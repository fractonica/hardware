// fr::ota::Ota (design c4 §3, spec 06 §6.6). Two halves share this object: the core task (frames, health
// bits, timers, everything that talks to Net) and fr_worker (HTTP, the slot, otadata, nvs:fr_ota). They
// meet only at the mailbox atomics and the worker queue, so neither ever waits for the other. The core
// task owns the job's state; fr_worker owns `dl_` from the first step of a download until it stores the
// job's end, and the core task never starts another job before it has read that end.
#include "fr/ota/ota.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "fr/ota/check.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"  // generated fr::proto OTA bodies

namespace fr::ota {
namespace {

namespace proto = fr::proto;

/** A fixed char array up to its NUL. */
template <size_t N>
std::string_view view(const char (&s)[N])
{
    const void *nul = std::memchr(s, '\0', N);
    return {s, nul != nullptr ? static_cast<size_t>(static_cast<const char *>(nul) - s) : N};
}

template <size_t N>
void copy(char (&dst)[N], std::string_view s)
{
    const size_t n = std::min(s.size(), N - 1);
    std::memcpy(dst, s.data(), n);
    std::memset(dst + n, 0, N - n);
}

/** Encodes `m` into `buf`; empty on overflow (cannot happen: every body fits its kMaxSize). */
template <class Msg>
std::span<const uint8_t> encode_into(const Msg &m, std::span<uint8_t> buf)
{
    fr::wire::Writer w(buf);
    encode(m, w);
    return w.overflow() ? std::span<const uint8_t>{} : w.bytes();
}

template <class Msg>
Status send_msg(Host &host, uint8_t kind, const Msg &m, bool ack_req = false)
{
    uint8_t buf[Msg::kMaxSize];
    return host.send(kind, encode_into(m, buf), ack_req);
}

template <class Msg>
void reply_msg(net::OtaReply &reply, uint8_t kind, const Msg &m)
{
    uint8_t buf[Msg::kMaxSize];
    reply.set(kind, encode_into(m, buf));
}

}  // namespace

// ---------------------------------------------------------------------------------------------------
// Core task
// ---------------------------------------------------------------------------------------------------

bool Ota::bind(const Deps &deps)
{
    if (bound_) {
        return true;
    }
    if (deps.core == nullptr || deps.worker == nullptr || deps.flash == nullptr || deps.fetch == nullptr ||
        deps.store == nullptr || deps.host == nullptr) {
        return false;
    }
    d_ = deps;
    timer_ = d_.core->timer([this] { on_timer(); });
    bound_ = timer_ != nullptr;
    return bound_;
}

void Ota::on_boot()
{
    if (!bound_) {
        return;
    }
    info_ = d_.flash->running();
    pending_ = info_.pending_verify;
    have_rec_ = d_.store->load(rec_);
    // The record belongs to the running image when the job that wrote it installed this fw_id.
    const bool ours = have_rec_ && rec_.fw_id == info_.fw_id;
    if (pending_) {
        // 06 §6.6: HUB_ACK only when the hub was reachable before the update; otherwise a hub outage would
        // roll back every node.
        required_ = kHealthCore | kHealthCaps | kHealthNet;
        if (ours && rec_.hub_seen) {
            required_ |= kHealthHubAck;
        }
        deadline_at_ = d_.core->now() + static_cast<TimeUs>(d_.health_deadline_ms) * 1000;
        report_ = ours ? Report::success_when_valid : Report::none;
    } else if (ours && rec_.state == RecState::installed) {
        // Marked valid in an earlier boot that ended before its RESULT went out.
        report_ = Report::success;
    } else if (have_rec_ && !ours && rec_.state != RecState::download && info_.has_last_invalid &&
               info_.last_invalid_fw_id == rec_.fw_id) {
        // design c4 §3: the stored job's image is the last invalid one and this is not it. The state says
        // whether that image gave up itself; otherwise the reset that ended its boot says what happened.
        report_ = Report::rolled_back;
        rollback_reason_ = rec_.state == RecState::health_timeout ? RollbackReason::health_timeout
                           : info_.crashed                        ? RollbackReason::crash
                                                                  : RollbackReason::unknown;
    }
    // Anything else is a download to resume, or a stale record the next job replaces.
    arm();
}

void Ota::on_frame(uint8_t kind, std::span<const uint8_t> body, net::OtaReply &reply)
{
    if (!bound_) {
        return;
    }
    switch (kind) {
    case proto::kKindOtaOffer:
        on_offer(body, reply);
        break;
    case proto::kKindOtaCommit:
        on_commit(body);
        break;
    case proto::kKindOtaAbort:
        on_abort(body);
        break;
    default:
        break;  // ACCEPT, REJECT, STATUS, RESULT go to the hub; CHUNK is ESP-NOW relay OTA (M2)
    }
    arm();
}

void Ota::on_offer(std::span<const uint8_t> body, net::OtaReply &reply)
{
    auto o = proto::decode_ota_offer(body);
    if (!o || o->job_id.empty()) {
        return;  // nothing to answer to
    }
    auto reject = [&](Reject r) {
        reply_msg(reply, proto::kKindOtaReject, proto::OtaReject{.job_id = o->job_id, .code = static_cast<uint8_t>(r)});
    };
    if (job_.phase != JobPhase::idle) {
        // An ABORTed job still winding down on fr_worker is busy to any OFFER, its own job_id's included:
        // the hub re-offers a job under the same id, and an ACCEPT from the aborted attempt would promise a
        // download that never comes.
        if (job_.phase != JobPhase::aborting && matches(o->job_id)) {
            // The hub sent this job's OFFER again (its ACCEPT got lost, or never left): the same answer, once
            // CHECK has one.
            if (w_check_.load(std::memory_order_acquire) == kCheckOk) {
                reply_msg(reply, proto::kKindOtaAccept,
                          proto::OtaAccept{.job_id = o->job_id, .code = w_code_.load(std::memory_order_relaxed)});
                if (!job_.accept_sent) {
                    accepted();
                }
            }
            return;
        }
        reject(Reject::busy);
        return;
    }
    if (o->fw_id.size() != 32) {
        reject(Reject::bad_image);
        return;
    }
    // IDF refuses an update while the running image is unconfirmed, and a rollback or mark-valid in flight
    // is the same window.
    if (pending_ || ((ops_ | inflight_) & (kOpMarkValid | kOpRollback)) != 0) {
        reject(Reject::busy);
        return;
    }
    const std::span<const uint8_t, 32> fw(o->fw_id.data(), 32);
    if (auto r = check_offer(fw, o->size, o->flags, info_)) {
        reject(*r);
        return;
    }
    Endpoint ep;
    if (!d_.host->endpoint(ep)) {
        reject(Reject::busy);  // no TCP session to download over (an OFFER over serial with Wi-Fi down)
        return;
    }

    // The worker's half; it is idle (the previous job's end has been read).
    dl_ = Download{};
    std::memcpy(dl_.fw.data(), fw.data(), 32);
    dl_.size = o->size;
    dl_.flags = o->flags;
    char hex[65];
    for (size_t i = 0; i < 32; ++i) {
        std::snprintf(hex + 2 * i, 3, "%02x", fw[i]);
    }
    std::snprintf(dl_.url, sizeof(dl_.url), "http://%s:%u/ota/%s.bin", ep.host, static_cast<unsigned>(ep.port), hex);
    copy(dl_.rec.job_id, o->job_id);
    dl_.rec.fw_id = dl_.fw;
    dl_.rec.size = o->size;
    dl_.rec.slot = info_.slot_addr;
    dl_.rec.hub_seen = true;  // the OFFER came from the hub over a session
    dl_.rec.state = RecState::download;
    w_bytes_.store(0, std::memory_order_relaxed);
    w_check_.store(kCheckPending, std::memory_order_relaxed);
    w_code_.store(0, std::memory_order_relaxed);
    w_reason_.store(0, std::memory_order_relaxed);
    w_end_.store(kEndRunning, std::memory_order_relaxed);
    cancel_.store(false, std::memory_order_relaxed);
    // Posting orders everything above before the first step (the queue's lock).
    if (!d_.worker->post([this] { step(); })) {
        reject(Reject::busy);
        return;
    }
    job_ = Job{};
    job_.phase = JobPhase::checking;
    copy(job_.id, o->job_id);
    job_.fw = dl_.fw;
    job_.size = o->size;
    // The job rewrites nvs:fr_ota: an earlier job's report still goes out, but must not clear the record.
    rec_replaced_ = true;
    ops_ &= static_cast<uint8_t>(~kOpClear);
}

void Ota::on_commit(std::span<const uint8_t> body)
{
    auto c = proto::decode_ota_commit(body);
    if (!c || job_.phase != JobPhase::staged || !matches(c->job_id)) {
        return;
    }
    job_.phase = JobPhase::committing;
    ops_ |= kOpCommit;
    post_ops();
}

void Ota::on_abort(std::span<const uint8_t> body)
{
    auto a = proto::decode_ota_abort(body);
    if (!a || !matches(a->job_id)) {
        return;
    }
    switch (job_.phase) {
    case JobPhase::checking:
    case JobPhase::downloading:
        // The worker sees it at its next step; the job ends when it says so.
        cancel_.store(true, std::memory_order_release);
        job_.phase = JobPhase::aborting;
        break;
    case JobPhase::staged:
        finish_job();  // verified but not the boot partition: the slot stays as it is, never booted
        break;
    default:
        break;  // committing and rebooting are past the point of no return; aborting already is
    }
}

bool Ota::matches(std::string_view job_id) const
{
    return job_.phase != JobPhase::idle && job_id == view(job_.id);
}

void Ota::health_set(uint32_t bits)
{
    if (!bound_) {
        return;
    }
    if (d_.fault_health) {
        bits &= ~kHealthCaps;  // 03 §3.8: a fault build never passes its health gate
    }
    health_ |= bits;
    if ((bits & kHealthHubAck) != 0) {
        hub_acked_ = true;
    }
    maybe_valid();
    post_ops();
    try_report();
    arm();
}

void Ota::maybe_valid()
{
    if (pending_ && !deadline_expired_ && !valid_failed_ && ((ops_ | inflight_) & (kOpMarkValid | kOpRollback)) == 0 &&
        (health_ & required_) == required_) {
        ops_ |= kOpMarkValid;
    }
}

void Ota::on_timer()
{
    const TimeUs now = d_.core->now();
    if (deadline_at_ != kNever && now >= deadline_at_) {
        deadline_at_ = kNever;
        on_deadline();
    }
    if (tick_at_ != kNever && now >= tick_at_) {
        tick_at_ = kNever;  // arm() sets the next one while something still waits
    }
    sync();
}

void Ota::on_deadline()
{
    if (!pending_) {
        return;
    }
    // A mark-valid already on the worker decides: valid, or this rollback after all (sync()).
    deadline_expired_ = true;
    ops_ &= static_cast<uint8_t>(~kOpMarkValid);
    if ((inflight_ & kOpMarkValid) == 0) {
        ops_ |= kOpRollback;
    }
    post_ops();
}

void Ota::sync()
{
    if (!bound_) {
        return;
    }
    if (job_.phase != JobPhase::idle) {
        sync_job();
    }
    if ((inflight_ & kOpMarkValid) != 0) {
        const uint8_t v = w_valid_.load(std::memory_order_acquire);
        if (v != kValidNone) {
            inflight_ &= static_cast<uint8_t>(~kOpMarkValid);
            w_valid_.store(kValidNone, std::memory_order_relaxed);
            if (v == kValidOk) {
                pending_ = false;
                deadline_at_ = kNever;
                if (report_ == Report::success_when_valid) {
                    report_ = Report::success;
                }
            } else {
                // Not retried: otadata that refuses the write once is no place to keep trying; the
                // deadline rolls the image back (at once when it already ran out).
                valid_failed_ = true;
                if (deadline_expired_) {
                    ops_ |= kOpRollback;
                }
            }
        }
    }
    maybe_valid();
    post_ops();
    try_report();
    arm();
}

void Ota::accepted()
{
    job_.accept_sent = true;
    job_.status_at = d_.core->now();
    job_.status_bytes = w_bytes_.load(std::memory_order_relaxed);
    if (job_.phase == JobPhase::checking) {
        job_.phase = JobPhase::downloading;
    }
}

void Ota::sync_job()
{
    // Level-triggered: whatever is not out yet goes at the next poke or tick (a session may come back), and
    // a re-sent OFFER is answered from the mailbox meanwhile. A job ABORTed before its ACCEPT left gets none.
    if (job_.phase != JobPhase::aborting && !job_.accept_sent && w_check_.load(std::memory_order_acquire) == kCheckOk) {
        const proto::OtaAccept a{.job_id = view(job_.id), .code = w_code_.load(std::memory_order_relaxed)};
        if (send_msg(*d_.host, proto::kKindOtaAccept, a)) {
            accepted();
        }
    }
    const uint8_t end = w_end_.load(std::memory_order_acquire);
    if (end != job_.seen_end) {
        job_.seen_end = end;
        // design c4 §3: an ABORTed job gets no answer. The worker may have ended it some other way before it
        // saw the cancel; the hub has given that attempt up, and its next one reuses the job_id.
        const bool aborted = job_.phase == JobPhase::aborting;
        switch (end) {
        case kEndRejected:
            if (!aborted) {
                send_msg(*d_.host, proto::kKindOtaReject,
                         proto::OtaReject{.job_id = view(job_.id), .code = w_code_.load(std::memory_order_relaxed)});
            }
            finish_job();
            return;
        case kEndStaged:
            if (aborted) {
                finish_job();  // verified but not the boot partition, as on_abort's staged case
                return;
            }
            job_.phase = JobPhase::staged;
            break;
        case kEndBootSet:
            // 06 §6.6: the RESULT comes from the new image after the reboot. An ABORT that arrived while
            // fr_worker was already setting the boot partition (past its last cancel check) cannot be
            // honoured: the node says so with STATUS rebooting and boots the image.
            job_.phase = JobPhase::rebooting;
            send_status(Phase::rebooting, job_.size);
            d_.host->restart();
            return;
        case kEndFailed: {
            if (aborted) {
                finish_job();
                return;
            }
            const proto::OtaResult r{.job_id = view(job_.id),
                                     .outcome = static_cast<uint8_t>(Outcome::failed),
                                     .fw_id_prefix = std::span<const uint8_t>(job_.fw.data(), 8),
                                     .reason = w_reason_.load(std::memory_order_relaxed)};
            send_msg(*d_.host, proto::kKindOtaResult, r, true);
            finish_job();
            return;
        }
        case kEndAborted:
            finish_job();  // the hub asked: it needs no answer
            return;
        default:
            return;
        }
    }
    if (job_.phase == JobPhase::staged && job_.accept_sent && !job_.staged_sent) {
        job_.staged_sent = static_cast<bool>(send_status(Phase::staged, job_.size));
        return;
    }
    if (job_.phase == JobPhase::downloading && job_.accept_sent) {
        // 06 §6.7: progress at least every 5 % or 1 s; the hub's stall timer reads `bytes`.
        const uint32_t bytes = w_bytes_.load(std::memory_order_relaxed);
        const TimeUs now = d_.core->now();
        const uint32_t step = std::max<uint32_t>(job_.size / 20, 1);
        if (now - job_.status_at >= static_cast<TimeUs>(kStatusMs) * 1000 || bytes - job_.status_bytes >= step) {
            if (send_status(Phase::downloading, bytes)) {
                job_.status_at = now;
                job_.status_bytes = bytes;
            }
        }
    }
}

Status Ota::send_status(Phase phase, uint32_t bytes)
{
    return send_msg(*d_.host, proto::kKindOtaStatus,
                    proto::OtaStatus{.job_id = view(job_.id), .state = static_cast<uint8_t>(phase), .bytes = bytes});
}

void Ota::finish_job()
{
    job_ = Job{};
}

void Ota::post_ops()
{
    // Ops with an outcome to wait for move to inflight_; a full worker queue leaves them for the next sync.
    if ((ops_ & kOpMarkValid) != 0 && d_.worker->post([this] { op_mark_valid(); })) {
        ops_ &= static_cast<uint8_t>(~kOpMarkValid);
        inflight_ |= kOpMarkValid;
    }
    if ((ops_ & kOpRollback) != 0) {
        const bool ours = have_rec_ && rec_.fw_id == info_.fw_id && !rec_replaced_;
        if (d_.worker->post([this, ours] { op_rollback(ours); })) {
            ops_ &= static_cast<uint8_t>(~kOpRollback);
            inflight_ |= kOpRollback;  // nothing comes back unless it failed, so no OFFER either
        }
    }
    if ((ops_ & kOpCommit) != 0 && d_.worker->post([this] { op_commit(); })) {
        ops_ &= static_cast<uint8_t>(~kOpCommit);
    }
    if ((ops_ & kOpClear) != 0 && d_.worker->post([this] { d_.store->clear(); })) {
        ops_ &= static_cast<uint8_t>(~kOpClear);
    }
}

void Ota::try_report()
{
    if (!hub_acked_ || (report_ != Report::success && report_ != Report::rolled_back)) {
        return;  // design c4 §3: RESULTs about an earlier boot's job go after the first WELCOME
    }
    const bool rolled_back = report_ == Report::rolled_back;
    const proto::OtaResult r{
        .job_id = view(rec_.job_id),
        .outcome = static_cast<uint8_t>(rolled_back ? Outcome::rolled_back : Outcome::success),
        .fw_id_prefix = std::span<const uint8_t>(rec_.fw_id.data(), 8),
        .reason = static_cast<uint8_t>(rolled_back ? rollback_reason_ : RollbackReason{0}),
    };
    // Q1: the hub ACKs it. Sent once: the record is cleared behind it, so a later boot does not repeat it.
    if (send_msg(*d_.host, proto::kKindOtaResult, r, true)) {
        report_ = Report::none;
        if (!rec_replaced_) {
            ops_ |= kOpClear;
            post_ops();
        }
    }
}

void Ota::arm()
{
    if (timer_ == nullptr) {
        return;
    }
    // A staged job waits for the hub, not the worker: it ticks only while its ACCEPT or STATUS is not out.
    const bool waiting = job_.phase == JobPhase::checking || job_.phase == JobPhase::downloading ||
                         job_.phase == JobPhase::committing || job_.phase == JobPhase::aborting ||
                         (job_.phase == JobPhase::staged && (!job_.accept_sent || !job_.staged_sent));
    const bool reporting = hub_acked_ && (report_ == Report::success || report_ == Report::rolled_back);
    const TimeUs now = d_.core->now();
    if (waiting || reporting || ops_ != 0 || (inflight_ & kOpMarkValid) != 0) {
        if (tick_at_ == kNever) {
            tick_at_ = now + static_cast<TimeUs>(kStatusMs) * 1000;
        }
    } else {
        tick_at_ = kNever;
    }
    const TimeUs next = std::min(deadline_at_, tick_at_);
    if (next == kNever) {
        timer_->stop();
        return;
    }
    timer_->start(static_cast<uint32_t>(std::max<TimeUs>(next - now, 0)));
}

// ---------------------------------------------------------------------------------------------------
// fr_worker
// ---------------------------------------------------------------------------------------------------

void Ota::poke()
{
    d_.core->post([this] { sync(); });
}

void Ota::step()
{
    for (;;) {
        if (!run_step()) {
            return;
        }
        // One step per worker job, so other slow work (NVS writes) interleaves with a long download; a
        // queue full of it must not stall the download, though.
        if (d_.worker->post([this] { step(); })) {
            return;
        }
    }
}

bool Ota::run_step()
{
    if (cancel_.load(std::memory_order_acquire)) {
        close_all();
        end(kEndAborted);
        return false;
    }
    switch (dl_.stage) {
    case Download::Stage::prepare:
        return prepare();
    case Download::Stage::connect:
        return connect();
    case Download::Stage::head:
        return head();
    case Download::Stage::body:
        return body();
    case Download::Stage::finish:
        return finish();
    }
    return false;
}

bool Ota::prepare()
{
    Download &w = dl_;
    Record stored;
    const bool resumable = d_.store->load(stored) && stored.state == RecState::download && stored.fw_id == w.fw &&
                           stored.size == w.size && stored.slot == info_.slot_addr && stored.off >= kCheckBytes &&
                           stored.off < w.size && stored.off % kChunk == 0;
    if (resumable && d_.flash->read(0, std::span<uint8_t>(buf_, kCheckBytes))) {
        // 06 §6.6: esp_ota_resume skips the checks esp_ota_begin makes, so CHECK runs again on the
        // descriptors the earlier download left in the slot.
        if (auto r = check_image(std::span<const uint8_t>(buf_, kCheckBytes), w.flags, info_, d_.ident)) {
            return reject(*r);
        }
        if (d_.flash->begin(w.size, stored.off)) {
            w.flash_open = true;
            w.received = w.flashed = w.saved_off = stored.off;
            w.rec.off = stored.off;
            d_.store->save(w.rec);  // this job's id from now on
            w_bytes_.store(w.received, std::memory_order_relaxed);
            w.poked = w.received;
            checked(Accept::resumed);
            w.stage = Download::Stage::connect;
            w.next = Download::Stage::body;
            return true;
        }
        // The slot would not reopen: start over.
    }
    w.stage = Download::Stage::connect;
    w.next = Download::Stage::head;
    return true;
}

bool Ota::connect()
{
    if (!d_.fetch->start(dl_.url, dl_.received)) {
        return retry();
    }
    dl_.fetch_open = true;
    dl_.stage = dl_.next;
    return true;
}

bool Ota::retry()
{
    Download &w = dl_;
    if (w.fetch_open) {
        d_.fetch->close();
        w.fetch_open = false;
    }
    if (w.retries >= kRangeRetries) {
        return fail(FailReason::download);
    }
    // 06 §6.6: within a boot the buffered bytes are kept and the GET continues at `Range: bytes=<received>-`.
    ++w.retries;
    w.next = w.stage == Download::Stage::connect ? w.next : w.stage;
    w.stage = Download::Stage::connect;
    return true;
}

bool Ota::head()
{
    Download &w = dl_;
    auto n = d_.fetch->read(std::span<uint8_t>(buf_ + w.buf_len, kCheckBytes - w.buf_len));
    if (!n || *n == 0) {
        return retry();  // an image is never shorter than kCheckBytes (check_offer): the body was cut
    }
    w.buf_len += *n;
    w.received += static_cast<uint32_t>(*n);
    if (w.buf_len < kCheckBytes) {
        return true;
    }
    if (auto r = check_image(std::span<const uint8_t>(buf_, kCheckBytes), w.flags, info_, d_.ident)) {
        return reject(*r);
    }
    if (!d_.flash->begin(w.size, 0)) {
        return fail(FailReason::flash);
    }
    w.flash_open = true;
    w.rec.off = 0;
    d_.store->save(w.rec);
    w_bytes_.store(w.received, std::memory_order_relaxed);
    checked(Accept::fresh);
    w.stage = Download::Stage::body;
    return true;
}

bool Ota::body()
{
    Download &w = dl_;
    if (w.received < w.size) {
        const size_t want = std::min<size_t>(kChunk - w.buf_len, w.size - w.received);
        auto n = d_.fetch->read(std::span<uint8_t>(buf_ + w.buf_len, want));
        if (!n || *n == 0) {
            return retry();
        }
        w.buf_len += *n;
        w.received += static_cast<uint32_t>(*n);
        w_bytes_.store(w.received, std::memory_order_relaxed);
    }
    if (w.buf_len == kChunk || (w.received == w.size && w.buf_len > 0)) {
        if (!d_.flash->write(std::span<const uint8_t>(buf_, w.buf_len))) {
            return fail(FailReason::flash);
        }
        w.flashed += static_cast<uint32_t>(w.buf_len);
        w.buf_len = 0;
        // 06 §6.6: the resume point every 64 KB, a whole number of 4 KB sectors that are in flash. A failed
        // write is tried again at the next chunk; a resume then just starts a little earlier.
        if (w.received < w.size && w.flashed - w.saved_off >= kResumeStride) {
            const uint32_t off = w.flashed / kChunk * kChunk;
            if (d_.store->save_off(off)) {
                w.saved_off = off;
            }
        }
    }
    const uint32_t step = std::max<uint32_t>(w.size / 20, 1);
    if (w.received - w.poked >= step) {
        w.poked = w.received;
        poke();
    }
    if (w.received == w.size && w.buf_len == 0) {
        w.stage = Download::Stage::finish;
    }
    return true;
}

bool Ota::finish()
{
    Download &w = dl_;
    if (w.fetch_open) {
        d_.fetch->close();
        w.fetch_open = false;
    }
    std::array<uint8_t, 32> sha{};
    const Status st = d_.flash->finish(sha);
    w.flash_open = false;  // esp_ota_end frees the handle whatever it returns
    if (!st || sha != w.fw) {
        // A bad image must not be resumed into: the next OFFER starts over.
        d_.store->save_off(0);
        return fail(!st && st.error() != Err::invalid_args ? FailReason::flash : FailReason::digest);
    }
    // An ABORT that came while the image was verified (esp_ota_end and the partition hash read it all, up
    // to seconds on target) still holds: nothing staged, nothing installed. The resume point stays, so the
    // hub's next attempt continues from it.
    if (cancel_.load(std::memory_order_acquire)) {
        end(kEndAborted);
        return false;
    }
    if ((w.flags & kOfferDeferCommit) != 0) {
        d_.store->save_off(0);
        end(kEndStaged);
        return false;
    }
    return install();
}

bool Ota::install()
{
    // `installed` before the boot partition changes: whichever image boots next finds the record saying
    // which job it is about (success after its health gate, or rolled_back).
    dl_.rec.off = 0;
    dl_.rec.state = RecState::installed;
    d_.store->save(dl_.rec);
    // The last point an ABORT is honoured (only a download's ABORT sets cancel_; COMMIT never sees one).
    if (cancel_.load(std::memory_order_acquire)) {
        d_.store->save_state(RecState::download);
        end(kEndAborted);
        return false;
    }
    if (!d_.flash->set_boot()) {
        d_.store->save_state(RecState::download);
        return fail(FailReason::flash);
    }
    end(kEndBootSet);
    return false;
}

void Ota::op_commit()
{
    install();
}

void Ota::checked(Accept code)
{
    w_code_.store(static_cast<uint8_t>(code), std::memory_order_relaxed);
    w_check_.store(kCheckOk, std::memory_order_release);
    poke();
}

bool Ota::reject(Reject code)
{
    close_all();
    w_code_.store(static_cast<uint8_t>(code), std::memory_order_relaxed);
    w_check_.store(kCheckRejected, std::memory_order_release);
    end(kEndRejected);
    return false;
}

bool Ota::fail(FailReason why)
{
    close_all();
    w_reason_.store(static_cast<uint8_t>(why), std::memory_order_relaxed);
    end(kEndFailed);
    return false;
}

void Ota::close_all()
{
    if (dl_.fetch_open) {
        d_.fetch->close();
        dl_.fetch_open = false;
    }
    if (dl_.flash_open) {
        d_.flash->abort();
        dl_.flash_open = false;
    }
}

void Ota::end(uint8_t what)
{
    // The last touch of dl_ by this job: the core task may start the next job as soon as it reads this.
    w_end_.store(what, std::memory_order_release);
    poke();
}

void Ota::op_mark_valid()
{
    const Status st = d_.flash->mark_valid();
    w_valid_.store(st ? kValidOk : kValidFailed, std::memory_order_release);
    poke();
}

void Ota::op_rollback(bool ours)
{
    // The record says the image gave up by itself (reason health_timeout) for the boot that reports it.
    if (ours) {
        d_.store->save_state(RecState::health_timeout);
    }
    d_.flash->rollback();
    // Only returns when no other image can boot: this one keeps running, PENDING_VERIFY, and refuses
    // OFFERs (busy) until a serial flash recovers it.
}

}  // namespace fr::ota
