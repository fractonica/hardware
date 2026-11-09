// The firmware's shared SPI master buses (design lcd-clock-c1 D3): one bus per host, shared by every driver on it (the
// Waveshare ESP32-C6-LCD-1.47's ST7789 panel and its micro-SD slot on SPI2). ESP-IDF only (src/spi_bus.cpp). The C6
// has one general-purpose SPI host, so a panel and a card on it must share; IDF's spi_master serialises transactions
// per bus, each driver adds its own device (its own CS).
#pragma once

#include <expected>

#include "driver/spi_master.h"
#include "fr/base.hpp"

namespace fr::platform {

/** The bus's lines; -1 for one a device does not use (a panel reads nothing back: miso -1). */
struct SpiBusPins {
    int sclk = -1;
    int mosi = -1;
    int miso = -1;
};

/**
 * Brings `host` up on `pins` the first time (DMA auto, max transfer at least `max_transfer` bytes), and answers OK to
 * every later caller whose sclk and mosi are the bus's and whose miso is the bus's or -1. A later caller that needs a
 * MISO the bus was brought up without, or other sclk/mosi, is refused with Err::busy (logged): the first caller must
 * name every line the bus will carry (codegen gives the panel of a shared bus the card's MISO, design D3). Err::failed
 * when IDF refused (logged). Board init (app task); the table is locked.
 */
Status spi_bus(spi_host_device_t host, const SpiBusPins &pins, int max_transfer);

#if FR_HOST_SHIM
/** The host suite's fresh boot: every bus down again (shim/panel_sim.cpp's spi_reset calls it). */
void spi_bus_host_reset();
#endif

}  // namespace fr::platform
