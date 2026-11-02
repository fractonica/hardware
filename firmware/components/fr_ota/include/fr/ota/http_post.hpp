// The node's second HTTP client (design audio-a1 D3): a chunked HTTP/1.1 POST over BSD sockets, beside HttpGet and
// like it one source (src/http) built against lwIP on target and POSIX on the host, with no esp_http_client. fr_ota
// holds both because src/http is the node's one socket HTTP code; fr.audio_in's record stream is its user
// (AudioInService on the fr_stream task, in fr_core, which requires fr_ota privately), and fr_net_node streams with it
// as the board does. Plain HTTP to a dotted IPv4 (the hub's address of the TCP session), `Transfer-Encoding: chunked`,
// `Connection: close`; every chunk goes out as written (TCP_NODELAY) and must have gone within the timeout in all (a
// connection trickling a few bytes at a time does not restart it), and the answer must come within it. A chunk goes
// in one blocking call (chunk()) or in slices (begin_chunk(), then pump() until it is done), so one task can serve
// other sockets between the slices. The answer's head must fit kHeadMax; up to kBodyMax bytes of its body are kept.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>
#include <string_view>

#include "fr/base.hpp"

namespace fr::ota {

class HttpPost final
{
public:
    static constexpr size_t kHeadMax = 512;
    static constexpr size_t kBodyMax = 128;
    static constexpr size_t kRequestMax = 384;
    /** An `a` up to this long goes out with the size line, copied (a record block's 8-byte head). */
    static constexpr size_t kLeadMax = 64;

    explicit HttpPost(uint32_t timeout_ms) : timeout_ms_(timeout_ms) {}
    ~HttpPost() { close(); }
    HttpPost(const HttpPost &) = delete;
    HttpPost &operator=(const HttpPost &) = delete;

    /**
     * The request head as start() sends it: `POST <path> HTTP/1.1`, `Host: <host>:<port>`, `Transfer-Encoding: chunked`,
     * `Connection: close`, then `headers` (whole lines, each ending CRLF), then the blank line. Its length, or 0 when it
     * does not fit `out`.
     */
    static size_t format_head(std::span<char> out, std::string_view host, uint16_t port, std::string_view path,
                              std::string_view headers);
    /** A chunk's size line, `<lowercase hex>\r\n`; its length (0 when it does not fit). */
    static size_t format_chunk_size(std::span<char> out, size_t len);

    /** Connects to `host` (dotted IPv4) and sends the head. invalid_args for a host or head it cannot take; failed
     * otherwise (error() says which step). */
    Status start(const char *host, uint16_t port, std::string_view path, std::string_view headers);
    /** One chunk carrying `a` then `b` (together non-empty): its size line, both, CRLF. A chunk that has not gone
     * within the timeout in all, or a closed connection, fails and closes. Blocks up to the timeout. */
    Status chunk(std::span<const uint8_t> a, std::span<const uint8_t> b);
    /**
     * Begins chunk(a, b) for pump(), sending nothing yet. An `a` of up to kLeadMax bytes is copied; a longer `a` and
     * `b` must stay valid until the chunk has gone (or failed). The timeout runs from here. invalid_args for an empty
     * chunk, failed when not open or another chunk is pending.
     */
    Status begin_chunk(std::span<const uint8_t> a, std::span<const uint8_t> b);
    /**
     * Sends what goes of the begun chunk, waiting at most `wait_ms` for room: true once all of it went, false while
     * some is left. Fails (and closes) once the timeout since begin_chunk() has passed, or when a send fails.
     */
    std::expected<bool, Err> pump(uint32_t wait_ms);
    /** A begun chunk has not gone yet. */
    bool pending() const { return seg_ < nsegs_; }
    /**
     * Whether the server has answered already, before finish() (the hub refusing a stream it did not issue): a look
     * that does not wait; when something came, the answer is read (status(), body()) and the connection closed.
     */
    bool answered();
    /** The last chunk (zero length), then the answer: OK when it came (any status: see status()); failed when it did
     * not within the timeout, or was not HTTP. The connection is closed either way. */
    Status finish();
    void close();

    bool open() const { return fd_ >= 0; }
    /** The answer's status code (0: none came). */
    int status() const { return status_; }
    /** The answer's body, up to kBodyMax bytes. */
    std::string_view body() const { return {body_, body_len_}; }
    /** The step the last call failed at ("connect", "timeout", "send", "status", ...); "" if none. */
    const char *error() const { return error_; }
    /** Body bytes sent so far in chunks (the size lines and CRLFs not counted). */
    uint64_t sent() const { return sent_; }

private:
    Status fail(const char *why, Err e = Err::failed);
    bool send_all(const void *data, size_t len);
    /** pump() on the socket made non-blocking. */
    std::expected<bool, Err> pump_slice(uint32_t wait_ms);
    /** Reads the answer: the head (whatever already came is in head_[0, got)), then the body. */
    Status read_answer(size_t got);

    uint32_t timeout_ms_;
    // The chunk being sent: its pieces (the size line with a short `a`, a long `a`, `b`, the CRLF), the next byte.
    std::array<std::span<const uint8_t>, 4> segs_{};
    size_t nsegs_ = 0;
    size_t seg_ = 0;
    size_t off_ = 0;
    size_t chunk_len_ = 0;
    int64_t deadline_ms_ = 0;
    uint8_t lead_[32 + kLeadMax] = {};
    int fd_ = -1;
    int status_ = 0;
    const char *error_ = "";
    uint64_t sent_ = 0;
    size_t body_len_ = 0;
    char head_[kHeadMax];
    char body_[kBodyMax];
};

}  // namespace fr::ota
