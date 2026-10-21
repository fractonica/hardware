// fr::ota::Fetch on target (spec 06 §6.5, design c4 §3): HttpGet (src/http) on lwIP sockets, a plain HTTP GET
// of the hub's node port with `Range: bytes=<from>-` when continuing, plus a log line for each failure.
// Blocking, on fr_worker only; one connection at a time.
#include <cinttypes>

#include "esp_log.h"
#include "fr/ota/esp.hpp"
#include "fr/ota/http_get.hpp"

namespace fr::ota::esp {
namespace {

constexpr const char *TAG = "fr_ota";

class EspFetch final : public Fetch
{
public:
    Status start(const char *url, uint32_t from_byte) override
    {
        Status st = http_.start(url, from_byte);
        if (!st) {
            // 404: the hub serves only an fw_id with an outstanding OFFER to this node's address (08 §8.10).
            ESP_LOGW(TAG, "GET %s from %" PRIu32 ": %s (HTTP %d)", url, from_byte, http_.error(), http_.status());
        }
        return st;
    }

    std::expected<size_t, Err> read(std::span<uint8_t> out) override
    {
        auto n = http_.read(out);
        if (!n) {
            ESP_LOGW(TAG, "GET body: %s", http_.error());
        }
        return n;
    }

    void close() override { http_.close(); }

private:
    HttpGet http_{kHttpTimeoutMs};
};

EspFetch s_fetch;

}  // namespace

Fetch &fetch()
{
    return s_fetch;
}

}  // namespace fr::ota::esp
