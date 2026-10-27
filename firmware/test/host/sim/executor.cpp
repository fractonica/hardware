// The fleet kit's executor (design m2-c2 D6, D15): one min-heap of (time, insertion order) holding both plain events
// (at()) and the cores' earliest deadlines (schedule()), and a list of cores touched by the running event, whose
// ready work runs right after it. Virtual time jumps from event to event; wall time waits in a Waiter for the
// heap's head, a watched fd or a wake() from a worker strand, and records every event's lateness.
#include "sim/executor.hpp"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <pthread.h>
#include <sys/event.h>
#include <sys/qos.h>
#endif

#include "sim/sim_core.hpp"

namespace frsim {

// ---- the lag histogram ----

void LagHistogram::add(TimeUs late_us)
{
    const TimeUs late = std::max<TimeUs>(late_us, 0);
    const auto it = std::upper_bound(kBoundsUs.begin(), kBoundsUs.end(), late);
    ++buckets[static_cast<size_t>(it - kBoundsUs.begin())];
    ++count;
    sum_us += late;
    max_us = std::max(max_us, late);
}

TimeUs LagHistogram::quantile(double q) const
{
    if (count == 0) {
        return 0;
    }
    const double want = std::ceil(std::clamp(q, 0.0, 1.0) * static_cast<double>(count));
    const uint64_t rank = std::max<uint64_t>(1, static_cast<uint64_t>(want));
    uint64_t seen = 0;
    for (size_t i = 0; i < kBuckets; ++i) {
        seen += buckets[i];
        if (seen >= rank) {
            return i < kBoundsUs.size() ? kBoundsUs[i] : max_us;
        }
    }
    return max_us;
}

// ---- waiters ----

namespace {

void set_nonblocking(int fd)
{
    ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    ::fcntl(fd, F_SETFD, FD_CLOEXEC);
}

/** poll() and a self-pipe: any platform, the timeout rounded up to whole ms. */
class PollWaiter final : public Waiter
{
public:
    PollWaiter()
    {
        int p[2];
        if (::pipe(p) == 0) {
            set_nonblocking(p[0]);
            set_nonblocking(p[1]);
            rd_ = p[0];
            wr_ = p[1];
        }
    }
    ~PollWaiter() override
    {
        if (rd_ >= 0) {
            ::close(rd_);
            ::close(wr_);
        }
    }

    bool add(int fd, uint32_t events) override
    {
        if (fd < 0 || rd_ < 0) {
            return false;
        }
        fds_[fd] = events;
        return true;
    }
    void remove(int fd) override { fds_.erase(fd); }

    bool wait(TimeUs timeout_us, const std::function<void(int fd, uint32_t events)> &ready) override
    {
        std::vector<pollfd> p;
        p.reserve(fds_.size() + 1);
        p.push_back({.fd = rd_, .events = POLLIN, .revents = 0});
        for (const auto &[fd, ev] : fds_) {
            const short want = static_cast<short>(((ev & kRead) != 0 ? POLLIN : 0) | ((ev & kWrite) != 0 ? POLLOUT : 0));
            p.push_back({.fd = fd, .events = want, .revents = 0});
        }
        const int ms = timeout_us < 0 ? -1 : static_cast<int>(std::min<TimeUs>((timeout_us + 999) / 1000, 1'000'000));
        const int n = ::poll(p.data(), static_cast<nfds_t>(p.size()), ms);
        if (n < 0) {
            return errno == EINTR;
        }
        if ((p[0].revents & POLLIN) != 0) {
            char buf[64];
            while (::read(rd_, buf, sizeof(buf)) > 0) {
            }
        }
        for (size_t i = 1; i < p.size(); ++i) {
            const short r = p[i].revents;
            const uint32_t bits = ((r & (POLLIN | POLLHUP | POLLERR)) != 0 ? kRead : 0) | ((r & POLLOUT) != 0 ? kWrite : 0);
            if (bits != 0) {
                ready(p[i].fd, bits);
            }
        }
        return true;
    }

    void wake() override
    {
        if (wr_ >= 0) {
            const char c = 1;
            [[maybe_unused]] const ssize_t w = ::write(wr_, &c, 1);  // EAGAIN: a wake is already pending
        }
    }

private:
    int rd_ = -1;
    int wr_ = -1;
    std::unordered_map<int, uint32_t> fds_;
};

#if defined(__APPLE__)
/** kqueue: read/write filters per fd, EVFILT_USER for wake(), a µs timespec (poll() rounds to ms). */
class KqueueWaiter final : public Waiter
{
public:
    static constexpr uintptr_t kWakeIdent = 1;

    KqueueWaiter() : kq_(::kqueue())
    {
        if (kq_ >= 0) {
            ::fcntl(kq_, F_SETFD, FD_CLOEXEC);
            struct kevent ev;
            EV_SET(&ev, kWakeIdent, EVFILT_USER, EV_ADD | EV_CLEAR, 0, 0, nullptr);
            ::kevent(kq_, &ev, 1, nullptr, 0, nullptr);
        }
    }
    ~KqueueWaiter() override
    {
        if (kq_ >= 0) {
            ::close(kq_);
        }
    }

    bool add(int fd, uint32_t events) override
    {
        if (fd < 0 || kq_ < 0) {
            return false;
        }
        remove(fd);
        struct kevent ev[2];
        int n = 0;
        if ((events & kRead) != 0) {
            EV_SET(&ev[n++], static_cast<uintptr_t>(fd), EVFILT_READ, EV_ADD, 0, 0, nullptr);
        }
        if ((events & kWrite) != 0) {
            EV_SET(&ev[n++], static_cast<uintptr_t>(fd), EVFILT_WRITE, EV_ADD, 0, 0, nullptr);
        }
        return n == 0 || ::kevent(kq_, ev, n, nullptr, 0, nullptr) == 0;
    }

    void remove(int fd) override
    {
        if (kq_ < 0) {
            return;
        }
        // One change per call: a filter that was never added fails alone (ENOENT), not the other.
        struct kevent ev;
        EV_SET(&ev, static_cast<uintptr_t>(fd), EVFILT_READ, EV_DELETE, 0, 0, nullptr);
        ::kevent(kq_, &ev, 1, nullptr, 0, nullptr);
        EV_SET(&ev, static_cast<uintptr_t>(fd), EVFILT_WRITE, EV_DELETE, 0, 0, nullptr);
        ::kevent(kq_, &ev, 1, nullptr, 0, nullptr);
    }

    bool wait(TimeUs timeout_us, const std::function<void(int fd, uint32_t events)> &ready) override
    {
        struct kevent out[64];
        timespec ts{};
        if (timeout_us >= 0) {
            ts.tv_sec = static_cast<time_t>(timeout_us / 1'000'000);
            ts.tv_nsec = static_cast<long>(timeout_us % 1'000'000) * 1000;
        }
        const int n = ::kevent(kq_, nullptr, 0, out, 64, timeout_us < 0 ? nullptr : &ts);
        if (n < 0) {
            return errno == EINTR;
        }
        for (int i = 0; i < n; ++i) {
            const struct kevent &e = out[i];
            if (e.filter == EVFILT_USER) {
                continue;
            }
            const uint32_t bits = e.filter == EVFILT_WRITE ? kWrite : kRead;  // EV_EOF and errors read as readable
            ready(static_cast<int>(e.ident), bits);
        }
        return true;
    }

    void wake() override
    {
        struct kevent ev;
        EV_SET(&ev, kWakeIdent, EVFILT_USER, 0, NOTE_TRIGGER, 0, nullptr);
        ::kevent(kq_, &ev, 1, nullptr, 0, nullptr);
    }

private:
    int kq_ = -1;
};
#endif

}  // namespace

std::unique_ptr<Waiter> make_poll_waiter()
{
    return std::make_unique<PollWaiter>();
}

std::unique_ptr<Waiter> make_kqueue_waiter()
{
#if defined(__APPLE__)
    return std::make_unique<KqueueWaiter>();
#else
    return nullptr;
#endif
}

std::unique_ptr<Waiter> make_waiter()
{
#if defined(__APPLE__)
    return make_kqueue_waiter();
#else
    return make_poll_waiter();
#endif
}

// ---- the executor ----

struct Executor::Impl {
    /** A heap entry: a plain event (core == nullptr), or a core's deadline. */
    struct Entry {
        TimeUs t = 0;
        uint64_t seq = 0;
        EventId id = 0;
        TimeUs due = 0;  // for lateness: t, or the time it was added when that was later
        SimCore *core = nullptr;
        uint64_t incarnation = 0;
        uint32_t gen = 0;
        TimeUs deadline = 0;  // a core's entry: the deadline it pushed (t may have been moved up to now)
        Fn fn;
    };
    /** std::push_heap keeps the largest first: "larger" here is the later one. */
    struct Later {
        bool operator()(const Entry &a, const Entry &b) const { return a.t != b.t ? a.t > b.t : a.seq > b.seq; }
    };

    TimeMode mode = TimeMode::virtual_time;
    std::unique_ptr<Waiter> waiter;
    std::chrono::steady_clock::time_point origin = std::chrono::steady_clock::now();
    TimeUs vnow = 1'000'000;                // virtual: not 0 at start, like esp_timer after boot (and FakeCore)
    mutable std::atomic<TimeUs> wlast{0};   // wall: the newest now() handed out (monotonic)
    std::vector<Entry> heap;
    std::unordered_set<EventId> pending;  // plain events not yet run or cancelled
    uint64_t seq = 0;
    EventId next_id = 0;
    uint64_t ran = 0;

    std::unordered_map<SimCore *, uint64_t> cores;  // live cores -> incarnation
    uint64_t incarnations = 0;
    std::mutex touch_mu;
    std::vector<std::pair<SimCore *, uint64_t>> touched;
    std::atomic<std::thread::id> loop_thread{std::this_thread::get_id()};

    std::unordered_map<int, FdFn> watches;

    // Wall mode's model time (event_time()): the time the running work stands for, never going back.
    TimeUs model = 0;
    bool looping = false;  // inside run_until

    LagStats lag;
    LagHistogram window;
    int64_t window_index = -1;
    bool qos_set = false;

    TimeUs wall_now() const
    {
        const TimeUs t =
            1'000'000 + std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - origin).count();
        TimeUs prev = wlast.load(std::memory_order_relaxed);
        while (t > prev && !wlast.compare_exchange_weak(prev, t, std::memory_order_relaxed)) {
        }
        return std::max(t, prev);
    }

    TimeUs now() const { return mode == TimeMode::virtual_time ? vnow : wall_now(); }

    /** Wall: the clock's reading, but never past the earliest entry still waiting (which may be stale: earlier is
     * only more cautious). */
    TimeUs io_time() const { return std::max(model, heap.empty() ? wall_now() : std::min(wall_now(), heap.front().t)); }
    /** Wall: work from a watched fd or a worker's wake-up is about to run. */
    void enter_io() { model = io_time(); }

    void push(Entry &&e)
    {
        e.seq = ++seq;
        heap.push_back(std::move(e));
        std::push_heap(heap.begin(), heap.end(), Later{});
    }

    Entry pop()
    {
        std::pop_heap(heap.begin(), heap.end(), Later{});
        Entry e = std::move(heap.back());
        heap.pop_back();
        return e;
    }

    void record(TimeUs late)
    {
        ++ran;
        lag.all.add(late);
        if (late > LagStats::kLateUs) {
            ++lag.late;
        }
        const TimeUs t = now();
        const int64_t w = t / 1'000'000;
        if (w != window_index) {
            if (window_index >= 0 && window.count > 0) {
                lag.last_window = {.start = window_index * 1'000'000,
                                   .events = window.count,
                                   .p50_us = window.quantile(0.5),
                                   .p99_us = window.quantile(0.99),
                                   .max_us = window.max_us};
            }
            window = {};
            window_index = w;
        }
        window.add(late);
    }

    /** An entry for `t` runs: virtual time jumps there; wall mode's model time takes it, however late it runs. */
    void advance(TimeUs t)
    {
        if (mode == TimeMode::virtual_time) {
            vnow = std::max(vnow, t);
        } else {
            model = std::max(model, t);
        }
    }

    /** Runs one entry popped from the heap (its time has come). */
    void run(Entry &e)
    {
        if (e.core == nullptr) {
            if (pending.erase(e.id) == 0) {
                return;  // cancelled
            }
            advance(e.t);
            record(mode == TimeMode::wall ? now() - e.due : 0);
            e.fn();
            return;
        }
        const auto it = cores.find(e.core);
        if (it == cores.end() || it->second != e.incarnation || !e.core->take_entry(e.deadline, e.gen)) {
            return;  // a core gone, crashed since, or an entry overtaken by an earlier one (lazy invalidation)
        }
        advance(e.t);
        record(mode == TimeMode::wall ? now() - e.due : 0);
        e.core->run_ready();
    }

    /** Every touched core runs its ready work, until none is left touched. */
    void drain_touched()
    {
        std::vector<std::pair<SimCore *, uint64_t>> batch;
        for (;;) {
            {
                std::lock_guard<std::mutex> lock(touch_mu);
                batch.swap(touched);
            }
            if (batch.empty()) {
                return;
            }
            for (const auto &[core, inc] : batch) {
                const auto it = cores.find(core);
                if (it == cores.end() || it->second != inc) {
                    continue;
                }
                core->clear_touch();
                core->run_ready();
            }
            batch.clear();
        }
    }

    bool has_touched()
    {
        std::lock_guard<std::mutex> lock(touch_mu);
        return !touched.empty();
    }
};

Executor::Executor(TimeMode mode, std::unique_ptr<Waiter> waiter) : impl_(std::make_unique<Impl>())
{
    impl_->mode = mode;
    if (mode == TimeMode::wall) {
        impl_->waiter = waiter != nullptr ? std::move(waiter) : make_waiter();
    }
}

Executor::~Executor() = default;

TimeMode Executor::mode() const
{
    return impl_->mode;
}

TimeUs Executor::now() const
{
    return impl_->now();
}

EventId Executor::at(TimeUs t, Fn fn)
{
    Impl &m = *impl_;
    const TimeUs now = m.now();
    const EventId id = ++m.next_id;
    m.pending.insert(id);
    // A time already past runs next: in virtual time at the current time, so now() never goes back.
    const TimeUs when = std::max(t, m.mode == TimeMode::virtual_time ? now : t);
    m.push({.t = when,
            .seq = 0,
            .id = id,
            .due = std::max(t, now),
            .core = nullptr,
            .incarnation = 0,
            .gen = 0,
            .deadline = 0,
            .fn = std::move(fn)});
    return id;
}

bool Executor::cancel(EventId id)
{
    return id != 0 && impl_->pending.erase(id) == 1;
}

void Executor::run_until(TimeUs t)
{
    Impl &m = *impl_;
    m.loop_thread.store(std::this_thread::get_id(), std::memory_order_relaxed);
    if (m.mode == TimeMode::virtual_time) {
        for (;;) {
            m.drain_touched();
            if (m.heap.empty() || m.heap.front().t > t) {
                break;
            }
            Impl::Entry e = m.pop();
            m.run(e);
        }
        m.vnow = std::max(m.vnow, t);
        return;
    }
#if defined(__APPLE__)
    if (!m.qos_set) {
        // D6: keep the loop off the E-cores of a loaded Mac (no root needed); published, not relied on.
        m.qos_set = true;
        pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
    }
#endif
    m.looping = true;
    m.enter_io();  // work touched before the loop runs at the clock's reading
    struct Leave {
        Impl &m;
        ~Leave() { m.looping = false; }
    } leave{m};
    for (;;) {
        m.drain_touched();
        const TimeUs n = m.wall_now();
        if (!m.heap.empty() && m.heap.front().t <= n) {
            Impl::Entry e = m.pop();
            m.run(e);
            continue;
        }
        if (n >= t) {
            return;
        }
        if (m.has_touched()) {
            continue;
        }
        const TimeUs next = m.heap.empty() ? t : std::min(m.heap.front().t, t);
        m.waiter->wait(std::max<TimeUs>(next - n, 0), [&m](int fd, uint32_t events) {
            const auto it = m.watches.find(fd);
            if (it != m.watches.end()) {
                const FdFn fn = it->second;  // the callback may unwatch its own fd
                m.enter_io();
                fn(events);
            }
        });
        m.enter_io();  // a worker's wake-up: its posts run at the clock's reading
    }
}

TimeUs Executor::event_time() const
{
    const Impl &m = *impl_;
    if (m.mode == TimeMode::virtual_time) {
        return m.vnow;
    }
    return m.looping ? m.model : m.io_time();
}

bool Executor::watch(int fd, uint32_t events, FdFn fn)
{
    Impl &m = *impl_;
    if (m.mode != TimeMode::wall || !m.waiter->add(fd, events)) {
        return false;
    }
    m.watches[fd] = std::move(fn);
    return true;
}

void Executor::unwatch(int fd)
{
    Impl &m = *impl_;
    if (m.waiter != nullptr) {
        m.waiter->remove(fd);
    }
    m.watches.erase(fd);
}

void Executor::wake()
{
    if (impl_->waiter != nullptr) {
        impl_->waiter->wake();
    }
}

void Executor::schedule(SimCore &core, TimeUs t, uint32_t gen)
{
    Impl &m = *impl_;
    const auto it = m.cores.find(&core);
    if (it == m.cores.end()) {
        return;
    }
    const TimeUs now = m.now();
    m.push({.t = std::max(t, m.mode == TimeMode::virtual_time ? now : t),
            .seq = 0,
            .id = 0,
            .due = std::max(t, now),
            .core = &core,
            .incarnation = it->second,
            .gen = gen,
            .deadline = t,
            .fn = nullptr});
}

void Executor::touch(SimCore &core)
{
    Impl &m = *impl_;
    if (!core.claim_touch()) {
        return;  // already in the list: its run_ready() sees this work too
    }
    {
        std::lock_guard<std::mutex> lock(m.touch_mu);
        m.touched.emplace_back(&core, core.incarnation());
    }
    if (std::this_thread::get_id() != m.loop_thread.load(std::memory_order_relaxed)) {
        wake();
    }
}

const LagStats &Executor::lag() const
{
    return impl_->lag;
}

uint64_t Executor::events_run() const
{
    return impl_->ran;
}

uint64_t Executor::attach_core(SimCore &core)
{
    const uint64_t inc = ++impl_->incarnations;
    impl_->cores[&core] = inc;
    return inc;
}

void Executor::detach_core(SimCore &core)
{
    impl_->cores.erase(&core);
}

}  // namespace frsim
