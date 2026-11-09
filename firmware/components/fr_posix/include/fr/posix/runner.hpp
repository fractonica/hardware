// The node's one thread (design uno-q-host §2.5 step 2): poll() on the hub's TCP socket, the core's wake pipe and any
// descriptors the application adds, then the core's ready work, the worker's jobs and the application's turn hook,
// until SIGTERM or SIGINT (a BYE shutdown goes out first) or fr.node.reboot (exit code kExitRestart).
#pragma once

#include <functional>
#include <vector>

#include "fr/net/net.hpp"
#include "fr/posix/core.hpp"
#include "fr/posix/device.hpp"
#include "fr/posix/links.hpp"
#include "fr/posix/store.hpp"

namespace fr::posix {

class Runner
{
public:
    Runner(PosixCore &core, InlineWorker &worker, net::Net &net, Device &device, TcpLink &tcp)
        : core_(core), worker_(worker), net_(net), device_(device), tcp_(tcp)
    {
    }

    /** A descriptor to wait on; `on_ready` gets poll()'s revents on the Runner thread. */
    void watch(int fd, short events, std::function<void(short)> on_ready);
    /** Called once per loop turn, after the core ran (stores' retries, application housekeeping). */
    std::function<void()> each_turn;
    /** The longest poll() wait, so each_turn runs at least this often. */
    TimeUs max_wait_us = 100'000;

    /** Installs the SIGTERM/SIGINT handlers and loops; returns the process exit code. */
    int run();

private:
    struct Watch {
        int fd;
        short events;
        std::function<void(short)> on_ready;
    };

    void turn(int timeout_ms);

    PosixCore &core_;
    InlineWorker &worker_;
    net::Net &net_;
    Device &device_;
    TcpLink &tcp_;
    std::vector<Watch> watches_;
};

}  // namespace fr::posix
