// Fakes for CameraService's tests (design camera-c1 D8, §10): a hal::Camera that hands out the newest queued JPEG (as
// CAMERA_GRAB_LATEST does) and records the settings it was given, and a hal::BlockStore kept in memory, with a card
// write that may take fake time (the pacing's drops). Both run on the test's one thread.
#pragma once

#include <cstdint>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <span>
#include <vector>

#include "fr/base.hpp"
#include "fr/hal/block_store.hpp"
#include "fr/hal/camera.hpp"
#include "tests/fake_core.hpp"

namespace frt {

/** A JPEG of `bytes` with a real SOI, SOF0 (width x height), filler and EOI: what jpeg_dims() and the hub read. */
inline std::vector<uint8_t> fake_jpeg(size_t bytes, uint16_t width, uint16_t height, uint8_t fill)
{
    std::vector<uint8_t> j(bytes < 24 ? 24 : bytes, fill);
    const uint8_t sof[] = {0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, static_cast<uint8_t>(height >> 8),
                           static_cast<uint8_t>(height), static_cast<uint8_t>(width >> 8), static_cast<uint8_t>(width),
                           0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xDA};
    std::memcpy(j.data(), sof, sizeof(sof));
    j[j.size() - 2] = 0xFF;
    j[j.size() - 1] = 0xD9;
    return j;
}

class FakeCamera final : public fr::hal::Camera
{
public:
    explicit FakeCamera(FakeCore &core) : core_(core) {}

    fr::Status init(fr::Core &) override
    {
        ++inits;
        return {};
    }
    fr::Status start(const fr::hal::CameraInit &i) override
    {
        if (fail_start) {
            return std::unexpected(fr::Err::failed);
        }
        if (started) {
            return std::unexpected(fr::Err::busy);
        }
        started = true;
        init_args = i;
        // As esp_camera_init leaves a sensor: the size and the quality, every image setting at its default. The
        // service's first pass must set() the rest (a fake that took them all here hid a driver that never applied
        // vflip and the levels).
        applied = {};
        applied.frame_size = i.settings.frame_size;
        applied.quality = i.settings.quality;
        return {};
    }
    fr::Status stop() override
    {
        started = false;
        return {};
    }
    bool running() const override { return started; }
    fr::Status grab(fr::hal::Frame &out, uint32_t) override
    {
        if (!started) {
            return std::unexpected(fr::Err::unsupported);
        }
        if (queue.empty()) {
            return std::unexpected(fr::Err::busy);
        }
        held.push_back(std::move(queue.front()));
        queue.pop_front();
        const std::vector<uint8_t> &v = *held.back();
        const fr::hal::FrameDims d = fr::hal::frame_dims(applied.frame_size);
        out.jpeg = v;
        out.width = d.width;
        out.height = d.height;
        out.t_us = static_cast<uint32_t>(core_.now());
        out.handle = const_cast<std::vector<uint8_t> *>(&v);
        ++grabs;
        return {};
    }
    void release(fr::hal::Frame &f) override
    {
        for (auto it = held.begin(); it != held.end(); ++it) {
            if (it->get() == f.handle) {
                held.erase(it);
                break;
            }
        }
        ++releases;
        f = {};
    }
    fr::Status set(const fr::hal::CameraSettings &s) override
    {
        if (s.frame_size > init_args.max_frame_size) {
            return std::unexpected(fr::Err::invalid_args);
        }
        sets.push_back(s);
        if (fail_set) {
            return std::unexpected(fr::Err::failed);  // the sensor refused every write: nothing applied (the driver's rollback)
        }
        applied = s;
        return {};
    }
    uint8_t sensor() const override { return fr::hal::kSensorOv2640; }
    uint32_t frames() const override { return grabs; }
    fr::hal::Selftest selftest() override { return {started, started ? "fake camera up" : "fake camera down"}; }

    /** The sensor delivered a frame of `bytes` at the applied size: the newest replaces what was not taken yet. */
    void frame(size_t bytes)
    {
        const fr::hal::FrameDims d = fr::hal::frame_dims(applied.frame_size);
        queue.clear();
        queue.push_back(std::make_unique<std::vector<uint8_t>>(fake_jpeg(bytes, d.width, d.height, static_cast<uint8_t>(++n))));
    }

    bool started = false;
    bool fail_start = false;
    bool fail_set = false;  // set() refuses (recorded in `sets`, nothing applied)
    int inits = 0;
    uint32_t grabs = 0;
    uint32_t releases = 0;
    uint8_t n = 0;
    fr::hal::CameraInit init_args{};
    fr::hal::CameraSettings applied{};
    std::vector<fr::hal::CameraSettings> sets;
    std::deque<std::unique_ptr<std::vector<uint8_t>>> queue;
    std::vector<std::unique_ptr<std::vector<uint8_t>>> held;

private:
    FakeCore &core_;
};

class FakeCard final : public fr::hal::BlockStore
{
public:
    explicit FakeCard(FakeCore &core) : core_(core) {}

    fr::Status init(fr::Core &) override
    {
        ++inits;
        if (fail_init) {
            st = fr::hal::StoreState::error;  // a host fault at the mount: the driver's contract
            return std::unexpected(fr::Err::failed);
        }
        return {};
    }
    fr::hal::StoreState state() const override { return st; }
    uint32_t free_mb() const override { return st == fr::hal::StoreState::mounted ? free : 0; }
    fr::Status open_recording(uint32_t id) override
    {
        if (st != fr::hal::StoreState::mounted) {
            return std::unexpected(fr::Err::unsupported);
        }
        if (open_) {
            return std::unexpected(fr::Err::busy);
        }
        if (fail_open) {
            return std::unexpected(fr::Err::failed);
        }
        recs[id] = {};
        open_ = true;
        open_id_ = id;
        ++opens;
        return {};
    }
    fr::Status write_frame(uint32_t index, std::span<const uint8_t> jpeg) override
    {
        if (!open_) {
            return std::unexpected(fr::Err::unsupported);
        }
        if (slow_ms > 0) {
            core_.advance_ms(slow_ms);  // the card takes its time: the core task runs meanwhile
        }
        if (fail_write_at != 0 && index + 1 >= fail_write_at) {
            return std::unexpected(fr::Err::failed);
        }
        if (index != recs[open_id_].size()) {
            index_gaps = true;
        }
        recs[open_id_].emplace_back(jpeg.begin(), jpeg.end());
        return {};
    }
    fr::Status close_recording() override
    {
        if (open_) {
            ++closes;
        }
        open_ = false;
        return {};
    }
    fr::Status list(uint32_t from, std::span<fr::hal::Recording> out, uint32_t &count, uint32_t &next) override
    {
        count = 0;
        next = 0;
        ++lists;
        if (st != fr::hal::StoreState::mounted) {
            return std::unexpected(fr::Err::unsupported);
        }
        uint32_t i = 0;
        for (const auto &[id, frames] : recs) {  // a map: ids ascending, the oldest first
            if (i++ < from) {
                continue;
            }
            if (count == out.size()) {
                next = i - 1;
                return {};
            }
            static_cast<void>(info(id, out[count++]));
        }
        return {};
    }
    fr::Status info(uint32_t id, fr::hal::Recording &out) override
    {
        const auto it = recs.find(id);
        if (it == recs.end()) {
            return std::unexpected(fr::Err::not_found);
        }
        out = {.id = id, .frames = static_cast<uint32_t>(it->second.size()), .bytes = 0};
        for (const auto &f : it->second) {
            out.bytes += static_cast<uint32_t>(f.size());
        }
        return {};
    }
    fr::Status read_frame(uint32_t id, uint32_t index, std::span<uint8_t> buf, uint32_t &len) override
    {
        len = 0;
        if (open_) {
            return std::unexpected(fr::Err::busy);
        }
        const auto it = recs.find(id);
        if (it == recs.end() || index >= it->second.size()) {
            return std::unexpected(fr::Err::not_found);
        }
        const auto &f = it->second[index];
        if (f.size() > buf.size()) {
            return std::unexpected(fr::Err::invalid_args);
        }
        std::memcpy(buf.data(), f.data(), f.size());
        len = static_cast<uint32_t>(f.size());
        ++reads;
        return {};
    }
    fr::Status remove(uint32_t id) override
    {
        if (st != fr::hal::StoreState::mounted) {
            return std::unexpected(fr::Err::unsupported);
        }
        if (open_ && id == open_id_) {
            return std::unexpected(fr::Err::busy);
        }
        recs.erase(id);
        ++removes;
        return {};
    }
    fr::hal::Selftest selftest() override { return {true, "fake store"}; }

    bool is_open() const { return open_; }

    fr::hal::StoreState st = fr::hal::StoreState::mounted;
    uint32_t free = 1000;
    uint32_t slow_ms = 0;        // fake time a write takes
    uint32_t fail_write_at = 0;  // the n-th write (1-based) fails: the card is full
    bool fail_open = false;
    bool fail_init = false;  // init() is a host fault: state error, Err::failed
    bool index_gaps = false;
    int inits = 0, opens = 0, closes = 0, reads = 0, removes = 0, lists = 0;
    std::map<uint32_t, std::vector<std::vector<uint8_t>>> recs;

private:
    FakeCore &core_;
    bool open_ = false;
    uint32_t open_id_ = 0;
};

}  // namespace frt
