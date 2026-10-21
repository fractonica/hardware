// fr_ota on ESP-IDF (design c4 §3): the update slot through esp_ota_ops, the image download (HttpGet on
// lwIP sockets), nvs:fr_ota, and the fr_ident fields CHECK compares. fr_core hands these to Ota::bind.
// Static objects: valid at any time, nothing touches hardware before Ota calls them.
#pragma once

#include "fr/ota/defs.hpp"
#include "fr/ota/fetch.hpp"
#include "fr/ota/flash.hpp"
#include "fr/ota/store.hpp"

namespace fr::ota::esp {

Flash &flash();
Fetch &fetch();
Store &store();

/** fr_ident's board, profile and part_profile (06 §6.3); the running image's own (fr_app_desc) for any it
 * lacks, as on an UNASSIGNED node. Call after fr_id_load(), which opens the fr_ident partition. */
Ident ident();

}  // namespace fr::ota::esp
