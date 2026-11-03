// hal::Settings in one NVS namespace (design scale-round-c1 D6): reads at once (board init reads the kept values),
// writes and erases queued on fr_worker in order, so flash never stalls the core task (spec 03 §3.4). The generated
// fr_board builds one per instance of a service that keeps state (codegen ServiceFacts.settings: fr.scale's
// `fr_scale`). ESP-IDF only (src/nvs_settings.cpp); the host suite fakes hal::Settings.
#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/base.hpp"
#include "fr/hal/settings.hpp"

namespace fr::platform {

class NvsSettings final : public hal::Settings
{
public:
    /** `ns` (at most 15 characters) must outlive this; nothing is opened until the first call. */
    explicit constexpr NvsSettings(const char *ns) : ns_(ns) {}

    std::expected<int32_t, Err> get_i32(const char *key) override;
    Status set_i32(const char *key, int32_t value) override;
    /** One fr_worker job for all the keys (the job's callback is too small to carry them: they wait here). */
    Status erase(std::span<const char *const> keys) override;

private:
    void erase_now();

    const char *ns_;
    // The erase waiting for fr_worker (one at a time: another answers Err::busy until it has run).
    std::array<std::array<char, kKeyMax + 1>, kEraseMax> erase_keys_{};
    size_t erase_n_ = 0;
    std::atomic<bool> erase_queued_{false};
};

}  // namespace fr::platform
