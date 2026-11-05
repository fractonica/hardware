// StorageService and ClockService against FakeCore, an in-memory file store and a fake RTC counting on the core's clock
// (design lcd-clock-c1 D5-D8): path rules, mount and the lost card, chunks, list paging, remount; the DS3231 register
// conversions; the rollover timestamp, set at a node time, lost_power, temperature, inject.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "tests/fake_worker.hpp"
#include "fr/rtc/ds3231_regs.hpp"
#include "fr/services/clock_service.hpp"
#include "fr/services/display_service.hpp"
#include "fr/services/storage_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using fr::ClockService;
using fr::Err;
using fr::StorageService;
using fr::TimeUs;
using frt::FakeCore;
using frt::RecordingSink;
namespace regs = fr::rtc::ds3231;

// ---- a store in memory ----

class FakeStore final : public fr::hal::FileStore
{
public:
    fr::Status init(fr::Core &) override { return {}; }
    fr::Status mount(uint8_t) override
    {
        ++mounts;
        if (!card) {
            return std::unexpected(Err::not_found);
        }
        mounted = true;
        return {};
    }
    void unmount() override { mounted = false; }
    fr::hal::StoreState state() const override { return mounted ? fr::hal::StoreState::mounted : fr::hal::StoreState::none; }
    fr::Status info(fr::hal::CardInfo &out) override
    {
        out.type = fr::hal::CardType::sdhc;
        out.total_mb = 30000;
        uint32_t used = 0;
        for (const auto &[k, v] : files) {
            used += static_cast<uint32_t>(v.size());
        }
        out.free_mb = 29000 - used / (1024 * 1024);
        std::snprintf(out.name, sizeof(out.name), "SD32G");
        out.speed_khz = 20000;
        ++infos;
        return {};
    }
    std::expected<size_t, Err> list(const char *path, uint16_t offset, std::span<fr::hal::FileEntry> out, bool &more) override
    {
        if (broken) {
            return std::unexpected(Err::failed);
        }
        std::string dir = path;
        if (dir != "/" && !dirs.count(dir)) {
            return std::unexpected(Err::not_found);
        }
        const std::string prefix = dir == "/" ? "/" : dir + "/";
        std::vector<std::pair<std::string, bool>> kids;
        for (const auto &[k, v] : files) {
            if (k.rfind(prefix, 0) == 0 && k.find('/', prefix.size()) == std::string::npos) {
                kids.push_back({k.substr(prefix.size()), false});
            }
        }
        for (const auto &d : dirs) {
            if (d.rfind(prefix, 0) == 0 && d.size() > prefix.size() && d.find('/', prefix.size()) == std::string::npos) {
                kids.push_back({d.substr(prefix.size()), true});
            }
        }
        size_t n = 0;
        more = false;
        for (size_t i = offset; i < kids.size(); ++i) {
            if (n == out.size()) {
                more = true;
                break;
            }
            out[n] = {};
            std::snprintf(out[n].name, sizeof(out[n].name), "%s", kids[i].first.c_str());
            out[n].dir = kids[i].second;
            out[n].size = kids[i].second ? 0 : static_cast<uint32_t>(files[prefix + kids[i].first].size());
            ++n;
        }
        return n;
    }
    fr::Status stat(const char *path, fr::hal::FileEntry &out) override
    {
        out = {};
        if (dirs.count(path)) {
            out.dir = true;
            return {};
        }
        auto it = files.find(path);
        if (it == files.end()) {
            return std::unexpected(Err::not_found);
        }
        out.size = static_cast<uint32_t>(it->second.size());
        return {};
    }
    std::expected<size_t, Err> read(const char *path, uint32_t offset, std::span<uint8_t> out, bool &eof) override
    {
        if (broken) {
            return std::unexpected(Err::failed);
        }
        auto it = files.find(path);
        if (it == files.end()) {
            return std::unexpected(Err::not_found);
        }
        const auto &f = it->second;
        size_t n = 0;
        while (offset + n < f.size() && n < out.size()) {
            out[n] = f[offset + n];
            ++n;
        }
        eof = offset + n >= f.size();
        return n;
    }
    std::expected<uint32_t, Err> write(const char *path, uint32_t offset, std::span<const uint8_t> data, bool truncate) override
    {
        if (broken) {
            return std::unexpected(Err::failed);
        }
        auto &f = files[path];
        if (f.size() < offset + data.size()) {
            f.resize(offset + data.size());
        }
        for (size_t i = 0; i < data.size(); ++i) {
            f[offset + i] = data[i];
        }
        if (truncate) {
            f.resize(offset + data.size());
        }
        ++writes;
        return static_cast<uint32_t>(f.size());
    }
    fr::Status remove(const char *path) override
    {
        if (files.erase(path) == 0 && dirs.erase(path) == 0) {
            return std::unexpected(Err::not_found);
        }
        return {};
    }
    fr::Status mkdir(const char *path) override
    {
        dirs.insert(path);
        return {};
    }
    fr::Status rename(const char *from, const char *to) override
    {
        auto it = files.find(from);
        if (it == files.end()) {
            return std::unexpected(Err::not_found);
        }
        files[to] = it->second;
        files.erase(it);
        return {};
    }
    fr::hal::Selftest selftest() override { return {true, "fake"}; }
    bool card_alive() override { return !dead; }

    bool card = true;
    bool dead = false;  // the card no longer answers a status command (pulled)
    bool mounted = false;
    bool broken = false;
    int mounts = 0;
    int infos = 0;
    int writes = 0;
    std::map<std::string, std::vector<uint8_t>> files;
    std::set<std::string> dirs;
};

constexpr uint8_t kStorePort = 4;

struct StoreRig {
    explicit StoreRig(fr::cap::StorageConfig cfg = {}) : svc(store, cfg) { svc.attach(kStorePort, "card", sink); }
    std::vector<RecordingSink::Emission> events(uint8_t id) const
    {
        std::vector<RecordingSink::Emission> out;
        for (const auto &e : sink.events()) {
            if (e.id == id) {
                out.push_back(e);
            }
        }
        return out;
    }
    FakeCore core;
    RecordingSink sink{core};
    FakeStore store;
    StorageService svc;
};

std::vector<uint8_t> bytes_of(const char *s)
{
    return std::vector<uint8_t>(s, s + std::strlen(s));
}

TEST(storage_paths)
{
    CHECK(StorageService::valid_path("/", true));
    CHECK(!StorageService::valid_path("/", false));
    CHECK(StorageService::valid_path("/a.txt", false));
    CHECK(StorageService::valid_path("/dir/sub/file name.bin", false));
    CHECK(!StorageService::valid_path("", false));
    CHECK(!StorageService::valid_path("a.txt", false));
    CHECK(!StorageService::valid_path("/a//b", false));
    CHECK(!StorageService::valid_path("/a/", false));
    CHECK(!StorageService::valid_path("/../x", false));
    CHECK(!StorageService::valid_path("/a/./b", false));
    CHECK(!StorageService::valid_path("/a\\b", false));
    CHECK(!StorageService::valid_path("/caf\xc3\xa9", false));
    CHECK(StorageService::valid_path("/" + std::string(95, 'x'), false));
    CHECK(!StorageService::valid_path("/" + std::string(96, 'x'), false));
}

TEST(storage_mounts_at_init_and_reports)
{
    StoreRig r;
    REQUIRE(r.svc.init(r.core));
    CHECK(r.svc.state() == fr::cap::StorageStoreState::mounted);
    CHECK_EQ(r.svc.total_mb(), 30000u);
    CHECK(r.svc.card_type() == fr::cap::StorageCardType::sdhc);
    CHECK_EQ(r.events(fr::cap::Storage::kEventMounted).size(), size_t{1});
    auto info = r.svc.info();
    REQUIRE(info.has_value());
    CHECK(info->name == "SD32G");
    CHECK_EQ(info->speed_khz, 20000u);
}

TEST(storage_no_card_is_none_and_info_retries)
{
    StoreRig r;
    r.store.card = false;
    REQUIRE(r.svc.init(r.core));
    CHECK(r.svc.state() == fr::cap::StorageStoreState::none);
    fr::cap::StorageReadArgs ra{};
    ra.path = "/a";
    CHECK(r.svc.read(ra).error() == Err::failed);
    r.store.card = true;
    // An attempt that ended just now is not repeated: info answers its state.
    auto info = r.svc.info();
    REQUIRE(info.has_value());
    CHECK(info->state == fr::cap::StorageStoreState::none);
    CHECK_EQ(r.store.mounts, 1);
    r.core.advance_ms(3'100);
    info = r.svc.info();
    REQUIRE(info.has_value());
    CHECK(info->state == fr::cap::StorageStoreState::mounted);
    CHECK_EQ(r.store.mounts, 2);
}

TEST(storage_mount_and_free_walk_run_on_the_worker_busy_meanwhile)
{
    frt::FakeWorker worker;
    StoreRig r;
    r.svc.use_worker(&worker);
    REQUIRE(r.svc.init(r.core));
    // The mount is queued on the worker: nothing touched the card yet, and every command answers BUSY.
    CHECK_EQ(r.store.mounts, 0);
    CHECK(r.svc.busy());
    CHECK(r.svc.info().error() == Err::busy);
    fr::cap::StorageReadArgs ra{};
    ra.path = "/a";
    CHECK(r.svc.read(ra).error() == Err::busy);
    CHECK(worker.run_all() == 1);
    CHECK_EQ(r.store.mounts, 1);
    r.core.advance_ms(30);  // the timer collects the result
    CHECK(!r.svc.busy());
    CHECK(r.svc.state() == fr::cap::StorageStoreState::mounted);
    CHECK_EQ(r.events(fr::cap::Storage::kEventMounted).size(), size_t{1});
    // A write schedules the free-space walk on the worker, at most every 10 s.
    fr::cap::StorageWriteArgs w{};
    w.path = "/x";
    const auto d = bytes_of("abc");
    w.data = d;
    REQUIRE(r.svc.write(w).has_value());
    const int infos = r.store.infos;
    r.core.advance_ms(10'100);
    CHECK(r.svc.busy());
    CHECK_EQ(r.store.infos, infos);
    CHECK(worker.run_all() == 1);
    CHECK_EQ(r.store.infos, infos + 1);
    r.core.advance_ms(30);
    CHECK(!r.svc.busy());
    // remount answers at once (none) and mounts in the background.
    auto rm = r.svc.remount();
    REQUIRE(rm.has_value());
    CHECK(rm->state == fr::cap::StorageStoreState::none);
    CHECK(r.svc.busy());
    worker.run_all();
    r.core.advance_ms(30);
    CHECK(r.svc.state() == fr::cap::StorageStoreState::mounted);
}

TEST(storage_write_read_round_trip_and_limits)
{
    fr::cap::StorageConfig cfg{};
    cfg.chunk = 512;
    StoreRig r(cfg);
    REQUIRE(r.svc.init(r.core));
    const auto data = bytes_of("hello fractonica");
    fr::cap::StorageWriteArgs w{};
    w.path = "/logs/a.txt";
    w.data = data;
    auto res = r.svc.write(w);
    REQUIRE(res.has_value());
    CHECK_EQ(res->size, uint32_t(data.size()));
    // Append at the end, then read in two pieces.
    w.offset = static_cast<uint32_t>(data.size());
    const auto more = bytes_of("!");
    w.data = more;
    REQUIRE(r.svc.write(w).has_value());
    fr::cap::StorageReadArgs ra{};
    ra.path = "/logs/a.txt";
    ra.len = 5;
    auto rd = r.svc.read(ra);
    REQUIRE(rd.has_value());
    CHECK_EQ(std::string(rd->data.begin(), rd->data.end()), std::string("hello"));
    CHECK(!rd->eof);
    ra.offset = 5;
    ra.len = 100;
    rd = r.svc.read(ra);
    REQUIRE(rd.has_value());
    CHECK_EQ(std::string(rd->data.begin(), rd->data.end()), std::string(" fractonica!"));
    CHECK(rd->eof);
    // Past the chunk: invalid before the card is touched.
    ra.len = 513;
    CHECK(r.svc.read(ra).error() == Err::invalid_args);
    std::vector<uint8_t> big(513, 1);
    w.data = big;
    const int before = r.store.writes;
    CHECK(r.svc.write(w).error() == Err::invalid_args);
    CHECK_EQ(r.store.writes, before);
    // A bad path never reaches the store.
    w.path = "/../x";
    w.data = more;
    CHECK(r.svc.write(w).error() == Err::invalid_args);
    // Truncate.
    w.path = "/logs/a.txt";
    w.offset = 2;
    w.truncate = true;
    auto t = r.svc.write(w);
    REQUIRE(t.has_value());
    CHECK_EQ(t->size, 3u);
}

TEST(storage_not_found_keeps_the_card_failure_loses_it)
{
    StoreRig r;
    REQUIRE(r.svc.init(r.core));
    fr::cap::StorageReadArgs ra{};
    ra.path = "/nope";
    CHECK(r.svc.read(ra).error() == Err::not_found);
    CHECK(r.svc.state() == fr::cap::StorageStoreState::mounted);
    r.store.broken = true;
    ra.path = "/x";
    r.store.files["/x"] = {1, 2, 3};
    // An I/O failure while the card still answers: FAILED, the card stays mounted.
    CHECK(r.svc.read(ra).error() == Err::failed);
    CHECK(r.svc.state() == fr::cap::StorageStoreState::mounted);
    CHECK(r.events(fr::cap::Storage::kEventUnmounted).empty());
    // The same once the card no longer answers: taken for removed.
    r.store.dead = true;
    CHECK(r.svc.read(ra).error() == Err::failed);
    CHECK(r.svc.state() == fr::cap::StorageStoreState::none);
    const auto ev = r.events(fr::cap::Storage::kEventUnmounted);
    REQUIRE_EQ(ev.size(), size_t{1});
    CHECK_EQ(frt::field_u(ev[0].bytes, 1), uint64_t(fr::cap::StorageUnmountReason::removed));
}

TEST(storage_list_pages_and_stat_rename_remove)
{
    StoreRig r;
    REQUIRE(r.svc.init(r.core));
    for (int i = 0; i < 20; ++i) {
        r.store.files["/f" + std::to_string(100 + i)] = {static_cast<uint8_t>(i)};
    }
    fr::cap::StorageListArgs la{};
    la.path = "/";
    auto page = r.svc.list(la);
    REQUIRE(page.has_value());
    CHECK_EQ(page->entries.size(), size_t{16});
    CHECK(page->more);
    la.offset = 16;
    page = r.svc.list(la);
    REQUIRE(page.has_value());
    CHECK_EQ(page->entries.size(), size_t{4});
    CHECK(!page->more);
    fr::cap::StorageStatArgs sa{};
    sa.path = "/f100";
    auto st = r.svc.stat(sa);
    REQUIRE(st.has_value());
    CHECK_EQ(st->entry.size, 1u);
    sa.path = "/";
    st = r.svc.stat(sa);
    REQUIRE(st.has_value());
    CHECK(st->entry.dir);
    fr::cap::StorageRenameArgs rn{};
    rn.from = "/f100";
    rn.to = "/g";
    CHECK(r.svc.rename(rn).has_value());
    CHECK(r.store.files.count("/g") == 1);
    fr::cap::StorageRemoveArgs rm{};
    rm.path = "/g";
    CHECK(r.svc.remove(rm).has_value());
    CHECK(r.svc.remove(rm).error() == Err::not_found);
}

TEST(storage_free_space_refresh_is_rate_limited)
{
    StoreRig r;
    REQUIRE(r.svc.init(r.core));
    const int infos = r.store.infos;
    fr::cap::StorageWriteArgs w{};
    w.path = "/a";
    const auto d = bytes_of("x");
    w.data = d;
    for (int i = 0; i < 5; ++i) {
        REQUIRE(r.svc.write(w).has_value());
    }
    CHECK_EQ(r.store.infos, infos);
    r.core.advance_ms(11'000);
    CHECK_EQ(r.store.infos, infos + 1);
}

TEST(storage_remount_emits_unmounted_command_then_mounted)
{
    StoreRig r;
    REQUIRE(r.svc.init(r.core));
    auto st = r.svc.remount();
    REQUIRE(st.has_value());
    CHECK(st->state == fr::cap::StorageStoreState::mounted);
    const auto un = r.events(fr::cap::Storage::kEventUnmounted);
    REQUIRE_EQ(un.size(), size_t{1});
    CHECK_EQ(frt::field_u(un[0].bytes, 1), uint64_t(fr::cap::StorageUnmountReason::command));
    CHECK_EQ(r.events(fr::cap::Storage::kEventMounted).size(), size_t{2});
}

// ---- DS3231 registers ----

TEST(ds3231_bcd)
{
    CHECK_EQ(regs::to_bcd(59), uint8_t(0x59));
    CHECK_EQ(*regs::from_bcd(0x42), uint8_t(42));
    CHECK(!regs::from_bcd(0x1A).has_value());
    CHECK(!regs::from_bcd(0xFF).has_value());
}

TEST(ds3231_time_round_trip)
{
    // 2024-02-29T00:00:00Z (a leap day), 2000-01-01, the last second of 2099, and now-ish.
    for (uint32_t t : {1709164800u, regs::kUnix2000, regs::kUnix2100 - 1, 1793880000u, 1793883599u}) {
        const auto r = regs::encode_time(t);
        const auto back = regs::decode_time(r);
        REQUIRE(back.has_value());
        CHECK_EQ(*back, t);
    }
    const auto leap = regs::encode_time(1709164800u);
    CHECK_EQ(leap[4], uint8_t(0x29));  // date
    CHECK_EQ(leap[5], uint8_t(0x02));  // month
    CHECK_EQ(leap[6], uint8_t(0x24));  // year
    CHECK_EQ(leap[3], uint8_t(4));     // a Thursday
    // Clamped to the chip's century.
    CHECK_EQ(*regs::decode_time(regs::encode_time(100)), regs::kUnix2000);
}

TEST(ds3231_twelve_hour_mode_and_garbage)
{
    // 12-hour, PM, 11 o'clock: 23:00 on 2026-11-05.
    std::array<uint8_t, 7> r = regs::encode_time(1793880000u);
    const uint32_t base = *regs::decode_time(r);
    r[2] = 0x40 | 0x20 | 0x11;
    const auto t = regs::decode_time(r);
    REQUIRE(t.has_value());
    CHECK_EQ(*t % 86400, 23u * 3600 + base % 3600);
    std::array<uint8_t, 7> ff{};
    ff.fill(0xFF);
    CHECK(!regs::decode_time(ff).has_value());
}

TEST(ds3231_decode_refuses_days_the_month_does_not_have)
{
    auto feb = regs::encode_time(1835395200u);  // 2028-02-29 (a leap year)
    CHECK(regs::decode_time(feb).has_value());
    auto bad = feb;
    bad[4] = regs::to_bcd(30);  // 2028-02-30
    CHECK(!regs::decode_time(bad).has_value());
    auto feb27 = regs::encode_time(1803772800u);  // 2027-02-28
    feb27[4] = regs::to_bcd(29);                  // 2027-02-29: not a leap year
    CHECK(!regs::decode_time(feb27).has_value());
    auto wd = feb;
    wd[3] = 0;  // weekday outside 1-7
    CHECK(!regs::decode_time(wd).has_value());
    CHECK_EQ(regs::days_in_month(2028, 2), 29u);
    CHECK_EQ(regs::days_in_month(2100, 2), 28u);
    CHECK_EQ(regs::days_in_month(2000, 2), 29u);
}

TEST(ds3231_temperature)
{
    CHECK_EQ(regs::temp_c10(25, 0x00), int16_t(250));
    CHECK_EQ(regs::temp_c10(25, 0x40), int16_t(253));  // 25.25 -> 25.3
    CHECK_EQ(regs::temp_c10(25, 0x80), int16_t(255));
    CHECK_EQ(regs::temp_c10(25, 0xC0), int16_t(258));  // 25.75 -> 25.8
    CHECK_EQ(regs::temp_c10(0xFF, 0xC0), int16_t(-3));  // -0.25
    CHECK_EQ(regs::temp_c10(0xF6, 0x00), int16_t(-100));
}

// ---- ClockService ----

class FakeRtc final : public fr::hal::Rtc
{
public:
    explicit FakeRtc(FakeCore &core) : core_(core) {}
    fr::Status init(fr::Core &) override { return {}; }
    uint32_t now_unix() const { return base + static_cast<uint32_t>((core_.now() - epoch) / 1'000'000); }
    std::expected<fr::hal::RtcTime, Err> now() override
    {
        if (dead || fail_bursts > 0) {
            fail_bursts -= fail_bursts > 0 ? 1 : 0;
            return std::unexpected(Err::failed);
        }
        return fr::hal::RtcTime{.unix = now_unix(), .osf = osf, .temp_c10 = temp, .aging = aging_v, .control_ok = control_ok};
    }
    std::expected<uint8_t, Err> seconds() override
    {
        if (dead) {
            return std::unexpected(Err::failed);
        }
        ++polls;
        return static_cast<uint8_t>(now_unix() % 60);
    }
    fr::Status set(uint32_t unix) override
    {
        set_at = core_.now();
        base = unix;
        epoch = core_.now();
        osf = false;
        return {};
    }
    std::expected<int16_t, Err> temp_c10() override { return temp; }
    std::expected<int8_t, Err> aging() override { return aging_v; }
    fr::Status set_aging(int8_t o) override
    {
        aging_v = o;
        return {};
    }
    void set_system_time(uint32_t unix) override { system = unix; }
    fr::hal::Selftest selftest() override { return {true, "fake"}; }
    void note(const char *what) override { notes.emplace_back(what); }
    /** A stray write: the chip's time moves by `s` seconds and its 1 Hz chain restarts now. */
    void stray(int32_t s)
    {
        base = static_cast<uint32_t>(static_cast<int64_t>(now_unix()) + s);
        epoch = core_.now();
    }

    FakeCore &core_;
    std::vector<std::string> notes;
    bool control_ok = true;
    uint32_t base = 1793880000;
    TimeUs epoch = 1'234'567;  // the chip's second boundary phase against the core's clock
    bool osf = false;
    bool dead = false;
    int16_t temp = 231;
    int8_t aging_v = 0;
    uint32_t system = 0;
    TimeUs set_at = 0;
    int polls = 0;
    int fail_bursts = 0;
};

constexpr uint8_t kClockPort = 5;

struct ClockRig {
    explicit ClockRig(fr::cap::ClockConfig cfg = {}) : rtc(core), svc(rtc, cfg) { svc.attach(kClockPort, "clock", sink); }
    std::vector<RecordingSink::Emission> events(uint8_t id) const
    {
        std::vector<RecordingSink::Emission> out;
        for (const auto &e : sink.events()) {
            if (e.id == id) {
                out.push_back(e);
            }
        }
        return out;
    }
    FakeCore core;
    RecordingSink sink{core};
    FakeRtc rtc;
    ClockService svc;
};

TEST(clock_next_poll_goes_fast_near_the_rollover)
{
    CHECK_EQ(ClockService::next_poll(0, 100'000, 0), TimeUs(100'000));
    // Far from the expected rollover: the period, clipped to the fast window's start.
    CHECK_EQ(ClockService::next_poll(800'000, 100'000, 1'000'000), TimeUs(900'000));
    CHECK_EQ(ClockService::next_poll(850'000, 100'000, 1'000'000), TimeUs(1'000'000 - ClockService::kFastBeforeUs));
    // Inside the window: fast.
    CHECK_EQ(ClockService::next_poll(950'000, 100'000, 1'000'000), TimeUs(950'000 + ClockService::kFastPollUs));
    // After it: the period again.
    CHECK_EQ(ClockService::next_poll(1'150'000, 100'000, 1'000'000), TimeUs(1'250'000));
}

TEST(clock_valid_time_seeds_the_system_and_rollovers_are_caught_within_10ms)
{
    ClockRig r;
    REQUIRE(r.svc.init(r.core));
    CHECK(r.svc.valid());
    CHECK_EQ(r.rtc.system, r.rtc.base);
    CHECK(r.events(fr::cap::Clock::kEventLostPower).empty());
    r.core.advance_ms(5'000);
    // The chip's boundaries are at epoch + k s; the last one seen is within one fast poll of one.
    const TimeUs phase = (r.svc.rollover_us() - r.rtc.epoch) % 1'000'000;
    CHECK(phase >= 0 && phase <= ClockService::kFastPollUs);
    auto rd = r.svc.read();
    REQUIRE(rd.has_value());
    CHECK_EQ(rd->unix, r.rtc.now_unix());
    CHECK_EQ(rd->temp_c10, int16_t(231));
    CHECK_EQ(rd->offset_ms, 0);
    // Not polling at 100 Hz all the time: about 10/s plus the fast windows (16 per window at most).
    CHECK(r.rtc.polls < 5 * (10 + 17));
}

TEST(clock_read_pairs_unix_with_the_rollover_it_began_at)
{
    ClockRig r;
    REQUIRE(r.svc.init(r.core));
    for (int step = 0; step < 40; ++step) {
        r.core.advance_ms(173);  // not a divisor of a second: reads land at every phase
        auto rd = r.svc.read();
        REQUIRE(rd.has_value());
        if (rd->rollover_us == 0) {
            continue;
        }
        // The second that began at rollover_us on the fake chip (the boundary is at most one fast poll before it).
        const TimeUs since = static_cast<TimeUs>(rd->rollover_us) - r.rtc.epoch;
        CHECK_EQ(rd->unix, r.rtc.base + static_cast<uint32_t>(since / 1'000'000));
        // The first rollovers are caught at the normal period; the fast window then closes in within ~3 s.
        if (step >= 20) {
            CHECK(since % 1'000'000 <= ClockService::kFastPollUs);
        }
    }
    // A failed burst at a rollover keeps the old pair instead of a new rollover with an old second.
    const auto before = *r.svc.read();
    r.rtc.fail_bursts = 1000;
    r.core.advance_ms(2'500);
    const auto during = *r.svc.read();
    CHECK_EQ(during.rollover_us, before.rollover_us);
    CHECK_EQ(during.unix, before.unix);
    r.rtc.fail_bursts = 0;
    r.core.advance_ms(1'500);
    const auto after = *r.svc.read();
    CHECK(after.rollover_us > before.rollover_us);
    CHECK_EQ(after.unix, r.rtc.base + static_cast<uint32_t>((static_cast<TimeUs>(after.rollover_us) - r.rtc.epoch) / 1'000'000));
}

TEST(clock_lost_power_at_boot)
{
    ClockRig r;
    r.rtc.osf = true;
    REQUIRE(r.svc.init(r.core));
    CHECK(!r.svc.valid());
    CHECK_EQ(r.events(fr::cap::Clock::kEventLostPower).size(), size_t{1});
    CHECK_EQ(r.rtc.system, 0u);  // not seeded from an untrusted time
}

TEST(clock_set_lands_at_the_target_and_validates)
{
    ClockRig r;
    r.rtc.osf = true;
    REQUIRE(r.svc.init(r.core));
    const TimeUs target = r.core.now() + 700'000;
    fr::cap::ClockSetArgs a{};
    a.unix = 1800000000;
    a.at_us = static_cast<uint64_t>(target);
    a.by = fr::cap::ClockSetBy::sync;
    REQUIRE(r.svc.set(a));
    CHECK(r.svc.set_pending());
    CHECK(r.svc.set(a).error() == Err::busy);
    r.core.advance_ms(1'000);
    CHECK(!r.svc.set_pending());
    // The fake clock does not move during the spin: the write lands at the timer, kSpinUs before the target at worst.
    CHECK(r.rtc.set_at >= target - ClockService::kSpinUs && r.rtc.set_at <= target);
    CHECK(r.svc.valid());
    const auto ev = r.events(fr::cap::Clock::kEventSet);
    REQUIRE_EQ(ev.size(), size_t{1});
    CHECK_EQ(frt::field_u(ev[0].bytes, 1), uint64_t(1800000000));
    CHECK_EQ(frt::field_u(ev[0].bytes, 2), uint64_t(fr::cap::ClockSetBy::sync));
    CHECK_EQ(r.rtc.system, 1800000000u);
}

TEST(clock_set_in_the_past_moves_by_whole_seconds_and_too_far_is_refused)
{
    ClockRig r;
    REQUIRE(r.svc.init(r.core));
    fr::cap::ClockSetArgs a{};
    a.unix = 1800000000;
    a.at_us = static_cast<uint64_t>(r.core.now() - 500'000);  // 0.5 s ago: the boundary 1 s after, unix + 1
    REQUIRE(r.svc.set(a));
    r.core.advance_ms(1'000);
    CHECK_EQ(r.rtc.base, 1800000001u);
    a.at_us = static_cast<uint64_t>(r.core.now() + 3'000'000);  // too far ahead
    CHECK(r.svc.set(a).error() == Err::invalid_args);
    a.at_us = static_cast<uint64_t>(r.core.now() - 1'500'000);  // too far behind: a stale target is not a forward jump
    CHECK(r.svc.set(a).error() == Err::invalid_args);
    a.at_us = 0x8000'0000'0000'0000ULL;  // does not fit node µs
    CHECK(r.svc.set(a).error() == Err::invalid_args);
    a.at_us = 0;
    a.unix = 900000000;  // 1998: the chip holds 2000-2099
    CHECK(r.svc.set(a).error() == Err::invalid_args);
    a.unix = 4102444800u;  // 2100-01-01
    CHECK(r.svc.set(a).error() == Err::invalid_args);
}

TEST(clock_set_late_timer_reaims_to_the_next_boundary)
{
    ClockRig r;
    REQUIRE(r.svc.init(r.core));
    const TimeUs target = r.core.now() + 500'000;
    fr::cap::ClockSetArgs a{};
    a.unix = 1800000000;
    a.at_us = static_cast<uint64_t>(target);
    REQUIRE(r.svc.set(a));
    // The core is busy past the target: the timer fires 300 ms late.
    r.core.stall_to(target + 300'000);
    r.core.advance_us(0);
    CHECK(r.svc.set_pending());       // not written at the stale second
    CHECK_EQ(r.rtc.set_at, TimeUs(0));
    r.core.advance_ms(1'000);
    CHECK(!r.svc.set_pending());
    CHECK_EQ(r.rtc.base, 1800000001u);  // the next boundary, unix + 1
    CHECK(r.rtc.set_at >= target + 1'000'000 - ClockService::kSpinUs && r.rtc.set_at <= target + 1'000'000);
    CHECK_EQ(r.svc.set_errors(), 0u);
}

TEST(clock_jump_without_set_invalidates_until_the_next_set)
{
    ClockRig r;
    REQUIRE(r.svc.init(r.core));
    r.core.advance_ms(5'000);
    CHECK(r.svc.valid());
    CHECK_EQ(r.svc.jumps(), 0u);
    const auto lost_before = r.events(fr::cap::Clock::kEventLostPower).size();
    r.rtc.stray(+101);  // what the bench saw: a stray write moved the chip forward
    r.core.advance_ms(3'000);
    CHECK_EQ(r.svc.jumps(), 1u);
    CHECK(!r.svc.valid());
    CHECK_EQ(r.events(fr::cap::Clock::kEventLostPower).size(), lost_before + 1);
    REQUIRE(!r.rtc.notes.empty());
    CHECK(r.rtc.notes.back().find("jumped +10") != std::string::npos);
    // It stays not valid while the chip keeps counting normally from the new time.
    r.core.advance_ms(5'000);
    CHECK(!r.svc.valid());
    CHECK_EQ(r.svc.jumps(), 1u);
    // A set makes it valid again (and seeds the system time).
    fr::cap::ClockSetArgs a{};
    a.unix = 1800000000;
    REQUIRE(r.svc.set(a));
    CHECK(r.svc.valid());
    r.core.advance_ms(3'000);
    CHECK(r.svc.valid());
    CHECK_EQ(r.svc.jumps(), 1u);
    CHECK(std::string(r.svc.selftest().detail).find("jumps 1") != std::string::npos);
}

TEST(clock_bus_errors_back_off_to_one_poll_a_second)
{
    ClockRig r;
    REQUIRE(r.svc.init(r.core));
    r.core.advance_ms(2'000);
    r.rtc.dead = true;
    r.core.advance_ms(1'000);
    CHECK(r.svc.backing_off());
    const int polls = r.rtc.polls;
    r.core.advance_ms(10'000);
    // Once a second while backing off (the dead fake does not count polls, so count the read errors instead).
    (void)polls;
    const uint32_t errs = r.svc.read_errors();
    r.core.advance_ms(10'000);
    CHECK(r.svc.read_errors() - errs <= 11u);
    REQUIRE(!r.rtc.notes.empty());
    r.rtc.dead = false;
    r.core.advance_ms(31'000);
    CHECK(!r.svc.backing_off());
    CHECK(r.svc.valid());
}

TEST(clock_aging_change_without_set_aging_is_noted)
{
    ClockRig r;
    REQUIRE(r.svc.init(r.core));
    r.rtc.aging_v = 9;  // a stray write to 0x10
    r.core.advance_ms(70'000);  // past a unix % 64 == 0 rollover
    bool noted = false;
    for (const auto &n : r.rtc.notes) {
        noted = noted || n.find("aging register reads 9") != std::string::npos;
    }
    CHECK(noted);
    CHECK_EQ(r.svc.read()->aging, int8_t(9));
}

TEST(clock_set_now_writes_at_once)
{
    ClockRig r;
    REQUIRE(r.svc.init(r.core));
    fr::cap::ClockSetArgs a{};
    a.unix = 1800000000;
    REQUIRE(r.svc.set(a));
    CHECK(!r.svc.set_pending());
    CHECK_EQ(r.rtc.base, 1800000000u);
}

TEST(clock_aging_and_dead_chip)
{
    ClockRig r;
    REQUIRE(r.svc.init(r.core));
    fr::cap::ClockSetAgingArgs g{};
    g.offset = -7;
    REQUIRE(r.svc.set_aging(g));
    CHECK_EQ(r.rtc.aging_v, int8_t(-7));
    CHECK_EQ(r.svc.read()->aging, int8_t(-7));
    r.rtc.dead = true;
    const uint32_t before = r.svc.read()->unix;
    r.core.advance_ms(2'000);
    CHECK(r.svc.read_errors() > 0);
    CHECK_EQ(r.svc.read()->unix, before);
}

#if FR_TEST_HOOKS
TEST(clock_inject_holds_and_counts_on)
{
    ClockRig r;
    REQUIRE(r.svc.init(r.core));
    fr::cap::ClockInjectArgs in{};
    in.unix = 2000000000;
    in.hold_ms = 5000;
    REQUIRE(r.svc.inject(in));
    r.core.advance_ms(2'000);
    auto rd = r.svc.read();
    REQUIRE(rd.has_value());
    CHECK(rd->injected);
    CHECK_EQ(rd->unix, 2000000002u);
    r.core.advance_ms(4'000);
    CHECK(!r.svc.read()->injected);
}
#endif

TEST(display_backlight_scaled_into_max_brightness)
{
    CHECK_EQ(fr::DisplayService::scaled(255, 255), uint8_t(255));
    CHECK_EQ(fr::DisplayService::scaled(100, 255), uint8_t(100));
    CHECK_EQ(fr::DisplayService::scaled(255, 128), uint8_t(128));
    CHECK_EQ(fr::DisplayService::scaled(128, 128), uint8_t(64));
    CHECK_EQ(fr::DisplayService::scaled(0, 128), uint8_t(0));
    CHECK_EQ(fr::DisplayService::scaled(1, 128), uint8_t(1));  // lit stays lit
    CHECK_EQ(fr::DisplayService::scaled(1, 1), uint8_t(1));
}

}  // namespace
