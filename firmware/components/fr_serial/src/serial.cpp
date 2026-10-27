#include "fr/serial.hpp"

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>

#include "driver/usb_serial_jtag.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "fr/serial_line.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG_ENABLED && CONFIG_VFS_SUPPORT_IO
#include "driver/usb_serial_jtag_vfs.h"
#endif

namespace fr::serial {
namespace {

constexpr const char *TAG = "fr_serial";
constexpr uint32_t kUsjBuffer = 4096;
// The frame ring also carries diag responses and bulk ENV frames (up to a full 2048-character line), so
// it holds a few.
constexpr size_t kFrameRingBytes = 8192;
constexpr size_t kLogRingBytes = 4096;
/** Longest record: a full line plus its '\n'. */
constexpr size_t kMaxRecord = wire::kMaxLine + 1;
/** Longest log line kept whole; the ready banner with long alias/board/version strings is ~330. */
constexpr size_t kLogLine = 384;
static_assert(kLogLine == kLogLineMax + 1);
// The net log ring (design m2-c2 D20): 4 KB on a radio image, a token one on the radio-off fixture, which never
// enables it. A record is `level u8 | pushed_ms u32 LE | tag_len u8 | tag | text`.
#if defined(CONFIG_FR_NET_RADIO) && CONFIG_FR_NET_RADIO
constexpr size_t kNetRingBytes = 4096;
constexpr size_t kNetJoinSlots = 3;  // tasks with a line half printed at once (the Wi-Fi blob's, a few others)
#else
constexpr size_t kNetRingBytes = 64;
constexpr size_t kNetJoinSlots = 1;
#endif
constexpr size_t kNetTagMax = 16;  // LOG.LINE.tag
constexpr size_t kNetHead = 6;
/** Largest ENV body write_frame encodes: a bulk envelope (spec 05 §5.6 MTU), whose line still fits kMaxLine. */
constexpr size_t kMaxFrameBody = 1470;
static_assert(wire::kLinePrefix.size() + wire::base64url_len(kMaxFrameBody + 3) <= wire::kMaxLine);
constexpr UBaseType_t kPrio = 9;
// A host that stops reading must cost the writer at most this per line, and producers nothing.
constexpr TickType_t kWriteTimeout = pdMS_TO_TICKS(20);
// Producers wake the writer; the timeout only covers wakeups lost before the scheduler ran.
constexpr TickType_t kIdleWait = pdMS_TO_TICKS(100);

/**
 * Multi-producer, single-consumer ring of whole lines, each stored as `len u16 | bytes` with its '\n'.
 * Producers copy under a spinlock (a few µs for the longest line), so no producer ever waits on the
 * USB host, and no lock is shared with the writer while it talks to the driver.
 */
template <size_t kRingBytes>
class LineRing
{
public:
    bool push(std::string_view line, bool newline)
    {
        const std::string_view parts[] = {line, newline ? std::string_view("\n") : std::string_view()};
        return push(parts);
    }

    /** One record of `parts` back to back; `was_empty` says whether the ring held nothing before it. */
    bool push(std::span<const std::string_view> parts, bool *was_empty = nullptr)
    {
        size_t n = 0;
        for (std::string_view p : parts) {
            n += p.size();
        }
        bool ok = false;
        portENTER_CRITICAL_SAFE(&mux_);
        if (was_empty != nullptr) {
            *was_empty = used_ == 0;
        }
        if (n <= kMaxRecord && used_ + 2 + n <= kRingBytes) {
            put_byte(static_cast<char>(n & 0xFF));
            put_byte(static_cast<char>(n >> 8));
            for (std::string_view p : parts) {
                put(p.data(), p.size());
            }
            ok = true;
        } else {
            ++dropped_;
        }
        portEXIT_CRITICAL_SAFE(&mux_);
        return ok;
    }

    /** Moves the oldest record into `out` (kMaxRecord bytes); returns its length, 0 when empty. */
    size_t pop(char *out) { return pop(out, kMaxRecord); }

    /** The same into `cap` bytes: a longer record's rest is dropped (it leaves the ring whole). */
    size_t pop(char *out, size_t cap)
    {
        size_t n = 0;
        portENTER_CRITICAL_SAFE(&mux_);
        if (used_ > 0) {
            n = static_cast<uint8_t>(take_byte());
            n |= static_cast<size_t>(static_cast<uint8_t>(take_byte())) << 8;
            for (size_t i = 0; i < n;) {
                size_t chunk = std::min(n - i, kRingBytes - tail_);
                if (i < cap) {
                    std::memcpy(out + i, buf_ + tail_, std::min(chunk, cap - i));
                }
                tail_ = (tail_ + chunk) % kRingBytes;
                used_ -= chunk;
                i += chunk;
            }
        }
        portEXIT_CRITICAL_SAFE(&mux_);
        return std::min(n, cap);
    }

    /** Counts a line that never reached push() (it could not be encoded). */
    void drop()
    {
        portENTER_CRITICAL_SAFE(&mux_);
        ++dropped_;
        portEXIT_CRITICAL_SAFE(&mux_);
    }
    uint32_t dropped() const { return dropped_; }
    void reset_dropped() { dropped_ = 0; }

private:
    void put_byte(char c)
    {
        buf_[(tail_ + used_) % kRingBytes] = c;
        ++used_;
    }
    void put(const char *p, size_t n)
    {
        for (size_t i = 0; i < n;) {
            size_t head = (tail_ + used_) % kRingBytes;
            size_t chunk = std::min(n - i, kRingBytes - head);
            std::memcpy(buf_ + head, p + i, chunk);
            used_ += chunk;
            i += chunk;
        }
    }
    char take_byte()
    {
        char c = buf_[tail_];
        tail_ = (tail_ + 1) % kRingBytes;
        --used_;
        return c;
    }

    portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
    char buf_[kRingBytes];
    size_t tail_ = 0;
    size_t used_ = 0;
    uint32_t dropped_ = 0;
};

LineRing<kFrameRingBytes> s_frames;
LineRing<kLogRingBytes> s_logs;
// The net log ring (design m2-c2 D20): off until enable_net_logs().
LineRing<kNetRingBytes> s_net_logs;
LineJoiner<kNetJoinSlots, kLogLineMax> s_net_join;
std::atomic<bool> s_net_on{false};
uint8_t s_net_max_level = 3;
void (*s_net_wake)() = nullptr;
std::atomic<uint32_t> s_net_cut{0};
Handlers s_handlers{};
TaskHandle_t s_writer = nullptr;

// Each counter has one writing task (writer or reader); readers may see a slightly stale value.
uint32_t s_frames_tx = 0;
uint32_t s_frames_failed = 0;
uint32_t s_logs_failed = 0;
uint32_t s_lines_discarded = 0;
uint32_t s_rx_frames = 0;
uint32_t s_rx_bad = 0;

void wake_writer()
{
    TaskHandle_t w = s_writer;
    if (w == nullptr || xTaskGetSchedulerState() != taskSCHEDULER_RUNNING) {
        return;
    }
    if (xPortInIsrContext()) {
        BaseType_t woken = pdFALSE;
        vTaskNotifyGiveFromISR(w, &woken);
        portYIELD_FROM_ISR(woken);
    } else {
        xTaskNotifyGive(w);
    }
}

/**
 * One whole line for the net log ring (design m2-c2 D20), its '\n' already gone: ANSI and a trailing '\r' off (as
 * the hub's serial path takes them off), the level and tag parsed out and floored by FR_NET_LOG_LEVEL, then pushed
 * with its stamp (fr::Core's clock, ms). The ring's first line after empty wakes the core task. Runs on the logging
 * task; logs nothing.
 */
void net_line(char *line, size_t len, bool cut)
{
    len = strip_ansi(line, len);
    if (len > 0 && line[len - 1] == '\r') {
        --len;
    }
    const std::string_view text(line, len);
    if (text.find_first_not_of(" \t") == std::string_view::npos) {
        return;  // blank: the hub stores none either
    }
    const LogHead head = parse_log_head(text);
    const uint8_t level = head.level != 0 ? head.level : 3;  // a line of another shape counts as I
    if (level > s_net_max_level) {
        return;
    }
    const std::string_view tag = head.tag.substr(0, kNetTagMax);
    // fr::Core's clock (EspCore::now() is esp_timer_get_time()) in ms, which Net's 30 s age limit reads it against.
    // Not esp_log_timestamp(), the `(<ms>)` in the text: esp_log's clock (LOG v1, RTOS source) is the cycle count
    // at its first call after the scheduler started plus 10 ms ticks, so it runs ahead of esp_timer by the boot's
    // start-up (+0.15..+0.57 s measured on the lab pads), and a stamp ahead of the drain's clock read as 49 days
    // old. esp_timer_get_time() takes no lock and is safe here (any task, the vprintf hook).
    const auto ms = static_cast<uint32_t>(esp_timer_get_time() / 1000);
    const char hdr[kNetHead] = {static_cast<char>(level),
                                static_cast<char>(ms & 0xFF),
                                static_cast<char>((ms >> 8) & 0xFF),
                                static_cast<char>((ms >> 16) & 0xFF),
                                static_cast<char>(ms >> 24),
                                static_cast<char>(tag.size())};
    const std::string_view parts[] = {{hdr, sizeof(hdr)}, tag, text};
    bool was_empty = false;
    if (!s_net_logs.push(parts, &was_empty)) {
        return;  // counted by the ring (ring_drop)
    }
    if (cut) {
        s_net_cut.fetch_add(1, std::memory_order_relaxed);
    }
    if (was_empty && s_net_wake != nullptr) {
        s_net_wake();
    }
}

/** esp_log_set_vprintf hook: every ESP_LOG line becomes one log-ring record (and, enabled, net log ring lines). */
int log_vprintf(const char *fmt, va_list ap)
{
    char buf[kLogLine];
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    if (n <= 0) {
        return n;
    }
    size_t len = std::min(static_cast<size_t>(n), sizeof(buf) - 1);
    const bool truncated = static_cast<size_t>(n) >= sizeof(buf);
    if (truncated) {
        buf[len - 1] = '\n';  // truncated: still exactly one line
    }
    s_logs.push({buf, len}, false);
    wake_writer();
    if (s_net_on.load(std::memory_order_acquire)) {
        // The same bytes the serial line got, so the hub's dedup finds the pair (design m2-c2 D21); the serial
        // ring has its copy, so the joiner may edit buf in place. The truncated line is the one ending at the '\n'
        // put in above.
        const char *forced = truncated ? buf + len - 1 : nullptr;
        s_net_join.feed(xTaskGetCurrentTaskHandle(), buf, len, [forced](char *line, size_t line_len, bool cut) {
            net_line(line, line_len, cut || line + line_len == forced);
        });
    }
    return n;
}

void writer_task(void *)
{
    static char out[kMaxRecord];
    // A library may print one log line in several vprintf calls (the Wi-Fi blob's "wifi certification
    // version" line, then its '\n'); a frame popped in between must not land on that line's end.
    bool line_open = false;
    for (;;) {
        size_t n = s_frames.pop(out);
        bool frame = n > 0;
        if (!frame) {
            n = s_logs.pop(out);
        }
        if (n == 0) {
            ulTaskNotifyTake(pdTRUE, kIdleWait);
            continue;
        }
        if (frame && line_open) {
            usb_serial_jtag_write_bytes("\n", 1, kWriteTimeout);
            line_open = false;
        }
        // The driver's TX ring takes a write whole or not at all, so a dropped line never leaves half
        // a line behind for the host to misparse.
        if (usb_serial_jtag_write_bytes(out, n, kWriteTimeout) == static_cast<int>(n)) {
            s_frames_tx += frame ? 1 : 0;
            if (!frame) {
                line_open = out[n - 1] != '\n';
            }
        } else if (frame) {
            ++s_frames_failed;
        } else {
            ++s_logs_failed;
        }
    }
}

void route(std::string_view line)
{
    if (!line.empty() && line.back() == '\r') {
        line.remove_suffix(1);
    }
    if (line.size() > wire::kMaxLine) {
        ++s_lines_discarded;
        return;
    }
    if (line.empty()) {
        return;
    }
    if (line.starts_with(wire::kLinePrefix)) {
        bool ok = s_handlers.frame != nullptr && s_handlers.frame(line);
        ++(ok ? s_rx_frames : s_rx_bad);
        return;
    }
    if (s_handlers.text != nullptr) {
        s_handlers.text(line);
    }
}

void reader_task(void *)
{
    // One spare byte so a 2048-character line can still carry its \r.
    static char line[wire::kMaxLine + 1];
    static uint8_t rx[256];
    size_t len = 0;
    bool discarding = false;
    for (;;) {
        int n = usb_serial_jtag_read_bytes(rx, sizeof(rx), portMAX_DELAY);
        for (int i = 0; i < n; ++i) {
            char c = static_cast<char>(rx[i]);
            if (c == '\n') {
                if (discarding) {
                    ++s_lines_discarded;
                    discarding = false;
                } else {
                    route({line, len});
                }
                len = 0;
            } else if (!discarding) {
                if (len == sizeof(line)) {
                    discarding = true;
                    len = 0;
                } else {
                    line[len++] = c;
                }
            }
        }
    }
}

}  // namespace

bool start(const Handlers &h)
{
    s_handlers = h;
    usb_serial_jtag_driver_config_t cfg = {.tx_buffer_size = kUsjBuffer, .rx_buffer_size = kUsjBuffer};
    esp_err_t err = usb_serial_jtag_driver_install(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "usb_serial_jtag_driver_install: %s", esp_err_to_name(err));
        return false;
    }
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG_ENABLED && CONFIG_VFS_SUPPORT_IO
    // Stray printf now queues in the driver's TX ring instead of racing the writer for the FIFO.
    usb_serial_jtag_vfs_use_driver();
#endif
    if (xTaskCreate(writer_task, "fr_serial", 3072, nullptr, kPrio, &s_writer) != pdPASS ||
        xTaskCreate(reader_task, "fr_serial_rx", 4096, nullptr, kPrio, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "cannot create tasks");
        return false;
    }
    esp_log_set_vprintf(log_vprintf);
    return true;
}

bool write_line(std::string_view line)
{
    bool ok = s_frames.push(line, true);
    wake_writer();
    return ok;
}

bool write_frame(uint8_t type, std::span<const uint8_t> body)
{
    // The core task is the only caller (fr_net's serial link), so one static line serves every frame; a
    // bulk envelope's ~2 KB line would not belong on its stack. Anything longer is dropped and counted.
    static char line[wire::kLinePrefix.size() + wire::base64url_len(kMaxFrameBody + 3)];
    size_t n = wire::encode_line(type, body, line);
    if (n == 0) {
        s_frames.drop();
        return false;
    }
    return write_line({line, n});
}

bool connected()
{
    return usb_serial_jtag_is_connected();
}

void enable_net_logs(uint8_t max_level, void (*wake)())
{
    s_net_max_level = max_level;
    s_net_wake = wake;
    s_net_on.store(true, std::memory_order_release);
}

bool pop_net_log(NetLogLine &line, std::span<char> scratch)
{
    // Popped in place: the views below point into the caller's scratch.
    if (scratch.size() < kNetHead) {
        return false;
    }
    const size_t n = s_net_logs.pop(scratch.data(), scratch.size());
    if (n < kNetHead) {
        return false;
    }
    const auto byte = [&](size_t i) { return static_cast<uint8_t>(scratch[i]); };
    const size_t tag_len = std::min<size_t>(byte(5), n - kNetHead);
    line.level = byte(0);
    line.pushed_ms = byte(1) | uint32_t{byte(2)} << 8 | uint32_t{byte(3)} << 16 | uint32_t{byte(4)} << 24;
    line.tag = {scratch.data() + kNetHead, tag_len};
    line.text = {scratch.data() + kNetHead + tag_len, n - kNetHead - tag_len};
    return true;
}

NetLogStats net_log_stats()
{
    return {.ring_drop = s_net_logs.dropped(), .cut = s_net_cut.load(std::memory_order_relaxed)};
}

Stats stats()
{
    return {.frames_tx = s_frames_tx,
            .frames_dropped = s_frames.dropped() + s_frames_failed,
            .logs_dropped = s_logs.dropped() + s_logs_failed,
            .lines_discarded = s_lines_discarded,
            .rx_frames = s_rx_frames,
            .rx_bad = s_rx_bad};
}

void reset_stats()
{
    s_frames_tx = 0;
    s_frames_failed = 0;
    s_logs_failed = 0;
    s_lines_discarded = 0;
    s_rx_frames = 0;
    s_rx_bad = 0;
    s_frames.reset_dropped();
    s_logs.reset_dropped();
}

}  // namespace fr::serial
