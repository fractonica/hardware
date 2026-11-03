// CameraService (design camera-c1 D7, D8, D10, §10) against FakeCore, a fake camera and a fake card, and a loopback hub
// that reads the mjpg1 stream: init brings the sensor up with the config; a hub stream paced by interval_ms, each chunk
// one frame behind the 24-byte head (seq, index, t_us, width, height, quality, frame_size, flags, len); slots missed
// while the path is busy counted in `dropped` (their indices skipped); a frame over kFrameMaxBytes dropped; a recording
// on the card (to sd, no hub), its list (a cache fr_stream refreshes, paged past 64), its fetch (flags b0, from a
// frame) and its delete (run by fr_stream, BUSY while pending); `both` writing the card first; `set` applied between
// grabs, during a `both` stream, and a stream's own quality; the head's size read from the frame's own SOF0; a refused
// set retried; net_lost without an endpoint, on the hub's 404 and on a post stalled past kStallMs; `error` after
// kNoFrameMs without a frame; the card refusing a recording; the refusals; stream_ended's fields and the properties;
// sdmmc_card's path layout. fr_stream runs by hand (Engine::set_manual): each round feeds the sensor one frame, one
// fr_stream pass, then 10 ms of core time.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "fr/audio/engine.hpp"
#include "fr/drv/sdmmc_layout.hpp"
#include "fr/services/camera_service.hpp"
#include "tests/camera_fakes.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCamera;
using frt::FakeCore;
using frt::FakeCard;
using frt::RecordingSink;
using fr::CameraService;
using fr::cap::CameraFrameSize;
using fr::cap::CameraTarget;

constexpr uint8_t kCamPort = 3;

uint16_t u16(const uint8_t *p)
{
    return static_cast<uint16_t>(p[0] | p[1] << 8);
}
uint32_t u32(const uint8_t *p)
{
    return static_cast<uint32_t>(p[0]) | static_cast<uint32_t>(p[1]) << 8 | static_cast<uint32_t>(p[2]) << 16 |
           static_cast<uint32_t>(p[3]) << 24;
}

/** One chunk as the hub got it: the head's fields and the JPEG. */
struct Block {
    uint32_t seq = 0, index = 0, t_us = 0, len = 0;
    uint16_t width = 0, height = 0, flags = 0;
    uint8_t quality = 0, frame_size = 0;
    std::vector<uint8_t> jpeg;
};

/**
 * A loopback hub for one stream POST: each chunk a block; `200 {"frames":N}` at its end, or `early_status` at once.
 * stall_ms: after the request head it reads nothing for that long (the node's sends then fill the socket and block).
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
        // A served thread nobody connected to (a test that bailed early) sits in accept(): wake it with a connect of
        // our own, so a failed REQUIRE reports instead of hanging the suite.
        if (thread_.joinable()) {
            stop_ = true;
            const int c = ::socket(AF_INET, SOCK_STREAM, 0);
            sockaddr_in a{};
            a.sin_family = AF_INET;
            a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            a.sin_port = htons(port);
            if (c >= 0) {
                ::connect(c, reinterpret_cast<const sockaddr *>(&a), sizeof(a));
            }
            join();
            if (c >= 0) {
                ::close(c);
            }
        }
        ::close(fd_);
    }
    void serve(int early_status = 0)
    {
        thread_ = std::thread([this, early_status] { conn(early_status); });
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
    int stall_ms = 0;

private:
    bool need(int c, size_t n)
    {
        char tmp[16384];
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
        if (stop_) {
            ::close(c);
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
        if (stall_ms > 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(stall_ms));
        }
        uint32_t frames = 0;
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
            if (len >= CameraService::kHeadBytes) {
                b.seq = u32(p);
                b.index = u32(p + 4);
                b.t_us = u32(p + 8);
                b.width = u16(p + 12);
                b.height = u16(p + 14);
                b.quality = p[16];
                b.frame_size = p[17];
                b.flags = u16(p + 18);
                b.len = u32(p + 20);
                b.jpeg.assign(p + CameraService::kHeadBytes, p + len);
            }
            ++frames;
            buf_.erase(0, len + 2);
            const std::lock_guard<std::mutex> g(m_);
            blocks_.push_back(std::move(b));
        }
        const std::string body = "{\"frames\":" + std::to_string(frames) + "}";
        const std::string r = "HTTP/1.1 200 OK\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body;
        ::send(c, r.data(), r.size(), 0);
        ::shutdown(c, SHUT_WR);
        char tmp[256];
        while (::recv(c, tmp, sizeof(tmp), 0) > 0) {
        }
        ::close(c);
    }

    int fd_ = -1;
    std::atomic<bool> stop_{false};
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
    explicit Rig(fr::cap::CameraConfig cfg = {}, bool with_store = true) : svc(cam, with_store ? &store : nullptr, cfg)
    {
        fr::audio::engine().set_manual(true);
        fr::stream::set_stream_host(&host);
        svc.attach(kCamPort, "cam", sink);
    }
    ~Rig() { fr::stream::set_stream_host(nullptr); }

    /** Rounds of 10 ms: the sensor's newest frame (when feeding), one fr_stream pass, 10 ms of core time; until `done`. */
    bool run(const std::function<bool()> &done, int max = 1000)
    {
        for (int i = 0; i < max; ++i) {
            if (feeding) {
                cam.frame(frame_bytes);
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
            if (e.port == kCamPort && e.id == id) {
                out.push_back(frt::field_u(e.bytes, 1));
            }
        }
        return out;
    }

    FakeCore core;
    RecordingSink sink{core};
    TestHost host;
    FakeCamera cam{core};
    FakeCard store{core};
    fr::CameraService svc;
    bool feeding = true;
    size_t frame_bytes = 3000;
};

struct End {
    uint64_t id, reason, frames, dropped, bytes;
};
End end_of(const RecordingSink::Emission &e)
{
    return {frt::field_u(e.bytes, 1), frt::field_u(e.bytes, 2), frt::field_u(e.bytes, 3), frt::field_u(e.bytes, 4),
            frt::field_u(e.bytes, 5)};
}
constexpr uint64_t kStopped = 0, kDone = 1, kNetLost = 2, kOverflow = 3;

fr::cap::CameraStreamStartArgs start_args(uint32_t id, uint32_t max_frames, uint32_t interval_ms = 0,
                                          CameraTarget to = CameraTarget::hub, uint16_t seconds = 0)
{
    fr::cap::CameraStreamStartArgs a{};
    a.stream_id = id;
    a.seconds = seconds;
    a.interval_ms = interval_ms;
    a.max_frames = max_frames;
    a.to = to;
    return a;
}

bool is_jpeg(const std::vector<uint8_t> &j)
{
    return j.size() >= 4 && j[0] == 0xFF && j[1] == 0xD8 && j[j.size() - 2] == 0xFF && j.back() == 0xD9;
}

TEST(camera_service_init_starts_the_sensor_and_mounts_the_card)
{
    fr::cap::CameraConfig vcfg{};
    vcfg.vflip = true;
    vcfg.brightness = 1;
    Rig rig(vcfg);
    CHECK_EQ(rig.svc.stream_start(start_args(1, 1)).error(), fr::Err::failed);  // before init
    REQUIRE(rig.svc.init(rig.core));
    CHECK_EQ(rig.cam.inits, 1);
    CHECK(rig.cam.started);
    CHECK(rig.cam.init_args.max_frame_size == fr::hal::FrameSize::uxga);
    CHECK_EQ(rig.cam.init_args.fb_count, 2);
    CHECK_EQ(rig.cam.init_args.xclk_hz, 20'000'000u);
    CHECK(rig.cam.init_args.settings.frame_size == fr::hal::FrameSize::svga);
    CHECK_EQ(rig.cam.init_args.settings.quality, 12);
    CHECK(rig.cam.init_args.settings.vflip);
    CHECK_EQ(rig.store.inits, 1);
    CHECK(rig.svc.sd() == fr::cap::CameraCardState::mounted);
    CHECK_EQ(rig.svc.sd_free_mb(), 1000u);
    CHECK_EQ(rig.svc.traits().sensor, fr::hal::kSensorOv2640);
    CHECK(rig.svc.traits().max_frame_size == CameraFrameSize::uxga);
    CHECK(rig.svc.selftest().ok);
    CHECK(!rig.svc.streaming());
    // The first timer tick reports the card; nothing else changed.
    rig.feeding = false;
    rig.run([] { return false; }, 110);
    CHECK(rig.props(fr::cap::Camera::kPropSd) == (std::vector<uint64_t>{1}));
    CHECK(rig.props(fr::cap::Camera::kPropSdFreeMb) == (std::vector<uint64_t>{1000}));
    CHECK(rig.props(fr::cap::Camera::kPropFrames).empty());
    CHECK(rig.props(fr::cap::Camera::kPropFpsX10).empty());
    CHECK(rig.props(fr::cap::Camera::kPropStreaming).empty());
    // The first pass set the config's settings on the sensor once (start() left vflip and the levels at the sensor's
    // defaults, as esp_camera_init does): vflip and brightness reached it; no set after that.
    REQUIRE_EQ(rig.cam.sets.size(), 1u);
    CHECK(rig.cam.applied.vflip);
    CHECK_EQ(rig.cam.applied.brightness, 1);
    CHECK(rig.cam.applied.frame_size == fr::hal::FrameSize::svga);
    rig.run([] { return false; }, 5);
    CHECK_EQ(rig.cam.sets.size(), 1u);

    // Config sd false: the card is never touched, none reported.
    fr::cap::CameraConfig cfg{};
    cfg.sd = false;
    Rig off(cfg);
    REQUIRE(off.svc.init(off.core));
    CHECK_EQ(off.store.inits, 0);
    CHECK(off.svc.sd() == fr::cap::CameraCardState::none);
    CHECK_EQ(off.svc.sd_list({}).error(), fr::Err::unsupported);

    // A sensor that does not come up fails init.
    Rig bad;
    bad.cam.fail_start = true;
    CHECK_EQ(bad.svc.init(bad.core).error(), fr::Err::failed);

    // A host fault at the mount does not: the sensor starts, the card reads error, the sd_* commands refuse.
    Rig fault;
    fault.store.fail_init = true;
    REQUIRE(fault.svc.init(fault.core));
    CHECK(fault.cam.started);
    CHECK(fault.svc.sd() == fr::cap::CameraCardState::error);
    CHECK_EQ(fault.svc.sd_free_mb(), 0u);
    CHECK_EQ(fault.svc.sd_list({}).error(), fr::Err::unsupported);
    CHECK_EQ(fault.svc.stream_start(start_args(1, 1, 0, CameraTarget::sd)).error(), fr::Err::invalid_args);
    fault.run([] { return false; }, 110);
    CHECK(fault.props(fr::cap::Camera::kPropSd) == (std::vector<uint64_t>{2}));
    CHECK_EQ(fault.store.lists, 0);  // never walked
}

TEST(camera_service_hub_stream_paced_by_interval)
{
    Hub hub;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    rig.run([] { return false; }, 20);
    REQUIRE(rig.svc.stream_start(start_args(7, 5, 100)));
    CHECK(rig.svc.streaming());
    CHECK_EQ(rig.svc.stream_start(start_args(8, 1)).error(), fr::Err::busy);
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 400));
    hub.join();
    CHECK(hub.head.starts_with("POST /v1/stream/in/7 HTTP/1.1\r\n"));
    CHECK(hub.head.find("X-Fr-Device: a1b2c3d4e5f6\r\n") != std::string::npos);
    CHECK(hub.head.find("X-Fr-Kind: jpeg\r\n") != std::string::npos);
    CHECK(hub.head.find("X-Fr-Format: mjpg1\r\n") != std::string::npos);
    CHECK(hub.head.find("Transfer-Encoding: chunked\r\n") != std::string::npos);
    CHECK(hub.ended);
    const auto blocks = hub.blocks();
    REQUIRE_EQ(blocks.size(), 5u);
    for (size_t i = 0; i < blocks.size(); ++i) {
        const Block &b = blocks[i];
        CHECK_EQ(b.seq, static_cast<uint32_t>(i));
        CHECK_EQ(b.index, static_cast<uint32_t>(i));  // nothing dropped
        CHECK_EQ(b.width, 800);
        CHECK_EQ(b.height, 600);
        CHECK_EQ(b.quality, 12);
        CHECK_EQ(b.frame_size, 2);  // svga
        CHECK_EQ(b.flags, 0);
        CHECK_EQ(b.len, 3000u);
        CHECK_EQ(b.jpeg.size(), 3000u);
        CHECK(is_jpeg(b.jpeg));
        if (i > 0) {
            CHECK(b.t_us - blocks[i - 1].t_us >= 100'000u);  // a frame every 100 ms, by its start
            CHECK(b.t_us - blocks[i - 1].t_us <= 120'000u);
            CHECK(b.jpeg[23] != blocks[i - 1].jpeg[23]);  // the sensor's counter: distinct frames
        }
    }
    REQUIRE_EQ(rig.events().size(), 1u);
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.id, 7u);
    CHECK_EQ(e.reason, kDone);
    CHECK_EQ(e.frames, 5u);
    CHECK_EQ(e.dropped, 0u);
    CHECK_EQ(e.bytes, 15000u);
    CHECK_EQ(rig.svc.last_status(), 200);
    CHECK_EQ(rig.svc.last_hub_frames(), 5u);
    CHECK(!rig.svc.streaming());
    CHECK(rig.props(fr::cap::Camera::kPropStreaming) == (std::vector<uint64_t>{1, 0}));
    CHECK_EQ(rig.cam.grabs, 5u);
    CHECK_EQ(rig.cam.releases, 5u);  // every frame given back
    CHECK(rig.cam.held.empty());
    // The properties: frames and last_bytes on change, fps over the window then back to 0.
    rig.run([] { return false; }, 220);
    CHECK_EQ(rig.svc.frames(), 5u);
    CHECK_EQ(rig.props(fr::cap::Camera::kPropFrames).back(), 5u);
    CHECK_EQ(rig.svc.last_bytes(), 3000u);
    CHECK_EQ(rig.props(fr::cap::Camera::kPropLastBytes).back(), 3000u);
    const auto fps = rig.props(fr::cap::Camera::kPropFpsX10);
    REQUIRE(fps.size() >= 2);
    CHECK(fps[0] > 0 && fps[0] <= 50);
    CHECK_EQ(fps.back(), 0u);
    CHECK_EQ(rig.svc.fps_x10(), 0u);
    // stream_stop of it now: not the running stream any more.
    CHECK_EQ(rig.svc.stream_stop({.stream_id = 7}).error(), fr::Err::not_found);
}

TEST(camera_service_stream_stop_and_seconds)
{
    Hub hub;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(21, 0, 50)));
    CHECK_EQ(rig.svc.stream_stop({.stream_id = 22}).error(), fr::Err::not_found);
    rig.run([] { return false; }, 40);
    REQUIRE(rig.svc.stream_stop({.stream_id = 21}));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 100));
    hub.join();
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.reason, kStopped);
    CHECK(e.frames >= 7 && e.frames <= 9);  // 400 ms at 50 ms
    CHECK_EQ(e.frames, hub.blocks().size());

    Hub hub2;
    hub2.serve();
    Rig rig2;
    rig2.host.port = hub2.port;
    REQUIRE(rig2.svc.init(rig2.core));
    REQUIRE(rig2.svc.stream_start(start_args(23, 0, 100, CameraTarget::hub, 1)));
    REQUIRE(rig2.run([&] { return !rig2.events().empty(); }, 200));
    hub2.join();
    const End e2 = end_of(rig2.events()[0]);
    CHECK_EQ(e2.reason, kDone);
    CHECK(e2.frames >= 9 && e2.frames <= 11);  // 1 s at 100 ms
}

TEST(camera_service_slots_missed_while_the_card_is_busy_are_dropped)
{
    // A timelapse at 100 ms to a card whose writes take 250 ms: the slots that pass during a write are dropped (their
    // indices skipped), the card holds the frames written, numbered as written.
    Rig rig;  // no hub needed
    rig.store.slow_ms = 250;
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(5, 6, 100, CameraTarget::sd)));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 200));
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.id, 5u);
    CHECK_EQ(e.reason, kDone);
    CHECK_EQ(e.frames, 6u);   // the index reached
    CHECK_EQ(e.dropped, 3u);  // slots 1, 3 and 4
    REQUIRE_EQ(rig.store.recs.count(5), 1u);
    CHECK_EQ(rig.store.recs[5].size(), 3u);
    CHECK_EQ(e.bytes, 9000u);
    CHECK(!rig.store.index_gaps);  // 0, 1, 2 on the card
    CHECK_EQ(rig.store.closes, 1);
    CHECK(!rig.store.is_open());
}

TEST(camera_service_frame_over_the_cap_is_dropped)
{
    Hub hub;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(9, 3)));
    rig.feeding = false;
    rig.cam.frame(CameraService::kFrameMaxBytes + 1);
    rig.run([] { return false; }, 2);  // taken, dropped, given back
    CHECK_EQ(rig.cam.grabs, 1u);
    CHECK_EQ(rig.cam.releases, 1u);
    rig.feeding = true;
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 200));
    hub.join();
    const auto blocks = hub.blocks();
    REQUIRE_EQ(blocks.size(), 2u);
    CHECK_EQ(blocks[0].index, 1u);  // the gap where the long frame was
    CHECK_EQ(blocks[1].index, 2u);
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.reason, kDone);
    CHECK_EQ(e.frames, 3u);
    CHECK_EQ(e.dropped, 1u);
    CHECK_EQ(e.bytes, 6000u);
    CHECK_EQ(rig.svc.frames(), 3u);  // the sensor delivered three
}

TEST(camera_service_card_recording_list_fetch_delete)
{
    Rig rig;  // host.port 0: no session; a recording needs none
    REQUIRE(rig.svc.init(rig.core));
    CHECK_EQ(rig.svc.sd_fetch({.stream_id = 1, .recording = 7}).error(), fr::Err::not_found);
    CHECK(rig.svc.sd_delete({.recording = 7}));  // nothing there: idempotent
    // Four frames of growing size to the card.
    REQUIRE(rig.svc.stream_start(start_args(7, 4, 0, CameraTarget::sd)));
    CHECK_EQ(rig.svc.sd_delete({.recording = 7}).error(), fr::Err::busy);  // the stream writes it
    size_t n = 0;
    REQUIRE(rig.run(
        [&] {
            rig.frame_bytes = 1000 * (++n + 1);
            return !rig.events().empty();
        },
        100));
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.id, 7u);
    CHECK_EQ(e.reason, kDone);
    CHECK_EQ(e.frames, 4u);
    CHECK_EQ(e.dropped, 0u);
    REQUIRE_EQ(rig.store.recs.count(7), 1u);
    REQUIRE_EQ(rig.store.recs[7].size(), 4u);
    uint32_t bytes = 0;
    for (const auto &f : rig.store.recs[7]) {
        bytes += static_cast<uint32_t>(f.size());
        CHECK(is_jpeg(f));
    }
    CHECK_EQ(e.bytes, bytes);
    CHECK_EQ(rig.store.opens, 1);
    CHECK_EQ(rig.store.closes, 1);

    // The list: one recording, no next page; from past the end: none.
    auto list = rig.svc.sd_list({.from = 0});
    REQUIRE(list.has_value());
    REQUIRE_EQ(list->recordings.size(), 1u);
    CHECK_EQ(list->recordings[0].id, 7u);
    CHECK_EQ(list->recordings[0].frames, 4u);
    CHECK_EQ(list->recordings[0].bytes, bytes);
    CHECK_EQ(list->next, 0u);
    list = rig.svc.sd_list({.from = 1});
    REQUIRE(list.has_value());
    CHECK_EQ(list->recordings.size(), 0u);

    // The fetch, from frame 1: three blocks from the card, flags b0, the head's size from the JPEG itself.
    Hub hub;
    hub.serve();
    rig.host.port = hub.port;
    rig.sink.clear();
    rig.feeding = false;
    REQUIRE(rig.svc.sd_fetch({.stream_id = 9, .recording = 7, .from_frame = 1}));
    CHECK(rig.svc.streaming());
    CHECK_EQ(rig.svc.sd_fetch({.stream_id = 10, .recording = 7}).error(), fr::Err::busy);
    CHECK_EQ(rig.svc.sd_delete({.recording = 7}).error(), fr::Err::busy);  // the stream reads it
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 200));
    hub.join();
    CHECK(hub.head.starts_with("POST /v1/stream/in/9 HTTP/1.1\r\n"));
    CHECK(hub.head.find("X-Fr-Kind: jpeg\r\n") != std::string::npos);
    const auto blocks = hub.blocks();
    REQUIRE_EQ(blocks.size(), 3u);
    for (size_t i = 0; i < blocks.size(); ++i) {
        const Block &b = blocks[i];
        CHECK_EQ(b.seq, static_cast<uint32_t>(i));
        CHECK_EQ(b.index, static_cast<uint32_t>(i + 1));
        CHECK_EQ(b.flags, CameraService::kFlagFromCard);
        CHECK_EQ(b.width, 800);
        CHECK_EQ(b.height, 600);
        CHECK_EQ(b.frame_size, 2);
        CHECK_EQ(b.quality, 0);  // unknown for a card frame
        CHECK(b.jpeg == rig.store.recs[7][i + 1]);
        CHECK_EQ(b.len, static_cast<uint32_t>(rig.store.recs[7][i + 1].size()));
    }
    const End f = end_of(rig.events()[0]);
    CHECK_EQ(f.id, 9u);
    CHECK_EQ(f.reason, kDone);
    CHECK_EQ(f.frames, 3u);
    CHECK_EQ(f.dropped, 0u);
    CHECK_EQ(f.bytes, bytes - static_cast<uint32_t>(rig.store.recs[7][0].size()));
    CHECK_EQ(rig.cam.grabs, 4u);  // the fetch took nothing from the sensor
    CHECK_EQ(rig.svc.last_hub_frames(), 3u);

    // The delete: OK at once, done by fr_stream on its next pass; a second one is BUSY until then, then idempotent.
    CHECK(rig.svc.sd_delete({.recording = 7}));
    CHECK(rig.svc.delete_pending());
    CHECK_EQ(rig.store.recs.count(7), 1u);  // not yet
    CHECK_EQ(rig.svc.sd_delete({.recording = 7}).error(), fr::Err::busy);
    CHECK_EQ(rig.svc.sd_fetch({.stream_id = 11, .recording = 7}).error(), fr::Err::busy);
    rig.run([] { return false; }, 1);
    CHECK(!rig.svc.delete_pending());
    CHECK_EQ(rig.store.recs.count(7), 0u);
    CHECK_EQ(rig.store.removes, 2);  // the idempotent one at the top of the test went through fr_stream too
    list = rig.svc.sd_list({.from = 0});
    REQUIRE(list.has_value());
    CHECK_EQ(list->recordings.size(), 0u);  // the cache followed the delete
    CHECK(rig.svc.sd_delete({.recording = 7}));
    rig.run([] { return false; }, 1);
    CHECK_EQ(rig.svc.sd_fetch({.stream_id = 11, .recording = 7}).error(), fr::Err::not_found);
}

TEST(camera_service_sd_list_is_a_cache_fr_stream_refreshes)
{
    // Recordings from before this boot: on the card at init, in the list once fr_stream's first pass has walked it.
    Rig rig;
    for (uint32_t id = 1; id <= 70; ++id) {
        rig.store.recs[id] = {frt::fake_jpeg(100 + id, 800, 600, 1)};
    }
    REQUIRE(rig.svc.init(rig.core));
    auto list = rig.svc.sd_list({.from = 0});
    REQUIRE(list.has_value());
    CHECK_EQ(list->recordings.size(), 0u);  // not walked yet: the core never does
    CHECK_EQ(rig.store.lists, 0);
    rig.feeding = false;
    rig.run([] { return false; }, 1);
    CHECK(rig.store.lists >= 1);
    // Paging past 64: a page of 64 with next 64, then the six left with next 0, then nothing.
    list = rig.svc.sd_list({.from = 0});
    REQUIRE(list.has_value());
    REQUIRE_EQ(list->recordings.size(), 64u);
    CHECK_EQ(list->recordings[0].id, 1u);
    CHECK_EQ(list->recordings[0].bytes, 101u);
    CHECK_EQ(list->recordings[63].id, 64u);
    CHECK_EQ(list->next, 64u);
    list = rig.svc.sd_list({.from = 64});
    REQUIRE(list.has_value());
    REQUIRE_EQ(list->recordings.size(), 6u);
    CHECK_EQ(list->recordings[5].id, 70u);
    CHECK_EQ(list->next, 0u);
    list = rig.svc.sd_list({.from = 70});
    REQUIRE(list.has_value());
    CHECK_EQ(list->recordings.size(), 0u);
    CHECK_EQ(list->next, 0u);
    list = rig.svc.sd_list({.from = 1000});
    REQUIRE(list.has_value());
    CHECK_EQ(list->recordings.size(), 0u);
    CHECK_EQ(list->next, 0u);
    // A recording made now is listed once its close refreshed the cache (the stream's end), without another command.
    const int lists = rig.store.lists;
    rig.feeding = true;
    REQUIRE(rig.svc.stream_start(start_args(71, 2, 0, CameraTarget::sd)));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 100));
    CHECK(rig.store.lists > lists);
    list = rig.svc.sd_list({.from = 64});
    REQUIRE(list.has_value());
    REQUIRE_EQ(list->recordings.size(), 7u);
    CHECK_EQ(list->recordings[6].id, 71u);
    CHECK_EQ(list->recordings[6].frames, 2u);
    CHECK(rig.svc.sd_fetch({.stream_id = 72, .recording = 71}).has_value());  // known to the cache
    REQUIRE(rig.run([&] { return rig.events().size() >= 2; }, 100));  // no hub: ends net_lost, the card untouched

    // A card with more than the cache holds lists the first kListCacheMax by id.
    Rig big;
    for (uint32_t id = 1; id <= CameraService::kListCacheMax + 10; ++id) {
        big.store.recs[id] = {};
    }
    REQUIRE(big.svc.init(big.core));
    big.feeding = false;
    big.run([] { return false; }, 1);
    uint32_t seen = 0;
    uint32_t from = 0;
    for (int page = 0; page < 10; ++page) {
        list = big.svc.sd_list({.from = from});
        REQUIRE(list.has_value());
        seen += static_cast<uint32_t>(list->recordings.size());
        if (list->next == 0) {
            break;
        }
        from = list->next;
    }
    CHECK_EQ(seen, CameraService::kListCacheMax);
    CHECK_EQ(big.svc.sd_fetch({.stream_id = 1, .recording = CameraService::kListCacheMax + 1}).error(), fr::Err::not_found);
}

TEST(camera_service_sd_delete_runs_on_fr_stream_after_a_stream)
{
    // A delete asked for while a stream runs (of another recording) is OK at once and runs when the stream ends; the
    // free space it gives back is reported at the tick after.
    Rig rig;
    rig.store.recs[3] = {frt::fake_jpeg(5000, 800, 600, 1)};
    REQUIRE(rig.svc.init(rig.core));
    rig.run([] { return false; }, 1);
    REQUIRE(rig.svc.stream_start(start_args(4, 5, 50, CameraTarget::sd)));
    rig.run([] { return false; }, 2);
    CHECK(rig.svc.sd_delete({.recording = 3}));
    CHECK_EQ(rig.svc.sd_delete({.recording = 3}).error(), fr::Err::busy);  // one at a time
    CHECK_EQ(rig.svc.sd_delete({.recording = 4}).error(), fr::Err::busy);  // the stream's own
    rig.run([] { return false; }, 3);
    CHECK_EQ(rig.store.recs.count(3), 1u);  // the stream runs: the delete waits
    CHECK(rig.svc.delete_pending());
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 100));
    CHECK_EQ(end_of(rig.events()[0]).reason, kDone);
    rig.store.free = 1200;  // what the fake frees; the fake remove does not change it by itself
    rig.run([] { return false; }, 2);
    CHECK(!rig.svc.delete_pending());
    CHECK_EQ(rig.store.recs.count(3), 0u);
    CHECK_EQ(rig.store.recs.count(4), 1u);
    CHECK_EQ(rig.store.removes, 1);
    const auto list = rig.svc.sd_list({});
    REQUIRE(list.has_value());
    REQUIRE_EQ(list->recordings.size(), 1u);
    CHECK_EQ(list->recordings[0].id, 4u);
    rig.run([] { return false; }, 110);
    CHECK_EQ(rig.props(fr::cap::Camera::kPropSdFreeMb).back(), 1200u);
}

TEST(camera_service_card_refuses_the_recording)
{
    // FakeCard::fail_open: the card will not take a new recording (full): the stream ends overflow with nothing taken.
    Rig rig;
    rig.store.fail_open = true;
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(20, 0, 0, CameraTarget::sd)));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 20));
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.id, 20u);
    CHECK_EQ(e.reason, kOverflow);
    CHECK_EQ(e.frames, 0u);
    CHECK_EQ(e.bytes, 0u);
    CHECK_EQ(rig.store.opens, 0);
    CHECK_EQ(rig.store.closes, 0);
    CHECK_EQ(rig.cam.grabs, 0u);
    CHECK(!rig.svc.streaming());
    CHECK(rig.props(fr::cap::Camera::kPropStreaming) == (std::vector<uint64_t>{1, 0}));

    // `both` the same: the hub is never connected.
    Hub hub;
    Rig rig2;
    rig2.host.port = hub.port;  // a listener nobody serves: a connect would hang in connecting
    rig2.store.fail_open = true;
    REQUIRE(rig2.svc.init(rig2.core));
    REQUIRE(rig2.svc.stream_start(start_args(21, 0, 0, CameraTarget::both)));
    REQUIRE(rig2.run([&] { return !rig2.events().empty(); }, 20));
    CHECK_EQ(end_of(rig2.events()[0]).reason, kOverflow);
    CHECK_EQ(rig2.cam.grabs, 0u);
}

TEST(camera_service_stream_stop_with_a_chunk_in_flight)
{
    // Big frames as fast as the path takes them, stopped mid-way: the chunk in flight goes out whole before the end,
    // every frame is given back, the hub counts what it got.
    Hub hub;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    rig.frame_bytes = 200 * 1024;
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(40, 0, 0)));
    REQUIRE(rig.run([&] { return hub.blocks().size() >= 3; }, 400));
    REQUIRE(rig.svc.stream_stop({.stream_id = 40}));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 200));
    hub.join();
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.reason, kStopped);
    CHECK(hub.ended);
    CHECK_EQ(e.dropped, 0u);
    CHECK_EQ(e.frames, static_cast<uint64_t>(hub.blocks().size()));
    CHECK_EQ(rig.svc.last_hub_frames(), static_cast<uint32_t>(hub.blocks().size()));
    CHECK_EQ(e.bytes, static_cast<uint64_t>(hub.blocks().size()) * 200 * 1024);
    CHECK(rig.cam.held.empty());
    CHECK_EQ(rig.cam.grabs, rig.cam.releases);
    CHECK(!rig.svc.streaming());
}

TEST(camera_service_set_during_a_both_stream)
{
    Hub hub;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(50, 6, 20, CameraTarget::both)));
    REQUIRE(rig.run([&] { return hub.blocks().size() >= 2; }, 100));
    fr::cap::CameraSetArgs v{};
    v.has_frame_size = true;
    v.frame_size = CameraFrameSize::qvga;
    v.has_hmirror = true;
    v.hmirror = true;
    REQUIRE(rig.svc.set(v));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 200));
    hub.join();
    const auto blocks = hub.blocks();
    REQUIRE_EQ(blocks.size(), 6u);
    REQUIRE_EQ(rig.store.recs[50].size(), 6u);
    CHECK_EQ(blocks[0].width, 800);
    CHECK_EQ(blocks[5].width, 320);
    CHECK_EQ(blocks[5].frame_size, 0);
    size_t changes = 0;
    for (size_t i = 0; i < blocks.size(); ++i) {
        CHECK(blocks[i].jpeg == rig.store.recs[50][i]);  // the card got the same frame, the same size
        uint16_t w = 0, h = 0;
        CHECK(CameraService::jpeg_dims(rig.store.recs[50][i], w, h));
        CHECK_EQ(w, blocks[i].width);
        changes += i > 0 && blocks[i].width != blocks[i - 1].width ? 1 : 0;
    }
    CHECK_EQ(changes, 1u);
    CHECK(rig.cam.applied.hmirror);
    CHECK(rig.cam.applied.frame_size == fr::hal::FrameSize::qvga);
    CHECK(rig.svc.settings().hmirror);
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.reason, kDone);
    CHECK_EQ(e.frames, 6u);
    CHECK_EQ(e.bytes, 18000u);  // each frame once
    CHECK_EQ(rig.store.closes, 1);
}

TEST(camera_service_head_carries_the_frame_s_own_size)
{
    // A frame captured at svga, grabbed after a `set vga` reached the sensor: the sensor (and hal::Frame) say vga,
    // the JPEG says svga; the head follows the JPEG. The next frame is vga.
    Hub hub;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    rig.run([] { return false; }, 2);
    rig.feeding = false;
    rig.cam.queue.clear();  // nothing stale from the rounds above
    REQUIRE(rig.svc.stream_start(start_args(60, 2, 0)));
    rig.run([] { return false; }, 20);  // connected; grabs starved meanwhile
    CHECK(rig.svc.starved() > 0);
    CHECK(hub.blocks().empty());
    rig.cam.frame(3000);  // an svga frame, queued
    fr::cap::CameraSetArgs v{};
    v.has_frame_size = true;
    v.frame_size = CameraFrameSize::vga;
    REQUIRE(rig.svc.set(v));
    rig.run([] { return false; }, 1);  // the pass: set vga on the sensor, then grab the svga frame
    CHECK(rig.cam.applied.frame_size == fr::hal::FrameSize::vga);
    rig.feeding = true;
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 100));
    hub.join();
    const auto blocks = hub.blocks();
    REQUIRE_EQ(blocks.size(), 2u);
    CHECK_EQ(blocks[0].width, 800);
    CHECK_EQ(blocks[0].height, 600);
    CHECK_EQ(blocks[0].frame_size, 2);
    CHECK_EQ(blocks[1].width, 640);
    CHECK_EQ(blocks[1].height, 480);
    CHECK_EQ(blocks[1].frame_size, 1);
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.reason, kDone);
    CHECK_EQ(e.dropped, 0u);  // starved passes are not drops
}

TEST(camera_service_no_frame_for_k_no_frame_ms_ends_the_stream_error)
{
    // The sensor queues nothing (every frame overflowing esp32-camera's buffer, or dead): kNoFrameMs after the stream's
    // start it ends `error` with no frame taken; frames before that reset the clock.
    Rig rig;
    REQUIRE(rig.svc.init(rig.core));
    rig.feeding = false;
    REQUIRE(rig.svc.stream_start(start_args(70, 0, 0, CameraTarget::sd)));
    const uint32_t starved0 = rig.svc.starved();
    rig.run([] { return false; }, CameraService::kNoFrameMs / 10 - 20);
    CHECK(rig.events().empty());
    CHECK(rig.svc.streaming());
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 40));
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.id, 70u);
    CHECK_EQ(e.reason, 4u);  // error
    CHECK_EQ(e.frames, 0u);
    CHECK_EQ(e.dropped, 0u);
    CHECK(rig.svc.starved() - starved0 >= CameraService::kNoFrameMs / 10 - 20);
    CHECK_EQ(rig.store.closes, 1);  // the (empty) recording closed
    CHECK(!rig.svc.streaming());

    // Frames coming, then stopping: the clock runs from the last one.
    Rig rig2;
    REQUIRE(rig2.svc.init(rig2.core));
    REQUIRE(rig2.svc.stream_start(start_args(71, 0, 100, CameraTarget::sd)));
    rig2.run([] { return false; }, 30);
    rig2.feeding = false;  // the frame queued last is taken at the next slot: the clock runs from it
    rig2.run([] { return false; }, CameraService::kNoFrameMs / 10 - 30);
    CHECK(rig2.events().empty());
    REQUIRE(rig2.run([&] { return !rig2.events().empty(); }, 60));
    const End e2 = end_of(rig2.events()[0]);
    CHECK_EQ(e2.reason, 4u);
    CHECK(e2.frames >= 3);
    CHECK_EQ(rig2.store.recs[71].size(), e2.frames - e2.dropped);
}

TEST(camera_service_refused_set_is_retried_then_left)
{
    Rig rig;
    REQUIRE(rig.svc.init(rig.core));
    rig.feeding = false;
    rig.run([] { return false; }, 2);
    REQUIRE_EQ(rig.cam.sets.size(), 1u);  // the first pass's
    // The sensor refuses: the same set goes again on the next pass, and takes once the sensor does.
    rig.cam.fail_set = true;
    fr::cap::CameraSetArgs s{};
    s.has_quality = true;
    s.quality = 10;
    REQUIRE(rig.svc.set(s));
    rig.run([] { return false; }, 1);
    CHECK_EQ(rig.cam.sets.size(), 2u);
    CHECK_EQ(rig.cam.applied.quality, 12);  // not applied
    rig.cam.fail_set = false;
    rig.run([] { return false; }, 1);
    CHECK_EQ(rig.cam.sets.size(), 3u);
    CHECK_EQ(rig.cam.applied.quality, 10);
    rig.run([] { return false; }, 3);
    CHECK_EQ(rig.cam.sets.size(), 3u);
    // A sensor that never takes it: kSetRetries passes, then left alone until the next change.
    rig.cam.fail_set = true;
    s.quality = 11;
    REQUIRE(rig.svc.set(s));
    rig.run([] { return false; }, 10);
    CHECK_EQ(rig.cam.sets.size(), 3u + CameraService::kSetRetries);
    CHECK_EQ(rig.cam.applied.quality, 10);
    s.quality = 9;
    REQUIRE(rig.svc.set(s));  // a new wish: tried again
    rig.run([] { return false; }, 1);
    CHECK_EQ(rig.cam.sets.size(), 4u + CameraService::kSetRetries);
}

TEST(sdmmc_layout_paths)
{
    namespace L = fr::drv::sdmmc_layout;
    L::Path p;
    L::dir_path(p, 0x1234abcd);
    CHECK_EQ(std::string(p), "/sdcard/fr/1234abcd");
    L::meta_path(p, 7);
    CHECK_EQ(std::string(p), "/sdcard/fr/00000007/meta.bin");
    L::shard_path(p, 7, 0);
    CHECK_EQ(std::string(p), "/sdcard/fr/00000007/000");
    L::frame_path(p, 7, 0);
    CHECK_EQ(std::string(p), "/sdcard/fr/00000007/000/000.jpg");
    L::frame_path(p, 7, 999);
    CHECK_EQ(std::string(p), "/sdcard/fr/00000007/000/999.jpg");
    L::frame_path(p, 7, 1000);
    CHECK_EQ(std::string(p), "/sdcard/fr/00000007/001/000.jpg");
    L::frame_path(p, 7, 3600);
    CHECK_EQ(std::string(p), "/sdcard/fr/00000007/003/600.jpg");
    L::frame_path(p, 0xFFFFFFFF, L::kFramesMax - 1);
    CHECK_EQ(std::string(p), "/sdcard/fr/ffffffff/999/999.jpg");
    CHECK(std::strlen(p) < L::kPathMax);
    CHECK_EQ(L::frame_shard(3600), 3u);
    CHECK_EQ(L::frame_slot(3600), 600u);
    CHECK_EQ(L::frame_index(3, 600), 3600u);
    for (uint32_t i : {0u, 1u, 999u, 1000u, 123456u, L::kFramesMax - 1}) {
        CHECK_EQ(L::frame_index(L::frame_shard(i), L::frame_slot(i)), i);
    }
    uint32_t v = 0;
    CHECK(L::parse_id("1234abcd", v));
    CHECK_EQ(v, 0x1234abcdu);
    CHECK(L::parse_id("1234ABCD", v));  // FatFs upper-cases
    CHECK_EQ(v, 0x1234abcdu);
    CHECK(!L::parse_id("1234abc", v));
    CHECK(!L::parse_id("1234abcg", v));
    CHECK(!L::parse_id("meta.bin", v));
    CHECK(L::parse_shard("003", v));
    CHECK_EQ(v, 3u);
    CHECK(!L::parse_shard("03", v));
    CHECK(!L::parse_shard("0003", v));
    CHECK(!L::parse_shard("meta.bin", v));
    CHECK(L::parse_frame("600.jpg", v));
    CHECK_EQ(v, 600u);
    CHECK(L::parse_frame("007.JPG", v));
    CHECK_EQ(v, 7u);
    CHECK(!L::parse_frame("0007.jpg", v));
    CHECK(!L::parse_frame("600.png", v));
    CHECK(!L::parse_frame("meta.bin", v));
}

TEST(camera_service_both_writes_the_card_first_then_the_hub)
{
    Hub hub;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(12, 3, 0, CameraTarget::both)));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 200));
    hub.join();
    const auto blocks = hub.blocks();
    REQUIRE_EQ(blocks.size(), 3u);
    REQUIRE_EQ(rig.store.recs[12].size(), 3u);
    for (size_t i = 0; i < 3; ++i) {
        CHECK(blocks[i].jpeg == rig.store.recs[12][i]);
        CHECK_EQ(blocks[i].flags, 0);
    }
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.reason, kDone);
    CHECK_EQ(e.frames, 3u);
    CHECK_EQ(e.bytes, 9000u);  // each frame once

    // The hub refuses: net_lost, with what the card holds kept as a recording.
    Hub hub2;
    hub2.serve(404);
    Rig rig2;
    rig2.host.port = hub2.port;
    REQUIRE(rig2.svc.init(rig2.core));
    REQUIRE(rig2.svc.stream_start(start_args(13, 0, 0, CameraTarget::both)));
    REQUIRE(rig2.run([&] { return !rig2.events().empty(); }, 400));
    hub2.join();
    CHECK_EQ(end_of(rig2.events()[0]).reason, kNetLost);
    CHECK_EQ(rig2.svc.last_status(), 404);
    CHECK_EQ(rig2.store.recs.count(13), 1u);
    CHECK_EQ(rig2.store.closes, 1);
    CHECK(rig2.cam.held.empty());

    // The card fills: overflow, the recording closed with what went in.
    Rig rig3;
    rig3.store.fail_write_at = 3;
    REQUIRE(rig3.svc.init(rig3.core));
    REQUIRE(rig3.svc.stream_start(start_args(14, 0, 0, CameraTarget::sd)));
    REQUIRE(rig3.run([&] { return !rig3.events().empty(); }, 100));
    const End o = end_of(rig3.events()[0]);
    CHECK_EQ(o.reason, kOverflow);
    CHECK_EQ(rig3.store.recs[14].size(), 2u);
    CHECK_EQ(o.bytes, 6000u);
    CHECK_EQ(rig3.store.closes, 1);
    CHECK(rig3.cam.held.empty());
}

TEST(camera_service_set_between_grabs_and_a_stream_s_own_settings)
{
    fr::cap::CameraConfig cfg{};
    cfg.max_frame_size = CameraFrameSize::xga;
    Hub hub;
    hub.serve();
    Rig rig(cfg);
    rig.host.port = hub.port;
    REQUIRE(rig.svc.init(rig.core));
    // Past max_frame_size: refused, nothing kept.
    fr::cap::CameraSetArgs bad{};
    bad.has_frame_size = true;
    bad.frame_size = CameraFrameSize::uxga;
    CHECK_EQ(rig.svc.set(bad).error(), fr::Err::invalid_args);
    auto a = start_args(30, 2);
    a.has_frame_size = true;
    a.frame_size = CameraFrameSize::uxga;
    CHECK_EQ(rig.svc.stream_start(a).error(), fr::Err::invalid_args);
    CHECK(!rig.svc.streaming());
    // Idle: the sensor gets it at the next fr_stream pass (within the Engine's wait), once.
    fr::cap::CameraSetArgs s{};
    s.has_frame_size = true;
    s.frame_size = CameraFrameSize::xga;
    s.has_quality = true;
    s.quality = 10;
    s.has_vflip = true;
    s.vflip = true;
    REQUIRE(rig.svc.set(s));
    CHECK(rig.cam.sets.empty());
    rig.run([] { return false; }, 1);
    REQUIRE_EQ(rig.cam.sets.size(), 1u);
    CHECK(rig.cam.applied.frame_size == fr::hal::FrameSize::xga);
    CHECK_EQ(rig.cam.applied.quality, 10);
    CHECK(rig.cam.applied.vflip);
    CHECK(rig.svc.settings().frame_size == fr::hal::FrameSize::xga);
    rig.run([] { return false; }, 5);
    CHECK_EQ(rig.cam.sets.size(), 1u);  // not again
    // A stream's own quality: on the sensor for the stream, the kept one back at its end.
    a = start_args(31, 2);
    a.has_quality = true;
    a.quality = 8;
    REQUIRE(rig.svc.stream_start(a));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 100));
    hub.join();
    const auto blocks = hub.blocks();
    REQUIRE_EQ(blocks.size(), 2u);
    CHECK_EQ(blocks[0].quality, 8);
    CHECK_EQ(blocks[0].width, 1024);
    CHECK_EQ(blocks[0].frame_size, 3);
    CHECK(blocks[0].jpeg.size() == 3000);
    rig.run([] { return false; }, 2);
    CHECK_EQ(rig.cam.applied.quality, 10);
    CHECK(rig.cam.applied.vflip);
    CHECK_EQ(rig.cam.sets.size(), 3u);  // the stream's, then the kept ones back

    // During a stream: applied between two grabs, the later frames at the new size.
    Hub hub2;
    hub2.serve();
    rig.host.port = hub2.port;
    rig.sink.clear();
    REQUIRE(rig.svc.stream_start(start_args(32, 6, 20)));
    REQUIRE(rig.run([&] { return hub2.blocks().size() >= 2; }, 100));
    fr::cap::CameraSetArgs v{};
    v.has_frame_size = true;
    v.frame_size = CameraFrameSize::vga;
    REQUIRE(rig.svc.set(v));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 200));
    hub2.join();
    const auto b2 = hub2.blocks();
    REQUIRE_EQ(b2.size(), 6u);
    CHECK_EQ(b2[0].width, 1024);
    CHECK_EQ(b2[5].width, 640);
    CHECK_EQ(b2[5].frame_size, 1);
    CHECK_EQ(b2[5].quality, 10);
    size_t changes = 0;
    for (size_t i = 1; i < b2.size(); ++i) {
        changes += b2[i].width != b2[i - 1].width ? 1 : 0;
    }
    CHECK_EQ(changes, 1u);
    CHECK_EQ(rig.cam.sets.size(), 4u);
    CHECK(rig.svc.settings().frame_size == fr::hal::FrameSize::vga);
    CHECK_EQ(end_of(rig.events()[0]).reason, kDone);
}

TEST(camera_service_net_lost_without_an_endpoint_and_on_a_refusal)
{
    Rig rig;  // host.port 0: no TCP session
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(4, 0)));
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 50));
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.id, 4u);
    CHECK_EQ(e.reason, kNetLost);
    CHECK_EQ(e.frames, 0u);
    CHECK_EQ(rig.svc.stream_stop({.stream_id = 4}).error(), fr::Err::not_found);
    CHECK(rig.props(fr::cap::Camera::kPropStreaming) == (std::vector<uint64_t>{1, 0}));

    Hub hub;
    hub.serve(404);
    Rig rig2;
    rig2.host.port = hub.port;
    REQUIRE(rig2.svc.init(rig2.core));
    REQUIRE(rig2.svc.stream_start(start_args(5, 0)));
    REQUIRE(rig2.run([&] { return !rig2.events().empty(); }, 400));
    hub.join();
    CHECK_EQ(end_of(rig2.events()[0]).reason, kNetLost);
    CHECK_EQ(rig2.svc.last_status(), 404);
    CHECK(rig2.cam.held.empty());  // a frame in flight was given back
}

TEST(camera_service_net_lost_on_a_stalled_post)
{
    // The hub takes the head, then reads nothing for 5 s: the node's chunks fill the socket, the one in flight has not
    // gone in kStallMs, the stream ends net_lost (about 3 s of real time) and the frame is given back.
    Hub hub;
    hub.stall_ms = 5000;
    hub.serve();
    Rig rig;
    rig.host.port = hub.port;
    rig.frame_bytes = 256 * 1024;
    REQUIRE(rig.svc.init(rig.core));
    REQUIRE(rig.svc.stream_start(start_args(6, 0)));
    const auto t0 = std::chrono::steady_clock::now();
    REQUIRE(rig.run([&] { return !rig.events().empty(); }, 3000));
    const auto took = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0);
    hub.join();
    const End e = end_of(rig.events()[0]);
    CHECK_EQ(e.reason, kNetLost);
    CHECK(e.frames >= 1);
    CHECK(e.dropped >= 1);  // the frame in flight, never sent
    CHECK(e.frames - e.dropped == hub.blocks().size() || e.frames - e.dropped == hub.blocks().size() + 1);
    CHECK(took.count() >= 2500 && took.count() < 6000);
    CHECK(rig.cam.held.empty());
    CHECK(!rig.svc.streaming());
}

TEST(camera_service_refusals_without_a_card)
{
    Rig rig;
    rig.store.st = fr::hal::StoreState::none;
    REQUIRE(rig.svc.init(rig.core));
    CHECK(rig.svc.sd() == fr::cap::CameraCardState::none);
    CHECK_EQ(rig.svc.sd_free_mb(), 0u);
    CHECK_EQ(rig.svc.stream_start(start_args(1, 1, 0, CameraTarget::sd)).error(), fr::Err::invalid_args);
    CHECK_EQ(rig.svc.stream_start(start_args(1, 1, 0, CameraTarget::both)).error(), fr::Err::invalid_args);
    CHECK_EQ(rig.svc.sd_list({}).error(), fr::Err::unsupported);
    CHECK_EQ(rig.svc.sd_fetch({.stream_id = 1, .recording = 1}).error(), fr::Err::unsupported);
    CHECK_EQ(rig.svc.sd_delete({.recording = 1}).error(), fr::Err::unsupported);
    CHECK(!rig.svc.streaming());
    rig.run([] { return false; }, 110);
    CHECK(rig.props(fr::cap::Camera::kPropSd) == (std::vector<uint64_t>{0}));

    Rig none({}, false);  // no store wired at all
    REQUIRE(none.svc.init(none.core));
    CHECK(none.svc.sd() == fr::cap::CameraCardState::none);
    CHECK_EQ(none.svc.stream_start(start_args(1, 1, 0, CameraTarget::sd)).error(), fr::Err::invalid_args);
    CHECK_EQ(none.svc.sd_list({}).error(), fr::Err::unsupported);
}

TEST(camera_service_head_and_jpeg_dims)
{
    uint8_t h[CameraService::kHeadBytes];
    CameraService::encode_head(h, 0x01020304, 0x05060708, 0x090A0B0C, 800, 600, 12, 2, 1, 0x0000ABCD);
    CHECK_BYTES(h, frt::from_hex("04030201 08070605 0c0b0a09 2003 5802 0c 02 0100 cdab0000"));
    const auto j = frt::fake_jpeg(100, 1024, 768, 0x55);
    uint16_t w = 0, hh = 0;
    CHECK(CameraService::jpeg_dims(j, w, hh));
    CHECK_EQ(w, 1024);
    CHECK_EQ(hh, 768);
    const uint8_t not_jpeg[] = {0x00, 0x01, 0x02, 0x03};
    CHECK(!CameraService::jpeg_dims(not_jpeg, w, hh));
    const uint8_t soi_only[] = {0xFF, 0xD8, 0xFF, 0xD9};
    CHECK(!CameraService::jpeg_dims(soi_only, w, hh));
}

}  // namespace
