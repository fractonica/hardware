// The fr_net task and the TCP/UDP links (design c3 §3 "Links", spec 05 §5.10-5.12). The task owns Wi-Fi
// control (WifiSta), hub_host resolution and the TCP socket; it sleeps in select() on the TCP socket and an
// eventfd that Wi-Fi events, TX frames and drop requests poke. The core task's side never blocks: a TCP
// frame is appended to a lock-free FIFO, a UDP datagram is one non-blocking sendto() on a socket that
// lives for the whole run, so only one task ever writes to each socket.
#include <fcntl.h>
#include <strings.h>
#include <sys/select.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cinttypes>
#include <cstdio>
#include <cstring>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_vfs_eventfd.h"
#include "esp_wifi.h"
#include "fr/net/esp.hpp"
#include "fr/net/tx_fifo.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include "mdns.h"
#include "protocol.hpp"  // generated fr::proto::kMtuBulk
#include "wifi_sta.hpp"

namespace fr::net::esp {
namespace {

using detail::Event;
using detail::WifiSta;

constexpr const char *TAG = "fr_net";
// Above fr_core (10): a frame the core queues for TCP goes out as soon as the core yields the CPU it was
// queued on. Below lwIP (18), the event loop (20) and Wi-Fi (23), as every fr task (spec 03 §3.4).
constexpr UBaseType_t kTaskPrio = 11;
constexpr uint32_t kTaskStack = 4096;
constexpr size_t kEventQueue = 16;
constexpr size_t kTxBytes = 8192;  // a few bulk RESULTs, or a get_state burst before udp_ok (a power of two)
constexpr size_t kMaxFrame = fr::proto::kMtuBulk;
constexpr TimeUs kBackoffMinUs = 250'000;  // 05 §5.11: reconnect backoff 0.25 -> 5 s
constexpr TimeUs kBackoffMaxUs = 5'000'000;
constexpr TimeUs kStableUs = 10'000'000;  // a connection that lasted this long starts the backoff over
constexpr TimeUs kConnectTimeoutUs = 3'000'000;
constexpr TimeUs kIdleWaitUs = 1'000'000;  // longest select() wait, so deadlines are never far off
constexpr uint32_t kMdnsTimeoutMs = 1000;
// 05 §5.11: SO_KEEPALIVE idle 5 s, interval 1 s, count 3 on both ends.
constexpr int kKeepIdleS = 5;
constexpr int kKeepIntvlS = 1;
constexpr int kKeepCnt = 3;

TimeUs now_us()
{
    return esp_timer_get_time();
}

/**
 * Why a TCP connection ended, or why an attempt never connected: the one log line of each close and, for an
 * established connection, its diag `stats` counter (tcp_close_*; bad frames are tcp_rx_bad).
 */
enum class Close : uint8_t {
    none,       // no address or no socket: nothing was open, nothing to say
    connect,    // the attempt failed (errno) or timed out (0)
    peer,       // the hub closed it (its offline timeout, a newer HELLO of this device, a restart)
    keepalive,  // lwIP gave up on the hub: keepalive (idle 5 s + 3 x 1 s) or retransmission timeout
    error,      // receive or send failed with another errno (a reset, say)
    bad_frame,  // a length of 0 or above the bulk MTU from the hub
    session,    // Net lost the session (Link::drop) and asked for a fresh connection
    wifi,       // Wi-Fi association or address lost
};
constexpr size_t kCloseKinds = static_cast<size_t>(Close::wifi) + 1;

const char *drop_text(DropReason why)
{
    switch (why) {
    case DropReason::hub_silent:
        return "no hub frame for 3.5 heartbeat intervals";
    case DropReason::hub_bye:
        return "the hub said BYE";
    case DropReason::hub_restarted:
        return "a new hub run WELCOMEd the other link";
    }
    return "?";
}

/** The hub address, the TCP connection and the UDP socket. Methods run on the fr_net task unless noted. */
class Hub
{
public:
    void configure(const Settings &s)
    {
        port_ = s.hub_port;
        in_addr a{};
        if (s.hub_ip[0] != '\0' && inet_aton(s.hub_ip, &a) != 0) {
            fallback_ip_ = a.s_addr;
        }
    }

    bool open_udp()
    {
        udp_fd_ = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (udp_fd_ < 0) {
            ESP_LOGE(TAG, "hub: no UDP socket (errno %d)", errno);
            return false;
        }
        set_nonblocking(udp_fd_);
        return true;
    }

    void poll(TimeUs now, const WifiSta &wifi);
    /** Waits in select() until a socket, the eventfd or `deadline` (0: none) needs the task. */
    void wait(TimeUs now, TimeUs deadline, int efd);
    /** Hands link changes to the core, retrying the ones it could not take. */
    void notify(const Hooks &hooks);

    // Core task.
    bool tcp_up() const { return tcp_up_.load(std::memory_order_acquire); }
    bool udp_up() const { return udp_up_.load(std::memory_order_acquire); }
    fr::Status tcp_send(std::span<const uint8_t> env);
    fr::Status udp_send(std::span<const uint8_t> env);
    void request_drop(DropReason why)
    {
        drop_why_.store(static_cast<uint8_t>(why), std::memory_order_relaxed);
        drop_req_.store(true, std::memory_order_release);
        detail::wake();
    }
    void request_hold(bool on)
    {
        hold_.store(on, std::memory_order_release);
        detail::wake();
    }

    void fill(Status &s) const;

private:
    enum class Phase : uint8_t { idle, waiting, connecting, connected };

    static void set_nonblocking(int fd)
    {
        int flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    }

    void resolve(const WifiSta &wifi);
    void start_connect(TimeUs now);
    void on_connected(TimeUs now);
    void finish_connect(TimeUs now);
    /** Closes the TCP socket (if open) and schedules the next attempt. `why` and `detail` (an errno, 0 for
     * none; for Close::wifi the Wi-Fi disconnect reason) say what happened: one log line when a socket was
     * open, and the counter of its kind when it was connected. */
    void close_tcp(TimeUs now, Close why, int detail = 0);
    /** Closes on a failed recv()/send(): lwIP aborting the connection is the keepalive's verdict. */
    void close_on_errno(TimeUs now, int err);
    void receive(TimeUs now);
    void flush(TimeUs now);
    void set_tcp_up(bool v);
    void set_udp_up(bool v);

    uint16_t port_ = 7421;
    uint32_t fallback_ip_ = 0;  // fr_ident hub_ip (network order)
    uint32_t last_ip_ = 0;      // the last address hub_host resolved to this boot
    bool unresolved_said_ = false;  // "does not resolve" logged since the last address
    std::atomic<uint32_t> hub_ip_{0};  // what TCP connects to and UDP sends to (network order)
    char resolved_host_[FR_ID_HOST_MAX + 1] = {};  // hub_host behind hub_ip_, for diag (under host_mux_)
    mutable portMUX_TYPE host_mux_ = portMUX_INITIALIZER_UNLOCKED;

    Phase phase_ = Phase::idle;
    int fd_ = -1;
    int udp_fd_ = -1;
    TimeUs next_at_ = 0;
    TimeUs deadline_ = 0;
    TimeUs connected_at_ = 0;
    TimeUs backoff_ = kBackoffMinUs;
    uint32_t fail_streak_ = 0;  // attempts in a row that never connected: only the first is logged loudly

    TxFifo<kTxBytes> tx_;
    uint8_t rx_[2 + kMaxFrame];
    size_t rx_fill_ = 0;

    std::atomic<bool> tcp_up_{false};
    std::atomic<bool> udp_up_{false};
    std::atomic<bool> drop_req_{false};
    std::atomic<uint8_t> drop_why_{0};  // DropReason of the pending drop_req_
    std::atomic<bool> hold_{false};     // drop_hub_link: no reconnect (core task writes)
    bool held_ = false;                 // hold_ as poll() last saw it
    uint8_t pending_ = 0;  // LinkKind bits whose change the core has not taken yet

    std::atomic<uint32_t> connects_{0};
    std::atomic<uint32_t> closes_{0};
    std::atomic<uint32_t> close_by_[kCloseKinds]{};  // closes_ by Close kind
    std::atomic<int> last_errno_{0};                    // of the last keepalive or error close
    std::atomic<uint32_t> tx_dropped_{0};
    std::atomic<uint32_t> rx_bad_{0};
    std::atomic<uint32_t> udp_fail_{0};
};

WifiSta s_wifi;
Hub s_hub;
Hooks s_hooks{};
QueueHandle_t s_events = nullptr;
int s_efd = -1;
bool s_started = false;
std::atomic<uint32_t> s_events_lost{0};

// ---- Hub ----

void Hub::set_tcp_up(bool v)
{
    if (tcp_up_.exchange(v, std::memory_order_acq_rel) != v) {
        pending_ |= 1u << index_of(LinkKind::tcp);
    }
}

void Hub::set_udp_up(bool v)
{
    if (udp_up_.exchange(v, std::memory_order_acq_rel) != v) {
        pending_ |= 1u << index_of(LinkKind::udp);
    }
}

void Hub::notify(const Hooks &hooks)
{
    for (LinkKind k : {LinkKind::tcp, LinkKind::udp}) {
        uint8_t bit = static_cast<uint8_t>(1u << index_of(k));
        if ((pending_ & bit) != 0 && hooks.link_changed != nullptr && hooks.link_changed(k)) {
            pending_ &= static_cast<uint8_t>(~bit);
        }
    }
}

void Hub::resolve(const WifiSta &wifi)
{
    // 05 §5.12.5: hub_host by mDNS on every attempt (macOS answers for <LocalHostName>.local whatever
    // Local Network Privacy says), then the address it last had, then fr_ident's hub_ip.
    const char *host = wifi.hub_host();
    uint32_t ip = 0;
    const char *how = nullptr;
    size_t len = std::strlen(host);
    in_addr literal{};
    if (len > 0 && inet_aton(host, &literal) != 0) {
        ip = literal.s_addr;
        how = "literal";
    } else if (len > 6 && strcasecmp(host + len - 6, ".local") == 0) {
        char name[FR_ID_HOST_MAX + 1];
        std::snprintf(name, sizeof(name), "%.*s", static_cast<int>(len - 6), host);  // mDNS wants no domain
        esp_ip4_addr_t a{};
        esp_err_t err = mdns_query_a(name, kMdnsTimeoutMs, &a);
        if (err == ESP_OK && a.addr != 0) {
            ip = a.addr;
            how = "mdns";
        } else {
            ESP_LOGD(TAG, "hub: mDNS %s: %s", host, esp_err_to_name(err));
        }
    } else if (len > 0) {
        addrinfo hints{};
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        addrinfo *res = nullptr;
        if (getaddrinfo(host, nullptr, &hints, &res) == 0 && res != nullptr) {
            ip = reinterpret_cast<const sockaddr_in *>(res->ai_addr)->sin_addr.s_addr;
            how = "dns";
        }
        if (res != nullptr) {
            freeaddrinfo(res);
        }
    }
    if (ip != 0) {
        last_ip_ = ip;
    } else if (last_ip_ != 0) {
        ip = last_ip_;
        how = "last address";
    } else if (fallback_ip_ != 0) {
        ip = fallback_ip_;
        how = "hub_ip";
    }
    const char *shown = len > 0 ? host : "(no hub_host)";
    if (ip == 0) {
        if (!unresolved_said_) {
            ESP_LOGW(TAG, "hub: %s does not resolve and there is no fallback address", shown);
            unresolved_said_ = true;
        }
    } else {
        unresolved_said_ = false;
        if (ip != hub_ip_.load(std::memory_order_relaxed)) {
            const uint8_t *b = reinterpret_cast<const uint8_t *>(&ip);
            ESP_LOGI(TAG, "hub: %s is %u.%u.%u.%u (%s)", shown, b[0], b[1], b[2], b[3], how);
        }
    }
    portENTER_CRITICAL(&host_mux_);
    std::snprintf(resolved_host_, sizeof(resolved_host_), "%s", host);
    portEXIT_CRITICAL(&host_mux_);
    hub_ip_.store(ip, std::memory_order_release);
    set_udp_up(ip != 0);
}

void Hub::start_connect(TimeUs now)
{
    uint32_t ip = hub_ip_.load(std::memory_order_relaxed);
    if (ip == 0) {
        close_tcp(now, Close::none);
        return;
    }
    fd_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd_ < 0) {
        ESP_LOGW(TAG, "hub: no TCP socket (errno %d)", errno);
        close_tcp(now, Close::none);
        return;
    }
    set_nonblocking(fd_);
    int one = 1;
    int idle = kKeepIdleS;
    int intvl = kKeepIntvlS;
    int cnt = kKeepCnt;
    // 05 §5.12.1: no Nagle (frames are latency-bound); keepalive finds a dead peer behind a silent NAT.
    setsockopt(fd_, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    setsockopt(fd_, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
    setsockopt(fd_, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
    setsockopt(fd_, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
    setsockopt(fd_, IPPROTO_TCP, TCP_KEEPCNT, &cnt, sizeof(cnt));
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(port_);
    a.sin_addr.s_addr = ip;
    if (connect(fd_, reinterpret_cast<const sockaddr *>(&a), sizeof(a)) == 0) {
        on_connected(now);
        return;
    }
    if (errno != EINPROGRESS) {
        close_tcp(now, Close::connect, errno);
        return;
    }
    phase_ = Phase::connecting;
    deadline_ = now + kConnectTimeoutUs;
}

void Hub::finish_connect(TimeUs now)
{
    int err = 0;
    socklen_t len = sizeof(err);
    if (getsockopt(fd_, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
        close_tcp(now, Close::connect, err != 0 ? err : errno);
        return;
    }
    on_connected(now);
}

void Hub::on_connected(TimeUs now)
{
    // A new stream starts on a frame boundary: nothing queued for an earlier connection may lead it.
    tx_dropped_.fetch_add(tx_.discard(), std::memory_order_relaxed);
    rx_fill_ = 0;
    phase_ = Phase::connected;
    connected_at_ = now;
    fail_streak_ = 0;
    connects_.fetch_add(1, std::memory_order_relaxed);
    uint32_t ip = hub_ip_.load(std::memory_order_relaxed);
    const uint8_t *q = reinterpret_cast<const uint8_t *>(&ip);
    ESP_LOGI(TAG, "hub: connected to %u.%u.%u.%u:%u", q[0], q[1], q[2], q[3], port_);
    set_tcp_up(true);
}

void Hub::close_tcp(TimeUs now, Close why, int detail)
{
    bool was_connected = phase_ == Phase::connected;
    if (fd_ >= 0 && why != Close::none) {
        char text[96];
        switch (why) {
        case Close::connect:
            if (detail != 0) {
                std::snprintf(text, sizeof(text), "connect failed (errno %d, %s)", detail, std::strerror(detail));
            } else {
                std::snprintf(text, sizeof(text), "connect timed out");
            }
            break;
        case Close::peer:
            std::snprintf(text, sizeof(text), "the hub closed it");
            break;
        case Close::keepalive:
            std::snprintf(text, sizeof(text), "keepalive or retransmit timeout (errno %d, %s)", detail,
                          std::strerror(detail));
            break;
        case Close::error:
            std::snprintf(text, sizeof(text), "socket error (errno %d, %s)", detail, std::strerror(detail));
            break;
        case Close::bad_frame:
            std::snprintf(text, sizeof(text), "bad frame length from the hub");
            break;
        case Close::session:
            std::snprintf(text, sizeof(text), "session lost: %s",
                          drop_text(static_cast<DropReason>(drop_why_.load(std::memory_order_relaxed))));
            break;
        case Close::wifi:
            if (detail != 0) {
                std::snprintf(text, sizeof(text), "Wi-Fi lost (disconnect reason %d)", detail);
            } else {
                std::snprintf(text, sizeof(text), "Wi-Fi lost (address lost)");
            }
            break;
        case Close::none:
            break;
        }
        if (was_connected) {
            // One line per close, so a reconnect seen on the bench says why (diag stats counts them).
            ESP_LOGW(TAG, "hub: TCP closed after %" PRId64 " ms: %s", (now - connected_at_) / 1000, text);
        } else {
            // While the hub is away every attempt fails the same way; the first one says so.
            esp_log_level_t level = fail_streak_ > 0 ? ESP_LOG_DEBUG : ESP_LOG_WARN;
            ESP_LOG_LEVEL_LOCAL(level, TAG, "hub: no connection: %s", text);
        }
    }
    if (!was_connected) {
        ++fail_streak_;
    }
    if (fd_ >= 0) {
        close(fd_);
        fd_ = -1;
    }
    if (was_connected) {
        set_tcp_up(false);
        closes_.fetch_add(1, std::memory_order_relaxed);
        close_by_[static_cast<size_t>(why)].fetch_add(1, std::memory_order_relaxed);
        if (why == Close::keepalive || why == Close::error) {
            last_errno_.store(detail, std::memory_order_relaxed);
        }
        tx_dropped_.fetch_add(tx_.discard(), std::memory_order_relaxed);
        if (now - connected_at_ >= kStableUs) {
            backoff_ = kBackoffMinUs;
        }
    }
    rx_fill_ = 0;
    phase_ = Phase::waiting;
    next_at_ = now + backoff_;
    backoff_ = std::min(backoff_ * 2, kBackoffMaxUs);
}

void Hub::poll(TimeUs now, const WifiSta &wifi)
{
    // `net drop_hub_link` (09 §9.7): no resolve and no reconnect while it lasts; at its end, at once.
    bool hold = hold_.load(std::memory_order_acquire);
    if (held_ && !hold) {
        backoff_ = kBackoffMinUs;
        next_at_ = now;
    }
    held_ = hold;
    if (!wifi.ip_up()) {
        if (fd_ >= 0) {
            close_tcp(now, Close::wifi, wifi.disconnect_reason());
        }
        set_udp_up(false);
        phase_ = Phase::idle;
        backoff_ = kBackoffMinUs;
        drop_req_.store(false, std::memory_order_relaxed);
        return;
    }
    if (drop_req_.exchange(false, std::memory_order_acq_rel) && fd_ >= 0) {
        // Net lost the session (05 §5.11): a fresh connection and a fresh HELLO.
        close_tcp(now, Close::session);
    }
    switch (phase_) {
    case Phase::idle:
        phase_ = Phase::waiting;
        next_at_ = now;
        [[fallthrough]];
    case Phase::waiting:
        if (!held_ && now >= next_at_) {
            resolve(wifi);
            start_connect(now_us());  // resolution may have taken its timeout
        }
        break;
    case Phase::connecting:
        if (now >= deadline_) {
            close_tcp(now, Close::connect);
        }
        break;
    case Phase::connected:
        break;
    }
}

void Hub::receive(TimeUs now)
{
    ssize_t n = recv(fd_, rx_ + rx_fill_, sizeof(rx_) - rx_fill_, MSG_DONTWAIT);
    if (n == 0) {
        close_tcp(now, Close::peer);
        return;
    }
    if (n < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK) {
            close_on_errno(now, errno);
        }
        return;
    }
    rx_fill_ += static_cast<size_t>(n);
    size_t off = 0;
    while (rx_fill_ - off >= 2) {
        size_t len = rx_[off] | static_cast<size_t>(rx_[off + 1]) << 8;
        if (len == 0 || len > kMaxFrame) {
            // Not our framing (or a desynchronised stream): nothing after it can be trusted.
            rx_bad_.fetch_add(1, std::memory_order_relaxed);
            close_tcp(now, Close::bad_frame);
            return;
        }
        if (rx_fill_ - off - 2 < len) {
            break;
        }
        if (s_hooks.deliver != nullptr) {
            s_hooks.deliver(LinkKind::tcp, {rx_ + off + 2, len});  // it counts what it could not take
        }
        off += 2 + len;
    }
    // At most one partial frame remains, and a whole frame always fits the buffer.
    std::memmove(rx_, rx_ + off, rx_fill_ - off);
    rx_fill_ -= off;
}

void Hub::flush(TimeUs now)
{
    for (;;) {
        std::span<const uint8_t> chunk = tx_.peek();
        if (chunk.empty()) {
            return;
        }
        ssize_t n = send(fd_, chunk.data(), chunk.size(), MSG_DONTWAIT);
        if (n > 0) {
            tx_.consume(static_cast<size_t>(n));
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return;  // select() reports when there is room again
        }
        close_on_errno(now, n < 0 ? errno : 0);
        return;
    }
}

void Hub::close_on_errno(TimeUs now, int err)
{
    // lwIP reports its own abort of a connection (keepalive probes unanswered, retransmissions exhausted)
    // as ECONNABORTED; ETIMEDOUT where a stack says so directly.
    close_tcp(now, err == ECONNABORTED || err == ETIMEDOUT ? Close::keepalive : Close::error, err);
}

void Hub::wait(TimeUs now, TimeUs deadline, int efd)
{
    auto consider = [&deadline](TimeUs d) {
        if (d != 0 && (deadline == 0 || d < deadline)) {
            deadline = d;
        }
    };
    if (phase_ == Phase::waiting && !held_) {
        consider(next_at_);
    } else if (phase_ == Phase::connecting) {
        consider(deadline_);
    }
    TimeUs wait_us = kIdleWaitUs;
    if (deadline != 0) {
        wait_us = std::clamp(deadline - now, TimeUs{0}, kIdleWaitUs);
    }
    if (pending_ != 0) {
        wait_us = std::min(wait_us, TimeUs{20'000});  // the core queue was full: offer again soon
    }

    fd_set rd;
    fd_set wr;
    FD_ZERO(&rd);
    FD_ZERO(&wr);
    FD_SET(efd, &rd);
    int maxfd = efd;
    if (fd_ >= 0) {
        if (phase_ == Phase::connecting) {
            FD_SET(fd_, &wr);
        } else {
            FD_SET(fd_, &rd);
            if (!tx_.empty()) {
                FD_SET(fd_, &wr);
            }
        }
        maxfd = std::max(maxfd, fd_);
    }
    timeval tv{};
    tv.tv_sec = static_cast<time_t>(wait_us / 1'000'000);
    tv.tv_usec = static_cast<suseconds_t>(wait_us % 1'000'000);
    int n = select(maxfd + 1, &rd, &wr, nullptr, &tv);
    if (n < 0) {
        ESP_LOGW(TAG, "select failed (errno %d)", errno);
        vTaskDelay(pdMS_TO_TICKS(50));  // never spin
        return;
    }
    if (FD_ISSET(efd, &rd)) {
        uint64_t v = 0;
        read(efd, &v, sizeof(v));  // reset the counter; the loop looks at everything anyway
    }
    TimeUs t = now_us();
    if (fd_ >= 0 && phase_ == Phase::connecting && FD_ISSET(fd_, &wr)) {
        finish_connect(t);
    }
    if (fd_ >= 0 && phase_ == Phase::connected && FD_ISSET(fd_, &rd)) {
        receive(t);
    }
    if (fd_ >= 0 && phase_ == Phase::connected) {
        flush(t);  // also what an eventfd poke from tcp_send() is for
    }
}

fr::Status Hub::tcp_send(std::span<const uint8_t> env)
{
    if (env.empty() || env.size() > kMaxFrame) {
        return std::unexpected(Err::invalid_args);
    }
    if (!tcp_up()) {
        return std::unexpected(Err::busy);
    }
    if (!tx_.push(env)) {
        tx_dropped_.fetch_add(1, std::memory_order_relaxed);
        return std::unexpected(Err::busy);
    }
    detail::wake();
    return {};
}

fr::Status Hub::udp_send(std::span<const uint8_t> env)
{
    if (!udp_up() || udp_fd_ < 0) {
        return std::unexpected(Err::busy);
    }
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(port_);
    a.sin_addr.s_addr = hub_ip_.load(std::memory_order_acquire);
    // Non-blocking: when the driver has no TX buffer (ENOMEM) the datagram is lost; Net retries Q1.
    if (sendto(udp_fd_, env.data(), env.size(), MSG_DONTWAIT, reinterpret_cast<const sockaddr *>(&a), sizeof(a)) < 0) {
        udp_fail_.fetch_add(1, std::memory_order_relaxed);
        return std::unexpected(Err::busy);
    }
    return {};
}

void Hub::fill(Status &s) const
{
    uint32_t ip = hub_ip_.load(std::memory_order_acquire);
    std::memcpy(s.hub_ip, &ip, sizeof(s.hub_ip));
    portENTER_CRITICAL(&host_mux_);
    std::memcpy(s.hub_host, resolved_host_, sizeof(s.hub_host));
    portEXIT_CRITICAL(&host_mux_);
    s.tcp_up = tcp_up();
    s.udp_up = udp_up();
    s.tcp_connects = connects_.load(std::memory_order_relaxed);
    s.tcp_closes = closes_.load(std::memory_order_relaxed);
    auto by = [this](Close c) { return close_by_[static_cast<size_t>(c)].load(std::memory_order_relaxed); };
    s.tcp_close_peer = by(Close::peer);
    s.tcp_close_keepalive = by(Close::keepalive);
    s.tcp_close_error = by(Close::error);
    s.tcp_close_session = by(Close::session);
    s.tcp_close_wifi = by(Close::wifi);
    s.tcp_last_errno = last_errno_.load(std::memory_order_relaxed);
    s.tcp_tx_dropped = tx_dropped_.load(std::memory_order_relaxed);
    s.tcp_rx_bad = rx_bad_.load(std::memory_order_relaxed);
    s.udp_tx_fail = udp_fail_.load(std::memory_order_relaxed);
}

// ---- links ----

class TcpLink final : public Link
{
public:
    LinkKind kind() const override { return LinkKind::tcp; }
    bool up() const override { return s_hub.tcp_up(); }
    fr::Status send(std::span<const uint8_t> envelope) override { return s_hub.tcp_send(envelope); }
    void drop(DropReason why) override { s_hub.request_drop(why); }
    void hold(bool on) override { s_hub.request_hold(on); }
};

class UdpLink final : public Link
{
public:
    LinkKind kind() const override { return LinkKind::udp; }
    bool up() const override { return s_hub.udp_up(); }
    fr::Status send(std::span<const uint8_t> envelope) override { return s_hub.udp_send(envelope); }
};

TcpLink s_tcp;
UdpLink s_udp;

// ---- task and events ----

/** Default event loop task: copy the event for the fr_net task, which runs the state machine. */
void on_event(void *, esp_event_base_t base, int32_t id, void *data)
{
    Event e;
    std::memset(&e, 0, sizeof(e));
    e.base = base;
    e.id = id;
    size_t size = 0;
    if (base == WIFI_EVENT) {
        switch (id) {
        case WIFI_EVENT_STA_START:
        case WIFI_EVENT_STA_STOP:
        case WIFI_EVENT_SCAN_DONE:
            break;
        case WIFI_EVENT_STA_CONNECTED:
            size = sizeof(e.data.connected);
            break;
        case WIFI_EVENT_STA_DISCONNECTED:
            size = sizeof(e.data.disconnected);
            break;
        case WIFI_EVENT_HOME_CHANNEL_CHANGE:
            size = sizeof(e.data.channel);
            break;
        default:
            return;
        }
    } else if (base == IP_EVENT) {
        if (id == IP_EVENT_STA_GOT_IP) {
            size = sizeof(e.data.got_ip);
        } else if (id != IP_EVENT_STA_LOST_IP) {
            return;
        }
    } else {
        return;
    }
    if (data != nullptr && size > 0) {
        std::memcpy(&e.data, data, size);
    }
    if (xQueueSend(s_events, &e, 0) != pdTRUE) {
        // The state machine's own deadlines recover from a lost event.
        s_events_lost.fetch_add(1, std::memory_order_relaxed);
    }
    detail::wake();
}

void task_main(void *)
{
    for (;;) {
        TimeUs now = now_us();
        Event e;
        while (xQueueReceive(s_events, &e, 0) == pdTRUE) {
            s_wifi.on_event(e, now);
        }
        s_wifi.poll(now);
        s_hub.poll(now, s_wifi);
        s_hub.notify(s_hooks);
        s_hub.wait(now_us(), s_wifi.next_deadline(), s_efd);
    }
}

bool check(esp_err_t err, const char *what)
{
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "%s: %s", what, esp_err_to_name(err));
        return false;
    }
    return true;
}

}  // namespace

namespace detail {

void wake()
{
    if (s_efd >= 0) {
        uint64_t one = 1;
        write(s_efd, &one, sizeof(one));
    }
}

}  // namespace detail

bool start(const Settings &settings, const Hooks &hooks)
{
    if (s_started) {
        return true;
    }
    s_hooks = hooks;
    s_hub.configure(settings);
    s_wifi.configure(settings, now_us());

    if (!check(esp_netif_init(), "esp_netif_init")) {
        return false;
    }
    esp_err_t err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {  // INVALID_STATE: someone created it already
        return check(err, "esp_event_loop_create_default");
    }
    esp_netif_t *netif = esp_netif_create_default_wifi_sta();
    if (netif == nullptr) {
        ESP_LOGE(TAG, "no Wi-Fi STA netif");
        return false;
    }
    if (settings.hostname[0] != '\0') {
        esp_netif_set_hostname(netif, settings.hostname);  // before DHCP starts: the router lists the alias
    }
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    if (!check(esp_wifi_init(&cfg), "esp_wifi_init")) {
        return false;
    }
    // The credentials live in fr_ident / fr_net2 only; the driver must not copy them into its NVS.
    check(esp_wifi_set_storage(WIFI_STORAGE_RAM), "esp_wifi_set_storage");
    if (!check(esp_wifi_set_mode(WIFI_MODE_STA), "esp_wifi_set_mode")) {
        return false;
    }
    if (settings.country[0] != '\0') {
        // Manual policy (802.11d off): the legal channel set is the provisioned country's (05 §5.3).
        check(esp_wifi_set_country_code(settings.country, false), "esp_wifi_set_country_code");
    } else {
        ESP_LOGW(TAG, "wifi: no country in fr_ident; using the driver default");
    }
    // Before Wi-Fi starts, so mDNS sees the STA interface come up.
    if (!check(mdns_init(), "mdns_init")) {
        ESP_LOGW(TAG, "hub: no mDNS; hub_host falls back to the provisioned hub_ip");
    }

    esp_vfs_eventfd_config_t efd_cfg{};
    efd_cfg.max_fds = 4;
    err = esp_vfs_eventfd_register(&efd_cfg);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {  // INVALID_STATE: already registered
        return check(err, "esp_vfs_eventfd_register");
    }
    s_efd = eventfd(0, 0);
    s_events = xQueueCreate(kEventQueue, sizeof(Event));
    if (s_efd < 0 || s_events == nullptr) {
        ESP_LOGE(TAG, "no eventfd or event queue");
        return false;
    }
    s_hub.open_udp();
    if (!check(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, nullptr, nullptr),
               "wifi event handler") ||
        !check(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, nullptr, nullptr),
               "ip event handler") ||
        !check(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_LOST_IP, on_event, nullptr, nullptr),
               "ip event handler")) {
        return false;
    }
    if (xTaskCreate(task_main, "fr_net", kTaskStack, nullptr, kTaskPrio, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "cannot create the fr_net task");
        return false;
    }
    if (!check(esp_wifi_start(), "esp_wifi_start")) {
        return false;
    }
    // 05 §5.3: modem sleep would delay every frame to the next DTIM (mains-powered nodes).
    check(esp_wifi_set_ps(WIFI_PS_NONE), "esp_wifi_set_ps");
#if CONFIG_FR_WIFI_MAX_TX_POWER_QDBM > 0
    // Board manifest rf.max_tx_power_qdbm: valid only after esp_wifi_start().
    if (check(esp_wifi_set_max_tx_power(CONFIG_FR_WIFI_MAX_TX_POWER_QDBM), "esp_wifi_set_max_tx_power")) {
        ESP_LOGI(TAG, "wifi: TX power capped at %d.%02d dBm", CONFIG_FR_WIFI_MAX_TX_POWER_QDBM / 4,
                 CONFIG_FR_WIFI_MAX_TX_POWER_QDBM % 4 * 25);
    }
#endif

    uint8_t sta[6];
    if (esp_wifi_get_mac(WIFI_IF_STA, sta) == ESP_OK && std::memcmp(sta, settings.mac, sizeof(sta)) != 0) {
        // 06 §6.3: device_id is the STA MAC; the hub keys TCP/serial sessions and the directory by it.
        ESP_LOGE(TAG, "STA MAC %02x%02x%02x%02x%02x%02x is not the device id", sta[0], sta[1], sta[2], sta[3], sta[4],
                 sta[5]);
    }
    if (settings.creds.ssid[0] == '\0') {
        ESP_LOGW(TAG, "wifi: no network provisioned; not joining");
    }
    s_started = true;
    return true;
}

Link &tcp_link()
{
    return s_tcp;
}

Link &udp_link()
{
    return s_udp;
}

LinkInfo link_info()
{
    return s_wifi.link_info();
}

Status status()
{
    Status s;
    s.started = s_started;
    s_wifi.fill(s);
    s_hub.fill(s);
    return s;
}

fr::Status net_set(const fr_net_creds_t &creds)
{
    if (!s_started) {
        return std::unexpected(Err::failed);
    }
    if (!s_wifi.request_override(creds, now_us())) {
        return std::unexpected(Err::busy);
    }
    return {};
}

}  // namespace fr::net::esp
