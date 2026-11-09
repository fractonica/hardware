#include "fr/posix/store.hpp"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sstream>

namespace fr::posix {

bool write_file_atomic(const std::string &path, std::span<const uint8_t> bytes)
{
    const std::string tmp = path + ".tmp";
    const int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd < 0) {
        return false;
    }
    size_t off = 0;
    while (off < bytes.size()) {
        const ssize_t n = ::write(fd, bytes.data() + off, bytes.size() - off);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            ::close(fd);
            ::unlink(tmp.c_str());
            return false;
        }
        off += static_cast<size_t>(n);
    }
    if (::fsync(fd) != 0 || ::close(fd) != 0 || ::rename(tmp.c_str(), path.c_str()) != 0) {
        ::unlink(tmp.c_str());
        return false;
    }
    // The rename itself reaches the disk with the directory.
    const size_t slash = path.find_last_of('/');
    const std::string dir = slash == std::string::npos ? "." : path.substr(0, std::max<size_t>(slash, 1));
    if (const int dfd = ::open(dir.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC); dfd >= 0) {
        ::fsync(dfd);
        ::close(dfd);
    }
    return true;
}

std::optional<std::string> read_file(const std::string &path)
{
    std::FILE *f = std::fopen(path.c_str(), "rb");
    if (f == nullptr) {
        return std::nullopt;
    }
    std::string out;
    char buf[4096];
    size_t n = 0;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) {
        out.append(buf, n);
    }
    const bool err = std::ferror(f) != 0;
    std::fclose(f);
    if (err) {
        return std::nullopt;
    }
    return out;
}

bool IdentityFile::load()
{
    const std::optional<std::string> text = read_file(path_);
    if (!text) {
        return errno == ENOENT;
    }
    std::istringstream in(*text);
    std::string line;
    extra_.clear();
    while (std::getline(in, line)) {
        const size_t eq = line.find('=');
        if (line.empty() || line[0] == '#' || eq == std::string::npos) {
            continue;
        }
        const std::string key = line.substr(0, eq);
        const std::string value = line.substr(eq + 1);
        const unsigned long num = std::strtoul(value.c_str(), nullptr, 10);
        if (key == "addr") {
            addr = static_cast<uint16_t>(num);
        } else if (key == "net") {
            net = static_cast<uint16_t>(num);
        } else if (key == "alias") {
            alias = value.substr(0, 31);
        } else if (key == "alias_rev") {
            alias_rev = static_cast<uint32_t>(num);
        } else if (key == "epoch") {
            epoch = static_cast<uint16_t>(num);
        } else if (key == "hub") {
            hub = value;
        } else {
            extra_ += line + "\n";
        }
    }
    return true;
}

bool IdentityFile::begin_boot(uint16_t floor)
{
    // max(stored, floor - 1) + 1 in RFC 1982 order, never 0 (0 means "no epoch" to the hub).
    uint16_t next = static_cast<uint16_t>(epoch + 1);
    if (static_cast<int16_t>(static_cast<uint16_t>(floor - next)) > 0) {
        next = floor;
    }
    if (next == 0) {
        next = 1;
    }
    epoch = next;
    return save();
}

bool IdentityFile::save()
{
    std::string text = "# fr_posix node identity: written by the node, edit only while it is stopped\n";
    text += "addr=" + std::to_string(addr) + "\n";
    text += "net=" + std::to_string(net) + "\n";
    text += "alias=" + alias + "\n";
    text += "alias_rev=" + std::to_string(alias_rev) + "\n";
    text += "epoch=" + std::to_string(epoch) + "\n";
    text += "hub=" + hub + "\n";
    text += extra_;
    return write_file_atomic(path_, std::span(reinterpret_cast<const uint8_t *>(text.data()), text.size()));
}

size_t FileBlob::read(std::span<uint8_t> out)
{
    const std::optional<std::string> bytes = read_file(path_);
    if (!bytes || bytes->empty() || bytes->size() > out.size()) {
        return 0;
    }
    std::memcpy(out.data(), bytes->data(), bytes->size());
    return bytes->size();
}

bool FileBlob::write(std::span<const uint8_t> bytes)
{
    return write_file_atomic(path_, bytes);
}

bool InlineWorker::post(Callback<void(), 32> job)
{
    const std::lock_guard lock(mu_);
    if (jobs_.size() >= worker::kQueueDepth) {
        return false;
    }
    jobs_.push_back(job);
    return true;
}

bool InlineWorker::run_one()
{
    Callback<void(), 32> job;
    {
        const std::lock_guard lock(mu_);
        if (jobs_.empty()) {
            return false;
        }
        job = jobs_.front();
        jobs_.pop_front();
    }
    job();
    return true;
}

bool InlineWorker::idle() const
{
    const std::lock_guard lock(mu_);
    return jobs_.empty();
}

}  // namespace fr::posix
