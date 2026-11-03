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
   "after": "hard-reset", "expect_chip_id": 5}
     expect_chip_id (optional) is the image header chip id; a different chip fails with TARGET_MISMATCH
     before anything is written.
  {"cmd": "reset", "port": ..., "mode": "hard" | "bootloader"}
  {"cmd": "nvs_gen", "csv_path": ..., "size": 16384 | "0x4000", "out_path": ...}
     renders an NVS partition image (fr_ident, spec 06 §6.3) from a CSV with esp-idf-nvs-partition-gen.
     The CSV holds the Wi-Fi password, so no event or error ever carries its content: failures name the
     CSV row and the error type only. The result is {"out_path", "size", "rows"}.
"""

from __future__ import annotations

import contextlib
import csv
import io
import json
import os
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
from esptool.targets import ROM_LIST
from esptool.util import FatalError, UnsupportedCommandError


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


# pyserial open errors. esptool adds "the port is busy or doesn't exist" to every one, so that text is not
# matched; a port another pyserial user holds fails the flock: "Could not exclusively lock port ...".
PORT_GONE = ("No such file or directory", "Device not configured", "FileNotFoundError")
PORT_BUSY = ("Resource busy", "Could not exclusively lock port", "Access is denied")


def port_open_error(msg: str) -> SidecarError | None:
    if any(s in msg for s in PORT_GONE):
        return SidecarError("NOT_FOUND", msg, "the port disappeared: re-run port_list (fr ports ls)")
    if any(s in msg for s in PORT_BUSY):
        return SidecarError("PORT_BUSY_EXTERNAL", msg, "close any other program using the port")
    return None


def connect_error(msg: str) -> SidecarError:
    """The SidecarError for a failed detect_chip: a port error by its text, else FLASH_FAILED with a hint.

    Boot mode 0xb (HSPI_FLASH_BOOT) means IO0 was low but GPIO2 high at reset: on an ESP32-CAM the micro-SD card's DAT0
    is GPIO2, and a card that was initialised once drives it high (after an unmount too) until the board is power-cycled,
    so the ROM never enters download mode however EN and IO0 are driven (bench, 2026-11-03)."""
    port_err = port_open_error(msg)
    if port_err:
        return port_err
    if "boot mode" in msg and "0xb" in msg:
        return SidecarError(
            "FLASH_FAILED", msg,
            "boot mode 0xb: GPIO2 is held high (on an ESP32-CAM the SD card's DAT0 once the card was used): "
            "power-cycle the board with the card removed, then retry")
    return SidecarError("FLASH_FAILED", msg, "if the board does not respond: hold BOOT, tap RST, release BOOT, then retry")


def connect(port: str, before: str = "default-reset"):
    set_stage("connect")
    try:
        return detect_chip(port, connect_mode=before)
    except Exception as e:  # esptool raises FatalError / serial errors
        raise connect_error(str(e)) from None


def security_info(esp: Any) -> tuple[dict, bool]:
    """GET_SECURITY_INFO's answer and whether the ROM had it.

    The classic ESP32's ROM has no GET_SECURITY_INFO (0x14): esptool raises UnsupportedCommandError ("not supported in
    the current download mode"). A lab board without the command has neither secure boot nor flash encryption worth
    refusing over (both would also show in the stub's flash reads), so the probe goes on and says it could not read it."""
    try:
        return esp.get_security_info(), True
    except UnsupportedCommandError:
        return {}, False
    except FatalError as e:
        if "not supported" in str(e).lower():
            return {}, False
        raise


def chip_name(image_chip_id: int) -> str:
    return next((c.CHIP_NAME for c in ROM_LIST if c.IMAGE_CHIP_ID == image_chip_id), f"chip id {image_chip_id}")


def check_target(esp: Any, expect: int | None) -> None:
    """Refuses an image built for another chip. esptool itself only checks images written at 0x0."""
    if expect is None or esp.IMAGE_CHIP_ID == expect:
        return
    try:
        reset_chip(esp, "hard-reset")  # nothing was written: let the old firmware run again
    except Exception:  # noqa: BLE001 - the mismatch is the error to report
        pass
    raise SidecarError("TARGET_MISMATCH",
                       f"the image is for {chip_name(expect)} (chip id {expect}), but the chip on this port is "
                       f"{esp.CHIP_NAME} (chip id {esp.IMAGE_CHIP_ID}); nothing was written",
                       "flash a build for this board's profile, or check that --port is the board you meant")


def mac_str(mac: Any) -> str:
    return ":".join(f"{b:02x}" for b in mac)


def cmd_version(_: dict) -> dict:
    return {"esptool": esptool.__version__, "python": sys.version.split()[0]}


def cmd_probe(req: dict) -> dict:
    with connect(req["port"], req.get("before", "default-reset")) as esp:
        set_stage("identify")
        sec, has_sec = security_info(esp)
        flash_crypt_cnt = int(sec.get("flash_crypt_cnt", 0) or 0)
        # Nothing here needs a chip id: the ESP32 has none (esptool's chip_id command reads its MAC instead), and the
        # chip is told apart by detect_chip's magic value; read_mac(BASE_MAC) works on every ROM.
        data = {
            "chip": esp.CHIP_NAME,
            "description": esp.get_chip_description(),
            "features": esp.get_chip_features(),
            "mac": mac_str(esp.read_mac("BASE_MAC")),
            "crystal_mhz": esp.get_crystal_freq(),
            "secure_boot": bool(int(sec.get("flags", 0) or 0) & 1),
            "flash_encryption": bin(flash_crypt_cnt).count("1") % 2 == 1,
            "security_info": "read" if has_sec else "unsupported",
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
    expect = req.get("expect_chip_id")
    if expect is not None and (isinstance(expect, bool) or not isinstance(expect, int)):
        raise SidecarError("INVALID_ARGS", f"expect_chip_id must be an integer, got {expect!r}")
    with connect(req["port"], req.get("before", "default-reset")) as esp:
        chip = esp.CHIP_NAME
        check_target(esp, expect)
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
        raise port_open_error(str(e)) or SidecarError(
            "PORT_BUSY_EXTERNAL", str(e), "close any other program using the port")
    try:
        HardReset(port, uses_usb=True)()
    finally:
        port.close()
    return {"mode": "hard"}


# NVS pages are 4 KiB; a read/write partition reserves one of them, and needs three in all (the
# library's check_size rule, repeated here because its own version exits the process on bad input).
NVS_PAGE = 4096


def nvs_size(size: Any) -> tuple[int, int, bool]:
    """(partition size, size for data pages, read_only) for a `size` given as int or "0x4000"."""
    try:
        total = size if isinstance(size, int) and not isinstance(size, bool) else int(str(size), 0)
    except ValueError:
        raise SidecarError("INVALID_ARGS", "size must be an integer (bytes) or a 0x hex string") from None
    if total <= 0 or total % NVS_PAGE != 0:
        raise SidecarError("INVALID_ARGS", f"size {total} is not a positive multiple of {NVS_PAGE}")
    data = total - NVS_PAGE
    if data < 2 * NVS_PAGE:
        # Smaller than 0x3000: a read-only partition without the reserved page.
        return total, total, True
    return total, data, False


def cmd_nvs_gen(req: dict) -> dict:
    from esp_idf_nvs_partition_gen import nvs_partition_gen as nvs

    csv_path, out_path = req.get("csv_path"), req.get("out_path")
    if not isinstance(csv_path, str) or not csv_path or not isinstance(out_path, str) or not out_path:
        raise SidecarError("INVALID_ARGS", "csv_path and out_path must be non-empty strings")
    total, data_size, read_only = nvs_size(req.get("size"))
    set_stage("render")
    tmp = f"{out_path}.partial"
    row = 0
    # The library prints progress and quotes keys and values in its messages; nothing it writes may reach
    # the hub, so its output is captured and dropped, and only the row number and error type get out.
    sink = io.StringIO()
    try:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            with open(csv_path, "rt", encoding="utf8", newline="") as src, open(tmp, "wb") as out:
                with nvs.nvs_open(out, data_size, nvs.Page.VERSION2, read_only=read_only) as image:
                    # As the library's generate(): `#` lines are comments, the header names the columns.
                    for entry in csv.DictReader((line for line in src if not line.startswith("#")), delimiter=","):
                        row += 1
                        key = entry.get("key") or ""
                        if not key or len(key) > 15:
                            raise ValueError("key missing or longer than 15 characters")
                        nvs.write_entry(image, key, entry.get("type"), entry.get("encoding"), entry.get("value"))
        os.replace(tmp, out_path)
    except BaseException as e:  # noqa: BLE001 - SystemExit too: the library exits on some input errors
        with contextlib.suppress(OSError):
            os.remove(tmp)
        if isinstance(e, KeyboardInterrupt):
            raise
        where = f"CSV row {row}" if row else "the CSV"
        raise SidecarError("INVALID_ARGS", f"cannot render the NVS image: {where} ({type(e).__name__})",
                           "check the rendered CSV's types and encodings (spec 06 §6.3)") from None
    finally:
        sink.close()
    return {"out_path": out_path, "size": total, "rows": row}


HANDLERS = {"version": cmd_version, "probe": cmd_probe, "flash": cmd_flash, "reset": cmd_reset,
            "nvs_gen": cmd_nvs_gen}


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
