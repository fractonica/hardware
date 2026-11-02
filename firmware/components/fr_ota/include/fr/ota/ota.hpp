// The node's OTA job (design c4 §3, spec 06 §6.6): OFFER -> CHECK -> download on fr_worker -> VERIFY ->
// STAGED/COMMIT -> BYE ota and restart, then the health gate and the outcome report on the next boot.
// Owned by fr_core and driven on the core task: Net hands it the hub's OTA frames (Host::ota_frame), and
// fr_core reports the health bits. Everything that blocks or writes flash (HTTP, the slot, otadata,
// nvs:fr_ota) runs on fr_worker; results come back through a mailbox of atomics the core task reads when
// the worker pokes it (Core::post), and at the latest at Ota's own 1 s tick, so a dropped poke only delays.
//
// IDF-free: on target Flash and Store are fr_ota/src/esp, Fetch is HttpGet (src/http) on lwIP, Host is
// fr_core; the host suite runs it on fakes, and fr_net_node on a memory flash and the same HttpGet on POSIX.
#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <string_view>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/core/worker.hpp"
#include "fr/net/net.hpp"
#include "fr/ota/defs.hpp"
#include "fr/ota/fetch.hpp"
#include "fr/ota/flash.hpp"
#include "fr/ota/store.hpp"

namespace fr::ota {

/** Where the node GETs an image (design c4 §3): the hub's address of the current TCP session, not a fresh
 * name lookup, and the hub's node HTTP port. */
struct Endpoint {
    char host[40] = {};  // NUL-terminated (a dotted IPv4 on target)
    uint16_t port = kHttpPort;
};

/** What Ota needs from the runtime: fr_core on target, a fake in tests, fr_net_node in interop. Core task. */
class Host
{
public:
    /** An OTA frame from port 240 to the hub (Net::send_ota): busy without a hub session. */
    virtual Status send(uint8_t kind, std::span<const uint8_t> body, bool ack_req) = 0;
    /** The current TCP session's hub endpoint; false without a TCP session (nothing to download from). */
    virtual bool endpoint(Endpoint &out) = 0;
    /** The new image is the boot partition: BYE ota on every session, then the restart once it has left. */
    virtual void restart() = 0;

protected:
    ~Host() = default;
};

/** Everything Ota runs on; all of it outlives Ota. */
struct Deps {
    Core *core = nullptr;
    Worker *worker = nullptr;
    Flash *flash = nullptr;
    Fetch *fetch = nullptr;
    Store *store = nullptr;
    Host *host = nullptr;
    Ident ident;                // fr_ident's board/profile/part_profile (CHECK identity)
    bool fault_health = false;  // CONFIG_FR_TEST_FAULT_HEALTH (03 §3.8): CAPS is never set
    uint32_t health_deadline_ms = kHealthDeadlineMs;  // tests and fr_net_node shorten it
};

class Ota
{
public:
    Ota() = default;
    Ota(const Ota &) = delete;
    Ota &operator=(const Ota &) = delete;

    /** Takes the dependencies and Ota's one timer from the Core pool (before fr::board::init drains it).
     * False when a dependency is missing or the pool is empty: Ota then ignores every call. */
    bool bind(const Deps &deps);
    /** Boot step 2 (03 §3.5): reads the running image and nvs:fr_ota once; a PENDING_VERIFY image gets its
     * health deadline, and the outcome of the job that installed (or failed to install) an image is queued
     * for the first WELCOME. Before the core task runs is fine: the timer fires once it does. */
    void on_boot();
    /** OFFER, COMMIT, ABORT from Net (port 240, cls OTA). An OFFER is answered through `reply` when the
     * OFFER alone decides (a REJECT; an ACCEPT again for a re-sent OFFER of the running job), else later
     * with Host::send once the image's first kCheckBytes are read. */
    void on_frame(uint8_t kind, std::span<const uint8_t> body, net::OtaReply &reply);
    /** kHealth* bits as the runtime reaches them (HUB_ACK on every WELCOME, which also sends a queued
     * RESULT). All required ones mark a PENDING_VERIFY image valid. */
    void health_set(uint32_t bits);

    /** A job is running: download, staged, installing (HEARTBEAT ota_busy). */
    bool busy() const { return job_.phase != JobPhase::idle; }
    /** The running image is PENDING_VERIFY and not yet marked valid (HELLO ota_state; OFFERs get busy). */
    bool pending_verify() const { return pending_; }
    /** What on_boot() read; fr_core takes the running fw_id from here instead of hashing the image again. */
    const RunningInfo &running() const { return info_; }
    uint32_t health() const { return health_; }
    /** The bits the PENDING_VERIFY image needs; 0 when none is pending. */
    uint32_t required() const { return pending_ ? required_ : 0; }

private:
    static constexpr TimeUs kNever = INT64_MAX;

    // Mailbox values (fr_worker -> core task).
    static constexpr uint8_t kCheckPending = 0;
    static constexpr uint8_t kCheckOk = 1;
    static constexpr uint8_t kCheckRejected = 2;
    static constexpr uint8_t kEndRunning = 0;
    static constexpr uint8_t kEndStaged = 1;
    static constexpr uint8_t kEndBootSet = 2;
    static constexpr uint8_t kEndFailed = 3;
    static constexpr uint8_t kEndAborted = 4;
    static constexpr uint8_t kEndRejected = 5;
    static constexpr uint8_t kValidNone = 0;
    static constexpr uint8_t kValidOk = 1;
    static constexpr uint8_t kValidFailed = 2;

    // Short worker jobs, besides the download (`ops_` waits to post them, `inflight_` for their outcome).
    static constexpr uint8_t kOpMarkValid = 1u << 0;
    static constexpr uint8_t kOpRollback = 1u << 1;
    static constexpr uint8_t kOpClear = 1u << 2;
    static constexpr uint8_t kOpCommit = 1u << 3;

    enum class JobPhase : uint8_t { idle, checking, downloading, staged, committing, rebooting, aborting };
    enum class Report : uint8_t { none, success_when_valid, success, rolled_back };

    /** The job as the core task tracks it. */
    struct Job {
        JobPhase phase = JobPhase::idle;
        char id[24] = {};
        std::array<uint8_t, 32> fw{};
        uint32_t size = 0;
        bool accept_sent = false;
        bool staged_sent = false;  // STATUS staged
        uint8_t seen_end = kEndRunning;
        uint32_t status_bytes = 0;  // `bytes` of the last STATUS
        TimeUs status_at = 0;
    };

    /** The download as fr_worker runs it, one step per worker job. The core task fills it before posting
     * the first step and leaves it alone until the job's end is in the mailbox. */
    struct Download {
        enum class Stage : uint8_t { prepare, connect, head, body, finish };
        Stage stage = Stage::prepare;
        Stage next = Stage::head;  // where connect goes on
        char url[128] = {};
        std::array<uint8_t, 32> fw{};
        uint32_t size = 0;
        uint32_t flags = 0;
        Record rec;               // what this job stores in nvs:fr_ota
        uint32_t received = 0;    // bytes taken from HTTP: the next Range start
        uint32_t flashed = 0;     // bytes written to the slot
        uint32_t saved_off = 0;   // the last `off` stored
        uint32_t poked = 0;       // `received` at the last progress poke
        size_t buf_len = 0;       // bytes in buf_ not yet written
        uint8_t retries = 0;      // Range re-issues so far (kRangeRetries)
        bool fetch_open = false;
        bool flash_open = false;
    };

    // ---- core task ----
    void on_offer(std::span<const uint8_t> body, net::OtaReply &reply);
    void on_commit(std::span<const uint8_t> body);
    void on_abort(std::span<const uint8_t> body);
    void on_timer();
    void on_deadline();
    /** Reads the mailbox and acts: ACCEPT/REJECT, STATUS, RESULT failed, staging, the restart, mark-valid. */
    void sync();
    void sync_job();
    /** The ACCEPT is out (sent, or the reply to a re-sent OFFER): STATUS counts from here. */
    void accepted();
    void maybe_valid();
    void post_ops();
    void try_report();
    void finish_job();
    void arm();
    bool matches(std::string_view job_id) const;
    Status send_status(Phase phase, uint32_t bytes);

    // ---- fr_worker ----
    /** One step of the download, then the next one posted (or run inline when the queue is full). */
    void step();
    /** False once the job's end is in the mailbox: nothing of dl_ may be touched after that. */
    bool run_step();
    bool prepare();
    bool connect();
    bool head();
    bool body();
    bool finish();
    /** Re-issues the GET from `received`, or fails the job after kRangeRetries. */
    bool retry();
    bool install();
    void checked(Accept code);
    bool reject(Reject code);
    bool fail(FailReason why);
    void close_all();
    void end(uint8_t what);
    void op_mark_valid();
    void op_rollback(bool ours);
    void op_commit();
    /** Worker -> core task: run sync() soon. A full core queue is fine: the tick catches up. */
    void poke();

    Deps d_;
    Timer *timer_ = nullptr;
    bool bound_ = false;

    // Read at on_boot(), then constant (fr_worker reads info_ and d_.ident during a job).
    RunningInfo info_;
    Record rec_;  // nvs:fr_ota as this boot found it: what a report is about
    bool have_rec_ = false;

    // Core task.
    Job job_;
    uint32_t health_ = 0;
    uint32_t required_ = 0;
    bool pending_ = false;           // PENDING_VERIFY, not yet marked valid
    bool deadline_expired_ = false;  // the health deadline ran out while a mark-valid was in flight
    bool valid_failed_ = false;      // esp_ota_mark_app_valid_cancel_rollback failed: the deadline decides
    bool hub_acked_ = false;         // a WELCOME arrived this boot: RESULTs can go
    bool rec_replaced_ = false;      // a job of this boot rewrote nvs:fr_ota: a report must not clear it
    Report report_ = Report::none;
    RollbackReason rollback_reason_ = RollbackReason::unknown;
    uint8_t ops_ = 0;
    uint8_t inflight_ = 0;
    TimeUs deadline_at_ = kNever;
    TimeUs tick_at_ = kNever;

    // Mailbox: fr_worker stores (release), the core task loads (acquire).
    std::atomic<uint32_t> w_bytes_{0};
    std::atomic<uint8_t> w_check_{kCheckPending};
    std::atomic<uint8_t> w_code_{0};    // Reject with kCheckRejected, Accept with kCheckOk
    std::atomic<uint8_t> w_end_{kEndRunning};
    std::atomic<uint8_t> w_reason_{0};  // FailReason with kEndFailed
    std::atomic<uint8_t> w_valid_{kValidNone};
    std::atomic<bool> cancel_{false};   // core task -> fr_worker: ABORT

    // fr_worker during a job (and the commit after it).
    Download dl_;
    /** kChunk bytes, from the heap while a download runs (prepare() to end()): never held between OTAs. */
    std::unique_ptr<uint8_t[]> buf_;
};

}  // namespace fr::ota
