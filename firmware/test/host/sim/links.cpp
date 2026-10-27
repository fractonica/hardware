// A fleet node's hub links (design m2-c2 D7): SimTcp, SimUdp and SimSerial; see links.hpp (the bridge is bridge.cpp).
#include "sim/links.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>

#include "fr/serial_line.hpp"

namespace frsim {

using fr::TimeUs;
using fr::net::LinkKind;

namespace {

void nonblock(int fd)
{
    ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
}

void nosigpipe(int fd)
{
#ifdef SO_NOSIGPIPE
    const int one = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#else
    static_cast<void>(fd);
#endif
}

int send_flags()
{
#ifdef MSG_NOSIGNAL
    return MSG_NOSIGNAL;
#else
    return 0;
#endif
}

/** Closes `fd` with an RST instead of a FIN (SO_LINGER {1, 0}). */
void reset_close(int fd)
{
    const linger l{.l_onoff = 1, .l_linger = 0};
    ::setsockopt(fd, SOL_SOCKET, SO_LINGER, &l, sizeof(l));
    ::close(fd);
}

sockaddr_in loopback_addr(const std::string &host, uint16_t port)
{
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    if (::inet_pton(AF_INET, host.c_str(), &a.sin_addr) != 1) {
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    }
    return a;
}

}  // namespace

// ---- SendBuffer ----

void SendBuffer::push(std::span<const uint8_t> bytes, TimeUs due)
{
    const size_t n = std::min(bytes.size(), room());
    if (n == 0) {
        return;
    }
    last_due_ = std::max(last_due_, due);
    chunks_.push_back({last_due_, std::vector<uint8_t>(bytes.begin(), bytes.begin() + static_cast<std::ptrdiff_t>(n))});
    fill_ += n;
}

std::vector<uint8_t> SendBuffer::take_due(TimeUs now)
{
    std::vector<uint8_t> out;
    while (!chunks_.empty() && chunks_.front().due <= now) {
        const std::vector<uint8_t> &b = chunks_.front().bytes;
        out.insert(out.end(), b.begin(), b.end());
        fill_ -= b.size();
        chunks_.pop_front();
    }
    return out;
}

TimeUs SendBuffer::next_due() const
{
    return chunks_.empty() ? kNeverUs : chunks_.front().due;
}

void SendBuffer::clear()
{
    chunks_.clear();
    fill_ = 0;
}

// ---- SimTcp ----

SimTcp::SimTcp(Executor &exec, SimCore &core, Ap &ap, const fr::net::Mac &mac, const TcpTiming &timing)
    : exec_(exec), core_(core), ap_(ap), mac_(mac), timing_(timing), backoff_(timing), sndbuf_(timing.sndbuf_bytes)
{
}

SimTcp::~SimTcp()
{
    for (const EventId id : {attempt_event_, timeout_event_, stale_event_, pump_event_, deliver_event_}) {
        exec_.cancel(id);
    }
    if (fd_ >= 0) {
        exec_.unwatch(fd_);
        ::close(fd_);
    }
    if (stale_fd_ >= 0) {
        ::close(stale_fd_);
    }
}

void SimTcp::set_hub(std::string host, uint16_t port)
{
    host_ = std::move(host);
    port_ = port;
}

void SimTcp::bind(fr::net::Net &net, RxFn rx)
{
    net_ = &net;
    rx_ = std::move(rx);
}

void SimTcp::ip_up()
{
    ip_ = true;
    backoff_.reset();
    if (phase_ == Phase::idle) {
        phase_ = Phase::waiting;
        schedule_attempt(0);
    }
}

void SimTcp::ip_down()
{
    ip_ = false;
    go_silent();
}

void SimTcp::crash()
{
    net_ = nullptr;  // no link change reaches the node being torn down
    rx_ = nullptr;
    ip_down();
    ready_.clear();
    // Net's hold (drop_hub_link, ip_block) and hub_link's backoff are RAM on target, gone at the reset: the rebuilt
    // Net starts unheld and never releases a hold it did not take (review fleet-1).
    held_ = false;
    backoff_.reset();
}

void SimTcp::welcomed()
{
    if (stale_fd_ >= 0) {
        exec_.cancel(stale_event_);
        stale_event_ = 0;
        ::close(stale_fd_);  // the hub superseded that session at this WELCOME: the close ends nothing
        stale_fd_ = -1;
        ++stats_.stale_closed;
    }
}

fr::Status SimTcp::send(std::span<const uint8_t> envelope)
{
    if (phase_ != Phase::connected || envelope.size() > fr::proto::kMtuBulk || !tx_.push(envelope)) {
        ++stats_.tx_refused;
        return std::unexpected(fr::Err::busy);
    }
    ++stats_.tx_frames;
    pump();
    return {};
}

void SimTcp::drop(fr::net::DropReason)
{
    // Net lost the session: a fresh connection after the backoff, and a fresh HELLO (hub_link.cpp's close_tcp).
    if (phase_ == Phase::connected) {
        close_now(true);
    }
}

void SimTcp::hold(bool on)
{
    if (held_ && !on) {
        backoff_.reset();
        held_ = false;
        if (phase_ == Phase::waiting) {
            schedule_attempt(0);
        }
        return;
    }
    held_ = on;
}

void SimTcp::schedule_attempt(TimeUs delay)
{
    exec_.cancel(attempt_event_);
    retry_at_ = exec_.now() + delay;
    const uint64_t conn = conn_;
    attempt_event_ = exec_.at(retry_at_, [this, conn] {
        attempt_event_ = 0;
        if (conn == conn_) {
            attempt();
        }
    });
}

void SimTcp::attempt()
{
    if (!ip_ || held_ || phase_ != Phase::waiting || port_ == 0) {
        return;
    }
    retry_at_ = kNeverUs;
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        ++stats_.connect_fails;
        schedule_attempt(backoff_.closed(exec_.now(), kNeverUs));
        return;
    }
    nonblock(fd);
    nosigpipe(fd);
    const int one = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    const sockaddr_in a = loopback_addr(host_, port_);
    fd_ = fd;
    ++conn_;
    phase_ = Phase::connecting;
    if (::connect(fd, reinterpret_cast<const sockaddr *>(&a), sizeof(a)) == 0) {
        connected();
        return;
    }
    if (errno != EINPROGRESS) {
        close_now(true);
        return;
    }
    watch();
    const uint64_t conn = conn_;
    timeout_event_ = exec_.after(timing_.connect_timeout_us, [this, conn] {
        timeout_event_ = 0;
        if (conn == conn_ && phase_ == Phase::connecting) {
            close_now(true);  // hub_link's 3 s connect timeout
        }
    });
}

void SimTcp::on_writable_connect()
{
    int err = 0;
    socklen_t len = sizeof(err);
    if (::getsockopt(fd_, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
        close_now(true);
        return;
    }
    connected();
}

void SimTcp::connected()
{
    exec_.cancel(timeout_event_);
    timeout_event_ = 0;
    // A new stream starts on a frame boundary: nothing queued for an earlier connection may lead it.
    tx_.discard();
    sndbuf_.clear();
    wbuf_.clear();
    rbuf_.clear();
    phase_ = Phase::connected;
    connected_at_ = exec_.now();
    last_frame_at_ = connected_at_;
    ++stats_.connects;
    watch();
    notify();
}

void SimTcp::close_now(bool reconnect)
{
    const bool was_connected = phase_ == Phase::connected;
    const TimeUs now = exec_.now();
    if (fd_ >= 0) {
        exec_.unwatch(fd_);
        ::close(fd_);
        fd_ = -1;
    }
    exec_.cancel(timeout_event_);
    timeout_event_ = 0;
    ++conn_;  // frames and events of that connection are stale now
    tx_.discard();
    sndbuf_.clear();
    wbuf_.clear();
    rbuf_.clear();
    phase_ = Phase::waiting;
    const TimeUs delay = backoff_.closed(now, was_connected ? connected_at_ : kNeverUs);
    connected_at_ = kNeverUs;
    if (was_connected) {
        ++stats_.closes;
        notify();
    } else {
        ++stats_.connect_fails;
    }
    if (reconnect && ip_) {
        schedule_attempt(delay);
    }
}

void SimTcp::go_silent()
{
    exec_.cancel(attempt_event_);
    attempt_event_ = 0;
    exec_.cancel(timeout_event_);
    timeout_event_ = 0;
    retry_at_ = kNeverUs;
    const bool was_connected = phase_ == Phase::connected;
    if (fd_ >= 0) {
        exec_.unwatch(fd_);
        if (was_connected) {
            // No FIN: on RF the hub hears nothing. The fd stays open, unread and unwritten, until it is reset.
            if (stale_fd_ >= 0) {
                reset_stale();
            }
            stale_fd_ = fd_;
            const TimeUs rst_at = std::max(exec_.now(), last_frame_at_ + timing_.silent_rst_us);
            stale_event_ = exec_.at(rst_at, [this] {
                stale_event_ = 0;
                reset_stale();
            });
        } else {
            ::close(fd_);  // an attempt in progress: no session to keep up appearances for
        }
        fd_ = -1;
    }
    ++conn_;
    tx_.discard();
    sndbuf_.clear();
    wbuf_.clear();
    rbuf_.clear();
    connected_at_ = kNeverUs;
    phase_ = Phase::idle;
    if (was_connected) {
        notify();
    }
}

void SimTcp::reset_stale()
{
    if (stale_fd_ >= 0) {
        reset_close(stale_fd_);
        stale_fd_ = -1;
        ++stats_.resets;
    }
}

void SimTcp::notify()
{
    // As on target, the link change reaches Net through the core queue, never re-entrantly.
    if (fr::net::Net *net = net_) {
        core_.post([net] { net->link_changed(LinkKind::tcp); });
    }
}

void SimTcp::watch()
{
    uint32_t events = Waiter::kRead;
    if (phase_ == Phase::connecting || !wbuf_.empty()) {
        events = phase_ == Phase::connecting ? Waiter::kWrite : Waiter::kRead | Waiter::kWrite;
    }
    exec_.watch(fd_, events, [this](uint32_t ev) { on_ready(ev); });
}

void SimTcp::on_ready(uint32_t events)
{
    if (phase_ == Phase::connecting) {
        on_writable_connect();
        return;
    }
    if (phase_ != Phase::connected) {
        return;
    }
    if ((events & Waiter::kWrite) != 0) {
        write_out();
    }
    if (phase_ == Phase::connected && (events & Waiter::kRead) != 0) {
        read_all();
    }
}

void SimTcp::read_all()
{
    uint8_t buf[4096];
    const uint64_t conn = conn_;
    bool ended = false;  // the hub closed it (or an error): its last frames still count, then a reconnect
    for (;;) {
        const ssize_t n = ::recv(fd_, buf, sizeof(buf), 0);
        if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
            ended = true;
            break;
        }
        if (n < 0) {
            break;
        }
        stats_.rx_bytes += static_cast<uint64_t>(n);
        rbuf_.insert(rbuf_.end(), buf, buf + n);
    }
    const TimeUs now = exec_.now();
    last_frame_at_ = now;
    size_t at = 0;
    TimeUs due = inbound_.empty() ? 0 : inbound_.back().due;
    while (rbuf_.size() - at >= 2) {
        const size_t len = rbuf_[at] | static_cast<size_t>(rbuf_[at + 1]) << 8;
        if (len == 0 || len > fr::proto::kMtuBulk) {
            close_now(true);  // bad frame length from the hub
            return;
        }
        if (rbuf_.size() - at - 2 < len) {
            break;
        }
        std::vector<uint8_t> env(rbuf_.begin() + static_cast<std::ptrdiff_t>(at + 2),
                                 rbuf_.begin() + static_cast<std::ptrdiff_t>(at + 2 + len));
        at += 2 + len;
        if (arrival_) {
            arrival_(env, now);
        }
        // The AP's downlink: its latency, in order, and nothing while a gap lasts.
        due = std::max(due, ap_.after_gap(now + ap_.downlink_us(mac_, draws_++)));
        ap_.account(len + 2);
        inbound_.push_back({due, conn, std::move(env)});
    }
    rbuf_.erase(rbuf_.begin(), rbuf_.begin() + static_cast<std::ptrdiff_t>(at));
    if (!inbound_.empty() && deliver_event_ == 0) {
        deliver_event_ = exec_.at(inbound_.front().due, [this] {
            deliver_event_ = 0;
            deliver_due();
        });
    }
    if (ended) {
        // What arrived before the close is still delivered: it is that connection's (conn), counted as one.
        for (Inbound &in : inbound_) {
            in.conn = in.conn == conn ? kClosedConn : in.conn;
        }
        close_now(true);
    }
}

void SimTcp::deliver_due()
{
    const TimeUs now = exec_.now();
    while (!inbound_.empty() && inbound_.front().due <= now) {
        Inbound in = std::move(inbound_.front());
        inbound_.pop_front();
        if ((in.conn != conn_ || phase_ != Phase::connected) && in.conn != kClosedConn) {
            continue;  // that connection ended meanwhile
        }
        if (net_ == nullptr) {
            continue;
        }
        // As hub_link.cpp: each envelope reaches the core task through its network queue (core.cpp post_net).
        ready_.push_back(std::move(in.env));
        if (!core_.post_net([this] {
                if (ready_.empty()) {
                    return;
                }
                std::vector<uint8_t> env = std::move(ready_.front());
                ready_.pop_front();
                if (rx_) {
                    ++stats_.rx_frames;
                    rx_(LinkKind::tcp, env);
                }
            })) {
            ready_.pop_back();
            ++stats_.rx_dropped;
        }
    }
    if (!inbound_.empty()) {
        deliver_event_ = exec_.at(inbound_.front().due, [this] {
            deliver_event_ = 0;
            deliver_due();
        });
    }
}

void SimTcp::pump()
{
    // The FIFO into lwIP's buffer as fast as it takes them (hub_link.cpp's flush), each piece due once the AP has
    // carried it.
    const TimeUs now = exec_.now();
    while (!tx_.empty() && sndbuf_.room() > 0) {
        const std::span<const uint8_t> run = tx_.peek();
        const size_t n = std::min(run.size(), sndbuf_.room());
        const TimeUs on_air = ap_.account(n);
        sndbuf_.push(run.first(n), ap_.after_gap(now + ap_.uplink_us(mac_, draws_++)) + on_air);
        tx_.consume(n);
    }
    const TimeUs next = sndbuf_.next_due();
    if (next != kNeverUs && (pump_event_ == 0 || next < pump_at_)) {
        exec_.cancel(pump_event_);
        pump_at_ = next;
        pump_event_ = exec_.at(next, [this] {
            pump_event_ = 0;
            pump_at_ = kNeverUs;
            flush();
        });
    }
}

void SimTcp::flush()
{
    if (phase_ != Phase::connected) {
        return;
    }
    const std::vector<uint8_t> due = sndbuf_.take_due(exec_.now());
    wbuf_.insert(wbuf_.end(), due.begin(), due.end());
    write_out();
    if (phase_ == Phase::connected) {
        pump();
    }
}

void SimTcp::write_out()
{
    while (!wbuf_.empty() && phase_ == Phase::connected) {
        const ssize_t n = ::send(fd_, wbuf_.data(), wbuf_.size(), send_flags());
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
            watch();  // the rest when the socket takes it
            return;
        }
        if (n <= 0) {
            close_now(true);
            return;
        }
        stats_.tx_bytes += static_cast<uint64_t>(n);
        last_frame_at_ = exec_.now();
        wbuf_.erase(wbuf_.begin(), wbuf_.begin() + n);
        if (wbuf_.empty()) {
            watch();
        }
    }
}

// ---- UDP ----

UdpSocket::UdpSocket() : fd_(::socket(AF_INET, SOCK_DGRAM, 0))
{
    if (fd_ >= 0) {
        nonblock(fd_);
    }
}

UdpSocket::~UdpSocket()
{
    if (fd_ >= 0) {
        ::close(fd_);
    }
}

bool UdpSocket::send_to(const std::string &host, uint16_t port, std::span<const uint8_t> bytes)
{
    const sockaddr_in a = loopback_addr(host, port);
    return ::sendto(fd_, bytes.data(), bytes.size(), 0, reinterpret_cast<const sockaddr *>(&a), sizeof(a)) ==
           static_cast<ssize_t>(bytes.size());
}

SimUdp::SimUdp(Executor &exec, Ap &ap, const fr::net::Mac &mac, UdpSocket &shared, bool own)
    : exec_(exec), ap_(ap), mac_(mac), shared_(shared), own_(own ? std::make_unique<UdpSocket>() : nullptr)
{
}

void SimUdp::set_hub(std::string host, uint16_t port)
{
    host_ = std::move(host);
    port_ = port;
}

void SimUdp::crash()
{
    ip_ = false;
    net_ = nullptr;
    queue_.clear();
    ++epoch_;
}

fr::Status SimUdp::send(std::span<const uint8_t> envelope)
{
    if (!ip_ || port_ == 0) {
        ++stats_.refused;
        return std::unexpected(fr::Err::busy);
    }
    const TimeUs now = exec_.now();
    const uint64_t n = draws_++;
    ap_.account(envelope.size());
    if (ap_.udp_lost(mac_, n, now)) {
        ++stats_.lost;  // gone on the air: the sender never knows
        return {};
    }
    const TimeUs due = std::max(queue_.empty() ? 0 : queue_.back().due, now + ap_.uplink_us(mac_, n));
    queue_.push_back({due, std::vector<uint8_t>(envelope.begin(), envelope.end())});
    if (event_ == 0) {
        const uint64_t epoch = epoch_;
        event_ = exec_.at(queue_.front().due, [this, epoch] {
            event_ = 0;
            if (epoch == epoch_) {
                send_due();
            }
        });
    }
    return {};
}

void SimUdp::send_due()
{
    const TimeUs now = exec_.now();
    UdpSocket &sock = own_ != nullptr ? *own_ : shared_;
    while (!queue_.empty() && queue_.front().due <= now) {
        if (sock.send_to(host_, port_, queue_.front().bytes)) {
            ++stats_.sent;
        }
        queue_.pop_front();
    }
    if (!queue_.empty()) {
        const uint64_t epoch = epoch_;
        event_ = exec_.at(queue_.front().due, [this, epoch] {
            event_ = 0;
            if (epoch == epoch_) {
                send_due();
            }
        });
    }
}

// ---- SimSerial ----

void SimSerial::bind(fr::net::Net &net, RxFn rx, DiagFn diag)
{
    net_ = &net;
    rx_ = std::move(rx);
    diag_ = std::move(diag);
}

void SimSerial::set_host(bool present)
{
    if (present == host_) {
        return;
    }
    host_ = present;
    if (fr::net::Net *net = net_) {
        core_.post([net] { net->link_changed(LinkKind::serial); });
    }
}

void SimSerial::crash()
{
    net_ = nullptr;
    rx_ = nullptr;
    diag_ = nullptr;
    ready_.clear();
}

fr::Status SimSerial::send(std::span<const uint8_t> envelope)
{
    if (!host_) {
        return std::unexpected(fr::Err::busy);
    }
    char line[fr::wire::kMaxLine + 1];
    const size_t n = fr::wire::encode_line(fr::wire::kSerialEnv, envelope, std::span<char>(line, fr::wire::kMaxLine));
    if (n == 0) {
        return std::unexpected(fr::Err::invalid_args);
    }
    if (write_) {
        write_(std::string_view(line, n));
    }
    return {};
}

void SimSerial::print(std::string_view line)
{
    if (host_ && write_) {
        write_(line);
    }
}

void SimSerial::on_line(std::string_view line)
{
    if (line.starts_with(fr::wire::kLinePrefix)) {
        uint8_t scratch[fr::wire::kMaxLineFrame];
        auto f = fr::wire::decode_line(line, scratch);
        if (!f || f->type != fr::wire::kSerialEnv || !host_ || muted_ || net_ == nullptr) {
            return;
        }
        ready_.emplace_back(f->body.begin(), f->body.end());
        if (!core_.post_net([this] {
                if (ready_.empty()) {
                    return;
                }
                std::vector<uint8_t> env = std::move(ready_.front());
                ready_.pop_front();
                if (rx_) {
                    rx_(LinkKind::serial, env);
                }
            })) {
            ready_.pop_back();
        }
        return;
    }
    if (const std::optional<std::string_view> id = serial_id(line); id && diag_ && host_ && !muted_ && write_) {
        write_(diag_(*id, line));
    }
}

std::optional<std::string_view> SimSerial::serial_id(std::string_view line)
{
    if (line.size() < 3 || line.front() != '#') {
        return std::nullopt;
    }
    size_t n = 1;
    while (n < line.size() && line[n] >= '0' && line[n] <= '9') {
        ++n;
    }
    if (n == 1 || n > 9 || n >= line.size() || line[n] != ' ') {
        return std::nullopt;
    }
    return line.substr(1, n - 1);
}

}  // namespace frsim
