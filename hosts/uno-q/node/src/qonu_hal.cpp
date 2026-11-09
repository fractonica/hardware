#include "qonu_hal.hpp"

#include <string>

namespace qonu {

fr::Status Led3::write(const fr::hal::LightLevel &l)
{
    auto lit = [&](uint8_t c) { return l.on && c >= 128 ? "true" : "false"; };
    const std::string params = std::string("{\"r\":") + lit(l.color.r) + ",\"g\":" + lit(l.color.g) +
                               ",\"b\":" + lit(l.color.b) + "}";
    if (!link_.call("led", params)) {
        return std::unexpected(fr::Err::failed);
    }
    return {};
}

fr::hal::Selftest Led3::selftest()
{
    return link_.call("ping", "{}") ? fr::hal::Selftest{true, "qonu-link answers"}
                                    : fr::hal::Selftest{false, "qonu-link does not answer"};
}

fr::Status Matrix::init(fr::Core &core, fr::hal::Rotation rotation)
{
    // The matrix is wired one way round; a half turn is a mirror both ways, done here. Quarter turns would need an
    // 8x13 panel: unsupported.
    if (rotation != fr::hal::Rotation::r0 && rotation != fr::hal::Rotation::r180) {
        return std::unexpected(fr::Err::unsupported);
    }
    rotation_ = rotation;
    rows_.fill(0);
    if (settle_ == nullptr) {
        settle_ = core.timer([this] { (void)send(); });  // a failed send is retried by the next change
    }
    return send();
}

fr::Status Matrix::flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> pixels)
{
    const size_t stride = (w + 7u) / 8u;
    if (w == 0 || h == 0 || x + w > kWidth || y + h > kHeight || pixels.size() < stride * h) {
        return std::unexpected(fr::Err::invalid_args);
    }
    const bool flip = rotation_ == fr::hal::Rotation::r180;
    for (uint16_t row = 0; row < h; ++row) {
        for (uint16_t col = 0; col < w; ++col) {
            const bool on = (pixels[row * stride + col / 8u] >> (7u - col % 8u)) & 1u;
            const uint16_t sx = x + col;
            const uint16_t sy = y + row;
            const uint16_t px = flip ? static_cast<uint16_t>(kWidth - 1 - sx) : sx;
            const uint16_t py = flip ? static_cast<uint16_t>(kHeight - 1 - sy) : sy;
            const auto bit = static_cast<uint16_t>(1u << px);
            rows_[py] = on ? static_cast<uint16_t>(rows_[py] | bit) : static_cast<uint16_t>(rows_[py] & ~bit);
        }
    }
    if (settle_ == nullptr) {
        return send();  // no timer to spare: straight out
    }
    if (!settle_->running()) {
        settle_->start(kSettleUs);
    }
    return {};
}

fr::Status Matrix::send()
{
    std::string params = "{\"rows\":[";
    for (size_t i = 0; i < rows_.size(); ++i) {
        params += (i ? "," : "") + std::to_string(rows_[i]);
    }
    params += "]}";
    if (!link_.call("matrix", params)) {
        return std::unexpected(fr::Err::failed);
    }
    return {};
}

fr::hal::Selftest Matrix::selftest()
{
    return link_.call("ping", "{}") ? fr::hal::Selftest{true, "qonu-link answers"}
                                    : fr::hal::Selftest{false, "qonu-link does not answer"};
}

}  // namespace qonu
