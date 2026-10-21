// Vocabulary types shared by every Fractonica component (design c2 §4, decision 1): they live in the
// lowest, IDF-free component so generated fr_caps code and host tests need no ESP-IDF.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <functional>
#include <new>
#include <type_traits>
#include <utility>

namespace fr {

/** Failure codes; the values are the wire status codes (spec 05 §5.7), OK = 0 being the success case. */
enum class Err : uint8_t {
    unsupported = 1,
    invalid_args = 2,
    busy = 3,
    failed = 4,
    not_provisioned = 5,
    late = 6,
    expired = 7,
    not_found = 8,
};

using Status = std::expected<void, Err>;

/** Microseconds on the esp_timer clock (a fake clock in host tests). */
using TimeUs = int64_t;

/** RESULT/ACK status byte for a Status. */
constexpr uint8_t wire_status(const Status &s)
{
    return s ? 0 : static_cast<uint8_t>(s.error());
}

/** Lower-case name as used in diag JSON (`"error":"invalid_args"`). */
constexpr const char *err_name(Err e)
{
    switch (e) {
    case Err::unsupported:
        return "unsupported";
    case Err::invalid_args:
        return "invalid_args";
    case Err::busy:
        return "busy";
    case Err::failed:
        return "failed";
    case Err::not_provisioned:
        return "not_provisioned";
    case Err::late:
        return "late";
    case Err::expired:
        return "expired";
    case Err::not_found:
        return "not_found";
    }
    return "unknown";
}

template <class Sig, size_t N = 24>
class Callback;

/**
 * std::function without the heap: the callable is stored in place (at most N bytes, 8-byte aligned),
 * so posting to the core task or arming a timer never allocates. Copyable; the callable must be too.
 * Calling an empty Callback does nothing and returns R{}.
 */
template <class R, class... Args, size_t N>
class Callback<R(Args...), N>
{
public:
    static constexpr size_t kAlign = 8;

    Callback() = default;
    Callback(std::nullptr_t) {}

    template <class F>
        requires(!std::is_same_v<std::remove_cvref_t<F>, Callback> && std::is_invocable_r_v<R, std::decay_t<F> &, Args...>)
    Callback(F &&f)
    {
        using D = std::decay_t<F>;
        static_assert(sizeof(D) <= N, "callable too large for this Callback's storage");
        static_assert(alignof(D) <= kAlign, "callable over-aligned for Callback storage");
        static_assert(std::is_copy_constructible_v<D>, "Callback needs a copyable callable");
        ::new (static_cast<void *>(buf_)) D(std::forward<F>(f));
        invoke_ = &invoke<D>;
        manage_ = &manage<D>;
    }

    Callback(const Callback &o) { copy_from(o); }

    Callback(Callback &&o) noexcept { move_from(o); }

    Callback &operator=(const Callback &o)
    {
        if (this != &o) {
            reset();
            copy_from(o);
        }
        return *this;
    }

    Callback &operator=(Callback &&o) noexcept
    {
        if (this != &o) {
            reset();
            move_from(o);
        }
        return *this;
    }

    ~Callback() { reset(); }

    explicit operator bool() const { return invoke_ != nullptr; }

    R operator()(Args... args) const
    {
        if (invoke_ == nullptr) {
            if constexpr (std::is_void_v<R>) {
                return;
            } else {
                return R{};
            }
        }
        return invoke_(buf_, std::forward<Args>(args)...);
    }

    void reset()
    {
        if (manage_ != nullptr) {
            manage_(Op::destroy, buf_, nullptr);
        }
        invoke_ = nullptr;
        manage_ = nullptr;
    }

private:
    enum class Op : uint8_t { copy, move, destroy };

    template <class D>
    static R invoke(void *p, Args &&...args)
    {
        return std::invoke(*static_cast<D *>(p), std::forward<Args>(args)...);
    }

    template <class D>
    static void manage(Op op, void *dst, void *src)
    {
        switch (op) {
        case Op::copy:
            ::new (dst) D(*static_cast<const D *>(src));
            break;
        case Op::move:
            ::new (dst) D(std::move(*static_cast<D *>(src)));
            static_cast<D *>(src)->~D();
            break;
        case Op::destroy:
            static_cast<D *>(dst)->~D();
            break;
        }
    }

    void copy_from(const Callback &o)
    {
        if (o.manage_ != nullptr) {
            o.manage_(Op::copy, buf_, o.buf_);
            invoke_ = o.invoke_;
            manage_ = o.manage_;
        }
    }

    void move_from(Callback &o)
    {
        if (o.manage_ != nullptr) {
            o.manage_(Op::move, buf_, o.buf_);
            invoke_ = o.invoke_;
            manage_ = o.manage_;
            o.invoke_ = nullptr;
            o.manage_ = nullptr;
        }
    }

    // mutable: a const Callback may still call a stateful (mutable) lambda, as std::function does.
    alignas(kAlign) mutable unsigned char buf_[N];
    R (*invoke_)(void *, Args &&...) = nullptr;
    void (*manage_)(Op, void *, void *) = nullptr;
};

}  // namespace fr
