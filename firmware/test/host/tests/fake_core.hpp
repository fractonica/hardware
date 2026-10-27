// Deterministic stand-ins for the core task and the L1 HAL (spec 10 §10.1 T0): a fake clock that only
// moves when a test advances it, timer/slot/post pools with the EspCore semantics, fake button and light
// drivers, and a Sink that records what services emit.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <span>
#include <utility>
#include <vector>

#include "fr/base.hpp"
#include "fr/cap/capability.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/button.hpp"
#include "fr/hal/light.hpp"
#include "tests/test.hpp"

namespace frt {

/**
 * Core with a fake clock. Nothing runs until the test calls run_ready() or advances the clock; then
 * the core-task order applies: input slots, due timers (earliest deadline first, ties in start order),
 * posted functions, repeated until nothing is ready.
 */
class FakeCore final : public fr::Core
{
public:
    static constexpr size_t kTimers = 32;
    static constexpr size_t kSlots = 8;
    static constexpr size_t kPosts = 16;

    fr::TimeUs now() const override { return now_; }

    fr::Timer *timer(fr::Callback<void(), 24> on_fire) override
    {
        if (timers_used_ == kTimers) {
            return nullptr;
        }
        FakeTimer &t = timers_[timers_used_++];
        t.core = this;
        t.on_fire = on_fire;
        return &t;
    }

    fr::InputSlot *input_slot(fr::Callback<void(const fr::InputSample &), 24> on_change) override
    {
        if (slots_used_ == kSlots) {
            return nullptr;
        }
        FakeSlot &s = slots_[slots_used_++];
        s.on_change = on_change;
        return &s;
    }

    bool post(fr::Callback<void(), 32> fn) override
    {
        if (posts_len_ == kPosts) {
            return false;
        }
        posts_[(posts_head_ + posts_len_) % kPosts] = fn;
        ++posts_len_;
        return true;
    }

    /** Runs everything ready at the current time. */
    void run_ready()
    {
        for (int guard = 0; guard < 100000; ++guard) {
            if (run_slots() || run_one_due_timer() || run_one_post()) {
                continue;
            }
            return;
        }
        std::fprintf(stderr, "FakeCore: work never settles (a timer re-arming at 0?)\n");
        std::abort();
    }

    /** Moves the clock to `t`, stopping at every timer deadline on the way so callbacks see their time. */
    void advance_to(fr::TimeUs t)
    {
        run_ready();
        for (;;) {
            FakeTimer *next = earliest();
            if (next == nullptr || next->deadline > t) {
                break;
            }
            if (next->deadline > now_) {
                now_ = next->deadline;
            }
            run_ready();
        }
        if (t > now_) {
            now_ = t;
        }
        run_ready();
    }

    void advance_ms(uint32_t ms) { advance_to(now_ + static_cast<fr::TimeUs>(ms) * 1000); }
    void advance_us(uint32_t us) { advance_to(now_ + us); }

    size_t timers_used() const { return timers_used_; }
    size_t timers_running() const
    {
        size_t n = 0;
        for (size_t i = 0; i < timers_used_; ++i) {
            n += timers_[i].is_running ? 1 : 0;
        }
        return n;
    }

private:
    struct FakeTimer final : fr::Timer {
        FakeCore *core = nullptr;
        fr::Callback<void(), 24> on_fire;
        bool is_running = false;
        fr::TimeUs deadline = 0;
        uint64_t order = 0;

        void start(uint32_t delay_us) override
        {
            is_running = true;
            deadline = core->now_ + delay_us;
            order = ++core->order_;
        }
        void stop() override { is_running = false; }
        bool running() const override { return is_running; }
    };

    struct FakeSlot final : fr::InputSlot {
        fr::Callback<void(const fr::InputSample &), 24> on_change;
        bool pending = false;
        fr::InputSample sample{};

        void update_from_isr(bool level, fr::TimeUs at) override
        {
            sample.level = level;
            sample.at = at;
            ++sample.edges;
            pending = true;
        }
    };

    bool run_slots()
    {
        bool any = false;
        for (size_t i = 0; i < slots_used_; ++i) {
            FakeSlot &s = slots_[i];
            if (s.pending) {
                fr::InputSample sample = s.sample;
                s.sample.edges = 0;
                s.pending = false;
                s.on_change(sample);
                any = true;
            }
        }
        return any;
    }

    FakeTimer *earliest()
    {
        FakeTimer *best = nullptr;
        for (size_t i = 0; i < timers_used_; ++i) {
            FakeTimer &t = timers_[i];
            if (t.is_running &&
                (best == nullptr || t.deadline < best->deadline || (t.deadline == best->deadline && t.order < best->order))) {
                best = &t;
            }
        }
        return best;
    }

    bool run_one_due_timer()
    {
        FakeTimer *t = earliest();
        if (t == nullptr || t->deadline > now_) {
            return false;
        }
        t->is_running = false;
        t->on_fire();
        return true;
    }

    bool run_one_post()
    {
        if (posts_len_ == 0) {
            return false;
        }
        fr::Callback<void(), 32> fn = std::move(posts_[posts_head_]);
        posts_[posts_head_].reset();
        posts_head_ = (posts_head_ + 1) % kPosts;
        --posts_len_;
        fn();
        return true;
    }

    fr::TimeUs now_ = 1'000'000;  // not 0, so "at - something" stays positive in tests
    uint64_t order_ = 0;
    std::array<FakeTimer, kTimers> timers_{};
    size_t timers_used_ = 0;
    std::array<FakeSlot, kSlots> slots_{};
    size_t slots_used_ = 0;
    std::array<fr::Callback<void(), 32>, kPosts> posts_{};
    size_t posts_head_ = 0;
    size_t posts_len_ = 0;
};

/** A GPIO-like button: edges go through a FakeCore input slot, like an ISR would send them. */
class FakeButton final : public fr::hal::ButtonSource
{
public:
    fr::Status init(fr::Core &core, fr::hal::ButtonSink &sink) override
    {
        ++inits;
        if (fail_init) {
            return std::unexpected(fr::Err::failed);
        }
        sink_ = &sink;
        slot_ = core.input_slot([this](const fr::InputSample &s) { sink_->on_button_edge(s.level, s.at, s.edges); });
        return {};
    }
    bool level_pressed() const override { return level; }
    fr::hal::Selftest selftest() override { return {!level, level ? "pressed at idle" : "idle level ok"}; }

    /** An ISR edge at `at`: the level changes and the slot is updated (the test then runs the core). */
    void edge(bool pressed, fr::TimeUs at)
    {
        level = pressed;
        slot_->update_from_isr(pressed, at);
    }
    /** The level changes without an interrupt being delivered (an edge lost inside the lockout). */
    void set_level_silently(bool pressed) { level = pressed; }

    bool level = false;
    bool fail_init = false;
    int inits = 0;

private:
    fr::hal::ButtonSink *sink_ = nullptr;
    fr::InputSlot *slot_ = nullptr;
};

class FakeLight final : public fr::hal::LightOutput
{
public:
    explicit FakeLight(fr::hal::LightFeatures f = {}) : feat(f) {}

    fr::Status init(fr::Core &) override
    {
        ++inits;
        return {};
    }
    fr::hal::LightFeatures features() const override { return feat; }
    fr::Status write(const fr::hal::LightLevel &l) override
    {
        writes.push_back(l);
        if (fail_writes) {
            return std::unexpected(fr::Err::failed);
        }
        return {};
    }
    fr::hal::Selftest selftest() override
    {
        writes.push_back({.on = true});
        return {true, "readback ok"};
    }

    const fr::hal::LightLevel &last() const { return writes.back(); }

    fr::hal::LightFeatures feat;
    std::vector<fr::hal::LightLevel> writes;
    bool fail_writes = false;
    int inits = 0;
};

/** Records every emission; fields are copied because the service's buffers are temporary. */
class RecordingSink final : public fr::cap::Sink
{
public:
    struct Emission {
        bool is_event;
        uint8_t port;
        uint8_t id;
        fr::cap::Priority prio;
        std::vector<uint8_t> bytes;
        fr::TimeUs at;       // the time the envelope would carry: `at`, or the clock for kNowUs
        fr::TimeUs emitted;  // the clock when the service emitted it
        bool stamped;        // the service passed a time (not kNowUs)
    };

    explicit RecordingSink(const fr::Core &core) : core_(core) {}

    void event(uint8_t port, uint8_t event_id, fr::cap::Priority prio, std::span<const uint8_t> fields,
               fr::TimeUs at, bool /*ordered*/) override
    {
        record(true, port, event_id, prio, fields, at);
    }
    void property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, fr::TimeUs at) override
    {
        record(false, port, prop_id, fr::cap::Priority::normal, value, at);
    }

    std::vector<Emission> events() const
    {
        std::vector<Emission> out;
        for (const Emission &e : log) {
            if (e.is_event) {
                out.push_back(e);
            }
        }
        return out;
    }
    std::vector<Emission> properties() const
    {
        std::vector<Emission> out;
        for (const Emission &e : log) {
            if (!e.is_event) {
                out.push_back(e);
            }
        }
        return out;
    }
    void clear() { log.clear(); }

    std::vector<Emission> log;

private:
    void record(bool is_event, uint8_t port, uint8_t id, fr::cap::Priority prio, std::span<const uint8_t> bytes,
                fr::TimeUs at)
    {
        fr::TimeUs now = core_.now();
        log.push_back({is_event, port, id, prio, {bytes.begin(), bytes.end()}, at < 0 ? now : at, now, at >= 0});
    }

    const fr::Core &core_;
};

/** Value of a varint field in a protobuf-wire body, or `absent` when the field is not there. */
inline uint64_t field_u(std::span<const uint8_t> body, uint32_t field, uint64_t absent = 0)
{
    fr::wire::Reader r(body);
    uint64_t v = absent;
    while (r.next()) {
        if (r.field() == field && r.wire_type() == fr::wire::WireType::varint) {
            v = r.read_uint64();
        } else {
            r.skip();
        }
    }
    return r.ok() ? v : UINT64_MAX;
}

}  // namespace frt
