#include "qonu_link.hpp"

#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>

namespace qonu {

LinkClient::~LinkClient()
{
    disconnect();
}

bool LinkClient::connect_socket()
{
    if (fd_ >= 0) {
        return true;
    }
    const int fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        return false;
    }
    sockaddr_un a{};
    a.sun_family = AF_UNIX;
    std::strncpy(a.sun_path, path_.c_str(), sizeof(a.sun_path) - 1);
    if (::connect(fd, reinterpret_cast<const sockaddr *>(&a), sizeof(a)) != 0) {
        ::close(fd);
        return false;
    }
    timeval tv{.tv_sec = timeout_ms_ / 1000, .tv_usec = (timeout_ms_ % 1000) * 1000};
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    fd_ = fd;
    inbuf_.clear();
    return true;
}

void LinkClient::disconnect()
{
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
    }
    inbuf_.clear();
}

bool LinkClient::call(std::string_view method, std::string_view params_json, std::string *error)
{
    auto fail = [&](const std::string &why) {
        ++failures_;
        disconnect();
        if (error != nullptr) {
            *error = why;
        }
        return false;
    };
    if (!connect_socket()) {
        return fail(path_ + ": " + std::strerror(errno));
    }
    const uint64_t id = next_id_++;
    std::string req = "{\"id\":" + std::to_string(id) + ",\"method\":\"";
    req.append(method);
    req += "\",\"params\":";
    req.append(params_json.empty() ? std::string_view("{}") : params_json);
    req += "}\n";
    size_t off = 0;
    while (off < req.size()) {
        const ssize_t n = ::send(fd_, req.data() + off, req.size() - off, MSG_NOSIGNAL);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            return fail("send: " + std::string(std::strerror(errno)));
        }
        off += static_cast<size_t>(n);
    }
    // One reply line per request, in order.
    size_t nl = std::string::npos;
    while ((nl = inbuf_.find('\n')) == std::string::npos) {
        char buf[1024];
        const ssize_t n = ::recv(fd_, buf, sizeof(buf), 0);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            return fail(n == 0 ? "qonu-link closed the socket" : "recv: " + std::string(std::strerror(errno)));
        }
        inbuf_.append(buf, static_cast<size_t>(n));
    }
    const std::string line = inbuf_.substr(0, nl);
    inbuf_.erase(0, nl + 1);
    if (line.find("\"ok\":true") != std::string::npos) {
        return true;
    }
    ++failures_;
    if (error != nullptr) {
        const size_t at = line.find("\"error\":\"");
        *error = at == std::string::npos ? line : line.substr(at + 9, line.find('"', at + 9) - at - 9);
    }
    return false;
}

}  // namespace qonu
