// The image download as one small HTTP/1.1 GET over BSD sockets (design c4 §3): lwIP's on target, POSIX on
// the host, from one source (src/http), so fr_ota pulls in no esp_http_client, esp-tls or mbedTLS SSL, and
// fr_net_node's OTA fake downloads with the code the board runs. Plain HTTP to a dotted IPv4 (the hub's
// address of the TCP session, spec 06 §6.5 L0), `Connection: close`, `Range: bytes=<from>-` when
// continuing; the answer must be 200 or 206 (a 206 whose Content-Range starts at `from`; a 200 to a Range
// request is skipped up to `from`), with Content-Length or a body that ends at the close, never chunked.
// Blocking with a timeout on the connect, every send and every receive: fr_worker calls it for OTA, and fr.audio_out's
// play GET on fr_stream (design audio-a1 D3), which looks with readable() first so that its record stream is not held up.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/base.hpp"
#include "fr/ota/defs.hpp"
#include "fr/ota/fetch.hpp"

namespace fr::ota {

class HttpGet final : public Fetch
{
public:
    /** The response head (status line and headers) must fit this; the hub's is about 250 bytes. */
    static constexpr size_t kHeadMax = 512;

    explicit HttpGet(uint32_t timeout_ms = kHttpTimeoutMs) : timeout_ms_(timeout_ms) {}
    ~HttpGet() { close(); }
    HttpGet(const HttpGet &) = delete;
    HttpGet &operator=(const HttpGet &) = delete;

    /** Connects, sends the GET and reads the response head. not_found for a 404 (the hub serves only an
     * fw_id with an outstanding OFFER to this node, 08 §8.10), invalid_args for a URL it cannot take,
     * unsupported for a chunked body, failed otherwise; error() says which step. */
    Status start(const char *url, uint32_t from_byte) override;
    /** Up to `out.size()` bytes of the body from `from_byte` on, as they arrive (one receive, which waits
     * at most the timeout); 0 once all of it came. A body cut short before its Content-Length, a timeout
     * or a reset fail. */
    std::expected<size_t, Err> read(std::span<uint8_t> out) override;
    /**
     * Whether a read() would return at once (body bytes came, the body is over, the peer closed), looking for at most
     * `wait_ms`; false while nothing is there yet. Fails (and closes) once nothing came for the timeout since start()
     * or the last read() that got bytes, as a read() waiting that long would. Not for a 200 still skipping up to a
     * Range's `from_byte` (its read() may wait on).
     */
    std::expected<bool, Err> readable(uint32_t wait_ms);
    void close() override;

    /** The status code of the last start(); 0 when no status line came. */
    int status() const { return status_; }
    /** The step the last start() or read() failed at ("connect", "timeout", "status", ...); "" if none. */
    const char *error() const { return error_; }

private:
    Status fail_start(const char *why, Err e = Err::failed);
    std::expected<size_t, Err> fail_read(const char *why);
    /** Reads until the blank line ending the head; whatever follows it stays in head_ as body. */
    bool read_head(size_t &head_len);
    Status parse_head(size_t head_len, uint32_t from_byte);

    uint32_t timeout_ms_;
    int fd_ = -1;
    int status_ = 0;
    const char *error_ = "";
    int64_t remaining_ = -1;  // Content-Length still to come; -1: until the close
    uint32_t skip_ = 0;       // bytes to drop first (a 200 answering a Range request)
    size_t body_at_ = 0;      // body bytes that came with the head: head_[body_at_, body_end_)
    size_t body_end_ = 0;
    int64_t data_ms_ = 0;     // when bytes last came (steady clock, ms): readable()'s stall
    char head_[kHeadMax];
};

}  // namespace fr::ota
