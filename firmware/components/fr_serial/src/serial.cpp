#include "fr/serial.hpp"

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>

#include "driver/usb_serial_jtag.h"
#include "esp_log.h"
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
// The frame ring also carries diag responses (up to a full 2048-character line), so it holds a few.
constexpr size_t kFrameRingBytes = 8192;
constexpr size_t kLogRingBytes = 4096;
/** Longest record: a full line plus its '\n'. */
constexpr size_t kMaxRecord = wire::kMaxLine + 1;
/** Longest log line kept whole; the ready banner with long alias/board/version strings is ~330. */
constexpr size_t kLogLine = 384;
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
        size_t n = line.size() + (newline ? 1 : 0);
        bool ok = false;
        portENTER_CRITICAL_SAFE(&mux_);
        if (n <= kMaxRecord && used_ + 2 + n <= kRingBytes) {
            put_byte(static_cast<char>(n & 0xFF));
            put_byte(static_cast<char>(n >> 8));
            put(line.data(), line.size());
            if (newline) {
                put_byte('\n');
            }
            ok = true;
        } else {
            ++dropped_;
        }
        portEXIT_CRITICAL_SAFE(&mux_);
        return ok;
    }

    /** Moves the oldest record into `out` (kMaxRecord bytes); returns its length, 0 when empty. */
    size_t pop(char *out)
    {
        size_t n = 0;
        portENTER_CRITICAL_SAFE(&mux_);
        if (used_ > 0) {
            n = static_cast<uint8_t>(take_byte());
            n |= static_cast<size_t>(static_cast<uint8_t>(take_byte())) << 8;
            for (size_t i = 0; i < n;) {
                size_t chunk = std::min(n - i, kRingBytes - tail_);
                std::memcpy(out + i, buf_ + tail_, chunk);
                tail_ = (tail_ + chunk) % kRingBytes;
                used_ -= chunk;
                i += chunk;
            }
        }
        portEXIT_CRITICAL_SAFE(&mux_);
        return n;
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

/** esp_log_set_vprintf hook: every ESP_LOG line becomes one log-ring record. */
int log_vprintf(const char *fmt, va_list ap)
{
    char buf[kLogLine];
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    if (n <= 0) {
        return n;
    }
    size_t len = std::min(static_cast<size_t>(n), sizeof(buf) - 1);
    if (static_cast<size_t>(n) >= sizeof(buf)) {
        buf[len - 1] = '\n';  // truncated: still exactly one line
    }
    s_logs.push({buf, len}, false);
    wake_writer();
    return n;
}

void writer_task(void *)
{
    static char out[kMaxRecord];
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
        // The driver's TX ring takes a write whole or not at all, so a dropped line never leaves half
        // a line behind for the host to misparse.
        if (usb_serial_jtag_write_bytes(out, n, kWriteTimeout) == static_cast<int>(n)) {
            s_frames_tx += frame ? 1 : 0;
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
    // Called on the core task for every frame, so the line lives on its stack, sized for the largest
    // envelope the node builds (EnvelopeLink: 505 B); anything longer is dropped and counted.
    char line[wire::kLinePrefix.size() + wire::base64url_len(512 + 3)];
    size_t n = wire::encode_line(type, body, line);
    if (n == 0) {
        s_frames.drop();
        return false;
    }
    return write_line({line, n});
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
