// The fleet's serial bridge (design m2-c2 D7): the hub's `--serial-bridge` wire (links/serial-bridge.ts, as
// virtual-usb.ts serves it) for the nodes a scenario puts on USB; see links.hpp.
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cerrno>

#include "sim/links.hpp"
#include "sim/out.hpp"

namespace frsim {

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

}  // namespace

struct Bridge::Conn {
    int fd = -1;
    std::string in;
    std::string out;
    std::string mac;      // the port it opened ("" while it has not)
    bool closing = false;  // close once `out` is written
};

Bridge::Bridge(Executor &exec) : exec_(exec) {}

Bridge::~Bridge()
{
    for (auto &[fd, c] : conns_) {
        exec_.unwatch(fd);
        ::close(fd);
    }
    if (fd_ >= 0) {
        exec_.unwatch(fd_);
        ::close(fd_);
    }
}

bool Bridge::listen(uint16_t port)
{
    fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd_ < 0) {
        return false;
    }
    const int one = 1;
    ::setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = htons(port);
    socklen_t len = sizeof(a);
    if (::bind(fd_, reinterpret_cast<sockaddr *>(&a), sizeof(a)) != 0 || ::listen(fd_, 64) != 0 ||
        ::getsockname(fd_, reinterpret_cast<sockaddr *>(&a), &len) != 0) {
        ::close(fd_);
        fd_ = -1;
        return false;
    }
    nonblock(fd_);
    port_ = ntohs(a.sin_port);
    return exec_.watch(fd_, Waiter::kRead, [this](uint32_t) { accept_all(); });
}

std::string Bridge::path_of(std::string_view mac_hex)
{
    return "/dev/cu.usbmodem-fr-" + std::string(mac_hex);
}

void Bridge::attach(std::string_view mac_hex, std::function<void(std::string_view)> to_device)
{
    detach(mac_hex);
    Port &p = ports_[std::string(mac_hex)];
    p.mac = std::string(mac_hex);
    p.to_device = std::move(to_device);
}

void Bridge::detach(std::string_view mac_hex)
{
    const auto it = ports_.find(std::string(mac_hex));
    if (it == ports_.end()) {
        return;
    }
    const std::set<Conn *> open = it->second.open;
    ports_.erase(it);
    for (Conn *c : open) {
        close_conn(*c);  // an unplug: the hub's read fails
    }
}

bool Bridge::attached(std::string_view mac_hex) const
{
    return ports_.contains(std::string(mac_hex));
}

bool Bridge::open(std::string_view mac_hex) const
{
    const auto it = ports_.find(std::string(mac_hex));
    return it != ports_.end() && !it->second.open.empty();
}

void Bridge::print(std::string_view mac_hex, std::string_view line)
{
    const auto it = ports_.find(std::string(mac_hex));
    if (it == ports_.end()) {
        return;
    }
    std::string bytes(line);
    bytes += '\n';
    for (Conn *c : it->second.open) {
        write(*c, bytes);
    }
}

std::string Bridge::listing() const
{
    // serialport's PortInfo, as virtual-usb.ts lists a board on the Mac's USB.
    std::string out = "[";
    for (const auto &[mac, p] : ports_) {
        std::string upper;
        for (size_t i = 0; i < mac.size(); i += 2) {
            upper += (i == 0 ? "" : ":") + mac.substr(i, 2);
        }
        std::transform(upper.begin(), upper.end(), upper.begin(), [](char ch) { return static_cast<char>(std::toupper(ch)); });
        out += sformat(R"(%s{"path":"%s","manufacturer":"Espressif","serialNumber":"%s","vendorId":"303a","productId":"1001"})",
                       out.size() > 1 ? "," : "", path_of(mac).c_str(), upper.c_str());
    }
    return out + "]";
}

void Bridge::accept_all()
{
    for (;;) {
        const int fd = ::accept(fd_, nullptr, nullptr);
        if (fd < 0) {
            return;
        }
        nonblock(fd);
        nosigpipe(fd);
        auto c = std::make_unique<Conn>();
        c->fd = fd;
        Conn &ref = *c;
        conns_[fd] = std::move(c);
        exec_.watch(fd, Waiter::kRead, [this, &ref](uint32_t ev) { on_conn(ref, ev); });
    }
}

void Bridge::on_conn(Conn &c, uint32_t events)
{
    const int fd = c.fd;  // `c` may be gone after a call that can close it
    if ((events & Waiter::kWrite) != 0) {
        write(c, {});
        if (!conns_.contains(fd)) {
            return;
        }
    }
    if ((events & Waiter::kRead) == 0) {
        return;
    }
    char buf[4096];
    for (;;) {
        const ssize_t n = ::recv(c.fd, buf, sizeof(buf), 0);
        if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
            close_conn(c);  // the hub closed the port (or its request)
            return;
        }
        if (n < 0) {
            break;
        }
        c.in.append(buf, static_cast<size_t>(n));
    }
    size_t nl;
    while ((nl = c.in.find('\n')) != std::string::npos) {
        std::string line = c.in.substr(0, nl);
        c.in.erase(0, nl + 1);
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        if (c.mac.empty()) {
            // The request line.
            if (line == "list") {
                write(c, listing() + "\n");
                c.closing = true;
                write(c, {});
                return;
            }
            std::string mac;
            for (const auto &[m, p] : ports_) {
                if (line == "open " + path_of(m)) {
                    mac = m;
                }
            }
            if (mac.empty()) {
                write(c, "err " + (line.starts_with("open ") ? "no such port " + line.substr(5) : "bad request " + line) + "\n");
                c.closing = true;
                write(c, {});
                return;
            }
            c.mac = mac;
            ports_[mac].open.insert(&c);
            write(c, "ok\n");
            continue;
        }
        const auto it = ports_.find(c.mac);
        if (it != ports_.end() && it->second.to_device) {
            it->second.to_device(line);
        }
        if (!conns_.contains(fd)) {
            return;  // the device was unplugged while handling it
        }
    }
}

void Bridge::write(Conn &c, std::string_view bytes)
{
    c.out.append(bytes);
    while (!c.out.empty()) {
        const ssize_t n = ::send(c.fd, c.out.data(), c.out.size(), send_flags());
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
            break;
        }
        if (n <= 0) {
            const int fd = c.fd;
            // Not from inside a write the caller still uses `c` after: the close waits for the loop.
            exec_.after(0, [this, fd] {
                const auto it = conns_.find(fd);
                if (it != conns_.end()) {
                    close_conn(*it->second);
                }
            });
            c.out.clear();
            return;
        }
        c.out.erase(0, static_cast<size_t>(n));
    }
    if (c.out.empty() && c.closing) {
        const int fd = c.fd;
        exec_.after(0, [this, fd] {
            const auto it = conns_.find(fd);
            if (it != conns_.end()) {
                close_conn(*it->second);
            }
        });
        return;
    }
    exec_.watch(c.fd, c.out.empty() ? Waiter::kRead : Waiter::kRead | Waiter::kWrite,
                [this, &c](uint32_t ev) { on_conn(c, ev); });
}

void Bridge::close_conn(Conn &c)
{
    const int fd = c.fd;
    if (!c.mac.empty()) {
        const auto it = ports_.find(c.mac);
        if (it != ports_.end()) {
            it->second.open.erase(&c);
        }
    }
    exec_.unwatch(fd);
    ::close(fd);
    conns_.erase(fd);  // destroys `c`
}

}  // namespace frsim
