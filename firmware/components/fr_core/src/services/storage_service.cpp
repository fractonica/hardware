#include "fr/services/storage_service.hpp"

#include <algorithm>
#include <cstring>

namespace fr {

StorageService::StorageService(hal::FileStore &store, const cap::StorageConfig &cfg) : store_(store), cfg_(cfg)
{
    traits_.removable = store_.removable();
    traits_.card_detect = store_.card_detect();
}

bool StorageService::valid_path(std::string_view p, bool root)
{
    if (p.empty() || p.size() > kMaxPath || p.front() != '/') {
        return false;
    }
    if (p == "/") {
        return root;
    }
    for (char c : p) {
        if (c < 0x20 || c > 0x7E || c == '\\') {
            return false;
        }
    }
    // Segments: none empty (no "//", no trailing "/"), none "." or "..".
    size_t i = 1;
    while (i <= p.size()) {
        const size_t j = std::min(p.find('/', i), p.size());
        const std::string_view seg = p.substr(i, j - i);
        if (seg.empty() || seg == "." || seg == "..") {
            return false;
        }
        i = j + 1;
    }
    return true;
}

Status StorageService::take_path(std::string_view p, bool root, std::array<char, kMaxPath + 1> &out) const
{
    if (!valid_path(p, root)) {
        return std::unexpected(Err::invalid_args);
    }
    std::memcpy(out.data(), p.data(), p.size());
    out[p.size()] = '\0';
    return {};
}

Status StorageService::init(Core &core)
{
    if (auto st = store_.init(core); !st) {
        return st;
    }
    if (cfg_.max_files < 1 || cfg_.max_files > 8 || cfg_.chunk < 128 || cfg_.chunk > buf_.size()) {
        return std::unexpected(Err::invalid_args);
    }
    core_ = &core;
    timer_ = core.timer([this] { on_timer(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
#if defined(ESP_PLATFORM)
    if (worker_ == nullptr) {
        worker_ = &worker::get();
    }
#endif
    if (cfg_.mount_on_boot) {
        (void)start_job(Job::mount);
    }
    return {};
}

hal::Selftest StorageService::selftest()
{
    return store_.selftest();
}

void StorageService::set_state(cap::StorageStoreState s)
{
    if (s != state_) {
        state_ = s;
        report_state(s);
    }
}

void StorageService::set_busy(bool b)
{
    if (b != busy_) {
        busy_ = b;
        report_busy(b);
    }
}

void StorageService::apply_sizes(const hal::CardInfo &info)
{
    card_ = info;
    const auto type = static_cast<cap::StorageCardType>(info.type);
    if (type != card_type_) {
        card_type_ = type;
        report_card_type(type);
    }
    if (info.total_mb != total_mb_) {
        total_mb_ = info.total_mb;
        report_total_mb(total_mb_);
    }
    if (info.free_mb != free_mb_) {
        free_mb_ = info.free_mb;
        report_free_mb(free_mb_);
    }
}

bool StorageService::start_job(Job j)
{
    if (busy_) {
        return false;
    }
    job_ = j;
    job_done_.store(false, std::memory_order_relaxed);
    set_busy(true);
    if (worker_ == nullptr) {
        run_job();
        finish_job();
        return true;
    }
    if (!worker_->post([this] { run_job(); })) {
        // The worker's queue is full: try again at the next timer.
        job_ = Job::none;
        set_busy(false);
        if (j == Job::refresh) {
            refresh_pending_ = false;
            touched();
        }
        return false;
    }
    timer_->start(static_cast<uint32_t>(kJobPollUs));
    return true;
}

void StorageService::run_job()
{
    job_info_ = {};
    job_info_ok_ = false;
    if (job_ == Job::mount) {
        job_status_ = store_.mount(cfg_.max_files);
        if (job_status_) {
            job_info_ok_ = static_cast<bool>(store_.info(job_info_));
        }
    } else if (job_ == Job::refresh) {
        job_status_ = store_.info(job_info_);
        job_info_ok_ = static_cast<bool>(job_status_);
    }
    job_done_.store(true, std::memory_order_release);
}

void StorageService::finish_job()
{
    const Job j = job_;
    job_ = Job::none;
    const TimeUs now = core_ != nullptr ? core_->now() : 0;
    if (j == Job::mount) {
        mount_tried_at_ = now != 0 ? now : 1;
        if (job_status_) {
            set_state(cap::StorageStoreState::mounted);
            if (job_info_ok_) {
                apply_sizes(job_info_);
            }
            last_refresh_ = now;
            set_busy(false);
            emit_mounted({.total_mb = total_mb_, .free_mb = free_mb_});
            return;
        }
        set_state(job_status_.error() == Err::not_found ? cap::StorageStoreState::none : cap::StorageStoreState::error);
    } else if (j == Job::refresh) {
        if (job_info_ok_ && state_ == cap::StorageStoreState::mounted) {
            apply_sizes(job_info_);
        }
        last_refresh_ = now;
        refresh_pending_ = false;
    }
    set_busy(false);
}

void StorageService::lost_card()
{
    store_.unmount();
    set_state(cap::StorageStoreState::none);
    mount_tried_at_ = 0;
    emit_unmounted({.reason = cap::StorageUnmountReason::removed});
}

Err StorageService::fail(Err e)
{
    if (e != Err::failed) {
        return e;
    }
    if (!store_.card_alive()) {
        lost_card();
    }
    return Err::failed;
}

Status StorageService::need_card() const
{
    if (busy_) {
        return std::unexpected(Err::busy);
    }
    if (state_ != cap::StorageStoreState::mounted) {
        return std::unexpected(Err::failed);
    }
    return {};
}

void StorageService::touched()
{
    if (refresh_pending_ || timer_ == nullptr) {
        return;
    }
    refresh_pending_ = true;
    if (busy_) {
        return;  // the job's timer picks it up when the job ends
    }
    const TimeUs now = core_->now();
    const TimeUs due = std::max(now, last_refresh_ + kFreeRefreshUs);
    timer_->start(static_cast<uint32_t>(std::max<TimeUs>(due - now, 1000)));
}

void StorageService::on_timer()
{
    if (job_ != Job::none) {
        if (!job_done_.load(std::memory_order_acquire)) {
            timer_->start(static_cast<uint32_t>(kJobPollUs));
            return;
        }
        finish_job();
    }
    if (refresh_pending_ && state_ == cap::StorageStoreState::mounted) {
        const TimeUs now = core_->now();
        const TimeUs due = last_refresh_ + kFreeRefreshUs;
        if (now >= due) {
            (void)start_job(Job::refresh);
        } else {
            timer_->start(static_cast<uint32_t>(std::max<TimeUs>(due - now, 1000)));
        }
    } else if (state_ != cap::StorageStoreState::mounted) {
        refresh_pending_ = false;
    }
}

std::expected<cap::StorageInfoResult, Err> StorageService::info()
{
    if (busy_) {
        return std::unexpected(Err::busy);
    }
    const TimeUs now = core_->now();
    if (state_ != cap::StorageStoreState::mounted) {
        // No card: one attempt in the background (BUSY while it runs), unless one ended just now.
        if (mount_tried_at_ == 0 || now - mount_tried_at_ >= kRetryUs) {
            if (start_job(Job::mount) && busy_) {
                return std::unexpected(Err::busy);
            }
        }
    } else if (now - last_refresh_ >= kFreeRefreshUs) {
        refresh_pending_ = true;
        (void)start_job(Job::refresh);  // the cached sizes now, the fresh ones in the next reports
    }
    cap::StorageInfoResult r{};
    r.state = state_;
    if (state_ == cap::StorageStoreState::mounted) {
        r.card_type = card_type_;
        r.total_mb = total_mb_;
        r.free_mb = free_mb_;
        r.name = std::string_view(card_.name, ::strnlen(card_.name, sizeof(card_.name)));
        r.speed_khz = card_.speed_khz;
    }
    return r;
}

std::expected<cap::StorageListResult, Err> StorageService::list(const cap::StorageListArgs &args)
{
    if (auto st = take_path(args.path, true, path_); !st) {
        return std::unexpected(st.error());
    }
    if (auto st = need_card(); !st) {
        return std::unexpected(st.error());
    }
    bool more = false;
    const auto n = store_.list(path_.data(), args.offset, entries_, more);
    if (!n) {
        return std::unexpected(fail(n.error()));
    }
    cap::StorageListResult r{};
    for (size_t i = 0; i < *n && i < entries_.size(); ++i) {
        const hal::FileEntry &e = entries_[i];
        r.entries.push_back({.name = std::string_view(e.name, ::strnlen(e.name, sizeof(e.name))),
                             .size = e.size,
                             .dir = e.dir,
                             .mtime = e.mtime});
    }
    r.more = more;
    return r;
}

std::expected<cap::StorageStatResult, Err> StorageService::stat(const cap::StorageStatArgs &args)
{
    if (auto st = take_path(args.path, true, path_); !st) {
        return std::unexpected(st.error());
    }
    if (auto st = need_card(); !st) {
        return std::unexpected(st.error());
    }
    if (std::string_view(path_.data()) == "/") {
        one_ = {};
        one_.name[0] = '/';
        one_.dir = true;
    } else if (auto st = store_.stat(path_.data(), one_); !st) {
        return std::unexpected(fail(st.error()));
    }
    cap::StorageStatResult r{};
    r.entry = {.name = std::string_view(one_.name, ::strnlen(one_.name, sizeof(one_.name))),
               .size = one_.size,
               .dir = one_.dir,
               .mtime = one_.mtime};
    return r;
}

std::expected<cap::StorageReadResult, Err> StorageService::read(const cap::StorageReadArgs &args)
{
    if (auto st = take_path(args.path, false, path_); !st) {
        return std::unexpected(st.error());
    }
    if (args.len > cfg_.chunk) {
        return std::unexpected(Err::invalid_args);
    }
    if (auto st = need_card(); !st) {
        return std::unexpected(st.error());
    }
    const size_t len = args.len == 0 ? cfg_.chunk : args.len;
    bool eof = false;
    const auto n = store_.read(path_.data(), args.offset, std::span<uint8_t>(buf_.data(), len), eof);
    if (!n) {
        return std::unexpected(fail(n.error()));
    }
    cap::StorageReadResult r{};
    r.data = std::span<const uint8_t>(buf_.data(), *n);
    r.eof = eof;
    return r;
}

std::expected<cap::StorageWriteResult, Err> StorageService::write(const cap::StorageWriteArgs &args)
{
    if (auto st = take_path(args.path, false, path_); !st) {
        return std::unexpected(st.error());
    }
    if (args.data.size() > cfg_.chunk) {
        return std::unexpected(Err::invalid_args);
    }
    if (auto st = need_card(); !st) {
        return std::unexpected(st.error());
    }
    const auto size = store_.write(path_.data(), args.offset, args.data, args.truncate);
    if (!size) {
        return std::unexpected(fail(size.error()));
    }
    touched();
    return cap::StorageWriteResult{.size = *size};
}

Status StorageService::remove(const cap::StorageRemoveArgs &args)
{
    if (auto st = take_path(args.path, false, path_); !st) {
        return st;
    }
    if (auto st = need_card(); !st) {
        return st;
    }
    if (auto st = store_.remove(path_.data()); !st) {
        return std::unexpected(fail(st.error()));
    }
    touched();
    return {};
}

Status StorageService::mkdir(const cap::StorageMkdirArgs &args)
{
    if (auto st = take_path(args.path, false, path_); !st) {
        return st;
    }
    if (auto st = need_card(); !st) {
        return st;
    }
    if (auto st = store_.mkdir(path_.data()); !st) {
        return std::unexpected(fail(st.error()));
    }
    return {};
}

Status StorageService::rename(const cap::StorageRenameArgs &args)
{
    if (auto st = take_path(args.from, false, path_); !st) {
        return st;
    }
    if (auto st = take_path(args.to, false, path2_); !st) {
        return st;
    }
    if (auto st = need_card(); !st) {
        return st;
    }
    if (auto st = store_.rename(path_.data(), path2_.data()); !st) {
        return std::unexpected(fail(st.error()));
    }
    touched();
    return {};
}

std::expected<cap::StorageRemountResult, Err> StorageService::remount()
{
    if (busy_) {
        return std::unexpected(Err::busy);
    }
    if (state_ == cap::StorageStoreState::mounted) {
        store_.unmount();
        set_state(cap::StorageStoreState::none);
        emit_unmounted({.reason = cap::StorageUnmountReason::command});
    }
    (void)start_job(Job::mount);
    return cap::StorageRemountResult{.state = state_};
}

}  // namespace fr
