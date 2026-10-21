// nvs:fr_ota as Ota sees it (spec 06 §6.3, §6.6, design c4 §3): the job a download or an installed image
// belongs to, so a reboot can resume the download, run the health gate with the right bits and report the
// outcome. On target an NVS namespace (src/esp); a memory record in host tests and fr_net_node. load() runs
// once at boot; every write runs on fr_worker (spec 03 §3.4).
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/ota/defs.hpp"

namespace fr::ota {

class Store
{
public:
    /** The stored record; false when there is none (or it is unreadable). */
    virtual bool load(Record &out) = 0;
    /** Every field: a job starts (or resumes) its download. */
    virtual Status save(const Record &r) = 0;
    /** Only `off`: the download's progress every kResumeStride. */
    virtual Status save_off(uint32_t off) = 0;
    /** Only `state`. */
    virtual Status save_state(RecState s) = 0;
    /** No record: the job's outcome was reported. */
    virtual Status clear() = 0;

protected:
    ~Store() = default;
};

}  // namespace fr::ota
