// One node's core task in the fleet kit (design m2-c2 D6): EspCore's pools, queues and round (esp_core.cpp) on the
// shared executor. The core keeps one entry in the executor's heap for its earliest deadline and re-pushes it only
// when a timer starts earlier than that entry; a later entry overtaken by an earlier one is dropped when it comes up
// (Executor's lazy invalidation), and a stale one costs one empty pass, as EspCore's stale alarm does.
#include "sim/sim_core.hpp"

#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>
#include <utility>

namespace frsim {

namespace {

/** A bounded FIFO of posted functions (EspCore's PostQueue, without its own lock). */
template <size_t N>
class Ring
{
public:
    bool push(fr::Callback<void(), 32> &&fn)
    {
        if (len_ == N) {
            return false;
        }
        fns_[(head_ + len_) % N] = std::move(fn);
        ++len_;
        return true;
    }
    bool pop(fr::Callback<void(), 32> &out)
    {
        if (len_ == 0) {
            return false;
        }
        out = std::move(fns_[head_]);
        fns_[head_].reset();
        head_ = (head_ + 1) % N;
        --len_;
        return true;
    }
    void clear()
    {
        for (auto &f : fns_) {
            f.reset();
        }
        head_ = 0;
        len_ = 0;
    }
    size_t size() const { return len_; }

private:
    std::array<fr::Callback<void(), 32>, N> fns_{};
    size_t head_ = 0;
    size_t len_ = 0;
};

/** Rounds of one run_ready() before it gives up: work that never settles (a timer re-arming itself at 0 forever)
 * would otherwise hang virtual time. */
constexpr uint32_t kMaxRounds = 1'000'000;

}  // namespace

struct SimCore::Impl {
    struct Timer final : fr::Timer {
        Impl *core = nullptr;
        fr::Callback<void(), 24> on_fire;
        bool armed = false;
        fr::TimeUs deadline = 0;  // core clock
        uint32_t order = 0;       // start order: breaks deadline ties and bounds one pass

        void start(uint32_t delay_us) override
        {
            deadline = core->now() + delay_us;
            order = ++core->order;
            armed = true;
            core->started(deadline);
        }
        void stop() override { armed = false; }
        bool running() const override { return armed; }
    };

    struct Slot final : fr::InputSlot {
        Impl *core = nullptr;
        fr::Callback<void(const fr::InputSample &), 24> on_change;
        bool pending = false;  // under core->mu
        fr::InputSample sample{false, 0, 0};

        void update_from_isr(bool level, fr::TimeUs at) override
        {
            {
                std::lock_guard<std::mutex> lock(core->mu);
                sample.level = level;
                sample.at = at;
                ++sample.edges;
                pending = true;
            }
            core->exec.touch(core->self);
        }
    };

    Impl(SimCore &s, Executor &e, std::string_view n) : self(s), exec(e), name(n) {}

    SimCore &self;
    Executor &exec;
    std::string name;
    uint64_t incarnation = 0;
    uint32_t generation = 0;
    std::atomic<bool> touched{false};
    fr::TimeUs heap_deadline = INT64_MAX;  // executor clock: the entry this core last pushed, not yet taken

    fr::TimeUs offset_us = 0;
    int32_t skew_ppm = 0;
    fr::TimeUs skew_origin = 0;  // executor clock when the skew was set

    std::array<Timer, kTimers> timers{};
    size_t timers_used = 0;
    uint32_t order = 0;
    std::array<Slot, kSlots> slots{};
    size_t slots_used = 0;

    std::mutex mu;  // posts, posts_refused, the slots' samples: post() and update_from_isr() come from any thread
    Ring<kPosts> posts;
    Ring<kNetPosts> net_posts;  // core task only
    Stats stats;

    fr::TimeUs now() const
    {
        const fr::TimeUs e = exec.now();
        if (skew_ppm == 0) {
            return e + offset_us;
        }
        const long double drift = static_cast<long double>(e - skew_origin) * skew_ppm / 1e6L;
        return e + offset_us + static_cast<fr::TimeUs>(std::floor(drift));
    }

    /** The executor time at which this core's clock reaches `t` (rounded up, so the timer is due then). */
    fr::TimeUs to_exec(fr::TimeUs t) const
    {
        if (t == INT64_MAX) {
            return t;
        }
        if (skew_ppm == 0) {
            return t - offset_us;
        }
        const long double e =
            skew_origin + static_cast<long double>(t - offset_us - skew_origin) / (1.0L + skew_ppm / 1e6L);
        fr::TimeUs out = static_cast<fr::TimeUs>(std::ceil(e));
        // The floor() in now() can leave the clock a µs short at `out`: step until it is due.
        while (out < INT64_MAX - 1) {
            const long double drift = static_cast<long double>(out - skew_origin) * skew_ppm / 1e6L;
            if (out + offset_us + static_cast<fr::TimeUs>(std::floor(drift)) >= t) {
                break;
            }
            ++out;
        }
        return out;
    }

    void started(fr::TimeUs deadline)
    {
        const fr::TimeUs at = to_exec(deadline);
        if (at < heap_deadline) {
            heap_deadline = at;
            exec.schedule(self, at, generation);
        }
    }

    fr::TimeUs next_deadline() const
    {
        fr::TimeUs best = INT64_MAX;
        for (size_t i = 0; i < timers_used; ++i) {
            if (timers[i].armed && timers[i].deadline < best) {
                best = timers[i].deadline;
            }
        }
        return best;
    }

    bool service_inputs()
    {
        bool any = false;
        for (size_t i = 0; i < slots_used; ++i) {
            Slot &s = slots[i];
            fr::InputSample sample{false, 0, 0};
            {
                std::lock_guard<std::mutex> lock(mu);
                if (!s.pending) {
                    continue;
                }
                sample = s.sample;
                s.sample.edges = 0;
                s.pending = false;
            }
            s.on_change(sample);
            any = true;
        }
        return any;
    }

    bool service_timers()
    {
        // EspCore: only timers started before this pass are eligible, so one restarted at 0 waits for the next
        // round; every due one runs, earliest deadline first, ties in start order.
        const uint32_t pass = order;
        const fr::TimeUs t = now();
        bool any = false;
        for (;;) {
            Timer *due = nullptr;
            for (size_t i = 0; i < timers_used; ++i) {
                Timer &c = timers[i];
                if (c.armed && c.deadline <= t && static_cast<int32_t>(pass - c.order) >= 0 &&
                    (due == nullptr || c.deadline < due->deadline ||
                     (c.deadline == due->deadline && static_cast<int32_t>(c.order - due->order) < 0))) {
                    due = &c;
                }
            }
            if (due == nullptr) {
                return any;
            }
            due->armed = false;
            due->on_fire();
            any = true;
        }
    }

    bool run_one_post()
    {
        fr::Callback<void(), 32> fn;
        bool have = false;
        {
            std::lock_guard<std::mutex> lock(mu);
            have = posts.pop(fn);
        }
        if (have) {
            fn();
        }
        return have;
    }

    bool run_one_net_post()
    {
        fr::Callback<void(), 32> fn;
        if (!net_posts.pop(fn)) {
            return false;
        }
        fn();
        return true;
    }

    [[noreturn]] void abort_named(const char *what) const
    {
        std::fprintf(stderr, "fleet: node %s: %s\n", name.c_str(), what);
        std::fflush(stderr);
        std::abort();
    }
};

SimCore::SimCore(Executor &exec, std::string_view name) : impl_(std::make_unique<Impl>(*this, exec, name))
{
    for (Impl::Timer &t : impl_->timers) {
        t.core = impl_.get();
    }
    for (Impl::Slot &s : impl_->slots) {
        s.core = impl_.get();
    }
    impl_->incarnation = exec.attach_core(*this);
}

SimCore::~SimCore()
{
    impl_->exec.detach_core(*this);
}

fr::TimeUs SimCore::now() const
{
    return impl_->now();
}

fr::Timer *SimCore::timer(fr::Callback<void(), 24> on_fire)
{
    Impl &m = *impl_;
    if (m.timers_used == kTimers) {
        m.abort_named("timer pool exhausted (28): a Net without its timer is silently dead");
    }
    Impl::Timer &t = m.timers[m.timers_used++];
    t.on_fire = std::move(on_fire);
    t.armed = false;
    return &t;
}

fr::InputSlot *SimCore::input_slot(fr::Callback<void(const fr::InputSample &), 24> on_change)
{
    Impl &m = *impl_;
    if (m.slots_used == kSlots) {
        m.abort_named("input slot pool exhausted (8)");
    }
    Impl::Slot &s = m.slots[m.slots_used];
    s.on_change = std::move(on_change);
    {
        std::lock_guard<std::mutex> lock(m.mu);
        s.pending = false;
        s.sample = {false, 0, 0};
    }
    ++m.slots_used;
    return &s;
}

bool SimCore::post(fr::Callback<void(), 32> fn)
{
    Impl &m = *impl_;
    {
        std::lock_guard<std::mutex> lock(m.mu);
        if (!m.posts.push(std::move(fn))) {
            ++m.stats.posts_refused;
            return false;
        }
    }
    m.exec.touch(*this);
    return true;
}

bool SimCore::post_net(fr::Callback<void(), 32> fn)
{
    Impl &m = *impl_;
    if (!m.net_posts.push(std::move(fn))) {
        ++m.stats.net_posts_refused;
        return false;
    }
    m.exec.touch(*this);
    return true;
}

void SimCore::run_ready()
{
    Impl &m = *impl_;
    const uint32_t gen = m.generation;
    for (uint32_t round = 0;; ++round) {
        if (round == kMaxRounds) {
            m.abort_named("work never settles (a timer re-arming itself at 0?)");
        }
        // EspCore's round (esp_core.cpp loop()): inputs, due timers, one post, one network post.
        bool busy = m.service_inputs();
        busy = m.service_timers() || busy;
        busy = m.run_one_post() || busy;
        busy = m.run_one_net_post() || busy;
        if (!busy || m.generation != gen) {
            break;  // settled, or crash() ran inside a handler: the rebuilt node starts afresh
        }
    }
    const fr::TimeUs next = m.to_exec(m.next_deadline());
    if (next < m.heap_deadline) {
        m.heap_deadline = next;
        m.exec.schedule(*this, next, m.generation);
    }
}

fr::TimeUs SimCore::next_deadline() const
{
    return impl_->next_deadline();
}

uint32_t SimCore::generation() const
{
    return impl_->generation;
}

void SimCore::crash()
{
    Impl &m = *impl_;
    for (Impl::Timer &t : m.timers) {
        t.armed = false;
        t.on_fire.reset();
    }
    m.timers_used = 0;
    {
        std::lock_guard<std::mutex> lock(m.mu);
        for (Impl::Slot &s : m.slots) {
            s.pending = false;
            s.sample = {false, 0, 0};
            s.on_change.reset();
        }
        m.posts.clear();
    }
    m.slots_used = 0;
    m.net_posts.clear();
    ++m.generation;
    m.heap_deadline = INT64_MAX;  // the old entries carry the old generation: dropped when they come up
}

void SimCore::set_clock(fr::TimeUs offset_us, int32_t skew_ppm)
{
    Impl &m = *impl_;
    m.offset_us = offset_us;
    m.skew_ppm = skew_ppm;
    m.skew_origin = m.exec.now();
    // Every deadline is on the core's clock: their executor times moved. The old entry still comes up (an empty pass
    // at worst), and the new one is pushed now.
    m.heap_deadline = INT64_MAX;
    const fr::TimeUs next = m.to_exec(m.next_deadline());
    if (next != INT64_MAX) {
        m.heap_deadline = next;
        m.exec.schedule(*this, next, m.generation);
    }
}

std::string_view SimCore::name() const
{
    return impl_->name;
}

SimCore::Stats SimCore::stats() const
{
    std::lock_guard<std::mutex> lock(impl_->mu);
    Stats s = impl_->stats;
    s.timers = static_cast<uint32_t>(impl_->timers_used);
    return s;
}

Executor &SimCore::executor() const
{
    return impl_->exec;
}

uint64_t SimCore::incarnation() const
{
    return impl_->incarnation;
}

bool SimCore::claim_touch()
{
    return !impl_->touched.exchange(true, std::memory_order_acq_rel);
}

void SimCore::clear_touch()
{
    impl_->touched.store(false, std::memory_order_release);
}

bool SimCore::take_entry(fr::TimeUs t, uint32_t gen)
{
    Impl &m = *impl_;
    if (gen != m.generation || t != m.heap_deadline) {
        return false;
    }
    m.heap_deadline = INT64_MAX;
    return true;
}

}  // namespace frsim
