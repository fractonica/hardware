// dvp_camera (design camera-c1 D9, §9, §10): hal::Camera over espressif/esp32-camera 2.1.8. The header says what runs
// where; this file is the only one that includes esp_camera.h (spec 03 §3.2). The calls are the spike's (camspike,
// design §9): esp_camera_init with the frame buffers in PSRAM sized for max_frame_size, CAMERA_GRAB_LATEST, the sensor's
// set_* over SCCB, esp_camera_fb_get / esp_camera_fb_return.
#include "fr/drv/dvp_camera.hpp"

#include <algorithm>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_camera.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "dvp_camera";
// XCLK's LEDC timer and channel (driver.yaml `resources { ledc_timers 1, ledc_channels 1 }`): the first of each. The
// LED drivers of a camera board drive plain GPIOs (led_gpio); a board with an LEDC light beside the camera would need
// the budget to hand these out, which codegen does not do yet (one camera per board for now).
constexpr ledc_timer_t kLedcTimer = LEDC_TIMER_0;
constexpr ledc_channel_t kLedcChannel = LEDC_CHANNEL_0;

framesize_t to_framesize(hal::FrameSize s)
{
    switch (s) {
    case hal::FrameSize::qvga:
        return FRAMESIZE_QVGA;
    case hal::FrameSize::vga:
        return FRAMESIZE_VGA;
    case hal::FrameSize::svga:
        return FRAMESIZE_SVGA;
    case hal::FrameSize::xga:
        return FRAMESIZE_XGA;
    case hal::FrameSize::sxga:
        return FRAMESIZE_SXGA;
    case hal::FrameSize::uxga:
        return FRAMESIZE_UXGA;
    }
    return FRAMESIZE_SVGA;
}

bool in_range(const hal::CameraSettings &s, hal::FrameSize max)
{
    const auto level_ok = [](int8_t v) { return v >= -2 && v <= 2; };
    return s.frame_size <= max && s.quality >= 4 && s.quality <= 63 && level_ok(s.brightness) && level_ok(s.contrast) &&
           level_ok(s.saturation);
}

}  // namespace

Status DvpCamera::init(Core &core)
{
    core_ = &core;
    return {};  // the sensor is powered at start()
}

Status DvpCamera::start(const hal::CameraInit &init)
{
    if (running_) {
        return std::unexpected(Err::busy);
    }
    if (!in_range(init.settings, init.max_frame_size) || init.fb_count < 1 || init.fb_count > 3) {
        return std::unexpected(Err::invalid_args);
    }
    max_frame_size_ = init.max_frame_size;
    camera_config_t cfg = {};
    cfg.pin_pwdn = cfg_.pwdn;
    cfg.pin_reset = cfg_.reset;
    cfg.pin_xclk = cfg_.xclk;
    cfg.pin_sccb_sda = cfg_.sda;
    cfg.pin_sccb_scl = cfg_.scl;
    cfg.pin_d7 = cfg_.d7;
    cfg.pin_d6 = cfg_.d6;
    cfg.pin_d5 = cfg_.d5;
    cfg.pin_d4 = cfg_.d4;
    cfg.pin_d3 = cfg_.d3;
    cfg.pin_d2 = cfg_.d2;
    cfg.pin_d1 = cfg_.d1;
    cfg.pin_d0 = cfg_.d0;
    cfg.pin_vsync = cfg_.vsync;
    cfg.pin_href = cfg_.href;
    cfg.pin_pclk = cfg_.pclk;
    cfg.xclk_freq_hz = static_cast<int>(init.xclk_hz);
    cfg.ledc_timer = kLedcTimer;
    cfg.ledc_channel = kLedcChannel;
    cfg.pixel_format = PIXFORMAT_JPEG;
    // The buffers are sized for max_frame_size (design §9: buffers made for svga overflowed at uxga); the wanted size
    // is set on the sensor below.
    cfg.frame_size = to_framesize(init.max_frame_size);
    cfg.jpeg_quality = init.settings.quality;
    cfg.fb_count = init.fb_count;
    cfg.fb_location = CAMERA_FB_IN_PSRAM;
    cfg.grab_mode = CAMERA_GRAB_LATEST;
    cfg.sccb_i2c_port = -1;  // the driver makes its own SCCB bus on sda/scl (driver.yaml resources: one i2c port)
    // esp32-camera's own JPEG buffer is w*h/5 (384,000 B at uxga), and a frame that overflows it is dropped inside the
    // driver (cam_hal "FB-OVF": nothing is queued, so grab() times out for as long as frames overflow). A quarter of
    // the pixels (480,000 B at uxga: a quality-4 uxga frame is under 300 KB, design D10) under hal::kFrameMaxBytes.
    const hal::FrameDims max = hal::frame_dims(init.max_frame_size);
    cfg.jpeg_buffer_size = std::min<size_t>(static_cast<size_t>(max.width) * max.height / 4, hal::kFrameMaxBytes);
    const int64_t t0 = esp_timer_get_time();
    const esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_camera_init: %s", esp_err_to_name(err));
        sensor_ = hal::kSensorUnknown;
        return std::unexpected(Err::failed);
    }
    sensor_t *s = esp_camera_sensor_get();
    if (s == nullptr) {
        esp_camera_deinit();
        return std::unexpected(Err::failed);
    }
    sensor_ = s->id.PID == OV2640_PID ? hal::kSensorOv2640 : hal::kSensorUnknown;
    running_ = true;
    // What esp_camera_init left on the sensor: the buffers' size and the quality from the config, every image setting
    // at the sensor's own default (0 / off). set() below writes what init.settings differs in (the wanted size, a
    // vflip, ...): starting from the config here would skip them (they would read as already applied).
    applied_ = {};
    applied_.frame_size = init.max_frame_size;
    applied_.quality = init.settings.quality;
    drop_next_ = true;  // the first frame after a size change may be short (design §9 NO-EOI)
    if (auto st = set(init.settings); !st) {
        ESP_LOGW(TAG, "settings not applied at start (%s)", err_name(st.error()));
    }
    ESP_LOGI(TAG, "sensor PID 0x%02x (%s) up in %lld ms, buffers for %ux%u x%u in PSRAM, xclk %u Hz",
             static_cast<unsigned>(s->id.PID), sensor_ == hal::kSensorOv2640 ? "ov2640" : "unknown",
             static_cast<long long>((esp_timer_get_time() - t0) / 1000),
             static_cast<unsigned>(hal::frame_dims(init.max_frame_size).width),
             static_cast<unsigned>(hal::frame_dims(init.max_frame_size).height), static_cast<unsigned>(init.fb_count),
             static_cast<unsigned>(init.xclk_hz));
    return {};
}

Status DvpCamera::stop()
{
    if (!running_) {
        return {};
    }
    running_ = false;
    const esp_err_t err = esp_camera_deinit();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_camera_deinit: %s", esp_err_to_name(err));
    }
    if (cfg_.pwdn >= 0) {
        gpio_set_level(static_cast<gpio_num_t>(cfg_.pwdn), 1);  // power-down high: the sensor sleeps
    }
    return {};
}

Status DvpCamera::grab(hal::Frame &out, uint32_t timeout_ms)
{
    if (!running_) {
        return std::unexpected(Err::unsupported);
    }
    // esp_camera_fb_get waits a fixed 4 s on its frame queue (esp32-camera 2.1.8: FB_GET_TIMEOUT); the bound here is the
    // caller's: look for a frame, a tick at a time, until timeout_ms, then take it. The take returns at once when the
    // queued frame is whole; one without its EOI is given back and retried inside esp32-camera, so the take itself can
    // hold the task up to those 4 s (hal::Camera::grab's doc states timeout_ms + 4 s as the real bound).
    const TickType_t start = xTaskGetTickCount();
    const TickType_t limit = std::max<TickType_t>(1, pdMS_TO_TICKS(timeout_ms));
    while (!esp_camera_available_frames()) {
        if (xTaskGetTickCount() - start >= limit) {
            return std::unexpected(Err::busy);
        }
        vTaskDelay(1);
    }
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb == nullptr) {
        ++failed_;
        last_grab_ok_ = false;
        return std::unexpected(Err::failed);
    }
    if (drop_next_) {
        // The first frame after a size change (design §9: one NO-EOI on the bench): given back, the next one is whole.
        drop_next_ = false;
        esp_camera_fb_return(fb);
        return grab(out, timeout_ms);
    }
    ++frames_;
    last_grab_ok_ = true;
    out.jpeg = {fb->buf, fb->len};
    out.width = static_cast<uint16_t>(fb->width);
    out.height = static_cast<uint16_t>(fb->height);
    // esp32-camera stamps the frame's first DMA buffer with esp_timer_get_time() (cam_hal.c), the chip's µs clock.
    out.t_us = static_cast<uint32_t>(static_cast<int64_t>(fb->timestamp.tv_sec) * 1'000'000 + fb->timestamp.tv_usec);
    out.handle = fb;
    return {};
}

void DvpCamera::release(hal::Frame &f)
{
    if (f.handle != nullptr && running_) {
        esp_camera_fb_return(static_cast<camera_fb_t *>(f.handle));
    }
    f.handle = nullptr;
    f.jpeg = {};
}

Status DvpCamera::set(const hal::CameraSettings &s)
{
    if (!running_) {
        return std::unexpected(Err::unsupported);
    }
    if (!in_range(s, max_frame_size_)) {
        return std::unexpected(Err::invalid_args);
    }
    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor == nullptr) {
        return std::unexpected(Err::failed);
    }
    // Each field that differs is written; one the sensor refuses (a failed SCCB write) stays as it was in applied_, so
    // the next set() with the same wish writes it again instead of taking it as done.
    int refused = 0;
    if (s.frame_size != applied_.frame_size) {
        if (sensor->set_framesize(sensor, to_framesize(s.frame_size)) == 0) {
            applied_.frame_size = s.frame_size;
            drop_next_ = true;
        } else {
            ++refused;
        }
    }
    if (s.quality != applied_.quality) {
        if (sensor->set_quality(sensor, s.quality) == 0) {
            applied_.quality = s.quality;
        } else {
            ++refused;
        }
    }
    if (s.vflip != applied_.vflip) {
        if (sensor->set_vflip(sensor, s.vflip ? 1 : 0) == 0) {
            applied_.vflip = s.vflip;
        } else {
            ++refused;
        }
    }
    if (s.hmirror != applied_.hmirror) {
        if (sensor->set_hmirror(sensor, s.hmirror ? 1 : 0) == 0) {
            applied_.hmirror = s.hmirror;
        } else {
            ++refused;
        }
    }
    if (s.brightness != applied_.brightness) {
        if (sensor->set_brightness(sensor, s.brightness) == 0) {
            applied_.brightness = s.brightness;
        } else {
            ++refused;
        }
    }
    if (s.contrast != applied_.contrast) {
        if (sensor->set_contrast(sensor, s.contrast) == 0) {
            applied_.contrast = s.contrast;
        } else {
            ++refused;
        }
    }
    if (s.saturation != applied_.saturation) {
        if (sensor->set_saturation(sensor, s.saturation) == 0) {
            applied_.saturation = s.saturation;
        } else {
            ++refused;
        }
    }
    if (refused != 0) {
        ESP_LOGW(TAG, "%d sensor setting(s) refused over SCCB: kept for the next set()", refused);
        return std::unexpected(Err::failed);
    }
    return {};
}

hal::Selftest DvpCamera::selftest()
{
    if (!running_) {
        return {false, "dvp_camera: sensor not started"};
    }
    if (sensor_ == hal::kSensorUnknown) {
        return {false, "dvp_camera: sensor not recognised (PID read over SCCB is not an OV2640's)"};
    }
    if (!last_grab_ok_) {
        return {false, "dvp_camera: the last grab failed"};
    }
    return {true, "dvp_camera: ov2640 answers over SCCB, last grab ok"};
}

}  // namespace fr::drv
