// Fractonica drivers (hal::*) for the UNO Q's STM32 outputs, through qonu-link (design uno-q-host §2.1):
// - Led3: LED3, the RGB LED the host owns, as an fr.led `rgb`, not dimmable (on/off per channel: a channel lights at
//   50 % or more, the rule fr.display uses for mono panels).
// - Matrix: the 13x8 LED matrix as a mono1 pixel panel; MonoBackend renders it (5x7 font, primitives) and flushes the
//   dirty area, which goes out as all 8 rows (bit x = column x, top row first). A change goes out kSettleUs after
//   the first one, with whatever followed it: an app that clears and then draws (two calls, a hub round trip apart)
//   shows one new picture instead of a blank flash between them.
// Both answer through qonu-link's socket; a failure is FAILED to the capability (qonu-link down, failsafe tripped).
#pragma once

#include <array>
#include <cstdint>

#include "fr/hal/display.hpp"
#include "fr/hal/light.hpp"
#include "qonu_link.hpp"

namespace qonu {

class Led3 final : public fr::hal::LightOutput
{
public:
    explicit Led3(LinkClient &link) : link_(link) {}

    fr::Status init(fr::Core &) override { return {}; }
    fr::hal::LightFeatures features() const override { return {.rgb = true, .dimmable = false}; }
    fr::Status write(const fr::hal::LightLevel &l) override;
    fr::hal::Selftest selftest() override;

private:
    LinkClient &link_;
};

class Matrix final : public fr::hal::Display
{
public:
    static constexpr uint16_t kWidth = 13;
    static constexpr uint16_t kHeight = 8;

    explicit Matrix(LinkClient &link) : link_(link) {}

    fr::Status init(fr::Core &core, fr::hal::Rotation rotation) override;
    uint16_t native_width() const override { return kWidth; }
    uint16_t native_height() const override { return kHeight; }
    fr::hal::PixelFormat format() const override { return fr::hal::PixelFormat::mono1; }
    fr::hal::Rotation rotation() const override { return rotation_; }
    fr::Status flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> pixels) override;
    fr::hal::Selftest selftest() override;

    static constexpr uint32_t kSettleUs = 60'000;

private:
    fr::Status send();

    LinkClient &link_;
    fr::Timer *settle_ = nullptr;
    fr::hal::Rotation rotation_ = fr::hal::Rotation::r0;
    std::array<uint16_t, kHeight> rows_{};
};

}  // namespace qonu
