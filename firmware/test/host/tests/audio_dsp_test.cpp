// The audio services' pieces alone (design audio-a1 D1-D5): the 32 -> 16-bit conversion (gain, DC blocker and its
// start-up glide, clipping), the level meter, the volume curve, the tone generator, the record ring's drop accounting,
// the play ring, and fr_ota's HttpPost: the exact bytes of a chunked stream on the wire, one deadline per chunk against
// a trickling hub, an early refusal, a refused connection, the connect and the answer in slices (fr.csi's).
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <expected>
#include <string>
#include <thread>
#include <vector>

#include "fr/audio/dsp.hpp"
#include "fr/audio/engine.hpp"
#include "fr/audio/rings.hpp"
#include "fr/hal/audio.hpp"
#include "fr/ota/http_post.hpp"
#include "tests/test.hpp"

namespace {

using fr::audio::Converter;
using fr::audio::Meter;

constexpr double kPi = 3.14159265358979323846;

/** A 16-bit value as the slot of a 24-bit part carries it (left-justified). */
int32_t slot_of(int32_t s16)
{
    return static_cast<int32_t>(static_cast<uint32_t>(s16) << 16);
}

std::vector<int16_t> sine16(double amp, double hz, uint32_t rate, size_t n)
{
    std::vector<int16_t> v(n);
    for (size_t i = 0; i < n; ++i) {
        v[i] = static_cast<int16_t>(std::lround(amp * std::sin(2 * kPi * hz * static_cast<double>(i) / rate)));
    }
    return v;
}

}  // namespace

TEST(audio_converter_takes_the_top_24_bits_and_rounds)
{
    Converter c;
    c.configure(16000, 0, 0);  // 0 dB, no DC blocker
    CHECK_EQ(c.gain_q16(), 65536);
    CHECK_EQ(c.pole_q24(), 0);
    CHECK_EQ(c.convert(0x12345600), 0x1234);  // 0x123456 / 256 = 4660.34
    CHECK_EQ(c.convert(0x12348000), 0x1235);  // .5 rounds up
    CHECK_EQ(c.convert(slot_of(-1000)), -1000);
    CHECK_EQ(c.convert(0x000000FF), 0);  // below the 24 bits: nothing
    CHECK_EQ(c.clipping(), 0u);
}

TEST(audio_converter_gain_and_saturation_count_clipping)
{
    Converter c;
    c.configure(16000, 12, 0);
    CHECK_EQ(c.gain_q16(), 260904);  // 10^(12/20) in Q16
    CHECK_EQ(c.convert(slot_of(1000)), 3981);
    CHECK_EQ(c.convert(slot_of(-1000)), -3981);
    CHECK_EQ(c.clipping(), 0u);
    c.configure(16000, 36, 0);
    CHECK_EQ(c.convert(slot_of(30000)), 32767);
    CHECK_EQ(c.convert(INT32_MIN), -32768);
    CHECK_EQ(c.convert(slot_of(100)), 6310);
    CHECK_EQ(c.clipping(), 2u);
    c.configure(16000, 0, 0);  // a new stream keeps the count (the service resets it at the source's start)
    CHECK_EQ(c.clipping(), 2u);
    c.reset_clipping();
    CHECK_EQ(c.clipping(), 0u);
}

TEST(audio_dc_blocker_removes_an_offset_and_passes_a_tone)
{
    Converter c;
    c.configure(16000, 0, 20);
    CHECK_EQ(c.pole_q24(), static_cast<int32_t>(std::lround(16777216.0 * std::exp(-2 * kPi * 20 / 16000))));
    // A DC step: through at first, gone after a second (exp(-2 pi 20) is nothing).
    CHECK_EQ(c.convert(slot_of(4096)), 4096);
    int16_t last = 0;
    for (int i = 1; i < 16000; ++i) {
        last = c.convert(slot_of(4096));
    }
    CHECK(std::abs(last) <= 1);
    // A 1 kHz tone on a large offset: the offset goes, the tone stays (within 1 %).
    c.configure(16000, 0, 20);
    const std::vector<int16_t> tone = sine16(8000, 1000, 16000, 16000);
    int peak = 0;
    double mean = 0;
    for (size_t i = 0; i < tone.size(); ++i) {
        const int16_t y = c.convert(slot_of(tone[i] + 10000));
        if (i >= 8000) {
            peak = std::max(peak, std::abs(static_cast<int>(y)));
            mean += y;
        }
    }
    CHECK(std::abs(mean / 8000) < 2.0);
    CHECK(peak >= 7920 && peak <= 8080);
    // hpf_hz 0: the offset stays.
    c.configure(16000, 0, 0);
    for (int i = 0; i < 100; ++i) {
        last = c.convert(slot_of(4096));
    }
    CHECK_EQ(last, 4096);
}

TEST(audio_dc_blocker_settle_primes_and_glides_without_a_click)
{
    // A part's start-up after the warm-up (the bench's INMP441: an offset decaying with tau 100 ms) under a 1 kHz tone
    // of amplitude 100, through the 20 Hz blocker with and without settle(): 500 ms from 200 Hz down to 20 Hz.
    auto start_up = [](uint32_t n) {
        const double t = n / 16000.0;
        return slot_of(static_cast<int32_t>(std::lround(11000.0 * std::exp(-t / 0.1) + 100.0 * std::sin(2 * kPi * 1000 * t))));
    };
    struct Run {
        int first = 0;
        int max_step = 0;
        double mean_100_200 = 0;  // stream ms 100-200
        double mean_500_600 = 0;
    };
    auto run = [&](bool settle) {
        Converter c;
        c.configure(16000, 0, 20);
        if (settle) {
            c.settle(8000, 200);
            CHECK_EQ(c.settling(), 8000u);
            CHECK(c.pole_now_q24() < c.pole_q24());  // the faster corner
        }
        Run r;
        int prev = 0;
        for (uint32_t n = 0; n < 16000; ++n) {
            const int y = c.convert(start_up(n));
            if (n == 0) {
                r.first = y;
            } else {
                r.max_step = std::max(r.max_step, std::abs(y - prev));
            }
            prev = y;
            r.mean_100_200 += n >= 1600 && n < 3200 ? y / 1600.0 : 0;
            r.mean_500_600 += n >= 8000 && n < 9600 ? y / 1600.0 : 0;
        }
        CHECK_EQ(c.settling(), 0u);
        CHECK_EQ(c.pole_now_q24(), c.pole_q24());  // the glide ends on hpf_hz exactly
        return r;
    };
    const Run plain = run(false);
    const Run settled = run(true);
    CHECK(plain.first > 10000);  // the offset comes out as a step
    CHECK_EQ(settled.first, 0);  // primed: the first sample is the reference
    // No click: the tone's own steps (2 pi 100 / 16 per sample, 39) and the drift, never the pole's moves.
    CHECK(settled.max_step < 60);
    CHECK(plain.max_step > 100);
    // The drift is followed while the corner is fast, and both are the room's once settled.
    CHECK(std::abs(settled.mean_100_200) < 50.0);
    CHECK(std::abs(plain.mean_100_200) > 150.0);
    CHECK(std::abs(settled.mean_500_600) < 10.0);
    // hpf_hz 0: settle() changes nothing.
    Converter off;
    off.configure(16000, 0, 0);
    off.settle(8000, 200);
    CHECK_EQ(off.settling(), 0u);
    CHECK_EQ(off.convert(slot_of(4096)), 4096);
}

TEST(audio_meter_rms_and_peak_in_dbfs_x10)
{
    CHECK_EQ(fr::audio::dbfs_x10(0), -900);
    CHECK_EQ(fr::audio::dbfs_x10(32768), 0);
    CHECK_EQ(fr::audio::dbfs_x10(16384), -60);
    CHECK_EQ(fr::audio::dbfs_x10(1), -900);  // -903, floored
    Meter m;
    m.configure(1600);
    CHECK(!m.add(std::vector<int16_t>(1599, 0)));
    CHECK_EQ(m.level().dbfs_x10, -900);
    CHECK(m.add(std::vector<int16_t>(1, 0)));  // the window's last sample closes it
    CHECK_EQ(m.level().dbfs_x10, -900);
    CHECK_EQ(m.level().peak_dbfs_x10, -900);
    // A full-scale sine: RMS -3.0 dBFS, peak 0.
    CHECK(m.add(sine16(32767, 1000, 16000, 1600)));
    CHECK_EQ(m.level().dbfs_x10, -30);
    CHECK_EQ(m.level().peak_dbfs_x10, 0);
    // A half-scale square: -6.0 dBFS both.
    std::vector<int16_t> sq(1600);
    for (size_t i = 0; i < sq.size(); ++i) {
        sq[i] = (i / 8) % 2 == 0 ? 16384 : -16384;
    }
    CHECK(m.add(sq));
    CHECK_EQ(m.level().dbfs_x10, -60);
    CHECK_EQ(m.level().peak_dbfs_x10, -60);
    CHECK_EQ(m.windows(), 3u);
    // Two windows in one call: the newer one is the level.
    m.configure(100);
    std::vector<int16_t> two(200, 0);
    std::fill(two.begin() + 100, two.end(), int16_t{-32768});
    CHECK(m.add(two));
    CHECK_EQ(m.level().dbfs_x10, 0);
}

TEST(audio_volume_curve_and_bit_exact_at_100)
{
    CHECK_EQ(fr::audio::volume_q15(100), 32768u);
    CHECK_EQ(fr::audio::volume_q15(200), 32768u);
    CHECK_EQ(fr::audio::volume_q15(60), 11796u);  // 0.36: -8.9 dB
    CHECK_EQ(fr::audio::volume_q15(0), 0u);
    std::vector<int16_t> s{32767, -32768, 1000, -1, 0};
    fr::audio::apply_volume(s, 32768);
    CHECK((s == std::vector<int16_t>{32767, -32768, 1000, -1, 0}));
    fr::audio::apply_volume(s, fr::audio::volume_q15(50));  // x0.25
    CHECK((s == std::vector<int16_t>{8192, -8192, 250, 0, 0}));
    fr::audio::apply_volume(s, 0);
    CHECK((s == std::vector<int16_t>{0, 0, 0, 0, 0}));
}

TEST(audio_tone_generator_length_frequency_and_fades)
{
    fr::audio::ToneGen t;
    t.start(1000, 16000, 16000, 80);
    std::vector<int16_t> out;
    int16_t buf[240];
    for (size_t n; (n = t.fill(buf)) > 0;) {
        out.insert(out.end(), buf, buf + n);
    }
    CHECK(t.done());
    REQUIRE_EQ(out.size(), 16000u);
    CHECK_EQ(out.front(), 0);
    CHECK(std::abs(out.back()) <= 1);  // faded out
    // 1 kHz: 2000 sign changes a second (each period crosses twice).
    int crossings = 0;
    int peak = 0;
    for (size_t i = 1; i < out.size(); ++i) {
        crossings += (out[i - 1] < 0) != (out[i] < 0) ? 1 : 0;
        peak = std::max(peak, std::abs(static_cast<int>(out[i])));
    }
    CHECK(crossings >= 1998 && crossings <= 2002);
    CHECK(peak >= 32700);
    // The interpolated table follows sin(): within 0.05 % of full scale anywhere outside the fades.
    double worst = 0;
    for (size_t i = 80; i < 15920; ++i) {
        worst = std::max(worst, std::abs(out[i] - 32767.0 * std::sin(2 * kPi * 1000 * static_cast<double>(i) / 16000)));
    }
    CHECK(worst < 16.0);
    // A tone shorter than its two fades.
    t.start(440, 16000, 10, 80);
    CHECK_EQ(t.fill(buf), 10u);
    CHECK_EQ(t.fill(buf), 0u);
}

TEST(audio_record_ring_drops_the_oldest_and_never_the_block_in_flight)
{
    constexpr uint32_t kBlock = 4;
    std::vector<int16_t> mem(5 * kBlock);
    fr::audio::RecordRing r;
    r.bind(mem.data(), mem.size() * sizeof(int16_t), nullptr);
    REQUIRE(r.reset(kBlock));
    CHECK_EQ(r.slots(), 5u);
    auto put = [&r](int16_t v, uint32_t first) {
        std::span<int16_t> b = r.acquire();
        std::fill(b.begin(), b.end(), v);
        r.publish(kBlock, first);
    };
    put(1, 0);
    put(2, 4);
    fr::audio::RecordRing::Block b;
    REQUIRE(r.take(b));  // block 1 in flight
    CHECK_EQ(b.first_sample, 0u);
    CHECK_EQ(b.pcm[0], 1);
    fr::audio::RecordRing::Block b2;
    CHECK(!r.take(b2));  // one in flight at a time
    put(3, 8);
    put(4, 12);
    put(5, 16);  // 4 queued + 1 in flight: full
    CHECK_EQ(r.dropped_samples(), 0u);
    put(6, 20);  // the oldest queued (2) goes; 1 is in flight and stays
    put(7, 24);  // then 3
    CHECK_EQ(r.dropped_samples(), 2 * kBlock);
    CHECK_EQ(r.overflows(), 2u);
    CHECK_EQ(b.pcm[0], 1);  // untouched while it was sent
    r.release();
    std::vector<uint32_t> firsts;
    while (r.take(b)) {
        CHECK_EQ(b.pcm[0], static_cast<int16_t>(b.first_sample / kBlock + 1));
        CHECK_EQ(b.len, kBlock);
        firsts.push_back(b.first_sample);
        r.release();
    }
    CHECK((firsts == std::vector<uint32_t>{12, 16, 20, 24}));
    // A short last block, a discard (the stall hook), and a reset that empties everything.
    std::span<int16_t> fill = r.acquire();
    r.discard(kBlock);
    CHECK_EQ(r.dropped_samples(), 3 * kBlock);
    CHECK(r.acquire().data() == fill.data());  // still the producer's
    r.publish(3, 28);
    REQUIRE(r.take(b));
    CHECK_EQ(b.len, 3u);
    r.release();
    REQUIRE(r.reset(kBlock));
    CHECK_EQ(r.dropped_samples(), 0u);
    CHECK_EQ(r.queued(), 0u);
    // Fewer than 3 blocks fit: no stream at that rate.
    CHECK(!r.reset(8));
    CHECK(r.acquire().empty());
}

TEST(audio_record_ring_sizes)
{
    // With PSRAM: 22 blocks at every rate (2 s queued); without: what 32,000 B holds, at least 3.
    std::vector<int16_t> mem(fr::audio::kRecordRingBytesPsram / 2);
    fr::audio::RecordRing r;
    r.bind(mem.data(), fr::audio::kRecordRingBytesPsram, nullptr);
    for (uint32_t hz : fr::hal::kAudioRates) {
        REQUIRE(r.reset(fr::audio::block_samples(hz)));
        CHECK_EQ(r.slots(), 22u);
    }
    r.bind(mem.data(), fr::audio::kRecordRingBytesInternal, nullptr);
    REQUIRE(r.reset(fr::audio::block_samples(16000)));
    CHECK_EQ(r.slots(), 10u);
    REQUIRE(r.reset(fr::audio::block_samples(48000)));
    CHECK_EQ(r.slots(), 3u);
}

TEST(audio_pcm_ring_wraps_and_discards)
{
    std::vector<int16_t> mem(5);
    fr::audio::PcmRing r;
    r.bind(mem.data(), mem.size());
    const std::vector<int16_t> a{1, 2, 3, 4, 5, 6, 7};
    CHECK_EQ(r.write(a), 5u);
    CHECK_EQ(r.room(), 0u);
    int16_t out[8] = {};
    CHECK_EQ(r.read({out, 3}), 3u);
    CHECK_EQ(out[2], 3);
    CHECK_EQ(r.write({a.data() + 5, 2}), 2u);  // wraps
    CHECK_EQ(r.read(out), 4u);
    CHECK((std::vector<int16_t>(out, out + 4) == std::vector<int16_t>{4, 5, 6, 7}));
    for (int i = 0; i < 100; ++i) {  // many laps keep the count right
        CHECK_EQ(r.write({a.data(), 3}), 3u);
        CHECK_EQ(r.read(out), 3u);
        CHECK_EQ(out[0], 1);
    }
    CHECK_EQ(r.write(a), 5u);
    r.discard_all();
    CHECK_EQ(r.size(), 0u);
    CHECK_EQ(r.read(out), 0u);
}

TEST(audio_ipv4_text)
{
    uint32_t ip = 0;
    CHECK(fr::audio::parse_ipv4("192.168.1.20", ip));
    CHECK_EQ(ip, 0xC0A80114u);
    char buf[16];
    fr::audio::format_ipv4(ip, buf, sizeof(buf));
    CHECK_EQ(std::string(buf), "192.168.1.20");
    CHECK(!fr::audio::parse_ipv4("192.168.1", ip));
    CHECK(!fr::audio::parse_ipv4("192.168.1.256", ip));
    CHECK(!fr::audio::parse_ipv4("hub.local", ip));
    CHECK(!fr::audio::parse_ipv4("1.2.3.4 ", ip));
}

// ---- HttpPost ----

namespace {

/** One loopback connection: everything the client sends is kept; `reply` goes back after `after` request bytes
 * (0: as soon as the head arrived). */
class PostServer
{
public:
    PostServer()
    {
        fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        socklen_t len = sizeof(a);
        if (fd_ < 0 || ::bind(fd_, reinterpret_cast<sockaddr *>(&a), sizeof(a)) != 0 || ::listen(fd_, 2) != 0 ||
            ::getsockname(fd_, reinterpret_cast<sockaddr *>(&a), &len) != 0) {
            frt::fail(__FILE__, __LINE__, "no loopback listener");
        }
        port = ntohs(a.sin_port);
    }
    ~PostServer()
    {
        if (thread_.joinable()) {
            thread_.join();
        }
        ::close(fd_);
    }

    /** Answers with `reply` once the request ends (`0\r\n\r\n`), or right after the head when `early`. */
    void serve(std::string reply, bool early = false)
    {
        thread_ = std::thread([this, reply = std::move(reply), early] {
            const int c = ::accept(fd_, nullptr, nullptr);
            if (c < 0) {
                return;
            }
            char buf[4096];
            for (;;) {
                const bool done = early ? got.find("\r\n\r\n") != std::string::npos : got.ends_with("\r\n0\r\n\r\n");
                if (done) {
                    break;
                }
                const ssize_t n = ::recv(c, buf, sizeof(buf), 0);
                if (n <= 0) {
                    break;
                }
                got.append(buf, static_cast<size_t>(n));
            }
            ::send(c, reply.data(), reply.size(), 0);
            ::shutdown(c, SHUT_WR);
            while (::recv(c, buf, sizeof(buf), 0) > 0) {  // until the client closes
            }
            ::close(c);
        });
    }
    void join() { thread_.join(); }

    uint16_t port = 0;
    std::string got;

private:
    int fd_ = -1;
    std::thread thread_;
};

std::span<const uint8_t> bytes(const std::string &s)
{
    return {reinterpret_cast<const uint8_t *>(s.data()), s.size()};
}

}  // namespace

TEST(http_post_chunked_bytes_on_the_wire)
{
    char line[16];
    CHECK_EQ(std::string(line, fr::ota::HttpPost::format_chunk_size(line, 3208)), "c88\r\n");
    CHECK_EQ(std::string(line, fr::ota::HttpPost::format_chunk_size(line, 0)), "0\r\n");

    PostServer srv;
    srv.serve("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{\"samples\":42}\n");
    fr::ota::HttpPost post(3000);
    REQUIRE(post.start("127.0.0.1", srv.port, "/v1/audio/in/7",
                       "X-Fr-Device: a1b2c3d4e5f6\r\nX-Fr-Format: s16le;rate=16000;ch=1\r\n"));
    const std::string head1("\x00\x00\x00\x00\x00\x00\x00\x00", 8);
    const std::string pcm1("\x01\x02\x03\x04", 4);
    const std::string head2("\x01\x00\x00\x00\x02\x00\x00\x00", 8);
    const std::string pcm2(26, 'z');
    REQUIRE(post.chunk(bytes(head1), bytes(pcm1)));
    REQUIRE(post.chunk(bytes(head2), bytes(pcm2)));
    CHECK_EQ(post.sent(), 46u);
    CHECK(!post.answered());
    REQUIRE(post.finish());
    srv.join();
    CHECK_EQ(post.status(), 200);
    CHECK_EQ(std::string(post.body()), "{\"samples\":42}\n");
    CHECK(!post.open());
    const std::string want = "POST /v1/audio/in/7 HTTP/1.1\r\n"
                             "Host: 127.0.0.1:" + std::to_string(srv.port) + "\r\n"
                             "Transfer-Encoding: chunked\r\n"
                             "Connection: close\r\n"
                             "X-Fr-Device: a1b2c3d4e5f6\r\n"
                             "X-Fr-Format: s16le;rate=16000;ch=1\r\n"
                             "\r\n"
                             "c\r\n" + head1 + pcm1 + "\r\n"
                             "22\r\n" + head2 + pcm2 + "\r\n"
                             "0\r\n\r\n";
    CHECK_BYTES(bytes(srv.got), bytes(want));
}

TEST(http_post_a_chunk_has_one_deadline_in_all)
{
    // A hub that reads a trickle (512 B every 20 ms): every pump moves a little, but a chunk has the timeout in all
    // from begin_chunk(), not per partial send, and pump() returns after its slice while the chunk is pending.
    int lfd = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t len = sizeof(a);
    REQUIRE(lfd >= 0 && ::bind(lfd, reinterpret_cast<sockaddr *>(&a), sizeof(a)) == 0 && ::listen(lfd, 1) == 0 &&
            ::getsockname(lfd, reinterpret_cast<sockaddr *>(&a), &len) == 0);
    std::thread srv([lfd] {
        const int c = ::accept(lfd, nullptr, nullptr);
        if (c < 0) {
            return;
        }
        char buf[512];
        while (::recv(c, buf, sizeof(buf), 0) > 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        ::close(c);
    });
    fr::ota::HttpPost post(400);
    REQUIRE(post.start("127.0.0.1", ntohs(a.sin_port), "/v1/audio/in/3", ""));
    const std::vector<uint8_t> big(16u << 20, 0x55);
    const std::string head("\x00\x00\x00\x00\x00\x00\x00\x00", 8);
    REQUIRE(post.begin_chunk(bytes(head), big));
    const auto t0 = std::chrono::steady_clock::now();
    int slices = 0;
    std::expected<bool, fr::Err> r = false;
    while (r && !*r) {
        r = post.pump(20);
        ++slices;
    }
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
    CHECK(!r);
    CHECK_EQ(std::string(post.error()), "timeout");
    CHECK(!post.open());
    CHECK(slices >= 10);  // 20 ms slices, not one blocking send
    CHECK(ms >= 390 && ms < 900);
    srv.join();
    ::close(lfd);
}

TEST(http_post_early_refusal_and_refused_connect)
{
    PostServer srv;
    srv.serve("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n", true);
    fr::ota::HttpPost post(3000);
    REQUIRE(post.start("127.0.0.1", srv.port, "/v1/audio/in/9", ""));
    bool answered = false;
    for (int i = 0; i < 300 && !answered; ++i) {
        answered = post.answered();
        if (!answered) {
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
    }
    CHECK(answered);
    CHECK_EQ(post.status(), 404);
    CHECK(!post.open());
    CHECK(!post.chunk(bytes("x"), {}));
    srv.join();

    // Nobody listens any more: connect fails at once on loopback.
    uint16_t port = 0;
    {
        PostServer gone;
        port = gone.port;
    }
    fr::ota::HttpPost lone(500);
    const fr::Status st = lone.start("127.0.0.1", port, "/v1/audio/in/1", "");
    CHECK(!st);
    CHECK_EQ(std::string(lone.error()), "connect");
    CHECK(!lone.start("hub.local", 7422, "/x", ""));
    CHECK_EQ(std::string(lone.error()), "host");
}

TEST(http_post_connect_and_answer_in_slices)
{
    // fr.csi's use (design csi-c1 D11): begin_start() sends nothing, pump() connects and sends the head; begin_finish()
    // and pump_answer() end it. The same bytes on the wire as start() ... finish().
    PostServer srv;
    srv.serve("HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"records\":3}");
    fr::ota::HttpPost post(3000);
    REQUIRE(post.begin_start("127.0.0.1", srv.port, "/v1/stream/in/2", "X-Fr-Kind: csi\r\n"));
    CHECK(post.pending());   // the head
    CHECK(!post.answered());  // nothing read into the head's buffer while it goes
    std::expected<bool, fr::Err> r = false;
    for (int i = 0; i < 100 && r && !*r; ++i) {
        r = post.pump(20);
    }
    REQUIRE(r && *r);
    CHECK_EQ(post.sent(), 0u);  // the head is not body
    REQUIRE(post.chunk(bytes("abc"), {}));
    REQUIRE(post.begin_finish());
    r = false;
    int slices = 0;
    for (; slices < 200 && r && !*r; ++slices) {
        r = post.pump_answer(20);
    }
    REQUIRE(r && *r);
    srv.join();
    CHECK_EQ(post.status(), 200);
    CHECK_EQ(std::string(post.body()), "{\"records\":3}");
    CHECK(!post.open());
    CHECK_EQ(post.sent(), 3u);
    const std::string want = "POST /v1/stream/in/2 HTTP/1.1\r\n"
                             "Host: 127.0.0.1:" + std::to_string(srv.port) + "\r\n"
                             "Transfer-Encoding: chunked\r\n"
                             "Connection: close\r\n"
                             "X-Fr-Kind: csi\r\n"
                             "\r\n"
                             "3\r\nabc\r\n"
                             "0\r\n\r\n";
    CHECK_BYTES(bytes(srv.got), bytes(want));

    // Nobody listens: the connect fails, at begin_start() or in the pump after it.
    uint16_t port = 0;
    {
        PostServer gone;
        port = gone.port;
    }
    fr::ota::HttpPost lone(500);
    r = false;
    if (lone.begin_start("127.0.0.1", port, "/v1/stream/in/1", "")) {
        for (int i = 0; i < 100 && r && !*r; ++i) {
            r = lone.pump(20);
        }
        CHECK(!r);
    }
    CHECK_EQ(std::string(lone.error()), "connect");
    CHECK(!lone.open());
}
