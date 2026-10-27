// The N-node medium (design m2-c2 D3, D4, §2.1). Each radio has at most one frame on the air or contending, the
// head of its pending list (the driver keeps one send in flight; after a crash a stale head is dropped). A
// contending radio waits for a channel it senses idle, then DIFS and its backoff slots, which freeze while the
// channel is busy and resume after the next DIFS. A frame that starts is sensed by every radio on the channel in
// reach of its sender, except one whose backoff ends within the same slot: that one transmits too, and the two
// collide wherever both are heard. At the frame's end each receiver's fate is decided (collision with capture, then
// the loss draw) and a decoded frame is delivered after the pair's latency, in order per (tx, rx); the channel is
// released at the exchange's end (a unicast's ACK included) and the verdict follows send_cb_us later.
//
// Model time: each contention event decides at its own time (a backoff's end, a frame's end), not at the clock's
// reading when the executor gets to it. In virtual time the two are equal. In wall time a loaded loop runs events
// late, in their order; deciding at the clock's reading would make two backoffs that ended milliseconds apart look
// like one slot, and collide (I1's T2-FLOOD-B dry run: two seeders' relays 1-16 ms apart, run late together). The
// AP's IP frames go on the same clock (Executor::event_time(): the time of the event that sent them, never the
// clock's reading), so a late event neither prunes a frame an undecided one still overlaps nor pushes the channel's
// busy union past ESP-NOW frames still to start (review sim-core-2, sim-core-3). Pruning also never passes the start
// of a frame not yet decided, whatever clock asks.
#include "sim/medium.hpp"

#include <algorithm>
#include <cmath>
#include <deque>
#include <map>
#include <memory>
#include <unordered_map>
#include <utility>

#include "sim/airtime.hpp"
#include "sim/rng.hpp"

namespace frsim {

namespace {

/** Frames older than this (by their exchange's end) can overlap no frame still to be decided. */
constexpr fr::TimeUs kPruneUs = 50'000;
constexpr fr::TimeUs kWindowUs = 1'000'000;
/** A frame from the AP model (account_ip), not from a radio. */
constexpr RadioId kAp = 0xFFFF;

using Bytes = std::shared_ptr<const std::vector<uint8_t>>;

}  // namespace

struct Medium::Impl {
    struct Tx {
        Bytes bytes;
        fr::net::Mac dst{};
        Rate rate = Rate::r1m;
        uint64_t frame_no = 0;
        uint32_t gen = 0;
        bool unicast = false;
    };

    enum class St : uint8_t { idle, contending, on_air };

    struct Radio {
        RadioPort *port = nullptr;
        fr::net::Mac mac{};
        uint8_t channel = 0;
        uint64_t frames = 0;  // frames handed to transmit(): the RNG's frame no
        std::deque<Tx> pending;
        St st = St::idle;
        uint32_t remaining = 0;  // backoff slots left
        bool frozen = false;     // waiting for an idle channel
        fr::TimeUs idle_since = 0;
        fr::TimeUs contend_at = 0;  // when its head frame began contending: its backoff never counts from before
        fr::TimeUs fire_at = 0;
        EventId fire_ev = 0;
        uint32_t busy = 0;  // frames on the air this radio senses
        RadioStats stats;
    };

    struct Cell {
        Pair p;
        fr::TimeUs last_rx = 0;  // the latest delivery on this pair: order per (tx, rx)
    };

    struct Frame {
        RadioId tx = 0;
        uint8_t channel = 0;
        fr::TimeUs start = 0;
        fr::TimeUs data_end = 0;
        fr::TimeUs end = 0;
        Tx tx_frame;
        size_t len = 0;
        std::vector<RadioId> sensed;
        bool ok = false;
        bool decided = false;   // its receivers' fates are known (an AP frame has none to decide)
        bool released = false;  // its release ran: the radios that sensed it were told it ended
    };

    struct Channel {
        std::vector<uint64_t> recent;  // frames that may still overlap one to be decided
        fr::TimeUs busy_until = 0;
        ChannelUse total;
        std::map<int64_t, ChannelUse> windows;
    };

    Impl(Executor &e, const MediumConfig &c) : exec(e), cfg(c) {}

    Executor &exec;
    MediumConfig cfg;
    std::function<void(const OnAir &)> observer;
    std::vector<Radio> radios;
    std::vector<std::vector<Cell>> pairs;  // [tx][rx]
    std::unordered_map<uint64_t, Frame> frames;
    uint64_t frame_ids = 0;
    std::map<uint8_t, Channel> channels;

    static Rate head_rate(const Radio &r) { return r.pending.empty() ? Rate::r1m : r.pending.front().rate; }

    ChannelUse &window(Channel &c, int64_t w)
    {
        ChannelUse &u = c.windows[w];
        while (!c.windows.empty() && c.windows.begin()->first < w - 3) {
            c.windows.erase(c.windows.begin());
        }
        return u;
    }

    /** The union of on-air time, split over 1 s windows. */
    void add_busy(Channel &c, fr::TimeUs s, fr::TimeUs e)
    {
        s = std::max(s, c.busy_until);
        if (e <= s) {
            return;
        }
        c.busy_until = e;
        c.total.busy_us += static_cast<uint64_t>(e - s);
        while (s < e) {
            const int64_t w = s / kWindowUs;
            const fr::TimeUs cut = std::min(e, (w + 1) * kWindowUs);
            window(c, w).busy_us += static_cast<uint64_t>(cut - s);
            s = cut;
        }
    }

    void add_planning(Channel &c, fr::TimeUs at, uint32_t us)
    {
        c.total.planning_us += us;
        window(c, at / kWindowUs).planning_us += us;
    }

    // ---- contention ----

    void schedule_fire(RadioId id)
    {
        Radio &r = radios[id];
        const airtime::Phy p = airtime::phy(head_rate(r));
        r.fire_at = r.idle_since + p.difs_us + static_cast<fr::TimeUs>(r.remaining) * p.slot_us;
        r.fire_ev = exec.at(r.fire_at, [this, id] { fire(id); });
    }

    /** The head of `id`'s pending list starts contending at `now` (a crashed node's stale frames are dropped first). */
    void contend(RadioId id, fr::TimeUs now)
    {
        Radio &r = radios[id];
        while (!r.pending.empty() && r.pending.front().gen != r.port->generation()) {
            r.pending.pop_front();
        }
        if (r.pending.empty()) {
            r.st = St::idle;
            return;
        }
        const Tx &t = r.pending.front();
        r.st = St::contending;
        r.contend_at = now;
        const int32_t forced = cfg.backoff_override ? cfg.backoff_override(id) : -1;
        r.remaining = forced >= 0 ? static_cast<uint32_t>(forced)
                                  : rng::upto(cfg.seed, r.mac, t.frame_no, r.mac, rng::Purpose::backoff, airtime::phy(t.rate).cw);
        r.frozen = r.busy > 0;
        if (!r.frozen) {
            r.idle_since = now;
            schedule_fire(id);
        }
    }

    /** A frame started that `id` senses: its backoff freezes, unless it ends within this slot (then it collides). */
    void sense_start(RadioId id, fr::TimeUs now)
    {
        Radio &r = radios[id];
        ++r.busy;
        if (r.st != St::contending || r.frozen) {
            return;
        }
        const airtime::Phy p = airtime::phy(head_rate(r));
        if (r.fire_at < now + p.slot_us) {
            return;  // its backoff ends in this slot: it cannot sense the frame yet
        }
        const fr::TimeUs counted_from = r.idle_since + p.difs_us;
        if (now > counted_from) {
            const auto slots = static_cast<uint32_t>((now - counted_from) / p.slot_us);
            r.remaining -= std::min(slots, r.remaining);
        }
        exec.cancel(r.fire_ev);
        r.fire_ev = 0;
        r.frozen = true;
    }

    void sense_end(RadioId id, fr::TimeUs now)
    {
        Radio &r = radios[id];
        r.busy = r.busy > 0 ? r.busy - 1 : 0;
        if (r.busy == 0 && r.st == St::contending && r.frozen) {
            r.frozen = false;
            r.idle_since = std::max(now, r.contend_at);  // a late release ends a frame before this radio queued
            schedule_fire(id);
        }
    }

    // ---- frames ----

    void fire(RadioId id)
    {
        Radio &r = radios[id];
        r.fire_ev = 0;
        if (r.st != St::contending || r.pending.empty()) {
            return;
        }
        if (r.pending.front().gen != r.port->generation()) {
            contend(id, r.fire_at);  // its node crashed while it contended
            return;
        }
        start_frame(id, r.fire_at);  // at its backoff's end, however late the loop runs it (model time)
    }

    void start_frame(RadioId id, fr::TimeUs now)
    {
        Radio &r = radios[id];
        Tx t = std::move(r.pending.front());
        r.pending.pop_front();
        r.st = St::on_air;
        const uint64_t fid = ++frame_ids;
        Frame &f = frames[fid];
        f.tx = id;
        f.channel = r.channel;
        f.start = now;
        f.len = t.bytes->size();
        f.data_end = now + airtime::on_air_us(t.rate, f.len);
        f.end = now + airtime::exchange_us(t.rate, f.len, t.unicast);
        f.tx_frame = std::move(t);
        for (RadioId o = 0; o < radios.size(); ++o) {
            if (o != id && radios[o].channel == f.channel && pairs[id][o].p.reach) {
                f.sensed.push_back(o);
                sense_start(o, now);
            }
        }
        Channel &c = channels[f.channel];
        prune(c, now);
        c.recent.push_back(fid);
        add_busy(c, now, f.end);
        add_planning(c, now, airtime::planning_us(f.tx_frame.rate, f.len, f.tx_frame.unicast));
        RateUse &use = c.total.by_rate[static_cast<size_t>(f.tx_frame.rate)];
        ++use.frames;
        use.bytes += f.len;
        RateUse &wuse = window(c, now / kWindowUs).by_rate[static_cast<size_t>(f.tx_frame.rate)];
        ++wuse.frames;
        wuse.bytes += f.len;
        ++r.stats.tx;
        r.stats.tx_airtime_us += static_cast<uint64_t>(f.end - f.start);
        if (observer) {
            observer(OnAir{.tx = id,
                           .dst = f.tx_frame.dst,
                           .frame = *f.tx_frame.bytes,
                           .rate = f.tx_frame.rate,
                           .channel = f.channel,
                           .start = f.start,
                           .end = f.data_end});
        }
        if (f.tx_frame.unicast) {
            exec.at(f.data_end, [this, fid] { decide(fid); });
            exec.at(f.end, [this, fid] { release(fid); });
        } else {
            exec.at(f.data_end, [this, fid] {
                decide(fid);
                release(fid);
            });
        }
    }

    void prune(Channel &c, fr::TimeUs now)
    {
        // Never past the start of a frame still to be decided: any frame it overlaps ends after that start, so it stays
        // for that frame's collision and half-duplex checks.
        fr::TimeUs horizon = now;
        for (const uint64_t id : c.recent) {
            if (const auto it = frames.find(id); it != frames.end() && !it->second.decided) {
                horizon = std::min(horizon, it->second.start);
            }
        }
        std::erase_if(c.recent, [&](uint64_t id) {
            const auto it = frames.find(id);
            if (it == frames.end()) {
                return true;
            }
            // Only a released frame: in wall time a late loop may not have run a frame's decide and release yet when
            // a newer frame's clock reading is past its end (then the radios that sensed it would stay frozen).
            if (it->second.released && it->second.end + kPruneUs < horizon) {
                frames.erase(it);
                return true;
            }
            return false;
        });
    }

    /** `f` reaches `rx` undamaged by overlapping frames (always, with collisions off). */
    bool survives(const Frame &f, RadioId rx, uint64_t fid)
    {
        if (!cfg.collisions) {
            return true;
        }
        const double mine = pairs[f.tx][rx].p.rssi_dbm;
        for (uint64_t gid : channels[f.channel].recent) {
            if (gid == fid) {
                continue;
            }
            const auto it = frames.find(gid);
            if (it == frames.end() || it->second.tx == kAp) {
                continue;
            }
            const Frame &g = it->second;
            if (g.start >= f.data_end || g.data_end <= f.start) {
                continue;
            }
            if (g.tx == rx) {
                return false;  // it was transmitting itself (half duplex)
            }
            if (pairs[g.tx][rx].p.reach && mine < pairs[g.tx][rx].p.rssi_dbm + cfg.capture_db) {
                return false;
            }
        }
        return true;
    }

    void decide(uint64_t fid)
    {
        const auto it = frames.find(fid);
        if (it == frames.end()) {
            return;
        }
        Frame &f = it->second;
        f.decided = true;
        Radio &s = radios[f.tx];
        if (!f.tx_frame.unicast) {
            for (RadioId o = 0; o < radios.size(); ++o) {
                if (o != f.tx && radios[o].channel == f.channel && pairs[f.tx][o].p.reach) {
                    receive(f, fid, o);
                }
            }
            f.ok = true;  // a broadcast is ok once it went on the air
            return;
        }
        f.ok = false;
        for (RadioId o = 0; o < radios.size(); ++o) {
            if (o == f.tx || radios[o].mac != f.tx_frame.dst) {
                continue;
            }
            if (radios[o].channel != f.channel || !pairs[f.tx][o].p.reach || !receive(f, fid, o)) {
                break;  // out of reach, off, collided or lost: no ACK, the sender's link retries follow
            }
            // Its MAC ACK on the reverse pair (ACK collisions are not modelled).
            const Pair &back = pairs[o][f.tx].p;
            f.ok = back.reach && rng::uniform(cfg.seed, s.mac, f.tx_frame.frame_no, radios[o].mac, rng::Purpose::ack) >= back.loss;
            break;
        }
    }

    /** `f` at `rx`: not heard (off), collided, lost, or decoded and delivered. True when decoded. */
    bool receive(const Frame &f, uint64_t fid, RadioId rx)
    {
        Radio &r = radios[rx];
        const Radio &s = radios[f.tx];
        Cell &cell = pairs[f.tx][rx];
        const uint64_t no = f.tx_frame.frame_no;
        if (!r.port->listening()) {
            return false;  // a powered-off board decodes nothing and sends no MAC ACK (review sim-core-1, fleet-3)
        }
        if (!survives(f, rx, fid)) {
            ++r.stats.collided;
            ++channels[f.channel].total.by_rate[static_cast<size_t>(f.tx_frame.rate)].collisions;
            ++window(channels[f.channel], f.data_end / kWindowUs).by_rate[static_cast<size_t>(f.tx_frame.rate)].collisions;
            return false;
        }
        if (rng::uniform(cfg.seed, s.mac, no, r.mac, rng::Purpose::loss) < cell.p.loss) {
            ++r.stats.lost;
            return false;
        }
        const Pair &p = cell.p;
        const uint32_t spread = p.lat_max_us > p.lat_min_us ? p.lat_max_us - p.lat_min_us : 0;
        const fr::TimeUs lat = p.lat_min_us + rng::upto(cfg.seed, s.mac, no, r.mac, rng::Purpose::latency, spread);
        const double noise = p.rssi_sigma_db > 0
                                 ? p.rssi_sigma_db * rng::normal(cfg.seed, s.mac, no, r.mac, rng::Purpose::rssi, rng::Purpose::rssi_b)
                                 : 0.0;
        const auto rssi = static_cast<int8_t>(std::clamp<long>(std::lround(p.rssi_dbm + noise), -127, 0));
        const fr::net::RxMeta meta{.src_mac = s.mac, .to_broadcast = !f.tx_frame.unicast, .rssi = rssi, .channel = f.channel};
        const bool dup = p.dup > 0 && rng::uniform(cfg.seed, s.mac, no, r.mac, rng::Purpose::dup) < p.dup;
        for (int copy = 0; copy < (dup ? 2 : 1); ++copy) {
            const fr::TimeUs at = std::max(f.data_end + lat, cell.last_rx + 1);
            cell.last_rx = at;
            ++r.stats.rx;
            const uint32_t gen = r.port->generation();
            exec.at(at, [this, rx, gen, bytes = f.tx_frame.bytes, meta] {
                RadioPort *port = radios[rx].port;
                if (port->generation() == gen) {
                    port->received(*bytes, meta);
                }
            });
        }
        if (dup) {
            ++r.stats.dups;
        }
        return true;
    }

    void release(uint64_t fid)
    {
        const auto it = frames.find(fid);
        if (it == frames.end()) {
            return;
        }
        Frame &f = it->second;
        f.released = true;
        // The time this release is due (a broadcast's at its data's end, an exchange's at its ACK's end), however
        // late the loop runs it.
        const fr::TimeUs now = f.tx == kAp || f.tx_frame.unicast ? f.end : f.data_end;
        for (RadioId o : f.sensed) {
            sense_end(o, now);
        }
        if (f.tx == kAp) {
            return;
        }
        Radio &s = radios[f.tx];
        s.st = St::idle;
        const uint32_t gen = f.tx_frame.gen;
        const bool ok = f.ok;
        const RadioId tx = f.tx;
        exec.at(now + cfg.send_cb_us, [this, tx, gen, ok] {
            RadioPort *port = radios[tx].port;
            if (port->generation() == gen) {
                port->transmitted(ok);
            }
        });
        contend(tx, now);
    }

    /** An AP frame on the air from `now` (model time: account_ip's start). */
    void start_ip(uint8_t channel, fr::TimeUs dur, fr::TimeUs now)
    {
        const uint64_t fid = ++frame_ids;
        Frame &f = frames[fid];
        f.tx = kAp;
        f.channel = channel;
        f.start = now;
        f.data_end = now + dur;
        f.end = now + dur;
        f.decided = true;  // no receiver's fate hangs on it
        for (RadioId o = 0; o < radios.size(); ++o) {
            if (radios[o].channel == channel) {
                f.sensed.push_back(o);
                sense_start(o, now);
            }
        }
        Channel &c = channels[channel];
        prune(c, now);
        c.recent.push_back(fid);
        exec.at(f.end, [this, fid] { release(fid); });
    }
};

Medium::Medium(Executor &exec, const MediumConfig &cfg) : impl_(std::make_unique<Impl>(exec, cfg)) {}

Medium::~Medium() = default;

RadioId Medium::add_radio(RadioPort &port, const fr::net::Mac &mac, uint8_t channel)
{
    Impl &m = *impl_;
    const auto id = static_cast<RadioId>(m.radios.size());
    Impl::Radio r;
    r.port = &port;
    r.mac = mac;
    r.channel = channel;
    m.radios.push_back(std::move(r));
    for (auto &row : m.pairs) {
        row.emplace_back();
    }
    m.pairs.emplace_back(m.radios.size());
    m.channels.try_emplace(channel);
    return id;
}

void Medium::set_channel(RadioId radio, uint8_t channel)
{
    impl_->radios[radio].channel = channel;
    impl_->channels.try_emplace(channel);
}

size_t Medium::radios() const
{
    return impl_->radios.size();
}

void Medium::set_pair(RadioId tx, RadioId rx, const Pair &pair)
{
    impl_->pairs[tx][rx].p = pair;
}

Pair Medium::pair(RadioId tx, RadioId rx) const
{
    return impl_->pairs[tx][rx].p;
}

void Medium::transmit(RadioId tx, const fr::net::Mac &dst, std::span<const uint8_t> frame, Rate rate)
{
    Impl &m = *impl_;
    Impl::Radio &r = m.radios[tx];
    r.pending.push_back({.bytes = std::make_shared<const std::vector<uint8_t>>(frame.begin(), frame.end()),
                         .dst = dst,
                         .rate = rate,
                         .frame_no = ++r.frames,
                         .gen = r.port->generation(),
                         .unicast = dst != fr::net::kBroadcastMac});
    if (r.st == Impl::St::idle) {
        m.contend(tx, m.exec.now());
    }
}

void Medium::account_ip(uint8_t channel, size_t bytes, uint32_t phy_rate_mbps)
{
    Impl &m = *impl_;
    Impl::Channel &c = m.channels[channel];
    // The model time of the event that sent it, never the clock's reading: in wall mode a late event would otherwise
    // start the frame ahead of ESP-NOW frames still to start, and prune frames an undecided one overlaps.
    const fr::TimeUs now = m.exec.event_time();
    const fr::TimeUs dur = airtime::ip_on_air_us(bytes, phy_rate_mbps);
    // The AP defers to the channel as it hears it (everyone on it): its frame starts when the channel is free.
    const fr::TimeUs start = std::max(now, c.busy_until);
    ++c.total.ip_frames;
    c.total.ip_us += static_cast<uint64_t>(dur);
    ChannelUse &w = m.window(c, start / kWindowUs);
    ++w.ip_frames;
    w.ip_us += static_cast<uint64_t>(dur);
    m.add_busy(c, start, start + dur);
    m.add_planning(c, start, static_cast<uint32_t>(dur) + airtime::mean_contention_us(Rate::r6m));
    if (start <= now) {
        m.start_ip(channel, dur, start);
    } else {
        m.exec.at(start, [&m, channel, dur, start] { m.start_ip(channel, dur, start); });
    }
}

Medium::Stats Medium::stats() const
{
    const Impl &m = *impl_;
    Stats out;
    const int64_t last = m.exec.now() / kWindowUs - 1;
    for (const auto &[ch, c] : m.channels) {
        ChannelStats s;
        s.channel = ch;
        s.total = c.total;
        if (const auto it = c.windows.find(last); it != c.windows.end()) {
            s.last_window = it->second;
        }
        s.busy_pct = static_cast<double>(s.last_window.busy_us) * 100.0 / static_cast<double>(kWindowUs);
        s.planning_pct = static_cast<double>(s.last_window.planning_us) * 100.0 / static_cast<double>(kWindowUs);
        out.channels.push_back(s);
    }
    for (const Impl::Radio &r : m.radios) {
        out.radios.push_back(r.stats);
    }
    return out;
}

void Medium::observe(std::function<void(const OnAir &)> observer)
{
    impl_->observer = std::move(observer);
}

const MediumConfig &Medium::config() const
{
    return impl_->cfg;
}

Executor &Medium::executor() const
{
    return impl_->exec;
}

fr::net::Mac Medium::mac(RadioId radio) const
{
    return impl_->radios[radio].mac;
}

uint8_t Medium::channel(RadioId radio) const
{
    return impl_->radios[radio].channel;
}

}  // namespace frsim
