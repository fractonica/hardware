#include "fr/posix/runner.hpp"

#include <poll.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <csignal>

namespace fr::posix {

namespace {

std::atomic<bool> g_stop{false};

extern "C" void on_signal(int)
{
    g_stop.store(true);
}

}  // namespace

void Runner::watch(int fd, short events, std::function<void(short)> on_ready)
{
    watches_.push_back({fd, events, std::move(on_ready)});
}

void Runner::turn(int timeout_ms)
{
    std::vector<pollfd> fds;
    fds.push_back({core_.wake_fd(), POLLIN, 0});
    fds.push_back({tcp_.fd(), tcp_.events(), 0});
    for (const Watch &w : watches_) {
        fds.push_back({w.fd, w.events, 0});
    }
    if (::poll(fds.data(), fds.size(), timeout_ms) < 0 && errno != EINTR) {
        return;
    }
    if (fds[0].revents != 0) {
        core_.drain_wake();
    }
    if (fds[1].fd >= 0 && fds[1].revents != 0) {
        tcp_.on_events(fds[1].revents);
        core_.run_ready();
    }
    for (size_t i = 0; i < watches_.size(); ++i) {
        if (fds[i + 2].revents != 0) {
            watches_[i].on_ready(fds[i + 2].revents);
            core_.run_ready();
        }
    }
}

int Runner::run()
{
    struct sigaction sa {};
    sa.sa_handler = on_signal;
    ::sigemptyset(&sa.sa_mask);
    ::sigaction(SIGTERM, &sa, nullptr);
    ::sigaction(SIGINT, &sa, nullptr);
    ::signal(SIGPIPE, SIG_IGN);

    while (!g_stop.load()) {
        tcp_.poll();
        core_.run_ready();
        while (worker_.run_one()) {
            core_.run_ready();
        }
        if (each_turn) {
            each_turn();
            core_.run_ready();
        }
        if (device_.restart_requested()) {
            // The BYE first (reboot, or what asked for the restart), given a moment to leave.
            net_.bye(device_.restart_bye());
            const TimeUs until = core_.now() + 200'000;
            while (core_.now() < until) {
                core_.run_ready();
                turn(10);
            }
            return kExitRestart;
        }
        const TimeUs now = core_.now();
        const TimeUs next = std::min({core_.next_deadline(), tcp_.next_deadline(), now + max_wait_us});
        turn(static_cast<int>(std::max<TimeUs>(0, (next - now + 999) / 1000)));
    }
    // A clean stop: BYE shutdown on every session, given a moment to leave.
    net_.bye(net::kByeShutdown);
    const TimeUs until = core_.now() + 200'000;
    while (core_.now() < until) {
        core_.run_ready();
        turn(10);
    }
    return 0;
}

}  // namespace fr::posix
