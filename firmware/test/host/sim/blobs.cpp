// nvs:fr_dir and nvs:fr_bind on a host node (design c5 §3, m2-c2 D2): FileBlob (a file in fr_net_node's --ota-dir,
// or memory) moved out of tools/net_node.cpp, and MemBlob, the memory a fleet node keeps across power cycles.
#include <cstring>

#include "sim/node.hpp"
#include "tools/ota_fake.hpp"

namespace frsim {

size_t FileBlob::read(std::span<uint8_t> out)
{
    const std::optional<std::string> data = path_.empty() ? mem_ : ota_fake::read_file(path_);
    if (!data || data->size() > out.size()) {
        return 0;
    }
    std::memcpy(out.data(), data->data(), data->size());
    return data->size();
}

bool FileBlob::write(std::span<const uint8_t> bytes)
{
    const std::string data(reinterpret_cast<const char *>(bytes.data()), bytes.size());
    if (path_.empty()) {
        mem_ = data;
    } else {
        ota_fake::write_file(path_, data);
    }
    return true;
}

size_t MemBlob::read(std::span<uint8_t> out)
{
    const std::lock_guard lock(mu_);
    if (!data_ || data_->size() > out.size()) {
        return 0;
    }
    std::memcpy(out.data(), data_->data(), data_->size());
    return data_->size();
}

bool MemBlob::write(std::span<const uint8_t> bytes)
{
    const std::lock_guard lock(mu_);
    data_.emplace(bytes.begin(), bytes.end());
    return true;
}

}  // namespace frsim
