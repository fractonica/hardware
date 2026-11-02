// The node's second HTTP client (design audio-a1 D3): a chunked HTTP/1.1 POST over BSD sockets, beside HttpGet and
// like it one source (src/http) built against lwIP on target and POSIX on the host, with no esp_http_client. fr_ota
// holds both because src/http is the node's one socket HTTP code; fr.audio_in's record stream is its user
// (AudioInService on the fr_stream task, in fr_core, which requires fr_ota privately), and fr_net_node streams with it
// as the board does. Plain HTTP to a dotted IPv4 (the hub's address of the TCP session), `Transfer-Encoding: chunked`,
// `Connection: close`; every chunk goes out as written (TCP_NODELAY) and must have gone within the timeout in all (a
// connection trickling a few bytes at a time does not restart it), and the answer must come within it. A chunk goes
// in one blocking call (chunk()) or in slices (begin_chunk(), then pump() until it is done), so one task can serve
// other sockets between the slices; so do the connect (begin_start(), then pump() until the head went: fr.csi, design
// csi-c1 D11) and the end (begin_finish(), then pump_answer() until the answer came). The answer's head must fit
// kHeadMax; up to kBodyMax bytes of its body are kept.
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
    /**
     * start() in slices: the same checks, the connect begun without waiting for it, the head the pending piece (in
     * head_, free until the answer). pump() then waits for the connection and sends the head, pending() until it went;
     * both within the timeout from here (a connect that has not come by then fails "connect").
     */
    Status begin_start(const char *host, uint16_t port, std::string_view path, std::string_view headers);
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
    /** finish() in slices: the last chunk begun (the timeout runs from here, for it and the answer); failed when not
     * open or a chunk is pending. */
    Status begin_finish();
    /**
     * Sends what goes of the last chunk and reads what came of the answer, waiting at most `wait_ms`: true once the
     * answer is in (status(), body(); closed), false while it is not. Fails (and closes) as finish() does, once the
     * timeout since begin_finish() passed without the answer's head.
     */
    std::expected<bool, Err> pump_answer(uint32_t wait_ms);
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
    /** start()'s first half: the checks, the head into head_ (its length in `head_len`), the socket, the connect begun
     * (connecting_ while it has not come). */
    Status open_socket(const char *host, uint16_t port, std::string_view path, std::string_view headers,
                       size_t &head_len);
    bool send_all(const void *data, size_t len);
    /** pump() on the socket made non-blocking. */
    std::expected<bool, Err> pump_slice(uint32_t wait_ms);
    /** pump_answer() on the socket made non-blocking. */
    std::expected<bool, Err> answer_slice(uint32_t wait_ms);
    /** Runs `fn` with the socket non-blocking (as it was again after). */
    template <class F>
    std::expected<bool, Err> nonblocking(F &&fn);
    /** The connect begun by begin_start(): true once it is up, false while it is not by `until`; fails at the
     * deadline or on its error. */
    std::expected<bool, Err> connected(int64_t until);
    /** What one recv of the answer did (Step::wait: nothing there yet, a non-blocking socket). */
    enum class Step : uint8_t { more, wait, done, failed };
    /** One recv of the answer (`flags` MSG_DONTWAIT or 0): the head into head_ (got_ bytes so far), then the body. */
    Step answer_step(int flags);
    /** The head is head_[0, len): the status and Content-Length; false when it is not HTTP. */
    bool parse_head(size_t len);
    void keep(const char *p, size_t n);
    /** Reads the answer, blocking: the head (whatever already came is in head_[0, got)), then the body. */
    Status read_answer(size_t got);

    uint32_t timeout_ms_;
    // The chunk being sent: its pieces (the size line with a short `a`, a long `a`, `b`, the CRLF), the next byte.
    std::array<std::span<const uint8_t>, 4> segs_{};
    size_t nsegs_ = 0;
    size_t seg_ = 0;
    size_t off_ = 0;
    size_t chunk_len_ = 0;
    int64_t deadline_ms_ = 0;
    bool connecting_ = false;  // begin_start()'s connect has not come yet
    bool head_out_ = false;    // the pending piece is the request head (in head_)
    // The answer as it comes: head_[0, got_), then the body until Content-Length (remaining_; -1: until the close).
    size_t got_ = 0;
    bool head_done_ = false;
    int code_ = 0;
    int64_t remaining_ = -1;
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
