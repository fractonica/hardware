// The firmware's I2C master buses (design m2-c5-display D4, D8): one bus per pin pair, shared by every driver on it
// (the Touch-LCD-2's CST816D now, its QMI8658 IMU later), on IDF v6.1's i2c_master API. ESP-IDF only
// (src/i2c_bus.cpp; the host suite builds it against its shim). For the app task during board init and the core
// task afterwards; i2c_master serialises transactions on one bus itself, so devices on it may be used from any task.
#pragma once

#include <expected>

#include "driver/i2c_master.h"
#include "fr/base.hpp"

namespace fr::platform {

/**
 * The master bus on (sda, scl), created on first use on a free port (internal pull-ups on, glitch filter 7 cycles);
 * every later call with the same pins answers the same handle. Err::busy when one of the pins already belongs to a
 * bus with another partner, Err::failed when IDF refused (no free port, a bad pin; logged).
 */
std::expected<i2c_master_bus_handle_t, Err> i2c_bus(int sda, int scl);

/** Adds a 7-bit device at `address`, clocked at `khz`, to that bus. Err as i2c_bus, Err::failed if IDF refused. */
std::expected<i2c_master_dev_handle_t, Err> i2c_device(int sda, int scl, uint8_t address, uint32_t khz);

}  // namespace fr::platform
