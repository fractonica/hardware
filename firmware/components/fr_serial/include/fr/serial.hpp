// fr_serial (spec 03 §3.4, 05 §5.12.3, design c2 §5): the only reader and writer of the USB-Serial/JTAG.
// Output is two bounded rings drained by one writer task, frames (and diag responses) before logs; a
// producer never blocks and a full ring drops and counts. Input is split into lines: `@fr1:` lines go
// to the frame handler, other lines to the text handler (the serial command channel). Nothing echoes.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>

namespace fr::serial {

struct Handlers {
    /** An `@fr1:` line without its terminator, on the reader task. Returns whether it decoded. */
    bool (*frame)(std::string_view line);
    /** Any other non-empty line (a trailing \r removed), on the reader task. */
    void (*text)(std::string_view line);
};

struct Stats {
    uint32_t frames_tx;        // lines written from the frame ring (ENV frames and diag responses)
    uint32_t frames_dropped;   // frame ring full, or the host stopped reading
    uint32_t logs_dropped;     // log ring full, or the host stopped reading
    uint32_t lines_discarded;  // input lines over 2048 characters
    uint32_t rx_frames;        // `@fr1:` lines that decoded
    uint32_t rx_bad;           // `@fr1:` lines that did not
};

/**
 * Installs the USJ driver (rx/tx 4096 B), sends stdout through it, hooks ESP_LOG into the log ring and
 * starts the reader and writer tasks. Call once; returns false if the driver could not be installed.
 */
bool start(const Handlers &h);

/** Queues one line (no terminator) ahead of all log output. Never blocks; false when dropped. */
bool write_line(std::string_view line);

/** Encodes `body` as an `@fr1:` line of the given type (05 §5.12.3) and queues it like write_line. */
bool write_frame(uint8_t type, std::span<const uint8_t> body);

Stats stats();
void reset_stats();

}  // namespace fr::serial
