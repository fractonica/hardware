// L1 camera contract (spec 07 §7.7; design camera-c1 D7, D8, D9, §10): a driver brings a JPEG camera sensor up on the
// chip's DVP interface, hands out frames and applies the sensor's settings; CameraService does everything else (the
// pacing, the stream to the hub, the recording to the card, the properties).
//
// Threading: init() runs at board init (fr::board::init, the core task's start) and touches no hardware; start(), stop()
// and set() run on the core task while no grab is in flight, or on the fr_stream task between two grabs (the service
// applies a `set` that arrives during a stream from its next pass, never concurrently with grab()); grab() and release()
// run on the fr_stream task and may block up to their timeout. The driver owns everything IDF-specific: esp_camera_init
// (the frame buffers in PSRAM, sized for max_frame_size), esp_camera_fb_get with CAMERA_GRAB_LATEST (a slow path takes
// the newest frame, never a backlog), the sensor's set_* calls over SCCB, CONFIG_CAMERA_* (its driver.yaml `sdkconfig`).
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** A frame size (fr.camera FrameSize, same values; esp32-camera's framesize_t names). */
enum class FrameSize : uint8_t { qvga = 0, vga = 1, svga = 2, xga = 3, sxga = 4, uxga = 5 };

struct FrameDims {
    uint16_t width;
    uint16_t height;
};

/** The pixel dimensions of a FrameSize (the wire head's width and height, design camera-c1 D10). */
constexpr FrameDims frame_dims(FrameSize s)
{
    switch (s) {
    case FrameSize::qvga:
        return {320, 240};
    case FrameSize::vga:
        return {640, 480};
    case FrameSize::svga:
        return {800, 600};
    case FrameSize::xga:
        return {1024, 768};
    case FrameSize::sxga:
        return {1280, 1024};
    case FrameSize::uxga:
        return {1600, 1200};
    }
    return {0, 0};
}

/** A frame is at most this (design camera-c1 D10: UXGA at quality 4 is under 300 KB); a longer one is dropped and counted. */
inline constexpr size_t kFrameMaxBytes = 512 * 1024;

/** fr.camera's `sensor` trait values (Camera::sensor()). */
inline constexpr uint8_t kSensorUnknown = 0;
inline constexpr uint8_t kSensorOv2640 = 1;

/** What the sensor is set to (fr.camera config and `set`, same ranges). */
struct CameraSettings {
    FrameSize frame_size = FrameSize::svga;
    uint8_t quality = 12;  // 4..63, lower is better
    bool vflip = false;
    bool hmirror = false;
    int8_t brightness = 0;  // -2..2
    int8_t contrast = 0;    // -2..2
    int8_t saturation = 0;  // -2..2
};

/** What start() brings the sensor up with (fr.camera config): the buffers are sized for max_frame_size. */
struct CameraInit {
    FrameSize max_frame_size = FrameSize::uxga;
    uint8_t fb_count = 2;  // 1..3 frame buffers (PSRAM)
    uint32_t xclk_hz = 20'000'000;
    CameraSettings settings{};
};

/**
 * One JPEG frame as the driver holds it: `jpeg` (SOI .. EOI) stays valid until release(); `t_us` is the chip's µs clock
 * at capture (the wire head's t_us); `handle` is the driver's buffer, opaque to the service.
 */
struct Frame {
    std::span<const uint8_t> jpeg;
    uint16_t width = 0;
    uint16_t height = 0;
    uint32_t t_us = 0;
    void *handle = nullptr;
};

/** A JPEG camera on the chip's DVP interface (dvp_camera). */
class Camera
{
public:
    /** Remembers the core; touches no hardware (the sensor is powered at start()). Board init. */
    virtual Status init(Core &core) = 0;
    /**
     * Brings the sensor up (power, XCLK, SCCB probe, the frame buffers for max_frame_size) at `init.settings`.
     * Err::failed when the sensor does not answer or the buffers do not fit; Err::busy when running. Core task.
     */
    virtual Status start(const CameraInit &init) = 0;
    /** Powers the sensor down and frees the buffers; OK when stopped. Every Frame must have been released. */
    virtual Status stop() = 0;
    virtual bool running() const = 0;
    /**
     * The newest frame, within timeout_ms: Err::busy when none came in time, Err::failed when the sensor failed
     * (esp32-camera's own retries exhausted), Err::unsupported while not running. The real bound is timeout_ms plus
     * up to 4 s: once a frame is reported queued the take is esp32-camera's cam_take with its fixed FB_GET_TIMEOUT,
     * which can hold the task that long when the queued frame is retried (no EOI). fr_stream task; one frame out at a
     * time per fb_count - 1, so release() before the next grab() with fb_count 1.
     */
    virtual Status grab(Frame &out, uint32_t timeout_ms) = 0;
    /** Gives the frame's buffer back to the sensor (esp_camera_fb_return). fr_stream task. */
    virtual void release(Frame &f) = 0;
    /**
     * Applies the settings to the sensor now (SCCB); a size change takes effect from the next frame (the first one may
     * be short: esp32-camera retries it). Err::invalid_args for a frame_size above start()'s max_frame_size or a value
     * outside its range; Err::unsupported while not running. Core task or fr_stream task, never beside a grab().
     */
    virtual Status set(const CameraSettings &s) = 0;
    /** The sensor found at start(): kSensorOv2640, else kSensorUnknown (fr.camera's `sensor` trait). */
    virtual uint8_t sensor() const = 0;
    /** Frames delivered and grabs that failed, since boot (stats camera). */
    virtual uint32_t frames() const { return 0; }
    virtual uint32_t failed() const { return 0; }
    /** The sensor answers over SCCB (its PID read back) and the last grab did not fail. */
    virtual Selftest selftest() = 0;

protected:
    ~Camera() = default;
};

}  // namespace fr::hal
