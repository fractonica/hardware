#include "fr/diag.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "cJSON.h"
#include "catalog.hpp"
#include "diag.hpp"  // generated fr::cap::Diag (mark event)
#include "diag_json.hpp"
#include "esp_app_desc.h"
#include "esp_chip_info.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "fr/envelope.hpp"
#include "fr/serial.hpp"
#include "fr/serial_line.hpp"
#include "sdkconfig.h"

namespace fr::diag {
namespace {

constexpr size_t kMaxIdDigits = 8;
constexpr size_t kMaxToken = 32;  // diag.mark token max (diag.cap.yaml)
// cJSON may need a few bytes more than the final text while printing; render() keeps them in reserve.
constexpr size_t kSlack = 5;

/** A failed request: an error code from the table in 09 §9.7 plus an optional human detail. */
struct Fail {
    const char *error = nullptr;
    const char *detail = nullptr;

    explicit operator bool() const { return error != nullptr; }
};

constexpr Fail ok{};

// Details naming an instance or tag are formatted here (core task only, one request at a time).
char s_detail[64];

Fail fail(const char *error, const char *detail = nullptr)
{
    return {error, detail};
}

/** "<what> '<name>'" as the detail. */
Fail fail_named(const char *error, const char *what, std::string_view name)
{
    std::snprintf(s_detail, sizeof(s_detail), "%s '%.*s'", what, static_cast<int>(name.size()), name.data());
    return {error, s_detail};
}

uint32_t s_calls = 0;  // diag call/inject dispatches, reported in `cmds` next to the CMD envelopes

std::string_view trim(std::string_view s)
{
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) {
        s.remove_prefix(1);
    }
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) {
        s.remove_suffix(1);
    }
    return s;
}

/** Splits off the first space-separated word. */
std::string_view next_word(std::string_view &s)
{
    s = trim(s);
    size_t sp = s.find(' ');
    std::string_view w = s.substr(0, sp);
    s = sp == std::string_view::npos ? std::string_view{} : trim(s.substr(sp));
    return w;
}

/** NUL-terminated copy for the C APIs; false if it does not fit. */
template <size_t N>
bool copy_cstr(std::string_view s, char (&out)[N])
{
    if (s.size() >= N) {
        return false;
    }
    std::memcpy(out, s.data(), s.size());
    out[s.size()] = '\0';
    return true;
}

const PortInfo *find_instance(Host &host, std::string_view name)
{
    for (const PortInfo &p : host.ports()) {
        if (name == p.name) {
            return &p;
        }
    }
    return nullptr;
}

bool is_board_port(unsigned port)
{
    return port >= 1 && port <= 239;
}

/** A decimal board port, 1-239. */
bool parse_board_port(std::string_view s, uint8_t &out)
{
    unsigned v = 0;
    auto [end, ec] = std::from_chars(s.data(), s.data() + s.size(), v);
    if (ec != std::errc{} || end != s.data() + s.size() || !is_board_port(v)) {
        return false;
    }
    out = static_cast<uint8_t>(v);
    return true;
}

// ---- info, caps ----

void add_ip(cJSON *obj, const char *key, const uint8_t (&ip)[4])
{
    char text[16];
    std::snprintf(text, sizeof(text), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
    cJSON_AddStringToObject(obj, key, text);
}

/** `info` (09 §9.7 planned addition): hub link states, the hub address and the Wi-Fi association. */
void add_link_states(cJSON *res, const NetStatus &n)
{
    cJSON *links = cJSON_AddObjectToObject(res, "links");
    for (size_t i = 0; i < kLinks; ++i) {
        const LinkStatus &l = n.links[i];
        cJSON *o = cJSON_AddObjectToObject(links, kLinkNames[i]);
        cJSON_AddBoolToObject(o, "up", l.up);
        if (i == kLinkEspnow) {
            // node <-> node: no hub session on it; the channel it lives on and its unicast peers instead.
            cJSON_AddNumberToObject(o, "ch", n.espnow.channel);
            cJSON_AddNumberToObject(o, "peers", n.espnow.peers);
            continue;
        }
        if (i == kLinkUdp) {
            cJSON_AddBoolToObject(o, "ok", l.udp_ok);  // UDP rides the TCP session; udp_ok is its state
        } else {
            cJSON_AddBoolToObject(o, "session", l.session);
            cJSON_AddBoolToObject(o, "synced", l.time_synced);
        }
    }
    cJSON *hub = cJSON_AddObjectToObject(res, "hub");
    cJSON_AddBoolToObject(hub, "link", n.hub_link);
    cJSON_AddNumberToObject(hub, "epoch", n.hub_epoch);
    cJSON_AddStringToObject(hub, "host", n.hub_host);
    add_ip(hub, "ip", n.hub_ip);
    cJSON *wifi = cJSON_AddObjectToObject(res, "wifi");
    cJSON_AddBoolToObject(wifi, "up", n.wifi_up);
    if (n.wifi_started) {
        char bssid[18];
        std::snprintf(bssid, sizeof(bssid), "%02x:%02x:%02x:%02x:%02x:%02x", n.bssid[0], n.bssid[1], n.bssid[2],
                      n.bssid[3], n.bssid[4], n.bssid[5]);
        cJSON_AddStringToObject(wifi, "ssid", n.ssid);
        cJSON_AddNumberToObject(wifi, "ch", n.channel);
        cJSON_AddStringToObject(wifi, "bssid", bssid);
        cJSON_AddNumberToObject(wifi, "rssi", n.rssi);
        add_ip(wifi, "ip", n.ip);
        cJSON_AddBoolToObject(wifi, "override", n.net_override);
        if (n.net_trial) {
            cJSON_AddBoolToObject(wifi, "trial", true);
        }
    }
    if (n.hub_link_dropped || n.udp_blocked || n.ip_blocked || n.wifi_held || n.loss_pct != 0) {
        cJSON *hooks = cJSON_AddObjectToObject(res, "hooks");
        cJSON_AddBoolToObject(hooks, "drop_hub_link", n.hub_link_dropped);
        cJSON_AddBoolToObject(hooks, "udp_block", n.udp_blocked);
        cJSON_AddBoolToObject(hooks, "ip_block", n.ip_blocked);
        cJSON_AddBoolToObject(hooks, "wifi_down", n.wifi_held);
        if (n.wifi_held) {
            cJSON_AddNumberToObject(hooks, "wifi_down_s", n.wifi_held_s);  // seconds left
        }
        if (n.loss_pct != 0) {
            // design c6 D21: `net loss` in force, with the seconds it has left.
            cJSON *loss = cJSON_AddObjectToObject(hooks, "loss");
            cJSON_AddNumberToObject(loss, "pct", n.loss_pct);
            cJSON_AddStringToObject(loss, "dir", loss_dir_name(static_cast<LossDir>(n.loss_dir)));
            cJSON_AddNumberToObject(loss, "s_left", n.loss_s);
        }
    }
}

Fail cmd_info(std::string_view, Host &host, cJSON *res, size_t)
{
    const fr_identity_t &id = host.identity();
    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    cJSON_AddStringToObject(res, "id", id.device_id);
    cJSON_AddStringToObject(res, "alias", id.alias);
    cJSON_AddNumberToObject(res, "addr", id.addr);
    cJSON_AddStringToObject(res, "state", fr_id_state_name(id.state));
    cJSON_AddNumberToObject(res, "epoch", id.epoch);
    cJSON_AddStringToObject(res, "chip", CONFIG_IDF_TARGET);
    cJSON_AddNumberToObject(res, "chip_rev", chip.revision);
    cJSON_AddStringToObject(res, "board", id.board);
    cJSON_AddStringToObject(res, "profile", id.profile);
    cJSON_AddStringToObject(res, "part", CONFIG_FR_PART_PROFILE);
    cJSON_AddStringToObject(res, "app", app->project_name);
    cJSON_AddStringToObject(res, "ver", app->version);
    cJSON_AddStringToObject(res, "fw_id", host.fw_id());
    cJSON_AddStringToObject(res, "idf", app->idf_ver);
    cJSON_AddNumberToObject(res, "uptime_ms", static_cast<double>(esp_timer_get_time() / 1000));
    cJSON_AddNumberToObject(res, "heap", esp_get_free_heap_size());
    cJSON_AddStringToObject(res, "reset", reset_reason());
    cJSON_AddStringToObject(res, "slot", running != nullptr ? running->label : "?");
    cJSON_AddBoolToObject(res, "inject_enabled", FR_TEST_HOOKS != 0);
    cJSON_AddNumberToObject(res, "test_pin", host.test_pin());  // design c6 D24: -1 without one
    add_link_states(res, host.net_status());
    return ok;
}

/**
 * Traits as JSON, from the descriptor bytes through the generated printer. Bytes it refuses (a value
 * outside the schema, which only a driver bug produces) are shown as hex, so `caps` still answers.
 */
cJSON *traits_json(const cap::Capability &c)
{
    uint8_t buf[32];
    wire::Writer w(buf, sizeof(buf));
    c.encode_traits(w);
    cJSON *t = w.overflow() ? nullptr : cap::traits_to_json(c.cap_id(), w.bytes());
    if (t != nullptr) {
        return t;
    }
    char hex[2 * sizeof(buf) + 1] = "";
    for (size_t i = 0; i < w.size() && !w.overflow(); ++i) {
        std::snprintf(hex + 2 * i, 3, "%02x", buf[i]);
    }
    t = cJSON_CreateObject();
    cJSON_AddStringToObject(t, "hex", hex);
    return t;
}

cJSON *cap_entry(const PortInfo &p)
{
    cJSON *c = cJSON_CreateObject();
    cap::Version v = p.cap->version();
    char ver[8];
    std::snprintf(ver, sizeof(ver), "%u.%u", v.major, v.minor);
    cJSON_AddNumberToObject(c, "port", p.port);
    cJSON_AddStringToObject(c, "name", p.name);
    cJSON_AddStringToObject(c, "cap", p.cap->type_name());
    cJSON_AddNumberToObject(c, "cap_id", p.cap->cap_id());
    cJSON_AddStringToObject(c, "v", ver);
    cJSON_AddItemToObject(c, "traits", traits_json(*p.cap));
    cJSON_AddBoolToObject(c, "ok", p.ok);
    return c;
}

/** The board port with a capability that comes next after `after` in port order; nullptr when none. */
const PortInfo *next_board_port(Host &host, unsigned after)
{
    const PortInfo *best = nullptr;
    for (const PortInfo &p : host.ports()) {
        if (is_board_port(p.port) && p.cap != nullptr && p.port > after &&
            (best == nullptr || p.port < best->port)) {
            best = &p;
        }
    }
    return best;
}

/** Length of `item` printed unformatted; SIZE_MAX when it cannot be printed (out of memory). */
size_t printed_size(cJSON *item)
{
    static char buf[512];  // core task only; one entry is at most about 350 characters
    if (!cJSON_PrintPreallocated(item, buf, sizeof(buf), false)) {
        return SIZE_MAX;
    }
    return std::strlen(buf);
}

/**
 * `caps [<from_port>]`: the board ports from `from_port` on (default 1), in port order. 16 instances
 * can need more than one response line (2048 characters, protocol-wide), so when the rest does not fit
 * the answer holds the entries that do plus `next`, the port to continue from; no `next`, no more.
 */
Fail cmd_caps(std::string_view args, Host &host, cJSON *res, size_t room)
{
    std::string_view from_arg = next_word(args);
    uint8_t from = 1;
    if (!args.empty() || (!from_arg.empty() && !parse_board_port(from_arg, from))) {
        return fail("invalid_args", "usage: caps [from_port]");
    }
    // The answer without entries, with the `next` it may need: {"ok":true,"caps":[],"next":239}.
    size_t used = sizeof(R"({"ok":true,"caps":[],"next":239})") - 1;
    cJSON *caps = cJSON_AddArrayToObject(res, "caps");
    bool any = false;
    for (const PortInfo *p = next_board_port(host, from - 1u); p != nullptr; p = next_board_port(host, p->port)) {
        cJSON *c = cap_entry(*p);
        size_t len = printed_size(c);
        // The first entry always goes in, so every page makes progress (render() reports it if even
        // that is too long).
        if (any && (len == SIZE_MAX || used + 1 + len > room)) {
            cJSON_Delete(c);
            cJSON_AddNumberToObject(res, "next", p->port);
            break;
        }
        cJSON_AddItemToArray(caps, c);
        used += (any ? 1 : 0) + (len == SIZE_MAX ? 0 : len);
        any = true;
    }
    return ok;
}

// ---- call, inject ----

#if FR_TEST_HOOKS
const char *status_name(const Status &st)
{
    return st ? "ok" : err_name(st.error());
}

/** Runs `cmd` of `inst` through the generated dispatch, as a CMD from the hub would; takes `args`. */
Fail run_call(Host &host, std::string_view inst, std::string_view cmd, cJSON *args, cJSON *res)
{
    const PortInfo *p = find_instance(host, inst);
    char cmd_name[32];
    if (p == nullptr || p->cap == nullptr) {
        cJSON_Delete(args);
        return fail_named("not_found", "no instance", inst);
    }
    if (!copy_cstr(cmd, cmd_name)) {
        cJSON_Delete(args);
        return fail("unsupported", "unknown command");
    }
    uint8_t buf[cap::Reply::kRealtimeCapacity];
    wire::Writer w(buf, sizeof(buf));
    uint8_t cmd_id = 0;
    Status enc = cap::encode_args_json(p->cap->cap_id(), cmd_name, args, &cmd_id, w);
    cJSON_Delete(args);
    if (!enc) {
        return fail_named(err_name(enc.error()), "cannot encode arguments of", cmd);
    }
    if (w.overflow()) {
        return fail("invalid_args", "arguments too long");
    }

    ++s_calls;
    cap::StaticReply<> reply;
    Status st = p->ok ? p->cap->dispatch(cmd_id, w.bytes(), reply) : Status{std::unexpected(Err::failed)};
    cJSON_AddStringToObject(res, "status", status_name(st));
    cJSON *fields = st ? cap::decode_to_json(p->cap->cap_id(), wire::kClsResult, cmd_id, reply.bytes()) : nullptr;
    cJSON_AddItemToObject(res, "fields", fields != nullptr ? fields : cJSON_CreateObject());
    return ok;
}

Fail cmd_call(std::string_view args, Host &host, cJSON *res, size_t)
{
    std::string_view target = next_word(args);
    size_t dot = target.find('.');
    if (dot == std::string_view::npos || dot == 0 || dot + 1 == target.size()) {
        return fail("invalid_args", "usage: call <inst>.<cmd> [json]");
    }
    cJSON *json = nullptr;
    if (!args.empty()) {
        // Not cJSON_ParseWithLength: a string holding U+0000 would reach the codecs cut short.
        json = cap::parse_args_json(args);
        if (json == nullptr) {
            return fail("invalid_args", "arguments are not JSON or hold U+0000");
        }
    }
    return run_call(host, target.substr(0, dot), target.substr(dot + 1), json, res);
}

Fail cmd_inject(std::string_view args, Host &host, cJSON *res, size_t)
{
    std::string_view inst = next_word(args);
    std::string_view gesture = next_word(args);
    char g[24];
    if (inst.empty() || gesture.empty() || !args.empty() || !copy_cstr(gesture, g)) {
        return fail("invalid_args", "usage: inject <inst> <gesture>");
    }
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "gesture", g);
    return run_call(host, inst, "inject", json, res);
}
#else
Fail cmd_call(std::string_view, Host &, cJSON *, size_t)
{
    return fail("unsupported", "test hooks are off in this build");
}

Fail cmd_inject(std::string_view, Host &, cJSON *, size_t)
{
    return fail("unsupported", "test hooks are off in this build");
}
#endif

// ---- selftest, mark, log, stats, reboot ----

Fail cmd_selftest(std::string_view args, Host &host, cJSON *res, size_t)
{
    std::string_view only = next_word(args);
    if (!only.empty() && find_instance(host, only) == nullptr) {
        return fail_named("not_found", "no instance", only);
    }
    cJSON *results = cJSON_AddArrayToObject(res, "results");
    for (const PortInfo &p : host.ports()) {
        if (!is_board_port(p.port) || (!only.empty() && only != p.name)) {
            continue;
        }
        SelftestResult r{false, "no self-test"};
        host.selftest(p.name, r);
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "name", p.name);
        cJSON_AddBoolToObject(item, "ok", r.ok);
        cJSON_AddStringToObject(item, "detail", r.detail != nullptr ? r.detail : "");
        cJSON_AddItemToArray(results, item);
    }
    return ok;
}

Fail cmd_mark(std::string_view args, Host &host, cJSON *, size_t)
{
    std::string_view token = trim(args);
    if (token.empty() || token.size() > kMaxToken ||
        !wire::utf8_valid({reinterpret_cast<const uint8_t *>(token.data()), token.size()})) {
        return fail("invalid_args", "usage: mark <token> (1-32 bytes)");
    }
    uint8_t buf[cap::DiagMark::kMaxSize];
    wire::Writer w(buf, sizeof(buf));
    cap::encode(cap::DiagMark{.token = token}, w);
    host.sink().event(kPortDiag, cap::Diag::kEventMark, cap::Priority::normal, w.bytes(), cap::kNowUs);
    return ok;
}

bool parse_level(std::string_view s, esp_log_level_t &out)
{
    static constexpr struct {
        const char *name;
        esp_log_level_t level;
    } kLevels[] = {
        {"none", ESP_LOG_NONE}, {"error", ESP_LOG_ERROR}, {"warn", ESP_LOG_WARN},
        {"info", ESP_LOG_INFO}, {"debug", ESP_LOG_DEBUG}, {"verbose", ESP_LOG_VERBOSE},
        {"N", ESP_LOG_NONE},    {"E", ESP_LOG_ERROR},     {"W", ESP_LOG_WARN},
        {"I", ESP_LOG_INFO},    {"D", ESP_LOG_DEBUG},     {"V", ESP_LOG_VERBOSE},
    };
    for (const auto &l : kLevels) {
        if (s == l.name) {
            out = l.level;
            return true;
        }
    }
    return false;
}

Fail cmd_log(std::string_view args, Host &, cJSON *res, size_t)
{
    std::string_view tag = next_word(args);
    std::string_view level = next_word(args);
    char t[32];
    esp_log_level_t lvl;
    if (tag.empty() || !args.empty() || !copy_cstr(tag, t) || !parse_level(level, lvl)) {
        return fail("invalid_args", "usage: log <tag|*> <none|error|warn|info|debug|verbose>");
    }
    esp_log_level_set(t, lvl);
    cJSON_AddStringToObject(res, "tag", t);
    cJSON_AddNumberToObject(res, "level", lvl);
    return ok;
}

/** True when `json` prints within `room` characters (render()'s limit for the answer). Core task only. */
bool fits(cJSON *json, size_t room)
{
    static char scratch[wire::kMaxLine];
    return room + 1 <= sizeof(scratch) && cJSON_PrintPreallocated(json, scratch, static_cast<int>(room + 1), false);
}

/**
 * `stats` sections (09 §9.7, design c5 §2): `stats <section>` answers one alone. A full answer that would not
 * fit its channel (fr.diag.exec's 1,400 B, with every C5 counter and long topic names) first folds msgs into
 * `{"other": <all>}` (`msgs_folded`), then drops whole sections from the end of this list, each named in
 * `omitted`, so a Wi-Fi-only node always answers; the dropped ones are a `stats <section>` away.
 */
constexpr std::string_view kStatSections[] = {"links", "bcast", "relay", "espnow", "bindings", "nodes", "msgs"};
constexpr size_t kStatSectionCount = sizeof(kStatSections) / sizeof(kStatSections[0]);

/** The index of `name` in kStatSections, or kStatSectionCount. */
size_t stat_section(std::string_view name)
{
    size_t i = 0;
    while (i < kStatSectionCount && kStatSections[i] != name) {
        ++i;
    }
    return i;
}

/** Adds section `i` of kStatSections: hub link counters (C3) or a C5 group (espnow: the driver's frames on
 * the air; nodes: node <-> node frames by path). */
void add_stat_section(cJSON *res, size_t i, const NetStatus &n)
{
    const std::string_view name = kStatSections[i];
    cJSON *o = cJSON_AddObjectToObject(res, name.data());  // the names are literals: NUL-terminated
    if (name == "links") {
        // Per boot, kept across hub-link drops (09 §9.7).
        for (size_t k = 0; k < kLinks; ++k) {
            const LinkStatus &l = n.links[k];
            cJSON *lo = cJSON_AddObjectToObject(o, kLinkNames[k]);
            cJSON_AddNumberToObject(lo, "tx", l.tx);
            cJSON_AddNumberToObject(lo, "tx_fail", l.tx_fail);
            cJSON_AddNumberToObject(lo, "rx", l.rx);
            cJSON_AddNumberToObject(lo, "rx_drop", l.rx_drop);
            cJSON_AddNumberToObject(lo, "retries", l.retries);
        }
    } else if (name == "bcast") {
        cJSON_AddNumberToObject(o, "delivered", n.bcast.delivered);
        cJSON_AddNumberToObject(o, "dup", n.bcast.dup);
        cJSON_AddNumberToObject(o, "old", n.bcast.old);
        cJSON_AddNumberToObject(o, "watermark", n.bcast.watermark);
    } else if (name == "relay") {
        cJSON_AddNumberToObject(o, "seeded", n.relay.seeded);
        cJSON_AddNumberToObject(o, "relayed", n.relay.relayed);
        cJSON_AddNumberToObject(o, "cancelled", n.relay.cancelled);
        cJSON_AddNumberToObject(o, "dropped", n.relay.dropped);
    } else if (name == "espnow") {
        const EspnowStatus &a = n.espnow;
        cJSON_AddNumberToObject(o, "tx", a.tx);
        cJSON_AddNumberToObject(o, "tx_fail", a.tx_fail);
        cJSON_AddNumberToObject(o, "retries", a.retries);
        cJSON_AddNumberToObject(o, "refused", a.refused);
        cJSON_AddNumberToObject(o, "rx", a.rx);
        cJSON_AddNumberToObject(o, "rx_bad", a.rx_bad);
        cJSON_AddNumberToObject(o, "rx_lost", a.rx_lost);
        cJSON_AddNumberToObject(o, "peers", a.peers);
        if (a.rate_fail != 0) {
            cJSON_AddNumberToObject(o, "rate_fail", a.rate_fail);
        }
        if (a.guard != 0) {  // late send callbacks (design c5 §3 driver): shown only once they happen
            cJSON_AddNumberToObject(o, "guard", a.guard);
            cJSON_AddNumberToObject(o, "lost", a.lost);
        }
    } else if (name == "bindings") {
        cJSON_AddNumberToObject(o, "fired", n.bindings.fired);
        cJSON_AddNumberToObject(o, "failed", n.bindings.failed);
        cJSON_AddNumberToObject(o, "rtt_p50_us", n.bindings.rtt_p50_us);
    } else if (name == "nodes") {
        cJSON_AddNumberToObject(o, "delivered", n.nodes.delivered);
        cJSON_AddNumberToObject(o, "dup", n.nodes.dup);
        cJSON_AddNumberToObject(o, "old", n.nodes.old);
        cJSON_AddNumberToObject(o, "sent", n.nodes.sent);
        cJSON_AddNumberToObject(o, "via_espnow", n.nodes.via_espnow);
        cJSON_AddNumberToObject(o, "via_hub", n.nodes.via_hub);
        cJSON_AddNumberToObject(o, "via_flood", n.nodes.via_flood);
        cJSON_AddNumberToObject(o, "failed", n.nodes.failed);
        cJSON_AddNumberToObject(o, "resolves", n.nodes.resolves);
    } else {  // msgs: per topic, the first kMsgTopics seen, then `other`
        for (const MsgTopicCount &t : n.msgs) {
            if (t.name[0] != '\0') {
                cJSON_AddNumberToObject(o, t.name, t.n);
            }
        }
        cJSON_AddNumberToObject(o, "other", n.msgs_other);
    }
}

/** Shrinks a full `stats` answer until it prints within `room` (kStatSections). Core task only. */
void fit_stats(cJSON *res, const NetStatus &n, size_t room)
{
    if (fits(res, room)) {
        return;
    }
    uint32_t all = n.msgs_other;
    for (const MsgTopicCount &t : n.msgs) {
        all += t.name[0] != '\0' ? t.n : 0;
    }
    cJSON_DeleteItemFromObject(res, "msgs");
    cJSON_AddNumberToObject(cJSON_AddObjectToObject(res, "msgs"), "other", all);
    cJSON_AddBoolToObject(res, "msgs_folded", true);
    cJSON *omitted = nullptr;
    for (size_t i = kStatSectionCount; i-- > 0 && !fits(res, room);) {
        if (omitted == nullptr) {
            omitted = cJSON_AddArrayToObject(res, "omitted");
        }
        if (kStatSections[i] == "msgs") {
            cJSON_DeleteItemFromObject(res, "msgs_folded");
        }
        cJSON_DeleteItemFromObject(res, kStatSections[i].data());
        cJSON_AddItemToArray(omitted, cJSON_CreateString(kStatSections[i].data()));
    }
}

Fail cmd_stats(std::string_view args, Host &host, cJSON *res, size_t room)
{
    std::string_view opt = next_word(args);
    const size_t section = stat_section(opt);
    if (!args.empty() || (!opt.empty() && opt != "reset" && section == kStatSectionCount)) {
        return fail("invalid_args", "usage: stats [reset|links|bcast|relay|espnow|bindings|nodes|msgs]");
    }
    NetStatus n = host.net_status();
    if (section != kStatSectionCount) {
        add_stat_section(res, section, n);
        return ok;
    }
    serial::Stats s = serial::stats();
    RuntimeStats r = host.runtime_stats();
    cJSON_AddNumberToObject(res, "frames_tx", s.frames_tx);
    cJSON_AddNumberToObject(res, "frames_dropped", s.frames_dropped);
    cJSON_AddNumberToObject(res, "logs_dropped", s.logs_dropped);
    cJSON_AddNumberToObject(res, "lines_discarded", s.lines_discarded);
    cJSON_AddNumberToObject(res, "rx_frames", s.rx_frames);
    cJSON_AddNumberToObject(res, "rx_bad", s.rx_bad);
    cJSON_AddNumberToObject(res, "cmds", r.cmds + s_calls);
    cJSON_AddNumberToObject(res, "env_ignored", r.env_ignored);
    cJSON_AddNumberToObject(res, "env_bad", r.env_bad);
    cJSON_AddNumberToObject(res, "rx_dropped", r.rx_dropped);
    cJSON_AddNumberToObject(res, "posts_dropped", r.posts_dropped);
    // Hub link counters (09 §9.7: per boot, kept across hub-link drops).
    add_stat_section(res, 0, n);
    cJSON_AddNumberToObject(res, "events_dropped", n.events_dropped);
    cJSON_AddNumberToObject(res, "delivery_failed", n.delivery_failed);
    cJSON_AddNumberToObject(res, "cmds_refused", n.cmds_refused);
    cJSON_AddNumberToObject(res, "dup", n.dup);
    cJSON_AddNumberToObject(res, "old", n.old);
    cJSON_AddNumberToObject(res, "cached_replies", n.cached_replies);
    cJSON_AddNumberToObject(res, "sessions_lost", n.sessions_lost);
    cJSON_AddNumberToObject(res, "sessions_timed_out", n.sessions_timed_out);
    cJSON_AddNumberToObject(res, "wifi_disconnects", n.wifi_disconnects);
    cJSON_AddNumberToObject(res, "wifi_last_reason", n.wifi_last_reason);
    cJSON_AddNumberToObject(res, "tcp_connects", n.tcp_connects);
    cJSON_AddNumberToObject(res, "tcp_closes", n.tcp_closes);
    // Why each close happened (09 §9.7 diagnosis of a reconnect; the log has one line per close).
    cJSON_AddNumberToObject(res, "tcp_close_peer", n.tcp_close_peer);
    cJSON_AddNumberToObject(res, "tcp_close_keepalive", n.tcp_close_keepalive);
    cJSON_AddNumberToObject(res, "tcp_close_error", n.tcp_close_error);
    cJSON_AddNumberToObject(res, "tcp_close_session", n.tcp_close_session);
    cJSON_AddNumberToObject(res, "tcp_close_wifi", n.tcp_close_wifi);
    cJSON_AddNumberToObject(res, "tcp_last_errno", n.tcp_last_errno);
    cJSON_AddNumberToObject(res, "tcp_tx_dropped", n.tcp_tx_dropped);
    cJSON_AddNumberToObject(res, "tcp_rx_bad", n.tcp_rx_bad);
    cJSON_AddNumberToObject(res, "udp_tx_fail", n.udp_tx_fail);
    cJSON_AddNumberToObject(res, "hook_dropped", n.hook_dropped);
    // design c6 D21-D23: what `net loss` dropped, exec_at's table, and the link task -> core task wait.
    cJSON_AddNumberToObject(res, "loss_tx", n.loss_tx);
    cJSON_AddNumberToObject(res, "loss_rx", n.loss_rx);
    cJSON_AddNumberToObject(res, "cmds_scheduled", n.cmds_scheduled);
    cJSON_AddNumberToObject(res, "exec_late", n.exec_late);
    cJSON_AddNumberToObject(res, "exec_cancelled", n.exec_cancelled);
    cJSON_AddNumberToObject(res, "exec_late_us_max", n.exec_late_us_max);
    cJSON_AddNumberToObject(res, "rx_queue_us_max", n.rx_queue_us_max);
    for (size_t i = 1; i < kStatSectionCount; ++i) {
        add_stat_section(res, i, n);
    }
    fit_stats(res, n, room);
    if (opt == "reset") {
        // The response carries the counts that were cleared (those of `omitted` sections are gone unread).
        serial::reset_stats();
        host.reset_runtime_stats();
        s_calls = 0;
    }
    return ok;
}

/**
 * `neighbors [from]` (design c5 §2): the ESP-NOW neighbour table, sorted by MAC, from index `from` (default
 * 0). Twenty entries can exceed fr.diag.exec's 1,400 B, so as `caps` does, the answer holds the entries that
 * fit plus `next`, the index to continue from; no `next`, no more.
 */
Fail cmd_neighbors(std::string_view args, Host &host, cJSON *res, size_t room)
{
    std::string_view from_arg = next_word(args);
    unsigned from = 0;
    if (!args.empty()) {
        return fail("invalid_args", "usage: neighbors [from]");
    }
    if (!from_arg.empty()) {
        auto [end, ec] = std::from_chars(from_arg.data(), from_arg.data() + from_arg.size(), from);
        if (ec != std::errc{} || end != from_arg.data() + from_arg.size() || from > kNeighborsMax) {
            return fail("invalid_args", "usage: neighbors [from] (0-20)");
        }
    }
    NeighborInfo nb[kNeighborsMax];
    const size_t count = std::min(host.neighbors(nb), kNeighborsMax);
    std::sort(nb, nb + count,
              [](const NeighborInfo &a, const NeighborInfo &b) { return std::memcmp(a.mac, b.mac, sizeof(a.mac)) < 0; });
    cJSON_AddNumberToObject(res, "count", static_cast<double>(count));
    // The answer without entries, with the `next` it may need.
    size_t used = sizeof(R"({"ok":true,"count":20,"neighbors":[],"next":19})") - 1;
    cJSON *list = cJSON_AddArrayToObject(res, "neighbors");
    bool any = false;
    for (size_t i = from; i < count; ++i) {
        const NeighborInfo &e = nb[i];
        char mac[13];
        std::snprintf(mac, sizeof(mac), "%02x%02x%02x%02x%02x%02x", e.mac[0], e.mac[1], e.mac[2], e.mac[3], e.mac[4],
                      e.mac[5]);
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "mac", mac);
        cJSON_AddNumberToObject(o, "addr", e.addr);
        cJSON_AddNumberToObject(o, "rssi", e.rssi);
        cJSON_AddNumberToObject(o, "age_ms", e.age_ms);
        cJSON_AddNumberToObject(o, "ack_ok", e.ack_ok);
        cJSON_AddNumberToObject(o, "ack_fail", e.ack_fail);
        size_t len = printed_size(o);
        if (any && (len == SIZE_MAX || used + 1 + len > room)) {
            cJSON_Delete(o);
            cJSON_AddNumberToObject(res, "next", static_cast<double>(i));
            break;
        }
        cJSON_AddItemToArray(list, o);
        used += (any ? 1 : 0) + (len == SIZE_MAX ? 0 : len);
        any = true;
    }
    return ok;
}

Fail cmd_reboot(std::string_view args, Host &host, cJSON *, size_t)
{
    std::string_view opt = next_word(args);
    bool bootloader = opt == "bootloader";
    if ((!opt.empty() && !bootloader) || !args.empty()) {
        return fail("invalid_args", "usage: reboot [bootloader]");
    }
    if (bootloader && !can_enter_bootloader()) {
        return fail("unsupported", "no download-mode reset on this target");
    }
    host.reboot(bootloader);
    return ok;
}

// ---- net (debug hooks), pin_pulse ----

#if FR_TEST_HOOKS
constexpr uint32_t kMaxHookSeconds = 86400;

/** A decimal in lo..hi, the whole word. */
bool parse_uint(std::string_view s, uint32_t lo, uint32_t hi, uint32_t &out)
{
    uint32_t v = 0;
    auto [end, ec] = std::from_chars(s.data(), s.data() + s.size(), v);
    if (s.empty() || ec != std::errc{} || end != s.data() + s.size() || v < lo || v > hi) {
        return false;
    }
    out = v;
    return true;
}

/** `net loss <pct> <s> [both|tx|rx]` (design c6 D21, T-INPUT). */
Fail cmd_net_loss(std::string_view args, Host &host, cJSON *res)
{
    std::string_view pct_arg = next_word(args);
    std::string_view secs_arg = next_word(args);
    std::string_view dir_arg = next_word(args);
    uint32_t pct = 0;
    uint32_t s = 0;
    LossDir dir = LossDir::both;
    if (dir_arg == "tx") {
        dir = LossDir::tx;
    } else if (dir_arg == "rx") {
        dir = LossDir::rx;
    } else if (!dir_arg.empty() && dir_arg != "both") {
        dir_arg = "?";
    }
    if (!parse_uint(pct_arg, 0, 100, pct) || !parse_uint(secs_arg, 0, kMaxHookSeconds, s) || dir_arg == "?" ||
        !args.empty()) {
        return fail("invalid_args", "usage: net loss <pct 0-100> <seconds 0-86400> [both|tx|rx] (0 ends it)");
    }
    Status st = host.net_loss(static_cast<uint8_t>(pct), s, dir);
    if (!st) {
        return fail(err_name(st.error()));
    }
    cJSON_AddStringToObject(res, "hook", "loss");
    cJSON_AddNumberToObject(res, "pct", pct);
    cJSON_AddNumberToObject(res, "s", s);
    cJSON_AddStringToObject(res, "dir", loss_dir_name(dir));
    return ok;
}
#endif

Fail cmd_net(std::string_view args, Host &host, cJSON *res, size_t)
{
#if FR_TEST_HOOKS
    constexpr uint32_t kMaxSeconds = kMaxHookSeconds;
    std::string_view name = next_word(args);
    if (name == "loss") {
        return cmd_net_loss(args, host, res);
    }
    std::string_view secs = next_word(args);
    NetHook hook;
    if (name == "drop_hub_link") {
        hook = NetHook::drop_hub_link;
    } else if (name == "udp_block") {
        hook = NetHook::udp_block;
    } else if (name == "ip_block") {
        hook = NetHook::ip_block;
    } else if (name == "wifi_down") {
        hook = NetHook::wifi_down;
    } else {
        return fail("invalid_args", "usage: net drop_hub_link|udp_block|ip_block|wifi_down <seconds> | "
                                    "loss <pct> <seconds> [both|tx|rx]");
    }
    uint32_t s = 0;
    auto [end, ec] = std::from_chars(secs.data(), secs.data() + secs.size(), s);
    if (secs.empty() || ec != std::errc{} || end != secs.data() + secs.size() || s > kMaxSeconds || !args.empty()) {
        return fail("invalid_args",
                    "usage: net drop_hub_link|udp_block|ip_block|wifi_down <seconds> (0-86400; 0 ends it)");
    }
    Status st = host.net_hook(hook, s);
    if (!st) {
        return fail(err_name(st.error()));
    }
    cJSON_AddStringToObject(res, "hook", hook_name(hook));
    cJSON_AddNumberToObject(res, "s", s);
    return ok;
#else
    (void)args;
    (void)host;
    (void)res;
    return fail("unsupported", "test hooks are off in this build");
#endif
}

/**
 * `pin_pulse <us>` (design c6 D24, T-LAT): drives the board's test_pin low for 10-100000 µs, open-drain, and
 * answers when it went low (`at_us`, esp_timer µs of the falling edge) as soon as it did; the release follows
 * from a one-shot timer. `busy` while a pulse runs.
 */
Fail cmd_pin_pulse(std::string_view args, Host &host, cJSON *res, size_t)
{
#if FR_TEST_HOOKS
    constexpr uint32_t kMinUs = 10;
    constexpr uint32_t kMaxUs = 100000;
    std::string_view us_arg = next_word(args);
    uint32_t us = 0;
    if (!parse_uint(us_arg, kMinUs, kMaxUs, us) || !args.empty()) {
        return fail("invalid_args", "usage: pin_pulse <us> (10-100000)");
    }
    auto p = host.pin_pulse(us);
    if (!p) {
        return fail(err_name(p.error()), p.error() == Err::unsupported ? "no test_pin on this board" : nullptr);
    }
    cJSON_AddNumberToObject(res, "pin", p->pin);
    cJSON_AddNumberToObject(res, "us", us);
    cJSON_AddNumberToObject(res, "at_us", static_cast<double>(p->at));
    return ok;
#else
    (void)args;
    (void)host;
    (void)res;
    return fail("unsupported", "test hooks are off in this build");
#endif
}

struct Command {
    const char *name;
    /** `room`: characters the response JSON may take (after any `#<id> `), for commands that page. */
    Fail (*run)(std::string_view args, Host &host, cJSON *res, size_t room);
};

constexpr Command kCommands[] = {
    {"info", cmd_info},         {"caps", cmd_caps}, {"call", cmd_call},   {"inject", cmd_inject},
    {"selftest", cmd_selftest}, {"mark", cmd_mark}, {"log", cmd_log},     {"stats", cmd_stats},
    {"reboot", cmd_reboot},     {"net", cmd_net},   {"neighbors", cmd_neighbors},
    {"pin_pulse", cmd_pin_pulse},
};

/** `#<id> ` prefix: 1-8 decimal digits. Returns the id text (empty when absent); false if malformed. */
bool split_id(std::string_view &line, std::string_view &id)
{
    id = {};
    if (line.empty() || line.front() != '#') {
        return true;
    }
    size_t n = 1;
    while (n < line.size() && std::isdigit(static_cast<unsigned char>(line[n]))) {
        ++n;
    }
    size_t digits = n - 1;
    if (digits == 0 || digits > kMaxIdDigits || (n < line.size() && line[n] != ' ')) {
        return false;
    }
    id = line.substr(1, digits);
    line = trim(line.substr(n));
    return true;
}

/** Length of the `#<id> ` prefix (0 without an id). */
size_t id_prefix(std::string_view id)
{
    return id.empty() ? 0 : 2 + id.size();
}

/** The longest JSON text render() can fit after the prefix. */
size_t json_room(std::string_view id, std::span<char> out)
{
    size_t pre = id_prefix(id);
    return out.size() > pre + kSlack + 1 ? out.size() - pre - kSlack - 1 : 0;
}

/** Writes `[#id ]` then the JSON; false if it does not fit. */
bool render(std::string_view id, cJSON *json, std::span<char> out, size_t &len)
{
    size_t pre = id_prefix(id);
    if (!id.empty()) {
        if (pre >= out.size()) {
            return false;
        }
        out[0] = '#';
        std::memcpy(out.data() + 1, id.data(), id.size());
        out[pre - 1] = ' ';
    }
    if (json == nullptr || out.size() < pre + kSlack + 2 ||
        !cJSON_PrintPreallocated(json, out.data() + pre, static_cast<int>(out.size() - pre - kSlack), false)) {
        return false;
    }
    len = pre + std::strlen(out.data() + pre);
    return true;
}

size_t render_error(std::string_view id, const Fail &f, std::span<char> out)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddBoolToObject(j, "ok", false);
    cJSON_AddStringToObject(j, "error", f.error);
    if (f.detail != nullptr) {
        cJSON_AddStringToObject(j, "detail", f.detail);
    }
    size_t len = 0;
    bool done = render(id, j, out, len);
    cJSON_Delete(j);
    if (done) {
        return len;
    }
    // Out of memory or a tiny buffer: a fixed answer the hub can still parse.
    int n = std::snprintf(out.data(), out.size(), "%s%.*s%s{\"ok\":false,\"error\":\"%s\"}", id.empty() ? "" : "#",
                          static_cast<int>(id.size()), id.data(), id.empty() ? "" : " ", "failed");
    return n > 0 ? std::min(static_cast<size_t>(n), out.size() - 1) : 0;
}

}  // namespace

size_t execute(std::string_view line, Host &host, std::span<char> out)
{
    if (out.empty()) {
        return 0;
    }
    line = trim(line);
    if (line.empty()) {
        return 0;
    }
    std::string_view id;
    if (!split_id(line, id)) {
        return render_error({}, fail("invalid_args", "request id is #<1-8 digits>"), out);
    }
    std::string_view args = line;
    std::string_view name = next_word(args);

    const Command *cmd = nullptr;
    for (const Command &c : kCommands) {
        if (name == c.name) {
            cmd = &c;
            break;
        }
    }
    if (cmd == nullptr) {
        return render_error(id, fail("unknown_command"), out);
    }

    cJSON *res = cJSON_CreateObject();
    if (res == nullptr) {
        return render_error(id, fail("failed", "out of memory"), out);
    }
    cJSON_AddBoolToObject(res, "ok", true);
    Fail f = cmd->run(args, host, res, json_room(id, out));
    size_t len = 0;
    if (!f && !render(id, res, out, len)) {
        f = fail("failed", "response too long");
    }
    cJSON_Delete(res);
    return f ? render_error(id, f, out) : len;
}

bool can_enter_bootloader()
{
#if CONFIG_IDF_TARGET_ESP32C3 || CONFIG_IDF_TARGET_ESP32S3 || CONFIG_IDF_TARGET_ESP32C6
    return true;
#else
    return false;
#endif
}

const char *reset_reason()
{
    switch (esp_reset_reason()) {
    case ESP_RST_POWERON:
        return "POWERON";
    case ESP_RST_EXT:
        return "EXT";
    case ESP_RST_SW:
        return "SW";
    case ESP_RST_PANIC:
        return "PANIC";
    case ESP_RST_INT_WDT:
        return "INT_WDT";
    case ESP_RST_TASK_WDT:
        return "TASK_WDT";
    case ESP_RST_WDT:
        return "WDT";
    case ESP_RST_DEEPSLEEP:
        return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:
        return "BROWNOUT";
    case ESP_RST_USB:
        return "USB";
    case ESP_RST_JTAG:
        return "JTAG";
    default:
        return "OTHER";
    }
}

}  // namespace fr::diag
