// FleetNode (design m2-c2 D1, D7, D8): one node of fr_fleet, its links and its boots; and NodeOut, its output. See
// node.hpp. A boot is fr_net_node's main() as objects: the same node classes, around a Net on the node's SimCore,
// over SimTcp, SimUdp, SimSerial and SimAir instead of fr_net_node's blocking links and FakeAir. M2-C3 (design
// m2-c3-inputs §8): its services and port table are the kit profile's (c6-pad, c3o-analog).
#include <sys/stat.h>

#include <algorithm>
#include <cstring>

#include "catalog.hpp"
#include "fr/gw/bridge.hpp"
#include "fr/services/led_service.hpp"
#include "sim/ap.hpp"
#include "sim/commands.hpp"
#include "sim/links.hpp"
#include "sim/node.hpp"
#include "sim/sim_air.hpp"
#include "tools/ota_fake.hpp"

namespace frsim {

using fr::TimeUs;
using fr::net::LinkKind;

// ---- NodeOut ----

std::string NodeOut::tagged(std::string_view json) const
{
    const std::string tag = "\"node\":\"" + json_text(alias_) + "\"";
    if (json.size() < 2 || json.front() != '{') {
        return "{" + tag + ",\"text\":\"" + json_text(json) + "\"}";
    }
    if (json == "{}") {
        return "{" + tag + "}";
    }
    return "{" + tag + "," + std::string(json.substr(1));
}

void NodeOut::line(std::string_view text)
{
    {
        const std::lock_guard lock(mu_);
        if (capturing_ && std::this_thread::get_id() == capture_thread_) {
            captured_.emplace_back(text);
            return;
        }
    }
    if (verbosity_.load(std::memory_order_relaxed) >= 1) {
        events_.write_line(tagged(text));
    }
}

void NodeOut::begin_capture()
{
    const std::lock_guard lock(mu_);
    capturing_ = true;
    capture_thread_ = std::this_thread::get_id();
    captured_.clear();
}

std::vector<std::string> NodeOut::end_capture()
{
    const std::lock_guard lock(mu_);
    capturing_ = false;
    return std::exchange(captured_, {});
}

namespace {

/** The boot button of a fleet pad: no wire reaches it, so it only ever moves by `inject` (ButtonService). */
class QuietButton final : public fr::hal::ButtonSource
{
public:
    fr::Status init(fr::Core &core, fr::hal::ButtonSink &sink) override
    {
        sink_ = &sink;
        slot_ = core.input_slot([this](const fr::InputSample &s) { sink_->on_button_edge(s.level, s.at, s.edges); });
        return slot_ != nullptr ? fr::Status{} : fr::Status{std::unexpected(fr::Err::failed)};
    }
    bool level_pressed() const override { return false; }
    fr::hal::Selftest selftest() override { return {true, "idle level ok"}; }

private:
    fr::hal::ButtonSink *sink_ = nullptr;
    fr::InputSlot *slot_ = nullptr;
};

/** The status LED (a C6 pad's WS2812): a per-frame `led` line, as fr_net_node prints it. */
class QuietLight final : public fr::hal::LightOutput
{
public:
    explicit QuietLight(Out &out) : out_(out) {}
    fr::Status init(fr::Core &) override { return {}; }
    fr::hal::LightFeatures features() const override { return {.rgb = true, .dimmable = true}; }
    fr::Status write(const fr::hal::LightLevel &l) override
    {
        if (out_.frames()) {
            const uint32_t b = l.on ? l.brightness : 0;
            const auto scale = [b](uint8_t c) { return (static_cast<uint32_t>(c) * b + 127) / 255; };
            const uint32_t grb = scale(l.color.g) << 16 | scale(l.color.r) << 8 | scale(l.color.b);
            out_.emit(R"({"ev":"led","on":%s,"grb":%u})", l.on ? "true" : "false", grb);
        }
        return {};
    }
    fr::hal::Selftest selftest() override { return {true, "ok"}; }

private:
    Out &out_;
};

/** The ev name of a node line (`{"ev":"state",...}`), or "" for another shape. */
std::string_view ev_of(std::string_view json)
{
    constexpr std::string_view kHead = R"({"ev":")";
    if (!json.starts_with(kHead)) {
        return {};
    }
    const size_t end = json.find('"', kHead.size());
    return end == std::string_view::npos ? std::string_view{} : json.substr(kHead.size(), end - kHead.size());
}

}  // namespace

// ---- the node's links, as its commands and diag hooks see them ----

class FleetNode::Links final : public NodeLinks
{
public:
    explicit Links(FleetNode &n) : n_(n) {}

    void wifi_down(uint32_t secs) override
    {
        FleetNode &n = n_;
        n.shared_.exec.cancel(n.wifi_event_);
        n.wifi_event_ = 0;
        if (secs == 0) {
            if (n.wifi_off_) {
                n.wifi_off_ = false;
                n.update_ip(true);
                n.out_.emit(R"({"ev":"wifi","up":true})");
            }
            return;
        }
        if (!n.wifi_off_) {
            n.wifi_off_ = true;
            n.update_ip(false);
            n.out_.emit(R"({"ev":"wifi","up":false})");
        }
        n.wifi_event_ = n.shared_.exec.after(static_cast<TimeUs>(secs) * 1'000'000, [&n] {
            n.wifi_event_ = 0;
            if (n.wifi_off_) {
                n.wifi_off_ = false;
                n.update_ip(true);  // association and DHCP again
                n.out_.emit(R"({"ev":"wifi","up":true})");
            }
        });
    }
    void tcp_enable(bool on) override
    {
        FleetNode &n = n_;
        if (n.tcp_off_ == !on) {
            return;
        }
        n.tcp_off_ = !on;
        if (!n.ip_ || n.spec_->role == fr::proto::Role::gateway) {
            return;  // a gateway has no TCP to the hub
        }
        if (on) {
            n.tcp_->ip_up();
        } else {
            n.tcp_->ip_down();  // silent, never closed (D7)
        }
    }
    void air_loss(uint32_t pct) override
    {
        // The share of received air frames lost: every pair into this radio, its own loss restored at 0.
        Medium &m = n_.shared_.medium;
        const RadioId me = n_.air_->radio();
        if (n_.loss_saved_.empty()) {
            for (RadioId tx = 0; tx < m.radios(); ++tx) {
                if (tx != me) {
                    n_.loss_saved_.emplace_back(tx, m.pair(tx, me).loss);
                }
            }
        }
        for (const auto &[tx, loss] : n_.loss_saved_) {
            Pair p = m.pair(tx, me);
            p.loss = pct == 0 ? loss : std::min(1.0, static_cast<double>(pct) / 100.0);
            m.set_pair(tx, me, p);
        }
        if (pct == 0) {
            n_.loss_saved_.clear();
        }
    }
    bool air_counters(AirCounters &out) const override
    {
        const SimAir &air = *n_.air_;
        const fr::net::air::SchedStats &d = air.scheduler().stats();
        const SimAir::Stats &s = air.stats();
        out = {.tx = d.sent,
               .tx_fail = d.failed,
               .retries = d.retries,
               .refused = d.refused,
               .rx = s.rx,
               .rx_bad = s.rx_bad,
               .rx_lost = s.ring_drops,
               .peers = static_cast<uint32_t>(air.scheduler().peers()),
               .datagrams = d.sent,
               .acks = 0};
        return true;
    }
    fr::net::LinkInfo wifi() const override
    {
        if (!n_.ip_) {
            return {};
        }
        return n_.shared_.ap.link_info(n_.spec_->mac, n_.spec_->radio.channel);
    }
    void serial_host(bool present) override { n_.usb(present); }
    void hub_mute(bool on) override { n_.serial_->set_mute(on); }
    bool air_rate(fr::net::AirRate rate, bool broadcast, uint32_t &peers, uint32_t &failed) override
    {
        const fr::net::air::RateChange r = n_.air_->set_default_rate(broadcast, rate);
        peers = r.peers;
        failed = r.failed;
        return true;
    }
    bool air_churn(uint32_t n, AirChurnCounts &out) override
    {
        fr::net::air::ChurnStats st;
        n_.air_->churn(n, st);
        out = {.n = st.n,
               .failed = st.failed,
               .add_p50_us = st.add.percentile(500),
               .add_p99_us = st.add.percentile(990),
               .add_max_us = st.add.max(),
               .del_p50_us = st.del.percentile(500),
               .del_p99_us = st.del.percentile(990),
               .del_max_us = st.del.max()};
        return true;
    }

private:
    FleetNode &n_;
};

// ---- a gateway's bridge (design m2-c4-gateway D18) ----

/**
 * fr_gw's bridge on a gateway node, wired as core.cpp wires it on target: the radio is Net::air_send_raw and the
 * node's SimAir, the line the node's bridge port (SimSerial::write_frame), and Net's AirTap hands it every air frame
 * and the end of each of its sends. No status light (D9's LED is cosmetic). Core task, one per boot.
 */
class FleetNode::Gateway final : public fr::gw::Air, public fr::gw::Line, public fr::net::AirTap
{
public:
    Gateway(FleetNode &n, fr::net::Net &net) : n_(n), net_(net), bridge_(*n.core_, *this, *this, nullptr) {}
    Gateway(const Gateway &) = delete;
    Gateway &operator=(const Gateway &) = delete;

    /** The bridge's timers, then the tap (core.cpp's order); false when the core's pool had none left. */
    bool begin()
    {
        if (!bridge_.begin()) {
            return false;
        }
        net_.set_air_tap(this);
        return true;
    }
    fr::gw::Bridge &bridge() { return bridge_; }

    // fr::gw::Air
    fr::Status send(const fr::net::Mac &dst, std::span<const uint8_t> env, fr::proto::GwRate rate, uint32_t token) override
    {
        uint8_t mac[6];
        std::memcpy(mac, dst.data(), sizeof(mac));
        return net_.air_send_raw(mac, env, static_cast<uint8_t>(rate), token);
    }
    bool up() const override { return n_.air_->up(); }
    fr::gw::AirInfo info() const override
    {
        const fr::net::LinkInfo li = n_.links_->wifi();
        const bool up = n_.air_->up();
        return {.up = up,
                .channel = up ? n_.spec_->radio.channel : uint8_t{0},
                .peers = static_cast<uint8_t>(n_.air_->scheduler().peers()),
                .net = n_.spec_->net,
                .associated = li.wifi_up && li.channel != 0,
                .ap_rssi = li.rssi,
                .ap_channel = li.channel};
    }
    // As core.cpp: the driver's peer table is fr_net's, its LRU replaces idle peers on its own.
    fr::Status peer_flush() override { return std::unexpected(fr::Err::unsupported); }

    // fr::gw::Line
    bool write_frame(uint8_t type, std::span<const uint8_t> body) override { return n_.serial_->write_frame(type, body); }

    // fr::net::AirTap
    void on_air_frame(std::span<const uint8_t> env, const fr::net::RxMeta &meta, TimeUs at) override
    {
        bridge_.on_air_frame(env, meta, at);
    }
    void on_air_sent(uint32_t token, bool ok, uint8_t retries, TimeUs queued_us) override
    {
        bridge_.on_air_sent(token, ok, retries, queued_us);
    }

private:
    FleetNode &n_;
    fr::net::Net &net_;
    fr::gw::Bridge bridge_;
};

// ---- one boot ----

namespace {

ota_fake::Digest running_of(const NodeSpec &spec)
{
    ota_fake::Digest d{};
    std::copy(spec.fw.begin(), spec.fw.end(), d.begin());
    return d;
}

}  // namespace

/** Everything a power cycle rebuilds, in fr_net_node main()'s order. */
struct FleetNode::Boot {
    explicit Boot(FleetNode &n)
        : node(n),
          flash(n.dir_, running_of(*n.spec_), n.spec_->version, n.out_),
          fw_synced(sync_fw(*n.spec_, flash)),
          store(n.dir_),
          fetch(n.out_, n.shared_.pool != nullptr, n.shared_.pool != nullptr ? n.shared_.ap.config().http_kbps * 1000 : 0),
          light(n.out_),
          button(button_src, fr::cap::ButtonConfig{}),
          led(light, fr::cap::LedConfig{.max_brightness = 64}),
          analog(n.wave_ != nullptr ? std::make_unique<fr::AnalogInService>(*n.wave_, kit_analog_config(n.spec_->analog_report_hz))
                                    : nullptr),
          diag(*n.core_, *n.spec_, n.out_),
          ports(make_ports(button, led, analog.get(), diag)),
          device(*n.core_, *n.spec_, ports, n.out_),
          cfg(make_cfg(*n.spec_)),
          net(*n.core_, device, cfg),
          dir_blob(n.dir_ + "/fr_dir.bin"),
          bind_blob(n.dir_ + "/fr_bind.bin"),
          stores(*n.core_, *n.strand_, dir_blob, bind_blob),
          logs(*n.core_, n.spec_->usb ? KitLogs::SerialOut([&n](std::string_view l) { n.serial_->print(l); })
                                      : KitLogs::SerialOut()),
          ota_host(net, device, *n.spec_, n.out_)
    {
    }

    static bool sync_fw(NodeSpec &spec, const ota_fake::MemFlash &flash)
    {
        // The running image, as the bootloader left it: its fw_id prefix is in HELLO and the descriptor.
        std::copy_n(flash.state().running.begin(), spec.fw.size(), spec.fw.begin());
        spec.version = flash.state().version;
        return true;
    }
    static std::vector<fr::PortEntry> make_ports(fr::ButtonService &button, fr::LedService &led, fr::AnalogInService *analog,
                                                 NodeDiag &diag)
    {
        // The kit profile's table (KitProfile): c6-pad's (schema/vectors Descriptor.c6_pad) boot button on 1, status
        // LED on 2, and c3o-analog's analog input on 3 (c3o-analog.slots.lock); fr.diag on 241 is a system port,
        // outside the descriptor, which Device builds from this table.
        std::vector<fr::PortEntry> p{{0, "node", nullptr, true}, {1, "boot", &button, true}, {2, "status", &led, true}};
        if (analog != nullptr) {
            p.push_back({3, "analog", analog, true});
        }
        p.push_back({241, "diag", &diag, true});
        return p;
    }
    static fr::net::Config make_cfg(const NodeSpec &spec)
    {
        fr::net::Config c;
        c.heartbeat_ms = spec.hb_ms;
        c.rng_seed = spec.rng_seed;
        return c;
    }

    FleetNode &node;
    ota_fake::MemFlash flash;
    bool fw_synced;
    ota_fake::MemStore store;
    ota_fake::HttpFetch fetch;
    QuietButton button_src;
    QuietLight light;
    fr::ButtonService button;
    fr::LedService led;
    std::unique_ptr<fr::AnalogInService> analog;  // c3o-analog only
    NodeDiag diag;
    std::vector<fr::PortEntry> ports;
    Device device;
    fr::net::Config cfg;
    fr::net::Net net;
    CountingSink analog_sink{net};  // the analog port's STATEs on their way to Net
    FileBlob dir_blob;
    FileBlob bind_blob;
    fr::core::NetStores stores;
    KitLogs logs;
    fr::ota::Ota ota;
    NodeOtaHost ota_host;
    bool ota_bound = false;  // the spec runs fr_ota, and it got its timer
    std::unique_ptr<Gateway> gateway;  // role gateway only (design m2-c4-gateway D18)
};

// ---- FleetNode ----

FleetNode::FleetNode(FleetShared &shared, std::unique_ptr<NodeSpec> spec, std::string state_dir)
    : shared_(shared),
      spec_(std::move(spec)),
      dir_(std::move(state_dir)),
      mac_hex_(hex(spec_->mac)),
      out_(spec_->alias, shared.events, shared.verbosity),
      core_(std::make_unique<SimCore>(shared.exec, spec_->alias)),
      strand_(std::make_unique<Strand>(shared.exec, shared.pool)),
      air_(std::make_unique<SimAir>(shared.medium, *core_, spec_->mac, spec_->radio.channel, spec_->radio.bcast_rate,
                                    spec_->radio.ucast_rate)),
      tcp_(std::make_unique<SimTcp>(shared.exec, *core_, shared.ap, spec_->mac, shared.tcp)),
      udp_(std::make_unique<SimUdp>(shared.exec, shared.ap, spec_->mac, shared.udp, spec_->udp == NodeSpec::Udp::own)),
      serial_(std::make_unique<SimSerial>(*core_)),
      links_(std::make_unique<Links>(*this))
{
    ::mkdir(dir_.c_str(), 0700);
    // What HELLO, the descriptor and fr_ota's CHECK say follows the kit profile (the fleet spec names only the profile).
    if (const KitProfile *k = kit_profile(spec_->profile)) {
        spec_->board = std::string(k->board);
        spec_->chip = k->chip;
        if (k->analog) {
            wave_ = std::make_unique<WaveAnalog>(*core_, spec_->rng_seed);
        }
    }
    if (shared.arrival) {
        tcp_->set_arrival([this](std::span<const uint8_t> env, TimeUs at) { shared_.arrival(*spec_, env, at); });
    }
}

FleetNode::~FleetNode()
{
    power_off();
    for (const EventId id : {assoc_event_, wifi_event_, tick_event_, restart_event_}) {
        shared_.exec.cancel(id);
    }
}

void FleetNode::set_hub(const std::string &host, uint16_t tcp, uint16_t udp, uint16_t http)
{
    spec_->host = host;
    spec_->hub_http = http;
    tcp_->set_hub(host, tcp);
    udp_->set_hub(host, udp);
}

void FleetNode::power_on()
{
    if (boot_ != nullptr) {
        return;
    }
    started_ = true;
    shared_.exec.cancel(restart_event_);
    restart_event_ = 0;
    // fr_boot (05 §5.5): every boot a new epoch, kept in the state directory across power cycles and fleet restarts.
    const auto stored = ota_fake::read_file(dir_ + "/epoch.txt");
    const unsigned long last = stored ? std::strtoul(stored->c_str(), nullptr, 10) : 0;
    spec_->epoch = static_cast<uint16_t>(std::max<unsigned long>(last + 1, spec_->epoch));
    ota_fake::write_file(dir_ + "/epoch.txt", std::to_string(spec_->epoch));
    ++boots_;
    strand_->resume();
    boot();
}

void FleetNode::boot()
{
    boot_ = std::make_unique<Boot>(*this);
    Boot &b = *boot_;
    b.ports[0].cap = &b.device.node_cap();
    b.device.set_net(b.net);
    b.device.set_links(*links_);
    b.net.attach_stores(b.stores.directory(), b.stores.bindings());
    for (fr::PortEntry &p : b.ports) {
        p.cap->attach(p.port, p.name, p.cap == b.analog.get() ? static_cast<fr::cap::Sink &>(b.analog_sink) : b.net);
    }
    if (!b.led.init(*core_) || !b.button.init(*core_) || (b.analog != nullptr && !b.analog->init(*core_))) {
        out_.emit(R"({"ev":"error","what":"service init failed"})");
    }
    b.diag.bind(b.net, *links_, b.ports);
    // design m2-c4-gateway D18: a gateway's bridge takes its timers before the rest of the boot can drain the pool,
    // and hears every air frame Net accepts from then on (Net handles only what is addressed to the gateway itself).
    const bool gateway = spec_->role == fr::proto::Role::gateway;
    if (gateway) {
        b.gateway = std::make_unique<Gateway>(*this, b.net);
        if (b.gateway->begin()) {
            b.diag.set_gateway(&b.gateway->bridge());
            fr::gw::Bridge *bridge = &b.gateway->bridge();
            serial_->set_frames([bridge](uint8_t type, std::span<const uint8_t> body, TimeUs at) {
                bridge->on_serial_frame(type, body, at);
            });
        } else {
            out_.emit(R"({"ev":"error","what":"gateway: no timer left for the bridge"})");
            b.gateway.reset();
        }
    }

    // The links: TCP and UDP to the hub (not a gateway's: its hub link is the USB line), the USB line where the
    // scenario has one, and the radio.
    const bool serial_only = !spec_->ip || gateway;
    RxFn rx = [this, serial_only](LinkKind k, std::span<const uint8_t> env) {
        Boot &bt = *boot_;
        const auto h = fr::wire::unpack_header(env);
        bt.net.receive(k, env);
        if (h && h->cls == fr::wire::kClsNet && h->kind == fr::proto::kKindNetWelcome && bt.net.state().link(k).session) {
            // HUB_ACK on a WELCOME that gave the link its session, as fr_core's on_envelope.
            if (bt.ota_bound) {
                bt.ota.health_set(fr::ota::kHealthHubAck | (serial_only && k == LinkKind::serial ? fr::ota::kHealthNet : 0));
            }
            if (k == LinkKind::tcp) {
                tcp_->welcomed();  // a stale silent connection is closed now, never before (D7)
            }
        }
    };
    if (spec_->usb) {
        serial_->bind(b.net, rx, [this](std::string_view id, std::string_view line) {
            return serial_diag_answer(boot_->diag, id, line);
        });
        b.net.attach(*serial_);
    }
    if (spec_->ip && !gateway) {
        tcp_->bind(b.net, rx);
        udp_->bind(b.net);
        b.net.attach(*tcp_);
        b.net.attach(*udp_);
    }
    air_->attach(b.net);
    air_->set_net(spec_->net);
    air_->set_up(true);
    b.net.attach_air(*air_);
    b.device.set_air(true);
    fr::net::Net *net = &b.net;
    core_->post([net] { net->link_changed(LinkKind::espnow); });  // as the driver posts it once up
    if (spec_->net_log) {
        b.logs.attach(b.net);
    }
    // fr_ota's slot line, from the strand: this boot's log source (the strand is quiesced before it goes); and fr_core's
    // OTA decision lines. Both reach the USB line and, with net_log, LOG frames, as ESP_LOG lines do on target.
    KitLogs *logs = &b.logs;
    b.flash.set_log([logs](char level, std::string_view tag, std::string_view text) { logs->log(level, tag, text); });
    b.ota_host.set_logs(&b.logs);

    // fr_core's OTA wiring (design c4 §3) on the fake sink, the node's strand as fr_worker.
    fr::ota::Deps deps;
    deps.core = core_.get();
    deps.worker = strand_.get();
    deps.flash = &b.flash;
    deps.fetch = &b.fetch;
    deps.store = &b.store;
    deps.host = &b.ota_host;
    std::snprintf(deps.ident.board, sizeof(deps.ident.board), "%s", spec_->board.c_str());
    std::snprintf(deps.ident.profile, sizeof(deps.ident.profile), "%s", spec_->profile.c_str());
    std::snprintf(deps.ident.part_profile, sizeof(deps.ident.part_profile), "%s", "fr-4mb-v1");
    deps.fault_health = spec_->fault_health || b.flash.state().fault;
    deps.health_deadline_ms = spec_->health_ms;
    b.ota_bound = spec_->ota && b.ota.bind(deps);
    if (b.ota_bound) {
        b.device.set_ota(b.ota, b.flash);
        b.ota.on_boot();
        // CORE and CAPS: the services are up (a fault build drops CAPS inside Ota).
        b.ota.health_set(fr::ota::kHealthCore | fr::ota::kHealthCaps);
    }
    net_up_ = false;
    udp_ok_ = false;

    // USB: the port is plugged in (unless `usb detach` holds it out) and the hub may open it.
    if (spec_->usb && usb_plugged_ && shared_.bridge != nullptr) {
        usb(true);
    }
    // IP: at power-on the node joins at once (the storm, §5.3); after an outage it associates first.
    update_ip(false);
    out_.emit(R"({"ev":"started","descriptor_hash":%u,"fw":"%s","version":"%s","pending":%s,"epoch":%u})",
              b.device.hello_info().descriptor_hash, ota_fake::hex(b.flash.state().running).c_str(),
              b.flash.state().version.c_str(), b.ota_bound && b.ota.pending_verify() ? "true" : "false", unsigned{spec_->epoch});
    if (spec_->net_log) {
        b.logs.start(*spec_, b.flash.state().running, b.device.hello_info().caps | fr::net::kCapNetLog, spec_->ip,
                     b.flash.state().slot == 0 ? "ota_0" : "ota_1", b.flash.running().crashed ? "PANIC" : "POWERON");
    }
    tick_event_ = shared_.exec.after(250'000, [this] {
        tick_event_ = 0;
        tick();
    });
}

void FleetNode::tick()
{
    if (boot_ == nullptr) {
        return;
    }
    Boot &b = *boot_;
    // fr_core's 250 ms poll: writes a full worker queue refused.
    b.stores.retry();
    if (!net_up_ && (spec_->role == fr::proto::Role::gateway ? ip_ : tcp_->up())) {
        net_up_ = true;
        if (b.ota_bound) {
            b.ota.health_set(fr::ota::kHealthNet);  // NET: the network is there (Wi-Fi up on target)
        }
    }
    if (const bool ok = b.net.state().link(LinkKind::udp).udp_ok; ok != udp_ok_) {
        udp_ok_ = ok;
        out_.emit(R"({"ev":"udp_ok","on":%s})", ok ? "true" : "false");
    }
    if (b.flash.reboot_requested) {
        // esp_ota_mark_app_invalid_rollback_and_reboot: no BYE, the reset follows at once.
        restart("rollback", false);
        return;
    }
    if (b.device.rebooting()) {
        restart(b.device.reboot_reason(), true);
        return;
    }
    tick_event_ = shared_.exec.after(250'000, [this] {
        tick_event_ = 0;
        tick();
    });
}

void FleetNode::restart(const char *reason, bool bye)
{
    static_cast<void>(bye);  // the BYE went out already (Device::reboot), or there is none (a rollback)
    if (reason != nullptr) {
        out_.emit(R"({"ev":"reboot","reason":"%s"})", reason);
    } else {
        out_.emit(R"({"ev":"reboot"})");
    }
    power_off();
    // The reset and the boot to the core task take a moment on target (*inferred*); then the next boot.
    restart_event_ = shared_.exec.after(300'000, [this] {
        restart_event_ = 0;
        power_on();
    });
}

void FleetNode::power_off()
{
    // An explicit power cut wins over a reboot under way (its power-on 300 ms later): the node stays off (review
    // fleet-2). restart() arms its power-on only after this returns, so its own reboot is unaffected.
    shared_.exec.cancel(restart_event_);
    restart_event_ = 0;
    if (boot_ == nullptr) {
        return;
    }
    // Quiesce before anything of the boot is destroyed (D8): a GET blocked in a read returns, the strand's job in
    // flight returns and its queued ones are dropped, the core's posts and timers go with its generation, and the
    // radio's queue and pending deliveries too. Only then does the boot go.
    boot_->fetch.abort();
    strand_->quiesce();
    core_->crash();
    air_->crash();
    air_->set_up(false);
    tcp_->crash();  // silent; reset at +8 s, or closed after the next WELCOME (D7)
    udp_->crash();
    serial_->crash();
    shared_.exec.cancel(tick_event_);
    tick_event_ = 0;
    shared_.exec.cancel(assoc_event_);
    assoc_event_ = 0;
    associating_ = false;
    ip_ = false;
    // `wifi_down` and `tcp 0` are the board's RAM (WifiSta, hub_link): the next boot starts with Wi-Fi and TCP on, as
    // a power-on does (D8, review fleet-1).
    shared_.exec.cancel(wifi_event_);
    wifi_event_ = 0;
    wifi_off_ = false;
    tcp_off_ = false;
    if (spec_->usb && shared_.bridge != nullptr) {
        shared_.bridge->detach(mac_hex_);  // the port goes with the power
        serial_->set_write(nullptr);
        serial_->set_host(false);
    }
    boot_->net.set_air_tap(nullptr);
    boot_.reset();
}

bool FleetNode::usb(bool attach)
{
    if (!spec_->usb || shared_.bridge == nullptr) {
        return false;
    }
    usb_plugged_ = attach;
    if (!attach || boot_ == nullptr) {
        shared_.bridge->detach(mac_hex_);
        serial_->set_write(nullptr);
        serial_->set_host(false);
        return true;
    }
    Bridge &br = *shared_.bridge;
    br.attach(mac_hex_, [this](std::string_view line) {
        if (shared_.arrival && line.starts_with(fr::wire::kLinePrefix)) {
            uint8_t scratch[fr::wire::kMaxLineFrame];
            if (auto f = fr::wire::decode_line(line, scratch); f && f->type == fr::wire::kSerialEnv) {
                shared_.arrival(*spec_, f->body, shared_.exec.now());
            }
        }
        serial_->on_line(line);
    });
    serial_->set_write([this](std::string_view line) { shared_.bridge->print(mac_hex_, line); });
    serial_->set_host(true);
    return true;
}

void FleetNode::ap_changed(bool up)
{
    static_cast<void>(up);
    update_ip(true);
}

void FleetNode::update_ip(bool associate)
{
    const bool want = boot_ != nullptr && spec_->ip && !wifi_off_ && shared_.ap.associated(spec_->mac, spec_->radio.channel);
    if (!want) {
        shared_.exec.cancel(assoc_event_);
        assoc_event_ = 0;
        associating_ = false;
        if (ip_) {
            set_ip(false);
        }
        return;
    }
    if (ip_ || associating_) {
        return;
    }
    if (!associate) {
        set_ip(true);
        return;
    }
    // Association and DHCP before IP is up again (assoc_ms); the backoff then starts over (D7).
    associating_ = true;
    assoc_event_ = shared_.exec.after(shared_.ap.assoc_us(spec_->mac, assoc_draws_++), [this] {
        assoc_event_ = 0;
        associating_ = false;
        update_ip(false);
    });
}

void FleetNode::set_ip(bool up)
{
    ip_ = up;
    if (spec_->role == fr::proto::Role::gateway) {
        return;  // associated for its channel, no hub link over IP (fr_net's gateway role starts no HubLink)
    }
    udp_->set_ip(up);
    if (up && !tcp_off_) {
        tcp_->ip_up();
    } else if (!up) {
        tcp_->ip_down();  // silent: the hub's socket stays open (D7)
    }
    if (boot_ != nullptr) {
        fr::net::Net *net = &boot_->net;
        core_->post([net] { net->link_changed(LinkKind::udp); });
    }
}

std::span<const uint8_t> FleetNode::descriptor() const
{
    return boot_ != nullptr ? boot_->device.descriptor() : std::span<const uint8_t>{};
}

bool FleetNode::tcp_session() const
{
    return boot_ != nullptr && boot_->net.state().link(LinkKind::tcp).session;
}

bool FleetNode::serial_session() const
{
    return boot_ != nullptr && boot_->net.state().link(LinkKind::serial).session;
}

FleetNode::Answer FleetNode::command(std::string_view line)
{
    if (line == "power off") {
        const bool was = powered();
        power_off();
        return {.ok = true, .fields = was ? "" : R"(,"already":true)"};
    }
    if (line == "power on") {
        const bool was = powered();
        power_on();
        return {.ok = true, .fields = was ? R"(,"already":true)" : ""};
    }
    if (line == "usb attach" || line == "usb detach") {
        if (!usb(line == "usb attach")) {
            return {.ok = false, .fields = R"(,"error":"not a USB node")"};
        }
        return {.ok = true, .fields = ""};
    }
    if (boot_ == nullptr) {
        return {.ok = false, .fields = R"(,"error":"powered off")"};
    }
    Boot &b = *boot_;
    if (line.starts_with("analog report_hz")) {
        // fr.analog_in has no config command: the rate is the next boot's, as a profile change is a new image on target.
        uint32_t hz = 0;
        std::string_view rest = line.substr(16);
        if (b.analog == nullptr || !parse_u32(next_word(rest), 1, 200, hz) || !rest.empty()) {
            return {.ok = false, .fields = b.analog == nullptr ? R"(,"error":"no analog input")" : R"(,"error":"usage: analog report_hz <1-200>")"};
        }
        const bool changed = hz != spec_->analog_report_hz;
        spec_->analog_report_hz = static_cast<uint16_t>(hz);
        if (changed) {
            b.device.reboot(false);  // BYE now, the restart at the next tick
        }
        return {.ok = true, .fields = sformat(R"(,"report_hz":%u,"reboot":%s)", hz, changed ? "true" : "false")};
    }
    if (line.starts_with("diag ")) {
        // NodeDiag's answer, as fr.diag.exec gives it (the hub's diag_exec `response`).
        const auto r = b.diag.exec({.line = line.substr(5)});
        const std::string_view json = r ? r->json : std::string_view(R"({"ok":false,"error":"failed"})");
        return {.ok = true, .fields = ",\"response\":" + std::string(json)};
    }
    NodeCtx ctx{.spec = *spec_,
                .core = *core_,
                .net = b.net,
                .links = *links_,
                .out = out_,
                .device = b.device,
                .diag = b.diag,
                .ota = b.ota_bound ? &b.ota : nullptr,
                .button = &b.button,
                .logs = spec_->net_log || spec_->usb ? &b.logs : nullptr,
                .wave = wave_.get(),
                .analog = b.analog.get(),
                .analog_sink = b.analog != nullptr ? &b.analog_sink : nullptr};
    out_.begin_capture();
    const Commands::Result r = Commands::run(ctx, line, shared_.pace != nullptr ? shared_.pace->load() : 1.0);
    const std::vector<std::string> lines = out_.end_capture();
    if (!r.known) {
        return {.ok = false, .fields = R"(,"error":"unknown command")"};
    }
    std::string fields;
    for (const std::string &l : lines) {
        const std::string_view ev = ev_of(l);
        fields += ",\"" + (ev.empty() ? std::string("line") : json_text(ev)) + "\":" + l;
    }
    return {.ok = r.ok, .fields = fields};
}

}  // namespace frsim
