// AudioInService and AudioOutService (design audio-a1 D1-D5, §11) against FakeCore, a fake microphone and amplifier,
// and a loopback hub that speaks the stream wire format: the commands' answers, the record stream's blocks (seq,
// first_sample, PCM), the ends and their figures, the ring's drop accounting, the stall hook, level_get, the warm-up
// and the blocker's glide after a start, the self-test on fr_audio, the tone, the play GET (with and without PSRAM),
// the full DMA while the microphone paces fr_audio, the drain without sleeping, the stuck-play backstop, replacement
// and stop, and the counters of diag `stats audio`; fr.audio_in 1.1's on-board monitor (design audio-a2 D3): the same
// samples in order on the amplifier within 50 ms, its ends (done, stopped, busy), the commands' refusals, the latency
// cap against a source faster than the sink, and a monitor beside a stream. The Engine runs by hand (set_manual): each
// round is 10 ms of the amplifier's playing, one fr_audio and one fr_stream pass, then 10 ms of core time.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "fr/audio/engine.hpp"
#include "fr/audio/rt.hpp"
#include "fr/services/audio_in_service.hpp"
#include "fr/services/audio_out_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using frt::RecordingSink;

constexpr uint8_t kMicPort = 3;
constexpr uint8_t kSpkPort = 4;

/**
 * A microphone whose sample n since start() is n as a 16-bit value (left-justified), or `gen(n)` when set, as fast as
 * it is read (240 a read); with `clock` set, in real time on that clock instead: a read returns what is due since
 * start() (sample n at n / rate), as a DMA would.
 */
class FakeMic final : public fr::hal::AudioSource
{
public:
    fr::Status init(fr::Core &) override { return {}; }
    fr::Status start(uint32_t hz) override
    {
        if (fail_start) {
            return std::unexpected(fr::Err::failed);
        }
        rate = hz;
        n = 0;
        t0 = clock != nullptr ? clock->now() : 0;
        ++starts;
        return {};
    }
    std::expected<size_t, fr::Err> read(std::span<int32_t> frames, uint32_t) override
    {
        if (rate == 0 || fail_read) {
            return std::unexpected(fr::Err::failed);
        }
        size_t k = std::min<size_t>(frames.size(), 240);
        if (clock != nullptr) {
            const uint64_t due = static_cast<uint64_t>(clock->now() - t0) * rate / 1'000'000;
            k = static_cast<size_t>(std::min<uint64_t>(frames.size(), due - n));
        }
        for (size_t i = 0; i < k; ++i, ++n) {
            frames[i] = gen ? gen(n) : static_cast<int32_t>(static_cast<uint32_t>(static_cast<uint16_t>(n)) << 16);
        }
        return k;
    }
    fr::Status stop() override
    {
        if (rate != 0) {
            ++stops;
        }
        rate = 0;
        return {};
    }
    uint32_t sample_hz() const override { return rate; }
    uint32_t max_sample_hz() const override { return 48000; }
    uint8_t bits() const override { return 24; }
    uint32_t overruns() const override { return lost; }
    fr::hal::Selftest selftest() override
    {
        ++selftests;  // the service never calls it: fr_audio runs its own self-test
        return {true, "fake mic"};
    }

    std::function<int32_t(uint32_t)> gen;
    const FakeCore *clock = nullptr;
    fr::TimeUs t0 = 0;
    uint32_t rate = 0;
    uint32_t n = 0;
    uint32_t lost = 0;
    int starts = 0;
    int stops = 0;
    int selftests = 0;
    bool fail_start = false;
    bool fail_read = false;
};

/**
 * An amplifier with a DMA of kDma samples that plays `rate` samples a second as the rig's rounds tick: write() takes
 * what fits (0 when full), every sample it took is kept, and a tick that finds less queued than it plays counts as
 * starved (the DMA ran dry while started). With `clock` set, each tick also records when it played up to which sample.
 */
class FakeAmp final : public fr::hal::AudioSink
{
public:
    static constexpr size_t kDma = 6 * 240;

    fr::Status init(fr::Core &) override { return {}; }
    fr::Status start(uint32_t hz) override
    {
        rate = hz;
        queued = 0;
        ++starts;
        return {};
    }
    std::expected<size_t, fr::Err> write(std::span<const int16_t> s, uint32_t) override
    {
        if (rate == 0) {
            return std::unexpected(fr::Err::failed);
        }
        const size_t k = std::min(s.size(), kDma - queued);
        written.insert(written.end(), s.begin(), s.begin() + static_cast<long>(k));
        queued += k;
        return k;
    }
    fr::Status stop(uint32_t timeout_ms) override
    {
        if (rate != 0) {
            ++stops;
        }
        max_stop_ms = std::max(max_stop_ms, timeout_ms);
        queued_at_stop = queued;
        rate = 0;
        return {};
    }
    uint32_t sample_hz() const override { return rate; }
    uint32_t max_sample_hz() const override { return 48000; }
    uint8_t bits() const override { return 16; }
    uint32_t underruns() const override { return late; }
    fr::hal::Selftest selftest() override { return {true, "fake amp"}; }

    /** `ms` of playing: the DMA gives up that many samples. */
    void tick(uint32_t ms)
    {
        if (rate == 0) {
            return;
        }
        const size_t play = rate * ms / 1000;
        if (queued < play) {
            ++starved;
            starved_at.push_back(played + queued);
        }
        played += std::min(queued, play);
        queued -= std::min(queued, play);
        if (clock != nullptr) {
            plays.emplace_back(clock->now(), played);
        }
    }

    /** When written sample `k` had played (the end of the tick that played it); -1 if it has not. */
    fr::TimeUs played_at(size_t k) const
    {
        for (const auto &[t, upto] : plays) {
            if (upto > k) {
                return t;
            }
        }
        return -1;
    }

    uint32_t rate = 0;
    size_t queued = 0;
    std::vector<int16_t> written;
    int starts = 0;
    int stops = 0;
    int starved = 0;
    uint32_t max_stop_ms = 0;
    size_t queued_at_stop = 0;  // what the DMA still held when stop() came
    uint32_t late = 0;          // underruns(): the driver's starved DMA buffers, as the test sets them
    const FakeCore *clock = nullptr;
    size_t played = 0;
    std::vector<size_t> starved_at;  // where each starved tick ran dry (samples played by then)
    std::vector<std::pair<fr::TimeUs, size_t>> plays;  // (tick time, samples played since the first start)
};

/** One block of a record stream as the hub received it. */
struct Block {
    uint32_t seq;
    uint32_t first;
    std::vector<int16_t> pcm;
};

/**
 * A loopback hub for one connection: a POST is read as the record wire format (chunks, each a block) and answered 200
 * {"samples":N} at its end, or `early_status` right after its head; a GET is answered with `body`.
 */
class Hub
{
public:
    Hub()
    {
        fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        socklen_t len = sizeof(a);
        if (fd_ < 0 || ::bind(fd_, reinterpret_cast<sockaddr *>(&a), sizeof(a)) != 0 || ::listen(fd_, 4) != 0 ||
            ::getsockname(fd_, reinterpret_cast<sockaddr *>(&a), &len) != 0) {
            frt::fail(__FILE__, __LINE__, "no loopback listener");
        }
        port = ntohs(a.sin_port);
    }
    ~Hub()
    {
        if (thread_.joinable()) {
            thread_.join();
        }
        ::close(fd_);
    }

    void serve_post(int early_status = 0)
    {
        thread_ = std::thread([this, early_status] { post_conn(early_status); });
    }
    void serve_get(std::string reply)
    {
        thread_ = std::thread([this, reply = std::move(reply)] {
            const int c = ::accept(fd_, nullptr, nullptr);
            if (c < 0) {
                return;
            }
            head = read_head(c);
            ::send(c, reply.data(), reply.size(), 0);
            ::shutdown(c, SHUT_WR);
            char buf[256];
            while (::recv(c, buf, sizeof(buf), 0) > 0) {
            }
            ::close(c);
        });
    }
    void join()
    {
        if (thread_.joinable()) {
            thread_.join();
        }
    }

    std::vector<Block> blocks() const
    {
        const std::lock_guard<std::mutex> g(m_);
        return blocks_;
    }
    size_t block_count() const
    {
        const std::lock_guard<std::mutex> g(m_);
        return blocks_.size();
    }

    uint16_t port = 0;
    std::string head;
    bool ended = false;  // the zero-length chunk came

private:
    /** Reads up to the blank line; what follows stays in buf_. */
    std::string read_head(int c)
    {
        char tmp[4096];
        while (buf_.find("\r\n\r\n") == std::string::npos) {
            const ssize_t n = ::recv(c, tmp, sizeof(tmp), 0);
            if (n <= 0) {
                return {};
            }
            buf_.append(tmp, static_cast<size_t>(n));
        }
        const size_t end = buf_.find("\r\n\r\n") + 4;
        std::string h = buf_.substr(0, end);
        buf_.erase(0, end);
        return h;
    }
    /** At least `n` bytes in buf_; false at the close. */
    bool need(int c, size_t n)
    {
        char tmp[8192];
        while (buf_.size() < n) {
            const ssize_t k = ::recv(c, tmp, sizeof(tmp), 0);
            if (k <= 0) {
                return false;
            }
            buf_.append(tmp, static_cast<size_t>(k));
        }
        return true;
    }
    void post_conn(int early_status)
    {
        const int c = ::accept(fd_, nullptr, nullptr);
        if (c < 0) {
            return;
        }
        head = read_head(c);
        if (early_status != 0) {
            const std::string r = "HTTP/1.1 " + std::to_string(early_status) + " Refused\r\nContent-Length: 0\r\n\r\n";
            ::send(c, r.data(), r.size(), 0);
            ::shutdown(c, SHUT_WR);
            char tmp[4096];
            while (::recv(c, tmp, sizeof(tmp), 0) > 0) {
            }
            ::close(c);
            return;
        }
        uint32_t samples = 0;
        for (;;) {
            size_t eol = std::string::npos;
            while ((eol = buf_.find("\r\n")) == std::string::npos) {
                if (!need(c, buf_.size() + 1)) {
                    ::close(c);
                    return;
                }
            }
            const size_t len = std::stoul(buf_.substr(0, eol), nullptr, 16);
            buf_.erase(0, eol + 2);
            if (!need(c, len + 2)) {
                ::close(c);
                return;
            }
            if (len == 0) {
                ended = true;
                buf_.erase(0, 2);
                break;
            }
            Block b{};
            std::memcpy(&b.seq, buf_.data(), 4);  // little-endian host
            std::memcpy(&b.first, buf_.data() + 4, 4);
            b.pcm.resize((len - 8) / 2);
            std::memcpy(b.pcm.data(), buf_.data() + 8, len - 8);
            samples = b.first + static_cast<uint32_t>(b.pcm.size());
            buf_.erase(0, len + 2);
            const std::lock_guard<std::mutex> g(m_);
            blocks_.push_back(std::move(b));
        }
        const std::string body = "{\"samples\":" + std::to_string(samples) + "}";
        const std::string r = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
                              std::to_string(body.size()) + "\r\n\r\n" + body;
        ::send(c, r.data(), r.size(), 0);
        ::shutdown(c, SHUT_WR);
        char tmp[256];
        while (::recv(c, tmp, sizeof(tmp), 0) > 0) {
        }
        ::close(c);
    }

    int fd_ = -1;
    std::thread thread_;
    std::string buf_;
    mutable std::mutex m_;
    std::vector<Block> blocks_;
};

class TestHost final : public fr::audio::StreamHost
{
public:
    bool endpoint(fr::audio::Endpoint &out) override
    {
        if (port == 0) {
            return false;
        }
        out.ipv4 = 0x7F000001;
        out.port = port;
        return true;
    }
    const char *device_id() const override { return "a1b2c3d4e5f6"; }
    uint16_t port = 0;
};

fr::cap::AudioInConfig plain_in()
{
    fr::cap::AudioInConfig c{};
    c.gain_db = 0;  // the stream carries the fake mic's counter as it is
    c.hpf_hz = 0;
    return c;
}

/** The services on one FakeCore, their Engine by hand, the stream host registered. */
struct Rig {
    explicit Rig(fr::cap::AudioInConfig in = plain_in(), fr::cap::AudioOutConfig out = {}) : mic(src, in), spk(amp, out)
    {
        fr::audio::engine().set_manual(true);
        fr::audio::set_stream_host(&host);
        mic.attach(kMicPort, "mic", sink);
        spk.attach(kSpkPort, "spk", sink);
    }
    ~Rig() { fr::audio::set_stream_host(nullptr); }

    bool init() { return mic.init(core) && spk.init(core); }

    /** Rounds until `done` (or `max` of them): the amplifier plays 10 ms, fr_audio, fr_stream, 10 ms of core time. */
    bool run(const std::function<bool()> &done, int max = 2000)
    {
        for (int i = 0; i < max; ++i) {
            amp.tick(10);
            fr::audio::engine().audio_once();
            fr::audio::engine().stream_once();
            core.advance_ms(10);
            if (done()) {
                return true;
            }
        }
        return false;
    }

    std::vector<RecordingSink::Emission> events(uint8_t port) const
    {
        std::vector<RecordingSink::Emission> out;
        for (const auto &e : sink.events()) {
            if (e.port == port) {
                out.push_back(e);
            }
        }
        return out;
    }
    std::vector<uint64_t> props(uint8_t port, uint8_t id) const
    {
        std::vector<uint64_t> out;
        for (const auto &e : sink.properties()) {
            if (e.port == port && e.id == id) {
                out.push_back(frt::field_u(e.bytes, 1));
            }
        }
        return out;
    }
    bool ended(uint8_t port) const { return !events(port).empty(); }

    FakeCore core;
    RecordingSink sink{core};
    TestHost host;
    FakeMic src;
    FakeAmp amp;
    fr::AudioInService mic;
    fr::AudioOutService spk;
};

/** stream_ended / play_done fields 1-4. */
struct End {
    uint64_t id, reason, a, b;
};
End end_of(const RecordingSink::Emission &e)
{
    return {frt::field_u(e.bytes, 1), frt::field_u(e.bytes, 2), frt::field_u(e.bytes, 3), frt::field_u(e.bytes, 4)};
}

constexpr uint64_t kInStopped = 0, kInDone = 1, kInNetLost = 2;
constexpr uint64_t kOutDone = 0, kOutStopped = 1, kOutNetLost = 2;
constexpr uint32_t kWarmup = 16000 * fr::AudioInService::kWarmupMs / 1000;  // 1600 frames dropped at start

/** The no-PSRAM ring sizes for a scope (the Mac has PSRAM otherwise). */
class NoPsram
{
public:
    NoPsram() { fr::audio::Rt::set_psram(false); }
    ~NoPsram() { fr::audio::Rt::set_psram(true); }
    NoPsram(const NoPsram &) = delete;
    NoPsram &operator=(const NoPsram &) = delete;
};

}  // namespace

TEST(audio_in_answers_rates_busy_and_no_endpoint)
{
    Rig r;
    REQUIRE(r.init());
    fr::cap::AudioInStreamStartArgs a{.stream_id = 1, .seconds = 1, .has_sample_hz = true, .sample_hz = 11025};
    CHECK(r.mic.stream_start(a).error() == fr::Err::invalid_args);
    a.sample_hz = 96000;
    CHECK(r.mic.stream_start(a).error() == fr::Err::invalid_args);
    a.has_sample_hz = false;
    const auto ok = r.mic.stream_start(a);  // no endpoint (host.port 0): OK, then net_lost
    REQUIRE(ok);
    CHECK_EQ(ok->sample_hz, 16000u);
    CHECK(r.mic.streaming());
    CHECK(r.mic.stream_start(a).error() == fr::Err::busy);
    CHECK(r.mic.stream_stop({.stream_id = 2}).error() == fr::Err::not_found);
    REQUIRE(r.run([&] { return r.ended(kMicPort); }));
    const End e = end_of(r.events(kMicPort)[0]);
    CHECK_EQ(e.id, 1u);
    CHECK_EQ(e.reason, kInNetLost);
    CHECK_EQ(e.a, 0u);
    CHECK_EQ(e.b, 0u);
    CHECK(!r.mic.streaming());
    CHECK((r.props(kMicPort, 2) == std::vector<uint64_t>{1, 0}));  // streaming true, then false
    // The microphone was started for the capture and is stopped again.
    REQUIRE(r.run([&] { return r.src.rate == 0; }, 10));
    CHECK(r.mic.stream_start(a).has_value());  // free again
}

TEST(audio_in_streams_a_second_exactly)
{
    Rig r;
    REQUIRE(r.init());
    Hub hub;
    r.host.port = hub.port;
    hub.serve_post();
    REQUIRE(r.mic.stream_start({.stream_id = 7, .seconds = 1}));
    REQUIRE(r.run([&] { return r.ended(kMicPort); }));
    hub.join();
    CHECK(hub.head.starts_with("POST /v1/audio/in/7 HTTP/1.1\r\n"));
    CHECK(hub.head.find("Host: 127.0.0.1:" + std::to_string(hub.port) + "\r\n") != std::string::npos);
    CHECK(hub.head.find("Transfer-Encoding: chunked\r\n") != std::string::npos);
    CHECK(hub.head.find("Connection: close\r\n") != std::string::npos);
    CHECK(hub.head.find("X-Fr-Device: a1b2c3d4e5f6\r\n") != std::string::npos);
    CHECK(hub.head.find("X-Fr-Format: s16le;rate=16000;ch=1\r\n") != std::string::npos);
    CHECK(hub.ended);
    const std::vector<Block> blocks = hub.blocks();
    REQUIRE_EQ(blocks.size(), 10u);
    bool pcm_ok = true;
    for (size_t i = 0; i < blocks.size(); ++i) {
        CHECK_EQ(blocks[i].seq, i);
        CHECK_EQ(blocks[i].first, i * 1600);
        CHECK_EQ(blocks[i].pcm.size(), 1600u);
        for (size_t k = 0; k < blocks[i].pcm.size(); ++k) {
            // The mic's counter after its first 100 ms (dropped: the part's power-up); hpf_hz 0: no glide.
            pcm_ok = pcm_ok && blocks[i].pcm[k] == static_cast<int16_t>(kWarmup + blocks[i].first + k);
        }
    }
    CHECK(pcm_ok);
    const End e = end_of(r.events(kMicPort)[0]);
    CHECK_EQ(e.id, 7u);
    CHECK_EQ(e.reason, kInDone);
    CHECK_EQ(e.a, 16000u);
    CHECK_EQ(e.b, 0u);
    CHECK_EQ(r.mic.last_status(), 200);
    CHECK_EQ(r.mic.last_hub_samples(), 16000u);
    // level at level_hz 5: windows of 3200 samples, five in the second.
    const size_t levels = r.props(kMicPort, 1).size();
    CHECK(levels >= 4 && levels <= 5);
    CHECK(r.mic.level() > -900);
}

TEST(audio_in_overflow_drops_the_oldest_blocks)
{
    Rig r;
    REQUIRE(r.init());
    Hub hub;
    r.host.port = hub.port;
    hub.serve_post();
    REQUIRE(r.mic.stream_start({.stream_id = 3, .seconds = 3}));
    fr::audio::engine().stream_once();  // the ring is reset, the POST connected
    // Three seconds captured while nothing is sent: 30 blocks into a ring of 22.
    for (int i = 0; i < 400; ++i) {
        fr::audio::engine().audio_once();
    }
    REQUIRE(r.run([&] { return r.ended(kMicPort); }));
    hub.join();
    const End e = end_of(r.events(kMicPort)[0]);
    CHECK_EQ(e.reason, kInDone);
    CHECK_EQ(e.a, 48000u);
    CHECK_EQ(e.b, 8u * 1600);
    const std::vector<Block> blocks = hub.blocks();
    REQUIRE_EQ(blocks.size(), 22u);
    CHECK_EQ(blocks.front().first, 8u * 1600);  // blocks 0-7 went
    CHECK_EQ(blocks.back().first, 29u * 1600);
    for (size_t i = 0; i < blocks.size(); ++i) {
        CHECK_EQ(blocks[i].seq, i);  // the chunks sent, without gaps
        CHECK_EQ(blocks[i].pcm.front(), static_cast<int16_t>(kWarmup + blocks[i].first));
    }
}

TEST(audio_in_stall_hook_drops_whole_blocks_and_keeps_time)
{
    Rig r;
    REQUIRE(r.init());
    CHECK(fr::audio::engine().stall(1000).error() == fr::Err::not_found);  // no stream
    Hub hub;
    r.host.port = hub.port;
    hub.serve_post();
    REQUIRE(r.mic.stream_start({.stream_id = 4, .seconds = 3}));
    REQUIRE(r.run([&] { return hub.block_count() >= 2; }));
    CHECK(fr::audio::engine().stall(0).error() == fr::Err::invalid_args);
    REQUIRE(fr::audio::engine().stall(1000));
    REQUIRE(r.run([&] { return r.ended(kMicPort); }));
    hub.join();
    const End e = end_of(r.events(kMicPort)[0]);
    CHECK_EQ(e.reason, kInDone);
    CHECK_EQ(e.a, 48000u);
    CHECK_EQ(e.b, 16000u);  // 1 s: ten whole blocks
    const std::vector<Block> blocks = hub.blocks();
    REQUIRE_EQ(blocks.size(), 20u);
    uint32_t gaps = 0;
    for (size_t i = 1; i < blocks.size(); ++i) {
        CHECK_EQ(blocks[i].seq, i);
        const uint32_t step = blocks[i].first - blocks[i - 1].first;
        if (step != 1600) {
            CHECK_EQ(step, 1600u + 16000);
            ++gaps;
        }
    }
    CHECK_EQ(gaps, 1u);
    CHECK_EQ(blocks.back().first + blocks.back().pcm.size(), 48000u);
}

TEST(audio_in_stop_and_early_refusal)
{
    {
        Rig r;
        REQUIRE(r.init());
        Hub hub;
        r.host.port = hub.port;
        hub.serve_post();
        REQUIRE(r.mic.stream_start({.stream_id = 5, .seconds = 0}));  // until stream_stop
        REQUIRE(r.run([&] { return hub.block_count() >= 3; }));
        REQUIRE(r.mic.stream_stop({.stream_id = 5}));
        REQUIRE(r.run([&] { return r.ended(kMicPort); }));
        hub.join();
        const End e = end_of(r.events(kMicPort)[0]);
        CHECK_EQ(e.reason, kInStopped);
        const std::vector<Block> blocks = hub.blocks();
        REQUIRE(!blocks.empty());
        CHECK_EQ(e.a, blocks.back().first + blocks.back().pcm.size());  // the last block may be short
        CHECK_EQ(e.b, 0u);
    }
    {
        Rig r;
        REQUIRE(r.init());
        Hub hub;
        r.host.port = hub.port;
        hub.serve_post(404);  // a stream id the hub did not issue
        REQUIRE(r.mic.stream_start({.stream_id = 6, .seconds = 5}));
        REQUIRE(r.run([&] { return r.ended(kMicPort); }, 300));
        hub.join();
        const End e = end_of(r.events(kMicPort)[0]);
        CHECK_EQ(e.reason, kInNetLost);
        CHECK_EQ(r.mic.last_status(), 404);
        CHECK(e.a < 5u * 16000);
    }
}

TEST(audio_in_level_get_runs_an_idle_microphone)
{
    fr::cap::AudioInConfig c = plain_in();
    Rig r(c);
    REQUIRE(r.init());
    REQUIRE(r.run([&] { return r.src.stops == 1; }, 5));  // fr_audio's self-test at init: started, one read, stopped
    const auto first = r.mic.level_get();
    REQUIRE(first);
    CHECK_EQ(first->dbfs_x10, -900);  // nothing measured yet
    CHECK_EQ(first->clipping, 0u);
    REQUIRE(r.run([&] { return r.src.starts == 2 && r.src.rate == 0; }));  // 100 ms warm-up + 200 ms, then stopped
    CHECK(r.src.n >= kWarmup + 3200 && r.src.n < kWarmup + 3200 + 240);  // hpf_hz 0: no glide
    const auto again = r.mic.level_get();
    REQUIRE(again);
    CHECK(again->dbfs_x10 > -900);
    CHECK(again->peak_dbfs_x10 >= again->dbfs_x10);
    CHECK(!r.props(kMicPort, 1).empty());  // `level` STATEs while it ran
    CHECK_EQ(r.src.stops, 2);
}

/**
 * The bench's INMP441 start-up as a source (16 kHz, 2026-11-02): 100 ms of saturating garbage, then an offset decaying
 * from about 30,000 (16-bit, before the gain) with tau 100 ms, under a 1 kHz tone of amplitude 100: the room.
 */
int32_t startup_mic(uint32_t n)
{
    const double t = n / 16000.0;
    double v = 0;
    if (n < 1600) {
        v = (n & 1) != 0 ? 30000 : -30000;
    } else {
        v = 30000.0 * std::exp(-t / 0.1) + 100.0 * std::sin(2.0 * 3.14159265358979 * 1000.0 * t);
    }
    return static_cast<int32_t>(std::lround(v)) * 65536;
}

TEST(audio_in_warm_up_and_glide_remove_the_part_s_start_up)
{
    fr::cap::AudioInConfig c{};  // gain 12 dB, hpf 20 Hz, level_hz 5: the profile's
    Rig r(c);
    r.src.gen = startup_mic;
    REQUIRE(r.init());
    Hub hub;
    r.host.port = hub.port;
    hub.serve_post();
    REQUIRE(r.mic.stream_start({.stream_id = 8, .seconds = 2}));
    REQUIRE(r.run([&] { return r.ended(kMicPort); }));
    hub.join();
    const std::vector<Block> blocks = hub.blocks();
    REQUIRE_EQ(blocks.size(), 20u);
    // The stream's sample 0 is the first kept one, 100 ms after the start; nothing clips (the blocker is primed).
    CHECK_EQ(blocks.front().first, 0u);
    int peak = 0;
    for (const Block &b : blocks) {
        for (int16_t v : b.pcm) {
            peak = std::max(peak, std::abs(static_cast<int>(v)));
        }
    }
    CHECK(peak < 32767);
    // After the warm-up and the glide (stream time 500 ms on) every 100 ms block is the room's: no offset.
    for (size_t i = 5; i < blocks.size(); ++i) {
        double sum = 0;
        for (int16_t v : blocks[i].pcm) {
            sum += v;
        }
        CHECK(std::abs(sum / static_cast<double>(blocks[i].pcm.size())) < 50.0);
    }
    const auto lv = r.mic.level_get();  // the stream's figures: the meter started after the glide
    REQUIRE(lv);
    CHECK_EQ(lv->clipping, 0u);
    // The tone: 100 x 3.98 (12 dB) peak, RMS 281.5, -41.3 dBFS.
    CHECK(lv->dbfs_x10 >= -423 && lv->dbfs_x10 <= -403);
}

TEST(audio_in_level_get_measures_the_room_after_the_start_up)
{
    fr::cap::AudioInConfig c{};
    Rig r(c);
    r.src.gen = startup_mic;
    REQUIRE(r.init());
    REQUIRE(r.run([&] { return r.src.stops == 1; }, 5));  // the self-test at init
    REQUIRE(r.mic.level_get());
    REQUIRE(r.run([&] { return r.src.starts == 2 && r.src.rate == 0; }));
    // 100 ms warm-up, 500 ms glide, then one 200 ms window: 12,800 frames read, on fr_audio's time.
    CHECK(r.src.n >= 12800 && r.src.n < 12800 + 240);
    const auto lv = r.mic.level_get();
    REQUIRE(lv);
    CHECK_EQ(lv->clipping, 0u);  // the saturating warm-up is not counted
    CHECK(lv->dbfs_x10 >= -423 && lv->dbfs_x10 <= -403);
    CHECK(lv->peak_dbfs_x10 >= lv->dbfs_x10 && lv->peak_dbfs_x10 <= -370);
}

TEST(audio_in_selftest_runs_on_fr_audio_never_on_the_core_task)
{
    Rig r;
    REQUIRE(r.init());
    const fr::hal::Selftest before = r.mic.selftest();  // fr_audio has not run yet
    CHECK(!before.ok);
    CHECK_EQ(r.src.starts, 0);
    REQUIRE(r.run([&] { return r.src.stops >= 1; }, 5));
    CHECK(r.mic.selftest().ok);  // the init run's result; another one is asked for
    REQUIRE(r.run([&] { return r.src.stops >= 2; }, 5));
    // A level_get asked for, fr_audio not yet round: the core task still leaves the source alone.
    REQUIRE(r.mic.level_get());
    CHECK(r.mic.selftest().ok);
    CHECK_EQ(r.src.selftests, 0);
    REQUIRE(r.run([&] { return r.src.rate == 0 && r.src.stops >= 3; }));  // the run and the test: one start
    // A source that does not start fails the next run.
    r.src.fail_start = true;
    static_cast<void>(r.mic.selftest());
    REQUIRE(r.run([&] { return true; }, 1));
    const fr::hal::Selftest bad = r.mic.selftest();
    CHECK(!bad.ok);
    CHECK(std::string(bad.detail).find("does not start") != std::string::npos);
    CHECK_EQ(r.src.selftests, 0);
}

TEST(audio_out_tone_volume_and_ends)
{
    Rig r;
    REQUIRE(r.init());
    CHECK(r.spk.tone({.freq_hz = 8000, .ms = 100}).error() == fr::Err::invalid_args);  // Nyquist at 16 kHz
    REQUIRE(r.spk.tone({.freq_hz = 1000, .ms = 100}));
    CHECK(r.spk.playing());
    REQUIRE(r.run([&] { return r.ended(kSpkPort); }));
    // The DMA plays out what it holds (up to 1440 frames, 90 ms) before the sink stops, on a deadline fr_audio looked
    // at, never by sleeping in stop().
    REQUIRE(r.run([&] { return r.amp.rate == 0; }, 20));
    CHECK_EQ(r.amp.queued_at_stop, 0u);
    CHECK_EQ(r.amp.max_stop_ms, 0u);
    REQUIRE_EQ(r.amp.written.size(), 1600u);
    int peak = 0;
    for (int16_t s : r.amp.written) {
        peak = std::max(peak, std::abs(static_cast<int>(s)));
    }
    CHECK(peak >= 11700 && peak <= 11796);  // volume 60: 0.36 of full scale
    End e = end_of(r.events(kSpkPort)[0]);
    CHECK_EQ(e.id, 0u);
    CHECK_EQ(e.reason, kOutDone);
    CHECK_EQ(e.b, 1600u);
    CHECK(!r.spk.playing());
    CHECK((r.props(kSpkPort, 1) == std::vector<uint64_t>{1, 0}));
    CHECK_EQ(r.amp.stops, 1);

    // A tone of its own volume, replaced by another before its end: stopped, then done.
    r.sink.clear();
    r.amp.written.clear();
    REQUIRE(r.spk.tone({.freq_hz = 440, .ms = 2000, .has_volume = true, .volume = 100}));
    REQUIRE(r.run([&] { return r.amp.written.size() > 3000; }));
    REQUIRE(r.spk.tone({.freq_hz = 880, .ms = 50}));
    REQUIRE(r.run([&] { return r.events(kSpkPort).size() == 2; }));
    const auto ev = r.events(kSpkPort);
    CHECK_EQ(end_of(ev[0]).reason, kOutStopped);
    CHECK(end_of(ev[0]).b > 3000u);
    CHECK_EQ(end_of(ev[1]).reason, kOutDone);
    CHECK_EQ(end_of(ev[1]).b, 800u);
    CHECK((r.props(kSpkPort, 1) == std::vector<uint64_t>{1, 0}));  // playing stays true across the replacement
}

TEST(audio_out_plays_the_hub_pcm_bit_exact_at_volume_100)
{
    Rig r;
    REQUIRE(r.init());
    REQUIRE(r.spk.set_volume({.volume = 100}));
    CHECK_EQ(r.spk.volume(), 100);
    CHECK((r.props(kSpkPort, 2) == std::vector<uint64_t>{100}));
    CHECK(r.spk.play({.play_id = 9, .sample_hz = 11025}).error() == fr::Err::invalid_args);
    std::vector<int16_t> pcm(8001);
    for (size_t i = 0; i < pcm.size(); ++i) {
        pcm[i] = static_cast<int16_t>(i * 7 - 20000);
    }
    std::string body(reinterpret_cast<const char *>(pcm.data()), pcm.size() * 2);
    Hub hub;
    r.host.port = hub.port;
    hub.serve_get("HTTP/1.1 200 OK\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body);
    REQUIRE(r.spk.play({.play_id = 9, .sample_hz = 22050}));
    REQUIRE(r.run([&] { return r.ended(kSpkPort); }));
    hub.join();
    CHECK(hub.head.starts_with("GET /v1/audio/out/9 HTTP/1.1\r\n"));
    REQUIRE(r.run([&] { return r.amp.rate == 0; }, 20));  // drained, then stopped
    CHECK(r.amp.written == pcm);
    const End e = end_of(r.events(kSpkPort)[0]);
    CHECK_EQ(e.id, 9u);
    CHECK_EQ(e.reason, kOutDone);
    CHECK_EQ(e.a, 0u);
    CHECK_EQ(e.b, 8001u);
}

TEST(audio_out_failed_get_stop_and_no_endpoint)
{
    Rig r;
    REQUIRE(r.init());
    {
        Hub hub;
        r.host.port = hub.port;
        hub.serve_get("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        REQUIRE(r.spk.play({.play_id = 2, .sample_hz = 16000}));
        REQUIRE(r.run([&] { return r.ended(kSpkPort); }));
        hub.join();
        const End e = end_of(r.events(kSpkPort)[0]);
        CHECK_EQ(e.reason, kOutNetLost);
        CHECK_EQ(e.b, 0u);
        CHECK(r.amp.written.empty());
    }
    r.sink.clear();
    r.host.port = 0;
    REQUIRE(r.spk.play({.play_id = 3, .sample_hz = 16000}));
    REQUIRE(r.run([&] { return r.ended(kSpkPort); }));
    CHECK_EQ(end_of(r.events(kSpkPort)[0]).reason, kOutNetLost);

    r.sink.clear();
    CHECK(r.spk.stop());  // nothing plays: OK, no event
    CHECK(r.events(kSpkPort).empty());
    REQUIRE(r.spk.tone({.freq_hz = 500, .ms = 5000}));
    REQUIRE(r.run([&] { return r.amp.written.size() > 1000; }));
    REQUIRE(r.spk.stop());
    REQUIRE_EQ(r.events(kSpkPort).size(), 1u);
    CHECK_EQ(end_of(r.events(kSpkPort)[0]).reason, kOutStopped);
    CHECK(!r.spk.playing());
    REQUIRE(r.run([&] { return r.amp.rate == 0; }, 10));
    CHECK_EQ(r.events(kSpkPort).size(), 1u);  // the stopped tone sends nothing more
}

TEST(audio_out_keeps_the_dma_full_while_the_microphone_paces_fr_audio)
{
    // A 48 kHz tone while level_get runs the microphone: fr_audio's passes are paced by the microphone's reads, each
    // pass's writes may not wait, and one 240-sample chunk a pass would starve a DMA that plays 480 every 10 ms.
    fr::cap::AudioOutConfig out{};
    out.sample_hz = 48000;
    fr::cap::AudioInConfig in = plain_in();
    in.level_hz = 1;  // a one-second window: the microphone runs past the tone
    Rig r(in, out);
    REQUIRE(r.init());
    REQUIRE(r.mic.level_get());
    REQUIRE(r.run([&] { return r.src.rate != 0; }, 5));
    REQUIRE(r.spk.tone({.freq_hz = 1000, .ms = 250}));
    REQUIRE(r.run([&] { return r.amp.written.size() == 12000; }));
    CHECK(r.src.rate != 0);  // the microphone paced every pass
    CHECK_EQ(r.amp.starved, 0);
    REQUIRE(r.run([&] { return r.ended(kSpkPort); }));
    CHECK_EQ(end_of(r.events(kSpkPort)[0]).reason, kOutDone);
}

TEST(audio_out_plays_48k_without_psram)
{
    // Without PSRAM the play ring holds 8,000 samples, less than 200 ms at 48 kHz: the prebuffer is what the ring takes.
    const NoPsram no_psram;
    Rig r;
    REQUIRE(r.init());
    REQUIRE(r.spk.set_volume({.volume = 100}));
    std::vector<int16_t> pcm(48000);  // 1 s
    for (size_t i = 0; i < pcm.size(); ++i) {
        pcm[i] = static_cast<int16_t>(i * 13 - 30000);
    }
    const std::string body(reinterpret_cast<const char *>(pcm.data()), pcm.size() * 2);
    Hub hub;
    r.host.port = hub.port;
    hub.serve_get("HTTP/1.1 200 OK\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body);
    REQUIRE(r.spk.play({.play_id = 11, .sample_hz = 48000}));
    REQUIRE(r.run([&] { return r.ended(kSpkPort); }, 400));
    hub.join();
    const End e = end_of(r.events(kSpkPort)[0]);
    CHECK_EQ(e.reason, kOutDone);
    CHECK_EQ(e.b, 48000u);
    CHECK(r.amp.written == pcm);
}

TEST(audio_out_a_play_that_never_moves_ends_net_lost)
{
    // fr_stream never runs (a GET that would block forever): the backstop ends the play after kStuckMs.
    Rig r;
    REQUIRE(r.init());
    r.host.port = 9;
    REQUIRE(r.spk.play({.play_id = 12, .sample_hz = 16000}));
    const uint32_t rounds = fr::AudioOutService::kStuckMs / 10 + 20;
    for (uint32_t i = 0; i < rounds && !r.ended(kSpkPort); ++i) {
        fr::audio::engine().audio_once();
        r.core.advance_ms(10);
    }
    REQUIRE(r.ended(kSpkPort));
    const End e = end_of(r.events(kSpkPort)[0]);
    CHECK_EQ(e.id, 12u);
    CHECK_EQ(e.reason, kOutNetLost);
    CHECK(!r.spk.playing());
}

namespace {

/** A worker that counts the passes each task gave it. */
class CountingWorker final : public fr::audio::Worker
{
public:
    bool is_input() const override { return false; }
    bool audio_pass(uint32_t) override
    {
        audio.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    bool stream_pass() override
    {
        stream.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    std::atomic<int> audio{0};
    std::atomic<int> stream{0};
};

}  // namespace

TEST(audio_engine_add_while_its_tasks_run)
{
    // The first service's init starts the tasks; the next ones add themselves while the tasks loop over the table.
    fr::audio::Engine e;
    CountingWorker w[3];
    REQUIRE(e.add(w[0]));
    REQUIRE(e.start());
    for (int i = 1; i < 3; ++i) {
        REQUIRE(e.add(w[i]));
        e.wake_audio();
        e.wake_stream();
    }
    for (int i = 0; i < 200 && (w[2].audio.load() < 2 || w[2].stream.load() < 2); ++i) {
        fr::audio::Rt::sleep_ms(5);
        e.wake_audio();
        e.wake_stream();
    }
    e.stop();
    for (const CountingWorker &x : w) {
        CHECK(x.audio.load() >= 2);
        CHECK(x.stream.load() >= 2);
    }
}

TEST(audio_stats_tell_dma_loss_ring_drops_clipping_and_dry_spells)
{
    // diag `stats audio` (design audio-a1 §11): each instance's counters since init, in the Engine's order.
    Rig r;
    REQUIRE(r.init());
    std::array<fr::audio::WorkerStats, 4> st{};
    REQUIRE_EQ(fr::audio::engine().stats(st), 2u);
    CHECK_EQ(std::string(st[0].name), "mic");
    CHECK(st[0].input);
    CHECK_EQ(std::string(st[1].name), "spk");
    CHECK(!st[1].input);
    CHECK_EQ(st[0].rx_overflows + st[0].dropped_samples + st[0].clipping + st[1].underruns + st[1].ring_dry, 0u);

    // The microphone: two DMA buffers lost by the driver, and the ring overflowing while nothing is sent.
    {
        Hub hub;
        r.host.port = hub.port;
        hub.serve_post();
        REQUIRE(r.mic.stream_start({.stream_id = 3, .seconds = 3}));
        fr::audio::engine().stream_once();
        for (int i = 0; i < 400; ++i) {
            if (i == 20) {
                r.src.lost = 2;
            }
            fr::audio::engine().audio_once();
        }
        REQUIRE(r.run([&] { return r.ended(kMicPort); }));
        hub.join();
    }
    const End rec = end_of(r.events(kMicPort)[0]);
    REQUIRE_EQ(fr::audio::engine().stats(st), 2u);
    CHECK_EQ(st[0].rx_overflows, 2u);
    CHECK_EQ(r.mic.dma_lost(), 480u);  // put back as zeros: the stream kept its time
    CHECK(st[0].dropped_samples > 0);
    CHECK_EQ(st[0].dropped_samples, rec.b);
    CHECK_EQ(st[0].clipping, 0u);

    // The amplifier: the driver's starved buffers during a tone.
    REQUIRE(r.spk.tone({.freq_hz = 1000, .ms = 200}));
    REQUIRE(r.run([&] { return r.amp.written.size() > 800; }));
    r.amp.late = 3;
    REQUIRE(r.run([&] { return r.ended(kSpkPort); }));
    CHECK_EQ(end_of(r.events(kSpkPort)[0]).a, 3u);
    REQUIRE(r.run([&] { return r.amp.rate == 0; }, 20));
    r.amp.late = 7;  // starved while stopped or draining: not counted
    REQUIRE_EQ(fr::audio::engine().stats(st), 2u);
    CHECK_EQ(st[1].underruns, 3u);
    CHECK_EQ(st[1].ring_dry, 0u);

    // A hub that pauses 300 ms after 0.3 s of PCM: the ring runs dry once (silence), the GET goes on, the play ends done.
    r.sink.clear();
    int lfd = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t alen = sizeof(a);
    REQUIRE(lfd >= 0 && ::bind(lfd, reinterpret_cast<sockaddr *>(&a), sizeof(a)) == 0 && ::listen(lfd, 1) == 0 &&
            ::getsockname(lfd, reinterpret_cast<sockaddr *>(&a), &alen) == 0);
    std::vector<int16_t> pcm(16000, 1000);
    std::thread srv([lfd, &pcm] {
        const int c = ::accept(lfd, nullptr, nullptr);
        if (c < 0) {
            return;
        }
        std::string head;
        char buf[512];
        while (head.find("\r\n\r\n") == std::string::npos) {
            const ssize_t n = ::recv(c, buf, sizeof(buf), 0);
            if (n <= 0) {
                break;
            }
            head.append(buf, static_cast<size_t>(n));
        }
        const std::string h = "HTTP/1.1 200 OK\r\nContent-Length: " + std::to_string(pcm.size() * 2) + "\r\n\r\n";
        ::send(c, h.data(), h.size(), 0);
        const auto *p = reinterpret_cast<const char *>(pcm.data());
        ::send(c, p, 4800 * 2, 0);
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
        ::send(c, p + 4800 * 2, (pcm.size() - 4800) * 2, 0);
        ::shutdown(c, SHUT_WR);
        while (::recv(c, buf, sizeof(buf), 0) > 0) {
        }
        ::close(c);
    });
    r.host.port = ntohs(a.sin_port);
    REQUIRE(r.spk.play({.play_id = 13, .sample_hz = 16000}));
    bool ended = false;
    for (int i = 0; i < 3000 && !ended; ++i) {
        // Real time passes too (the hub's pause is a real one), slower than the rig's 10 ms rounds.
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        ended = r.run([&] { return r.ended(kSpkPort); }, 1);
    }
    srv.join();
    ::close(lfd);
    REQUIRE(ended);
    const End play = end_of(r.events(kSpkPort)[0]);
    CHECK_EQ(play.reason, kOutDone);
    CHECK_EQ(play.b, 16000u);
    CHECK_EQ(play.a, 1u);  // one dry spell
    REQUIRE_EQ(fr::audio::engine().stats(st), 2u);
    CHECK_EQ(st[1].ring_dry, 1u);
    CHECK_EQ(st[1].underruns, 3u);

    // Clipping: a loud microphone through 36 dB, outside the warm-up.
    fr::cap::AudioInConfig loud = plain_in();
    loud.gain_db = 36;
    Rig q(loud);
    REQUIRE(q.init());
    REQUIRE(q.run([&] { return q.src.stops == 1; }, 5));  // the self-test at init
    REQUIRE(q.mic.level_get());
    REQUIRE(q.run([&] { return q.src.starts == 2 && q.src.rate == 0; }));
    std::array<fr::audio::WorkerStats, 4> qs{};
    REQUIRE_EQ(fr::audio::engine().stats(qs), 4u);  // both rigs' services: q's after r's
    const auto lv = q.mic.level_get();
    REQUIRE(lv);
    CHECK(lv->clipping > 0);
    CHECK(qs[2].input);
    CHECK_EQ(qs[2].clipping, lv->clipping);
}

// ---- the on-board monitor (fr.audio_in 1.1, design audio-a2 D3, §10) ----

namespace {

constexpr uint64_t kMonStopped = 0, kMonDone = 1, kMonBusy = 2, kMonError = 3;
constexpr uint8_t kPropMonitoring = 3;

/** A 997 Hz sine at 16 kHz in 16 bits (its period is no whole number of samples: an offset shows). */
int16_t sine997(uint32_t n)
{
    return static_cast<int16_t>(std::lround(8000.0 * std::sin(2.0 * 3.14159265358979323846 * 997.0 * n / 16000.0)));
}

int32_t sine997_slot(uint32_t n)
{
    return static_cast<int32_t>(static_cast<uint32_t>(static_cast<uint16_t>(sine997(n))) << 16);
}

/** monitor_ended fields: reason, to_port, samples. */
struct MonEnd {
    uint64_t reason, to_port, samples;
};
MonEnd mon_end_of(const RecordingSink::Emission &e)
{
    return {frt::field_u(e.bytes, 1), frt::field_u(e.bytes, 2), frt::field_u(e.bytes, 3)};
}

/** A rig whose microphone and amplifier run on the core's clock (the sine above), so latency can be measured. */
struct TimedRig : Rig {
    TimedRig(fr::cap::AudioInConfig in = plain_in(), fr::cap::AudioOutConfig out = {}) : Rig(in, out)
    {
        src.clock = &core;
        src.gen = sine997_slot;
        amp.clock = &core;
    }
};

}  // namespace

TEST(audio_monitor_plays_the_input_on_the_output_in_order_within_50_ms)
{
    TimedRig r;
    REQUIRE(r.init());
    REQUIRE(r.mic.monitor_start({.to_port = kSpkPort, .seconds = 2, .volume = 100}));
    CHECK(r.mic.monitoring());
    CHECK(r.spk.playing());  // the output is busy while claimed
    CHECK((r.props(kMicPort, kPropMonitoring) == std::vector<uint64_t>{1}));
    CHECK((r.props(kSpkPort, 1) == std::vector<uint64_t>{1}));
    const size_t levels_before = r.props(kMicPort, 1).size();
    REQUIRE(r.run([&] { return r.ended(kMicPort); }, 400));
    const MonEnd e = mon_end_of(r.events(kMicPort)[0]);
    CHECK_EQ(e.reason, kMonDone);
    CHECK_EQ(e.to_port, kSpkPort);
    CHECK_EQ(e.samples, 32000u);  // seconds x rate, after the source's warm-up
    CHECK(!r.mic.monitoring());
    CHECK((r.props(kMicPort, kPropMonitoring) == std::vector<uint64_t>{1, 0}));
    CHECK_EQ(r.props(kMicPort, 1).size(), levels_before);  // `level` paused while monitoring
    CHECK(r.events(kSpkPort).empty());                       // no play_done for a monitor
    CHECK(!r.spk.playing());
    CHECK((r.props(kSpkPort, 1) == std::vector<uint64_t>{1, 0}));
    REQUIRE(r.run([&] { return r.amp.rate == 0 && r.src.rate == 0; }, 10));

    // The input's converted samples, in order, from its first kept one (the warm-up's 1600 go nowhere): nothing lost,
    // nothing repeated. What the ring still held at the release is not played.
    const std::vector<int16_t> &w = r.amp.written;
    CHECK_EQ(r.spk.monitor_dropped(), 0u);
    CHECK(w.size() >= 32000u - 2 * 480u);
    CHECK(w.size() <= 32000u);
    bool same = true;
    for (size_t k = 0; k < w.size(); ++k) {
        same = same && w[k] == sine997(kWarmup + static_cast<uint32_t>(k));
    }
    CHECK(same);
    // Latency: each sample played within 50 ms of being due at the source (kMonitorPrebufferMs 30 and the rig's
    // 10 ms rounds); the DMA never ran dry.
    fr::TimeUs worst = 0;
    const fr::TimeUs t0 = r.src.t0;
    for (size_t k = 0; k < w.size(); k += 7) {
        const fr::TimeUs at = r.amp.played_at(k);
        if (at < 0) {
            continue;  // still queued when the sink stopped
        }
        const fr::TimeUs due = t0 + static_cast<fr::TimeUs>(kWarmup + k) * 1'000'000 / 16000;
        worst = std::max(worst, at - due);
    }
    CHECK(worst > 0);
    CHECK(worst <= 50'000);
    // The DMA ran dry only once everything written had played (the end, before the sink stopped).
    CHECK(std::all_of(r.amp.starved_at.begin(), r.amp.starved_at.end(), [&](size_t at) { return at == w.size(); }));
    std::array<fr::audio::WorkerStats, 4> st{};
    REQUIRE_EQ(fr::audio::engine().stats(st), 2u);
    CHECK_EQ(st[0].rx_overflows, 0u);
    CHECK_EQ(st[1].underruns, 0u);
    CHECK_EQ(st[1].ring_dry, 0u);
}

TEST(audio_monitor_stop_seconds_0_and_the_commands_refusals)
{
    TimedRig r;
    REQUIRE(r.init());
    CHECK(r.mic.monitor_stop());  // none runs: OK
    CHECK(r.mic.monitor_start({.to_port = 9}).error() == fr::Err::invalid_args);        // no output there
    CHECK(r.mic.monitor_start({.to_port = kMicPort}).error() == fr::Err::invalid_args); // an input, not an output
    REQUIRE(r.mic.monitor_start({.to_port = kSpkPort}));  // seconds 0: until monitor_stop
    CHECK(r.mic.monitor_start({.to_port = kSpkPort}).error() == fr::Err::busy);  // this input monitors already
    // The output is busy: a play or tone would take it; another stream rate cannot run beside the monitor.
    CHECK(r.mic.stream_start({.stream_id = 4, .has_sample_hz = true, .sample_hz = 8000}).error() == fr::Err::busy);
    REQUIRE(r.run([&] { return r.amp.written.size() > 16000; }, 300));
    CHECK(!r.ended(kMicPort));
    REQUIRE(r.mic.monitor_stop());
    REQUIRE(r.run([&] { return r.ended(kMicPort); }, 10));
    const MonEnd e = mon_end_of(r.events(kMicPort)[0]);
    CHECK_EQ(e.reason, kMonStopped);
    CHECK(e.samples > 16000u);
    CHECK(!r.spk.playing());
    CHECK(r.events(kSpkPort).empty());

    // Another input monitoring to the same output: BUSY until the first one ends.
    FakeMic src2;
    fr::AudioInService mic2(src2, plain_in());
    mic2.attach(5, "rf", r.sink);
    REQUIRE(mic2.init(r.core));
    REQUIRE(r.mic.monitor_start({.to_port = kSpkPort}));
    CHECK(mic2.monitor_start({.to_port = kSpkPort}).error() == fr::Err::busy);
    REQUIRE(r.mic.monitor_stop());
    REQUIRE(r.run([&] { return !r.mic.monitoring(); }, 10));
    REQUIRE(mic2.monitor_start({.to_port = kSpkPort, .seconds = 1}));
    REQUIRE(r.run([&] { return !mic2.monitoring(); }, 300));
    CHECK(!r.spk.playing());

    // A tone or play running: BUSY.
    r.sink.clear();
    REQUIRE(r.spk.tone({.freq_hz = 500, .ms = 100}));
    CHECK(r.mic.monitor_start({.to_port = kSpkPort}).error() == fr::Err::busy);
    REQUIRE(r.run([&] { return r.ended(kSpkPort); }));
    REQUIRE(r.mic.monitor_start({.to_port = kSpkPort}));  // the tone done (and draining): free again
    REQUIRE(r.mic.monitor_stop());
    REQUIRE(r.run([&] { return r.ended(kMicPort); }, 10));
}

TEST(audio_monitor_needs_the_output_s_rate)
{
    {
        fr::cap::AudioOutConfig out{};
        out.sample_hz = 22050;
        TimedRig r(plain_in(), out);
        REQUIRE(r.init());
        CHECK(r.mic.monitor_start({.to_port = kSpkPort}).error() == fr::Err::invalid_args);
        CHECK(!r.mic.monitoring());
        CHECK(!r.spk.playing());
        CHECK(r.props(kMicPort, kPropMonitoring).empty());
    }

    // A stream at another rate running: BUSY (the source runs the stream's rate).
    TimedRig q;
    REQUIRE(q.init());
    REQUIRE(q.mic.stream_start({.stream_id = 1, .seconds = 1, .has_sample_hz = true, .sample_hz = 8000}));
    CHECK(q.mic.monitor_start({.to_port = kSpkPort}).error() == fr::Err::busy);
    REQUIRE(q.run([&] { return q.ended(kMicPort); }));  // no endpoint: net_lost at once
}

TEST(audio_monitor_ends_busy_on_a_tone_stopped_on_the_output_s_stop_error_on_the_source)
{
    TimedRig r;
    REQUIRE(r.init());
    REQUIRE(r.mic.monitor_start({.to_port = kSpkPort, .seconds = 30}));
    REQUIRE(r.run([&] { return r.amp.written.size() > 3200; }, 300));
    // A tone takes the output: the monitor ends busy, the tone plays out (playing stays true), done.
    REQUIRE(r.spk.tone({.freq_hz = 1000, .ms = 100}));
    CHECK(r.spk.playing());
    REQUIRE(r.run([&] { return r.ended(kMicPort) && r.ended(kSpkPort); }));
    CHECK_EQ(mon_end_of(r.events(kMicPort)[0]).reason, kMonBusy);
    CHECK_EQ(end_of(r.events(kSpkPort)[0]).reason, kOutDone);  // the tone's play_done, none for the monitor
    CHECK_EQ(end_of(r.events(kSpkPort)[0]).b, 1600u);
    CHECK_EQ(r.events(kSpkPort).size(), 1u);
    CHECK((r.props(kSpkPort, 1) == std::vector<uint64_t>{1, 0}));  // true from the claim to the tone's end

    // The output's stop: the monitor ends stopped.
    r.sink.clear();
    REQUIRE(r.mic.monitor_start({.to_port = kSpkPort}));
    REQUIRE(r.run([&] { return r.amp.rate != 0; }, 300));
    REQUIRE(r.spk.stop());
    CHECK(!r.spk.playing());
    REQUIRE(r.run([&] { return r.ended(kMicPort); }, 10));
    CHECK_EQ(mon_end_of(r.events(kMicPort)[0]).reason, kMonStopped);
    CHECK(r.events(kSpkPort).empty());

    // The source failing: error.
    r.sink.clear();
    REQUIRE(r.mic.monitor_start({.to_port = kSpkPort}));
    REQUIRE(r.run([&] { return r.amp.rate != 0; }, 300));
    r.src.fail_read = true;
    REQUIRE(r.run([&] { return r.ended(kMicPort); }, 10));
    CHECK_EQ(mon_end_of(r.events(kMicPort)[0]).reason, kMonError);
    CHECK(!r.spk.playing());
    r.src.fail_read = false;
    REQUIRE(r.run([&] { return r.amp.rate == 0; }, 10));
}

TEST(audio_monitor_caps_its_latency_against_a_faster_source)
{
    // The untimed microphone makes 240 samples a 10 ms round, 1.5 x what the amplifier plays: what would build up
    // above the ring's cap (kMonitorPrebufferMs + 2 x 240) is dropped, so the delay stays bounded (here the fake
    // DMA's 1440 on top), and the sink never runs dry.
    Rig r;
    REQUIRE(r.init());
    REQUIRE(r.mic.monitor_start({.to_port = kSpkPort, .seconds = 3, .volume = 100}));
    REQUIRE(r.run([&] { return r.ended(kMicPort); }, 400));
    CHECK_EQ(mon_end_of(r.events(kMicPort)[0]).samples, 48000u);
    CHECK(r.spk.monitor_dropped() > 10000u);
    CHECK(r.amp.written.size() + r.spk.monitor_dropped() <= 48000u);
    // Not played at the end: at most the ring's cap and the chunk in hand.
    CHECK(r.amp.written.size() + r.spk.monitor_dropped() + 960u + 240u >= 48000u);
    CHECK_EQ(r.amp.starved, 0);
    // What did go out is the counter in order, with gaps only where the cap dropped.
    bool rising = true;
    for (size_t k = 1; k < r.amp.written.size(); ++k) {
        rising = rising && static_cast<uint16_t>(r.amp.written[k] - r.amp.written[k - 1]) >= 1;
    }
    CHECK(rising);
}

TEST(audio_monitor_and_a_stream_at_one_rate_carry_the_same_samples)
{
    TimedRig r;
    REQUIRE(r.init());
    Hub hub;
    r.host.port = hub.port;
    hub.serve_post();
    REQUIRE(r.mic.monitor_start({.to_port = kSpkPort, .seconds = 1, .volume = 100}));
    REQUIRE(r.mic.stream_start({.stream_id = 5, .seconds = 1}));
    REQUIRE(r.run([&] { return r.events(kMicPort).size() == 2; }, 400));
    hub.join();
    // Both began with the source's first kept sample: stream sample i is monitor sample i.
    std::vector<int16_t> streamed;
    for (const Block &b : hub.blocks()) {
        streamed.insert(streamed.end(), b.pcm.begin(), b.pcm.end());
    }
    REQUIRE_EQ(streamed.size(), 16000u);
    const std::vector<int16_t> &w = r.amp.written;
    REQUIRE(w.size() > 15000u);
    bool same = true;
    for (size_t k = 0; k < streamed.size(); ++k) {
        same = same && streamed[k] == sine997(kWarmup + static_cast<uint32_t>(k));
        same = same && (k >= w.size() || w[k] == streamed[k]);
    }
    CHECK(same);
    CHECK(std::all_of(r.amp.starved_at.begin(), r.amp.starved_at.end(), [&](size_t at) { return at == w.size(); }));
    CHECK(!r.mic.streaming());
    CHECK(!r.mic.monitoring());
}
