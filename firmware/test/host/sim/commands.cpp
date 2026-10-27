// fr_net_node's stdin command table and state printers (design m2-c2 D2), moved out of tools/net_node.cpp with the
// same parsing (a command is matched by its prefix, `arg` is the number after its first space) and the same lines.
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "sim/commands.hpp"

namespace frsim {

using fr::net::LinkKind;

namespace {

/** The C5 part of `state`: Net's ESP-NOW link and counters, the medium's, the tables. */
std::string c5_state(const fr::net::Net &net, const AirCounters *air)
{
    const fr::net::State s = net.state();
    const fr::net::LinkState &l = s.link(LinkKind::espnow);
    size_t bindings = 0;
    for (const fr::net::BindingSlot &b : net.bindings()) {
        bindings += b.used ? 1 : 0;
    }
    std::string out = sformat(
        R"("air_up":%s,"air_tx":%u,"air_tx_fail":%u,"air_rx":%u,"air_rx_drop":%u,"air_retries":%u,)"
        R"("relay_seeded":%u,"relay_relayed":%u,"relay_cancelled":%u,"relay_dropped":%u,)"
        R"("bcast_delivered":%u,"bcast_dup":%u,"bcast_old":%u,"bcast_watermark":%u,)"
        R"("bind_fired":%u,"bind_failed":%u,"bind_rtt_p50_us":%u,"bindings":%zu,"directory":%zu,"neighbors":%zu,)"
        R"("nodes":{"delivered":%u,"dup":%u,"old":%u,"sent":%u,"via_espnow":%u,"via_hub":%u,"via_flood":%u,"failed":%u,"resolves":%u})",
        l.up ? "true" : "false", l.tx, l.tx_fail, l.rx, l.rx_drop, l.retries, s.relay.seeded, s.relay.relayed,
        s.relay.cancelled, s.relay.dropped, s.bcast.delivered, s.bcast.dup, s.bcast.old, s.bcast.watermark,
        s.bindings.fired, s.bindings.failed, s.bindings.rtt_p50_us, bindings, net.directory().count, net.neighbors().count,
        s.nodes.delivered, s.nodes.dup, s.nodes.old, s.nodes.sent, s.nodes.via_espnow, s.nodes.via_hub, s.nodes.via_flood,
        s.nodes.failed, s.nodes.resolves);
    if (air != nullptr) {
        out += sformat(
            R"(,"medium":{"tx":%u,"rx":%u,"rx_bad":%u,"lost":%u,"acks":%u,"sent":%u,"failed":%u,"link_retries":%u,"refused":%u,"peers":%u})",
            air->datagrams, air->rx, air->rx_bad, air->rx_lost, air->acks, air->tx, air->tx_fail, air->retries, air->refused,
            air->peers);
    }
    out += R"(,"msgs":{)";
    for (const fr::net::MsgStats::Topic &t : net.msg_stats().topics) {
        if (t.name[0] != '\0') {
            out += "\"" + json_text(t.name) + "\":" + std::to_string(t.n) + ",";
        }
    }
    out += R"("other":)" + std::to_string(net.msg_stats().other) + "}";
    return out;
}

/** The C6 part of `state` (design c6 D21-D23): `net loss` and its counts, exec_at's table, the receive queue. */
std::string c6_state(const fr::net::State &s)
{
    const char *dir = s.loss_dir == fr::net::LossDir::tx ? "tx" : s.loss_dir == fr::net::LossDir::rx ? "rx" : "both";
    return sformat(R"("loss_pct":%u,"loss_dir":"%s","loss_tx":%u,"loss_rx":%u,"cmds_refused":%u,"cmds_scheduled":%u,)"
                   R"("exec_late":%u,"exec_cancelled":%u,"exec_late_us_max":%u,"rx_queue_us_max":%u)",
                   unsigned{s.loss_pct}, dir, s.loss_tx, s.loss_rx, s.cmds_refused, s.cmds_scheduled, s.exec_late,
                   s.exec_cancelled, s.exec_late_us_max, s.rx_queue_us_max);
}

/** `msg <dst|broadcast> <topic> [data…]`: fr::msg::send from the table. */
bool msg(NodeCtx &ctx, std::string_view args, bool reliable)
{
    auto word = [&args]() {
        while (!args.empty() && args.front() == ' ') {
            args.remove_prefix(1);
        }
        const size_t sp = std::min(args.find(' '), args.size());
        const std::string_view w = args.substr(0, sp);
        args.remove_prefix(sp);
        return w;
    };
    const std::string_view dst_text = word();
    const std::string_view topic = word();
    if (!args.empty() && args.front() == ' ') {
        args.remove_prefix(1);
    }
    const uint16_t dst = dst_text == "broadcast"
                             ? fr::msg::kBroadcast
                             : static_cast<uint16_t>(std::strtoul(std::string(dst_text).c_str(), nullptr, 0));
    const fr::Status st = fr::core::msg_send(
        ctx.net, dst, topic, std::span<const uint8_t>(reinterpret_cast<const uint8_t *>(args.data()), args.size()), reliable);
    ctx.out.emit(R"({"ev":"msg_sent","dst":%u,"topic":"%s","ok":%s,"error":"%s"})", unsigned{dst}, json_text(topic).c_str(),
                 st ? "true" : "false", st ? "" : fr::err_name(st.error()));
    return static_cast<bool>(st);
}

/** `log <E|W|I|D|V> <tag> <text…>` (design m2-c2 D20): one line through the node's log source. */
bool log_line(NodeCtx &ctx, std::string_view args)
{
    const std::string_view level = next_word(args);
    const std::string_view tag = next_word(args);
    return ctx.logs != nullptr && level.size() == 1 && ctx.logs->log(level.front(), tag, args);
}

}  // namespace

Commands::Result Commands::run(NodeCtx &ctx, std::string_view line, double pace)
{
    const std::string cmd(line);
    const uint32_t arg = static_cast<uint32_t>(std::strtoul(cmd.c_str() + std::min(cmd.find(' '), cmd.size()), nullptr, 10));
    Result r{.known = true, .ok = true};
    if (cmd == "state") {
        AirCounters c;
        const bool air = ctx.links.air_counters(c);
        print_state(ctx.out, ctx.net, air ? &c : nullptr, ctx.ota != nullptr ? ctx.ota->health() : 0);
    } else if (cmd.starts_with("udp_block")) {
        ctx.net.udp_block(arg);
    } else if (cmd.starts_with("drop_hub_link")) {
        ctx.net.drop_hub_link(arg);
    } else if (cmd.starts_with("ip_block")) {
        ctx.net.ip_block(arg);
    } else if (cmd.starts_with("tcp ")) {
        ctx.links.tcp_enable(arg != 0);
    } else if (cmd.starts_with("usb ")) {
        ctx.links.serial_host(arg != 0);
    } else if (cmd.starts_with("hub_mute ")) {
        ctx.links.hub_mute(arg != 0);
    } else if (cmd.starts_with("wifi_down")) {
        r.ok = ctx.spec.ip;
        if (ctx.spec.ip) {
            ctx.links.wifi_down(arg);
        }
    } else if (cmd.starts_with("loss ")) {
        // `loss <pct> <s> [both|tx|rx]` (design c6 D21): from here at once, as from the serial channel.
        const std::string_view rest = std::string_view(cmd).substr(5);
        unsigned pct = 0;
        unsigned secs = 0;
        char dir[8] = "both";
        const int got = std::sscanf(std::string(rest).c_str(), "%u %u %7s", &pct, &secs, dir);
        const std::string_view d = dir;
        r.ok = got >= 2 && pct <= 100 && (d == "both" || d == "tx" || d == "rx");
        if (r.ok) {
            using fr::net::LossDir;
            const LossDir way = d == "tx" ? LossDir::tx : d == "rx" ? LossDir::rx : LossDir::both;
            ctx.net.loss(static_cast<uint8_t>(pct), secs, way);
        }
        ctx.out.emit(R"({"ev":"loss","ok":%s,"pct":%u,"s":%u,"dir":"%s"})", r.ok ? "true" : "false", pct, secs, dir);
    } else if (cmd.starts_with("air_loss")) {
        ctx.links.air_loss(arg);
    } else if (cmd.starts_with("msg_reliable ")) {
        r.ok = msg(ctx, std::string_view(cmd).substr(13), true);
    } else if (cmd.starts_with("msg ")) {
        r.ok = msg(ctx, std::string_view(cmd).substr(4), false);
    } else if (cmd.starts_with("bind ")) {
        std::string_view h = std::string_view(cmd).substr(5);
        std::vector<uint8_t> bytes(h.size() / 2);
        const bool hex_ok = h.size() % 2 == 0 && parse_hex(h, bytes);
        const fr::Status st = hex_ok ? ctx.net.set_binding(bytes) : fr::Status{std::unexpected(fr::Err::invalid_args)};
        r.ok = static_cast<bool>(st);
        ctx.out.emit(R"({"ev":"bind","ok":%s})", st ? "true" : "false");
    } else if (cmd.starts_with("unbind ")) {
        const bool all = cmd.ends_with(" all");
        const fr::Status st = ctx.net.clear_binding(all ? fr::net::kBindSlotAll : static_cast<uint8_t>(arg));
        r.ok = static_cast<bool>(st);
        ctx.out.emit(R"({"ev":"unbind","ok":%s})", st ? "true" : "false");
    } else if (cmd == "bindings") {
        const auto list = ctx.net.encode_bindings(ctx.device.bind_buf());
        r.ok = static_cast<bool>(list);
        ctx.out.emit(R"({"ev":"bindings","ok":%s,"hex":"%s"})", list ? "true" : "false", list ? hex(*list).c_str() : "");
    } else if (cmd == "neighbors") {
        print_neighbors(ctx.out, ctx.net, ctx.core.now());
    } else if (cmd == "directory") {
        print_directory(ctx.out, ctx.net);
    } else if (cmd.starts_with("inject ")) {
        // A gesture on the boot button, as the hub's input_simulate: its events, and the bindings they fire, go
        // through Net like a real press (T-NN without a hub). The fixture has none.
        fr::cap::ButtonGesture g{};
        const bool known = ctx.button != nullptr && fr::cap::from_name(std::string_view(cmd).substr(7), g);
        const fr::Status st = known ? ctx.button->inject({.gesture = g}) : fr::Status{std::unexpected(fr::Err::invalid_args)};
        r.ok = static_cast<bool>(st);
        ctx.out.emit(R"({"ev":"inject","ok":%s})", st ? "true" : "false");
    } else if (cmd == "bye") {
        ctx.net.bye(fr::net::kByeShutdown);
    } else if (cmd.starts_with("log_rate ")) {
        const double rate = std::strtod(cmd.c_str() + 9, nullptr);
        r.ok = ctx.logs != nullptr && rate >= 0 && rate <= 1000 && ctx.logs->set_rate(rate * pace);
    } else if (cmd.starts_with("log ")) {
        r.ok = log_line(ctx, std::string_view(cmd).substr(4));
    } else {
        r = {};
    }
    return r;
}

void print_state(Out &out, const fr::net::Net &net, const AirCounters *air, uint32_t health)
{
    const fr::net::State s = net.state();
    const auto &tcp = s.link(LinkKind::tcp);
    const auto &udp = s.link(LinkKind::udp);
    const auto &ser = s.link(LinkKind::serial);
    out.emit(R"({"ev":"state","serial_session":%s,"serial_tx":%u,"serial_rx":%u,"session":%s,"udp_ok":%s,"time_synced":%s,"hub_epoch":%u,"tcp_tx":%u,"tcp_rx":%u,"udp_tx":%u,)"
             R"("udp_retries":%u,"rx_drop":%u,"cmds":%u,"dup":%u,"old":%u,"cached_replies":%u,"sessions_lost":%u,)"
             R"("events_dropped":%u,"delivery_failed":%u,"udp_blocked":%s,"ip_blocked":%s,"hook_drops":%u,%s,%s,)"
             R"("health":%u,"hub_session":%s})",
             ser.session ? "true" : "false", ser.tx, ser.rx, tcp.session ? "true" : "false", udp.udp_ok ? "true" : "false",
             s.time_synced() ? "true" : "false", unsigned{s.hub_epoch}, tcp.tx, tcp.rx, udp.tx, udp.retries,
             tcp.rx_drop + udp.rx_drop, s.cmds, s.dup, s.old, s.cached_replies, s.sessions_lost, s.events_dropped,
             s.delivery_failed, s.udp_blocked ? "true" : "false", s.ip_blocked ? "true" : "false", s.hook_drops,
             c5_state(net, air).c_str(), c6_state(s).c_str(), health, s.hub_link() ? "true" : "false");
}

void print_neighbors(Out &out, const fr::net::Net &net, fr::TimeUs now)
{
    const fr::net::Neighbors nb = net.neighbors();
    std::string items;
    for (size_t i = 0; i < nb.count && i < nb.items.size(); ++i) {
        const fr::net::Neighbor &e = nb.items[i];
        items += sformat(R"(%s{"mac":"%s","addr":%u,"rssi":%d,"age_ms":%lld,"ack_ok":%u,"ack_fail":%u})", i == 0 ? "" : ",",
                         hex(e.mac).c_str(), unsigned{e.addr}, int{e.rssi}, static_cast<long long>((now - e.last_heard) / 1000),
                         e.ack_ok, e.ack_fail);
    }
    out.emit(R"({"ev":"neighbors","items":[%s]})", items.c_str());
}

void print_directory(Out &out, const fr::net::Net &net)
{
    const fr::net::Directory &d = net.directory();
    const auto end = d.entries.begin() + static_cast<std::ptrdiff_t>(std::min(d.count, d.entries.size()));
    std::vector<fr::net::DirEntry> sorted(d.entries.begin(), end);
    std::sort(sorted.begin(), sorted.end(), [](const fr::net::DirEntry &a, const fr::net::DirEntry &b) { return a.addr < b.addr; });
    std::string items;
    for (const fr::net::DirEntry &e : sorted) {
        items += sformat(R"(%s{"addr":%u,"mac":"%s"})", items.empty() ? "" : ",", unsigned{e.addr}, hex(e.mac).c_str());
    }
    out.emit(R"({"ev":"directory","items":[%s]})", items.c_str());
}

}  // namespace frsim
