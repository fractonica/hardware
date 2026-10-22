// A simulated ESP-NOW medium for multi-node host tests (design c5 §5): N Nets share one FakeCore clock, each
// with a Radio (AirLink) on one channel. The model follows the driver of design c5 §3 and the airtime of
// spec 05 §5.15: one send in flight per radio, URGENT > NORMAL > BULK, carrier sense (a send waits for the
// channel, then a random backoff, and cannot be cancelled once handed over), airtime 0.9 ms + 8 µs per byte
// (a 32 B broadcast takes ~1.15 ms) plus 0.3 ms for a unicast's MAC ACK, independent seeded loss per
// receiver and per ACK, and link retries after 2 ms and 4 ms. The hub side delivers frames over a node's hub
// link after a random 0.8-3 ms, in order per link. Deterministic for a seed. Test code: it may allocate.
#pragma once

#include <deque>
#include <functional>
#include <map>
#include <random>
#include <string>
#include <utility>
#include <vector>

#include "tests/net_air_fakes.hpp"

namespace frt {

class AirMedium
{
public:
    struct Options {
        double loss = 0.0;  // per receiver and transmission (and per MAC ACK), independent
        uint32_t seed = 1;
        int8_t rssi = -55;
        size_t queue_max = 16;  // the driver's queue; send() is busy beyond it
        uint32_t hub_min_us = 800;
        uint32_t hub_max_us = 3000;
    };

    class Radio final : public fr::net::AirLink
    {
    public:
        Radio(AirMedium &m, Mac mac) : mac(mac), medium_(m) {}

        bool up() const override { return is_up; }
        fr::Status send(const Mac &dst, std::span<const uint8_t> envelope, fr::net::AirPrio prio, uint32_t token) override
        {
            if (!is_up) {
                return std::unexpected(fr::Err::failed);
            }
            if (queue_.size() >= medium_.opt_.queue_max) {
                return std::unexpected(fr::Err::busy);
            }
            queue_.push_back({dst, {envelope.begin(), envelope.end()}, prio, token, 0});
            medium_.kick(*this);
            return {};
        }

        Mac mac;
        fr::net::Net *net = nullptr;
        bool is_up = true;
        uint32_t transmissions = 0;  // frames this radio put on the channel, link retries included

    private:
        friend class AirMedium;
        struct Tx {
            Mac dst;
            std::vector<uint8_t> bytes;
            fr::net::AirPrio prio;
            uint32_t token;
            uint8_t attempt;
        };
        AirMedium &medium_;
        std::deque<Tx> queue_;
        bool busy_ = false;  // one send in flight, retries included
    };

    /** One frame on the channel. */
    struct Transmission {
        fr::TimeUs at;
        Mac from;
        Mac dst;
        std::vector<uint8_t> bytes;
    };

    AirMedium(FakeCore &core, Options o) : core_(core), opt_(o), rng_(o.seed)
    {
        timer_ = core_.timer([this] { run(); });
    }
    AirMedium(const AirMedium &) = delete;
    AirMedium &operator=(const AirMedium &) = delete;

    Radio &add(Mac mac) { return radios_.emplace_back(*this, mac); }

    /** A hub frame over `net`'s hub link `link`, after the hub path's latency, in order per link. */
    void hub_send(fr::net::Net &net, fr::net::LinkKind link, std::vector<uint8_t> env)
    {
        const fr::TimeUs lat = opt_.hub_min_us + rng_() % (opt_.hub_max_us - opt_.hub_min_us + 1);
        fr::TimeUs &last = hub_last_[{&net, link}];
        last = std::max(core_.now() + lat, last + 1);
        at(last, [&net, link, env] { net.receive(link, env); });
    }

    void at(fr::TimeUs t, std::function<void()> fn)
    {
        events_.emplace(std::make_pair(t, ++order_), std::move(fn));
        arm();
    }

    std::vector<Transmission> log;  // every frame put on the channel, retries included
    uint32_t lost = 0;              // receptions (or MAC ACKs) the loss model ate

private:
    static uint32_t airtime_us(size_t len) { return 900 + 8 * static_cast<uint32_t>(len); }

    bool lose()
    {
        if (opt_.loss <= 0) {
            return false;
        }
        const bool l = std::uniform_real_distribution<double>(0, 1)(rng_) < opt_.loss;
        lost += l ? 1 : 0;
        return l;
    }

    void kick(Radio &r)
    {
        if (r.busy_ || r.queue_.empty() || !r.is_up) {
            return;
        }
        // URGENT > NORMAL > BULK, first in first out within one.
        auto best = std::min_element(r.queue_.begin(), r.queue_.end(),
                                     [](const Radio::Tx &a, const Radio::Tx &b) { return a.prio < b.prio; });
        Radio::Tx tx = std::move(*best);
        r.queue_.erase(best);
        r.busy_ = true;
        start(r, std::move(tx));
    }

    void start(Radio &r, Radio::Tx tx)
    {
        const fr::TimeUs now = core_.now();
        if (channel_free_ > now) {
            // Carrier sense: wait for the channel, then a random backoff (20 µs slots).
            const fr::TimeUs when = channel_free_ + 20 * static_cast<fr::TimeUs>(rng_() % 16);
            at(when, [this, &r, tx] { start(r, tx); });
            return;
        }
        const bool unicast = tx.dst != fr::net::kBroadcastMac;
        const fr::TimeUs end = now + airtime_us(tx.bytes.size()) + (unicast ? 300 : 0);
        channel_free_ = end;
        ++r.transmissions;
        log.push_back({now, r.mac, tx.dst, tx.bytes});
        at(end, [this, &r, tx] { finish(r, tx); });
    }

    void finish(Radio &r, Radio::Tx tx)
    {
        if (tx.dst == fr::net::kBroadcastMac) {
            for (Radio &o : radios_) {
                if (&o != &r && o.is_up && o.net != nullptr && !lose()) {
                    o.net->receive_air(tx.bytes, {.src_mac = r.mac, .to_broadcast = true, .rssi = opt_.rssi, .channel = 6});
                }
            }
            done(r, tx, true);
            return;
        }
        Radio *t = nullptr;
        for (Radio &o : radios_) {
            if (o.mac == tx.dst && o.is_up && o.net != nullptr) {
                t = &o;
            }
        }
        const bool received = t != nullptr && !lose();
        if (received) {
            t->net->receive_air(tx.bytes, {.src_mac = r.mac, .to_broadcast = false, .rssi = opt_.rssi, .channel = 6});
        }
        if (received && !lose()) {
            done(r, tx, true);
        } else if (tx.attempt < 2) {
            // Link retries after 2 ms, then 4 ms (05 §5.3); the target may have it already (its ACK lost).
            ++tx.attempt;
            at(core_.now() + (tx.attempt == 1 ? 2000 : 4000), [this, &r, tx] { start(r, tx); });
        } else {
            done(r, tx, false);
        }
    }

    void done(Radio &r, const Radio::Tx &tx, bool acked)
    {
        r.busy_ = false;
        if (r.net != nullptr) {
            r.net->air_sent(tx.token, acked);
        }
        kick(r);
    }

    void run()
    {
        while (!events_.empty() && events_.begin()->first.first <= core_.now()) {
            auto fn = std::move(events_.begin()->second);
            events_.erase(events_.begin());
            fn();
        }
        arm();
    }

    void arm()
    {
        if (events_.empty()) {
            timer_->stop();
            return;
        }
        const fr::TimeUs next = events_.begin()->first.first;
        const fr::TimeUs now = core_.now();
        timer_->start(static_cast<uint32_t>(next > now ? next - now : 0));
    }

    FakeCore &core_;
    Options opt_;
    std::mt19937 rng_;
    fr::Timer *timer_ = nullptr;
    std::deque<Radio> radios_;
    std::map<std::pair<fr::TimeUs, uint64_t>, std::function<void()>> events_;
    uint64_t order_ = 0;
    fr::TimeUs channel_free_ = 0;
    std::map<std::pair<const fr::net::Net *, fr::net::LinkKind>, fr::TimeUs> hub_last_;
};

inline Mac sim_mac(uint16_t addr)
{
    return {0x02, 0x00, 0x00, 0x00, static_cast<uint8_t>(addr >> 8), static_cast<uint8_t>(addr)};
}

/** One node on the medium: Net with serial and TCP links, its radio, stores and a HubSim for its hub frames. */
struct SimNode {
    SimNode(FakeCore &core, AirMedium &m, uint16_t addr, uint32_t seed_offset)
        : host(core, addr, sim_mac(addr)), serial(LinkKind::serial, core), tcp(LinkKind::tcp, core),
          net(core, host, air_config(seed_offset)), radio(m.add(sim_mac(addr))), hub(addr, host.id.net)
    {
        net.attach(serial);
        net.attach(tcp);
        net.attach_stores(&stores, &stores);
        radio.net = &net;
        net.attach_air(radio);
    }

    /** Link `k` up, WELCOMEd with `bcast_base`, its boot event ACKed. */
    void session(FakeCore &core, LinkKind k, uint32_t bcast_base)
    {
        FakeLink &l = k == LinkKind::serial ? serial : tcp;
        l.is_up = true;
        net.link_changed(k);
        core.run_ready();
        net.receive(k, hub.welcome(0, bcast_base));
        for (const Frame &f : l.frames_of(fr::wire::kClsEvent)) {
            if ((f.flags & fr::wire::kFlagAckReq) != 0) {
                net.receive(k, hub.ack(host.id.epoch, f.seq));
            }
        }
        core.run_ready();
    }

    void link_down(FakeCore &core, LinkKind k)
    {
        (k == LinkKind::serial ? serial : tcp).is_up = false;
        net.link_changed(k);
        core.run_ready();
    }

    /** How many times each `topic` MSG data was handed to Host::msg. */
    std::map<std::string, int> deliveries(std::string_view topic) const
    {
        std::map<std::string, int> out;
        for (const AirHost::Msg &m : host.msgs) {
            if (m.topic == topic) {
                ++out[std::string(m.data.begin(), m.data.end())];
            }
        }
        return out;
    }

    AirHost host;
    FakeLink serial;
    FakeLink tcp;
    MemStores stores;
    fr::net::Net net;
    AirMedium::Radio &radio;
    HubSim hub;
};

}  // namespace frt
