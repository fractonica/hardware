// fr::ota::HttpGet (design c4 §3): the image GET over BSD sockets. The same source builds against lwIP on
// target (its sys/socket.h wraps lwip_*; close, fcntl and select go through the VFS) and against POSIX in
// the host suite and fr_net_node.
#include "fr/ota/http_get.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <optional>
#include <string_view>

namespace fr::ota {
namespace {

constexpr std::string_view kScheme = "http://";
constexpr std::string_view kCrlf = "\r\n";
// No SIGPIPE from a send to a closed connection (Linux); macOS takes SO_NOSIGPIPE, lwIP has no signals.
#ifdef MSG_NOSIGNAL
constexpr int kSendFlags = MSG_NOSIGNAL;
#else
constexpr int kSendFlags = 0;
#endif

/** A monotonic clock in ms (as http_post.cpp's). */
int64_t now_ms()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

/** ASCII case-insensitive comparison: header names, `bytes`, `identity`. */
bool iequals(std::string_view a, std::string_view b)
{
    return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) {
               auto lower = [](char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; };
               return lower(x) == lower(y);
           });
}

std::string_view trim(std::string_view s)
{
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) {
        s.remove_prefix(1);
    }
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) {
        s.remove_suffix(1);
    }
    return s;
}

/** A decimal number that is all of `s`. */
std::optional<uint64_t> number(std::string_view s)
{
    uint64_t v = 0;
    auto [end, ec] = std::from_chars(s.data(), s.data() + s.size(), v);
    if (s.empty() || ec != std::errc{} || end != s.data() + s.size()) {
        return std::nullopt;
    }
    return v;
}

timeval timeval_of(uint32_t ms)
{
    timeval tv{};
    tv.tv_sec = static_cast<decltype(tv.tv_sec)>(ms / 1000);
    tv.tv_usec = static_cast<decltype(tv.tv_usec)>((ms % 1000) * 1000);
    return tv;
}

/** SO_RCVTIMEO and SO_SNDTIMEO run out with EAGAIN (EWOULDBLOCK). */
bool timed_out()
{
    return errno == EAGAIN || errno == EWOULDBLOCK;
}

}  // namespace

Status HttpGet::start(const char *url, uint32_t from_byte)
{
    close();
    status_ = 0;
    error_ = "";
    // http://<dotted IPv4>[:port]/<path>: Ota builds it from the TCP session's hub address (design c4 §3).
    std::string_view u = url != nullptr ? std::string_view(url) : std::string_view{};
    if (!u.starts_with(kScheme)) {
        return fail_start("url", Err::invalid_args);
    }
    u.remove_prefix(kScheme.size());
    const size_t slash = u.find('/');
    if (slash == std::string_view::npos) {
        return fail_start("url", Err::invalid_args);
    }
    const std::string_view hostport = u.substr(0, slash);
    const std::string_view path = u.substr(slash);
    const size_t colon = hostport.find(':');
    const std::string_view host = hostport.substr(0, colon);
    uint64_t port = 80;
    if (colon != std::string_view::npos) {
        const auto p = number(hostport.substr(colon + 1));
        if (!p || *p == 0 || *p > 65535) {
            return fail_start("url", Err::invalid_args);
        }
        port = *p;
    }
    char host_z[INET_ADDRSTRLEN] = {};
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    if (host.empty() || host.size() >= sizeof(host_z)) {
        return fail_start("url", Err::invalid_args);
    }
    std::memcpy(host_z, host.data(), host.size());
    if (::inet_pton(AF_INET, host_z, &addr.sin_addr) != 1) {
        return fail_start("url", Err::invalid_args);
    }

    char req[256];
    int n = std::snprintf(req, sizeof(req), "GET %.*s HTTP/1.1\r\nHost: %.*s\r\nConnection: close\r\n",
                          static_cast<int>(path.size()), path.data(), static_cast<int>(hostport.size()),
                          hostport.data());
    if (n > 0 && from_byte > 0 && static_cast<size_t>(n) < sizeof(req)) {
        n += std::snprintf(req + n, sizeof(req) - static_cast<size_t>(n), "Range: bytes=%" PRIu32 "-\r\n", from_byte);
    }
    if (n > 0 && static_cast<size_t>(n) < sizeof(req)) {
        n += std::snprintf(req + n, sizeof(req) - static_cast<size_t>(n), "\r\n");
    }
    if (n <= 0 || static_cast<size_t>(n) >= sizeof(req)) {
        return fail_start("url", Err::invalid_args);  // a path no Ota URL has
    }

    fd_ = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd_ < 0) {
        return fail_start("socket");
    }
    // Every send and receive waits at most the timeout (below the hub's 15 s stall limit, 06 §6.7), so a
    // silent connection fails here first and Ota re-issues its Range.
    const timeval tv = timeval_of(timeout_ms_);
    ::setsockopt(fd_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    ::setsockopt(fd_, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#ifdef SO_NOSIGPIPE
    const int one = 1;
    ::setsockopt(fd_, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
    // The connect too: non-blocking, then select() for at most the timeout.
    const int flags = ::fcntl(fd_, F_GETFL, 0);
    if (flags < 0 || ::fcntl(fd_, F_SETFL, flags | O_NONBLOCK) != 0) {
        return fail_start("socket");
    }
    if (::connect(fd_, reinterpret_cast<const sockaddr *>(&addr), sizeof(addr)) != 0) {
        if (errno != EINPROGRESS) {
            return fail_start("connect");
        }
        fd_set wr;
        FD_ZERO(&wr);
        FD_SET(fd_, &wr);
        timeval wait = timeval_of(timeout_ms_);
        int err = 0;
        socklen_t len = sizeof(err);
        if (::select(fd_ + 1, nullptr, &wr, nullptr, &wait) != 1 ||
            ::getsockopt(fd_, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
            return fail_start("connect");
        }
    }
    ::fcntl(fd_, F_SETFL, flags);

    for (int sent = 0; sent < n;) {
        const ssize_t k = ::send(fd_, req + sent, static_cast<size_t>(n - sent), kSendFlags);
        if (k < 0 && errno == EINTR) {
            continue;
        }
        if (k <= 0) {
            return fail_start(k < 0 && timed_out() ? "timeout" : "send");
        }
        sent += static_cast<int>(k);
    }
    size_t head_len = 0;
    if (!read_head(head_len)) {
        return fail_start(error_);
    }
    data_ms_ = now_ms();
    return parse_head(head_len, from_byte);
}

bool HttpGet::read_head(size_t &head_len)
{
    size_t got = 0;
    for (;;) {
        if (got == sizeof(head_)) {
            error_ = "head too large";
            return false;
        }
        const ssize_t n = ::recv(fd_, head_ + got, sizeof(head_) - got, 0);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            error_ = n == 0 ? "closed" : timed_out() ? "timeout" : "recv";
            return false;
        }
        const size_t from = got >= 3 ? got - 3 : 0;  // the blank line may straddle two receives
        got += static_cast<size_t>(n);
        const size_t end = std::string_view(head_, got).find("\r\n\r\n", from);
        if (end != std::string_view::npos) {
            head_len = end + kCrlf.size();  // through the last header line's CRLF
            body_at_ = end + 2 * kCrlf.size();
            body_end_ = got;
            return true;
        }
    }
}

Status HttpGet::parse_head(size_t head_len, uint32_t from_byte)
{
    std::string_view head(head_, head_len);
    const size_t eol = head.find(kCrlf);
    const std::string_view line = head.substr(0, eol);
    // "HTTP/1.x NNN reason"
    const auto code = line.size() >= 12 && line.starts_with("HTTP/1.") && line[8] == ' ' ? number(line.substr(9, 3))
                                                                                         : std::nullopt;
    if (!code || (line.size() > 12 && line[12] != ' ')) {
        return fail_start("status");
    }
    status_ = static_cast<int>(*code);
    head.remove_prefix(eol + kCrlf.size());
    std::string_view content_range;
    while (!head.empty()) {
        const size_t end = head.find(kCrlf);
        const std::string_view h = head.substr(0, end);
        head.remove_prefix(end == std::string_view::npos ? head.size() : end + kCrlf.size());
        const size_t colon = h.find(':');
        if (colon == std::string_view::npos) {
            continue;
        }
        const std::string_view name = trim(h.substr(0, colon));
        const std::string_view value = trim(h.substr(colon + 1));
        if (iequals(name, "Content-Length")) {
            const auto v = number(value);
            if (!v) {
                return fail_start("content-length");
            }
            remaining_ = static_cast<int64_t>(*v);
        } else if (iequals(name, "Content-Range")) {
            content_range = value;
        } else if (iequals(name, "Transfer-Encoding") && !iequals(value, "identity")) {
            return fail_start("chunked", Err::unsupported);  // the hub never chunks a file it knows the size of
        }
    }
    if (status_ == 206) {
        // "bytes <first>-<last>/<size>": any other first byte would be written at the wrong offset.
        const size_t dash = content_range.find('-');
        const auto first = content_range.size() > 6 && iequals(content_range.substr(0, 6), "bytes ") &&
                                   dash != std::string_view::npos
                               ? number(trim(content_range.substr(6, dash - 6)))
                               : std::nullopt;
        if (!first || *first != from_byte) {
            return fail_start("range");
        }
    } else if (status_ == 200) {
        skip_ = from_byte;  // the server ignored Range: drop what is already here
    } else {
        return fail_start("status", status_ == 404 ? Err::not_found : Err::failed);
    }
    return {};
}

std::expected<size_t, Err> HttpGet::read(std::span<uint8_t> out)
{
    if (fd_ < 0 || out.empty()) {
        return fail_read("not open");
    }
    for (;;) {
        if (remaining_ == 0) {
            return size_t{0};
        }
        size_t want = out.size();
        if (remaining_ > 0) {
            want = static_cast<size_t>(std::min<int64_t>(static_cast<int64_t>(want), remaining_));
        }
        size_t n = 0;
        if (body_at_ < body_end_) {
            n = std::min(want, body_end_ - body_at_);
            std::memcpy(out.data(), head_ + body_at_, n);
            body_at_ += n;
        } else {
            const ssize_t r = ::recv(fd_, out.data(), want, 0);
            if (r < 0 && errno == EINTR) {
                continue;
            }
            if (r == 0) {
                // The close ends a body of unknown length; one with a Content-Length was cut short.
                if (remaining_ < 0) {
                    remaining_ = 0;
                    return size_t{0};
                }
                return fail_read("closed early");
            }
            if (r < 0) {
                return fail_read(timed_out() ? "timeout" : "recv");
            }
            n = static_cast<size_t>(r);
            data_ms_ = now_ms();
        }
        if (remaining_ > 0) {
            remaining_ -= static_cast<int64_t>(n);
        }
        if (skip_ > 0) {
            const size_t k = std::min<size_t>(skip_, n);
            std::memmove(out.data(), out.data() + k, n - k);
            n -= k;
            skip_ -= static_cast<uint32_t>(k);
            if (n == 0) {
                continue;  // the read loop: still dropping bytes before `from_byte`
            }
        }
        return n;
    }
}

std::expected<bool, Err> HttpGet::readable(uint32_t wait_ms)
{
    if (fd_ < 0) {
        static_cast<void>(fail_read("not open"));
        return std::unexpected(Err::failed);
    }
    if (remaining_ == 0 || body_at_ < body_end_) {
        return true;
    }
    fd_set rd;
    FD_ZERO(&rd);
    FD_SET(fd_, &rd);
    timeval wait = timeval_of(wait_ms);
    const int k = ::select(fd_ + 1, &rd, nullptr, nullptr, &wait);
    if (k > 0) {
        return true;  // bytes, the close or an error: read() tells which, without waiting
    }
    if (k < 0 && errno != EINTR) {
        static_cast<void>(fail_read("recv"));
        return std::unexpected(Err::failed);
    }
    if (now_ms() - data_ms_ >= static_cast<int64_t>(timeout_ms_)) {
        static_cast<void>(fail_read("timeout"));
        return std::unexpected(Err::failed);
    }
    return false;
}

void HttpGet::close()
{
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
    }
    remaining_ = -1;
    skip_ = 0;
    body_at_ = body_end_ = 0;
}

Status HttpGet::fail_start(const char *why, Err e)
{
    close();
    error_ = why;
    return std::unexpected(e);
}

std::expected<size_t, Err> HttpGet::fail_read(const char *why)
{
    close();
    error_ = why;
    return std::unexpected(Err::failed);
}

}  // namespace fr::ota
