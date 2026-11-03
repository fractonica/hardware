// Fakes for ScaleService's tests (design scale-round-c1 D9): a hal::LoadCell whose conversions the test pushes with
// their times (its rate_hz counts the ones of the last second on the fake clock, as the driver's window does), and a
// hal::Settings kept in a map that outlives a service (a reboot is a new service on the same FakeSettings). Both run on
// the test's one thread.
#pragma once

#include <cstdint>
#include <cstring>
#include <deque>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "fr/base.hpp"
#include "fr/hal/load_cell.hpp"
#include "fr/hal/settings.hpp"
#include "tests/fake_core.hpp"

namespace frt {

class FakeLoadCell final : public fr::hal::LoadCell
{
public:
    explicit FakeLoadCell(const FakeCore &core) : core_(core) {}

    fr::Status init(fr::Core &) override
    {
        ++inits;
        if (fail_init) {
            return std::unexpected(fr::Err::failed);
        }
        return {};
    }
    fr::Status start(fr::hal::LoadCellGain g) override
    {
        ++starts;
        started = true;
        gain = g;
        return {};
    }
    fr::Status stop() override
    {
        started = false;
        return {};
    }
    bool take(fr::hal::LoadCellSample &out) override
    {
        if (queue.empty()) {
            return false;
        }
        out = queue.front();
        queue.pop_front();
        return true;
    }
    /** The conversions pushed in (now - 1 s, now]. */
    uint8_t rate_hz() const override
    {
        const fr::TimeUs now = core_.now();
        uint32_t n = 0;
        for (fr::TimeUs t : times) {
            n += (t > now - 1'000'000 && t <= now) ? 1 : 0;
        }
        return static_cast<uint8_t>(n > 255 ? 255 : n);
    }
    uint8_t resolution_bits() const override { return 24; }
    uint8_t max_rate_hz() const override { return 80; }
    fr::hal::Selftest selftest() override { return {!times.empty(), times.empty() ? "no conversion" : "fake"}; }

    /** A conversion that became ready at `at` (the service takes it at its next tick). */
    void push(int32_t raw, fr::TimeUs at)
    {
        queue.push_back({raw, at});
        times.push_back(at);
    }

    bool fail_init = false;
    bool started = false;
    fr::hal::LoadCellGain gain = fr::hal::LoadCellGain::a128;
    int inits = 0;
    int starts = 0;
    std::deque<fr::hal::LoadCellSample> queue;
    std::vector<fr::TimeUs> times;

private:
    const FakeCore &core_;
};

class FakeSettings final : public fr::hal::Settings
{
public:
    std::expected<int32_t, fr::Err> get_i32(const char *key) override
    {
        ++gets;
        if (fail_get) {
            return std::unexpected(fr::Err::failed);
        }
        auto it = kept.find(key);
        if (it == kept.end()) {
            return std::unexpected(fr::Err::not_found);
        }
        return it->second;
    }
    fr::Status set_i32(const char *key, int32_t value) override
    {
        if (std::strlen(key) > kKeyMax) {
            return std::unexpected(fr::Err::invalid_args);
        }
        if (refuse) {
            return std::unexpected(*refuse);
        }
        kept[key] = value;
        log.push_back(std::string("set ") + key + "=" + std::to_string(value));
        return {};
    }
    fr::Status erase(std::span<const char *const> keys) override
    {
        if (keys.empty() || keys.size() > kEraseMax) {
            return std::unexpected(fr::Err::invalid_args);
        }
        if (refuse) {
            return std::unexpected(*refuse);  // all or nothing, as NvsSettings
        }
        std::string line = "erase";
        for (const char *k : keys) {
            kept.erase(k);
            line += std::string(" ") + k;
        }
        log.push_back(line);
        return {};
    }

    std::map<std::string, int32_t> kept;
    std::vector<std::string> log;
    std::optional<fr::Err> refuse;  // set/erase answer this (Err::busy: fr_worker's queue full)
    bool fail_get = false;
    int gets = 0;
};

}  // namespace frt
