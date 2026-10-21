// The TCP link's TX FIFO (fr/net/tx_fifo.hpp, design c3 §3 "Links"): whole `len u16 LE | envelope`
// records in, a byte stream out in contiguous runs, across the ring's end and across the wrap of its
// free-running counters (32 bits on target: once per 4 GiB of node-to-hub TCP in one boot).
#include <cstdint>
#include <vector>

#include "fr/net/tx_fifo.hpp"
#include "tests/test.hpp"

namespace {

/** The record `push` should produce for `env`: the stream the hub parses. */
void append_record(std::vector<uint8_t> &out, const std::vector<uint8_t> &env)
{
    out.push_back(static_cast<uint8_t>(env.size() & 0xFF));
    out.push_back(static_cast<uint8_t>(env.size() >> 8));
    out.insert(out.end(), env.begin(), env.end());
}

/** Takes up to `max` bytes the way the fr_net task does: one contiguous run, partly sent. */
template <class Fifo>
size_t drain(Fifo &f, std::vector<uint8_t> &out, size_t max)
{
    auto run = f.peek();
    const size_t n = std::min(run.size(), max);
    out.insert(out.end(), run.begin(), run.begin() + static_cast<long>(n));
    f.consume(n);
    return n;
}

}  // namespace

TEST(net_tx_fifo_records_survive_the_counter_wrap)
{
    // 64 bytes of ring, counters 40 bytes short of 2^32: the records cross both the ring's end and the
    // counters' wrap many times. A ring that is not a power of two jumps at the wrap (2^32 mod 6144 =
    // 4096) and misframes the stream; the power-of-two ring does not.
    fr::net::TxFifo<64, uint32_t> f(0xFFFFFFFFu - 40);
    std::vector<uint8_t> want;
    std::vector<uint8_t> got;
    uint8_t fill = 0;
    size_t pushed = 0;
    for (int i = 0; i < 400; ++i) {
        std::vector<uint8_t> env(static_cast<size_t>(1 + (i * 7) % 23));
        for (uint8_t &b : env) {
            b = fill++;
        }
        if (f.push(env)) {
            append_record(want, env);
            ++pushed;
        }
        // Partial sends of odd sizes, as send() returns them.
        drain(f, got, static_cast<size_t>(5 + i % 17));
    }
    while (drain(f, got, 64) > 0) {
    }
    CHECK(f.empty());
    CHECK(pushed > 200u);
    CHECK_EQ(got.size(), want.size());
    CHECK(got == want);
    CHECK_EQ(f.discard(), 0u);  // every record went out whole
}

TEST(net_tx_fifo_keeps_unsent_bytes_across_the_wrap)
{
    fr::net::TxFifo<64, uint32_t> f(0xFFFFFFFFu - 10);
    const std::vector<uint8_t> a(30, 0xAA);
    const std::vector<uint8_t> b(30, 0xBB);
    const std::vector<uint8_t> c(1, 0xCC);
    REQUIRE(f.push(a));      // 32 bytes, across the counters' wrap
    REQUIRE(f.push(b));      // 64: full
    CHECK(!f.push(c));       // never overwrites what has not been sent
    std::vector<uint8_t> got;
    size_t sent = drain(f, got, 20);  // part of the first record: a run that ends at the ring's end
    CHECK_EQ(sent, 11u);
    sent += drain(f, got, 20 - sent);
    REQUIRE_EQ(sent, 20u);
    CHECK(!f.push(std::vector<uint8_t>(19, 0xDD)));  // 21 bytes do not fit in 20
    REQUIRE(f.push(std::vector<uint8_t>(18, 0xEE)));  // 20 do
    while (drain(f, got, 64) > 0) {
    }
    std::vector<uint8_t> want;
    append_record(want, a);
    append_record(want, b);
    append_record(want, std::vector<uint8_t>(18, 0xEE));
    CHECK(got == want);
}

TEST(net_tx_fifo_discard_counts_the_frames_lost)
{
    fr::net::TxFifo<64, uint32_t> f(0xFFFFFFF0u);
    REQUIRE(f.push(std::vector<uint8_t>(10, 1)));
    REQUIRE(f.push(std::vector<uint8_t>(10, 2)));
    std::vector<uint8_t> got;
    drain(f, got, 5);  // the first record half sent: lost with the connection all the same
    CHECK_EQ(f.discard(), 2u);
    CHECK(f.empty());
    // The next connection starts on a record boundary.
    REQUIRE(f.push(std::vector<uint8_t>(3, 7)));
    got.clear();
    drain(f, got, 64);
    CHECK(got == (std::vector<uint8_t>{3, 0, 7, 7, 7}));
}
