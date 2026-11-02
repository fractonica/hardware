// fr.csi's record, ring and motion feature (fr/csi/csi.hpp; design csi-c1 D10, §12).
#include "fr/csi/csi.hpp"

namespace fr::csi {

size_t encode_record(const hal::CsiRecord &r, std::span<uint8_t> out)
{
    const size_t n = record_wire_bytes(r);
    if (r.data.size() > hal::kCsiDataMax || out.size() < n) {
        return 0;
    }
    uint8_t *p = out.data();
    put_u16le(p, static_cast<uint16_t>(r.data.size()));
    put_u32le(p + 2, r.t_us);
    p[6] = static_cast<uint8_t>(r.rssi);
    p[7] = static_cast<uint8_t>(r.noise);
    p[8] = r.channel;
    p[9] = static_cast<uint8_t>(r.bb_format);
    p[10] = r.flags;
    p[11] = 0;
    std::memcpy(p + 12, r.mac.data(), r.mac.size());
    if (!r.data.empty()) {
        std::memcpy(p + kRecordHeadBytes, r.data.data(), r.data.size());
    }
    return n;
}

uint32_t isqrt(uint32_t v)
{
    uint32_t root = 0;
    uint32_t bit = 1u << 30;
    while (bit > v) {
        bit >>= 2;
    }
    while (bit != 0) {
        if (v >= root + bit) {
            v -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }
    return root;
}

// ---- RecordRing ----

bool RecordRing::push(const hal::CsiRecord &r)
{
    const uint32_t seq = next_seq_++;
    const size_t wire = record_wire_bytes(r);
    const uint32_t total = static_cast<uint32_t>((kEntryHead + wire + 3) & ~size_t{3});
    const uint32_t head = head_.load(std::memory_order_relaxed);
    const uint32_t tail = tail_.load(std::memory_order_acquire);
    const uint32_t pos = size_ > 0 ? at(head) : 0;
    const uint32_t contiguous = size_ - pos;
    const uint32_t need = total + (contiguous < total ? contiguous : 0);
    if (mem_ == nullptr || r.data.size() > hal::kCsiDataMax || head - tail + need > size_) {
        dropped_.fetch_add(1, std::memory_order_relaxed);
        offered_.store(seq + 1, std::memory_order_release);
        return false;
    }
    uint32_t to = head;
    if (contiguous < total) {
        put_u16le(mem_ + pos, 0);  // the wrap marker: the consumer goes on at 0
        to += contiguous;
    }
    uint8_t *e = mem_ + at(to);
    put_u16le(e, static_cast<uint16_t>(total));
    put_u16le(e + 2, static_cast<uint16_t>(wire));
    put_u32le(e + 4, seq);
    encode_record(r, {e + kEntryHead, wire});
    head_.store(to + total, std::memory_order_release);  // the entry first, then the head the consumer reads
    offered_.store(seq + 1, std::memory_order_release);
    return true;
}

bool RecordRing::peek(View &out)
{
    if (mem_ == nullptr) {
        return false;
    }
    uint32_t tail = tail_.load(std::memory_order_relaxed);
    const uint32_t head = head_.load(std::memory_order_acquire);
    if (tail == head) {
        return false;
    }
    uint32_t pos = at(tail);
    if (get_u16le(mem_ + pos) == 0) {
        tail += size_ - pos;  // the wrap marker
        tail_.store(tail, std::memory_order_release);
        if (tail == head) {
            return false;
        }
        pos = 0;
    }
    const uint8_t *e = mem_ + pos;
    out.seq = get_u32le(e + 4);
    out.wire = {e + kEntryHead, get_u16le(e + 2)};
    return true;
}

void RecordRing::pop()
{
    const uint32_t tail = tail_.load(std::memory_order_relaxed);
    if (tail == head_.load(std::memory_order_acquire)) {
        return;
    }
    const uint32_t total = get_u16le(mem_ + at(tail));  // peek() stepped over a wrap marker already
    tail_.store(tail + total, std::memory_order_release);
}

// ---- Motion ----

uint32_t Motion::shift_for(uint32_t rate_hz)
{
    // The baseline's time constant is 2^k records: k = round(log2(rate x kBaselineMs)), clamped to 2..10.
    const uint32_t records = std::max<uint32_t>((rate_hz == 0 ? 100 : rate_hz) * kBaselineMs / 1000, 1);
    uint32_t k = 0;
    while (k < 31 && (1u << (k + 1)) <= records) {
        ++k;
    }
    // 2^k <= records < 2^(k+1): the nearer one (geometric midpoint 2^k x sqrt 2 ~ 2^k x 181 / 128).
    if (static_cast<uint64_t>(records) * 128 >= (uint64_t{1} << k) * 181) {
        ++k;
    }
    return std::clamp<uint32_t>(k, 2, 10);
}

bool Motion::add(std::span<const int8_t> data, bool first_word_invalid, uint32_t rate_hz)
{
    const size_t n = std::min(data.size() / 2, kMaxSub);
    if (n == 0) {
        return false;
    }
    if (seeded_ && n != n_) {
        if (++others_ < kSwitchAfter) {
            return false;  // another frame format: skipped
        }
        seeded_ = false;  // that format is the one coming now
    }
    others_ = 0;
    const size_t from = first_word_invalid ? 2 : 0;  // data[0..3]: the first two subcarriers
    if (!seeded_) {
        n_ = n;
        for (size_t i = 0; i < n; ++i) {
            const int32_t im = data[2 * i];
            const int32_t re = data[2 * i + 1];
            base_[i] = i < from ? 0 : static_cast<int32_t>(isqrt(static_cast<uint32_t>(re * re + im * im)) << 8);
        }
        seeded_ = true;
        return false;
    }
    const uint32_t k = shift_for(rate_hz);
    uint64_t sum_d = 0;
    uint64_t sum_b = 0;
    for (size_t i = from; i < n; ++i) {
        const int32_t im = data[2 * i];
        const int32_t re = data[2 * i + 1];
        const int32_t amp = static_cast<int32_t>(isqrt(static_cast<uint32_t>(re * re + im * im)) << 8);
        const int32_t d = amp - base_[i];
        sum_d += static_cast<uint32_t>(d < 0 ? -d : d);
        sum_b += static_cast<uint32_t>(base_[i]);
        base_[i] += d / (int32_t{1} << k);  // toward zero either way: no drift from the shift's rounding
    }
    if (sum_b == 0) {
        return false;  // nothing but null subcarriers
    }
    win_sum_ += std::min<uint64_t>(sum_d * kUnit / sum_b, 65535);
    ++win_n_;
    return true;
}

uint16_t Motion::close()
{
    const uint16_t m = win_n_ > 0 ? static_cast<uint16_t>(win_sum_ / win_n_) : 0;
    win_sum_ = 0;
    win_n_ = 0;
    return m;
}

}  // namespace fr::csi
