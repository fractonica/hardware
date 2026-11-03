// dvp_camera (design camera-c1 D9, §10; spec 07 §7.8): hal::Camera over espressif/esp32-camera on the chip's DVP
// interface. CameraService calls start(), stop() and set() from the core task (or set() between grabs on the fr_stream
// task) and grab()/release() from the fr_stream task (fr/hal/camera.hpp says what runs where).
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/camera.hpp"

namespace fr::drv {

/**
 * start() fills esp32-camera's camera_config_t from Config (the pins), the CameraInit (xclk_hz on LEDC timer 0 /
 * channel 0, PIXFORMAT_JPEG, frame_size max_frame_size for the buffer sizing, jpeg_buffer_size a quarter of its
 * pixels under hal::kFrameMaxBytes, jpeg_quality, fb_count, CAMERA_FB_IN_PSRAM, CAMERA_GRAB_LATEST), calls
 * esp_camera_init, reads the sensor's PID (0x26: OV2640), takes the sensor's state as what esp_camera_init left (the
 * buffers' size, the quality, every image setting at its default) and applies the settings from there (set_framesize,
 * set_quality, set_vflip, set_hmirror, set_brightness, set_contrast, set_saturation: only what differs). A field the
 * sensor refuses over SCCB is not recorded as applied, so the next set() with the same wish writes it again. grab() is
 * esp_camera_fb_get bounded by timeout_ms (esp32-camera's own wait is a fixed 4 s: the driver looks for a queued frame
 * a tick at a time, esp_camera_available_frames, and takes it once there; the take can still hold the task up to those
 * 4 s when the queued frame is retried), release() esp_camera_fb_return. The first frame after a size change (start()
 * included: the buffers are made at max_frame_size, then the sensor set to the wanted size) is taken and given back
 * unseen: the bench saw one NO-EOI frame there (design §9). stop() is esp_camera_deinit and the power-down pin high.
 */
class DvpCamera final : public hal::Camera
{
public:
    // driver.yaml `config` order; an optional pin is -1 (not wired).
    struct Config {
        uint8_t xclk = 0;
        uint8_t sda = 0;
        uint8_t scl = 0;
        int8_t pwdn = -1;
        int8_t reset = -1;
        uint8_t d0 = 0;
        uint8_t d1 = 0;
        uint8_t d2 = 0;
        uint8_t d3 = 0;
        uint8_t d4 = 0;
        uint8_t d5 = 0;
        uint8_t d6 = 0;
        uint8_t d7 = 0;
        uint8_t vsync = 0;
        uint8_t href = 0;
        uint8_t pclk = 0;
        uint8_t port = 0;  // the I2S controller of the ESP32's camera DMA (I2S0); unused on the S3 (LCD_CAM)
    };

    // Only stores the configuration: the sensor is touched once start() runs (spec 03 §3.4).
    explicit DvpCamera(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    Status start(const hal::CameraInit &init) override;
    Status stop() override;
    bool running() const override { return running_; }
    Status grab(hal::Frame &out, uint32_t timeout_ms) override;
    void release(hal::Frame &f) override;
    Status set(const hal::CameraSettings &s) override;
    uint8_t sensor() const override { return sensor_; }
    uint32_t frames() const override { return frames_; }
    uint32_t failed() const override { return failed_; }
    hal::Selftest selftest() override;

private:
    Config cfg_;
    Core *core_ = nullptr;
    bool running_ = false;
    uint8_t sensor_ = hal::kSensorUnknown;
    hal::FrameSize max_frame_size_ = hal::FrameSize::uxga;
    hal::CameraSettings applied_{};  // what the sensor is set to (set() writes only what changed, keeps what it refused)
    bool drop_next_ = false;         // the next grab's frame follows a size change: given back unseen
    bool last_grab_ok_ = true;
    uint32_t frames_ = 0;
    uint32_t failed_ = 0;
};

}  // namespace fr::drv
