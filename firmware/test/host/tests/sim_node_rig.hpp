// A small fleet in virtual time for the kit's node tests (sim_node_test.cpp, sim_commands_test.cpp): FleetNodes on
// one Medium in one room, an AP, no hub (their TCP and UDP have no port to go to, so they stay quiet), no USB bridge
// and no worker pool (each strand's jobs run on the executor). Their state lives in a temp directory removed at the
// end. Test code.
#pragma once

#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "sim/ap.hpp"
#include "sim/executor.hpp"
#include "sim/links.hpp"
#include "sim/medium.hpp"
#include "sim/node.hpp"
#include "sim/rng.hpp"
#include "sim/sim_air.hpp"
#include "sim/topology.hpp"

namespace frt {

/** Lines a fleet prints, kept. */
class LineLog final : public frsim::LineSink
{
public:
    void write_line(std::string_view line) override
    {
        const std::lock_guard lock(mu_);
        lines_.emplace_back(line);
    }
    std::vector<std::string> lines() const
    {
        const std::lock_guard lock(mu_);
        return lines_;
    }

private:
    mutable std::mutex mu_;
    std::vector<std::string> lines_;
};

/** `rm -rf` of a test's temp dir (no exceptions: no std::filesystem error paths to handle). */
inline void remove_tree(const std::string &path)
{
    if (DIR *d = ::opendir(path.c_str())) {
        while (const dirent *e = ::readdir(d)) {
            const std::string name = e->d_name;
            if (name == "." || name == "..") {
                continue;
            }
            const std::string p = path + "/" + name;
            struct stat st {};
            if (::lstat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {
                remove_tree(p);
            } else {
                ::unlink(p.c_str());
            }
        }
        ::closedir(d);
    }
    ::rmdir(path.c_str());
}

struct FleetRig {
    /** `profile`: the kit profile every node plays (c6-pad; c3o-analog adds the analog input, design m2-c3-inputs §8). */
    explicit FleetRig(size_t n, bool collisions = false, const std::string &profile = "c6-pad")
        : medium(exec, frsim::MediumConfig{.seed = 1, .collisions = collisions}),
          ap(&medium, frsim::ApConfig{}),
          shared{.exec = exec,
                 .medium = medium,
                 .ap = ap,
                 .bridge = nullptr,
                 .udp = udp,
                 .pool = nullptr,
                 .events = events,
                 .verbosity = verbosity,
                 .tcp = tcp,
                 .arrival = {}}
    {
        char tmpl[] = "/tmp/fr-sim-node-XXXXXX";
        dir = ::mkdtemp(tmpl) != nullptr ? tmpl : "/tmp/fr-sim-node";
        std::vector<frsim::RadioId> radios;
        for (size_t i = 1; i <= n; ++i) {
            auto spec = std::make_unique<frsim::NodeSpec>();
            spec->alias = "sim-0" + std::to_string(i);
            spec->mac = {0x02, 0xf2, 0x00, 0x00, 0x00, static_cast<uint8_t>(i)};
            spec->addr = static_cast<uint16_t>(i);
            spec->net = 42;
            spec->alias_rev = 1;
            spec->rng_seed = frsim::rng::node_seed(1, spec->mac);
            spec->net_log = true;
            spec->profile = profile;
            const std::string alias = spec->alias;
            nodes.push_back(std::make_unique<frsim::FleetNode>(shared, std::move(spec), dir + "/" + alias));
            radios.push_back(nodes.back()->air().radio());
        }
        frsim::TopologyConfig t;
        t.loss_min = t.loss_max = 0;  // the tests count deliveries exactly
        frsim::apply_topology(medium, radios, t, 1);
        for (auto &node : nodes) {
            node->set_hub("127.0.0.1", 0, 0, 0);  // no hub: nothing to connect to
        }
    }
    ~FleetRig()
    {
        nodes.clear();
        remove_tree(dir);
    }

    frsim::FleetNode &node(size_t i) { return *nodes[i - 1]; }
    void run_ms(uint32_t ms) { exec.run_for(static_cast<fr::TimeUs>(ms) * 1000); }

    frsim::Executor exec{frsim::TimeMode::virtual_time};
    frsim::Medium medium;
    frsim::Ap ap;
    frsim::UdpSocket udp;
    LineLog events;
    std::atomic<int> verbosity{1};
    frsim::TcpTiming tcp;
    frsim::FleetShared shared;
    std::string dir;
    std::vector<std::unique_ptr<frsim::FleetNode>> nodes;
};

/** The JSON members of `fields` (`,"state":{...}`) as one object's text, for substring checks. */
inline std::string answer_text(const frsim::FleetNode::Answer &a)
{
    return std::string("{\"ok\":") + (a.ok ? "true" : "false") + a.fields + "}";
}

}  // namespace frt
