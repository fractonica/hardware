// The image download as Ota sees it (design c4 §3): HttpGet (http_get.hpp), an HTTP/1.1 GET with Range over
// BSD sockets, on target (lwIP, src/esp) and in fr_net_node (POSIX); a fake in host tests. Blocking: only
// fr_worker calls it.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/base.hpp"

namespace fr::ota {

class Fetch
{
public:
    /** GETs `url` from `from_byte` on (`Range: bytes=<from_byte>-` when > 0); the open handle is kept
     * for the reads. */
    virtual Status start(const char *url, uint32_t from_byte) = 0;
    /** Up to `out.size()` bytes of the body; 0 when it is complete. */
    virtual std::expected<size_t, Err> read(std::span<uint8_t> out) = 0;
    virtual void close() = 0;

protected:
    ~Fetch() = default;
};

}  // namespace fr::ota
