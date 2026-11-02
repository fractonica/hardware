// fr.csi's pieces below the service (design csi-c1 D10, §12; fr/csi/csi.hpp): the wire record and block head byte
// for byte against §12's tables, the record ring (order, sequence numbers, wrap, drops when full, its byte counters
// across 2^32), the integer square root, the baseline's shift, and the motion feature on synthetic CSI: a quiet channel
// reads low, a varying one high, a format switch and a baseline reset re-seed it.
#include <cmath>
#include <vector>

#include "fr/csi/csi.hpp"
#include "tests/test.hpp"

namespace {

using fr::csi::Motion;
using fr::csi::RecordRing;
using fr::hal::CsiBbFormat;
using fr::hal::CsiRecord;

CsiRecord record(std::span<const int8_t> data, uint32_t t = 0)
{
    CsiRecord r{};
    r.t_us = t;
    r.rssi = -40;
    r.noise = -92;
    r.channel = 36;
    r.bb_format = CsiBbFormat::he_su;
    r.flags = fr::hal::kCsiFlagFirstWordInvalid | fr::hal::kCsiFlagMatched;
    r.mac = {0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc};
    r.data = data;
    return r;
}

TEST(csi_record_wire_bytes_golden)
{
    const int8_t data[] = {1, -2, 3, -4};
    CsiRecord r = record(data, 0x01020304);
    uint8_t out[64] = {};
    REQUIRE_EQ(fr::csi::encode_record(r, out), 22u);
    // §12: len u16 | t_us u32 | rssi i8 | noise i8 | channel u8 | bb_format u8 | flags u8 | reserved | mac 6 | data.
    CHECK_BYTES(std::span<const uint8_t>(out, 22),
                frt::from_hex("0400 04030201 d8 a4 24 04 05 00 123456789abc 01fe03fc"));
    CHECK_EQ(fr::csi::kRecordHeadBytes, 18u);
    CHECK_EQ(fr::csi::kBlockHeadBytes, 8u);
    // A buffer too short, data above kCsiDataMax: nothing.
    CHECK_EQ(fr::csi::encode_record(r, std::span<uint8_t>(out, 21)), 0u);
    std::vector<int8_t> big(fr::hal::kCsiDataMax + 2);
    r.data = big;
    std::vector<uint8_t> room(600);
    CHECK_EQ(fr::csi::encode_record(r, room), 0u);
}

TEST(csi_block_head_golden)
{
    uint8_t head[8] = {};
    fr::csi::encode_block_head(head, 2, 0x10);
    CHECK_BYTES(std::span<const uint8_t>(head, 8), frt::from_hex("02000000 10000000"));
    fr::csi::encode_block_head(head, 0x01020304, 0xA0B0C0D0);
    CHECK_BYTES(std::span<const uint8_t>(head, 8), frt::from_hex("04030201 d0c0b0a0"));
}

TEST(csi_ring_order_wrap_and_drops)
{
    std::vector<uint8_t> mem(256);
    RecordRing ring;
    ring.bind(mem.data(), mem.size());
    std::vector<int8_t> data(40, 7);  // 8 + 18 + 40 = 66 -> 68 bytes an entry: 3 fit in 256
    uint32_t got = 0;
    uint32_t next = 0;
    for (int round = 0; round < 20; ++round) {
        data[0] = static_cast<int8_t>(round);
        CHECK(ring.push(record(data, static_cast<uint32_t>(round))));
        RecordRing::View v;
        REQUIRE(ring.peek(v));
        CHECK_EQ(v.seq, next++);
        REQUIRE_EQ(v.wire.size(), 18u + 40u);
        CHECK_EQ(static_cast<int8_t>(v.wire[18]), static_cast<int8_t>(round));
        CHECK_EQ(fr::csi::get_u32le(v.wire.data() + 2), static_cast<uint32_t>(round));
        ring.pop();
        ++got;
    }
    CHECK_EQ(got, 20u);  // every entry went round the 256 bytes several times, wraps included
    // Full: the newest is dropped, its sequence number used all the same.
    CHECK(ring.push(record(data)));
    CHECK(ring.push(record(data)));
    CHECK(ring.push(record(data)));
    CHECK(!ring.push(record(data)));
    CHECK_EQ(ring.dropped(), 1u);
    CHECK_EQ(ring.offered(), 24u);
    RecordRing::View v;
    std::vector<uint32_t> seqs;
    while (ring.peek(v)) {
        seqs.push_back(v.seq);
        ring.pop();
    }
    CHECK(seqs == (std::vector<uint32_t>{20, 21, 22}));
    CHECK(ring.push(record(data)));
    REQUIRE(ring.peek(v));
    CHECK_EQ(v.seq, 24u);  // the gap of the dropped one shows
}

TEST(csi_ring_counters_cross_2_to_the_32)
{
    // The byte counters are u32s that run on for ever: at 127 HE20 records a second they pass 2^32 after about 18 h.
    // Started just below it, entries of every size (wrap markers included) go round 2^32 and come out as they went in.
    CHECK_EQ(RecordRing::usable(4096), 4096u);
    CHECK_EQ(RecordRing::usable(6000), 4096u);  // a power of two, whatever it is given
    CHECK_EQ(RecordRing::usable(63), 32u);
    std::vector<uint8_t> mem(1024);
    RecordRing ring;
    ring.bind(mem.data(), mem.size(), 0xFFFFFFFFu - 700);
    std::vector<int8_t> data;
    uint32_t next = 0;
    for (uint32_t round = 0; round < 64; ++round) {
        data.assign(10 + (round * 37) % 300, static_cast<int8_t>(round));
        CHECK(ring.push(record(data, round)));
        if (round % 3 == 2) {
            continue;  // leave one queued now and then: the head runs ahead of the tail across the wrap
        }
        RecordRing::View v;
        while (ring.peek(v)) {
            CHECK_EQ(v.seq, next);
            CHECK_EQ(fr::csi::get_u32le(v.wire.data() + 2), next);  // t_us: the round it was pushed in
            CHECK_EQ(v.wire.size(), 18u + 10u + (next * 37) % 300);
            CHECK_EQ(static_cast<int8_t>(v.wire[18]), static_cast<int8_t>(next));
            ring.pop();
            ++next;
        }
    }
    CHECK_EQ(next, 64u);
    CHECK_EQ(ring.dropped(), 0u);
    // Full after the wrap still drops the newest, counted.
    std::vector<int8_t> big(300, 1);
    while (ring.push(record(big))) {
    }
    CHECK_EQ(ring.dropped(), 1u);
}

TEST(csi_ring_unbound_drops)
{
    RecordRing ring;
    const int8_t d[2] = {1, 1};
    CHECK(!ring.push(record(d)));
    RecordRing::View v;
    CHECK(!ring.peek(v));
    CHECK_EQ(ring.dropped(), 1u);
}

TEST(csi_isqrt_and_shift)
{
    for (uint32_t v : {0u, 1u, 2u, 3u, 4u, 99u, 100u, 32768u, 65535u, 1u << 20, 0xFFFFFFFFu}) {
        const uint32_t r = fr::csi::isqrt(v);
        CHECK(static_cast<uint64_t>(r) * r <= v);
        CHECK(static_cast<uint64_t>(r + 1) * (r + 1) > v);
    }
    // 2 s of records, to the nearest power of two: 100 Hz -> 200 -> 256 (2.56 s), 10 Hz -> 20 -> 16.
    CHECK_EQ(Motion::shift_for(100), 8u);
    CHECK_EQ(Motion::shift_for(0), 8u);  // unknown: as 100 Hz
    CHECK_EQ(Motion::shift_for(10), 4u);
    CHECK_EQ(Motion::shift_for(50), 7u);
    CHECK_EQ(Motion::shift_for(1), 2u);    // clamped
    CHECK_EQ(Motion::shift_for(5000), 10u);
}

/** 57 subcarriers (HT20): amplitude `a` on each, the phase turning across them, plus `wobble` on subcarrier i. */
std::vector<int8_t> csi(double a, double wobble, int t)
{
    std::vector<int8_t> d(2 * 57);
    for (int i = 0; i < 57; ++i) {
        const double amp = a + wobble * std::sin(0.7 * i + 0.9 * t);
        const double ph = 0.3 * i;
        d[2 * i] = static_cast<int8_t>(std::lround(amp * std::sin(ph)));      // imaginary
        d[2 * i + 1] = static_cast<int8_t>(std::lround(amp * std::cos(ph)));  // real
    }
    return d;
}

uint16_t run_window(Motion &m, double a, double wobble, int from, int n)
{
    for (int t = from; t < from + n; ++t) {
        m.add(csi(a, wobble, t), false, 100);
    }
    return m.close();
}

TEST(csi_motion_quiet_low_varying_high)
{
    Motion m;
    CHECK_EQ(m.close(), 0u);  // no records
    run_window(m, 40, 0, 0, 200);  // seeds and settles
    const uint16_t quiet = run_window(m, 40, 0, 200, 100);
    CHECK_EQ(quiet, 0u);  // a channel that does not change
    // A little noise (a quiet room): low.
    const uint16_t still = run_window(m, 40, 1.0, 300, 100);
    // Someone walking: the amplitudes swing by a quarter.
    const uint16_t walking = run_window(m, 40, 10.0, 400, 100);
    CHECK(still < 1500);
    CHECK(walking > 2000);  // 16384 x 0.64 x 10 / 40: about 2,600
    CHECK(walking > 3 * still);
    CHECK_EQ(m.subcarriers(), 57u);
}

TEST(csi_motion_format_switch_and_reset)
{
    Motion m;
    run_window(m, 40, 0, 0, 50);
    // A legacy record (53 subcarriers) among HT20 ones is skipped: it does not count.
    std::vector<int8_t> lltf(2 * 53, 20);
    CHECK(!m.add(lltf, false, 100));
    CHECK_EQ(m.subcarriers(), 57u);
    // kSwitchAfter of them in a row move the baseline to them (the record that switches seeds it).
    for (uint32_t i = 1; i < Motion::kSwitchAfter; ++i) {
        CHECK(!m.add(lltf, false, 100));
    }
    CHECK_EQ(m.subcarriers(), 53u);
    CHECK(m.add(lltf, false, 100));
    m.close();
    // baseline_reset: the next record seeds (and does not count), the window after reads 0 on a steady channel.
    m.reset();
    CHECK_EQ(m.subcarriers(), 0u);
    std::vector<int8_t> other(2 * 53, 50);
    CHECK(!m.add(other, false, 100));
    CHECK(m.add(other, false, 100));
    CHECK_EQ(m.close(), 0u);
    // first_word_invalid: subcarriers 0 and 1 are left out (a huge value there changes nothing).
    std::vector<int8_t> spoiled = other;
    spoiled[0] = 127;
    spoiled[1] = -127;
    spoiled[2] = 127;
    spoiled[3] = 127;
    CHECK(m.add(spoiled, true, 100));
    CHECK_EQ(m.close(), 0u);
}

}  // namespace
