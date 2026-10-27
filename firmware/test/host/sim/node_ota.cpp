// NodeOtaHost (design c4 §3, m2-c2 D2): fr_core's OtaHost on a host node, moved out of tools/net_node.cpp. Each OTA
// frame the node sends is one `ota_tx` line, and each decision fr_core's log_ota line (through the node's KitLogs);
// the image comes from the hub's node HTTP port at the address of the TCP session (NodeSpec::host, hub_http).
#include <cstdio>

#include "sim/node.hpp"

namespace frsim {

void NodeOtaHost::log_ota(uint8_t kind, std::span<const uint8_t> body, bool sent)
{
    // fr_core's log_ota (core.cpp): one line per OTA decision the node sends, not every STATUS.
    if (logs_ == nullptr) {
        return;
    }
    const char *tail = sent ? "" : " (no hub session: not sent)";
    if (kind == fr::proto::kKindOtaAccept) {
        if (auto a = fr::proto::decode_ota_accept(body)) {
            const bool resumed = a->code == static_cast<uint8_t>(fr::ota::Accept::resumed);
            logs_->log('I', "fr",
                       sformat(KitLogs::kOtaAcceptFmt, static_cast<int>(a->job_id.size()), a->job_id.data(), resumed ? " (resumed)" : "", tail));
        }
    } else if (kind == fr::proto::kKindOtaReject) {
        if (auto r = fr::proto::decode_ota_reject(body)) {
            logs_->log('W', "fr", sformat(KitLogs::kOtaRejectFmt, static_cast<int>(r->job_id.size()), r->job_id.data(), unsigned{r->code}, tail));
        }
    } else if (kind == fr::proto::kKindOtaResult) {
        if (auto r = fr::proto::decode_ota_result(body)) {
            logs_->log('I', "fr",
                       sformat(KitLogs::kOtaResultFmt, static_cast<int>(r->job_id.size()), r->job_id.data(), unsigned{r->outcome},
                               unsigned{r->reason}, tail));
        }
    } else if (kind == fr::proto::kKindOtaStatus) {
        if (auto m = fr::proto::decode_ota_status(body); m && m->state != static_cast<uint8_t>(fr::ota::Phase::downloading)) {
            logs_->log('I', "fr",
                       sformat(KitLogs::kOtaPhaseFmt, m->state == static_cast<uint8_t>(fr::ota::Phase::staged) ? "staged" : "installed",
                               static_cast<int>(m->job_id.size()), m->job_id.data()));
        }
    }
}

fr::Status NodeOtaHost::send(uint8_t kind, std::span<const uint8_t> body, bool ack_req)
{
    const fr::Status st = net_.send_ota(kind, body, ack_req);
    log_ota(kind, body, static_cast<bool>(st));
    const char *sent = st ? "true" : "false";
    const char *ack = ack_req ? "true" : "false";
    if (kind == fr::proto::kKindOtaAccept || kind == fr::proto::kKindOtaReject) {
        auto a = kind == fr::proto::kKindOtaAccept ? fr::proto::decode_ota_accept(body)
                                                   : fr::proto::decode_ota_reject(body).transform([](const auto &r) {
                                                         return fr::proto::OtaAccept{.job_id = r.job_id, .code = r.code};
                                                     });
        if (a) {
            out_.emit(R"({"ev":"ota_tx","kind":"%s","job":"%.*s","code":%u,"ack_req":%s,"sent":%s})",
                      kind == fr::proto::kKindOtaAccept ? "accept" : "reject", static_cast<int>(a->job_id.size()),
                      a->job_id.data(), unsigned{a->code}, ack, sent);
        }
    } else if (kind == fr::proto::kKindOtaStatus) {
        if (auto m = fr::proto::decode_ota_status(body)) {
            out_.emit(R"({"ev":"ota_tx","kind":"status","job":"%.*s","state":%u,"bytes":%u,"ack_req":%s,"sent":%s})",
                      static_cast<int>(m->job_id.size()), m->job_id.data(), unsigned{m->state},
                      static_cast<unsigned>(m->bytes), ack, sent);
        }
    } else if (kind == fr::proto::kKindOtaResult) {
        if (auto m = fr::proto::decode_ota_result(body)) {
            out_.emit(R"({"ev":"ota_tx","kind":"result","job":"%.*s","outcome":%u,"reason":%u,"ack_req":%s,"sent":%s})",
                      static_cast<int>(m->job_id.size()), m->job_id.data(), unsigned{m->outcome}, unsigned{m->reason}, ack,
                      sent);
        }
    }
    return st;
}

bool NodeOtaHost::endpoint(fr::ota::Endpoint &out)
{
    // design c4 §3: the address of the TCP session, the hub's node HTTP port.
    if (!net_.state().link(fr::net::LinkKind::tcp).session) {
        return false;
    }
    std::snprintf(out.host, sizeof(out.host), "%s", spec_.host.c_str());
    out.port = spec_.hub_http;
    return true;
}

}  // namespace frsim
