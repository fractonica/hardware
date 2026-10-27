// fr_fleet: N nodes in one process against a private hub (design m2-c2 D1, D7, D8), for the T2-*-30 gates. One
// thread runs every node's Net on its own SimCore, the medium, an AP model and the executor in wall time; blocking
// OTA downloads run on worker strands (16 pool threads, one serial strand per node). The sim runner
// (tests/sim/lib/runner.ts, through tests/sim/lib/fleet.ts) writes the spec file, starts it, then starts the private
// hub with --serial-bridge pointing at the bridge port it printed.
//
// The contract (design m2-c2 §3; the schemas are in packages/protocol/src/sim.ts):
//   fr_fleet --spec <file.json>     the spec, fractonica/fleet-spec@1 (FleetSpecSchema): seed, pace, verbosity,
//                                   state_dir, medium, ap and nodes[]
//   fr_fleet --make-image <path> [--version V] [--size N] [--board B] [--profile P] [--part X] [--chip N]
//            [--min-rev N] [--max-rev N] [--fault 0|1] [--seed N]
//                                   an app image the nodes' CHECK accepts (fr_net_node's), for T2-OTA-30's artifacts
// With --spec it opens its control and bridge listeners on 127.0.0.1, raises its RLIMIT_NOFILE soft limit to
// min(hard, need) (need 3N + 64: a TCP socket and a stale one per node, the USB ports, 16 HTTP GETs, its own), prints
// one line (FleetReadySchema) and starts no node yet:
//   {"fleet":"ready","nodes":30,"spares":0,"control":"127.0.0.1:<p>","bridge":"127.0.0.1:<p>",
//    "nofile":{"soft":…,"hard":…,"need":…},"sanitized":false}
// Control lines, on stdin or the control port (one TCP connection, lines both ways), are `[@<rid>] <target> <command…>`:
//   @<rid> fleet start <hub host> <tcp> <udp> <http> [--stagger-ms n]
//   @<rid> fleet stats | medium | ap off | ap on | spawn <alias> | pace <x> | verbosity <0-3> | quit
//   @<rid> <alias|*> <command>      fr_net_node's stdin commands (sim/commands.hpp), plus `diag <line>`, `power
//                                   off|on`, `usb attach|detach`, `log <L> <tag> <text>` and `log_rate <lines/s>`
//                                   (scaled by `pace`)
// Each node answers one JSON line {"rid":…,"node":…,"ok":…,…}: the lines the command printed in fr_net_node
// (`state`, `msg_sent`, `inject`, ...) come as members named by their `ev` ("state":{"ev":"state",...}); `diag
// <line>` answers "response":{...}, fr.diag.exec's answer as the hub's diag_exec gives it; a failure says "error".
// A `*` command ends with {"rid":…,"done":true,"n":…}. Fleet commands answer as node "fleet". `fleet stats` carries the
// executor's lag histogram (D15), the nodes' arrival skew for hub broadcasts and fan-out (D16) and the links'
// counters; `fleet medium` the medium's channel and radio stats (D4). Every second the fleet prints one counter line,
// {"fleet":"tick",...}; at verbosity 0 that and the answers are all it prints (no per-node or per-frame lines). The
// fleet quits on `fleet quit` or when stdin closes. Test code: it may allocate.
#include <fcntl.h>
#include <signal.h>
#include <sys/resource.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

#include "fr/envelope.hpp"
#include "protocol.hpp"
#include "sim/ap.hpp"
#include "sim/executor.hpp"
#include "sim/links.hpp"
#include "sim/medium.hpp"
#include "sim/node.hpp"
#include "sim/out.hpp"
#include "sim/rng.hpp"
#include "sim/sim_air.hpp"
#include "sim/sim_core.hpp"
#include "sim/topology.hpp"
#include "tools/ota_fake.hpp"

namespace {

using frsim::EventId;
using frsim::FleetNode;
using frsim::sformat;
using fr::TimeUs;

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
constexpr bool kSanitized = true;
#else
constexpr bool kSanitized = false;
#endif
#else
constexpr bool kSanitized = false;
#endif

constexpr const char *kUsage =
    "usage: fr_fleet --spec <file.json>\n"
    "       fr_fleet --make-image <path> [--version V] [--size N] [--board B] [--profile P] [--part X] [--chip N]\n"
    "                [--min-rev N] [--max-rev N] [--fault 0|1] [--seed N]\n"
    "  the spec is fractonica/fleet-spec@1 (packages/protocol/src/sim.ts); fr_fleet prints one `ready` line,\n"
    "  then takes control lines `[@<rid>] <alias|*|fleet> <command...>` on stdin or its control port:\n"
    "    fleet start <hub host> <tcp> <udp> <http> [--stagger-ms n]\n"
    "    fleet stats | medium | ap off | ap on | spawn <alias> | pace <x> | verbosity <n> | quit\n"
    "    <alias|*> <fr_net_node command> | diag <line> | power off|on | usb attach|detach | log <L> <tag> <text>\n";

/**
 * Lines out of a file descriptor without ever blocking the loop (D8): appended under a lock from any thread, written
 * by the loop as the fd takes them. Lines that are not answers are dropped (and counted) past `cap` bytes queued, so
 * a reader that stopped reading costs memory, never the fleet's timing.
 *
 * A control connection's Writer also owns its read side (`on_read`): the executor keeps one watch per fd, its
 * callback replaced by every watch(), so the writer keeps kRead in it for as long as the connection is open, kWrite
 * added only while bytes wait, and never unwatches. Without that, an answer the socket would not take whole swapped
 * the read watch for a write one and its drain removed both: the connection was never read again (later commands
 * unanswered, its close unseen, its fd leaked; review fleet-4).
 */
class Writer final : public frsim::LineSink
{
public:
    static constexpr size_t kCap = 64u << 20;
    using ReadFn = std::function<void()>;

    /** `on_read` (a control connection): called on the loop whenever the fd is readable; it may destroy this Writer. */
    Writer(frsim::Executor &exec, int fd, ReadFn on_read = {})
        : exec_(exec), fd_(fd), loop_(std::this_thread::get_id()), on_read_(std::move(on_read))
    {
        if (on_read_) {
            const std::lock_guard lock(mu_);
            rewatch(false);
        }
    }
    ~Writer()
    {
        if (watched_ != 0) {
            exec_.unwatch(fd_);
        }
    }

    void write_line(std::string_view line) override { add(line, false); }
    /** An answer: never dropped. */
    void answer(std::string_view line) { add(line, true); }
    /** The loop: write what the fd takes now. */
    void flush()
    {
        std::string chunk;
        {
            const std::lock_guard lock(mu_);
            if (buf_.empty() || closed_) {
                return;
            }
            chunk.swap(buf_);
        }
        size_t off = 0;
        while (off < chunk.size()) {
            const ssize_t n = ::write(fd_, chunk.data() + off, chunk.size() - off);
            if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
                break;
            }
            if (n <= 0) {
                const std::lock_guard lock(mu_);
                closed_ = true;  // the reader went away (a control connection's read side sees its close)
                buf_.clear();
                rewatch(false);
                return;
            }
            off += static_cast<size_t>(n);
        }
        const std::lock_guard lock(mu_);
        buf_.insert(0, chunk, off, std::string::npos);
        rewatch(!buf_.empty());
    }
    uint64_t dropped() const { return dropped_.load(); }
    bool closed() const
    {
        const std::lock_guard lock(mu_);
        return closed_;
    }

private:
    /** The fd's one watch: kRead while a control connection is open, kWrite while bytes wait. Under mu_. */
    void rewatch(bool want_write)
    {
        const uint32_t want = (on_read_ ? frsim::Waiter::kRead : 0u) | (want_write ? frsim::Waiter::kWrite : 0u);
        if (want == watched_) {
            return;
        }
        watched_ = want;
        if (want == 0) {
            exec_.unwatch(fd_);
            return;
        }
        exec_.watch(fd_, want, [this](uint32_t ev) {
            if ((ev & frsim::Waiter::kWrite) != 0) {
                flush();
            }
            if ((ev & frsim::Waiter::kRead) != 0 && on_read_) {
                const ReadFn read = on_read_;  // last: it may destroy this Writer (the connection closed)
                read();
            }
        });
    }

    void add(std::string_view line, bool keep)
    {
        {
            const std::lock_guard lock(mu_);
            if (closed_) {
                return;
            }
            if (!keep && buf_.size() > kCap) {
                dropped_.fetch_add(1);
                return;
            }
            buf_.append(line);
            buf_ += '\n';
        }
        if (std::this_thread::get_id() == loop_) {
            flush();
        } else {
            exec_.wake();  // a worker strand's line: the loop's periodic flush takes it
        }
    }

    frsim::Executor &exec_;
    int fd_;
    std::thread::id loop_;
    ReadFn on_read_;
    mutable std::mutex mu_;
    std::string buf_;
    bool closed_ = false;
    uint32_t watched_ = 0;  // the Waiter bits the fd is watched for
    std::atomic<uint64_t> dropped_{0};
};

/** A histogram of µs values with fine low buckets: arrival skew is µs to a few ms (D16, C9's input). */
struct SkewHistogram {
    static constexpr std::array<TimeUs, 15> kBoundsUs{10, 25, 50, 100, 250, 500, 1'000, 2'500, 5'000, 10'000, 25'000,
                                                      50'000, 100'000, 250'000, 1'000'000};
    std::array<uint64_t, kBoundsUs.size() + 1> buckets{};
    uint64_t count = 0;
    TimeUs sum_us = 0;
    TimeUs max_us = 0;

    void add(TimeUs v)
    {
        v = std::max<TimeUs>(v, 0);
        size_t i = 0;
        while (i < kBoundsUs.size() && v >= kBoundsUs[i]) {
            ++i;
        }
        ++buckets[i];
        ++count;
        sum_us += v;
        max_us = std::max(max_us, v);
    }
    TimeUs quantile(double q) const
    {
        if (count == 0) {
            return 0;
        }
        const auto rank = static_cast<uint64_t>(std::ceil(q * static_cast<double>(count)));
        uint64_t seen = 0;
        for (size_t i = 0; i < buckets.size(); ++i) {
            seen += buckets[i];
            if (seen >= std::max<uint64_t>(rank, 1)) {
                return i < kBoundsUs.size() ? kBoundsUs[i] : max_us;
            }
        }
        return max_us;
    }
    std::string json() const
    {
        std::string b;
        for (size_t i = 0; i < buckets.size(); ++i) {
            b += (i == 0 ? "" : ",") + std::to_string(buckets[i]);
        }
        std::string bounds;
        for (size_t i = 0; i < kBoundsUs.size(); ++i) {
            bounds += (i == 0 ? "" : ",") + std::to_string(kBoundsUs[i]);
        }
        return sformat(R"({"count":%llu,"sum_us":%lld,"max_us":%lld,"p50_us":%lld,"p99_us":%lld,"bounds_us":[%s],"buckets":[%s]})",
                       static_cast<unsigned long long>(count), static_cast<long long>(sum_us), static_cast<long long>(max_us),
                       static_cast<long long>(quantile(0.5)), static_cast<long long>(quantile(0.99)), bounds.c_str(), b.c_str());
    }
};

/**
 * Each broadcast's arrival skew at the nodes (D16): for every envelope to kAddrBroadcast that reached nodes over
 * their hub links (a hub broadcast, src 0, or the hub's fan-out of a node's broadcast), the time from its first copy
 * read at any node to its last, on the fleet's one clock. A node's second copy (TCP and serial) counts once. Closed 1 s
 * after the first copy.
 */
class ArrivalSkew
{
public:
    void arrived(const frsim::NodeSpec &node, std::span<const uint8_t> env, TimeUs at)
    {
        const auto h = fr::wire::unpack_header(env);
        if (!h || h->dst != fr::proto::kAddrBroadcast) {
            return;
        }
        const uint64_t key = static_cast<uint64_t>(h->src) << 48 | static_cast<uint64_t>(h->epoch) << 32 | h->seq;
        Open &o = open_[key];
        if (o.nodes.empty()) {
            o.first = at;
            o.hub = h->src == fr::proto::kAddrHub;
        }
        if (std::find(o.nodes.begin(), o.nodes.end(), node.addr) != o.nodes.end()) {
            return;
        }
        o.nodes.push_back(node.addr);
        o.last = at;
    }
    /** Closes broadcasts first seen more than 1 s before `now`. */
    void close(TimeUs now)
    {
        for (auto it = open_.begin(); it != open_.end();) {
            if (now - it->second.first < 1'000'000) {
                ++it;
                continue;
            }
            if (it->second.nodes.size() >= 2) {
                (it->second.hub ? hub_ : fanout_).add(it->second.last - it->second.first);
            }
            it = open_.erase(it);
        }
    }
    std::string json() const { return sformat(R"({"hub":%s,"fanout":%s})", hub_.json().c_str(), fanout_.json().c_str()); }

private:
    struct Open {
        TimeUs first = 0;
        TimeUs last = 0;
        bool hub = false;
        std::vector<uint16_t> nodes;
    };
    std::unordered_map<uint64_t, Open> open_;
    SkewHistogram hub_;
    SkewHistogram fanout_;
};

std::string lag_json(const frsim::LagStats &lag)
{
    const frsim::LagHistogram &h = lag.all;
    std::string b;
    for (size_t i = 0; i < h.buckets.size(); ++i) {
        b += (i == 0 ? "" : ",") + std::to_string(h.buckets[i]);
    }
    std::string bounds;
    for (size_t i = 0; i < frsim::LagHistogram::kBoundsUs.size(); ++i) {
        bounds += (i == 0 ? "" : ",") + std::to_string(frsim::LagHistogram::kBoundsUs[i]);
    }
    const auto &w = lag.last_window;
    return sformat(R"({"count":%llu,"sum_us":%lld,"max_us":%lld,"p50_us":%lld,"p99_us":%lld,"late":%llu,"bounds_us":[%s],"buckets":[%s],)"
                   R"("window":{"start_ms":%lld,"events":%llu,"p50_us":%lld,"p99_us":%lld,"max_us":%lld}})",
                   static_cast<unsigned long long>(h.count), static_cast<long long>(h.sum_us), static_cast<long long>(h.max_us),
                   static_cast<long long>(h.quantile(0.5)), static_cast<long long>(h.quantile(0.99)),
                   static_cast<unsigned long long>(lag.late), bounds.c_str(), b.c_str(), static_cast<long long>(w.start / 1000),
                   static_cast<unsigned long long>(w.events), static_cast<long long>(w.p50_us), static_cast<long long>(w.p99_us),
                   static_cast<long long>(w.max_us));
}

const char *rate_name(frsim::Rate r)
{
    return r == frsim::Rate::r6m ? "6M" : "1M";
}

std::string medium_json(const frsim::Medium::Stats &s)
{
    auto use = [](const frsim::ChannelUse &u) {
        std::string rates;
        for (size_t r = 0; r < frsim::kRates; ++r) {
            rates += sformat(R"(%s"%s":{"frames":%llu,"bytes":%llu,"collisions":%llu})", r == 0 ? "" : ",",
                             rate_name(static_cast<frsim::Rate>(r)), static_cast<unsigned long long>(u.by_rate[r].frames),
                             static_cast<unsigned long long>(u.by_rate[r].bytes),
                             static_cast<unsigned long long>(u.by_rate[r].collisions));
        }
        return sformat(R"({"busy_us":%llu,"planning_us":%llu,"ip_frames":%llu,"ip_us":%llu,"rates":{%s}})",
                       static_cast<unsigned long long>(u.busy_us), static_cast<unsigned long long>(u.planning_us),
                       static_cast<unsigned long long>(u.ip_frames), static_cast<unsigned long long>(u.ip_us), rates.c_str());
    };
    std::string ch;
    for (const frsim::ChannelStats &c : s.channels) {
        ch += sformat(R"(%s{"channel":%u,"busy_pct":%.2f,"planning_pct":%.2f,"total":%s,"last_window":%s})", ch.empty() ? "" : ",",
                      unsigned{c.channel}, c.busy_pct, c.planning_pct, use(c.total).c_str(), use(c.last_window).c_str());
    }
    std::string radios;
    for (const frsim::RadioStats &r : s.radios) {
        radios += sformat(R"(%s{"tx":%llu,"tx_airtime_us":%llu,"rx":%llu,"lost":%llu,"collided":%llu,"dups":%llu})",
                          radios.empty() ? "" : ",", static_cast<unsigned long long>(r.tx),
                          static_cast<unsigned long long>(r.tx_airtime_us), static_cast<unsigned long long>(r.rx),
                          static_cast<unsigned long long>(r.lost), static_cast<unsigned long long>(r.collided),
                          static_cast<unsigned long long>(r.dups));
    }
    return sformat(R"({"channels":[%s],"radios":[%s]})", ch.c_str(), radios.c_str());
}

/** `--make-image PATH ...`: as fr_net_node's (T2-OTA-30 registers these before the private hub starts, D9). */
int make_image_main(int argc, char **argv)
{
    ota_fake::ImageOptions io;
    const std::string path = argv[2];
    for (int i = 3; i + 1 < argc; i += 2) {
        const std::string_view k = argv[i];
        const char *v = argv[i + 1];
        const unsigned long n = std::strtoul(v, nullptr, 0);
        if (k == "--version") {
            io.version = v;
        } else if (k == "--size") {
            io.size = static_cast<uint32_t>(n);
        } else if (k == "--board") {
            io.board = v;
        } else if (k == "--profile") {
            io.profile = v;
        } else if (k == "--part") {
            io.part = v;
        } else if (k == "--chip") {
            io.chip = static_cast<uint16_t>(n);
        } else if (k == "--min-rev") {
            io.min_rev = static_cast<uint16_t>(n);
        } else if (k == "--max-rev") {
            io.max_rev = static_cast<uint16_t>(n);
        } else if (k == "--fault") {
            io.fault = static_cast<uint8_t>(n);
        } else if (k == "--seed") {
            io.seed = static_cast<uint32_t>(n);
        } else {
            std::fputs(kUsage, stderr);
            return 64;
        }
    }
    const std::vector<uint8_t> img = ota_fake::make_image(io);
    ota_fake::write_file(path, std::string_view(reinterpret_cast<const char *>(img.data()), img.size()));
    std::printf(R"({"ev":"image","fw_id":"%s","size":%zu})"
                "\n",
                ota_fake::hex(std::span<const uint8_t>(img.data() + img.size() - 32, 32)).c_str(), img.size());
    return 0;
}

/** `mkdir -p`: the state directory and its parents. */
void make_dirs(const std::string &path)
{
    for (size_t at = path.find('/', 1); at != std::string::npos; at = path.find('/', at + 1)) {
        ::mkdir(path.substr(0, at).c_str(), 0700);
    }
    ::mkdir(path.c_str(), 0700);
}

/** An rlimit as JSON reads it: RLIM_INFINITY (2^63 - 1) is past a double's exact integers, so it caps at 2^53 - 1. */
unsigned long long json_limit(rlim_t v)
{
    return std::min<unsigned long long>(static_cast<unsigned long long>(v), (1ull << 53) - 1);
}

/** A listening TCP socket on 127.0.0.1 (any free port); -1 when none. */
int listen_loopback(uint16_t &port)
{
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    const int one = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t len = sizeof(a);
    if (::bind(fd, reinterpret_cast<sockaddr *>(&a), sizeof(a)) != 0 || ::listen(fd, 16) != 0 ||
        ::getsockname(fd, reinterpret_cast<sockaddr *>(&a), &len) != 0) {
        ::close(fd);
        return -1;
    }
    ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    port = ntohs(a.sin_port);
    return fd;
}

/** The fleet: its nodes and what they share, the control channel, and the per-second counters. */
class Fleet
{
public:
    Fleet(frsim::FleetSpec spec, frsim::Executor &exec, Writer &stdout_writer)
        : spec_(std::move(spec)),
          exec_(exec),
          stdout_(stdout_writer),
          verbosity_(spec_.verbosity),
          pace_(spec_.pace),
          medium_(exec, frsim::MediumConfig{.seed = spec_.seed,
                                            .collisions = spec_.medium.collisions,
                                            .capture_db = spec_.medium.capture_db}),
          ap_(&medium_, ap_config(spec_)),
          bridge_(exec),
          pool_(16),
          shared_{.exec = exec,
                  .medium = medium_,
                  .ap = ap_,
                  .bridge = &bridge_,
                  .udp = udp_,
                  .pool = &pool_,
                  .events = stdout_writer,
                  .verbosity = verbosity_,
                  .tcp = tcp_timing_,
                  .pace = &pace_,
                  .arrival = [this](const frsim::NodeSpec &n, std::span<const uint8_t> env, TimeUs at) {
                      skew_.arrived(n, env, at);
                  }}
    {
    }

    /** Builds the nodes (not started) and the medium's pair table; opens the listeners. False with a reason. */
    bool init(std::string &error)
    {
        if (!bridge_.listen(0)) {
            error = "cannot open the bridge listener";
            return false;
        }
        control_fd_ = listen_loopback(control_port_);
        if (control_fd_ < 0 || !exec_.watch(control_fd_, frsim::Waiter::kRead, [this](uint32_t) { accept(); })) {
            error = "cannot open the control listener";
            return false;
        }
        make_dirs(spec_.state_dir);
        std::vector<frsim::RadioId> radios;
        for (const frsim::NodeSpec &ns : spec_.nodes) {
            auto node = std::make_unique<FleetNode>(shared_, std::make_unique<frsim::NodeSpec>(ns),
                                                    spec_.state_dir + "/" + ns.alias);
            radios.push_back(node->air().radio());
            index_[ns.alias] = nodes_.size();
            nodes_.push_back(std::move(node));
        }
        apply_topology(medium_, radios, topology(), spec_.seed);
        ap_.listen([this](bool up) {
            for (const auto &n : nodes_) {
                n->ap_changed(up);
            }
        });
        stdin_buf_.clear();
        exec_.watch(STDIN_FILENO, frsim::Waiter::kRead, [this](uint32_t) { read_stdin(); });
        schedule_tick();
        schedule_flush();
        return true;
    }

    uint16_t control_port() const { return control_port_; }
    uint16_t bridge_port() const { return bridge_.port(); }
    size_t started_nodes() const
    {
        return static_cast<size_t>(std::count_if(spec_.nodes.begin(), spec_.nodes.end(), [](const auto &n) { return !n.spare; }));
    }
    size_t spare_nodes() const { return spec_.nodes.size() - started_nodes(); }
    bool quit() const { return quit_; }
    /** Before the nodes go: they hold the pool's strands and the shared objects. */
    void shutdown()
    {
        for (auto &n : nodes_) {
            n->power_off();
        }
        nodes_.clear();
        for (auto &[fd, c] : conns_) {
            c.out.reset();  // unwatches the fd
            ::close(fd);
        }
        conns_.clear();
        exec_.unwatch(STDIN_FILENO);
        if (control_fd_ >= 0) {
            exec_.unwatch(control_fd_);
            ::close(control_fd_);
        }
        exec_.cancel(tick_event_);
        exec_.cancel(flush_event_);
    }

private:
    struct Conn {
        int fd;
        std::string in;
        std::unique_ptr<Writer> out;
    };

    static frsim::ApConfig ap_config(const frsim::FleetSpec &s)
    {
        frsim::ApConfig c;
        c.channel = s.ap.channel;
        c.rssi_min_dbm = s.ap.rssi_min_dbm;
        c.rssi_max_dbm = s.ap.rssi_max_dbm;
        c.uplink_min_ms = s.ap.uplink_min_ms;
        c.uplink_max_ms = s.ap.uplink_max_ms;
        c.downlink_min_ms = s.ap.downlink_min_ms;
        c.downlink_max_ms = s.ap.downlink_max_ms;
        c.udp_loss = s.ap.udp_loss;
        if (s.ap.gaps) {
            c.gaps = frsim::ApConfig::Gaps{.every_s = s.ap.gaps->first, .len_ms = s.ap.gaps->second};
        }
        c.phy_rate_mbps = s.ap.phy_rate;
        c.http_kbps = s.ap.http_kbps;
        c.assoc_min_ms = s.ap.assoc_min_ms;
        c.assoc_max_ms = s.ap.assoc_max_ms;
        c.seed = s.seed;
        return c;
    }

    frsim::TopologyConfig topology() const
    {
        const frsim::MediumSpec &m = spec_.medium;
        frsim::TopologyConfig t;
        t.kind = m.topology;
        t.rssi_min_dbm = m.rssi_min_dbm;
        t.rssi_max_dbm = m.rssi_max_dbm;
        t.asym_db = m.asymmetry_db;
        t.loss_min = m.loss_min;
        t.loss_max = m.loss_max;
        t.rssi_sigma_db = m.rssi_sigma_db;
        t.dup = m.dup;
        t.lat_min_us = m.latency_min_us;
        t.lat_max_us = m.latency_max_us;
        if (m.cross_reach) {
            t.cross_reach = *m.cross_reach;
        }
        for (const frsim::MediumSpec::PairSpec &p : m.pairs) {
            const auto tx = index_.find(p.tx);
            const auto rx = index_.find(p.rx);
            if (tx == index_.end() || rx == index_.end()) {
                continue;
            }
            frsim::Pair pair;
            pair.reach = true;
            pair.loss = p.loss;
            pair.rssi_dbm = p.rssi_dbm;
            pair.rssi_sigma_db = m.rssi_sigma_db;
            pair.dup = m.dup;
            pair.lat_min_us = m.latency_min_us;
            pair.lat_max_us = m.latency_max_us;
            t.matrix.push_back({.tx = tx->second, .rx = rx->second, .pair = pair});
        }
        if (!m.positions.empty()) {
            t.positions.assign(nodes_.size(), {});
            for (const auto &[alias, xy] : m.positions) {
                if (const auto it = index_.find(alias); it != index_.end()) {
                    t.positions[it->second] = {.x_m = xy[0], .y_m = xy[1]};
                }
            }
        }
        t.p0_dbm = m.p0_dbm;
        t.exponent = m.path_n;
        t.rate = m.bcast_rate;
        return t;
    }

    void schedule_tick()
    {
        tick_event_ = exec_.after(1'000'000, [this] {
            tick();
            schedule_tick();
        });
    }

    void schedule_flush()
    {
        // Lines from worker strands (OTA) wait for this; the loop's own are written at once.
        flush_event_ = exec_.after(20'000, [this] {
            stdout_.flush();
            for (auto &[fd, c] : conns_) {
                c.out->flush();
            }
            schedule_flush();
        });
    }

    /** The per-second counter line (D8: at verbosity 0, with the answers, all the fleet prints). */
    void tick()
    {
        const TimeUs now = exec_.now();
        skew_.close(now);
        size_t powered = 0;
        size_t tcp = 0;
        size_t serial = 0;
        for (const auto &n : nodes_) {
            powered += n->powered() ? 1 : 0;
            tcp += n->tcp_session() ? 1 : 0;
            serial += n->serial_session() ? 1 : 0;
        }
        const frsim::LagStats &lag = exec_.lag();
        stdout_.write_line(sformat(
            R"({"fleet":"tick","t_ms":%lld,"powered":%zu,"tcp_sessions":%zu,"serial_sessions":%zu,"lag":{"events":%llu,"p50_us":%lld,"p99_us":%lld,"max_us":%lld,"all_p99_us":%lld,"all_max_us":%lld},"dropped_lines":%llu})",
            static_cast<long long>(now / 1000), powered, tcp, serial, static_cast<unsigned long long>(lag.last_window.events),
            static_cast<long long>(lag.last_window.p50_us), static_cast<long long>(lag.last_window.p99_us),
            static_cast<long long>(lag.last_window.max_us), static_cast<long long>(lag.all.quantile(0.99)),
            static_cast<long long>(lag.all.max_us), static_cast<unsigned long long>(stdout_.dropped())));
    }

    void accept()
    {
        for (;;) {
            const int fd = ::accept(control_fd_, nullptr, nullptr);
            if (fd < 0) {
                return;
            }
            ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
#ifdef SO_NOSIGPIPE
            const int one = 1;
            ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
            // The writer keeps the fd's one watch, reads included (fleet-4).
            conns_[fd] = Conn{.fd = fd, .in = {}, .out = std::make_unique<Writer>(exec_, fd, [this, fd] { read_conn(fd); })};
        }
    }

    void read_conn(int fd)
    {
        const auto it = conns_.find(fd);
        if (it == conns_.end()) {
            return;
        }
        char buf[4096];
        for (;;) {
            const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
            if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
                it->second.out.reset();  // unwatches the fd
                ::close(fd);
                conns_.erase(it);
                return;
            }
            if (n < 0) {
                break;
            }
            it->second.in.append(buf, static_cast<size_t>(n));
        }
        lines(it->second.in, *it->second.out);
    }

    void read_stdin()
    {
        char buf[4096];
        const ssize_t n = ::read(STDIN_FILENO, buf, sizeof(buf));
        if (n <= 0) {
            if (n < 0 && (errno == EAGAIN || errno == EINTR)) {
                return;
            }
            exec_.unwatch(STDIN_FILENO);
            quit_ = true;  // the runner went away: no orphan fleet
            return;
        }
        stdin_buf_.append(buf, static_cast<size_t>(n));
        lines(stdin_buf_, stdout_);
    }

    void lines(std::string &in, Writer &out)
    {
        size_t nl;
        while ((nl = in.find('\n')) != std::string::npos) {
            std::string line = in.substr(0, nl);
            in.erase(0, nl + 1);
            if (!line.empty() && line.back() == '\r') {
                line.pop_back();
            }
            if (!line.empty()) {
                control(line, out);
            }
            if (quit_) {
                return;
            }
        }
    }

    /** `{"rid":"<rid>",` or `{` without one. */
    static std::string head(const std::string &rid)
    {
        return rid.empty() ? "{" : "{\"rid\":\"" + frsim::json_text(rid) + "\",";
    }

    void control(std::string_view line, Writer &out)
    {
        std::string rid;
        if (line.starts_with('@')) {
            std::string_view rest = line.substr(1);
            rid = std::string(frsim::next_word(rest));
            line = rest;
        }
        std::string_view rest = line;
        const std::string target(frsim::next_word(rest));
        if (target.empty()) {
            return;
        }
        if (target == "fleet") {
            fleet_command(rid, rest, out);
            return;
        }
        if (target == "*") {
            size_t n = 0;
            for (const auto &node : nodes_) {
                if (node->started()) {
                    answer(rid, *node, node->command(rest), out);
                    ++n;
                }
            }
            out.answer(head(rid) + sformat(R"("done":true,"n":%zu})", n));
            return;
        }
        const auto it = index_.find(target);
        if (it == index_.end()) {
            out.answer(head(rid) + "\"node\":\"" + frsim::json_text(target) + R"(","ok":false,"error":"no such node"})");
            return;
        }
        FleetNode &node = *nodes_[it->second];
        if (!node.started()) {
            out.answer(head(rid) + "\"node\":\"" + frsim::json_text(target) + R"(","ok":false,"error":"not started"})");
            return;
        }
        answer(rid, node, node.command(rest), out);
    }

    void answer(const std::string &rid, FleetNode &node, const FleetNode::Answer &a, Writer &out)
    {
        out.answer(head(rid) + "\"node\":\"" + frsim::json_text(node.spec().alias) + "\",\"ok\":" + (a.ok ? "true" : "false") +
                   a.fields + "}");
    }

    void fleet_answer(const std::string &rid, bool ok, const std::string &fields, Writer &out)
    {
        out.answer(head(rid) + R"("node":"fleet","ok":)" + (ok ? "true" : "false") + fields + "}");
    }

    void fleet_command(const std::string &rid, std::string_view args, Writer &out)
    {
        const std::string_view cmd = frsim::next_word(args);
        if (cmd == "start") {
            start(rid, args, out);
        } else if (cmd == "stats") {
            fleet_answer(rid, true, ",\"stats\":" + stats(), out);
        } else if (cmd == "medium") {
            fleet_answer(rid, true, ",\"medium\":" + medium_json(medium_.stats()), out);
        } else if (cmd == "ap" && (args == "off" || args == "on")) {
            ap_.set_up(args == "on");
            fleet_answer(rid, true, sformat(R"(,"ap":%s)", ap_.up() ? "true" : "false"), out);
        } else if (cmd == "spawn") {
            const auto it = index_.find(std::string(args));
            if (it == index_.end() || !hub_set_) {
                fleet_answer(rid, false, it == index_.end() ? R"(,"error":"no such node")" : R"(,"error":"fleet start first")", out);
                return;
            }
            nodes_[it->second]->power_on();
            fleet_answer(rid, true, ",\"spawned\":\"" + frsim::json_text(args) + "\"", out);
        } else if (cmd == "pace") {
            const double x = std::strtod(std::string(args).c_str(), nullptr);
            if (!(x > 0 && x <= 10)) {
                fleet_answer(rid, false, R"(,"error":"pace takes a number in (0, 10]")", out);
                return;
            }
            spec_.pace = x;
            pace_.store(x);  // a later `log_rate` is scaled by it
            fleet_answer(rid, true, sformat(R"(,"pace":%g)", x), out);
        } else if (cmd == "verbosity") {
            uint32_t v = 0;
            if (!frsim::parse_u32(args, 0, 3, v)) {
                fleet_answer(rid, false, R"(,"error":"verbosity takes 0-3")", out);
                return;
            }
            verbosity_.store(static_cast<int>(v));
            fleet_answer(rid, true, "", out);
        } else if (cmd == "quit") {
            fleet_answer(rid, true, "", out);
            quit_ = true;
        } else {
            fleet_answer(rid, false, R"(,"error":"unknown fleet command")", out);
        }
    }

    /** `fleet start <host> <tcp> <udp> <http> [--stagger-ms n]`: every non-spare node powers on, `n` ms apart. */
    void start(const std::string &rid, std::string_view args, Writer &out)
    {
        const std::string host(frsim::next_word(args));
        uint32_t tcp = 0;
        uint32_t udp = 0;
        uint32_t http = 0;
        uint32_t stagger = 0;
        bool ok = !host.empty() && frsim::parse_u32(frsim::next_word(args), 1, 65535, tcp) &&
                  frsim::parse_u32(frsim::next_word(args), 1, 65535, udp) && frsim::parse_u32(frsim::next_word(args), 1, 65535, http);
        if (ok && !args.empty()) {
            ok = frsim::next_word(args) == "--stagger-ms" && frsim::parse_u32(frsim::next_word(args), 0, 60'000, stagger) &&
                 args.empty();
        }
        if (!ok) {
            fleet_answer(rid, false, R"(,"error":"usage: fleet start <hub host> <tcp> <udp> <http> [--stagger-ms n]")", out);
            return;
        }
        if (hub_set_) {
            fleet_answer(rid, false, R"(,"error":"already started")", out);
            return;
        }
        hub_set_ = true;
        size_t i = 0;
        for (const auto &n : nodes_) {
            n->set_hub(host, static_cast<uint16_t>(tcp), static_cast<uint16_t>(udp), static_cast<uint16_t>(http));
            if (n->spec().spare) {
                continue;
            }
            FleetNode *node = n.get();
            if (stagger == 0) {
                node->power_on();
            } else {
                exec_.after(static_cast<TimeUs>(i) * stagger * 1000, [node] { node->power_on(); });
            }
            ++i;
        }
        fleet_answer(rid, true, sformat(R"(,"started":%zu)", i), out);
    }

    std::string stats()
    {
        skew_.close(exec_.now());
        size_t started = 0;
        size_t powered = 0;
        size_t tcp_sessions = 0;
        size_t serial_sessions = 0;
        uint64_t boots = 0;
        uint64_t posts_refused = 0;
        uint64_t net_posts_refused = 0;
        frsim::SimTcp::Stats tcp{};
        for (const auto &n : nodes_) {
            started += n->started() ? 1 : 0;
            powered += n->powered() ? 1 : 0;
            tcp_sessions += n->tcp_session() ? 1 : 0;
            serial_sessions += n->serial_session() ? 1 : 0;
            boots += n->boots();
            const frsim::SimCore::Stats cs = n->core().stats();
            posts_refused += cs.posts_refused;
            net_posts_refused += cs.net_posts_refused;
            const frsim::SimTcp::Stats &t = n->tcp().stats();
            tcp.connects += t.connects;
            tcp.connect_fails += t.connect_fails;
            tcp.closes += t.closes;
            tcp.resets += t.resets;
            tcp.stale_closed += t.stale_closed;
            tcp.tx_frames += t.tx_frames;
            tcp.tx_refused += t.tx_refused;
            tcp.rx_frames += t.rx_frames;
            tcp.rx_dropped += t.rx_dropped;
            tcp.tx_bytes += t.tx_bytes;
            tcp.rx_bytes += t.rx_bytes;
        }
        return sformat(R"({"t_ms":%lld,"sanitized":%s,"pace":%g,"nodes":{"total":%zu,"started":%zu,"powered":%zu,"tcp_sessions":%zu,"serial_sessions":%zu,"boots":%llu},)",
                       static_cast<long long>(exec_.now() / 1000), kSanitized ? "true" : "false", spec_.pace, nodes_.size(),
                       started, powered, tcp_sessions, serial_sessions, static_cast<unsigned long long>(boots)) +
               "\"lag\":" + lag_json(exec_.lag()) + ",\"skew\":" + skew_.json() +
               sformat(R"(,"cores":{"posts_refused":%llu,"net_posts_refused":%llu})", static_cast<unsigned long long>(posts_refused),
                       static_cast<unsigned long long>(net_posts_refused)) +
               sformat(R"(,"tcp":{"connects":%u,"connect_fails":%u,"closes":%u,"resets":%u,"stale_closed":%u,"tx_frames":%u,"tx_refused":%u,"rx_frames":%u,"rx_dropped":%u,"tx_bytes":%llu,"rx_bytes":%llu})",
                       tcp.connects, tcp.connect_fails, tcp.closes, tcp.resets, tcp.stale_closed, tcp.tx_frames, tcp.tx_refused,
                       tcp.rx_frames, tcp.rx_dropped, static_cast<unsigned long long>(tcp.tx_bytes),
                       static_cast<unsigned long long>(tcp.rx_bytes)) +
               sformat(R"(,"ap":{"up":%s},"writer":{"dropped_lines":%llu}})", ap_.up() ? "true" : "false",
                       static_cast<unsigned long long>(stdout_.dropped()));
    }

    frsim::FleetSpec spec_;
    frsim::Executor &exec_;
    Writer &stdout_;
    std::atomic<int> verbosity_;
    std::atomic<double> pace_{1};
    frsim::TcpTiming tcp_timing_;
    frsim::Medium medium_;
    frsim::Ap ap_;
    frsim::Bridge bridge_;
    frsim::UdpSocket udp_;
    frsim::WorkerPool pool_;
    frsim::FleetShared shared_;
    ArrivalSkew skew_;
    std::vector<std::unique_ptr<FleetNode>> nodes_;
    std::map<std::string, size_t> index_;
    int control_fd_ = -1;
    uint16_t control_port_ = 0;
    std::map<int, Conn> conns_;
    std::string stdin_buf_;
    bool hub_set_ = false;
    bool quit_ = false;
    EventId tick_event_ = 0;
    EventId flush_event_ = 0;
};

}  // namespace

int main(int argc, char **argv)
{
    if (argc >= 3 && std::string_view(argv[1]) == "--make-image") {
        return make_image_main(argc, argv);
    }
    const bool help = argc == 2 && (std::strcmp(argv[1], "--help") == 0 || std::strcmp(argv[1], "-h") == 0);
    if (help || argc != 3 || std::string_view(argv[1]) != "--spec") {
        std::fputs(kUsage, help ? stdout : stderr);
        return help ? 0 : 64;
    }
    const auto text = ota_fake::read_file(argv[2]);
    frsim::FleetSpec spec;
    std::string error;
    if (!text || !frsim::parse_fleet_spec(*text, spec, error)) {
        std::fprintf(stderr, "fr_fleet: %s: %s\n", argv[2], text ? error.c_str() : "cannot read it");
        return 64;
    }
    ::signal(SIGPIPE, SIG_IGN);
    // D1: one TCP socket (and a stale one) per node, its USB port, 16 HTTP GETs, the listeners and the loop's own.
    const rlim_t need = 3 * static_cast<rlim_t>(spec.nodes.size()) + 64;
    rlimit lim{};
    ::getrlimit(RLIMIT_NOFILE, &lim);
    if (lim.rlim_cur < need) {
        rlimit want = lim;
        want.rlim_cur = std::min(lim.rlim_max, need);
        if (::setrlimit(RLIMIT_NOFILE, &want) == 0) {
            lim = want;
        }
    }
    if (::isatty(STDOUT_FILENO) == 0) {
        ::fcntl(STDOUT_FILENO, F_SETFL, ::fcntl(STDOUT_FILENO, F_GETFL, 0) | O_NONBLOCK);
    }
    ::fcntl(STDIN_FILENO, F_SETFL, ::fcntl(STDIN_FILENO, F_GETFL, 0) | O_NONBLOCK);

    frsim::Executor exec(frsim::TimeMode::wall);
    Writer out(exec, STDOUT_FILENO);
    {
        Fleet fleet(std::move(spec), exec, out);
        if (!fleet.init(error)) {
            std::fprintf(stderr, "fr_fleet: %s\n", error.c_str());
            return 1;
        }
        out.answer(sformat(R"({"fleet":"ready","nodes":%zu,"spares":%zu,"control":"127.0.0.1:%u","bridge":"127.0.0.1:%u",)"
                           R"("nofile":{"soft":%llu,"hard":%llu,"need":%llu},"sanitized":%s})",
                           fleet.started_nodes(), fleet.spare_nodes(), unsigned{fleet.control_port()}, unsigned{fleet.bridge_port()},
                           json_limit(lim.rlim_cur), json_limit(lim.rlim_max),
                           static_cast<unsigned long long>(need), kSanitized ? "true" : "false"));
        while (!fleet.quit() && !out.closed()) {
            exec.run_for(100'000);
        }
        fleet.shutdown();
        out.flush();
    }
    // Whatever is still queued for stdout goes out blocking now: the answer to `quit` among it.
    ::fcntl(STDOUT_FILENO, F_SETFL, ::fcntl(STDOUT_FILENO, F_GETFL, 0) & ~O_NONBLOCK);
    out.flush();
    return 0;
}
