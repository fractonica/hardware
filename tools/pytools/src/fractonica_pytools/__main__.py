"""Fractonica hub sidecar.

Reads one JSON request from stdin and writes JSON-line events to stdout:
  {"ev": "log", "msg": ...}
  {"ev": "progress", "pct": ..., "prefix": ...}
  {"ev": "stage", "stage": ...}
  {"ev": "result", "data": {...}}
  {"ev": "error", "code": ..., "message": ..., "stage": ..., "hint": ...}
Exit status is 0 on success and 1 on error. One process per job: esptool's logger is global.

Requests:
  {"cmd": "version"}
  {"cmd": "probe", "port": "/dev/cu.usbmodem1101"}
  {"cmd": "flash", "port": ..., "files": [{"offset": "0x0", "path": ...}], "erase": [{"offset": ..., "size": ...}],
   "after": "hard-reset"}
  {"cmd": "reset", "port": ..., "mode": "hard" | "bootloader"}
"""

from __future__ import annotations

import json
import sys
from typing import Any

import esptool
import serial
from esptool.cmds import (
    attach_flash,
    detect_chip,
    detect_flash_size,
    erase_region,
    reset_chip,
    run_stub,
    write_flash,
)
from esptool.logger import TemplateLogger, log
from esptool.reset import HardReset


def emit(**kv: Any) -> None:
    sys.stdout.write(json.dumps(kv, default=str) + "\n")
    sys.stdout.flush()


class SidecarError(Exception):
    def __init__(self, code: str, message: str, hint: str | None = None):
        super().__init__(message)
        self.code = code
        self.hint = hint


class JsonLogger(TemplateLogger):
    """Routes esptool output to JSON events; progress is throttled to whole percents."""

    def __init__(self) -> None:
        self._last_pct = -1.0

    def print(self, *args: Any, **kwargs: Any) -> None:
        msg = " ".join(str(a) for a in args).strip()
        if msg:
            emit(ev="log", msg=msg)

    def note(self, message: str) -> None:
        emit(ev="log", level="note", msg=message)

    def warning(self, message: str) -> None:
        emit(ev="log", level="warning", msg=message)

    def error(self, message: str) -> None:
        emit(ev="log", level="error", msg=message)

    def stage(self, finish: bool = False) -> None:
        pass

    def progress_bar(self, cur_iter: int, total_iters: int, prefix: str = "", suffix: str = "",
                     bar_length: int = 30) -> None:
        pct = round(100.0 * cur_iter / total_iters, 0) if total_iters else 100.0
        if pct != self._last_pct or cur_iter == total_iters:
            self._last_pct = pct
            emit(ev="progress", pct=pct, prefix=prefix.strip(), suffix=suffix.strip())

    def set_verbosity(self, verbosity: str) -> None:
        pass


STAGE = "init"


def set_stage(name: str) -> None:
    global STAGE
    STAGE = name
    emit(ev="stage", stage=name)


def connect(port: str, before: str = "default-reset"):
    set_stage("connect")
    try:
        return detect_chip(port, connect_mode=before)
    except Exception as e:  # esptool raises FatalError / serial errors
        msg = str(e)
        if "Resource busy" in msg or "could not open port" in msg:
            raise SidecarError("PORT_BUSY_EXTERNAL", msg, "close any other program using the port")
        raise SidecarError("FLASH_FAILED", msg,
                           "if the board does not respond: hold BOOT, tap RST, release BOOT, then retry")


def mac_str(mac: Any) -> str:
    return ":".join(f"{b:02x}" for b in mac)


def cmd_version(_: dict) -> dict:
    return {"esptool": esptool.__version__, "python": sys.version.split()[0]}


def cmd_probe(req: dict) -> dict:
    with connect(req["port"], req.get("before", "default-reset")) as esp:
        set_stage("identify")
        sec = esp.get_security_info()
        flash_crypt_cnt = int(sec.get("flash_crypt_cnt", 0) or 0)
        data = {
            "chip": esp.CHIP_NAME,
            "description": esp.get_chip_description(),
            "features": esp.get_chip_features(),
            "mac": mac_str(esp.read_mac("BASE_MAC")),
            "crystal_mhz": esp.get_crystal_freq(),
            "secure_boot": bool(int(sec.get("flags", 0) or 0) & 1),
            "flash_encryption": bin(flash_crypt_cnt).count("1") % 2 == 1,
        }
        esp = run_stub(esp)
        attach_flash(esp)
        data["flash_size"] = detect_flash_size(esp)
        set_stage("reset")
        reset_chip(esp, "hard-reset")
        return data


def cmd_flash(req: dict) -> dict:
    files = [(int(f["offset"], 0), f["path"]) for f in req["files"]]
    erases = [(int(e["offset"], 0), int(e["size"], 0)) for e in req.get("erase", [])]
    with connect(req["port"], req.get("before", "default-reset")) as esp:
        chip = esp.CHIP_NAME
        set_stage("stub")
        esp = run_stub(esp)
        attach_flash(esp)
        for offset, size in erases:
            set_stage(f"erase 0x{offset:x}")
            erase_region(esp, offset, size)
        set_stage("write")
        write_flash(esp, files, flash_freq="keep", flash_mode="keep", flash_size="keep", compress=True)
        set_stage("reset")
        reset_chip(esp, req.get("after", "hard-reset"))
        return {"chip": chip, "written": [{"offset": hex(o), "path": p} for o, p in files],
                "erased": [{"offset": hex(o), "size": hex(s)} for o, s in erases]}


def cmd_reset(req: dict) -> dict:
    mode = req.get("mode", "hard")
    if mode == "bootloader":
        with connect(req["port"], "default-reset") as esp:
            set_stage("reset")
            reset_chip(esp, "no-reset")
            return {"mode": "bootloader", "chip": esp.CHIP_NAME}
    set_stage("reset")
    port = serial.Serial()
    port.port = req["port"]
    port.dtr = False  # never assert BOOT; only pulse EN through RTS
    port.rts = False
    try:
        port.open()
    except serial.SerialException as e:
        raise SidecarError("PORT_BUSY_EXTERNAL", str(e), "close any other program using the port")
    try:
        HardReset(port, uses_usb=True)()
    finally:
        port.close()
    return {"mode": "hard"}


HANDLERS = {"version": cmd_version, "probe": cmd_probe, "flash": cmd_flash, "reset": cmd_reset}


def main() -> int:
    log.set_logger(JsonLogger())
    try:
        req = json.loads(sys.stdin.read() or "{}")
        handler = HANDLERS.get(req.get("cmd", ""))
        if handler is None:
            raise SidecarError("INVALID_ARGS", f"unknown cmd {req.get('cmd')!r}")
        emit(ev="result", data=handler(req))
        return 0
    except SidecarError as e:
        emit(ev="error", code=e.code, message=str(e), stage=STAGE, hint=e.hint)
    except Exception as e:  # noqa: BLE001 - every failure must reach the hub as JSON
        emit(ev="error", code="FLASH_FAILED", message=f"{type(e).__name__}: {e}", stage=STAGE)
    return 1


if __name__ == "__main__":
    sys.exit(main())
