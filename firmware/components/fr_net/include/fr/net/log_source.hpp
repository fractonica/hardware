// LOG frames over TCP (design m2-c2 D20, spec 05 §5.7, §5.12.1): where Net reads the node's log lines from. On
// target fr_core implements it over fr_serial's second ring (whole lines, valid UTF-8, each with its push stamp);
// host tests and the fleet kit implement it in memory. Net attaches one (Net::attach_logs), says `net_log` in
// HELLO caps while it is attached, and drains it on its timer, over a settled TCP session only. IDF-free.
//
// Two clocks (design m2-c2 D20): a line's push stamp is on the core clock (fr::Core::now(), in ms), which the
// drain's 30 s age limit compares it with; the `(<ms>)` its text prints is the node's log clock (esp_log's on
// target, which runs ahead of the core clock by the boot's start-up), which text_ms() also gives for the one line
// Net writes itself.
#pragma once

#include <cstdint>
#include <span>
#include <string_view>

namespace fr::net {

/** One log line as the ring kept it. `tag` and `text` point into the scratch pop() was given. */
struct LogLine {
    uint8_t level = 0;  // LOG kind: E 1, W 2, I 3, D 4, V 5 (schema/protocol.yaml)
    // When the line entered the ring, on the core clock in ms (u32, wrapping): what the age limit reads. Net takes
    // the signed difference from its own clock, so a stamp a little ahead of it (a line pushed on another task
    // just after the drain read the clock) is a fresh line, not one 49 days old.
    uint32_t pushed_ms = 0;
    std::string_view tag;   // esp_log's tag, <= 16 B
    std::string_view text;  // the whole formatted line (`I (1234) tag: msg`), no ANSI, no trailing `\n`
};

/** The node's log ring, as Net drains it. Called on the core task. */
class LogSource
{
public:
    /** Takes the oldest line into `line`, its bytes copied into `scratch`; false when the ring is empty. */
    virtual bool pop(LogLine &line, std::span<char> scratch) = 0;

    /**
     * The `<ms>` a line logged now prints (`I (<ms>) tag: msg`), given the core clock now in ms: Net's
     * `W (<ms>) fr_net: <n> log lines dropped` line uses it, so every LOG line's text is on one clock. A source
     * whose lines print the core clock's ms (the host's) returns `core_ms`; fr_core's returns esp_log_timestamp().
     */
    virtual uint32_t text_ms(uint32_t core_ms) const { return core_ms; }

protected:
    ~LogSource() = default;
};

}  // namespace fr::net
