#include "fr/audio/engine.hpp"

#include <algorithm>
#include <cstdio>

#include "fr/audio/rt.hpp"

namespace fr::audio {
namespace {

StreamHost *s_host = nullptr;

}  // namespace

void format_ipv4(uint32_t ipv4, char *out, size_t len)
{
    std::snprintf(out, len, "%u.%u.%u.%u", static_cast<unsigned>(ipv4 >> 24), static_cast<unsigned>((ipv4 >> 16) & 0xFF),
                  static_cast<unsigned>((ipv4 >> 8) & 0xFF), static_cast<unsigned>(ipv4 & 0xFF));
}

bool parse_ipv4(const char *text, uint32_t &out)
{
    if (text == nullptr) {
        return false;
    }
    uint32_t v = 0;
    const char *p = text;
    for (int part = 0; part < 4; ++part) {
        if (*p < '0' || *p > '9') {
            return false;
        }
        uint32_t octet = 0;
        int digits = 0;
        while (*p >= '0' && *p <= '9') {
            octet = octet * 10 + static_cast<uint32_t>(*p - '0');
            if (++digits > 3 || octet > 255) {
                return false;
            }
            ++p;
        }
        v = v << 8 | octet;
        if (part < 3) {
            if (*p != '.') {
                return false;
            }
            ++p;
        }
    }
    if (*p != '\0') {
        return false;
    }
    out = v;
    return true;
}

void set_stream_host(StreamHost *host)
{
    s_host = host;
}

StreamHost *stream_host()
{
    return s_host;
}

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

bool Engine::add(Worker &w)
{
    const size_t n = count_.load(std::memory_order_relaxed);  // only the core task adds
    if (std::find(workers_.begin(), workers_.begin() + n, &w) != workers_.begin() + n) {
        return true;
    }
    if (n == workers_.size() || !make_signals()) {
        return false;
    }
    workers_[n] = &w;
    count_.store(n + 1, std::memory_order_release);  // the slot first, then the count the tasks look at
    return true;
}

void Engine::remove(Worker &w)
{
    const size_t n = count_.load(std::memory_order_relaxed);
    auto *end = workers_.begin() + n;
    auto *it = std::find(workers_.begin(), end, &w);
    if (it != end) {
        std::copy(it + 1, end, it);
        workers_[n - 1] = nullptr;
        count_.store(n - 1, std::memory_order_release);
    }
}

bool Engine::start()
{
    if (manual_ || started_) {
        return true;
    }
    if (!make_signals()) {
        return false;
    }
    stopping_.store(false, std::memory_order_relaxed);
    // fr_audio with Wi-Fi on core 0 (design D5), as fr_net; fr_stream unpinned (network-bound, below both).
    const Rt::TaskSpec audio{.name = "fr_audio", .priority = kAudioPriority, .stack_bytes = kStackBytes, .core0 = true};
    const Rt::TaskSpec stream{.name = "fr_stream", .priority = kStreamPriority, .stack_bytes = kStackBytes, .core0 = false};
    if (!Rt::spawn(audio, &Engine::audio_main, this) || !Rt::spawn(stream, &Engine::stream_main, this)) {
        return false;
    }
    started_ = true;
    return true;
}

void Engine::stop()
{
    if (!started_) {
        return;
    }
    stopping_.store(true, std::memory_order_release);
    wake_audio();
    wake_stream();
    Rt::join_all();
    started_ = false;
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
    const size_t n = count_.load(std::memory_order_acquire);
    bool any = false;
    for (size_t i = 0; i < n; ++i) {
        any = workers_[i]->stream_pass() || any;
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
