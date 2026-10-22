// Duplicate filtering primitives of fr_net (spec 05 §5.8): the replay window with its WELCOME floor and
// broadcast watermark, the LATEST filter, and RFC 1982 comparisons.
#include "fr/net/window.hpp"
#include "tests/test.hpp"

namespace {

using fr::net::LatestFilter;
using fr::net::ReplayWindow;
using Verdict = ReplayWindow<128>::Verdict;

}  // namespace

TEST(net_serial_arithmetic)
{
    CHECK(fr::net::seq_after(2, 1));
    CHECK(!fr::net::seq_after(1, 1));
    CHECK(!fr::net::seq_after(1, 2));
    CHECK(fr::net::seq_after(0, 0xFFFFFFFF));  // wraps forward
    CHECK(fr::net::seq_after(0x80000000, 1));  // just under half the space ahead
    CHECK(!fr::net::seq_after(0x80000001, 1));  // half the space: behind
    CHECK(fr::net::epoch_after(1, 0xFFFF));
    CHECK(!fr::net::epoch_after(0xFFFF, 1));
    CHECK(fr::net::epoch_after(0x8000, 1));
}

TEST(net_window_floor_counts_as_received)
{
    ReplayWindow<128> w;
    w.reset(10);
    // At and below the floor: already seen (a WELCOME's ucast_floor); far below the window: OLD.
    CHECK(w.check_and_set(10) == Verdict::dup);
    CHECK(w.check_and_set(1) == Verdict::dup);
    w.reset(1000);
    CHECK(w.check_and_set(1000 - 128) == Verdict::old);
    CHECK(w.check_and_set(1000 - 127) == Verdict::dup);
    CHECK(w.check_and_set(1001) == Verdict::fresh);
    CHECK_EQ(w.top(), 1001u);
}

TEST(net_window_slides_and_detects_dups)
{
    ReplayWindow<128> w;
    w.reset(0);
    CHECK(w.check_and_set(1) == Verdict::fresh);
    CHECK(w.check_and_set(3) == Verdict::fresh);
    CHECK(w.check_and_set(3) == Verdict::dup);
    CHECK(w.check_and_set(2) == Verdict::fresh);  // late but inside the window
    CHECK(w.check_and_set(2) == Verdict::dup);
    // Slide across a word boundary and keep the history in the upper word.
    CHECK(w.check_and_set(70) == Verdict::fresh);
    CHECK(w.check_and_set(3) == Verdict::dup);
    CHECK(w.check_and_set(4) == Verdict::fresh);
    CHECK(w.check_and_set(200) == Verdict::fresh);
    CHECK(w.check_and_set(73) == Verdict::fresh);  // 127 below: the oldest seq the window still holds
    CHECK(w.check_and_set(70) == Verdict::old);    // 130 below
}

TEST(net_window_old_below_window_and_big_jumps)
{
    ReplayWindow<128> w;
    w.reset(0);
    CHECK(w.check_and_set(500) == Verdict::fresh);
    CHECK(w.check_and_set(372) == Verdict::old);   // 128 below
    CHECK(w.check_and_set(373) == Verdict::fresh);  // 127 below: inside, never seen
    // Half the space away is behind under serial arithmetic: OLD, and the history survives.
    CHECK(w.check_and_set(500 + 0x80000000u) == Verdict::old);
    CHECK(w.check_and_set(500) == Verdict::dup);
    // A jump beyond the window clears the history (everything older is OLD now).
    CHECK(w.check_and_set(10'000) == Verdict::fresh);
    CHECK(w.check_and_set(9'999) == Verdict::fresh);
    CHECK(w.check_and_set(500) == Verdict::old);
}

TEST(net_window_watermark)
{
    ReplayWindow<128> w;
    w.reset(50);  // bcast_base: a late joiner starts here (05 §5.9)
    CHECK_EQ(w.watermark(), 50u);
    w.check_and_set(51);
    CHECK_EQ(w.watermark(), 51u);
    w.check_and_set(53);  // 52 missing
    CHECK_EQ(w.watermark(), 51u);
    w.check_and_set(55);
    CHECK_EQ(w.watermark(), 51u);
    w.check_and_set(52);
    CHECK_EQ(w.watermark(), 53u);  // 54 is the oldest gap now
    w.check_and_set(54);
    CHECK_EQ(w.watermark(), 55u);
    // A gap that slides out of the window stops holding the watermark back.
    w.check_and_set(57);  // 56 missing
    for (uint32_t s = 58; s <= 56 + 127; ++s) {
        w.check_and_set(s);
    }
    CHECK_EQ(w.watermark(), 55u);  // 56 is the window's oldest seq
    w.check_and_set(56 + 128);     // and now 128 below the top: outside
    CHECK_EQ(w.watermark(), 56u + 128);
}

TEST(net_window_256_bits)
{
    ReplayWindow<256> w;
    w.reset(0);
    CHECK(w.check_and_set(300) == ReplayWindow<256>::Verdict::fresh);
    CHECK(w.check_and_set(45) == ReplayWindow<256>::Verdict::fresh);  // 255 below
    CHECK(w.check_and_set(44) == ReplayWindow<256>::Verdict::old);    // 256 below
    CHECK(w.check_and_set(45) == ReplayWindow<256>::Verdict::dup);
    CHECK(w.check_and_set(301) == ReplayWindow<256>::Verdict::fresh);
    CHECK(w.check_and_set(45) == ReplayWindow<256>::Verdict::old);
}

TEST(net_latest_filter)
{
    LatestFilter<2> f;
    CHECK(f.accept(1, 1, 5));
    CHECK(!f.accept(1, 1, 5));  // not newer
    CHECK(!f.accept(1, 1, 4));
    CHECK(f.accept(1, 1, 6));
    CHECK(f.accept(1, 2, 3));  // another kind is its own space
    CHECK(f.accept(2, 1, 1));  // a third pair evicts the pair updated longest ago: (1,1)
    CHECK(f.accept(1, 2, 4));  // (1,2) still tracked
    CHECK(!f.accept(1, 2, 4));
    CHECK(f.accept(1, 1, 2));  // (1,1) was evicted, so any seq is accepted again
    f.clear();
    CHECK(f.accept(1, 2, 1));
}

TEST(net_window_raise_floor_never_moves_back)
{
    ReplayWindow<128> w;
    w.reset(10);
    CHECK(w.check_and_set(12) == Verdict::fresh);  // 11 missing
    // A floor at or below top marks the floor and below, and leaves top and the newer seqs as they were.
    w.raise_floor(9);
    CHECK_EQ(w.top(), 12u);
    CHECK_EQ(w.watermark(), 10u);
    CHECK(w.check_and_set(12) == Verdict::dup);
    w.raise_floor(11);
    CHECK_EQ(w.top(), 12u);
    CHECK_EQ(w.watermark(), 12u);
    CHECK(w.check_and_set(11) == Verdict::dup);
    w.raise_floor(12);
    CHECK_EQ(w.top(), 12u);
    CHECK(w.check_and_set(13) == Verdict::fresh);
    // A floor after top acts as reset().
    w.raise_floor(300);
    CHECK_EQ(w.top(), 300u);
    CHECK_EQ(w.watermark(), 300u);
    CHECK(w.check_and_set(250) == Verdict::dup);
    CHECK(w.check_and_set(301) == Verdict::fresh);
    // Across the words: top 200 with everything below missing, floor 130 (bit 70).
    ReplayWindow<128> v;
    v.reset(0);
    CHECK(v.check_and_set(200) == Verdict::fresh);
    v.raise_floor(130);
    CHECK_EQ(v.top(), 200u);
    CHECK(v.check_and_set(130) == Verdict::dup);
    CHECK(v.check_and_set(73) == Verdict::dup);  // bit 127, the window's last
    CHECK(v.check_and_set(72) == Verdict::old);
    CHECK(v.check_and_set(131) == Verdict::fresh);
    CHECK(v.check_and_set(199) == Verdict::fresh);
    CHECK_EQ(v.watermark(), 131u);  // 132..198 still missing
    // A wild floor half the space away (a corrupt base) changes nothing.
    v.raise_floor(200 + 0x80000000u);
    CHECK_EQ(v.top(), 200u);
    CHECK(v.check_and_set(150) == Verdict::fresh);
}

TEST(net_window_restart_has_seen_nothing)
{
    // A new boot of a source: nothing below its first frame counts as received.
    ReplayWindow<128> w;
    w.restart(5);
    CHECK(w.check_and_set(6) == Verdict::fresh);
    CHECK(w.check_and_set(5) == Verdict::fresh);
    CHECK(w.check_and_set(3) == Verdict::fresh);
    CHECK(w.check_and_set(3) == Verdict::dup);
    CHECK_EQ(w.top(), 6u);
}
