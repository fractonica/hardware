// Framework core. M1 checkpoint C1: identity + boot banner + liveness log. The actor task,
// input slots and timers (spec 03 §3.4) arrive with checkpoint C2.
#pragma once

#include "fr/id.h"

namespace fr::core {

/** Loads identity, logs the boot banner ("fr: ready id=... fw=..."), starts the liveness log. */
void boot();

/** Identity loaded by boot(). */
const fr_identity_t &identity();

/** First 6 bytes of the running image's appended SHA-256, as 12 hex digits (matches build_id). */
const char *fw_id();

}  // namespace fr::core
