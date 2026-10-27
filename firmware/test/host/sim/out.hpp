// Where a node's lines go, and the small text helpers the node classes share (design m2-c2 D2). fr_net_node prints
// exactly the untagged JSON lines cpp-node.ts and every interop suite parse (StdOut: one line on stdout, flushed);
// a fleet node tags each line with "node":"<alias>" and, while it answers a control command, captures them into
// the answer (node.cpp). The OTA fake (tools/ota_fake.hpp) writes through the same Out, so its lines follow the
// node they belong to. Test code: it may allocate.
#pragma once

#include <cstdarg>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>

namespace frsim {

class Out
{
public:
    virtual ~Out() = default;

    /** One line from a printf format (the node's `{"ev":...}` lines); no newline in `fmt`. Any thread. */
    void emit(const char *fmt, ...) __attribute__((format(printf, 2, 3)));
    void vemit(const char *fmt, va_list ap) __attribute__((format(printf, 2, 0)));
    /** A whole line, without its newline. Any thread. */
    virtual void line(std::string_view text) = 0;
    /**
     * Per-frame lines (`dispatch`, `ota_frame`, `led`, ...): fr_net_node prints every one; the fleet only at
     * verbosity 2 or more, so 30 nodes never flood its stdout (D8).
     */
    virtual bool frames() const { return true; }
};

/** fr_net_node's: each line on stdout, flushed at once (a test reads it while the process runs). */
class StdOut final : public Out
{
public:
    void line(std::string_view text) override;
};

// ---- text (text.cpp) ----

/** A JSON string body: quotes, backslashes and control characters escaped. */
std::string json_text(std::string_view s);
/** Lowercase hex of `b`. */
std::string hex(std::span<const uint8_t> b);
/** `s` as exactly out.size() bytes of hex; false (out partly written) otherwise. */
bool parse_hex(std::string_view s, std::span<uint8_t> out);
/** The next space-separated word of `s`, consumed with the spaces around it. */
std::string_view next_word(std::string_view &s);
/** A decimal of 1-9 digits within [lo, hi]. No exceptions here: never std::stoi. */
bool parse_u32(std::string_view s, uint32_t lo, uint32_t hi, uint32_t &out);
/** printf into a std::string, of any length. */
std::string sformat(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
std::string vsformat(const char *fmt, va_list ap) __attribute__((format(printf, 1, 0)));

}  // namespace frsim
