// NodeDiag (design c6 §6 S6, m2-c2 D2, D11): fr.diag on port 241 with fr_diag's answers, moved out of
// tools/net_node.cpp. The test pin and the Wi-Fi switch are the host's (NodeLinks), the espnow counters its radio's.
// M2-C2 adds `inject <inst> <gesture>` (fr_diag's run_call: the instance's own inject through the generated
// dispatch, answered {ok, status, fields}) and `neighbors [from]` (sorted by MAC, paged by `next`), so the bench
// gates' fleet diag (tests/sim/lib/fleet-diag.ts) gets the shapes the boards give. M2-C3 (design m2-c3-inputs §5,
// D6) adds the analog form `inject <inst> value=<n> [hold_ms=<n>]` and `stats`' state_repeats_superseded. M2-C4 (design
// m2-c4-gateway D10, D19) adds the gateway link to `info` and `stats` (`stats gateway`), and spike S2's hooks in fr_diag's
// shapes: `air bench tx|rx`, `air rate` and `air churn` over SimAir, `net stream`; `air txpower`, `wifi proto` and `cpu`
// answer unsupported (the medium has no TX power, protocols or CPU). D18: a gateway node's `stats gw` (its bridge's
// counters, fr_diag's shape; {"on":false} on any other node, and left out of a full `stats` there, as on target).
#include <algorithm>
#include <cstdio>
#include <cstring>

#include "cJSON.h"
#include "diag_json.hpp"  // generated JSON <-> wire codecs of `call` (FR_TEST_HOOKS)
#include "fr/gw/bridge.hpp"
#include "sim/node.hpp"

namespace frsim {

using fr::net::LinkKind;

NodeDiag::NodeDiag(fr::Core &core, const NodeSpec &spec, Out &out)
    : core_(core), spec_(spec), out_(out), test_pin_(board_test_pin(spec.board)), boot_us_(core.now())
{
}

void NodeDiag::bind(fr::net::Net &net, NodeLinks &links, std::span<const fr::PortEntry> ports)
{
    net_ = &net;
    links_ = &links;
    ports_ = ports;
}

std::expected<fr::cap::DiagExecResult, fr::Err> NodeDiag::exec(const fr::cap::DiagExecArgs &args)
{
    std::string_view line = args.line;
    const std::string_view cmd = next_word(line);
    int n = 0;
    if (cmd == "pin_pulse") {
        n = pin_pulse(line);
    } else if (cmd == "net") {
        n = net_hook(line);
    } else if (cmd == "stats") {
        n = stats(line);
    } else if (cmd == "info") {
        n = info();
    } else if (cmd == "inject") {
        n = inject(line);
    } else if (cmd == "neighbors") {
        n = neighbors(line);
    } else if (cmd == "air") {
        n = air(line);
    } else if (cmd == "wifi") {
        n = fail("unsupported", "no Wi-Fi protocols in the kit");
    } else if (cmd == "cpu") {
        n = fail("unsupported", "no CPU in the kit");
    } else {
        n = std::snprintf(out_buf_, sizeof(out_buf_), R"({"ok":false,"error":"unknown_command"})");
    }
    return fr::cap::DiagExecResult{.json = {out_buf_, std::min(static_cast<size_t>(std::max(n, 0)), sizeof(out_buf_) - 1)}};
}

int NodeDiag::info()
{
    // fr_diag's cmd_info (diag.cpp) in the parts a gate reads: identity, epoch and uptime (bootMark tells a reboot
    // by them), the hub link states and the Wi-Fi association from link_info() (T-FLOOD-B --router-off waits for
    // wifi.up, the RSSI pick reads wifi.rssi). The uptime counts from this boot, as esp_timer does. No alias: the
    // spec's is the boot's, not a later set_alias's (T-PROV's rename says it could not read it back, as before).
    const bool pin = links_->test_pin_wired() && test_pin_ >= 0;
    const fr::net::State st = net_->state();
    const fr::net::LinkInfo wifi = links_->wifi();
    const auto link = [&st](LinkKind k) { return st.link(k); };
    const char *const b = "true";
    const char *const f = "false";
    char bssid[18];
    std::snprintf(bssid, sizeof(bssid), "%02x:%02x:%02x:%02x:%02x:%02x", wifi.bssid[0], wifi.bssid[1], wifi.bssid[2],
                  wifi.bssid[3], wifi.bssid[4], wifi.bssid[5]);
    const auto &tcp = link(LinkKind::tcp);
    const auto &udp = link(LinkKind::udp);
    const auto &ser = link(LinkKind::serial);
    const auto &air = link(LinkKind::espnow);
    const auto &gw = link(LinkKind::gateway);
    return std::snprintf(
        out_buf_, sizeof(out_buf_),
        R"({"ok":true,"id":"%s","addr":%u,"state":"%s","epoch":%u,"board":"%s","profile":"%s",)"
        R"("uptime_ms":%lld,"inject_enabled":true,"test_pin":%d,)"
        R"("links":{"serial":{"up":%s,"session":%s,"synced":%s},"tcp":{"up":%s,"session":%s,"synced":%s},)"
        R"("udp":{"up":%s,"ok":%s},"espnow":{"up":%s,"ch":%u},"gateway":{"up":%s,"session":%s,"synced":%s}},)"
        R"("hub":{"link":%s,"epoch":%u},)"
        R"("wifi":{"up":%s,"ch":%u,"bssid":"%s","rssi":%d}})",
        hex(spec_.mac).c_str(), unsigned{spec_.addr},
        spec_.addr != fr::proto::kAddrUnassigned ? "PROVISIONED" : "UNASSIGNED", unsigned{spec_.epoch}, spec_.board.c_str(),
        spec_.profile.c_str(), static_cast<long long>((core_.now() - boot_us_) / 1000), pin ? test_pin_ : -1,
        ser.up ? b : f, ser.session ? b : f, ser.time_synced ? b : f, tcp.up ? b : f, tcp.session ? b : f,
        tcp.time_synced ? b : f, udp.up ? b : f, udp.udp_ok ? b : f, air.up ? b : f, unsigned{spec_.radio.channel},
        gw.up ? b : f, gw.session ? b : f, gw.time_synced ? b : f, st.hub_link() ? b : f, unsigned{st.hub_epoch}, wifi.wifi_up ? b : f, unsigned{wifi.channel}, bssid, int{wifi.rssi});
}

int NodeDiag::fail(const char *error, const char *detail)
{
    return std::snprintf(out_buf_, sizeof(out_buf_), R"({"ok":false,"error":"%s","detail":"%s"})", error, detail);
}

int NodeDiag::put(std::string_view json)
{
    const size_t n = std::min(json.size(), sizeof(out_buf_) - 1);
    std::memcpy(out_buf_, json.data(), n);
    out_buf_[n] = '\0';
    return static_cast<int>(n);
}

int NodeDiag::pin_pulse(std::string_view args)
{
    uint32_t us = 0;
    if (!parse_u32(next_word(args), 10, 100000, us) || !args.empty()) {
        return fail("invalid_args", "usage: pin_pulse <us> (10-100000)");
    }
    if (!links_->test_pin_wired() || test_pin_ < 0) {
        return fail("unsupported", "no test_pin on this board");
    }
    const fr::TimeUs now = core_.now();
    if (now < low_until_) {
        return std::snprintf(out_buf_, sizeof(out_buf_), R"({"ok":false,"error":"busy"})");
    }
    // One wire, two ends: the pulse is `<us>` on each (low now, released `us` later).
    links_->test_pin_pulse(us);
    low_until_ = now + us;
    out_.emit(R"({"ev":"pin_pulse","us":%u,"at_us":%lld})", us, static_cast<long long>(now));
    return std::snprintf(out_buf_, sizeof(out_buf_), R"({"ok":true,"pin":%d,"us":%u,"at_us":%lld})", test_pin_, us,
                         static_cast<long long>(now));
}

int NodeDiag::net_hook(std::string_view args)
{
    const std::string_view name = next_word(args);
    if (name == "stream") {
        return net_stream(args);
    }
    if (name == "loss") {
        uint32_t pct = 0;
        uint32_t secs = 0;
        const bool ok_pct = parse_u32(next_word(args), 0, 100, pct);
        const bool ok_s = parse_u32(next_word(args), 0, 86400, secs);
        const std::string_view d = next_word(args);
        fr::net::LossDir dir = fr::net::LossDir::both;
        bool ok_dir = d.empty() || d == "both";
        if (d == "tx" || d == "rx") {
            dir = d == "tx" ? fr::net::LossDir::tx : fr::net::LossDir::rx;
            ok_dir = true;
        }
        if (!ok_pct || !ok_s || !ok_dir || !args.empty()) {
            return fail("invalid_args", "usage: net loss <pct 0-100> <seconds 0-86400> [both|tx|rx] (0 ends it)");
        }
        net_->loss(static_cast<uint8_t>(pct), secs, dir);  // after this RESULT: Net defers it
        const char *dir_name = dir == fr::net::LossDir::tx ? "tx" : dir == fr::net::LossDir::rx ? "rx" : "both";
        out_.emit(R"({"ev":"loss","ok":true,"pct":%u,"s":%u,"dir":"%s"})", pct, secs, dir_name);  // as from stdin
        return std::snprintf(out_buf_, sizeof(out_buf_), R"({"ok":true,"hook":"loss","pct":%u,"s":%u,"dir":"%s"})", pct,
                             secs, dir_name);
    }
    uint32_t secs = 0;
    if (!parse_u32(next_word(args), 0, 86400, secs) || !args.empty()) {
        return fail("invalid_args", "usage: net drop_hub_link|udp_block|ip_block|wifi_down <seconds> | loss <pct> <seconds>");
    }
    if (name == "drop_hub_link") {
        net_->drop_hub_link(secs);
    } else if (name == "udp_block") {
        net_->udp_block(secs);
    } else if (name == "ip_block") {
        net_->ip_block(secs);
    } else if (name == "wifi_down") {
        if (!spec_.ip) {
            return fail("unsupported", "no Wi-Fi switch in this node");
        }
        // As fr_net's WifiSta (wifi_sta.cpp request_down): applied kWifiApplyDelayUs later, so this RESULT leaves over
        // the link the CMD came on first, TCP included (core.cpp; review fleet-5); a later request restarts the wait
        // with its own seconds. The timer is the boot's: a power cut in between drops it with the core's timers.
        if (wifi_timer_ == nullptr) {
            wifi_timer_ = core_.timer([this] { links_->wifi_down(wifi_secs_); });
            if (wifi_timer_ == nullptr) {
                return fail("busy", "no core timer for the Wi-Fi switch");
            }
        }
        wifi_secs_ = secs;
        wifi_timer_->start(static_cast<uint32_t>(kWifiApplyDelayUs));
    } else {
        return fail("invalid_args", "usage: net drop_hub_link|udp_block|ip_block|wifi_down <seconds> | loss <pct> <seconds>");
    }
    return std::snprintf(out_buf_, sizeof(out_buf_), R"({"ok":true,"hook":"%.*s","s":%u})", static_cast<int>(name.size()),
                         name.data(), secs);
}

std::string NodeDiag::section(std::string_view name) const
{
    const fr::net::State s = net_->state();
    if (name == "links") {
        constexpr std::pair<LinkKind, const char *> kLinks[] = {{LinkKind::serial, "serial"}, {LinkKind::tcp, "tcp"},
                                                                {LinkKind::udp, "udp"},       {LinkKind::espnow, "espnow"},
                                                                {LinkKind::gateway, "gateway"}};
        std::string out = "{";
        for (const auto &[kind, link_name] : kLinks) {
            const fr::net::LinkState &l = s.link(kind);
            out += sformat(R"(%s"%s":{"tx":%u,"tx_fail":%u,"rx":%u,"rx_drop":%u,"retries":%u})", out.size() > 1 ? "," : "",
                           link_name, l.tx, l.tx_fail, l.rx, l.rx_drop, l.retries);
        }
        return out + "}";
    }
    if (name == "bcast") {
        return sformat(R"({"delivered":%u,"dup":%u,"old":%u,"watermark":%u,"adopted":%u})", s.bcast.delivered, s.bcast.dup,
                       s.bcast.old, s.bcast.watermark, s.bcast.adopted);
    }
    if (name == "relay") {
        return sformat(R"({"seeded":%u,"relayed":%u,"cancelled":%u,"dropped":%u,"refused":%u})", s.relay.seeded,
                       s.relay.relayed, s.relay.cancelled, s.relay.dropped, s.relay.refused);
    }
    if (name == "espnow") {
        AirCounters c;
        if (!links_->air_counters(c)) {
            return R"({"tx":0,"tx_fail":0,"retries":0,"refused":0,"rx":0,"rx_bad":0,"rx_lost":0,"peers":0})";
        }
        return sformat(R"({"tx":%u,"tx_fail":%u,"retries":%u,"refused":%u,"rx":%u,"rx_bad":%u,"rx_lost":%u,"peers":%u})", c.tx,
                       c.tx_fail, c.retries, c.refused, c.rx, c.rx_bad, c.rx_lost, c.peers);
    }
    if (name == "bindings") {
        return sformat(R"({"fired":%u,"failed":%u,"rtt_p50_us":%u})", s.bindings.fired, s.bindings.failed, s.bindings.rtt_p50_us);
    }
    if (name == "nodes") {
        return sformat(R"({"delivered":%u,"dup":%u,"old":%u,"sent":%u,"via_espnow":%u,"via_hub":%u,"via_flood":%u,"failed":%u,"resolves":%u})",
                       s.nodes.delivered, s.nodes.dup, s.nodes.old, s.nodes.sent, s.nodes.via_espnow, s.nodes.via_hub,
                       s.nodes.via_flood, s.nodes.failed, s.nodes.resolves);
    }
    if (name == "gateway") {  // the gateway session (design m2-c4-gateway D10-D12)
        const fr::net::GatewayStats &g = s.gateway;
        std::string out = sformat(R"({"live":%u,"beacons":%u,"lost":%u,"opened":%u,"closed":%u,"tx_nak":%u,"too_big":%u)",
                                  unsigned{g.live}, g.beacons, g.lost, g.opened, g.closed, g.tx_nak, g.too_big);
        if (g.chosen) {
            out += sformat(R"(,"age_ms":%lld)", static_cast<long long>((core_.now() - g.heard_at) / 1000));
        }
        return out + "}";
    }
    if (name == "gw") {  // a gateway's bridge (design m2-c4-gateway D8, D18), in fr_diag's order
        if (gw_ == nullptr) {
            return R"({"on":false})";
        }
        const fr::gw::Stats g = gw_->stats();
        const std::pair<const char *, uint32_t> fields[] = {
            {"tx", g.tx},
            {"tx_fail", g.tx_fail},
            {"tx_nak", g.tx_nak},
            {"tx_queue_full", g.tx_queue_full},
            {"tx_no_peer", g.tx_no_peer},
            {"tx_too_big", g.tx_too_big},
            {"tx_radio_off", g.tx_radio_off},
            {"tx_stale", g.tx_stale},
            {"tx_dropped", g.tx_dropped},
            {"tx_busy", g.tx_busy},
            {"done_dropped", g.done_dropped},
            {"tx_refused", g.tx_refused},
            {"rx", g.rx},
            {"rx_drop", g.rx_drop},
            {"rx_no_hub", g.rx_no_hub},
            {"rx_line_full", g.rx_line_full},
            {"rx_too_big", g.rx_too_big},
            {"rx_bad", g.rx_bad},
            {"pings", g.pings},
            {"hub_lost", g.hub_lost},
            {"cmds", g.cmds},
            {"beacons", g.beacons},
            {"q_high", g.q_high},
            {"last_tx_us", g.last_tx_us},
        };
        std::string out = R"({"on":true)";
        for (const auto &[key, v] : fields) {
            out += sformat(R"(,"%s":%u)", key, v);
        }
        return out + "}";
    }
    if (name == "net_logs") {  // LOG frames over TCP (design m2-c2 D20)
        return sformat(R"({"sent":%u,"ring_drop":%u,"age_drop":%u,"rate_drop":%u,"cut":%u})", s.logs.sent, s.logs.ring_drop,
                       s.logs.age_drop, s.logs.rate_drop, s.logs.cut);
    }
    std::string out = "{";  // msgs: per topic, then other
    for (const fr::net::MsgStats::Topic &t : net_->msg_stats().topics) {
        if (t.name[0] != '\0') {
            out += "\"" + json_text(t.name) + "\":" + std::to_string(t.n) + ",";
        }
    }
    return out + R"("other":)" + std::to_string(net_->msg_stats().other) + "}";
}

/**
 * `stats [section]` as fr_diag's cmd_stats: one section alone, or the counters and every section, dropping sections
 * from the end (named in `omitted`) until the answer fits fr.diag.exec. No `reset` here.
 */
int NodeDiag::stats(std::string_view args)
{
    const std::string_view opt = next_word(args);
    const auto *it = std::find(std::begin(kSections), std::end(kSections), opt);
    if (!args.empty() || (!opt.empty() && it == std::end(kSections))) {
        return fail("invalid_args", "usage: stats [links|bcast|relay|espnow|bindings|nodes|msgs|net_logs|gateway|gw]");
    }
    std::string out;
    if (!opt.empty()) {
        out = sformat(R"({"ok":true,"%.*s":)", static_cast<int>(opt.size()), opt.data()) + section(opt) + "}";
    } else {
        const fr::net::State s = net_->state();
        out = sformat(R"({"ok":true,"cmds":%u,"cmds_refused":%u,"hook_dropped":%u,"loss_tx":%u,"loss_rx":%u,)"
                      R"("cmds_scheduled":%u,"exec_late":%u,"exec_cancelled":%u,"exec_late_us_max":%u,"rx_queue_us_max":%u,)",
                      s.cmds, s.cmds_refused, s.hook_drops, s.loss_tx, s.loss_rx, s.cmds_scheduled, s.exec_late,
                      s.exec_cancelled, s.exec_late_us_max, s.rx_queue_us_max) +
              sformat(R"("dup":%u,"old":%u,"cached_replies":%u,"sessions_lost":%u,"events_dropped":%u,"delivery_failed":%u,)"
                      R"("state_repeats_superseded":%u)",
                      s.dup, s.old, s.cached_replies, s.sessions_lost, s.events_dropped, s.delivery_failed,
                      s.state_repeats_superseded);
        std::vector<std::string> parts;
        std::vector<std::string_view> names;
        for (const std::string_view name : kSections) {
            if (name == "gw" && gw_ == nullptr) {
                continue;  // only a gateway has a bridge; `stats gw` still answers {"on":false}
            }
            parts.push_back(sformat(R"("%.*s":)", static_cast<int>(name.size()), name.data()) + section(name));
            names.push_back(name);
        }
        std::string omitted;
        auto total = [&] {
            size_t n = out.size() + 1 + (omitted.empty() ? 0 : omitted.size() + 14);
            for (const std::string &p : parts) {
                n += p.size() + 1;
            }
            return n;
        };
        for (size_t i = parts.size(); i-- > 0 && total() >= sizeof(out_buf_);) {
            omitted = sformat(R"("%.*s")", static_cast<int>(names[i].size()), names[i].data()) +
                      (omitted.empty() ? "" : "," + omitted);
            parts.pop_back();
        }
        for (const std::string &p : parts) {
            out += "," + p;
        }
        out += (omitted.empty() ? "" : R"(,"omitted":[)" + omitted + "]") + "}";
    }
    return put(out);
}

namespace {

/** `<key>=<n>` with n <= max (fr_diag's parse_kv). */
bool parse_kv(std::string_view word, std::string_view key, uint32_t max, uint32_t &out)
{
    if (word.size() <= key.size() + 1 || !word.starts_with(key) || word[key.size()] != '=') {
        return false;
    }
    return parse_u32(word.substr(key.size() + 1), 0, max, out);
}

// fr_diag's (diag.cpp kInjectUsage): the button form takes a gesture, the analog form (m2-c3-inputs §5) a value.
constexpr const char *kInjectUsage = "usage: inject <inst> <gesture> | inject <inst> value=<0-65535> [hold_ms=<0-60000>]";

}  // namespace

/**
 * `inject <inst> <gesture>` and (M2-C3) `inject <inst> value=<n> [hold_ms=<n>]` as fr_diag's: the instance's `inject`
 * command through the generated JSON codec and its dispatch, as a CMD from the hub would run it (so the gesture's
 * events and the bindings they fire go through Net like a real press, and a held value reports as a sample would),
 * answered {"ok":true,"status":<ok or the error>,"fields":{...}}. hold_ms 0 or absent: the service's 1,000 ms.
 */
int NodeDiag::inject(std::string_view args)
{
    const std::string_view inst = next_word(args);
    const std::string_view first = next_word(args);
    cJSON *json = nullptr;
    if (first.starts_with("value=")) {
        uint32_t value = 0;
        uint32_t hold_ms = 0;
        const std::string_view second = next_word(args);
        if (inst.empty() || !parse_kv(first, "value", 65535, value) || (!second.empty() && !parse_kv(second, "hold_ms", 60000, hold_ms)) ||
            !args.empty()) {
            return fail("invalid_args", kInjectUsage);
        }
        json = cJSON_CreateObject();
        cJSON_AddNumberToObject(json, "value", value);
        if (!second.empty()) {
            cJSON_AddNumberToObject(json, "hold_ms", hold_ms);
        }
    } else if (inst.empty() || first.empty() || !args.empty() || first.size() >= 24) {
        return fail("invalid_args", kInjectUsage);
    }
    const fr::PortEntry *p = nullptr;
    for (const fr::PortEntry &e : ports_) {
        if (e.port >= 1 && e.port <= 239 && e.cap != nullptr && std::string_view(e.name) == inst) {
            p = &e;
        }
    }
    if (p == nullptr) {
        cJSON_Delete(json);
        const std::string detail = sformat("no instance '%.*s'", static_cast<int>(inst.size()), inst.data());
        return fail("not_found", detail.c_str());
    }
    if (json == nullptr) {
        json = cJSON_CreateObject();
        cJSON_AddStringToObject(json, "gesture", std::string(first).c_str());
    }
    uint8_t buf[fr::cap::Reply::kRealtimeCapacity];
    fr::wire::Writer w(buf, sizeof(buf));
    uint8_t cmd_id = 0;
    const fr::Status enc = fr::cap::encode_args_json(p->cap->cap_id(), "inject", json, &cmd_id, w);
    cJSON_Delete(json);
    if (!enc) {
        return fail(fr::err_name(enc.error()), "cannot encode arguments of inject");
    }
    fr::cap::StaticReply<> reply;
    const fr::Status st = p->ok ? p->cap->dispatch(cmd_id, w.bytes(), reply) : fr::Status{std::unexpected(fr::Err::failed)};
    cJSON *fields = st ? fr::cap::decode_to_json(p->cap->cap_id(), fr::wire::kClsResult, cmd_id, reply.bytes()) : nullptr;
    char *text = fields != nullptr ? cJSON_PrintUnformatted(fields) : nullptr;
    const std::string answer =
        sformat(R"({"ok":true,"status":"%s","fields":%s})", st ? "ok" : fr::err_name(st.error()), text != nullptr ? text : "{}");
    cJSON_free(text);
    cJSON_Delete(fields);
    return put(answer);
}

/**
 * `neighbors [from]` as fr_diag's (design c5 §2): the ESP-NOW neighbour table sorted by MAC from index `from`, as
 * many entries as fit fr.diag.exec, then `next` when more remain.
 */
int NodeDiag::neighbors(std::string_view args)
{
    const std::string_view from_arg = next_word(args);
    uint32_t from = 0;
    if (!args.empty()) {
        return fail("invalid_args", "usage: neighbors [from]");
    }
    if (!from_arg.empty() && !parse_u32(from_arg, 0, fr::net::kNeighborsMax, from)) {
        return fail("invalid_args", "usage: neighbors [from] (0-20)");
    }
    const fr::net::Neighbors nb = net_->neighbors();
    std::vector<fr::net::Neighbor> sorted(nb.items.begin(),
                                          nb.items.begin() + static_cast<std::ptrdiff_t>(std::min(nb.count, nb.items.size())));
    std::sort(sorted.begin(), sorted.end(), [](const fr::net::Neighbor &a, const fr::net::Neighbor &b) { return a.mac < b.mac; });
    const fr::TimeUs now = core_.now();
    const size_t room = sizeof(out_buf_) - 1;
    size_t used = sizeof(R"({"ok":true,"count":20,"neighbors":[],"next":19})") - 1;
    std::string items;
    std::string next;
    for (size_t i = from; i < sorted.size(); ++i) {
        const fr::net::Neighbor &e = sorted[i];
        const std::string o = sformat(R"({"mac":"%s","addr":%u,"rssi":%d,"age_ms":%lld,"ack_ok":%u,"ack_fail":%u})",
                                      hex(e.mac).c_str(), unsigned{e.addr}, int{e.rssi},
                                      static_cast<long long>((now - e.last_heard) / 1000), e.ack_ok, e.ack_fail);
        if (!items.empty() && used + 1 + o.size() > room) {
            next = sformat(R"(,"next":%zu)", i);
            break;
        }
        used += (items.empty() ? 0 : 1) + o.size();
        items += (items.empty() ? "" : ",") + o;
    }
    return put(sformat(R"({"ok":true,"count":%zu,"neighbors":[%s]%s})", sorted.size(), items.c_str(), next.c_str()));
}

// ---- the serial command channel ----

std::optional<std::string_view> serial_diag_id(std::string_view cmd)
{
    if (cmd.size() < 3 || cmd.front() != '#') {
        return std::nullopt;
    }
    size_t n = 1;
    while (n < cmd.size() && cmd[n] >= '0' && cmd[n] <= '9') {
        ++n;
    }
    if (n == 1 || n > 9 || n >= cmd.size() || cmd[n] != ' ') {
        return std::nullopt;
    }
    return cmd.substr(1, n - 1);
}

std::string serial_diag_answer(NodeDiag &diag, std::string_view id, std::string_view line)
{
    const std::string_view rest = line.substr(id.size() + 2);
    const auto r = diag.exec({.line = rest});
    const std::string_view json = r ? r->json : std::string_view(R"({"ok":false,"error":"failed"})");
    return sformat("#%.*s %.*s", static_cast<int>(id.size()), id.data(), static_cast<int>(json.size()), json.data());
}

}  // namespace frsim

// ---- spike S2's hooks (design m2-c4-gateway D19), fr_diag's shapes (diag.cpp cmd_air, cmd_net_stream) ----

namespace frsim {

namespace {

/** A MAC as 12 hex digits, colons between the bytes allowed (fr_diag's parse_mac). */
bool parse_mac(std::string_view s, fr::net::Mac &out)
{
    size_t n = 0;
    for (const char c : s) {
        if (c == ':') {
            continue;
        }
        const int v = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
        if (v < 0 || n >= 12) {
            return false;
        }
        out[n / 2] = static_cast<uint8_t>(n % 2 == 0 ? v << 4 : out[n / 2] | v);
        ++n;
    }
    return n == 12;
}

const char *err_text(fr::Err e)
{
    return fr::err_name(e);
}

}  // namespace

int NodeDiag::air(std::string_view args)
{
    const std::string_view what = next_word(args);
    if (what == "bench") {
        const std::string_view dir = next_word(args);
        if (dir == "rx") {
            return bench_rx(args);
        }
        const std::string_view dst_arg = next_word(args);
        uint32_t count = 0;
        uint32_t len = 0;
        uint32_t interval = 0;
        const bool ok_count = parse_u32(next_word(args), 1, 1'000'000, count);
        const bool ok_len = parse_u32(next_word(args), 32, 215, len);
        const bool ok_iv = parse_u32(next_word(args), 0, 60'000, interval);
        const std::string_view echo_arg = next_word(args);
        fr::net::Mac mac = fr::net::kBroadcastMac;
        const bool bcast = dst_arg == "bcast";
        if (dir != "tx" || (!bcast && !parse_mac(dst_arg, mac)) || !ok_count || !ok_len || !ok_iv ||
            (!echo_arg.empty() && echo_arg != "echo") || !args.empty()) {
            return fail("invalid_args", "usage: air bench tx <mac|bcast> <count 1-1000000> <len 32-215> "
                                        "<interval_ms 0-60000> [echo] | air bench rx [reset]");
        }
        const bool echo = echo_arg == "echo";
        if (const fr::Status st = net_->bench_tx(mac, count, static_cast<uint16_t>(len), interval, echo); !st) {
            return std::snprintf(out_buf_, sizeof(out_buf_), R"({"ok":false,"error":"%s"})", err_text(st.error()));
        }
        return std::snprintf(out_buf_, sizeof(out_buf_),
                             R"({"ok":true,"dst":"%s","count":%u,"len":%u,"interval_ms":%u,"echo":%s})",
                             bcast ? "bcast" : hex(mac).c_str(), count, len, interval, echo ? "true" : "false");
    }
    if (what == "rate") {
        const std::string_view rate = next_word(args);
        const std::string_view peer = next_word(args);
        if ((rate != "robust" && rate != "fast") || (!peer.empty() && peer != "bcast") || !args.empty()) {
            return fail("invalid_args", "usage: air rate <robust|fast> [bcast]");
        }
        uint32_t peers = 0;
        uint32_t failed = 0;
        if (!links_->air_rate(rate == "fast" ? fr::net::AirRate::fast : fr::net::AirRate::robust, peer == "bcast", peers,
                              failed)) {
            return fail("unsupported", "no per-peer rates on this radio");
        }
        return std::snprintf(out_buf_, sizeof(out_buf_), R"({"ok":true,"rate":"%s","peer":"%s","peers":%u,"rate_fail":%u})",
                             rate == "fast" ? "fast" : "robust", peer == "bcast" ? "bcast" : "unicast", peers, failed);
    }
    if (what == "churn") {
        uint32_t n = 0;
        if (!parse_u32(next_word(args), 1, 1000, n) || !args.empty()) {
            return fail("invalid_args", "usage: air churn <n 1-1000>");
        }
        AirChurnCounts c;
        if (!links_->air_churn(n, c)) {
            return fail("unsupported", "no peer table on this radio");
        }
        return std::snprintf(out_buf_, sizeof(out_buf_),
                             R"({"ok":true,"n":%u,"failed":%u,"add_us":{"p50":%u,"p99":%u,"max":%u},)"
                             R"("del_us":{"p50":%u,"p99":%u,"max":%u}})",
                             c.n, c.failed, c.add_p50_us, c.add_p99_us, c.add_max_us, c.del_p50_us, c.del_p99_us,
                             c.del_max_us);
    }
    if (what == "txpower") {
        return fail("unsupported", "no TX power on the medium");
    }
    return fail("invalid_args", "usage: air bench tx|rx ... | rate <robust|fast> [bcast] | txpower <qdbm|profile> | churn <n>");
}

int NodeDiag::bench_rx(std::string_view args)
{
    const std::string_view opt = next_word(args);
    if ((!opt.empty() && opt != "reset") || !args.empty()) {
        return fail("invalid_args", "usage: air bench rx [reset]");
    }
    const fr::net::BenchReport r = net_->bench_report();
    const fr::net::BenchTx &t = r.tx;
    const char *const b = "true";
    const char *const f = "false";
    std::string out = sformat(
        R"({"ok":true,"tx":{"running":%s,"dst":"%s","count":%u,"len":%u,"interval_ms":%u,"echo":%s,"sent":%u,)"
        R"("refused":%u,"acked":%u,"failed":%u,"echoes":%u,"rtt_p50_us":%u,"rtt_p99_us":%u,"rtt_max_us":%u,)"
        R"("elapsed_ms":%u},"rx":[)",
        t.running ? b : f, t.broadcast ? "bcast" : hex(t.dst).c_str(), t.count, unsigned{t.len}, t.interval_ms,
        t.echo ? b : f, t.sent, t.refused, t.acked, t.failed, t.echoes, t.rtt_p50_us, t.rtt_p99_us, t.rtt_max_us,
        t.elapsed_ms);
    for (size_t i = 0; i < r.rx_count; ++i) {
        const fr::net::BenchRx &x = r.rx[i];
        out += sformat(R"(%s{"mac":"%s","addr":%u,"received":%u,"gaps":%u,"dups":%u,"rssi_p50":%d,"echoed":%u,"age_ms":%u})",
                       i > 0 ? "," : "", hex(x.mac).c_str(), unsigned{x.addr}, x.received, x.gaps, x.dups, int{x.rssi_p50},
                       x.echoed, x.age_ms);
    }
    out += "]}";
    if (opt == "reset") {
        net_->bench_reset();  // the answer carries what was cleared
    }
    return put(out);
}

int NodeDiag::net_stream(std::string_view args)
{
    uint32_t hz = 0;
    uint32_t secs = 0;
    uint32_t len = 8;
    const bool ok_hz = parse_u32(next_word(args), 0, 1000, hz);
    const bool ok_s = parse_u32(next_word(args), 0, 3600, secs);
    const std::string_view len_arg = next_word(args);
    if (!ok_hz || !ok_s || (!len_arg.empty() && !parse_u32(len_arg, 1, 200, len)) || !args.empty()) {
        return fail("invalid_args", "usage: net stream <hz 0-1000> <seconds 0-3600> [len 1-200] (0 ends it)");
    }
    if (const fr::Status st = net_->stream(hz, secs, static_cast<uint16_t>(len)); !st) {
        return std::snprintf(out_buf_, sizeof(out_buf_), R"({"ok":false,"error":"%s"})", err_text(st.error()));
    }
    return std::snprintf(out_buf_, sizeof(out_buf_), R"({"ok":true,"hook":"stream","hz":%u,"s":%u,"len":%u,"port":%u,"prop":%u})",
                         hz, secs, len, unsigned{fr::proto::kPortDiag}, unsigned{fr::net::Net::kStreamProp});
}

}  // namespace frsim
