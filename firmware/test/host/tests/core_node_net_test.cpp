// fr_core's C5 glue around Net (design c5 §3, §6 N2; fr/core/node_net.hpp), as the target and fr_net_node
// run it: fr.node bind_set re-encodes its args as the Binding Net stores, bind_list returns them, the
// directory and bindings persist through NetStores (blobs written on fr_worker, the core task never
// waiting, newest table wins), corrupt blobs never load, and the fr::msg handler table and MSG checks.
#include <string>
#include <vector>

#include "fr/core/node_net.hpp"
#include "messages.hpp"
#include "node.hpp"
#include "tests/fake_core.hpp"
#include "tests/fake_worker.hpp"
#include "tests/test.hpp"

namespace {

using fr::net::LinkKind;

class StubHost final : public fr::net::Host
{
public:
    fr::Status dispatch(uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &) override
    {
        return std::unexpected(fr::Err::not_found);
    }
    void report_all() override {}
    fr::net::HelloInfo hello_info() override { return {}; }
    fr::net::Identity identity() override { return {}; }
    fr::net::LinkInfo link_info() override { return {}; }
    fr::net::Vitals vitals() override { return {}; }
    void ota_frame(LinkKind, const fr::wire::Header &, std::span<const uint8_t>, fr::net::OtaReply &) override {}
};

class MemBlob final : public fr::core::Blob
{
public:
    size_t read(std::span<uint8_t> out) override
    {
        if (!present || data.size() > out.size()) {
            return 0;
        }
        std::copy(data.begin(), data.end(), out.begin());
        return data.size();
    }
    bool write(std::span<const uint8_t> bytes) override
    {
        history.emplace_back(bytes.begin(), bytes.end());
        if (fail) {
            return false;
        }
        data.assign(bytes.begin(), bytes.end());
        present = true;
        return true;
    }

    std::vector<uint8_t> data;
    bool present = false;
    bool fail = false;
    std::vector<std::vector<uint8_t>> history;
};

// Binding.nn_boot_down_blink and fr.node.bind_set.args.nn_boot_down_blink (schema/vectors), the same bytes:
// slot 0, on EVENT port 1 kind 1, to a0:b1:... addr 0x34 port 2 CMD 3, payload {count: 1}, reliable.
const char *const kNnBootDownBlink = "1001180320013206a0b1c2d3e4f53834400248045003620218016801";
// Binding.msg_ping_broadcast_pong: slot 15, on MSG "ping", to 0xFFFF MSG "pong" {}.
const char *const kMsgPingPong = "080f18072a0470696e6738ffff0348075a04706f6e6762027b7d";

fr::cap::NodeBindSetArgs args_of(const std::vector<uint8_t> &bytes)
{
    auto a = fr::cap::decode_node_bind_set_args(bytes);
    if (!a) {
        frt::fail(__FILE__, __LINE__, "golden bind_set args do not decode");
        return {};
    }
    return *a;
}

size_t used_slots(const fr::net::Net &net)
{
    size_t n = 0;
    for (const fr::net::BindingSlot &b : net.bindings()) {
        n += b.used ? 1 : 0;
    }
    return n;
}

}  // namespace

TEST(node_net_bind_set_stores_the_args_as_a_binding)
{
    const std::vector<uint8_t> golden = frt::from_hex(kNnBootDownBlink);
    const fr::cap::NodeBindSetArgs args = args_of(golden);
    // to_binding keeps every field: re-encoded, the args are the golden Binding.
    uint8_t buf[fr::proto::Binding::kMaxSize];
    fr::wire::Writer w(buf, sizeof(buf));
    fr::proto::encode(fr::core::to_binding(args), w);
    CHECK_BYTES(w.bytes(), golden);

    frt::FakeCore core;
    StubHost host;
    fr::net::Net net(core, host, fr::net::Config{});
    REQUIRE(fr::core::bind_set(net, args));
    REQUIRE(fr::core::bind_set(net, args_of(frt::from_hex(kMsgPingPong))));
    CHECK_EQ(used_slots(net), 2u);

    uint8_t list_buf[fr::core::kBindListMax];
    auto list = fr::core::bind_list(net, list_buf);
    REQUIRE(list);
    auto decoded = fr::proto::decode_binding_list(list->bindings);
    REQUIRE(decoded);
    REQUIRE_EQ(decoded->items.size(), 2u);
    // Slot order: nn_boot_down_blink is slot 0, msg_ping_broadcast_pong slot 15.
    CHECK_EQ(decoded->items[0].slot, 0);
    CHECK_EQ(decoded->items[0].to_addr, 0x0034);
    CHECK(decoded->items[0].reliable);
    CHECK_EQ(decoded->items[1].slot, 15);
    CHECK_EQ(decoded->items[1].on_topic, "ping");

    CHECK(fr::core::bind_clear(net, fr::cap::NodeBindClearArgs{.slot = 0}));
    CHECK_EQ(used_slots(net), 1u);
    CHECK(fr::core::bind_clear(net, fr::cap::NodeBindClearArgs{.slot = fr::net::kBindSlotAll}));
    CHECK_EQ(used_slots(net), 0u);
    CHECK_EQ(fr::core::bind_clear(net, fr::cap::NodeBindClearArgs{.slot = 16}).error(), fr::Err::invalid_args);
    list = fr::core::bind_list(net, list_buf);
    REQUIRE(list);
    CHECK(list->bindings.empty());
}

TEST(node_net_bindings_and_directory_persist_through_the_worker)
{
    frt::FakeCore core;
    frt::FakeWorker worker;
    StubHost host;
    MemBlob dir_blob;
    MemBlob bind_blob;
    {
        fr::core::NetStores stores(core, worker, dir_blob, bind_blob);
        fr::net::Net net(core, host, fr::net::Config{});
        net.attach_stores(stores.directory(), stores.bindings());
        CHECK_EQ(used_slots(net), 0u);  // nothing stored yet
        REQUIRE(fr::core::bind_set(net, args_of(frt::from_hex(kNnBootDownBlink))));
        // Saved on fr_worker, not on the core task.
        CHECK(bind_blob.history.empty());
        CHECK_EQ(worker.pending(), 1u);
        worker.run_all();
        CHECK_EQ(bind_blob.history.size(), 1u);
        CHECK(stores.bindings_writer().busy());  // until the core task takes the verdict
        core.run_ready();
        CHECK(!stores.bindings_writer().busy());
        CHECK_EQ(stores.bindings_writer().writes(), 1u);

        fr::net::Directory d;
        d.count = 2;
        d.entries[0] = {.addr = 0x0012, .mac = {1, 2, 3, 4, 5, 6}};
        d.entries[1] = {.addr = 0x0034, .mac = {0xa0, 0xb1, 0xc2, 0xd3, 0xe4, 0xf5}};
        stores.save(d);  // as Net does on NET/DIRECTORY (stream N1)
        worker.run_all();
        core.run_ready();
        CHECK_EQ(dir_blob.history.size(), 1u);
    }
    // The next boot.
    fr::core::NetStores stores(core, worker, dir_blob, bind_blob);
    fr::net::Net net(core, host, fr::net::Config{});
    net.attach_stores(stores.directory(), stores.bindings());
    REQUIRE_EQ(used_slots(net), 1u);
    CHECK_BYTES(net.bindings()[0].encoded(), frt::from_hex(kNnBootDownBlink));
    REQUIRE_EQ(net.directory().count, 2u);
    const fr::net::DirEntry *e = net.directory().find(0x0034);
    REQUIRE(e != nullptr);
    CHECK_EQ(e->mac[5], 0xf5);
    CHECK(!stores.directory_writer().holding());  // the boot's read buffers went back to the heap
    CHECK(!stores.bindings_writer().holding());
    // The same directory again (a DIRECTORY after WELCOME): flash already holds it.
    stores.save(net.directory());
    stores.save(net.bindings());
    CHECK_EQ(worker.pending(), 0u);
    CHECK_EQ(stores.directory_writer().skipped(), 1u);
    CHECK_EQ(stores.bindings_writer().skipped(), 1u);
}

TEST(node_net_blob_writer_newest_table_wins_while_a_write_runs)
{
    frt::FakeCore core;
    frt::FakeWorker worker;
    MemBlob blob;
    fr::core::BlobWriter<16> w(core, worker, blob);
    auto table = [](uint8_t v) {
        return [v](std::span<uint8_t> out) {
            out[0] = v;
            return size_t{1};
        };
    };
    CHECK(!w.holding());  // no buffers before a save
    w.save(table(1));
    w.save(table(2));  // the worker has not run yet: buffer 1 is its, this goes to the other
    w.save(table(3));  // replaces 2
    CHECK_EQ(worker.pending(), 1u);
    CHECK(w.holding());
    worker.run_all();
    core.run_ready();  // verdict of 1; 3 goes to the worker
    worker.run_all();
    core.run_ready();
    REQUIRE_EQ(blob.history.size(), 2u);
    CHECK_EQ(blob.history[0][0], 1);
    CHECK_EQ(blob.history[1][0], 3);
    CHECK(!w.busy());
    CHECK_EQ(w.writes(), 2u);
    CHECK(!w.holding());  // back to the heap once nothing is queued
    // The table flash holds already: no write (DIRECTORY repeats on every registry change).
    w.save(table(3));
    CHECK_EQ(worker.pending(), 0u);
    CHECK_EQ(w.skipped(), 1u);
    CHECK(!w.holding());
    // An encoder that cannot fit the table writes nothing.
    w.save([](std::span<uint8_t>) { return size_t{0}; });
    CHECK_EQ(worker.pending(), 0u);
    CHECK_EQ(w.failures(), 1u);
    // A failed flash write is counted; the same table saved again is written again.
    blob.fail = true;
    w.save(table(4));
    worker.run_all();
    core.run_ready();
    CHECK_EQ(w.failures(), 2u);
    CHECK(!w.busy());
    blob.fail = false;
    w.save(table(4));
    worker.run_all();
    core.run_ready();
    CHECK_EQ(blob.data, (std::vector<uint8_t>{4}));
    CHECK_EQ(w.writes(), 3u);
}

TEST(node_net_blob_writer_recovers_refused_posts)
{
    frt::FakeCore core;
    frt::FakeWorker worker;
    MemBlob blob;
    fr::core::BlobWriter<16> w(core, worker, blob);
    auto one = [](std::span<uint8_t> out) {
        out[0] = 7;
        return size_t{1};
    };
    // fr_worker's queue is full: the write waits for retry().
    for (size_t i = 0; i < fr::worker::kQueueDepth; ++i) {
        CHECK(worker.post([] {}));
    }
    w.save(one);
    CHECK(w.busy());
    worker.run_all();
    CHECK(blob.history.empty());
    w.retry();
    CHECK_EQ(worker.pending(), 1u);
    // The core queue is full when the worker posts its verdict: retry() collects it all the same.
    for (size_t i = 0; i < frt::FakeCore::kPosts; ++i) {
        CHECK(core.post([] {}));
    }
    worker.run_all();
    CHECK_EQ(blob.history.size(), 1u);
    CHECK(w.busy());
    w.retry();
    CHECK(!w.busy());
    CHECK_EQ(w.writes(), 1u);
    core.run_ready();  // the no-ops; nothing left for the writer
    CHECK_EQ(w.writes(), 1u);
}

TEST(node_net_blobs_of_another_shape_never_load)
{
    fr::net::BindingTable t{};
    t[3].used = true;
    t[3].len = 2;
    t[3].bytes[0] = 0x08;
    t[3].bytes[1] = 0x03;
    uint8_t buf[fr::core::kBindBlobMax];
    const size_t n = fr::core::encode_bindings_blob(t, buf);
    CHECK_BYTES(std::span<const uint8_t>(buf, n), frt::from_hex("01 01 03 02 0803"));
    fr::net::BindingTable out{};
    REQUIRE(fr::core::decode_bindings_blob({buf, n}, out));
    CHECK(out[3].used);
    CHECK_BYTES(out[3].encoded(), frt::from_hex("0803"));

    const auto refused = [](const char *hex) {
        fr::net::BindingTable o{};
        o[0].used = true;  // must survive a refused blob
        const std::vector<uint8_t> b = frt::from_hex(hex);
        return !fr::core::decode_bindings_blob(b, o) && o[0].used && !o[3].used;
    };
    CHECK(refused("02 01 03 02 0803"));       // another version
    CHECK(refused("01 01 10 02 0803"));       // slot 16
    CHECK(refused("01 02 03 01 08 03 01 08")); // slot 3 twice
    CHECK(refused("01 01 03 05 0803"));       // truncated
    CHECK(refused("01 01 03 02 0803 00"));    // trailing byte
    CHECK(refused("01 01 03 00"));            // empty binding
    CHECK(refused("01 11"));                  // 17 bindings
    CHECK(refused(""));

    fr::net::Directory d;
    d.count = 1;
    d.entries[0] = {.addr = 0x0102, .mac = {1, 2, 3, 4, 5, 6}};
    uint8_t dbuf[fr::core::kDirBlobMax];
    const size_t dn = fr::core::encode_directory_blob(d, dbuf);
    CHECK_BYTES(std::span<const uint8_t>(dbuf, dn), frt::from_hex("01 01 0201 010203040506"));
    fr::net::Directory dout;
    REQUIRE(fr::core::decode_directory_blob({dbuf, dn}, dout));
    CHECK_EQ(dout.count, 1u);
    CHECK_EQ(dout.entries[0].addr, 0x0102);
    fr::net::Directory bad;
    CHECK(!fr::core::decode_directory_blob(frt::from_hex("01 02 0201 010203040506"), bad));  // short
    CHECK(!fr::core::decode_directory_blob(frt::from_hex("01 41"), bad));                    // 65 entries
    CHECK_EQ(bad.count, 0u);
}

TEST(node_net_msg_handlers_run_by_topic)
{
    fr::core::MsgHandlers h;
    std::vector<std::string> seen;
    REQUIRE(h.add("ping", [&seen](uint16_t src, std::span<const uint8_t> data) {
        seen.push_back("a" + std::to_string(src) + ":" + std::string(data.begin(), data.end()));
    }));
    REQUIRE(h.add("pong", [&seen](uint16_t, std::span<const uint8_t>) { seen.push_back("pong"); }));
    REQUIRE(h.add("ping", [&seen](uint16_t, std::span<const uint8_t>) { seen.push_back("b"); }));
    const std::string data = R"({"n":1})";
    CHECK_EQ(h.dispatch(0x12, "ping", {reinterpret_cast<const uint8_t *>(data.data()), data.size()}), 2u);
    CHECK_EQ(h.dispatch(0, "pin", {}), 0u);  // exact topics only
    REQUIRE_EQ(seen.size(), 2u);
    CHECK_EQ(seen[0], R"(a18:{"n":1})");
    CHECK_EQ(seen[1], "b");

    CHECK_EQ(h.add("", [](uint16_t, std::span<const uint8_t>) {}).error(), fr::Err::invalid_args);
    CHECK_EQ(h.add(std::string(33, 't'), [](uint16_t, std::span<const uint8_t>) {}).error(), fr::Err::invalid_args);
    CHECK(h.add(std::string(32, 't'), [](uint16_t, std::span<const uint8_t>) {}));
    while (h.size() < fr::msg::kHandlersMax) {
        CHECK(h.add("x", [](uint16_t, std::span<const uint8_t>) {}));
    }
    CHECK_EQ(h.add("y", [](uint16_t, std::span<const uint8_t>) {}).error(), fr::Err::busy);
}

TEST(node_net_msg_send_checks_topic_and_data)
{
    frt::FakeCore core;
    StubHost host;
    fr::net::Net net(core, host, fr::net::Config{});
    const uint8_t data[fr::msg::kDataMax + 1] = {};
    const uint8_t bad_utf8[] = {0xff};
    const std::string_view bad_topic(reinterpret_cast<const char *>(bad_utf8), 1);
    CHECK_EQ(fr::core::msg_send(net, 0x12, "", {}, false).error(), fr::Err::invalid_args);
    CHECK_EQ(fr::core::msg_send(net, 0x12, std::string(33, 't'), {}, false).error(), fr::Err::invalid_args);
    CHECK_EQ(fr::core::msg_send(net, 0x12, "t", data, false).error(), fr::Err::invalid_args);
    CHECK_EQ(fr::core::msg_send(net, 0x12, bad_topic, {}, false).error(), fr::Err::invalid_args);
    // A group is no MSG dst (05 §5.5 addresses; groups are M2); the hub is, but needs a hub session.
    CHECK_EQ(fr::core::msg_send(net, 0xF001, "t", {data, fr::msg::kDataMax}, true).error(), fr::Err::invalid_args);
    CHECK_EQ(fr::core::msg_send(net, fr::msg::kHub, "t", {}, true).error(), fr::Err::busy);
}
