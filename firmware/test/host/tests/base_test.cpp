// fr::Callback storage semantics, fr::Status codes and the capability base classes.
#include "fr/base.hpp"
#include "fr/cap/capability.hpp"
#include "tests/test.hpp"

namespace {

// Counts live instances, so leaks and double destructions in Callback show up.
struct Probe {
    static inline int live = 0;
    int *hits;
    explicit Probe(int *h) : hits(h) { ++live; }
    Probe(const Probe &o) : hits(o.hits) { ++live; }
    Probe(Probe &&o) noexcept : hits(o.hits) { ++live; }
    ~Probe() { --live; }
    void operator()() const { ++*hits; }
};

}  // namespace

TEST(callback_calls_copies_moves_and_destroys)
{
    int hits = 0;
    {
        fr::Callback<void()> a{Probe(&hits)};
        CHECK(static_cast<bool>(a));
        a();
        fr::Callback<void()> b = a;
        b();
        fr::Callback<void()> c = std::move(a);
        CHECK(!a);
        c();
        a = c;
        a();
        c = nullptr;
        CHECK(!c);
        CHECK_EQ(Probe::live, 2);
    }
    CHECK_EQ(hits, 4);
    CHECK_EQ(Probe::live, 0);
}

TEST(callback_forwards_arguments_and_results)
{
    int base = 10;
    fr::Callback<int(int, const int &)> add = [base](int a, const int &b) { return base + a + b; };
    CHECK_EQ(add(1, 2), 13);
    fr::Callback<int(int, const int &)> empty;
    CHECK_EQ(empty(1, 2), 0);
    int counter = 0;
    fr::Callback<void(), 32> bump = [&counter, n = 0]() mutable { counter += ++n; };
    const auto &cref = bump;
    cref();
    cref();
    CHECK_EQ(counter, 3);
}

TEST(status_wire_codes)
{
    CHECK_EQ(fr::wire_status(fr::Status{}), 0);
    CHECK_EQ(fr::wire_status(std::unexpected(fr::Err::invalid_args)), 2);
    CHECK_EQ(fr::wire_status(std::unexpected(fr::Err::not_found)), 8);
    CHECK_EQ(fr::err_name(fr::Err::not_provisioned), "not_provisioned");
}

namespace {

struct RecordingSink final : fr::cap::Sink {
    uint8_t port = 0;
    uint8_t id = 0;
    size_t len = 0;
    fr::TimeUs at = 0;
    void event(uint8_t p, uint8_t e, fr::cap::Priority, std::span<const uint8_t> f, fr::TimeUs t, bool) override
    {
        port = p;
        id = e;
        len = f.size();
        at = t;
    }
    void property(uint8_t, uint8_t, std::span<const uint8_t>, fr::TimeUs) override {}
};

struct Dummy final : fr::cap::Capability {
    uint16_t cap_id() const override { return 0x8000; }
    fr::cap::Version version() const override { return {1, 2}; }
    const char *type_name() const override { return "test.dummy"; }
    fr::Status dispatch(uint8_t cmd_id, std::span<const uint8_t>, fr::cap::Reply &reply) override
    {
        if (cmd_id != 1) {
            return std::unexpected(fr::Err::unsupported);
        }
        reply.fields().field_uint(1, 42);
        return {};
    }
    void report_all() override {}
    void encode_traits(fr::wire::Writer &) const override {}
    void fire() { sink_->event(port_, 3, fr::cap::Priority::realtime, {}, fr::cap::kNowUs); }
};

}  // namespace

TEST(capability_attach_and_reply)
{
    RecordingSink sink;
    Dummy d;
    CHECK_EQ(d.port(), 0xFF);
    d.attach(5, "dummy", sink);
    CHECK_EQ(d.port(), 5);
    CHECK_EQ(d.name(), "dummy");
    d.fire();
    CHECK_EQ(sink.port, 5);
    CHECK_EQ(sink.id, 3);
    CHECK_EQ(sink.at, fr::cap::kNowUs);

    fr::cap::StaticReply<> reply;
    CHECK(d.dispatch(1, {}, reply).has_value());
    CHECK_BYTES(reply.bytes(), frt::from_hex("08 2a"));
    CHECK_EQ(d.dispatch(9, {}, reply).error(), fr::Err::unsupported);
    CHECK_EQ(fr::cap::Reply::kRealtimeCapacity, 200);
    CHECK_EQ(reply.capacity(), 200);
    CHECK_EQ(fr::cap::Reply::kBulkCapacity, 1445);
}
