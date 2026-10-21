// Fuzz case generator and target registry (T-CODEC, spec 05 §5.18). The scheme is identical to
// packages/protocol/test/fuzz.ts, so a failing case index replays on either side: xorshift32 seeded
// with FNV-1a 32 of the target name; per case, if the corpus is non-empty and the next draw is odd, a
// mutation of a corpus entry, else a random buffer of 0..256 bytes. Targets fold their outcomes into
// a Digest; tests/fuzz_parity_test.cpp pins the digests the TS suite pins for 10^4 cases.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <span>
#include <string_view>
#include <vector>

#include "fr/wire.hpp"

namespace frf {

using Bytes = std::vector<uint8_t>;

constexpr uint32_t fnv1a32(std::string_view s)
{
    uint32_t h = 0x811C9DC5;
    for (const char c : s) {
        h = (h ^ static_cast<uint8_t>(c)) * 0x01000193;
    }
    return h;
}

class Rng
{
public:
    explicit Rng(uint32_t seed) : x_(seed ? seed : 1) {}

    uint32_t operator()()
    {
        x_ ^= x_ << 13;
        x_ ^= x_ >> 17;
        x_ ^= x_ << 5;
        return x_;
    }

private:
    uint32_t x_;
};

inline constexpr uint32_t kMaxRandomLen = 256;

class Cases
{
public:
    Cases(std::string_view target, const std::vector<Bytes> &corpus) : rng_(fnv1a32(target)), corpus_(corpus) {}

    // Every draw is its own statement: the order of rng() calls is the cross-language contract.
    const Bytes &next()
    {
        if (!corpus_.empty() && (rng_() & 1)) {
            const uint32_t pick = rng_() % static_cast<uint32_t>(corpus_.size());
            buf_ = corpus_[pick];
            mutate();
        } else {
            const uint32_t len = rng_() % (kMaxRandomLen + 1);
            buf_.resize(len);
            for (auto &b : buf_) {
                b = static_cast<uint8_t>(rng_() & 0xFF);
            }
        }
        return buf_;
    }

private:
    void mutate()
    {
        const uint32_t ops = 1 + rng_() % 4;
        for (uint32_t k = 0; k < ops; ++k) {
            const uint32_t op = rng_() % 5;
            if (op == 2) {
                const uint32_t i = rng_() % static_cast<uint32_t>(buf_.size() + 1);
                const uint32_t v = rng_() & 0xFF;
                buf_.insert(buf_.begin() + i, static_cast<uint8_t>(v));
                continue;
            }
            if (buf_.empty()) {
                continue;
            }
            const uint32_t i = rng_() % static_cast<uint32_t>(buf_.size());
            if (op == 0) {
                const uint32_t bit = rng_() % 8;
                buf_[i] ^= static_cast<uint8_t>(1u << bit);
            } else if (op == 1) {
                buf_[i] = static_cast<uint8_t>(rng_() & 0xFF);
            } else if (op == 3) {
                buf_.erase(buf_.begin() + i);
            } else {
                buf_.resize(i);
            }
        }
    }

    Rng rng_;
    const std::vector<Bytes> &corpus_;
    Bytes buf_;
};

/** FNV-1a over target outcomes; byte-for-byte the TS Digest. */
struct Digest {
    uint32_t h = 0x811C9DC5;

    void u8(uint8_t v) { h = (h ^ v) * 0x01000193; }
    void u32(uint32_t v)
    {
        for (int i = 0; i < 4; ++i) {
            u8(static_cast<uint8_t>(v >> (8 * i)));
        }
    }
    void ok() { u8(0); }
    void err(fr::wire::DecodeErr e) { u8(static_cast<uint8_t>(e)); }
};

using TargetFn = void (*)(std::span<const uint8_t> data, Digest &d);
using CorpusFn = std::vector<Bytes> (*)();

struct Target {
    const char *name;
    TargetFn fn;
    CorpusFn corpus;
};

inline std::vector<Target> &targets()
{
    static std::vector<Target> t;
    return t;
}

struct Registrar {
    Registrar(const char *name, TargetFn fn, CorpusFn corpus) { targets().push_back({name, fn, corpus}); }
};

inline const char *g_target = "";
inline uint64_t g_case = 0;
inline std::span<const uint8_t> g_input;

/** A broken invariant: prints the target, case index and input, then aborts. */
[[noreturn]] inline void fail(const char *what)
{
    std::fprintf(stderr, "fuzz %s case %llu: %s\n  input:", g_target, static_cast<unsigned long long>(g_case), what);
    for (const uint8_t b : g_input) {
        std::fprintf(stderr, " %02x", b);
    }
    std::fprintf(stderr, "\n");
    std::abort();
}

/** Runs n cases of a target and returns its digest. */
inline uint32_t run(const Target &t, uint64_t n)
{
    const std::vector<Bytes> corpus = t.corpus ? t.corpus() : std::vector<Bytes>{};
    Cases cases(t.name, corpus);
    Digest d;
    g_target = t.name;
    for (g_case = 0; g_case < n; ++g_case) {
        const Bytes &in = cases.next();
        g_input = in;
        t.fn(in, d);
    }
    return d.h;
}

/** "ac 02" -> bytes, for corpora; whitespace is ignored. */
inline Bytes from_hex(std::string_view h)
{
    Bytes out;
    int hi = -1;
    for (const char c : h) {
        int v;
        if (c >= '0' && c <= '9') {
            v = c - '0';
        } else if (c >= 'a' && c <= 'f') {
            v = c - 'a' + 10;
        } else if (c >= 'A' && c <= 'F') {
            v = c - 'A' + 10;
        } else {
            continue;
        }
        if (hi < 0) {
            hi = v;
        } else {
            out.push_back(static_cast<uint8_t>(hi << 4 | v));
            hi = -1;
        }
    }
    return out;
}

inline Bytes from_text(std::string_view s)
{
    return Bytes(s.begin(), s.end());
}

}  // namespace frf

/** FUZZ_TARGET(ident, "dotted.name", corpus_fn_or_nullptr) { ... use `data` and `d` ... } */
#define FUZZ_TARGET(ident, name, corpus)                                                         \
    static void frf_target_##ident(std::span<const uint8_t> data, ::frf::Digest &d);             \
    static const ::frf::Registrar frf_reg_##ident{name, frf_target_##ident, corpus};             \
    static void frf_target_##ident(std::span<const uint8_t> data, ::frf::Digest &d)
