// fr_serial (spec 03 §3.4, 05 §5.12.3, design c2 §5): the only reader and writer of the USB-Serial/JTAG.
// Output is two bounded rings drained by one writer task, frames (and diag responses) before logs; a
// producer never blocks and a full ring drops and counts. Input is split into lines: `@fr1:` lines go
// to the frame handler, other lines to the text handler (the serial command channel). Nothing echoes.
//
// M2-C2 (design m2-c2 D20): the ESP_LOG hook also feeds a third ring, the net log ring, which fr_core enables
// when the radio is on and fr_net drains as LOG frames over TCP. Its records are whole lines (a library's line
// printed in several vprintf calls is joined), without ANSI or the line end, with the level and tag parsed out
// and a push stamp on fr::Core's clock; its first line after empty wakes the core task. The pieces of that hook that need no IDF are
// inline below, so the host suite runs them.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
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

/**
 * Encodes `body` as an `@fr1:` line of the given type (05 §5.12.3) and queues it like write_line. Bodies
 * up to a bulk envelope (1470 B) fit one line. Core task only: the line is built in one static buffer.
 */
bool write_frame(uint8_t type, std::span<const uint8_t> body);

/**
 * Whether a USB host is attached (it sends SOFs), which is what makes the serial ENV channel a hub link
 * (design c3 §3). True even while no program has the port open; false on a charger.
 */
bool connected();

Stats stats();
void reset_stats();

// ---- the net log ring (design m2-c2 D20) ----

/** One line of the net log ring, as pop_net_log copies it out. */
struct NetLogLine {
    uint8_t level = 0;       // E 1, W 2, I 3, D 4, V 5 (a line of another shape: I)
    // When the hook pushed it, on fr::Core's clock (esp_timer_get_time() / 1000, wrapping at 2^32 ms), which Net's
    // age limit reads. Not the text's `(<ms>)`: that is esp_log_timestamp(), which runs ahead of esp_timer by the
    // boot's start-up (0.15-0.6 s).
    uint32_t pushed_ms = 0;
    std::string_view tag;    // esp_log's tag, <= 16 B, into the scratch pop_net_log was given
    std::string_view text;   // the whole line as the serial port printed it, without ANSI and its line end
};

/** What the net log ring counted since boot (never reset: fr_core hands Net the differences). */
struct NetLogStats {
    uint32_t ring_drop;  // lines it had no room for (drop-newest: the boot banner stays)
    uint32_t cut;        // lines longer than the hook's buffer, cut as the serial line is
};

/**
 * Turns the net log ring on (4 KB, drop-newest): every ESP_LOG line at or below `max_level` (1 E .. 5 V) that
 * esp_log lets through goes there too, whole. `wake` runs on the logging task each time the ring goes from empty
 * to non-empty (it must not log). Call once, before start(); radio-off images never call it.
 */
void enable_net_logs(uint8_t max_level, void (*wake)());

/**
 * Takes the oldest line, its tag and text copied into `scratch` (a line that does not fit is cut); false when
 * the ring is empty. One consumer (fr_net's drain on the core task).
 */
bool pop_net_log(NetLogLine &line, std::span<char> scratch);

NetLogStats net_log_stats();

// ---- IDF-free pieces of the net log hook (host-tested) ----

/** The longest line the ESP_LOG hook formats, '\n' included (its vsnprintf buffer less the NUL). */
inline constexpr size_t kLogLineMax = 383;

/**
 * Removes the colour sequences esp_log adds (ESC '[' digits and ';' 'm'), exactly as the hub's stripAnsi does to
 * a serial line, in place; returns the new length.
 */
inline size_t strip_ansi(char *s, size_t n)
{
    size_t o = 0;
    for (size_t i = 0; i < n;) {
        if (s[i] == '\x1b' && i + 1 < n && s[i + 1] == '[') {
            size_t j = i + 2;
            while (j < n && ((s[j] >= '0' && s[j] <= '9') || s[j] == ';')) {
                ++j;
            }
            if (j < n && s[j] == 'm') {
                i = j + 1;
                continue;
            }
        }
        s[o++] = s[i++];
    }
    return o;
}

/** What an esp_log line `I (1234) tag: msg` says of itself (the hub's ESP_LOG_RE); level 0 for another shape. */
struct LogHead {
    uint8_t level = 0;
    std::string_view tag;
};

inline LogHead parse_log_head(std::string_view line)
{
    static constexpr std::string_view kLevels = "EWIDV";
    const size_t lv = line.empty() ? std::string_view::npos : kLevels.find(line[0]);
    if (lv == std::string_view::npos || line.size() < 4 || line[1] != ' ' || line[2] != '(') {
        return {};
    }
    size_t i = 3;
    while (i < line.size() && line[i] >= '0' && line[i] <= '9') {
        ++i;
    }
    if (i == 3 || i + 1 >= line.size() || line[i] != ')' || line[i + 1] != ' ') {
        return {};
    }
    const size_t tag_at = i + 2;
    const size_t colon = line.find(':', tag_at);
    if (colon == std::string_view::npos || colon == tag_at) {
        return {};
    }
    return {.level = static_cast<uint8_t>(lv + 1), .tag = line.substr(tag_at, colon - tag_at)};
}

/**
 * Whole lines out of vprintf calls (design m2-c2 D20). A library may print one line in several calls (the Wi-Fi
 * blob's certification line, then its '\n'): the partial line of a caller (its task, `key`) waits in one of
 * `Slots` slots until the '\n' comes. Several tasks may feed at once: a slot is claimed by a compare-and-swap and
 * then touched by its owner only. A caller that finds no free slot has its fragment taken as a line of its own.
 */
template <size_t Slots, size_t Bytes>
class LineJoiner
{
public:
    /**
     * Calls `emit(char *line, size_t len, bool cut)` for each whole line in `text`, its '\n' left out. The line's
     * bytes are writable (they are `text`'s own, or the slot's): the hook strips ANSI in place. `cut`: a joined
     * line longer than Bytes, whose rest was dropped.
     */
    template <class Emit>
    void feed(const void *key, char *text, size_t n, Emit &&emit)
    {
        Slot *mine = find(key);
        size_t at = 0;
        while (at < n) {
            char *nl = static_cast<char *>(std::memchr(text + at, '\n', n - at));
            const size_t end = nl != nullptr ? static_cast<size_t>(nl - text) : n;
            if (mine == nullptr && nl != nullptr) {
                emit(text + at, end - at, false);
            } else {
                if (mine == nullptr && (mine = claim(key)) == nullptr) {
                    emit(text + at, end - at, false);  // no slot: the fragment as a line of its own
                    return;
                }
                append(*mine, text + at, end - at);
                if (nl == nullptr) {
                    return;  // still open
                }
                emit(mine->buf, mine->len, mine->cut);
                release(*mine);
                mine = nullptr;
            }
            at = end + 1;
        }
    }

    /** Slots holding a partial line now (tests). */
    size_t open() const
    {
        size_t n = 0;
        for (const Slot &s : slots_) {
            n += s.key.load(std::memory_order_acquire) != nullptr ? 1 : 0;
        }
        return n;
    }

private:
    struct Slot {
        std::atomic<const void *> key{nullptr};
        size_t len = 0;
        bool cut = false;
        char buf[Bytes];
    };

    Slot *find(const void *key)
    {
        for (Slot &s : slots_) {
            if (s.key.load(std::memory_order_acquire) == key) {
                return &s;
            }
        }
        return nullptr;
    }
    Slot *claim(const void *key)
    {
        for (Slot &s : slots_) {
            const void *free = nullptr;
            if (s.key.compare_exchange_strong(free, key, std::memory_order_acq_rel)) {
                s.len = 0;
                s.cut = false;
                return &s;
            }
        }
        return nullptr;
    }
    static void append(Slot &s, const char *p, size_t n)
    {
        const size_t take = n <= Bytes - s.len ? n : Bytes - s.len;
        std::memcpy(s.buf + s.len, p, take);
        s.len += take;
        s.cut = s.cut || take < n;
    }
    static void release(Slot &s)
    {
        s.len = 0;
        s.cut = false;
        s.key.store(nullptr, std::memory_order_release);
    }

    Slot slots_[Slots];
};

}  // namespace fr::serial
