#include "fr/audio/engine.hpp"

#include <algorithm>
#include <cstdio>

#include "fr/audio/rt.hpp"

namespace fr::audio {

Engine &engine()
{
    static Engine e;
    return e;
}

bool Engine::make_signals()
{
    if (audio_sig_ == nullptr) {
        audio_sig_ = Rt::signal_create();
    }
    if (stream_sig_ == nullptr) {
        stream_sig_ = Rt::signal_create();
    }
    return audio_sig_ != nullptr && stream_sig_ != nullptr;
}

namespace {

/** Adds `w` to the table [0, count) of `slots` (core task): the slot first, then the count the tasks look at. */
template <class T, size_t N>
bool add_to(std::array<T *, N> &slots, std::atomic<size_t> &count, T *w)
{
    const size_t n = count.load(std::memory_order_relaxed);  // only the core task adds
    if (std::find(slots.begin(), slots.begin() + n, w) != slots.begin() + n) {
        return true;
    }
    if (n == slots.size()) {
        return false;
    }
    slots[n] = w;
    count.store(n + 1, std::memory_order_release);
    return true;
}

template <class T, size_t N>
void remove_from(std::array<T *, N> &slots, std::atomic<size_t> &count, T *w)
{
    const size_t n = count.load(std::memory_order_relaxed);
    auto *end = slots.begin() + n;
    auto *it = std::find(slots.begin(), end, w);
    if (it != end) {
        std::copy(it + 1, end, it);
        slots[n - 1] = nullptr;
        count.store(n - 1, std::memory_order_release);
    }
}

}  // namespace

bool Engine::add(Worker &w)
{
    if (!make_signals()) {
        return false;
    }
    const size_t n = count_.load(std::memory_order_relaxed);
    if (std::find(workers_.begin(), workers_.begin() + n, &w) != workers_.begin() + n) {
        return true;
    }
    if (n == workers_.size() || stream_count_.load(std::memory_order_relaxed) == streams_.size()) {
        return false;
    }
    add_to(streams_, stream_count_, static_cast<stream::Worker *>(&w));
    return add_to(workers_, count_, &w);
}

bool Engine::add_stream(stream::Worker &w)
{
    return make_signals() && add_to(streams_, stream_count_, &w);
}

void Engine::remove(Worker &w)
{
    remove_from(workers_, count_, &w);
    remove_from(streams_, stream_count_, static_cast<stream::Worker *>(&w));
}

void Engine::remove_stream(stream::Worker &w)
{
    remove_from(streams_, stream_count_, &w);
}

bool Engine::start_stream()
{
    if (manual_ || stream_started_) {
        return true;
    }
    if (!make_signals()) {
        return false;
    }
    stopping_.store(false, std::memory_order_relaxed);
    // fr_stream unpinned (network-bound, below fr_audio and fr_net).
    const Rt::TaskSpec stream{.name = "fr_stream", .priority = kStreamPriority, .stack_bytes = kStackBytes, .core0 = false};
    if (!Rt::spawn(stream, &Engine::stream_main, this)) {
        return false;
    }
    stream_started_ = true;
    return true;
}

bool Engine::start()
{
    if (manual_ || started_) {
        return true;
    }
    if (!make_signals() || !start_stream()) {
        return false;
    }
    // fr_audio with Wi-Fi on core 0 (design D5), as fr_net.
    const Rt::TaskSpec audio{.name = "fr_audio", .priority = kAudioPriority, .stack_bytes = kStackBytes, .core0 = true};
    if (!Rt::spawn(audio, &Engine::audio_main, this)) {
        return false;
    }
    started_ = true;
    return true;
}

void Engine::stop()
{
    if (!started_ && !stream_started_) {
        return;
    }
    stopping_.store(true, std::memory_order_release);
    wake_audio();
    wake_stream();
    Rt::join_all();
    started_ = false;
    stream_started_ = false;
}

void Engine::wake_audio()
{
    if (audio_sig_ != nullptr) {
        Rt::give(audio_sig_);
    }
}

void Engine::wake_stream()
{
    if (stream_sig_ != nullptr) {
        Rt::give(stream_sig_);
    }
}

bool Engine::audio_once()
{
    // The inputs first: a running microphone's read waits up to kWaitMs for its next DMA buffer and so paces the loop.
    // Then the outputs: without waiting when an input ran (each fills all the room its DMA has, which holds more than
    // one input buffer's time: AudioOutService writes until a write takes nothing), else up to kWaitMs for room.
    const size_t n = count_.load(std::memory_order_acquire);
    bool input_ran = false;
    for (size_t i = 0; i < n; ++i) {
        if (workers_[i]->is_input()) {
            input_ran = workers_[i]->audio_pass(kWaitMs) || input_ran;
        }
    }
    bool any = input_ran;
    for (size_t i = 0; i < n; ++i) {
        if (!workers_[i]->is_input()) {
            any = workers_[i]->audio_pass(input_ran ? 0 : kWaitMs) || any;
        }
    }
    return any;
}

bool Engine::stream_once()
{
    const size_t n = stream_count_.load(std::memory_order_acquire);
    bool any = false;
    for (size_t i = 0; i < n; ++i) {
        any = streams_[i]->stream_pass() || any;
    }
    return any;
}

void Engine::audio_main(void *arg)
{
    auto *e = static_cast<Engine *>(arg);
    while (!e->stopping_.load(std::memory_order_acquire)) {
        if (!e->audio_once()) {
            Rt::take(e->audio_sig_, kIdleMs);
        }
    }
}

void Engine::stream_main(void *arg)
{
    auto *e = static_cast<Engine *>(arg);
    while (!e->stopping_.load(std::memory_order_acquire)) {
        if (!e->stream_once()) {
            Rt::take(e->stream_sig_, kWaitMs);
        }
    }
}

MonitorSink *Engine::monitor_sink(uint8_t port)
{
    const size_t n = count_.load(std::memory_order_acquire);
    for (size_t i = 0; i < n; ++i) {
        if (!workers_[i]->is_input() && workers_[i]->worker_port() == port) {
            return workers_[i]->monitor_sink();
        }
    }
    return nullptr;
}

size_t Engine::stats(std::span<WorkerStats> out) const
{
    const size_t n = count_.load(std::memory_order_acquire);
    size_t k = 0;
    for (size_t i = 0; i < n && k < out.size(); ++i) {
        out[k] = {};
        if (workers_[i]->stats(out[k])) {
            ++k;
        }
    }
    return k;
}

#if FR_TEST_HOOKS
Status Engine::stall(uint32_t ms)
{
    Status last = std::unexpected(Err::not_found);
    const size_t n = count_.load(std::memory_order_acquire);
    for (size_t i = 0; i < n; ++i) {
        const Status st = workers_[i]->stall(ms);
        if (st) {
            return st;
        }
        if (st.error() != Err::not_found) {
            last = st;  // a refusal of the stream that runs beats "no stream" from the others
        }
    }
    return last;
}
#endif

}  // namespace fr::audio
