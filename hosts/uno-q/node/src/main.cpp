// qonu-node: the Arduino UNO Q as a Fractonica device (design docs/design/uno-q-host.md, role A2). Fractonica's own
// node runtime (fr_net core, the fr_core services) on Linux through fr_posix, with the STM32's outputs as capability
// instances through qonu-link:
//   port 0   node    fr.node
//   port 1   led3    fr.led      LED3, rgb, on/off per channel
//   port 2   matrix  fr.display  the 13x8 LED matrix, mono1, primitives (5x7 font)
// It connects to the hub named in its identity file (or --hub), resolved over mDNS, and keeps its identity and boot
// counter in /data, which survives image reflashes.
//
//   qonu-node [--hub HOST[:PORT]] [--data DIR] [--socket PATH] [--iface IF] [--hb-ms N]
//   qonu-node set-hub HOST[:PORT] [--data DIR]    store the hub in the identity file and exit (the service is stopped)
//   qonu-node show [--data DIR]                   print the identity file
// Exit codes: 0 stopped, 75 fr.node.reboot (restart me), 64 usage or no hub configured (do not restart), 1 error.
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>
#include <sys/stat.h>
#include <vector>

#include "fr/core/node_net.hpp"
#include "fr/core/port.hpp"
#include "fr/display/mono_backend.hpp"
#include "fr/net/net.hpp"
#include "fr/posix/core.hpp"
#include "fr/posix/device.hpp"
#include "fr/posix/links.hpp"
#include "fr/posix/runner.hpp"
#include "fr/posix/store.hpp"
#include "fr/services/display_service.hpp"
#include "fr/services/led_service.hpp"
#include "qonu_hal.hpp"
#include "qonu_link.hpp"

#ifndef QONU_NODE_VERSION
#define QONU_NODE_VERSION "0.1.0"
#endif

namespace {

constexpr uint16_t kHubPort = 7421;

void log_line(const std::string &line)
{
    // journald adds the time; stderr is unbuffered.
    std::fprintf(stderr, "%s\n", line.c_str());
}

struct Options {
    std::string command;  // empty (run), set-hub or show
    std::string command_arg;
    std::string hub;
    std::string data = "/data/fractonica";
    std::string socket = "/run/qonu/link.sock";
    std::string iface = "wlan0";
    uint32_t hb_ms = 1000;
};

[[noreturn]] void usage(const char *why)
{
    std::fprintf(stderr,
                 "qonu-node: %s\nusage: qonu-node [--hub HOST[:PORT]] [--data DIR] [--socket PATH] [--iface IF] "
                 "[--hb-ms N]\n",
                 why);
    std::exit(64);
}

Options parse(int argc, char **argv)
{
    Options o;
    int i = 1;
    if (argc > 1 && (std::string(argv[1]) == "set-hub" || std::string(argv[1]) == "show")) {
        o.command = argv[1];
        if (o.command == "set-hub") {
            if (argc < 3) {
                usage("set-hub needs HOST[:PORT]");
            }
            o.command_arg = argv[2];
            i = 3;
        } else {
            i = 2;
        }
    }
    for (; i < argc; ++i) {
        const std::string k = argv[i];
        auto value = [&]() -> std::string {
            if (i + 1 >= argc) {
                usage((k + " needs a value").c_str());
            }
            return argv[++i];
        };
        if (k == "--hub") {
            o.hub = value();
        } else if (k == "--data") {
            o.data = value();
        } else if (k == "--socket") {
            o.socket = value();
        } else if (k == "--iface") {
            o.iface = value();
        } else if (k == "--hb-ms") {
            o.hb_ms = static_cast<uint32_t>(std::strtoul(value().c_str(), nullptr, 10));
        } else if (k == "--version") {
            std::printf("qonu-node %s\n", QONU_NODE_VERSION);
            std::exit(0);
        } else {
            usage(("unknown option " + k).c_str());
        }
    }
    return o;
}

/** host[:port] -> (host, port). */
std::pair<std::string, uint16_t> split_hub(const std::string &hub)
{
    const size_t colon = hub.rfind(':');
    if (colon == std::string::npos) {
        return {hub, kHubPort};
    }
    return {hub.substr(0, colon), static_cast<uint16_t>(std::strtoul(hub.c_str() + colon + 1, nullptr, 10))};
}

/** The fw_id prefix HELLO and the descriptor carry: "qonu" and the version's numbers, as no image hash exists. */
std::array<uint8_t, 8> fw_prefix()
{
    std::array<uint8_t, 8> fw{'q', 'o', 'n', 'u', 0, 0, 0, 0};
    unsigned a = 0;
    unsigned b = 0;
    unsigned c = 0;
    std::sscanf(QONU_NODE_VERSION, "%u.%u.%u", &a, &b, &c);
    fw[4] = static_cast<uint8_t>(a);
    fw[5] = static_cast<uint8_t>(b);
    fw[6] = static_cast<uint8_t>(c);
    return fw;
}

}  // namespace

int main(int argc, char **argv)
{
    const Options o = parse(argc, argv);
    ::mkdir(o.data.c_str(), 0755);

    fr::posix::IdentityFile ident(o.data + "/node.ident");
    if (!ident.load()) {
        log_line("qonu-node: cannot read " + ident.path());
        return 1;
    }
    if (o.command == "show") {
        const std::optional<std::string> text = fr::posix::read_file(ident.path());
        std::fputs(text ? text->c_str() : "(no identity file yet)\n", stdout);
        return 0;
    }
    if (o.command == "set-hub") {
        ident.hub = o.command_arg;
        if (!ident.save()) {
            log_line("qonu-node: cannot write " + ident.path());
            return 1;
        }
        std::printf("hub %s saved in %s; restart the service: systemctl restart qonu-node\n", ident.hub.c_str(),
                    ident.path().c_str());
        return 0;
    }
    if (!o.hub.empty()) {
        ident.hub = o.hub;
    }
    if (ident.alias.empty()) {
        char host[64] = {};
        ::gethostname(host, sizeof(host) - 1);
        ident.alias = host;
    }
    if (ident.hub.empty()) {
        log_line("qonu-node: no hub configured: run `qonu-node set-hub HOST[:PORT]` (kept in " + ident.path() + ")");
        return 64;
    }
    // Spec 05 §5.5: this boot's epoch is committed before anything is sent.
    if (!ident.begin_boot()) {
        log_line("qonu-node: cannot write " + ident.path());
        return 1;
    }

    fr::posix::NodeInfo info;
    info.board = "arduino-uno-q";
    info.profile = "uno-q";
    info.chip = fr::posix::kChipLinux;
    info.fw_id_prefix = fw_prefix();
    info.hb_ms = o.hb_ms;
    if (!fr::posix::interface_mac(o.iface, info.mac)) {
        log_line("qonu-node: cannot read the MAC of " + o.iface);
        return 1;
    }

    fr::posix::PosixCore core;
    fr::posix::InlineWorker worker;
    qonu::LinkClient link(o.socket);

    qonu::Led3 led3_out(link);
    fr::LedService led3(led3_out, fr::cap::LedConfig{});
    qonu::Matrix matrix_panel(link);
    fr::display::MonoBackend matrix_backend;
    fr::DisplayService matrix(matrix_panel, matrix_backend, fr::cap::DisplayConfig{.flush_ms = 50});

    std::vector<fr::PortEntry> ports{
        {0, "node", nullptr, true},
        {1, "led3", &led3, true},
        {2, "matrix", &matrix, true},
    };
    fr::posix::Device device(core, ident, info, ports);
    device.log = log_line;

    fr::net::Config cfg;
    cfg.heartbeat_ms = o.hb_ms;
    fr::net::Net net(core, device, cfg);
    device.set_net(net);

    fr::posix::FileBlob dir_blob(o.data + "/fr_dir.bin");
    fr::posix::FileBlob bind_blob(o.data + "/fr_bind.bin");
    fr::core::NetStores stores(core, worker, dir_blob, bind_blob);
    net.attach_stores(stores.directory(), stores.bindings());

    for (fr::PortEntry &p : ports) {
        p.cap->attach(p.port, p.name, net);
    }
    ports[1].ok = static_cast<bool>(led3.init(core));
    ports[2].ok = static_cast<bool>(matrix.init(core));
    if (!ports[1].ok || !ports[2].ok) {
        log_line(std::string("qonu-node: init failed:") + (ports[1].ok ? "" : " led3") + (ports[2].ok ? "" : " matrix") +
                 " (is qonu-link running?)");
    }

    const auto [hub_host, hub_port] = split_hub(ident.hub);
    fr::posix::TcpLink tcp(core, hub_host, hub_port);
    fr::posix::UdpLink udp;
    tcp.bind(net, &udp);
    tcp.rx = [&net](std::span<const uint8_t> env) { net.receive(fr::net::LinkKind::tcp, env); };
    tcp.log = log_line;
    net.attach(tcp);
    net.attach(udp);

    char mac[18];
    std::snprintf(mac, sizeof(mac), "%02x%02x%02x%02x%02x%02x", info.mac[0], info.mac[1], info.mac[2], info.mac[3],
                  info.mac[4], info.mac[5]);
    log_line(std::string("qonu-node ") + QONU_NODE_VERSION + ": device " + mac + " alias " + ident.alias + " epoch " +
             std::to_string(ident.epoch) + ", hub " + hub_host + ":" + std::to_string(hub_port));

    fr::posix::Runner runner(core, worker, net, device, tcp);
    runner.each_turn = [&stores] { stores.retry(); };
    const int code = runner.run();
    log_line(code == fr::posix::kExitRestart ? "qonu-node: restarting (fr.node.reboot)" : "qonu-node: stopped");
    return code;
}
