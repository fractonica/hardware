// fr:realtime
// fr_net core, M2-C4 (design m2-c4-gateway D19): spike S2's air bench and STATE stream, the frames behind diag `air bench`
// and `net stream` (FR_TEST_HOOKS builds start them; the firmware and the kit run this same code).
//
// A bench run sends `count` NET.TEST frames (TTL 1, never relayed, dst 0xFFFF: they are addressed by MAC) to one MAC or
// the broadcast MAC, paced by Net's timer (or, at interval 0, by the driver's ends, kBenchWindow in its queue), and counts
// what AirLink said of each. Every node counts the test frames it hears per source MAC (distinct seqs, gaps, dups, RSSI
// median), outside the node windows, and echoes those that ask, by unicast to the sender with echo false and dst the
// sender's addr; the sender takes an echo from its target as an RTT sample (on its own clock: t_us comes back as sent).
// The stream is Net::property() at a fixed rate on port 241, as an analog node's reports. Core task; no heap.
#include <algorithm>
#include <cstring>

#include "fr/envelope.hpp"
#include "fr/net/net.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"
#include "net_util.hpp"

namespace fr::net {

using namespace fr::wire;
using namespace util;

namespace {

/** A bench frame's token: kTokenBench, the run (8 bits), then a count, so a frame of an earlier run ends unnoticed. */
constexpr uint32_t kBenchRunShift = 22;
constexpr uint32_t kBenchCountMask = (1u << kBenchRunShift) - 1;

/** Zeros: the pad of every bench frame. */
constexpr uint8_t kZeros[Net::kStreamLenMax] = {};
static_assert(sizeof(kZeros) >= 180, "NET.TEST pad is at most 180 B (schema/protocol.yaml)");

constexpr int kRssiMin = -100;

}  // namespace

Status Net::bench_tx(const Mac &dst, uint32_t count, uint16_t len, uint32_t interval_ms, bool echo)
{
    if (count == 0 || count > kBenchCountMax || len < kBenchLenMin || len > kBenchLenMax ||
        interval_ms > kBenchIntervalMaxMs) {
        return std::unexpected(Err::invalid_args);
    }
    if (!provisioned()) {
        return std::unexpected(Err::not_provisioned);
    }
    if (!air_up()) {
        return std::unexpected(Err::failed);
    }
    const TimeUs now = core_.now();
    bench_reset();  // a new run: the frames of the one going end unnoticed
    bench_ = BenchTx{.running = true,
                     .broadcast = dst == kBroadcastMac,
                     .dst = dst,
                     .echo = echo,
                     .count = count,
                     .len = len,
                     .interval_ms = interval_ms};
    bench_t0_ = bench_end_ = now;
    bench_due_ = now;  // the first frame from the timer, after the RESULT of the request that asked for it
    arm();
    return {};
}

BenchReport Net::bench_report() const
{
    BenchReport r;
    r.tx = bench_;
    r.tx.rtt_p50_us = bench_rtt_.percentile(500);
    r.tx.rtt_p99_us = bench_rtt_.percentile(990);
    r.tx.rtt_max_us = bench_rtt_.max();
    const TimeUs now = core_.now();
    if (bench_.count != 0) {
        r.tx.elapsed_ms = static_cast<uint32_t>(((bench_.running ? now : bench_end_) - bench_t0_) / 1000);
    }
    std::array<const BenchSource *, kBenchSources> order{};
    for (const BenchSource &b : bench_src_) {
        if (b.used) {
            order[r.rx_count++] = &b;
        }
    }
    std::sort(order.begin(), order.begin() + static_cast<std::ptrdiff_t>(r.rx_count),
              [](const BenchSource *a, const BenchSource *b) { return a->heard > b->heard; });
    for (size_t i = 0; i < r.rx_count; ++i) {
        const BenchSource &b = *order[i];
        BenchRx &o = r.rx[i];
        o.mac = b.mac;
        o.addr = b.addr;
        o.received = b.received;
        const uint64_t span = uint64_t{b.newest} - b.first + 1;
        o.gaps = span > b.received ? static_cast<uint32_t>(span - b.received) : 0;
        o.dups = b.dups;
        o.echoed = b.echoed;
        o.age_ms = static_cast<uint32_t>((now - b.heard) / 1000);
        // The median bin: the RSSI at or below which half the frames were heard.
        uint64_t seen = 0;
        const uint64_t half = (uint64_t{b.received} + b.dups + 1) / 2;
        for (size_t k = 0; k < b.rssi.size(); ++k) {
            seen += b.rssi[k];
            if (seen >= half) {
                o.rssi_p50 = static_cast<int8_t>(kRssiMin + static_cast<int>(k));
                break;
            }
        }
    }
    return r;
}

void Net::bench_reset()
{
    bench_ = BenchTx{};
    bench_due_ = kNever;
    bench_seq_ = 0;
    bench_open_ = 0;
    bench_rtt_.clear();
    bench_src_ = {};
    ++bench_run_;  // frames still in the driver end unnoticed
}

void Net::bench_send(TimeUs now)
{
    const uint32_t seq = bench_seq_ + 1;
    fr::proto::NetTest m{.seq = seq, .t_us = low32(now), .echo = bench_.echo};
    uint8_t body[fr::proto::NetTest::kMaxSize];
    Writer bare(body, sizeof(body));
    encode(m, bare);
    // The pad takes what is left of `len`: its tag and length byte(s), then zeros (up to 2 bytes short where its own
    // length's varint grows, or nothing is left for the tag).
    const size_t used = kHeaderSize + bare.size();
    const size_t need = bench_.len > used ? bench_.len - used : 0;
    size_t pad = need >= 3 ? need - 2 : 0;
    pad = pad >= 128 ? need - 3 : pad;
    m.pad = std::span<const uint8_t>(kZeros, std::min<size_t>(pad, 180));
    Writer w(body, sizeof(body));
    encode(m, w);
    const auto env = build(0, kClsNet, fr::proto::kKindNetTest, ++seq_, fr::proto::kAddrBroadcast, fr::proto::kPortDiag,
                           {}, w.bytes(), ttl_both(1));
    const uint32_t token = kTokenBench | uint32_t{bench_run_} << kBenchRunShift | (next_token() & kBenchCountMask);
    if (air_send(bench_.dst, env, AirPrio::normal, token)) {
        ++bench_.sent;
        ++bench_open_;
        bench_seq_ = seq;
        return;
    }
    ++bench_.refused;
    if (bench_.interval_ms != 0) {
        bench_seq_ = seq;  // paced: that frame's slot is gone, and the receiver sees the gap
    }
}

void Net::service_bench(TimeUs now)
{
    if (!bench_.running || bench_due_ > now) {
        return;
    }
    if (!air_up()) {
        bench_.running = false;  // ESP-NOW went down: the run ends where it is
        bench_due_ = kNever;
        bench_end_ = now;
        return;
    }
    if (bench_.interval_ms == 0) {
        // As fast as the driver takes them: kBenchWindow queued at once, the next at each end. A refusal waits for the
        // next end (or 1 ms when nothing is out), the seq kept.
        bench_due_ = kNever;
        while (bench_seq_ < bench_.count && bench_open_ < kBenchWindow) {
            const uint32_t refused = bench_.refused;
            bench_send(now);
            if (bench_.refused != refused) {
                bench_due_ = bench_open_ == 0 ? now + 1000 : kNever;
                break;
            }
        }
    } else if (bench_seq_ < bench_.count) {
        bench_send(now);
        // A fixed rate; a late timer skips the slots it missed rather than bursting to catch up.
        const TimeUs iv = ms_us(bench_.interval_ms);
        bench_due_ += iv;
        if (bench_due_ <= now) {
            bench_due_ = now + iv;
        }
    }
    if (bench_seq_ >= bench_.count) {
        bench_due_ = kNever;
        if (bench_open_ == 0) {
            bench_.running = false;
            bench_end_ = now;
        }
    }
}

void Net::bench_sent(uint32_t token, bool ok)
{
    if (((token >> kBenchRunShift) & 0xFF) != bench_run_ || bench_open_ == 0) {
        return;  // a frame of a run reset or replaced since
    }
    --bench_open_;
    ++(ok ? bench_.acked : bench_.failed);
    const TimeUs now = core_.now();
    bench_end_ = now;
    if (bench_.running && bench_.interval_ms == 0) {
        bench_due_ = now;
        service_bench(now);
    } else if (bench_.running && bench_seq_ >= bench_.count && bench_open_ == 0) {
        bench_.running = false;
    }
}

void Net::on_bench(const EnvelopeView &e, const RxMeta &meta)
{
    const auto t = fr::proto::decode_net_test(e.body);
    if (!t) {
        ++ls(LinkKind::espnow).rx_drop;
        return;
    }
    const Header &h = e.header;
    const TimeUs now = core_.now();
    if (h.dst == addr_) {
        // An echo of this node's run, from its target (any node for a broadcast run), within the seqs sent.
        if (!t->echo && bench_.count != 0 && t->seq >= 1 && t->seq <= bench_seq_ &&
            (bench_.broadcast || meta.src_mac == bench_.dst)) {
            bench_rtt_.add(low32(now) - t->t_us);
            ++bench_.echoes;
        }
        return;
    }
    if (h.dst != fr::proto::kAddrBroadcast || t->seq == 0) {
        ++ls(LinkKind::espnow).rx_drop;  // another node's echo, or no seq
        return;
    }
    BenchSource *b = nullptr;
    for (BenchSource &x : bench_src_) {
        if (x.used && x.mac == meta.src_mac) {
            b = &x;
            break;
        }
    }
    if (b == nullptr) {
        b = &*std::min_element(bench_src_.begin(), bench_src_.end(), [](const BenchSource &x, const BenchSource &y) {
            return !x.used ? y.used || &x < &y : y.used && x.heard < y.heard;
        });
        *b = BenchSource{.used = true, .mac = meta.src_mac};
    }
    const uint32_t seq = t->seq;
    if (b->received > 0 && seq == 1 && b->newest >= 64) {
        *b = BenchSource{.used = true, .mac = meta.src_mac};  // seq 1 again, well past the window: a new run
    }
    b->addr = h.src;
    b->heard = now;
    ++b->rssi[static_cast<size_t>(std::clamp<int>(meta.rssi, kRssiMin, kRssiMin + static_cast<int>(kRssiBins) - 1) -
                                  kRssiMin)];
    if (b->received == 0) {
        b->first = b->newest = seq;
        b->seen = 1;
        b->received = 1;
    } else if (seq > b->newest) {
        const uint32_t shift = seq - b->newest;
        b->seen = (shift >= 64 ? 0 : b->seen << shift) | 1;
        b->newest = seq;
        ++b->received;
    } else if (const uint32_t back = b->newest - seq; back < 64) {
        const uint64_t bit = uint64_t{1} << back;
        if ((b->seen & bit) != 0) {
            ++b->dups;
        } else {
            b->seen |= bit;
            ++b->received;
            b->first = std::min(b->first, seq);
        }
    } else {
        // Older than the window: taken as new (a dup that late cannot be told apart).
        ++b->received;
        b->first = std::min(b->first, seq);
    }
    if (!t->echo) {
        return;
    }
    fr::proto::NetTest r = *t;
    r.echo = false;
    uint8_t body[fr::proto::NetTest::kMaxSize];
    Writer w(body, sizeof(body));
    encode(r, w);
    const auto env = build(0, kClsNet, fr::proto::kKindNetTest, ++seq_, h.src, fr::proto::kPortDiag, {}, w.bytes(),
                           ttl_both(1));
    if (air_send(meta.src_mac, env, AirPrio::normal, next_token())) {
        ++b->echoed;
    }
}

Status Net::stream(uint32_t hz, uint32_t seconds, uint16_t len)
{
    if (hz == 0 || seconds == 0) {
        stream_due_ = kNever;
        arm();
        return {};
    }
    if (hz > kStreamHzMax || seconds > kStreamSecondsMax || len == 0 || len > kStreamLenMax) {
        return std::unexpected(Err::invalid_args);
    }
    const TimeUs now = core_.now();
    stream_period_us_ = 1'000'000 / hz;
    stream_until_ = now + static_cast<TimeUs>(seconds) * 1'000'000;
    stream_len_ = len;
    stream_n_ = 0;
    stream_due_ = now;  // from the timer, after the RESULT of the request
    arm();
    return {};
}

void Net::service_stream(TimeUs now)
{
    if (stream_due_ > now) {
        return;
    }
    if (now >= stream_until_) {
        stream_due_ = kNever;
        return;
    }
    uint8_t value[kStreamLenMax] = {};
    const uint32_t n = ++stream_n_;
    for (size_t i = 0; i < std::min<size_t>(4, stream_len_); ++i) {
        value[i] = static_cast<uint8_t>(n >> (8 * i));
    }
    property(fr::proto::kPortDiag, kStreamProp, std::span<const uint8_t>(value, stream_len_), now);
    stream_due_ += stream_period_us_;
    if (stream_due_ <= now) {
        stream_due_ = now + stream_period_us_;  // a late timer skips the slots it missed
    }
}

TimeUs Net::next_bench_due() const
{
    return std::min(bench_.running ? bench_due_ : kNever, stream_due_);
}

}  // namespace fr::net
