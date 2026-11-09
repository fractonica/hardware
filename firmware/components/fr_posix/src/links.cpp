#include "fr/posix/links.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>

#include "protocol.hpp"  // generated fr::proto constants (kMtuBulk)

namespace fr::posix {

bool resolve_ipv4(const std::string &host, uint16_t port, sockaddr_in &out)
{
    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo *res = nullptr;
    if (::getaddrinfo(host.c_str(), nullptr, &hints, &res) != 0 || res == nullptr) {
        return false;
    }
    std::memcpy(&out, res->ai_addr, sizeof(out));
    out.sin_port = htons(port);
    ::freeaddrinfo(res);
    return true;
}

namespace {

void set_nonblocking(int fd)
{
    ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    ::fcntl(fd, F_SETFD, FD_CLOEXEC);
}

}  // namespace

TcpLink::TcpLink(PosixCore &core, std::string host, uint16_t port, Timing timing)
    : core_(core), host_(std::move(host)), port_(port), timing_(timing), backoff_us_(timing.backoff_min_us)
{
    tx_.reserve(kTxBytes);
}

TcpLink::~TcpLink()
{
    if (fd_ >= 0) {
        ::close(fd_);
    }
}

Status TcpLink::send(std::span<const uint8_t> envelope)
{
    if (state_ != State::up || envelope.empty() || envelope.size() > proto::kMtuBulk) {
        return std::unexpected(Err::busy);
    }
    if (tx_.size() + envelope.size() + 2 > kTxBytes) {
        return std::unexpected(Err::busy);  // tcp_tx_dropped on target
    }
    tx_.push_back(static_cast<uint8_t>(envelope.size()));
    tx_.push_back(static_cast<uint8_t>(envelope.size() >> 8));
    tx_.insert(tx_.end(), envelope.begin(), envelope.end());
    flush();
    return {};
}

void TcpLink::hold(bool on)
{
    if (held_ && !on) {
        retry_at_ = 0;
    }
    held_ = on;
    if (on) {
        close("held");
    }
}

short TcpLink::events() const
{
    switch (state_) {
    case State::connecting:
        return POLLOUT;
    case State::up:
        return static_cast<short>(POLLIN | (tx_.empty() ? 0 : POLLOUT));
    case State::idle:
        break;
    }
    return 0;
}

TimeUs TcpLink::next_deadline() const
{
    if (state_ == State::connecting) {
        return connect_deadline_;
    }
    if (state_ == State::idle && !held_) {
        return retry_at_;
    }
    return kNever;
}

void TcpLink::poll()
{
    const TimeUs now = core_.now();
    if (state_ == State::connecting && now >= connect_deadline_) {
        close("connect timed out");
        return;
    }
    if (state_ == State::idle && !held_ && now >= retry_at_) {
        start_connect();
    }
}

void TcpLink::start_connect()
{
    sockaddr_in to{};
    if (!resolve_ipv4(host_, port_, to)) {
        say("hub: cannot resolve " + host_);
        retry_at_ = core_.now() + backoff_us_;
        backoff_us_ = std::min(backoff_us_ * 2, timing_.backoff_max_us);
        return;
    }
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        retry_at_ = core_.now() + backoff_us_;
        return;
    }
    set_nonblocking(fd);
    const int one = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    ::setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
    if (udp_ != nullptr) {
        udp_->set_target(to);  // UDP goes to the address TCP reaches (the hub binds both on one port)
    }
    fd_ = fd;
    const int r = ::connect(fd, reinterpret_cast<const sockaddr *>(&to), sizeof(to));
    if (r == 0) {
        connected();
    } else if (errno == EINPROGRESS) {
        state_ = State::connecting;
        connect_deadline_ = core_.now() + timing_.connect_timeout_us;
    } else {
        close("connect failed");
    }
}

void TcpLink::connected()
{
    state_ = State::up;
    up_since_ = core_.now();
    tx_.clear();
    rx_.clear();
    char ip[INET_ADDRSTRLEN] = "?";
    sockaddr_in peer{};
    socklen_t len = sizeof(peer);
    if (::getpeername(fd_, reinterpret_cast<sockaddr *>(&peer), &len) == 0) {
        ::inet_ntop(AF_INET, &peer.sin_addr, ip, sizeof(ip));
    }
    say("hub: TCP up to " + host_ + " (" + ip + ":" + std::to_string(port_) + ")");
    notify();
}

void TcpLink::on_events(short revents)
{
    if (state_ == State::connecting) {
        if ((revents & (POLLOUT | POLLERR | POLLHUP)) == 0) {
            return;
        }
        int err = 0;
        socklen_t len = sizeof(err);
        ::getsockopt(fd_, SOL_SOCKET, SO_ERROR, &err, &len);
        if (err != 0) {
            close(std::strerror(err));
            return;
        }
        connected();
        return;
    }
    if (state_ != State::up) {
        return;
    }
    if ((revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
        read();
    }
    if (state_ == State::up && (revents & POLLOUT) != 0) {
        flush();
    }
}

void TcpLink::flush()
{
    while (state_ == State::up && !tx_.empty()) {
        const ssize_t n = ::send(fd_, tx_.data(), tx_.size(), MSG_NOSIGNAL);
        if (n > 0) {
            tx_.erase(tx_.begin(), tx_.begin() + n);
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
            return;  // POLLOUT brings us back
        }
        close("send failed");
        return;
    }
}

void TcpLink::read()
{
    uint8_t buf[4096];
    const ssize_t n = ::recv(fd_, buf, sizeof(buf), 0);
    if (n == 0) {
        close("closed by the hub");
        return;
    }
    if (n < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
            close("recv failed");
        }
        return;
    }
    rx_.insert(rx_.end(), buf, buf + n);
    size_t at = 0;
    while (rx_.size() - at >= 2) {
        const size_t len = rx_[at] | static_cast<size_t>(rx_[at + 1]) << 8;
        if (len == 0 || len > proto::kMtuBulk) {
            close("bad frame length");
            return;
        }
        if (rx_.size() - at - 2 < len) {
            break;
        }
        const std::vector<uint8_t> env(rx_.begin() + static_cast<long>(at + 2),
                                       rx_.begin() + static_cast<long>(at + 2 + len));
        at += 2 + len;
        if (rx) {
            rx(env);
        }
        if (state_ != State::up) {
            return;  // Net dropped the link while handling it
        }
    }
    rx_.erase(rx_.begin(), rx_.begin() + static_cast<long>(at));
}

void TcpLink::close(const char *why)
{
    if (fd_ < 0) {
        return;
    }
    const bool was_up = state_ == State::up;
    ::close(fd_);
    fd_ = -1;
    state_ = State::idle;
    connect_deadline_ = kNever;
    tx_.clear();
    rx_.clear();
    const TimeUs now = core_.now();
    if (was_up && now - up_since_ >= timing_.stable_us) {
        backoff_us_ = timing_.backoff_min_us;
    }
    retry_at_ = now + backoff_us_;
    backoff_us_ = std::min(backoff_us_ * 2, timing_.backoff_max_us);
    say(std::string("hub: TCP closed: ") + why);
    if (was_up) {
        notify();
    }
}

void TcpLink::notify()
{
    // As on target, the link change reaches Net through the core queue, never re-entrantly.
    net::Net *net = net_;
    if (net != nullptr) {
        core_.post([net] { net->link_changed(net::LinkKind::tcp); });
    }
}

UdpLink::UdpLink()
{
    fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd_ >= 0) {
        set_nonblocking(fd_);
    }
}

UdpLink::~UdpLink()
{
    if (fd_ >= 0) {
        ::close(fd_);
    }
}

Status UdpLink::send(std::span<const uint8_t> envelope)
{
    if (!up()) {
        return std::unexpected(Err::busy);
    }
    const ssize_t n =
        ::sendto(fd_, envelope.data(), envelope.size(), 0, reinterpret_cast<const sockaddr *>(&to_), sizeof(to_));
    if (n != static_cast<ssize_t>(envelope.size())) {
        return std::unexpected(Err::busy);
    }
    return {};
}

}  // namespace fr::posix
