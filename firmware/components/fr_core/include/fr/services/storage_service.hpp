// L2 storage service (spec 07 §7.3, §7.7-7.8; design lcd-clock-c1 D5, D6): fr.storage over any hal::FileStore.
// Host-buildable.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <expected>
#include <string_view>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/core/worker.hpp"
#include "fr/hal/file_store.hpp"
#include "storage.hpp"  // generated fr::cap::Storage

namespace fr {

/**
 * Commands on the core task; the slow parts on fr_worker (design D5-D6, as built). The card's file I/O runs in command
 * dispatch, one chunk (at most config chunk, 1 KB) or one directory page (16 entries) per command, so a command holds
 * the core task for that one bounded operation (a 1 KB read is a few ms at 20 MHz SPI). The mount (a card's init can
 * take seconds with no card) and the free-space walk (seconds on a large card with a stale FSINFO) run on fr_worker:
 * while one runs, `busy` is true and every command answers BUSY; a 20 ms timer collects the result.
 *
 * Every path is checked first: absolute ("/" is the card's root), ASCII 0x20-0x7E, at most kMaxPath bytes, no "." or
 * ".." segment, no backslash, no empty segment; anything else is INVALID_ARGS before the card is touched.
 *
 * Mount: at init when config mount_on_boot (in the background); `info` with no card starts one and answers BUSY while
 * it runs, then the state it reached (an attempt that ended under kRetryUs ago is not repeated: `info` answers its
 * state); `remount` unmounts and starts one, answering the state at once (none) with `mounted` to follow. A card
 * operation that fails with Err::failed while the card no longer answers (hal::FileStore::card_alive) is taken for a
 * removed card (no card-detect switch on the C6-LCD-1.47): the store is unmounted, `unmounted {removed}` fires, the
 * state goes none and the command answers FAILED. Any other failure answers its error and leaves the card mounted.
 *
 * Sizes: total_mb and free_mb come from the mount and from a background refresh after writes, removes and renames, at
 * most every kFreeRefreshUs; `info` answers the cached ones (and starts a refresh when they are older than that).
 */
class StorageService final : public cap::Storage
{
public:
    StorageService(hal::FileStore &store, const cap::StorageConfig &cfg);

    /** Err::invalid_args for a config codegen should have refused (max_files 0, chunk outside 128-1024). */
    Status init(Core &core);
    hal::Selftest selftest();

    std::expected<cap::StorageInfoResult, Err> info() override;
    std::expected<cap::StorageListResult, Err> list(const cap::StorageListArgs &args) override;
    std::expected<cap::StorageStatResult, Err> stat(const cap::StorageStatArgs &args) override;
    std::expected<cap::StorageReadResult, Err> read(const cap::StorageReadArgs &args) override;
    std::expected<cap::StorageWriteResult, Err> write(const cap::StorageWriteArgs &args) override;
    Status remove(const cap::StorageRemoveArgs &args) override;
    Status mkdir(const cap::StorageMkdirArgs &args) override;
    Status rename(const cap::StorageRenameArgs &args) override;
    std::expected<cap::StorageRemountResult, Err> remount() override;

    cap::StorageStoreState state() const override { return state_; }
    uint32_t total_mb() const override { return total_mb_; }
    uint32_t free_mb() const override { return free_mb_; }
    cap::StorageCardType card_type() const override { return card_type_; }
    bool busy() const override { return busy_; }
    cap::StorageTraits traits() const override { return traits_; }

    static constexpr size_t kMaxPath = 96;
    static constexpr size_t kMaxEntries = 16;
    static constexpr TimeUs kFreeRefreshUs = 10'000'000;
    static constexpr TimeUs kRetryUs = 3'000'000;
    static constexpr TimeUs kJobPollUs = 20'000;

    /** The task the mount and the free-space walk run on (the target's fr_worker by default; host tests a FakeWorker).
     *  None: they run inline (the host suite's simple rigs). */
    void use_worker(Worker *w) { worker_ = w; }

    /** A path the service accepts (see the class comment); `root` allows "/" itself (list, stat). */
    static bool valid_path(std::string_view p, bool root);

private:
    enum class Job : uint8_t { none, mount, refresh };
    /** Starts `j` on the worker (inline without one); false when one runs already. */
    bool start_job(Job j);
    /** On the worker: the job's card work, results into job_*; then job_done_. */
    void run_job();
    /** On the core task: the finished job's results applied. */
    void finish_job();
    /** A failed operation on a mounted card: unmount, `unmounted {removed}`, state none. */
    void lost_card();
    void set_state(cap::StorageStoreState s);
    void set_busy(bool b);
    void apply_sizes(const hal::CardInfo &info);
    /** Schedules a free-space refresh (at most every kFreeRefreshUs). */
    void touched();
    void on_timer();
    /** `p` into path_ (NUL-terminated) after valid_path; Err::invalid_args otherwise. */
    Status take_path(std::string_view p, bool root, std::array<char, kMaxPath + 1> &out) const;
    /** The error a store failure answers: Err::failed with a card that no longer answers takes the card; others pass. */
    Err fail(Err e);
    /** Mounted and not busy: OK; Err::busy while a job runs, Err::failed with no card. */
    Status need_card() const;

    hal::FileStore &store_;
    cap::StorageConfig cfg_;
    cap::StorageTraits traits_{};
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    cap::StorageStoreState state_ = cap::StorageStoreState::none;
    cap::StorageCardType card_type_ = cap::StorageCardType::unknown;
    uint32_t total_mb_ = 0;
    uint32_t free_mb_ = 0;
    TimeUs last_refresh_ = 0;
    bool refresh_pending_ = false;
    TimeUs mount_tried_at_ = 0;  // when the last mount attempt ended (0: none yet)
    Worker *worker_ = nullptr;
    // The background job: set on the core task before it starts, written by the worker, read after job_done_.
    Job job_ = Job::none;
    bool busy_ = false;
    std::atomic<bool> job_done_{false};
    Status job_status_{};
    hal::CardInfo job_info_{};
    bool job_info_ok_ = false;
    hal::CardInfo card_{};
    std::array<char, kMaxPath + 1> path_{};
    std::array<char, kMaxPath + 1> path2_{};
    std::array<hal::FileEntry, kMaxEntries> entries_{};
    hal::FileEntry one_{};
    std::array<uint8_t, 1024> buf_{};
};

}  // namespace fr
