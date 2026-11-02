// fr::ota::HttpPost (design audio-a1 D3): the chunked POST over BSD sockets. As http_get.cpp, the same source builds
// against lwIP on target (its sys/socket.h wraps lwip_*; close, fcntl and select go through the VFS) and against
// POSIX in the host suite and fr_net_node.
#include "fr/ota/http_post.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#if __has_include(<netinet/tcp.h>)
#include <netinet/tcp.h>  // TCP_NODELAY (lwIP's sys/socket.h defines it too)
#endif

#include <algorithm>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <optional>

namespace fr::ota {
namespace {

constexpr std::string_view kCrlf = "\r\n";
constexpr std::string_view kLastChunk = "0\r\n\r\n";
#ifdef MSG_NOSIGNAL
constexpr int kSendFlags = MSG_NOSIGNAL;
#else
constexpr int kSendFlags = 0;
#endif
#ifdef MSG_DONTWAIT
constexpr int kNoWait = MSG_DONTWAIT;
#else
constexpr int kNoWait = 0;  // no such flag: pump()'s O_NONBLOCK alone keeps a send from waiting
#endif
constexpr uint8_t kCrlfBytes[] = {'\r', '\n'};

/** A monotonic clock in ms (std::chrono::steady_clock: CLOCK_MONOTONIC on the board's newlib and on the host). */
int64_t now_ms()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

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

bool timed_out()
{
    return errno == EAGAIN || errno == EWOULDBLOCK;
}

}  // namespace

size_t HttpPost::format_head(std::span<char> out, std::string_view host, uint16_t port, std::string_view path,
                             std::string_view headers)
{
    const int n = std::snprintf(out.data(), out.size(),
                                "POST %.*s HTTP/1.1\r\nHost: %.*s:%u\r\nTransfer-Encoding: chunked\r\n"
                                "Connection: close\r\n%.*s\r\n",
                                static_cast<int>(path.size()), path.data(), static_cast<int>(host.size()), host.data(),
                                static_cast<unsigned>(port), static_cast<int>(headers.size()), headers.data());
    return n > 0 && static_cast<size_t>(n) < out.size() ? static_cast<size_t>(n) : 0;
}

size_t HttpPost::format_chunk_size(std::span<char> out, size_t len)
{
    const int n = std::snprintf(out.data(), out.size(), "%zx\r\n", len);
    return n > 0 && static_cast<size_t>(n) < out.size() ? static_cast<size_t>(n) : 0;
}

Status HttpPost::start(const char *host, uint16_t port, std::string_view path, std::string_view headers)
{
    close();
    status_ = 0;
    error_ = "";
    sent_ = 0;
    body_len_ = 0;
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    if (host == nullptr || port == 0 || ::inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
        return fail("host", Err::invalid_args);
    }
    char req[kRequestMax];
    const size_t n = format_head(req, host, port, path, headers);
    if (n == 0) {
        return fail("head", Err::invalid_args);
    }

    fd_ = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd_ < 0) {
        return fail("socket");
    }
    // Each send and receive waits at most the timeout: a send that cannot go on for that long ends the stream
    // (design D3: 3 s, net_lost).
    const timeval tv = timeval_of(timeout_ms_);
    ::setsockopt(fd_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    ::setsockopt(fd_, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    const int one = 1;
#ifdef SO_NOSIGPIPE
    ::setsockopt(fd_, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
#ifdef TCP_NODELAY
    // A block's size line, its PCM and its CRLF leave at once, not after the hub's delayed ACK (Nagle).
    ::setsockopt(fd_, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
#endif
    const int flags = ::fcntl(fd_, F_GETFL, 0);
    if (flags < 0 || ::fcntl(fd_, F_SETFL, flags | O_NONBLOCK) != 0) {
        return fail("socket");
    }
    if (::connect(fd_, reinterpret_cast<const sockaddr *>(&addr), sizeof(addr)) != 0) {
        if (errno != EINPROGRESS) {
            return fail("connect");
        }
        fd_set wr;
        FD_ZERO(&wr);
        FD_SET(fd_, &wr);
        timeval wait = timeval_of(timeout_ms_);
        int err = 0;
        socklen_t len = sizeof(err);
        if (::select(fd_ + 1, nullptr, &wr, nullptr, &wait) != 1 ||
            ::getsockopt(fd_, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
            return fail("connect");
        }
    }
    ::fcntl(fd_, F_SETFL, flags);
    if (!send_all(req, n)) {
        return fail(error_);
    }
    return {};
}

bool HttpPost::send_all(const void *data, size_t len)
{
    const auto *p = static_cast<const uint8_t *>(data);
    for (size_t sent = 0; sent < len;) {
        const ssize_t k = ::send(fd_, p + sent, len - sent, kSendFlags);
        if (k < 0 && errno == EINTR) {
            continue;
        }
        if (k <= 0) {
            error_ = k < 0 && timed_out() ? "timeout" : "send";
            return false;
        }
        sent += static_cast<size_t>(k);
    }
    return true;
}

Status HttpPost::chunk(std::span<const uint8_t> a, std::span<const uint8_t> b)
{
    if (auto st = begin_chunk(a, b); !st) {
        return st;
    }
    for (;;) {
        const auto done = pump(timeout_ms_);
        if (!done) {
            return std::unexpected(done.error());
        }
        if (*done) {
            return {};
        }
    }
}

Status HttpPost::begin_chunk(std::span<const uint8_t> a, std::span<const uint8_t> b)
{
    if (fd_ < 0) {
        return fail("not open");
    }
    if (pending()) {
        return fail("chunk pending");
    }
    const size_t len = a.size() + b.size();
    if (len == 0) {
        return fail("empty", Err::invalid_args);  // a zero-length chunk is the end: finish()
    }
    // The size line and a short `a` (a block's 8-byte head) in one piece; then a long `a`, `b`, the CRLF.
    size_t n = format_chunk_size({reinterpret_cast<char *>(lead_), 32}, len);
    const bool joined = a.size() <= kLeadMax;
    if (joined && !a.empty()) {
        std::memcpy(lead_ + n, a.data(), a.size());
        n += a.size();
    }
    nsegs_ = 0;
    segs_[nsegs_++] = {lead_, n};
    if (!joined) {
        segs_[nsegs_++] = a;
    }
    if (!b.empty()) {
        segs_[nsegs_++] = b;
    }
    segs_[nsegs_++] = kCrlfBytes;
    seg_ = 0;
    off_ = 0;
    chunk_len_ = len;
    deadline_ms_ = now_ms() + timeout_ms_;
    return {};
}

std::expected<bool, Err> HttpPost::pump(uint32_t wait_ms)
{
    if (fd_ < 0) {
        fail("not open");
        return std::unexpected(Err::failed);
    }
    if (!pending()) {
        return true;  // nothing begun, or all of it went already
    }
    // The socket is non-blocking while it pumps: not every stack's send() honours MSG_DONTWAIT (Darwin's waits out
    // SO_SNDTIMEO for a large piece anyway), and a send that waits would overrun the slice. Blocking again after,
    // for finish() and the answer.
    const int flags = ::fcntl(fd_, F_GETFL, 0);
    const bool nb = flags >= 0 && (flags & O_NONBLOCK) == 0 && ::fcntl(fd_, F_SETFL, flags | O_NONBLOCK) == 0;
    const auto r = pump_slice(wait_ms);
    if (nb && fd_ >= 0) {
        ::fcntl(fd_, F_SETFL, flags);
    }
    return r;
}

std::expected<bool, Err> HttpPost::pump_slice(uint32_t wait_ms)
{
    const int64_t until = std::min(deadline_ms_, now_ms() + wait_ms);
    while (seg_ < nsegs_) {
        const std::span<const uint8_t> piece = segs_[seg_];
        if (off_ == piece.size()) {
            ++seg_;
            off_ = 0;
            continue;
        }
        const ssize_t k = ::send(fd_, piece.data() + off_, piece.size() - off_, kSendFlags | kNoWait);
        if (k > 0) {
            off_ += static_cast<size_t>(k);
            continue;
        }
        if (k < 0 && errno == EINTR) {
            continue;
        }
        if (k < 0 && timed_out()) {
            // No room: wait for some, up to this pass's end; the chunk's deadline counts from begin_chunk().
            const int64_t t = now_ms();
            if (t >= deadline_ms_) {
                fail("timeout");  // closes: the pending chunk goes with the connection
                return std::unexpected(Err::failed);
            }
            if (t >= until) {
                return false;
            }
            fd_set wr;
            FD_ZERO(&wr);
            FD_SET(fd_, &wr);
            timeval wait = timeval_of(static_cast<uint32_t>(until - t));
            static_cast<void>(::select(fd_ + 1, nullptr, &wr, nullptr, &wait));
            continue;
        }
        fail("send");
        return std::unexpected(Err::failed);
    }
    sent_ += chunk_len_;
    return true;
}

bool HttpPost::answered()
{
    if (fd_ < 0) {
        return status_ != 0;
    }
    char c = 0;
#ifdef MSG_DONTWAIT
    const ssize_t k = ::recv(fd_, &c, 1, MSG_DONTWAIT | MSG_PEEK);
#else
    const ssize_t k = -1;  // no look without waiting: only finish() reads the answer
    errno = EAGAIN;
#endif
    if (k < 0 && (timed_out() || errno == EINTR)) {
        return false;
    }
    if (k == 0) {
        fail("closed");  // the server went away without a word
        return true;
    }
    if (k < 0) {
        fail("recv");
        return true;
    }
    static_cast<void>(read_answer(0));
    return true;
}

Status HttpPost::finish()
{
    if (fd_ < 0) {
        return fail("not open");
    }
    if (!send_all(kLastChunk.data(), kLastChunk.size())) {
        return fail(error_);
    }
    return read_answer(0);
}

Status HttpPost::read_answer(size_t got)
{
    size_t head_len = 0;
    size_t body_at = 0;
    for (;;) {
        if (got == sizeof(head_)) {
            return fail("head too large");
        }
        const ssize_t k = ::recv(fd_, head_ + got, sizeof(head_) - got, 0);
        if (k < 0 && errno == EINTR) {
            continue;
        }
        if (k <= 0) {
            return fail(k == 0 ? "closed" : timed_out() ? "timeout" : "recv");
        }
        const size_t from = got >= 3 ? got - 3 : 0;
        got += static_cast<size_t>(k);
        const size_t end = std::string_view(head_, got).find("\r\n\r\n", from);
        if (end != std::string_view::npos) {
            head_len = end + kCrlf.size();
            body_at = end + 2 * kCrlf.size();
            break;
        }
    }
    std::string_view head(head_, head_len);
    const size_t eol = head.find(kCrlf);
    const std::string_view line = head.substr(0, eol);
    const auto code = line.size() >= 12 && line.starts_with("HTTP/1.") && line[8] == ' ' ? number(line.substr(9, 3))
                                                                                         : std::nullopt;
    if (!code || (line.size() > 12 && line[12] != ' ')) {
        return fail("status");
    }
    head.remove_prefix(eol + kCrlf.size());
    int64_t remaining = -1;  // until the close
    while (!head.empty()) {
        const size_t end = head.find(kCrlf);
        const std::string_view h = head.substr(0, end);
        head.remove_prefix(end == std::string_view::npos ? head.size() : end + kCrlf.size());
        const size_t colon = h.find(':');
        if (colon != std::string_view::npos && iequals(trim(h.substr(0, colon)), "Content-Length")) {
            if (const auto v = number(trim(h.substr(colon + 1)))) {
                remaining = static_cast<int64_t>(*v);
            }
        }
    }
    // The body: what came with the head, then until Content-Length or the close; kept up to kBodyMax.
    body_len_ = 0;
    auto keep = [this, &remaining](const char *p, size_t n) {
        if (remaining >= 0) {
            n = static_cast<size_t>(std::min<int64_t>(static_cast<int64_t>(n), remaining));
            remaining -= static_cast<int64_t>(n);
        }
        const size_t k = std::min(n, sizeof(body_) - body_len_);
        std::memcpy(body_ + body_len_, p, k);
        body_len_ += k;
    };
    keep(head_ + body_at, got - body_at);
    while (remaining != 0) {
        char buf[64];
        const ssize_t k = ::recv(fd_, buf, sizeof(buf), 0);
        if (k < 0 && errno == EINTR) {
            continue;
        }
        if (k <= 0) {
            break;  // the close (or a timeout) ends it: the status is what matters
        }
        keep(buf, static_cast<size_t>(k));
    }
    status_ = static_cast<int>(*code);
    close();
    return {};
}

void HttpPost::close()
{
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
    }
    seg_ = nsegs_ = 0;  // a pending chunk goes with the connection
}

Status HttpPost::fail(const char *why, Err e)
{
    close();
    error_ = why;
    return std::unexpected(e);
}

}  // namespace fr::ota
