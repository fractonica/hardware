// The audio services' platform layer (design audio-a1 D5): what differs between the board and the Mac, as fr_ui's
// runtime does for the renderer. The board (fr_core/src/audio_rt_esp.cpp) runs fr_audio and fr_stream as FreeRTOS
// tasks, with FreeRTOS mutexes and binary semaphores and heap_caps buffers (PSRAM when CONFIG_SPIRAM); the Mac
// (fr_core/src/host/audio_rt.cpp) as std::threads, with std::mutex, condition variables and malloc. The rest of the
// audio code (fr/audio/*, the services) is the same on both.
#pragma once

#include <cstddef>
#include <cstdint>

namespace fr::audio {

struct Rt {
    /** A task the Engine runs: its name, FreeRTOS priority and stack, and whether it sits on core 0 (dual core). */
    struct TaskSpec {
        const char *name;
        uint32_t priority;
        uint32_t stack_bytes;
        bool core0;
    };

    /**
     * `bytes` for a ring: PSRAM when the build has it (CONFIG_SPIRAM; Mac: always, as the s3a-audio board), internal
     * RAM otherwise; nullptr when there is not that much. Init only.
     */
    static void *alloc(size_t bytes);
    static void release(void *p);
    /** Whether alloc() hands out PSRAM: the rings' sizes follow (fr/audio/rings.hpp). */
    static bool psram();
    /** Mac only (no board definition): psram() answers `on` from now on, so the host suite runs the no-PSRAM sizes. */
    static void set_psram(bool on);

    /** Starts `fn(arg)` as a task; false when it cannot. */
    static bool spawn(const TaskSpec &spec, void (*fn)(void *), void *arg);
    /** Mac: waits for every task spawn() started to return (Engine::stop). Board: nothing (they never end). */
    static void join_all();

    /** A mutex (priority inheritance on the board); nullptr when none can be made. Init only. */
    static void *mutex_create();
    static void lock(void *m);
    static void unlock(void *m);

    /** A binary signal: give() from any task, take() waits for it up to `ms`; nullptr when none can be made. */
    static void *signal_create();
    static void give(void *s);
    /** True when given (the give is consumed), false on the timeout. */
    static bool take(void *s, uint32_t ms);

    static void sleep_ms(uint32_t ms);
};

/** Rt's mutex held for a scope. */
class LockGuard
{
public:
    explicit LockGuard(void *m) : m_(m)
    {
        if (m_ != nullptr) {
            Rt::lock(m_);
        }
    }
    ~LockGuard()
    {
        if (m_ != nullptr) {
            Rt::unlock(m_);
        }
    }
    LockGuard(const LockGuard &) = delete;
    LockGuard &operator=(const LockGuard &) = delete;

private:
    void *m_;
};

}  // namespace fr::audio
