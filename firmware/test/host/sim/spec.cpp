// The fleet's spec file (design m2-c2 D8): fractonica/fleet-spec@1, as FleetSpecSchema (packages/protocol/src/sim.ts)
// shapes it, read with cJSON (the vendored fr_cjson; no exceptions, so no JSON library that throws). The sim runner
// writes it from a scenario after zod validation, so this checks types and ranges and applies the schema's
// defaults, nothing more.
#include <cmath>

#include "cJSON.h"
#include "sim/node.hpp"

namespace frsim {

namespace {

const cJSON *item(const cJSON *o, const char *key)
{
    return o != nullptr ? cJSON_GetObjectItemCaseSensitive(o, key) : nullptr;
}

bool number(const cJSON *o, const char *key, double &out, double lo, double hi, std::string &error)
{
    const cJSON *v = item(o, key);
    if (v == nullptr) {
        return true;  // the default stays
    }
    if (!cJSON_IsNumber(v) || v->valuedouble < lo || v->valuedouble > hi) {
        error = std::string(key) + ": expected a number in [" + sformat("%g", lo) + ", " + sformat("%g", hi) + "]";
        return false;
    }
    out = v->valuedouble;
    return true;
}

template <class T>
bool integer(const cJSON *o, const char *key, T &out, double lo, double hi, std::string &error)
{
    double d = static_cast<double>(out);
    if (!number(o, key, d, lo, hi, error)) {
        return false;
    }
    if (d != std::floor(d)) {
        error = std::string(key) + ": expected an integer";
        return false;
    }
    out = static_cast<T>(d);
    return true;
}

bool boolean(const cJSON *o, const char *key, bool &out, std::string &error)
{
    const cJSON *v = item(o, key);
    if (v == nullptr) {
        return true;
    }
    if (!cJSON_IsBool(v)) {
        error = std::string(key) + ": expected true or false";
        return false;
    }
    out = cJSON_IsTrue(v);
    return true;
}

bool text(const cJSON *o, const char *key, std::string &out, std::string &error)
{
    const cJSON *v = item(o, key);
    if (v == nullptr) {
        return true;
    }
    if (!cJSON_IsString(v)) {
        error = std::string(key) + ": expected a string";
        return false;
    }
    out = v->valuestring;
    return true;
}

/** `[lo, hi]` with lo <= hi. */
bool range(const cJSON *o, const char *key, double &lo, double &hi, double min, double max, std::string &error)
{
    const cJSON *v = item(o, key);
    if (v == nullptr) {
        return true;
    }
    if (!cJSON_IsArray(v) || cJSON_GetArraySize(v) != 2 || !cJSON_IsNumber(cJSON_GetArrayItem(v, 0)) ||
        !cJSON_IsNumber(cJSON_GetArrayItem(v, 1))) {
        error = std::string(key) + ": expected [lo, hi]";
        return false;
    }
    const double a = cJSON_GetArrayItem(v, 0)->valuedouble;
    const double b = cJSON_GetArrayItem(v, 1)->valuedouble;
    if (a > b || a < min || b > max) {
        error = std::string(key) + ": expected [lo, hi] with lo <= hi within [" + sformat("%g", min) + ", " +
                sformat("%g", max) + "]";
        return false;
    }
    lo = a;
    hi = b;
    return true;
}

bool rate(const cJSON *o, const char *key, Rate &out, std::string &error)
{
    std::string r = out == Rate::r6m ? "6M" : "1M";
    if (!text(o, key, r, error)) {
        return false;
    }
    if (r != "1M" && r != "6M") {
        error = std::string(key) + ": expected 1M or 6M";
        return false;
    }
    out = r == "6M" ? Rate::r6m : Rate::r1m;
    return true;
}

bool parse_medium(const cJSON *m, MediumSpec &out, std::string &error)
{
    if (m == nullptr) {
        return true;
    }
    std::string topo = "one_room";
    if (!text(m, "topology", topo, error)) {
        return false;
    }
    if (topo == "one_room") {
        out.topology = Topology::one_room;
    } else if (topo == "two_rooms") {
        out.topology = Topology::two_rooms;
    } else if (topo == "matrix") {
        out.topology = Topology::matrix;
    } else if (topo == "positions") {
        out.topology = Topology::positions;
    } else {
        error = "medium.topology: expected one_room, two_rooms, matrix or positions";
        return false;
    }
    double rlo = out.rssi_min_dbm;
    double rhi = out.rssi_max_dbm;
    double llo = out.loss_min;
    double lhi = out.loss_max;
    double tlo = out.latency_min_us;
    double thi = out.latency_max_us;
    if (!range(m, "rssi_dbm", rlo, rhi, -100, 0, error) || !number(m, "asymmetry_db", out.asymmetry_db, 0, 20, error) ||
        !number(m, "rssi_sigma_db", out.rssi_sigma_db, 0, 20, error) || !range(m, "loss", llo, lhi, 0, 1, error) ||
        !number(m, "dup", out.dup, 0, 1, error) || !range(m, "latency_us", tlo, thi, 0, 1'000'000, error) ||
        !boolean(m, "collisions", out.collisions, error) || !number(m, "capture_db", out.capture_db, 0, 40, error)) {
        error = "medium." + error;
        return false;
    }
    out.rssi_min_dbm = static_cast<int8_t>(rlo);
    out.rssi_max_dbm = static_cast<int8_t>(rhi);
    out.loss_min = llo;
    out.loss_max = lhi;
    out.latency_min_us = static_cast<uint32_t>(tlo);
    out.latency_max_us = static_cast<uint32_t>(thi);
    if (const cJSON *r = item(m, "rate")) {
        if (!rate(r, "broadcast", out.bcast_rate, error) || !rate(r, "unicast", out.ucast_rate, error)) {
            error = "medium.rate." + error;
            return false;
        }
    }
    if (item(m, "cross_reach") != nullptr) {
        double c = 0;
        if (!number(m, "cross_reach", c, 0, 1, error)) {
            error = "medium." + error;
            return false;
        }
        out.cross_reach = c;
    }
    if (const cJSON *pairs = item(m, "pairs"); cJSON_IsArray(pairs)) {
        for (const cJSON *p = pairs->child; p != nullptr; p = p->next) {
            MediumSpec::PairSpec ps;
            double rssi = ps.rssi_dbm;
            if (!text(p, "tx", ps.tx, error) || !text(p, "rx", ps.rx, error) || !number(p, "loss", ps.loss, 0, 1, error) ||
                !number(p, "rssi_dbm", rssi, -100, 0, error)) {
                error = "medium.pairs." + error;
                return false;
            }
            ps.rssi_dbm = static_cast<int8_t>(rssi);
            out.pairs.push_back(ps);
        }
    }
    if (const cJSON *pos = item(m, "positions"); cJSON_IsObject(pos)) {
        for (const cJSON *p = pos->child; p != nullptr; p = p->next) {
            if (!cJSON_IsArray(p) || cJSON_GetArraySize(p) != 2) {
                error = "medium.positions: expected [x, y] per alias";
                return false;
            }
            out.positions.push_back(
                {p->string, {cJSON_GetArrayItem(p, 0)->valuedouble, cJSON_GetArrayItem(p, 1)->valuedouble}});
        }
    }
    if (const cJSON *pl = item(m, "path_loss")) {
        if (!number(pl, "p0_dbm", out.p0_dbm, -200, 100, error) || !number(pl, "n", out.path_n, 1, 6, error)) {
            error = "medium.path_loss." + error;
            return false;
        }
    }
    return true;
}

bool parse_ap(const cJSON *a, FleetSpec::Ap &out, std::string &error)
{
    if (a == nullptr) {
        return true;
    }
    double rlo = out.rssi_min_dbm;
    double rhi = out.rssi_max_dbm;
    double alo = out.assoc_min_ms;
    double ahi = out.assoc_max_ms;
    if (!integer(a, "channel", out.channel, 1, 13, error) || !range(a, "rssi_dbm", rlo, rhi, -100, 0, error) ||
        !range(a, "uplink_ms", out.uplink_min_ms, out.uplink_max_ms, 0, 10'000, error) ||
        !range(a, "downlink_ms", out.downlink_min_ms, out.downlink_max_ms, 0, 10'000, error) ||
        !number(a, "udp_loss", out.udp_loss, 0, 1, error) || !number(a, "phy_rate", out.phy_rate, 0.1, 1000, error) ||
        !number(a, "http_kbps", out.http_kbps, 0, 1e6, error) ||
        !range(a, "assoc_ms", alo, ahi, 0, 60'000, error)) {
        error = "ap." + error;
        return false;
    }
    out.rssi_min_dbm = static_cast<int8_t>(rlo);
    out.rssi_max_dbm = static_cast<int8_t>(rhi);
    out.assoc_min_ms = static_cast<uint32_t>(alo);
    out.assoc_max_ms = static_cast<uint32_t>(ahi);
    if (const cJSON *g = item(a, "gaps"); g != nullptr && !cJSON_IsNull(g)) {
        double every = 0;
        uint32_t len = 0;
        if (!number(g, "every_s", every, 1e-3, 1e6, error) || !integer(g, "len_ms", len, 1, 1e7, error)) {
            error = "ap.gaps." + error;
            return false;
        }
        out.gaps = std::make_pair(every, len);
    }
    return true;
}

bool parse_node(const cJSON *n, NodeSpec &out, std::string &error)
{
    std::string mac;
    std::string udp = "shared";
    if (!text(n, "alias", out.alias, error) || !text(n, "mac", mac, error) || !integer(n, "addr", out.addr, 0, 0xFFFF, error) ||
        !integer(n, "net", out.net, 0, 0xFFFF, error) || !integer(n, "epoch", out.epoch, 0, 0xFFFF, error) ||
        !integer(n, "alias_rev", out.alias_rev, 0, 4294967295.0, error) ||
        !integer(n, "rng_seed", out.rng_seed, 0, 4294967295.0, error) || !integer(n, "hb_ms", out.hb_ms, 100, 60'000, error) ||
        !integer(n, "health_ms", out.health_ms, 1000, 600'000, error) || !boolean(n, "usb", out.usb, error) ||
        !text(n, "udp", udp, error) || !boolean(n, "ota", out.ota, error) || !text(n, "profile", out.profile, error) ||
        !boolean(n, "spare", out.spare, error)) {
        return false;
    }
    if (out.alias.empty() || !parse_hex(mac, out.mac)) {
        error = "alias and a 12-hex mac are required";
        return false;
    }
    if (kit_profile(out.profile) == nullptr) {
        // Its port table and descriptor are the kit's (design m2-c3-inputs §8): a profile it cannot play is refused.
        error = "profile: the kit plays " + kit_profile_names() + ", not " + out.profile;
        return false;
    }
    if (udp != "shared" && udp != "own") {
        error = "udp: expected shared or own";
        return false;
    }
    out.udp = udp == "own" ? NodeSpec::Udp::own : NodeSpec::Udp::shared;
    if (const cJSON *r = item(n, "radio")) {
        if (!integer(r, "channel", out.radio.channel, 1, 13, error) || !rate(r, "bcast_rate", out.radio.bcast_rate, error) ||
            !rate(r, "ucast_rate", out.radio.ucast_rate, error)) {
            error = "radio." + error;
            return false;
        }
    }
    // Every fleet node is a pad with Wi-Fi and a log source (D20), as the C2 image is.
    out.ip = true;
    out.net_log = true;
    return true;
}

}  // namespace

bool parse_fleet_spec(std::string_view json, FleetSpec &out, std::string &error)
{
    cJSON *root = cJSON_ParseWithLength(json.data(), json.size());
    if (root == nullptr || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        error = "the spec is not a JSON object";
        return false;
    }
    std::string schema;
    bool ok = text(root, "schema", schema, error);
    if (ok && schema != "fractonica/fleet-spec@1") {
        error = "schema: expected fractonica/fleet-spec@1";
        ok = false;
    }
    ok = ok && integer(root, "seed", out.seed, 0, 4294967295.0, error) && number(root, "pace", out.pace, 1e-6, 10, error) &&
         integer(root, "verbosity", out.verbosity, 0, 3, error) && text(root, "state_dir", out.state_dir, error) &&
         parse_medium(item(root, "medium"), out.medium, error) && parse_ap(item(root, "ap"), out.ap, error);
    if (ok && out.state_dir.empty()) {
        error = "state_dir is required";
        ok = false;
    }
    const cJSON *nodes = item(root, "nodes");
    if (ok && (!cJSON_IsArray(nodes) || cJSON_GetArraySize(nodes) == 0)) {
        error = "nodes: expected at least one";
        ok = false;
    }
    if (ok) {
        int i = 0;
        for (const cJSON *n = nodes->child; n != nullptr && ok; n = n->next, ++i) {
            NodeSpec ns;
            if (!parse_node(n, ns, error)) {
                error = sformat("nodes[%d].", i) + error;
                ok = false;
                break;
            }
            for (const NodeSpec &other : out.nodes) {
                if (other.alias == ns.alias || other.mac == ns.mac || other.addr == ns.addr) {
                    error = sformat("nodes[%d]: alias, mac or addr repeats", i);
                    ok = false;
                }
            }
            out.nodes.push_back(std::move(ns));
        }
    }
    cJSON_Delete(root);
    return ok;
}

}  // namespace frsim
