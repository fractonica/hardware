#!/usr/bin/env python3
"""TCP + UDP echo server for the hwprobe round-trip test (M0 spikes S4/S5). Run on the hub Mac.

Prints one JSON line per notable event. A failing UDP send back to the node is reported, because
macOS Local Network Privacy can block outbound UDP from an app-launched process.
"""
import json
import selectors
import socket
import sys
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7421


def log(**kv):
    kv["ts"] = round(time.time(), 3)
    print(json.dumps(kv), flush=True)


sel = selectors.DefaultSelector()
tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
tcp.bind(("0.0.0.0", PORT))
tcp.listen()
tcp.setblocking(False)
sel.register(tcp, selectors.EVENT_READ, "accept")
udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp.bind(("0.0.0.0", PORT))
udp.setblocking(False)
sel.register(udp, selectors.EVENT_READ, "udp")
log(event="listening", port=PORT)

stats = {"tcp_bytes": 0, "udp_rx": 0, "udp_tx": 0, "udp_tx_err": 0}
last_report = time.time()
while True:
    for key, _ in sel.select(timeout=1.0):
        if key.data == "accept":
            conn, addr = tcp.accept()
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            conn.setblocking(False)
            sel.register(conn, selectors.EVENT_READ, "conn")
            log(event="tcp_accept", peer=addr[0])
        elif key.data == "conn":
            conn = key.fileobj
            try:
                data = conn.recv(4096)
            except OSError as e:
                data = b""
                log(event="tcp_error", error=str(e))
            if not data:
                sel.unregister(conn)
                conn.close()
                log(event="tcp_closed", **stats)
                continue
            stats["tcp_bytes"] += len(data)
            try:
                conn.sendall(data)
            except OSError as e:
                log(event="tcp_send_error", error=str(e))
        elif key.data == "udp":
            data, addr = udp.recvfrom(2048)
            stats["udp_rx"] += 1
            try:
                udp.sendto(data, addr)
                stats["udp_tx"] += 1
            except OSError as e:
                stats["udp_tx_err"] += 1
                if stats["udp_tx_err"] <= 3:
                    log(event="udp_send_error", peer=addr[0], error=str(e))
    if time.time() - last_report > 10 and any(stats.values()):
        last_report = time.time()
        log(event="stats", **stats)
