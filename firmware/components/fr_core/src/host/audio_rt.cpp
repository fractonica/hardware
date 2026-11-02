// The audio platform layer on the Mac (fr/audio/rt.hpp): std::thread tasks (fr_net_node runs fr_audio and fr_stream
// for real, D10), std::mutex, a condition-variable signal and malloc. The host suite drives the Engine by hand
// (Engine::set_manual) and spawns nothing. Test code: it may allocate.
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <mutex>
#include <thread>
#include <vector>

#include "fr/audio/rt.hpp"

namespace fr::audio {
namespace {

struct Signal {
    std::mutex m;
    std::condition_variable cv;
    bool given = false;
};

std::mutex s_tasks_mutex;
std::vector<std::thread> s_tasks;
std::atomic<bool> s_psram{true};  // the Mac plays the s3a-audio board, which has PSRAM

}  // namespace

void *Rt::alloc(size_t bytes)
{
    return std::malloc(bytes);
}

void Rt::release(void *p)
{
    std::free(p);
}

bool Rt::psram()
{
    return s_psram.load(std::memory_order_relaxed);
}

void Rt::set_psram(bool on)
{
    s_psram.store(on, std::memory_order_relaxed);
}

bool Rt::spawn(const TaskSpec &, void (*fn)(void *), void *arg)
{
    const std::lock_guard<std::mutex> g(s_tasks_mutex);
    s_tasks.emplace_back(fn, arg);
    return true;
}

void Rt::join_all()
{
    std::vector<std::thread> tasks;
    {
        const std::lock_guard<std::mutex> g(s_tasks_mutex);
        tasks.swap(s_tasks);
    }
    for (std::thread &t : tasks) {
        t.join();
    }
}

void *Rt::mutex_create()
{
    return new std::mutex;
}

void Rt::lock(void *m)
{
    static_cast<std::mutex *>(m)->lock();
}

void Rt::unlock(void *m)
{
    static_cast<std::mutex *>(m)->unlock();
}

void *Rt::signal_create()
{
    return new Signal;
}

void Rt::give(void *s)
{
    auto *sig = static_cast<Signal *>(s);
    {
        const std::lock_guard<std::mutex> g(sig->m);
        sig->given = true;
    }
    sig->cv.notify_one();
}

bool Rt::take(void *s, uint32_t ms)
{
    auto *sig = static_cast<Signal *>(s);
    std::unique_lock<std::mutex> g(sig->m);
    if (!sig->cv.wait_for(g, std::chrono::milliseconds(ms), [sig] { return sig->given; })) {
        return false;
    }
    sig->given = false;
    return true;
}

void Rt::sleep_ms(uint32_t ms)
{
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}

}  // namespace fr::audio
