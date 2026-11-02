// CsiService and RadioTxService (design csi-c1 D7-D11, §12) against FakeCore, a fake CSI source and transmitter, and a
// loopback hub that reads the csi1 stream: the POST's route and headers, each chunk one block (seq from 0 without
// gaps, first_index, whole records in §12's layout, at most 8,192 bytes, about 10 records at 100 Hz), the end and its
// figures (done, stopped, net_lost without an endpoint or on the hub's 404), the ring's drops as a jump of first_index
// counted in `dropped`, the commands' refusals, a stream's own source and its return to the config's, the properties
// (motion past its deadband at once, a smaller change at most once a second, never the same value twice; rate and rssi), and fr.radio_tx's arguments, `sending` and its seconds. fr_stream runs by hand
// (Engine::set_manual): each round feeds the source's records for 10 ms, one fr_stream pass, then 10 ms of core time;
// or in real time beside a feeder thread (RealTime): a hub slow to answer the end or to take the connect holds no pass
// long, the feature windows keep their 100 ms, the ring's drops stay bounded.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <sys/select.h>

#include <algorithm>
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
#include "fr/csi/csi.hpp"
#include "fr/services/csi_service.hpp"
#include "fr/services/radio_tx_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using frt::RecordingSink;
using fr::hal::CsiCapture;
using fr::hal::CsiMode;

constexpr uint8_t kCsiPort = 3;

class FakeCsi final : public fr::hal::CsiSource
{
public:
    fr::Status init(fr::Core &, fr::hal::CsiSink &s) override
    {
        sink = &s;
        return {};
    }
    fr::Status capture(const CsiCapture &c) override
    {
        if (c.mode == CsiMode::peer && !c.has_peer) {
            return std::unexpected(fr::Err::invalid_args);
        }
        captures.push_back(c);
        return {};
    }
    fr::Status stop() override
    {
        ++stops;
        return {};
    }
    fr::hal::Selftest selftest() override { return {true, "fake csi"}; }

    /** One HT20 record (57 subcarriers) of `level` with `n` in its first data byte (`steady`: none), as the Wi-Fi task
     * would hand it over. */
    void frame(uint32_t n, size_t len = 114, int8_t rssi = -45)
    {
        std::vector<int8_t> d(len, level);
        if (!steady) {
            d[0] = static_cast<int8_t>(n);
        }
        fr::hal::CsiRecord r{};
        r.t_us = n * 10'000;
        r.rssi = rssi;
        r.noise = -95;
        r.channel = 36;
        r.bb_format = fr::hal::CsiBbFormat::ht;
        r.flags = fr::hal::kCsiFlagMatched;
        r.mac = {0x02, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE};
        r.data = d;
        sink->on_csi(r);
    }

    fr::hal::CsiSink *sink = nullptr;
    std::vector<CsiCapture> captures;
    int stops = 0;
    int8_t level = 20;
    bool steady = false;
};

/** One block as the hub got it, its records split out (each the wire record, head included). */
struct Block {
    uint32_t seq = 0;
    uint32_t first = 0;
    size_t bytes = 0;
    std::vector<std::vector<uint8_t>> records;
};

/**
 * A loopback hub for one stream POST: each chunk a block; `200 {"records":N}` at its end (answer_delay_ms after the
 * zero-length chunk), or `early_status` at once. slow_connect(ms): its accept queue (backlog 1) held full by another
 * client for that long, so the stream's SYN goes unanswered (and is retried) meanwhile.
 */
class Hub
{
public:
    explicit Hub(int backlog = 4)
    {
        fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        socklen_t len = sizeof(a);
        if (fd_ < 0 || ::bind(fd_, reinterpret_cast<sockaddr *>(&a), sizeof(a)) != 0 || ::listen(fd_, backlog) != 0 ||
            ::getsockname(fd_, reinterpret_cast<sockaddr *>(&a), &len) != 0) {
            frt::fail(__FILE__, __LINE__, "no loopback listener");
        }
        port = ntohs(a.sin_port);
    }
    ~Hub()
    {
        join();
        if (filler_ >= 0) {
            ::close(filler_);
        }
        ::close(fd_);
    }
    void serve(int early_status = 0)
    {
        thread_ = std::thread([this, early_status] {
            if (accept_delay_ms_ > 0) {
                std::this_thread::sleep_for(std::chrono::milliseconds(accept_delay_ms_));
                const int f = ::accept(fd_, nullptr, nullptr);  // the filler: the queue has room again
                if (f >= 0) {
                    ::close(f);
                }
                fd_set rd;
                FD_ZERO(&rd);
                FD_SET(fd_, &rd);
                timeval tv{.tv_sec = 5, .tv_usec = 0};
                if (::select(fd_ + 1, &rd, nullptr, nullptr, &tv) != 1) {
                    return;  // the stream gave up before its SYN got in
                }
            }
            conn(early_status);
        });
    }
    /** Use Hub(1): a client takes the one queue slot until serve()'s thread accepts it, `ms` later. */
    void slow_connect(int ms)
    {
        accept_delay_ms_ = ms;
        filler_ = ::socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        a.sin_port = htons(port);
        if (filler_ < 0 || ::connect(filler_, reinterpret_cast<sockaddr *>(&a), sizeof(a)) != 0) {
            frt::fail(__FILE__, __LINE__, "no filler connection");
        }
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

    uint16_t port = 0;
    std::string head;
    bool ended = false;
    int answer_delay_ms = 0;

private:
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
    void conn(int early_status)
    {
        const int c = ::accept(fd_, nullptr, nullptr);
        if (c < 0) {
            return;
        }
        while (buf_.find("\r\n\r\n") == std::string::npos) {
            if (!need(c, buf_.size() + 1)) {
                ::close(c);
                return;
            }
        }
        const size_t end = buf_.find("\r\n\r\n") + 4;
        head = buf_.substr(0, end);
        buf_.erase(0, end);
        if (early_status != 0) {
            const std::string r = "HTTP/1.1 " + std::to_string(early_status) + " No\r\nContent-Length: 0\r\n\r\n";
            ::send(c, r.data(), r.size(), 0);
            ::shutdown(c, SHUT_WR);
            char tmp[4096];
            while (::recv(c, tmp, sizeof(tmp), 0) > 0) {
            }
            ::close(c);
            return;
        }
        uint32_t records = 0;
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
                break;
            }
            const auto *p = reinterpret_cast<const uint8_t *>(buf_.data());
            Block b;
            b.seq = fr::csi::get_u32le(p);
            b.first = fr::csi::get_u32le(p + 4);
            b.bytes = len;
            for (size_t at = 8; at + 18 <= len;) {
                const size_t n = 18 + fr::csi::get_u16le(p + at);
                b.records.emplace_back(p + at, p + std::min(at + n, len));
                at += n;
            }
            records += static_cast<uint32_t>(b.records.size());
            buf_.erase(0, len + 2);
            const std::lock_guard<std::mutex> g(m_);
            blocks_.push_back(std::move(b));
        }
        if (answer_delay_ms > 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(answer_delay_ms));  // closing its file, say
        }
        const std::string body = "{\"records\":" + std::to_string(records) + "}";
        const std::string r = "HTTP/1.1 200 OK\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body;
        ::send(c, r.data(), r.size(), 0);
        ::shutdown(c, SHUT_WR);
        char tmp[256];
        while (::recv(c, tmp, sizeof(tmp), 0) > 0) {
        }
        ::close(c);
    }

    int fd_ = -1;
    int filler_ = -1;
    int accept_delay_ms_ = 0;
    std::thread thread_;
    std::string buf_;
    mutable std::mutex m_;
    std::vector<Block> blocks_;
};

class TestHost final : public fr::stream::StreamHost
{
public:
    bool endpoint(fr::stream::Endpoint &out) override
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

struct Rig {
    explicit Rig(fr::cap::CsiConfig cfg = {}) : svc(src, cfg)
    {
        fr::audio::engine().set_manual(true);
        fr::stream::set_stream_host(&host);
        svc.attach(kCsiPort, "csi", sink);
    }
    ~Rig() { fr::stream::set_stream_host(nullptr); }

    /** Rounds of 10 ms: `per_round` records (numbered on), one fr_stream pass, 10 ms of core time; until `done`. */
    bool run(const std::function<bool()> &done, int max = 1000, int per_round = 1)
    {
        for (int i = 0; i < max; ++i) {
            for (int k = 0; k < per_round; ++k) {
                if (feeding) {
                    src.frame(n++);
                }
            }
            fr::audio::engine().stream_once();
            core.advance_ms(10);
            if (done()) {
                return true;
            }
        }
        return false;
    }
    std::vector<RecordingSink::Emission> events() const { return sink.events(); }
    std::vector<uint64_t> props(uint8_t id) const
    {
        std::vector<uint64_t> out;
        for (const auto &e : sink.properties()) {
            if (e.port == kCsiPort && e.id == id) {
                out.push_back(frt::field_u(e.bytes, 1));
            }
        }
        return out;
    }

    FakeCore core;
    RecordingSink sink{core};
    TestHost host;
    FakeCsi src;
    fr::CsiService svc;
    uint32_t n = 0;
    bool feeding = true;
};

struct End {
    uint64_t id, reason, records, dropped;
};
End end_of(const RecordingSink::Emission &e)
{
    return {frt::field_u(e.bytes, 1), frt::field_u(e.bytes, 2), frt::field_u(e.bytes, 3), frt::field_u(e.bytes, 4)};
}
constexpr uint64_t kStopped = 0, kDone = 1, kNetLost = 2;

fr::cap::CsiStreamStartArgs start_args(uint32_t id, uint16_t seconds)
{
    fr::cap::CsiStreamStartArgs a{};
    a.stream_id = id;
    a.seconds = seconds;
    return a;
}

TEST(csi_service_init_captures_the_config)
{
    Rig rig;
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE_EQ(rig.src.captures.size(), 1u);
    CHECK(rig.src.captures[0].mode == CsiMode::router);
    CHECK_EQ(rig.src.captures[0].rate_hz, 100);
    CHECK(rig.src.captures[0].format == fr::hal::CsiFormat::auto_);
    CHECK(rig.svc.selftest().ok);
}

TEST(csi_service_stream_blocks_on_the_wire)
{
    Hub hub;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    rig.run([] { return false; }, 20);  // properties running before the stream
    REQUIRE(rig.svc.stream_start(start_args(7, 1)));
    CHECK_EQ(rig.svc.stream_start(start_args(8, 1)).error(), fr::Err::busy);
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 400));
    hub.join();
    CHECK(hub.head.starts_with("POST /v1/stream/in/7 HTTP/1.1\r\n"));
    CHECK(hub.head.find("X-Fr-Device: a1b2c3d4e5f6\r\n") != std::string::npos);
    CHECK(hub.head.find("X-Fr-Kind: csi\r\n") != std::string::npos);
    CHECK(hub.head.find("X-Fr-Format: csi1\r\n") != std::string::npos);
    CHECK(hub.head.find("Transfer-Encoding: chunked\r\n") != std::string::npos);
    CHECK(hub.ended);
    const auto blocks = hub.blocks();
    REQUIRE(blocks.size() >= 8);
    uint32_t next = 0;
    size_t total = 0;
    for (size_t i = 0; i < blocks.size(); ++i) {
        CHECK_EQ(blocks[i].seq, static_cast<uint32_t>(i));
        CHECK_EQ(blocks[i].first, next);  // nothing dropped: contiguous
        CHECK(blocks[i].bytes <= fr::csi::kBlockMaxBytes);
        CHECK(!blocks[i].records.empty());
        CHECK(blocks[i].records.size() <= 12);  // ~0.1 s at 100 Hz
        for (const auto &r : blocks[i].records) {
            REQUIRE_EQ(r.size(), 18u + 114u);
            CHECK_EQ(fr::csi::get_u16le(r.data()), 114u);
            CHECK_EQ(static_cast<int8_t>(r[6]), -45);  // rssi
            CHECK_EQ(static_cast<int8_t>(r[7]), -95);  // noise
            CHECK_EQ(r[8], 36u);                       // channel
            CHECK_EQ(r[9], 2u);                        // bb_format ht
            CHECK_EQ(r[10], fr::hal::kCsiFlagMatched);
            CHECK_EQ(r[11], 0u);
            CHECK_EQ(r[12], 0x02u);
            CHECK_EQ(r[17], 0xEEu);
        }
        // Records in order: their first data byte is the source's counter, one apart.
        for (size_t k = 1; k < blocks[i].records.size(); ++k) {
            CHECK_EQ(static_cast<uint8_t>(blocks[i].records[k][18] - blocks[i].records[k - 1][18]), 1u);
        }
        next += static_cast<uint32_t>(blocks[i].records.size());
        total += blocks[i].records.size();
    }
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.id, 7u);
    CHECK_EQ(e.reason, kDone);
    CHECK_EQ(e.records, total);
    CHECK_EQ(e.dropped, 0u);
    CHECK(total >= 95 && total <= 105);  // 1 s at 100 Hz
    CHECK_EQ(rig.svc.last_status(), 200);
    CHECK_EQ(rig.svc.last_hub_records(), total);
}

TEST(csi_service_ring_drops_show_as_a_gap)
{
    Hub hub;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(9, 0)));
    rig.run([] { return false; }, 30);
    // A burst the ring cannot hold between two passes (4 KB: 29 HT20 records): the newest are dropped.
    rig.run([] { return false; }, 1, 200);
    rig.run([] { return false; }, 30);
    REQUIRE(rig.svc.stream_stop({.stream_id = 9}));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 200));
    hub.join();
    CHECK(rig.svc.ring_dropped() > 0);
    const auto blocks = hub.blocks();
    uint32_t next = 0;
    uint32_t sent = 0;
    bool gap = false;
    for (const Block &b : blocks) {
        CHECK(b.first >= next);
        gap = gap || b.first > next;
        next = b.first + static_cast<uint32_t>(b.records.size());
        sent += static_cast<uint32_t>(b.records.size());
    }
    CHECK(gap);
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.reason, kStopped);
    CHECK_EQ(e.records, next);  // the index reached, dropped ones included
    CHECK_EQ(e.dropped, next - sent);
    CHECK(e.dropped > 0);
}

TEST(csi_service_refusals)
{
    fr::cap::CsiConfig cfg{};
    cfg.source = fr::cap::CsiSourceMode::peer;  // no peer_mac in the config: no capture until a stream names one
    Rig rig(cfg);
    CHECK_EQ(rig.svc.stream_start(start_args(1, 0)).error(), fr::Err::failed);  // before init
    REQUIRE(rig.svc.init(rig.core));
    CHECK(rig.src.captures.empty());
    CHECK_EQ(rig.svc.stream_start(start_args(1, 0)).error(), fr::Err::invalid_args);  // peer without a MAC
    auto a = start_args(1, 0);
    const uint8_t five[5] = {2, 1, 2, 3, 4};
    a.has_peer_mac = true;
    a.peer_mac = five;
    CHECK_EQ(rig.svc.stream_start(a).error(), fr::Err::invalid_args);
    CHECK_EQ(rig.svc.stream_stop({.stream_id = 1}).error(), fr::Err::not_found);
    CHECK(rig.svc.baseline_reset());
}

TEST(csi_service_no_endpoint_ends_net_lost)
{
    Rig rig;  // host.port 0: no TCP session
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(4, 5)));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 50));
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.id, 4u);
    CHECK_EQ(e.reason, kNetLost);
    CHECK_EQ(e.records, 0u);
    // stream_stop of it now: not the running stream any more.
    CHECK_EQ(rig.svc.stream_stop({.stream_id = 4}).error(), fr::Err::not_found);
}

TEST(csi_service_hub_refusal_ends_net_lost)
{
    Hub hub;
    hub.serve(404);
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(5, 0)));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 400));
    hub.join();
    CHECK_EQ(end_of(rig.events()[0]).reason, kNetLost);
    CHECK_EQ(rig.svc.last_status(), 404);
}

TEST(csi_service_stream_source_override_and_back)
{
    Hub hub;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    auto a = start_args(6, 1);
    const uint8_t peer[6] = {0x02, 0x11, 0x22, 0x33, 0x44, 0x55};
    a.has_source = true;
    a.source = fr::cap::CsiSourceMode::peer;
    a.has_peer_mac = true;
    a.peer_mac = peer;
    REQUIRE(rig.svc.stream_start(a));
    REQUIRE_EQ(rig.src.captures.size(), 2u);
    CHECK(rig.src.captures[1].mode == CsiMode::peer);
    CHECK(rig.src.captures[1].has_peer);
    CHECK_EQ(rig.src.captures[1].peer[5], 0x55u);
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 400));
    hub.join();
    // The stream's end: the config's source (router) again.
    REQUIRE_EQ(rig.src.captures.size(), 3u);
    CHECK(rig.src.captures[2].mode == CsiMode::router);
    CHECK(rig.svc.capture().mode == CsiMode::router);
}

TEST(csi_service_properties)
{
    Rig rig;
    REQUIRE(rig.svc.init(rig.core));
    rig.run([] { return false; }, 150);  // 1.5 s at 100 Hz, features_hz 10
    const auto motion = rig.props(fr::cap::Csi::kPropMotion);
    CHECK(!motion.empty() && motion.size() <= 16);  // at most every window, the first one always
    CHECK(rig.svc.rate() >= 95 && rig.svc.rate() <= 105);
    CHECK_EQ(rig.svc.rssi(), -45);
    CHECK(rig.svc.motion() < 2000);  // the fake's records change only in their first subcarrier
    CHECK(!rig.props(fr::cap::Csi::kPropRate).empty());
    // Nothing comes: rate falls to 0 within a second, reported within another (at most once a second).
    rig.feeding = false;
    rig.run([] { return false; }, 220);
    CHECK_EQ(rig.svc.rate(), 0u);
    CHECK_EQ(rig.props(fr::cap::Csi::kPropRate).back(), 0u);
}

TEST(csi_service_motion_is_reported_when_it_moves)
{
    Rig rig;
    rig.src.steady = true;  // a still room: every record the same
    REQUIRE(rig.svc.init(rig.core));
    rig.run([] { return false; }, 150);  // 1.5 s, 15 windows
    // The first window's value only: an unchanged motion never goes out again (the bench saw it 10 times a second).
    REQUIRE_EQ(rig.props(fr::cap::Csi::kPropMotion).size(), 1u);
    CHECK_EQ(rig.props(fr::cap::Csi::kPropMotion)[0], 0u);
    CHECK_EQ(rig.svc.motion(), 0u);

    // Something moves: every amplitude doubles, motion jumps far past the deadband and goes out within two windows.
    const size_t before = rig.sink.properties().size();
    rig.src.level = 40;
    REQUIRE(rig.run([&] { return rig.props(fr::cap::Csi::kPropMotion).size() > 1; }, 20));
    CHECK(rig.props(fr::cap::Csi::kPropMotion)[1] > fr::CsiService::kMotionDeadband * 10u);
    CHECK(rig.sink.properties().size() > before);

    // The baseline follows (about 2 s): motion falls back. A report either moved past the deadband from the one before,
    // or came at least a second after it; never twice the same value.
    rig.run([] { return false; }, 600);
    std::vector<RecordingSink::Emission> ms;
    for (const auto &e : rig.sink.properties()) {
        if (e.port == kCsiPort && e.id == fr::cap::Csi::kPropMotion) {
            ms.push_back(e);
        }
    }
    REQUIRE(ms.size() >= 3);
    CHECK(ms.size() < 60);  // 6 s of windows would be 60
    for (size_t i = 2; i < ms.size(); ++i) {
        const uint64_t a = frt::field_u(ms[i - 1].bytes, 1);
        const uint64_t b = frt::field_u(ms[i].bytes, 1);
        const uint64_t moved = a > b ? a - b : b - a;
        CHECK(moved != 0);
        CHECK(moved > fr::CsiService::kMotionDeadband || ms[i].emitted - ms[i - 1].emitted >= fr::CsiService::kSlowUs);
    }
    CHECK(rig.svc.motion() < fr::CsiService::kMotionDeadband * 10u);  // settled near the new still room
}

/**
 * fr_stream in real time, as on the board: a feeder thread (the Wi-Fi task) hands over HE20 records (490 bytes, the
 * C5's largest) at 127 Hz, the bench's rate; fr_stream passes on this thread, which moves core time with the clock.
 * It measures each pass and the longest real time between two feature windows.
 */
struct RealTime {
    explicit RealTime(Rig &r) : rig(r) {}
    ~RealTime() { stop_feeding(); }

    void start_feeding()
    {
        feeder = std::thread([this] {
            auto next = std::chrono::steady_clock::now();
            for (uint32_t n = 0; !stop.load(std::memory_order_relaxed); ++n) {
                rig.src.frame(n, 490);
                offered.fetch_add(1, std::memory_order_relaxed);
                next += std::chrono::microseconds(1'000'000 / 127);
                std::this_thread::sleep_until(next);
            }
        });
    }
    void stop_feeding()
    {
        stop.store(true);
        if (feeder.joinable()) {
            feeder.join();
        }
    }
    /** Passes until `done` or `max_ms` of real time. */
    bool run(const std::function<bool()> &done, int max_ms)
    {
        using clock = std::chrono::steady_clock;
        const auto t0 = clock::now();
        auto moved = t0;  // core time is moved up to here
        uint32_t win = rig.svc.windows();
        auto win_at = t0;
        while (clock::now() - t0 < std::chrono::milliseconds(max_ms)) {
            const auto a = clock::now();
            const bool busy = fr::audio::engine().stream_once();
            const auto b = clock::now();
            longest_pass = std::max(longest_pass, b - a);
            const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(b - moved);
            if (ms.count() > 0) {
                rig.core.advance_ms(static_cast<uint32_t>(ms.count()));
                moved += ms;
            }
            if (rig.svc.windows() != win) {
                win = rig.svc.windows();
                longest_gap = std::max(longest_gap, b - win_at);
                win_at = b;
            }
            if (done()) {
                return true;
            }
            if (!busy) {
                std::this_thread::sleep_for(std::chrono::milliseconds(5));  // Engine::kWaitMs's idle wait, shorter
            }
        }
        return false;
    }
    static long ms(std::chrono::steady_clock::duration d)
    {
        return static_cast<long>(std::chrono::duration_cast<std::chrono::milliseconds>(d).count());
    }

    Rig &rig;
    std::thread feeder;
    std::atomic<bool> stop{false};
    std::atomic<uint32_t> offered{0};
    std::chrono::steady_clock::duration longest_pass{};
    std::chrono::steady_clock::duration longest_gap{};
};

TEST(csi_service_slow_hub_answer_does_not_hold_the_features)
{
    // The hub takes 2 s to answer the stream's end (the review's case: fr_stream blocked up to 3 s on it, and the
    // 4 KB ring holds ~55 ms of HE20 records at 127 Hz). Answered in 20 ms slices, the windows keep closing every
    // 100 ms and the ring drains: no pass holds fr_stream long, nothing (or next to nothing) is dropped.
    Hub hub;
    hub.answer_delay_ms = 2000;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    RealTime rt(rig);
    rt.start_feeding();
    rt.run([] { return false; }, 300);
    REQUIRE(rig.svc.stream_start(start_args(11, 1)));
    REQUIRE(rt.run([&] { return !rig.events().empty(); }, 6000));
    rt.run([] { return false; }, 300);
    rt.stop_feeding();
    hub.join();
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.reason, kDone);
    CHECK_EQ(rig.svc.last_status(), 200);
    CHECK(e.records >= 100 && e.records <= 160);  // 1 s at 127 Hz
    CHECK_EQ(rig.svc.last_hub_records(), e.records - e.dropped);
    CHECK(RealTime::ms(rt.longest_pass) < 150);  // a slice is 20 ms (the old blocking answer: 2 s)
    CHECK(RealTime::ms(rt.longest_gap) < 400);   // a window is 100 ms
    const uint32_t offered = rt.offered.load();
    CHECK(offered > 400);
    CHECK(rig.svc.ring_dropped() * 20 <= offered);  // bounded: under 5 % (the old blocking answer lost ~40 %)
    CHECK(rig.svc.rate() >= 100 && rig.svc.rate() <= 150);
}

TEST(csi_service_slow_hub_connect_does_not_hold_the_features)
{
    // The hub's accept queue is full for 2 s: the stream's connect waits (its SYN retried), in slices. The features
    // and the ring go on meanwhile; the stream then either connects and runs (macOS: its SYN retry at ~3 s gets in),
    // or gives up at kStallMs (net_lost), as the stack's SYN retries fall.
    Hub hub(1);
    hub.slow_connect(2000);
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    RealTime rt(rig);
    rt.start_feeding();
    rt.run([] { return false; }, 300);
    REQUIRE(rig.svc.stream_start(start_args(12, 4)));  // `seconds` run from stream_start: the connect's wait in them
    REQUIRE(rt.run([&] { return !rig.events().empty(); }, 10000));
    rt.run([] { return false; }, 300);
    rt.stop_feeding();
    hub.join();
    const End e = end_of(rig.events()[0]);
    CHECK((e.reason == kDone && e.records > 50) || (e.reason == kNetLost && e.records == 0));
    CHECK(RealTime::ms(rt.longest_pass) < 150);
    CHECK(RealTime::ms(rt.longest_gap) < 400);
    const uint32_t offered = rt.offered.load();
    CHECK(offered > 300);
    CHECK(rig.svc.ring_dropped() * 20 <= offered);
}

// ---- fr.radio_tx ----

class FakeTx final : public fr::hal::RadioTx
{
public:
    fr::Status init(fr::Core &) override { return {}; }
    fr::Status start(const std::array<uint8_t, 6> &p, uint16_t r, uint16_t l) override
    {
        if (busy) {
            return std::unexpected(fr::Err::busy);
        }
        peer = p;
        rate = r;
        len = l;
        on = true;
        ++starts;
        return {};
    }
    fr::Status stop() override
    {
        on = false;
        ++stops;
        return {};
    }
    bool running() const override { return on; }
    fr::hal::Selftest selftest() override { return {true, "fake tx"}; }

    std::array<uint8_t, 6> peer{};
    uint16_t rate = 0, len = 0;
    bool on = false, busy = false;
    int starts = 0, stops = 0;
};

TEST(radio_tx_service_start_stop_and_seconds)
{
    FakeCore core;
    RecordingSink sink{core};
    FakeTx tx;
    fr::RadioTxService svc(tx);
    svc.attach(4, "tx", sink);
    REQUIRE(svc.init(core));
    const uint8_t peer[6] = {0x02, 1, 2, 3, 4, 5};
    const uint8_t group[6] = {0x01, 0, 0x5E, 0, 0, 1};
    const uint8_t five[5] = {2, 1, 2, 3, 4};
    fr::cap::RadioTxStartArgs a{};
    a.peer_mac = five;
    CHECK_EQ(svc.start(a).error(), fr::Err::invalid_args);
    a.peer_mac = group;
    CHECK_EQ(svc.start(a).error(), fr::Err::invalid_args);
    tx.busy = true;
    a.peer_mac = peer;
    CHECK_EQ(svc.start(a).error(), fr::Err::busy);
    CHECK(!svc.sending());
    tx.busy = false;
    a.rate_hz = 50;
    a.len = 64;
    a.seconds = 2;
    REQUIRE(svc.start(a));
    CHECK(svc.sending());
    CHECK_EQ(tx.rate, 50);
    CHECK_EQ(tx.len, 64);
    CHECK_EQ(tx.peer[5], 5u);
    core.advance_ms(1900);
    CHECK(svc.sending());
    core.advance_ms(200);
    CHECK(!svc.sending());  // its seconds
    CHECK(!tx.on);
    // A run the driver ended itself (the station lost its channel) is noticed.
    a.seconds = 0;
    REQUIRE(svc.start(a));
    tx.on = false;
    core.advance_ms(300);
    CHECK(!svc.sending());
    // stop: idempotent.
    CHECK(svc.stop());
    CHECK(svc.stop());
    std::vector<uint64_t> states;
    for (const auto &e : sink.properties()) {
        states.push_back(frt::field_u(e.bytes, 1));
    }
    CHECK(states == (std::vector<uint64_t>{1, 0, 1, 0}));
}

}  // namespace
