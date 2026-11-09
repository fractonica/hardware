//! qonu-dash: the UNO Q's 320x172 SPI display and its front panel. Four pages:
//!
//!   1 SYSTEM    Linux vitals: CPU, memory, temperatures, disk, Wi-Fi, the STM32 link
//!   2 SERVICES  the board's services (qonu-*, the Fractonica hub, fr-app-* apps): logs, restart, stop, start;
//!               apps can also be removed
//!   3 CONTROL   a QR code with qonu-web's one-time terminal link, for a phone on the same network
//!   4 WI-FI     the connection and the saved networks; scan, join (the password typed on the LED&KEY module), forget
//!
//! Buttons (header D2 confirm, D3 up, D4 down): up/down change the page or move in a list, confirm opens. The LED&KEY
//! module (a TM1638 on D12/D7/D5) types passwords phone style; otherwise its keys S1..S4 jump to a page, and its
//! digits and LEDs show the time and the CPU load.
//!
//! Each screen is redrawn whole once a second (and at once after a press) through the qonu-link daemon (`draw` ops,
//! then `present`), which keeps it stateless: the picture heals by itself after an MCU reset, a failsafe trip or a
//! display reconnect. It costs about 1 KB on the link and 22 ms of SPI per second.

use std::collections::{HashMap, VecDeque};
use std::ffi::CStr;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const SOCKET: &str = "/run/qonu/link.sock";
const WEB_STATE: &str = "/run/qonu/web.json";
const PAGES: [&str; 4] = ["SYSTEM", "SERVICES", "CONTROL", "WI-FI"];
const P_SYSTEM: usize = 0;
const P_SERVICES: usize = 1;
const P_CONTROL: usize = 2;
const P_WIFI: usize = 3;
const W: i64 = 320;
const HISTORY: usize = 60;

// Palette.
const BG: &str = "#0b0f17";
const PANEL: &str = "#151b26";
const TRACK: &str = "#232c3b";
const TEXT: &str = "#e5e7eb";
const DIM: &str = "#8b95a5";
const ACCENT: &str = "#60a5fa";
const GOOD: &str = "#34d399";
const WARN: &str = "#fbbf24";
const BAD: &str = "#f87171";
const MEM: &str = "#a78bfa";

// ------------------------------------------------------------------ samples

#[derive(Clone, Copy, Default)]
struct CpuTimes {
    busy: u64,
    total: u64,
}

/// Aggregate and per-core counters from /proc/stat.
fn cpu_times() -> Vec<CpuTimes> {
    let stat = fs::read_to_string("/proc/stat").unwrap_or_default();
    stat.lines()
        .filter(|l| l.starts_with("cpu"))
        .map(|l| {
            let v: Vec<u64> = l.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
            let total: u64 = v.iter().take(8).sum(); // user..steal; guest is already in user
            let idle = v.get(3).copied().unwrap_or(0) + v.get(4).copied().unwrap_or(0); // idle + iowait
            CpuTimes { busy: total.saturating_sub(idle), total }
        })
        .collect()
}

fn usage(prev: CpuTimes, now: CpuTimes) -> f64 {
    let dt = now.total.saturating_sub(prev.total);
    if dt == 0 { 0.0 } else { 100.0 * now.busy.saturating_sub(prev.busy) as f64 / dt as f64 }
}

fn meminfo() -> (u64, u64) {
    let mut kb = HashMap::new();
    for l in fs::read_to_string("/proc/meminfo").unwrap_or_default().lines() {
        let mut it = l.split_whitespace();
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
            kb.insert(k.trim_end_matches(':').to_string(), v.parse::<u64>().unwrap_or(0));
        }
    }
    let total = kb.get("MemTotal").copied().unwrap_or(0);
    (total.saturating_sub(kb.get("MemAvailable").copied().unwrap_or(total)), total)
}

/// Thermal zones by type, in degrees C.
fn temps() -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for e in fs::read_dir("/sys/class/thermal").into_iter().flatten().flatten() {
        let p = e.path();
        let t = fs::read_to_string(p.join("type")).unwrap_or_default();
        if let Ok(milli) = fs::read_to_string(p.join("temp")).unwrap_or_default().trim().parse::<f64>() {
            out.insert(t.trim().to_string(), milli / 1000.0);
        }
    }
    out
}

fn max_temp(t: &HashMap<String, f64>, prefix: &str) -> Option<f64> {
    t.iter().filter(|(k, _)| k.starts_with(prefix)).map(|(_, v)| *v).reduce(f64::max)
}

fn read_trim(path: &str) -> String {
    fs::read_to_string(path).unwrap_or_default().trim().to_string()
}

fn disk(path: &str) -> Option<(u64, u64)> {
    let c = std::ffi::CString::new(path).ok()?;
    // SAFETY: statvfs fills the struct we pass; zeroed is a valid initial value.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let frag = s.f_frsize as u64;
    Some(((s.f_blocks - s.f_bfree) as u64 * frag, s.f_blocks as u64 * frag))
}

fn ipv4(ifname: &str) -> Option<String> {
    let mut addrs: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs/freeifaddrs pair; we only read the list in between.
    if unsafe { libc::getifaddrs(&mut addrs) } != 0 {
        return None;
    }
    let mut found = None;
    let mut cur = addrs;
    while !cur.is_null() {
        let a = unsafe { &*cur };
        cur = a.ifa_next;
        if a.ifa_addr.is_null() || unsafe { (*a.ifa_addr).sa_family } as i32 != libc::AF_INET {
            continue;
        }
        if unsafe { CStr::from_ptr(a.ifa_name) }.to_str() == Ok(ifname) {
            let sin = unsafe { &*(a.ifa_addr as *const libc::sockaddr_in) };
            found = Some(std::net::Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr)).to_string());
            break;
        }
    }
    unsafe { libc::freeifaddrs(addrs) };
    found
}

fn net_bytes(ifname: &str) -> (u64, u64) {
    let r = |k| read_trim(&format!("/sys/class/net/{ifname}/statistics/{k}")).parse().unwrap_or(0);
    (r("rx_bytes"), r("tx_bytes"))
}

/// SSID and RSSI from iwd (no wireless extensions in this kernel).
fn wifi() -> (Option<String>, Option<i64>) {
    let out = Command::new("iwctl").args(["station", "wlan0", "show"]).output();
    let Ok(out) = out else { return (None, None) };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut ssid = None;
    let mut rssi = None;
    for line in text.lines() {
        // iwctl colors its output; drop escape sequences before parsing.
        let mut clean = String::new();
        let mut esc = false;
        for c in line.chars() {
            match (esc, c) {
                (false, '\x1b') => esc = true,
                (true, c) if c.is_ascii_alphabetic() => esc = false,
                (true, _) => {}
                (false, c) => clean.push(c),
            }
        }
        let clean = clean.trim();
        if let Some(v) = clean.strip_prefix("Connected network") {
            ssid = Some(v.trim().to_string());
        } else if let Some(v) = clean.strip_prefix("RSSI") {
            rssi = v.trim().trim_end_matches("dBm").trim().parse().ok();
        }
    }
    (ssid, rssi)
}

unsafe extern "C" {
    /// glibc's: (re)reads the time zone. The libc crate leaves it out.
    fn tzset();
}

/// The local time. tzset first: glibc re-reads /etc/localtime when it changed, so a zone set with
/// `timedatectl set-timezone` shows without a restart.
fn local_tm() -> libc::tm {
    // SAFETY: tzset, time and localtime_r with a zeroed tm we own.
    unsafe {
        tzset();
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        tm
    }
}

fn clock() -> String {
    let tm = local_tm();
    format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
}

// ------------------------------------------------------------------ format

fn duration(secs: u64) -> String {
    let (d, h, m) = (secs / 86400, secs / 3600 % 24, secs / 60 % 60);
    if d > 0 { format!("{d}d {h}h") } else if h > 0 { format!("{h}h {m:02}m") } else { format!("{m}m {:02}s", secs % 60) }
}

fn bytes(b: u64) -> String {
    let b = b as f64;
    if b >= 1e9 { format!("{:.1}G", b / 1e9) } else if b >= 1e6 { format!("{:.0}M", b / 1e6) } else { format!("{:.0}K", b / 1e3) }
}

fn rate(bps: f64) -> String {
    if bps >= 1e6 { format!("{:.1}MB/s", bps / 1e6) } else { format!("{:.1}KB/s", bps / 1e3) }
}

fn level(pct: f64, warn: f64, bad: f64) -> &'static str {
    if pct >= bad { BAD } else if pct >= warn { WARN } else { GOOD }
}

// ------------------------------------------------------------------- link

struct Link {
    errors_logged: Instant,
}

impl Link {
    fn call(&mut self, method: &str, params: Value) -> Option<Value> {
        let r = (|| -> Result<Value, String> {
            let mut s = UnixStream::connect(SOCKET).map_err(|e| e.to_string())?;
            s.set_read_timeout(Some(Duration::from_secs(2))).ok();
            writeln!(s, "{}", json!({"id": 1, "method": method, "params": params})).map_err(|e| e.to_string())?;
            let mut line = String::new();
            BufReader::new(s).read_line(&mut line).map_err(|e| e.to_string())?;
            let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if v["ok"] == true { Ok(v["result"].clone()) } else { Err(v["error"].as_str().unwrap_or("?").to_string()) }
        })();
        match r {
            Ok(v) => Some(v),
            Err(e) => {
                // At most one log line a minute while the daemon or MCU is away.
                if self.errors_logged.elapsed() > Duration::from_secs(60) {
                    eprintln!("qonu-dash: {method}: {e}");
                    self.errors_logged = Instant::now();
                }
                None
            }
        }
    }
}

// ------------------------------------------------------------------- draw

struct Ops(Vec<Value>);

impl Ops {
    fn text(&mut self, x: i64, y: i64, font: &str, color: &str, align: &str, text: impl Into<String>) {
        let mut t: String = text.into();
        while t.len() > 64 {
            t.pop();
        }
        self.0.push(json!({"op": "text", "x": x, "y": y, "font": font, "color": color, "align": align, "text": t}));
    }
    fn rect(&mut self, x: i64, y: i64, w: i64, h: i64, color: &str) {
        self.0.push(json!({"op": "rect", "x": x, "y": y, "w": w.max(0), "h": h.max(0), "color": color, "filled": true}));
    }
    /// Horizontal gauge: track plus a filled share.
    fn gauge(&mut self, x: i64, y: i64, w: i64, h: i64, pct: f64, color: &str) {
        self.rect(x, y, w, h, TRACK);
        self.rect(x, y, (w as f64 * pct.clamp(0.0, 100.0) / 100.0).round() as i64, h, color);
    }
}

struct State {
    prev_cpu: Vec<CpuTimes>,
    history: VecDeque<f64>,
    prev_net: (u64, u64),
    prev_at: Instant,
    wifi: (Option<String>, Option<i64>),
    wifi_at: Option<Instant>,
    mcu: Option<Value>,
    mcu_at: Option<Instant>,
    units: Vec<Unit>,
    units_at: Option<Instant>,
}

/// A page's background and its top bar: host and page name, the clock, and one dot per page (the current one lit).
fn header(page: usize) -> Ops {
    let mut o = Ops(vec![json!({"op": "clear", "color": BG})]);
    o.rect(0, 0, W, 19, PANEL);
    o.text(6, 3, "medium", TEXT, "left", read_trim("/proc/sys/kernel/hostname"));
    let name_x = 6 + 8 * (read_trim("/proc/sys/kernel/hostname").len() as i64 + 1);
    o.text(name_x, 5, "small", DIM, "left", PAGES[page]);
    o.text(W / 2 + 30, 3, "medium", ACCENT, "center", clock());
    let n = PAGES.len() as i64;
    for i in 0..n {
        o.rect(W - 4 - 10 * n + i * 10, 7, 6, 6, if i as usize == page { ACCENT } else { TRACK });
    }
    o
}

fn frame(st: &mut State, link: &mut Link) -> Vec<Value> {
    // --- sample
    let cpu = cpu_times();
    let per: Vec<f64> = cpu.iter().zip(st.prev_cpu.iter()).map(|(n, p)| usage(*p, *n)).collect();
    st.prev_cpu = cpu;
    let total = per.first().copied().unwrap_or(0.0);
    let cores = per.get(1..).unwrap_or(&[]).to_vec();
    if st.history.len() == HISTORY {
        st.history.pop_front();
    }
    st.history.push_back(total);

    let (mem_used, mem_total) = meminfo();
    let t = temps();
    let load = read_trim("/proc/loadavg");
    let load: Vec<&str> = load.split_whitespace().collect();
    let uptime = read_trim("/proc/uptime").split_whitespace().next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);

    let now = Instant::now();
    let dt = now.duration_since(st.prev_at).as_secs_f64().max(0.001);
    let net = net_bytes("wlan0");
    let (rx, tx) = ((net.0.saturating_sub(st.prev_net.0)) as f64 / dt, (net.1.saturating_sub(st.prev_net.1)) as f64 / dt);
    st.prev_net = net;
    st.prev_at = now;

    if st.wifi_at.is_none_or(|t| t.elapsed() > Duration::from_secs(10)) {
        st.wifi = wifi();
        st.wifi_at = Some(Instant::now());
    }
    if st.mcu_at.is_none_or(|t| t.elapsed() > Duration::from_secs(5)) {
        st.mcu = link.call("info", json!({}));
        st.mcu_at = Some(Instant::now());
    }
    let stats = link.call("stats", json!({}));

    // --- layout, 320 x 172
    let mut o = header(P_SYSTEM);

    // CPU: big number, per-core bars, 60 s history
    o.text(6, 24, "small", DIM, "left", "CPU");
    o.text(6, 34, "huge", level(total, 50.0, 85.0), "left", format!("{:.0}%", total));
    o.0.push(json!({"op": "bars", "x": 76, "y": 36, "h": 30, "bar_w": 6, "gap": 3, "color": ACCENT, "bg": TRACK,
        "values": cores.iter().map(|v| v.round()).collect::<Vec<_>>()}));
    o.text(116, 24, "small", DIM, "left", format!(
        "load {}  up {}",
        load.get(..3).map(|l| l.join(" ")).unwrap_or_default(),
        duration(uptime as u64)
    ));
    let hist: Vec<f64> = st.history.iter().map(|v| v.round()).collect();
    let hx = W - 6 - (HISTORY as i64) * 3 + 1;
    o.0.push(json!({"op": "bars", "x": hx, "y": 36, "h": 30, "bar_w": 2, "gap": 1, "color": GOOD, "bg": PANEL, "values": hist}));

    // Memory
    let mem_pct = if mem_total > 0 { 100.0 * mem_used as f64 / mem_total as f64 } else { 0.0 };
    o.text(6, 74, "small", DIM, "left", "MEM");
    o.gauge(40, 75, 150, 9, mem_pct, MEM);
    o.text(196, 74, "small", TEXT, "left", format!("{}/{} MB {:.0}%", mem_used / 1024, mem_total / 1024, mem_pct));

    // Temperatures
    o.text(6, 91, "small", DIM, "left", "TEMP");
    let mut x = 40;
    for (label, prefix) in [("CPU", "cpuss"), ("GPU", "gpu"), ("WLAN", "wlan"), ("MDM", "mdm")] {
        if let Some(c) = max_temp(&t, prefix) {
            o.text(x, 89, "medium", level(c, 60.0, 80.0), "left", format!("{label} {c:.0}°"));
            x += 8 * (label.len() as i64 + 5) + 4;
        }
    }

    // Disk
    o.text(6, 108, "small", DIM, "left", "DISK");
    let mut parts = vec![];
    for (name, path) in [("/", "/"), ("/data", "/data")] {
        if let Some((used, size)) = disk(path) {
            parts.push(format!("{name} {}/{} {:.0}%", bytes(used), bytes(size), 100.0 * used as f64 / size.max(1) as f64));
        }
    }
    o.text(40, 108, "small", TEXT, "left", parts.join("   "));

    // Network
    o.text(6, 124, "small", DIM, "left", "WIFI");
    let (ssid, rssi) = &st.wifi;
    let rssi_color = match rssi {
        Some(r) if *r >= -60 => GOOD,
        Some(r) if *r >= -72 => WARN,
        Some(_) => BAD,
        None => DIM,
    };
    o.text(40, 124, "small", TEXT, "left", ssid.clone().unwrap_or_else(|| "not connected".into()));
    if let Some(r) = rssi {
        o.text(W - 6, 124, "small", rssi_color, "right", format!("{r} dBm"));
    }
    o.text(40, 137, "small", DIM, "left", format!(
        "{}  rx {}  tx {}",
        ipv4("wlan0").unwrap_or_else(|| "-".into()),
        rate(rx),
        rate(tx)
    ));

    // Footer: the MCU link
    o.rect(0, 153, W, 19, PANEL);
    let link_up = stats.as_ref().is_some_and(|s| s["link_up"] == true);
    if link_up {
        let s = stats.as_ref().unwrap();
        let fw = st.mcu.as_ref().and_then(|i| i["fw"].as_array().cloned()).map(|v| {
            v.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(".")
        });
        let c = &s["counters"];
        let errs: u64 = ["rx_bad_crc", "rx_bad_frame", "timeouts"].iter().filter_map(|k| c[k].as_u64()).sum();
        let rtt = s["rtt_us"]["p50"].as_u64().map(|us| format!("{:.2} ms", us as f64 / 1000.0)).unwrap_or("-".into());
        o.text(6, 157, "small", DIM, "left", format!(
            "STM32 fw {}  link {}  {} err  {}",
            fw.unwrap_or_else(|| "?".into()),
            rtt,
            errs,
            s["failsafe"].as_str().unwrap_or("?")
        ));
        o.rect(W - 14, 158, 8, 8, GOOD);
    } else {
        o.text(6, 157, "small", BAD, "left", "STM32 link down");
        o.rect(W - 14, 158, 8, 8, BAD);
    }

    o.0.push(json!({"op": "present"}));
    o.0
}

// ------------------------------------------------------------ services page

struct Unit {
    name: String,
    active: String,
    sub: String,
    mem: Option<u64>,
}

/// The board's own services and the deployed apps, in that order: their state and memory from systemd.
fn units() -> Vec<Unit> {
    let listed = Command::new("systemctl")
        .args(["list-units", "--all", "--plain", "--no-legend", "--no-pager", "--type=service"])
        .args(["qonu-*", "fractonica-*", "fr-app-*"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let names: Vec<String> = listed.lines().filter_map(|l| l.split_whitespace().next().map(str::to_string)).collect();
    if names.is_empty() {
        return vec![];
    }
    let shown = Command::new("systemctl")
        .args(["show", "-p", "Id,ActiveState,SubState,MemoryCurrent"])
        .args(&names)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let mut out: Vec<Unit> = shown
        .split("\n\n")
        .filter_map(|block| {
            let get = |k: &str| block.lines().find_map(|l| l.strip_prefix(k)).map(str::to_string);
            let id = get("Id=")?;
            Some(Unit {
                name: id.trim_end_matches(".service").to_string(),
                active: get("ActiveState=").unwrap_or_default(),
                sub: get("SubState=").unwrap_or_default(),
                mem: get("MemoryCurrent=").and_then(|m| m.parse().ok()),
            })
        })
        .collect();
    // One-shot setup units (qonu-mcu-boot0, the USB gadget) finish at boot: not services to watch.
    out.retain(|u| u.sub != "exited");
    // Apps after the board's own services; each group by name.
    out.sort_by_key(|u| (u.name.starts_with("fr-app-"), u.name.clone()));
    out
}

fn refresh_units(st: &mut State) {
    if st.units_at.is_none_or(|t| t.elapsed() > Duration::from_secs(2)) {
        st.units = units();
        st.units_at = Some(Instant::now());
    }
}

fn state_color(active: &str) -> &'static str {
    match active {
        "active" => GOOD,
        "activating" | "deactivating" | "reloading" => WARN,
        "failed" => BAD,
        _ => DIM,
    }
}

/// The services list; with `cursor`, that row is selected (and the list scrolls to keep it in view).
fn services_page(st: &mut State, cursor: Option<usize>) -> Ops {
    refresh_units(st);
    let mut o = header(P_SERVICES);
    let running = st.units.iter().filter(|u| u.active == "active").count();
    let failed = st.units.iter().filter(|u| u.active == "failed").count();
    let apps = st.units.iter().filter(|u| u.name.starts_with("fr-app-")).count();
    const ROWS: usize = 9;
    let top = cursor.map_or(0, |c| c.saturating_sub(ROWS - 1));
    let mut y = 24;
    for (i, u) in st.units.iter().enumerate().skip(top).take(ROWS) {
        let selected = cursor == Some(i);
        if selected {
            o.rect(2, y - 1, W - 4, 14, ACCENT);
        }
        o.rect(8, y + 3, 7, 7, if selected { BG } else { state_color(&u.active) });
        let (name, label) = match u.name.strip_prefix("fr-app-") {
            Some(app) => (app.to_string(), "app"),
            None => (u.name.clone(), ""),
        };
        let fg = if selected { BG } else if u.active == "active" { TEXT } else { DIM };
        o.text(22, y, "medium", fg, "left", name);
        o.text(170, y + 2, "small", if selected { BG } else { DIM }, "left", format!("{label} {}", u.sub).trim().to_string());
        if let Some(m) = u.mem.filter(|_| u.active == "active") {
            o.text(W - 8, y + 2, "small", if selected { BG } else { DIM }, "right", bytes(m));
        }
        y += 14;
    }
    if st.units.is_empty() {
        o.text(W / 2, 80, "medium", DIM, "center", "no services found");
    }
    o.rect(0, 153, W, 19, PANEL);
    if cursor.is_some() {
        o.text(6, 157, "small", DIM, "left", "up/down: choose   confirm: open");
    } else {
        o.text(6, 157, "small", DIM, "left", format!(
            "{running} running  {failed} failed  {apps} app{}   confirm: select",
            if apps == 1 { "" } else { "s" }
        ));
    }
    if failed > 0 {
        o.rect(W - 14, 158, 8, 8, BAD);
    }
    o
}

// ------------------------------------------------------- service actions

/// Units the display needs: stopping them would leave nobody to show the way back.
const KEEP_RUNNING: [&str; 2] = ["qonu-dash", "qonu-link"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Action {
    Logs,
    Restart,
    Stop,
    Start,
    Remove,
    Back,
}

impl Action {
    fn label(self) -> &'static str {
        match self {
            Action::Logs => "Logs",
            Action::Restart => "Restart",
            Action::Stop => "Stop",
            Action::Start => "Start",
            Action::Remove => "Remove",
            Action::Back => "Back",
        }
    }
}

fn actions(u: Option<&Unit>, name: &str) -> Vec<Action> {
    let active = u.is_some_and(|u| u.active == "active" || u.active == "activating");
    let mut a = vec![Action::Logs, Action::Restart];
    if !active {
        a.push(Action::Start);
    } else if !KEEP_RUNNING.contains(&name) {
        a.push(Action::Stop);
    }
    if name.starts_with("fr-app-") {
        a.push(Action::Remove);
    }
    a.push(Action::Back);
    a
}

/// `systemctl --no-block <verb> <unit>`: queued, so the display never waits on a slow stop (or on its own restart).
fn systemctl(verb: &str, unit: &str) -> String {
    let ok = Command::new("systemctl")
        .args(["--no-block", verb, &format!("{unit}.service")])
        .status()
        .is_ok_and(|s| s.success());
    eprintln!("qonu-dash: systemctl {verb} {unit}: {}", if ok { "queued" } else { "failed" });
    match (ok, verb) {
        (false, _) => format!("{verb} {unit} failed"),
        (true, "restart") => format!("restarting {unit}"),
        (true, "stop") => format!("stopping {unit}"),
        (true, _) => format!("starting {unit}"),
    }
}

fn menu_page(st: &mut State, unit: &str, cursor: usize) -> Ops {
    refresh_units(st);
    let u = st.units.iter().find(|u| u.name == unit);
    let mut o = header(P_SERVICES);
    o.text(8, 26, "large", TEXT, "left", unit.trim_start_matches("fr-app-"));
    let (active, sub) = u.map_or(("gone".into(), String::new()), |u| (u.active.clone(), u.sub.clone()));
    o.rect(8, 53, 7, 7, state_color(&active));
    let mem = u.and_then(|u| u.mem).filter(|_| active == "active").map(|m| format!("  {}", bytes(m))).unwrap_or_default();
    o.text(20, 51, "small", DIM, "left", format!("{active} {sub}{mem}"));
    let items = actions(u, unit);
    let mut y = 68;
    for (i, a) in items.iter().enumerate() {
        let selected = i == cursor.min(items.len() - 1);
        o.rect(8, y - 2, 140, 16, if selected { ACCENT } else { PANEL });
        o.text(16, y, "medium", if selected { BG } else { TEXT }, "left", a.label());
        y += 17;
    }
    if KEEP_RUNNING.contains(&unit) {
        o.text(160, 72, "small", DIM, "left", "No Stop here: the");
        o.text(160, 84, "small", DIM, "left", "display needs it.");
    }
    o.rect(0, 153, W, 19, PANEL);
    o.text(6, 157, "small", DIM, "left", "up/down: choose   confirm: do it");
    o
}

const LOG_COLS: usize = 53; // 320 px / 6 px per character of the small font
const LOG_ROWS: usize = 13;

/// The unit's journal for this boot, wrapped to the panel's width (oldest first).
fn log_lines(unit: &str) -> Vec<String> {
    let text = Command::new("journalctl")
        .args(["-u", &format!("{unit}.service"), "-b", "-n", "300", "--no-pager", "-o", "cat"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let mut out = vec![];
    for line in text.lines() {
        let chars: Vec<char> = line.chars().filter(|c| !c.is_control()).collect();
        if chars.is_empty() {
            out.push(String::new());
        }
        for chunk in chars.chunks(LOG_COLS) {
            out.push(chunk.iter().collect());
        }
    }
    if out.is_empty() {
        out.push("(no log lines this boot)".into());
    }
    out
}

/// The last LOG_ROWS lines, `back` lines up from the end.
fn logs_page(lines: &[String], unit: &str, back: usize) -> Ops {
    let mut o = header(P_SERVICES);
    let end = lines.len().saturating_sub(back);
    let start = end.saturating_sub(LOG_ROWS);
    let mut y = 22;
    for l in &lines[start..end] {
        o.text(2, y, "small", TEXT, "left", l.clone());
        y += 10;
    }
    o.rect(0, 153, W, 19, PANEL);
    let pos = if back == 0 { "end (following)".to_string() } else { format!("{back} lines up") };
    o.text(6, 157, "small", DIM, "left", format!("{} log  {pos}", unit.trim_start_matches("fr-app-")));
    o.text(W - 6, 157, "small", DIM, "right", "confirm: back");
    o
}

// ------------------------------------------------------------- control page

/// qonu-web's current one-time terminal link and when it expires (unix seconds).
fn terminal_link() -> Option<(String, u64)> {
    let v: Value = serde_json::from_str(&fs::read_to_string(WEB_STATE).ok()?).ok()?;
    let ip = ipv4("wlan0")?;
    let port = v["port"].as_u64().unwrap_or(80);
    let host = if port == 80 { ip } else { format!("{ip}:{port}") };
    Some((format!("http://{host}{}", v["path"].as_str()?), v["expires_s"].as_u64().unwrap_or(0)))
}

fn control_page() -> Ops {
    let mut o = header(P_CONTROL);
    match terminal_link() {
        Some((url, expires)) => match qrcode::QrCode::with_error_correction_level(url.as_bytes(), qrcode::EcLevel::L) {
            Ok(code) => {
                let w = code.width();
                let avail = 172 - 19 - 4; // under the top bar, with a little margin
                let scale = (avail / (w as i64 + 6)).clamp(1, 5); // the code plus a 3-module quiet zone each side
                let side = (w as i64 + 6) * scale;
                let (x, y) = (6, 19 + (172 - 19 - side) / 2);
                o.rect(x, y, side, side, "#ffffff");
                let colors = code.to_colors();
                let rows: Vec<String> = colors
                    .chunks(w)
                    .map(|r| r.iter().map(|c| if *c == qrcode::Color::Dark { '#' } else { '.' }).collect())
                    .collect();
                o.0.push(json!({"op": "bitmap", "x": x + 3 * scale, "y": y + 3 * scale, "scale": scale,
                                "fg": "#000000", "rows": rows}));
                let tx = x + side + 10;
                o.text(tx, 26, "medium", TEXT, "left", "Scan to open");
                o.text(tx, 42, "medium", TEXT, "left", "a terminal");
                o.text(tx, 64, "small", DIM, "left", "Same Wi-Fi network.");
                o.text(tx, 76, "small", DIM, "left", "Each code opens one");
                o.text(tx, 88, "small", DIM, "left", "session.");
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                let left = expires.saturating_sub(now);
                o.text(tx, 106, "small", ACCENT, "left", format!("new code in {}:{:02}", left / 60, left % 60));
                let host = url.trim_start_matches("http://").split('/').next().unwrap_or("").to_string();
                o.text(tx, 124, "small", DIM, "left", host);
                o.text(tx, 150, "small", DIM, "left", "confirm: new code");
            }
            Err(_) => o.text(W / 2, 80, "medium", BAD, "center", "link too long for a QR code"),
        },
        None => {
            o.text(W / 2, 64, "medium", WARN, "center", "No terminal link");
            let why = if ipv4("wlan0").is_none() { "Wi-Fi is not connected" } else { "qonu-web is not running" };
            o.text(W / 2, 86, "small", DIM, "center", why);
        }
    }
    // No footer bar here: the code takes the whole height under the top bar (a 29-module code at 4 px with its quiet
    // zone is 140 px of the 153).
    o
}

// ------------------------------------------------------------ confirmations

/// What a yes/no screen asks.
enum Ask {
    Stop(String),
    Remove(String),
    Forget(Net),
}

fn ask_page(ask: &Ask) -> Ops {
    let (page, title, lines, verb): (usize, String, Vec<&str>, &str) = match ask {
        Ask::Stop(unit) => (
            P_SERVICES,
            format!("Stop {}?", unit.trim_start_matches("fr-app-")),
            vec!["It stays stopped until started again", "or the board restarts."],
            "stop",
        ),
        Ask::Remove(unit) => (
            P_SERVICES,
            format!("Remove {}?", unit.trim_start_matches("fr-app-")),
            vec!["It stops and leaves the board. Its data", "and settings stay for a redeploy", "(fr app rm --purge deletes them too)."],
            "remove",
        ),
        Ask::Forget(net) => (
            P_WIFI,
            format!("Forget {}?", clip(&net.name, 20)),
            if net.connected {
                vec!["The board deletes its password", "and leaves this network now."]
            } else {
                vec!["The board deletes its password."]
            },
            "forget",
        ),
    };
    let mut o = header(page);
    o.text(W / 2, 46, "large", WARN, "center", title);
    let mut y = 78;
    for l in lines {
        o.text(W / 2, y, "small", DIM, "center", l);
        y += 12;
    }
    footer(&mut o, &format!("confirm: {verb}   up/down: cancel"), None);
    o
}

/// `fr app rm NAME` on its own thread (the CLI takes a few seconds to start on the board): the hub stops the app and
/// deletes its unit and releases, keeping its data and settings.
fn remove_app(unit: &str, tx: &Sender<Input>) {
    let app = unit.trim_start_matches("fr-app-").to_string();
    let tx = tx.clone();
    thread::spawn(move || {
        let msg = match Command::new("fr").args(["app", "rm", &app]).output() {
            Ok(o) if o.status.success() => format!("removed {app}"),
            Ok(o) => {
                let out = format!("{}\n{}", String::from_utf8_lossy(&o.stderr), String::from_utf8_lossy(&o.stdout));
                format!("{app}: {}", out.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("failed"))
            }
            Err(e) => format!("{app}: {e}"),
        };
        eprintln!("qonu-dash: fr app rm: {msg}");
        let _ = tx.send(Input::Note(Note::Toast(msg)));
    });
}

fn footer(o: &mut Ops, hint: &str, busy: Option<&str>) {
    o.rect(0, 153, W, 19, PANEL);
    o.text(6, 157, "small", DIM, "left", hint.to_string());
    if let Some(b) = busy {
        o.text(W - 6, 157, "small", ACCENT, "right", b.to_string());
    }
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { s.chars().take(n.saturating_sub(1)).collect::<String>() + "~" }
}

// ------------------------------------------------------------------- wi-fi

/// iwd on the system bus, through busctl's JSON output (no D-Bus library needed).
const IWD: &str = "net.connman.iwd";

/// `busctl --json=short ARGS`: the reply (`{"type": .., "data": [..]}`), or what busctl said went wrong.
fn busctl(args: &[&str]) -> Result<Value, String> {
    let out = Command::new("busctl").arg("--json=short").args(args).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("busctl: {}", out.status) } else { err });
    }
    if out.stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

#[derive(Clone, Debug)]
struct Net {
    /// iwd's Network object; empty for a saved network out of range.
    path: String,
    name: String,
    /// psk, open, 8021x, wep
    kind: String,
    connected: bool,
    /// The KnownNetwork object, when the board has a profile (a password) for it.
    known: Option<String>,
    dbm: Option<i64>,
}

#[derive(Clone, Default)]
struct WifiView {
    station: Option<String>,
    state: String,
    /// In range, strongest first, then saved networks out of range.
    nets: Vec<Net>,
    /// Every saved network: (KnownNetwork object, name).
    known: Vec<(String, String)>,
    /// What a background job is doing, shown in the footer.
    busy: Option<String>,
    at: Option<Instant>,
}

struct WifiShared {
    view: Mutex<WifiView>,
    refreshing: AtomicBool,
}
type Wifi = Arc<WifiShared>;

/// iwd's objects: the station, the networks it sees and the saved profiles.
fn iwd_view() -> Result<WifiView, String> {
    let objs = busctl(&["call", IWD, "/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects"])?;
    let objs = objs["data"][0].as_object().cloned().unwrap_or_default();
    let prop = |o: &Value, iface: &str, k: &str| o[iface][k]["data"].clone();
    let mut v = WifiView::default();
    for (path, o) in &objs {
        if o.get("net.connman.iwd.Station").is_some() && v.station.is_none() {
            v.station = Some(path.clone());
            v.state = prop(o, "net.connman.iwd.Station", "State").as_str().unwrap_or("").to_string();
        }
        let n = "net.connman.iwd.Network";
        if o.get(n).is_some() {
            v.nets.push(Net {
                path: path.clone(),
                name: prop(o, n, "Name").as_str().unwrap_or("?").to_string(),
                kind: prop(o, n, "Type").as_str().unwrap_or("?").to_string(),
                connected: prop(o, n, "Connected").as_bool().unwrap_or(false),
                known: prop(o, n, "KnownNetwork").as_str().map(str::to_string),
                dbm: None,
            });
        }
        let k = "net.connman.iwd.KnownNetwork";
        if o.get(k).is_some() {
            v.known.push((path.clone(), prop(o, k, "Name").as_str().unwrap_or("?").to_string()));
        }
    }
    if let Some(station) = &v.station {
        if let Ok(r) = busctl(&["call", IWD, station, "net.connman.iwd.Station", "GetOrderedNetworks"]) {
            // a(on): (network, signal in 100 * dBm), strongest first
            let order: Vec<(String, i64)> = r["data"][0]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| Some((e[0].as_str()?.to_string(), e[1].as_i64()?)))
                .collect();
            for n in &mut v.nets {
                n.dbm = order.iter().find(|(p, _)| *p == n.path).map(|(_, s)| s / 100);
            }
            v.nets.sort_by_key(|n| (order.iter().position(|(p, _)| *p == n.path).unwrap_or(usize::MAX), n.name.clone()));
        }
    }
    v.known.sort_by(|a, b| a.1.cmp(&b.1));
    for (path, name) in &v.known {
        if !v.nets.iter().any(|n| n.known.as_deref() == Some(path)) {
            let kind = prop(&objs[path.as_str()], "net.connman.iwd.KnownNetwork", "Type").as_str().unwrap_or("?").to_string();
            v.nets.push(Net { path: String::new(), name: name.clone(), kind, connected: false, known: Some(path.clone()), dbm: None });
        }
    }
    Ok(v)
}

fn wifi_refresh(w: &Wifi) {
    match iwd_view() {
        Ok(mut v) => {
            let mut cur = w.view.lock().unwrap();
            v.busy = cur.busy.take();
            v.at = Some(Instant::now());
            *cur = v;
        }
        Err(e) => {
            eprintln!("qonu-dash: iwd: {e}");
            w.view.lock().unwrap().at = Some(Instant::now());
        }
    }
}

/// A refresh on its own thread (busctl waits on iwd), one at a time.
fn wifi_refresh_async(w: &Wifi) {
    if w.refreshing.swap(true, Ordering::SeqCst) {
        return;
    }
    let w = w.clone();
    thread::spawn(move || {
        wifi_refresh(&w);
        w.refreshing.store(false, Ordering::SeqCst);
    });
}

/// Runs a Wi-Fi job on its own thread with `busy` in the footer; false when another one is running.
fn wifi_job(w: &Wifi, tx: &Sender<Input>, busy: &str, job: impl FnOnce(&Wifi, &Sender<Input>) + Send + 'static) -> bool {
    {
        let mut v = w.view.lock().unwrap();
        if v.busy.is_some() {
            return false;
        }
        v.busy = Some(busy.to_string());
    }
    let (w, tx) = (w.clone(), tx.clone());
    thread::spawn(move || {
        job(&w, &tx);
        wifi_refresh(&w);
        w.view.lock().unwrap().busy = None;
        let _ = tx.send(Input::Note(Note::Redraw));
    });
    true
}

fn scan(w: &Wifi, _tx: &Sender<Input>) {
    wifi_refresh(w);
    let Some(station) = w.view.lock().unwrap().station.clone() else { return };
    // An error here is mostly "Busy": a scan is running already, and the wait below covers it.
    let _ = busctl(&["call", IWD, &station, "net.connman.iwd.Station", "Scan"]);
    let until = Instant::now() + Duration::from_secs(15);
    thread::sleep(Duration::from_millis(500));
    while Instant::now() < until {
        let scanning = busctl(&["get-property", IWD, &station, "net.connman.iwd.Station", "Scanning"])
            .is_ok_and(|v| v["data"] == true);
        if !scanning {
            break;
        }
        thread::sleep(Duration::from_millis(400));
    }
}

/// iwd's profile file for an SSID: the name as is when it is only letters, digits, space, `_` and `-`, otherwise `=`
/// and its bytes in hex (as scripts/add-wifi.sh writes them).
fn iwd_profile(ssid: &str, kind: &str) -> String {
    let plain = !ssid.is_empty() && ssid.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'_' | b'-'));
    let name = if plain { ssid.to_string() } else { format!("={}", ssid.bytes().map(|b| format!("{b:02x}")).collect::<String>()) };
    format!("/var/lib/iwd/{name}.{kind}")
}

fn write_private(path: &str, data: &[u8]) -> std::io::Result<()> {
    fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?.write_all(data)
}

/// Joins `net`. With a password, its profile is written first (iwd picks new profiles up as they appear); when the
/// network refuses it, the profile goes back to how it was. The password is never logged.
fn connect(_w: &Wifi, tx: &Sender<Input>, net: Net, pass: Option<String>) {
    let say = |m: String| {
        eprintln!("qonu-dash: wi-fi: {m}");
        let _ = tx.send(Input::Note(Note::Toast(m)));
    };
    let mut restore = None;
    if let Some(pass) = &pass {
        let file = iwd_profile(&net.name, "psk");
        let before = fs::read(&file).ok();
        // iwd's settings syntax: a backslash and spaces are escaped.
        let esc: String = pass.chars().map(|c| match c {
            '\\' => "\\\\".to_string(),
            ' ' => "\\s".to_string(),
            c => c.to_string(),
        }).collect();
        if let Err(e) = write_private(&file, format!("[Security]\nPassphrase={esc}\n").as_bytes()) {
            return say(format!("cannot save the password: {e}"));
        }
        restore = Some((file, before));
        thread::sleep(Duration::from_millis(500));
    }
    match busctl(&["--timeout=45", "call", IWD, &net.path, "net.connman.iwd.Network", "Connect"]) {
        Ok(_) => {
            let mut ip = None;
            for _ in 0..20 {
                thread::sleep(Duration::from_millis(500));
                if let Some(a) = ipv4("wlan0") {
                    ip = Some(a);
                    break;
                }
            }
            let _ = tx.send(Input::Note(Note::Joined(net.name.clone())));
            say(match ip {
                Some(ip) => format!("joined {}: {ip}", clip(&net.name, 14)),
                None => format!("joined {}, no address yet", clip(&net.name, 14)),
            });
        }
        Err(e) => {
            if let Some((file, before)) = restore {
                let _ = match before {
                    Some(b) => write_private(&file, &b),
                    None => fs::remove_file(&file),
                };
            }
            eprintln!("qonu-dash: wi-fi: connect {}: {e}", net.name);
            let why = e.rsplit(": ").next().unwrap_or(&e).trim().to_string();
            let why = if why.contains("failed") || why.contains("Failed") { "failed (wrong password?)".to_string() } else { why };
            say(format!("{}: {why}", clip(&net.name, 12)));
        }
    }
}

fn forget(tx: &Sender<Input>, net: &Net) {
    let Some(known) = &net.known else { return };
    let msg = match busctl(&["call", IWD, known, "net.connman.iwd.KnownNetwork", "Forget"]) {
        Ok(_) => format!("forgot {}", clip(&net.name, 20)),
        Err(e) => format!("{}: {e}", clip(&net.name, 12)),
    };
    eprintln!("qonu-dash: wi-fi: {msg}");
    let _ = tx.send(Input::Note(Note::Toast(msg)));
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum WifiAction {
    Join,
    Password,
    Forget,
    Back,
}

fn wifi_actions(n: &Net) -> Vec<WifiAction> {
    let here = !n.path.is_empty();
    let mut a = vec![];
    if here && !n.connected && (n.known.is_some() || n.kind == "open") {
        a.push(WifiAction::Join);
    }
    if here && n.kind == "psk" {
        a.push(WifiAction::Password);
    }
    if n.known.is_some() {
        a.push(WifiAction::Forget);
    }
    a.push(WifiAction::Back);
    a
}

fn signal_color(dbm: Option<i64>) -> &'static str {
    match dbm {
        Some(d) if d >= -60 => GOOD,
        Some(d) if d >= -72 => WARN,
        Some(_) => BAD,
        None => DIM,
    }
}

/// Four bars, 15 px wide, bottom at `y + 9`.
fn signal_bars(o: &mut Ops, x: i64, y: i64, dbm: Option<i64>, fg: &str) {
    let lit = match dbm {
        Some(d) if d >= -60 => 4,
        Some(d) if d >= -67 => 3,
        Some(d) if d >= -75 => 2,
        Some(_) => 1,
        None => 0,
    };
    for i in 0..4 {
        let h = 3 + 2 * i;
        o.rect(x + i * 4, y + 9 - h, 3, h, if i < lit { fg } else { TRACK });
    }
}

fn wifi_page(view: &WifiView, st: &State) -> Ops {
    let mut o = header(P_WIFI);
    let here = view.nets.iter().find(|n| n.connected);
    let ssid = here.map(|n| n.name.clone()).or_else(|| st.wifi.0.clone());
    let dbm = here.and_then(|n| n.dbm).or(st.wifi.1);
    match ssid {
        Some(s) => {
            o.text(8, 25, "large", TEXT, "left", clip(&s, 26));
            signal_bars(&mut o, W - 24, 29, dbm, signal_color(dbm));
            o.text(8, 50, "small", GOOD, "left", "connected");
            o.text(70, 50, "small", DIM, "left", format!(
                "{}   {}",
                ipv4("wlan0").unwrap_or_else(|| "no address yet".into()),
                dbm.map(|d| format!("{d} dBm")).unwrap_or_default()
            ));
        }
        None => {
            o.text(8, 25, "large", WARN, "left", "Not connected");
            o.text(8, 50, "small", DIM, "left", if view.state.is_empty() { "iwd: no answer".to_string() } else { format!("iwd: {}", view.state) });
        }
    }
    o.text(8, 70, "small", DIM, "left", "SAVED NETWORKS");
    let mut y = 83;
    for (_, name) in view.known.iter().take(4) {
        o.text(16, y, "medium", TEXT, "left", clip(name, 36));
        y += 15;
    }
    if view.known.len() > 4 {
        o.text(16, y, "small", DIM, "left", format!("and {} more", view.known.len() - 4));
    } else if view.known.is_empty() {
        o.text(16, y, "small", DIM, "left", "none yet");
    }
    footer(&mut o, "confirm: find networks", view.busy.as_deref());
    o
}

const WIFI_ROWS: usize = 8;

fn wifi_list_page(view: &WifiView, cursor: usize) -> Ops {
    let mut o = header(P_WIFI);
    let top = cursor.saturating_sub(WIFI_ROWS - 1);
    let mut y = 23;
    for (i, n) in view.nets.iter().enumerate().skip(top).take(WIFI_ROWS) {
        let sel = i == cursor;
        if sel {
            o.rect(2, y - 1, W - 4, 15, ACCENT);
        }
        signal_bars(&mut o, 8, y + 2, n.dbm, if sel { BG } else { signal_color(n.dbm) });
        o.text(28, y, "medium", if sel { BG } else { TEXT }, "left", clip(&n.name, 26));
        let tag = if n.connected {
            "connected"
        } else if n.path.is_empty() {
            "saved, away"
        } else if n.known.is_some() {
            "saved"
        } else if n.kind == "psk" {
            ""
        } else {
            n.kind.as_str()
        };
        o.text(W - 8, y + 2, "small", if sel { BG } else if n.connected { GOOD } else { DIM }, "right", tag);
        y += 16;
    }
    if view.nets.is_empty() {
        let msg = if view.busy.is_some() { "looking for networks..." } else { "no networks; confirm: scan again" };
        o.text(W / 2, 70, "medium", DIM, "center", msg);
    }
    footer(&mut o, "up/down: choose   confirm: open", view.busy.as_deref());
    o
}

fn wifi_menu_page(view: &WifiView, net: &Net, cursor: usize) -> Ops {
    let mut o = header(P_WIFI);
    o.text(8, 26, "large", TEXT, "left", clip(&net.name, 30));
    let kind = match net.kind.as_str() {
        "psk" => "password",
        k => k,
    };
    let status = if net.connected {
        ", connected"
    } else if net.path.is_empty() {
        ", saved, out of range"
    } else if net.known.is_some() {
        ", saved"
    } else {
        ""
    };
    o.text(8, 51, "small", DIM, "left", format!("{kind}{status}{}", net.dbm.map(|d| format!(", {d} dBm")).unwrap_or_default()));
    let items = wifi_actions(net);
    let mut y = 68;
    for (i, a) in items.iter().enumerate() {
        let selected = i == cursor.min(items.len() - 1);
        let label = match a {
            WifiAction::Join => "Connect",
            WifiAction::Password if net.known.is_some() => "New password",
            WifiAction::Password => "Password",
            WifiAction::Forget => "Forget",
            WifiAction::Back => "Back",
        };
        o.rect(8, y - 2, 140, 16, if selected { ACCENT } else { PANEL });
        o.text(16, y, "medium", if selected { BG } else { TEXT }, "left", label);
        y += 17;
    }
    footer(&mut o, "up/down: choose   confirm: do it", view.busy.as_deref());
    o
}

// -------------------------------------------------------------- text entry

/// Phone-style typing on the LED&KEY's keys: a key cycles through its letters, a pause (or another key) keeps the
/// letter shown. UP switches abc / ABC / 123, DOWN deletes.
const MULTITAP: Duration = Duration::from_millis(1200);
const LETTERS: [&str; 7] = ["abcd", "efgh", "ijkl", "mnop", "qrst", "uvwx", "yz "];
const SYMBOLS: &str = ".-_@!?#$%&*+=/:;,'\"()[]{}<>~^|\\`";
/// The most a WPA passphrase takes.
const PASS_MAX: usize = 63;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Case {
    Lower,
    Upper,
    Digits,
}

impl Case {
    fn label(self) -> &'static str {
        match self {
            Case::Lower => "abc",
            Case::Upper => "ABC",
            Case::Digits => "123",
        }
    }
    fn next(self) -> Case {
        match self {
            Case::Lower => Case::Upper,
            Case::Upper => Case::Digits,
            Case::Digits => Case::Lower,
        }
    }
}

struct Entry {
    net: Net,
    text: String,
    /// The key whose letter is still open, which of its letters, and when it was last pressed.
    pending: Option<(usize, usize, Instant)>,
    case: Case,
}

impl Entry {
    /// What key `k` (0 = S1) cycles through.
    fn group(&self, k: usize) -> Vec<char> {
        match (self.case, k) {
            (Case::Digits, 0..=6) => vec![char::from(b'1' + k as u8)],
            (Case::Digits, _) => vec!['8', '9', '0'],
            (_, 7) => SYMBOLS.chars().collect(),
            (Case::Upper, k) => LETTERS[k].to_uppercase().chars().collect(),
            (Case::Lower, k) => LETTERS[k].chars().collect(),
        }
    }

    fn pending_char(&self) -> Option<char> {
        self.pending.map(|(k, i, _)| self.group(k)[i])
    }

    fn push(&mut self, c: char) {
        if self.text.chars().count() < PASS_MAX {
            self.text.push(c);
        }
    }

    fn commit(&mut self) {
        if let Some(c) = self.pending_char() {
            self.push(c);
        }
        self.pending = None;
    }

    fn key(&mut self, k: usize) {
        if k >= 8 {
            return;
        }
        let g = self.group(k);
        match self.pending {
            Some((pk, i, at)) if pk == k && at.elapsed() < MULTITAP && g.len() > 1 => {
                self.pending = Some((k, (i + 1) % g.len(), Instant::now()));
            }
            _ => {
                self.commit();
                if g.len() == 1 {
                    self.push(g[0]);
                } else {
                    self.pending = Some((k, 0, Instant::now()));
                }
            }
        }
    }

    /// Drops the open letter, else the last one; false when there was nothing to delete.
    fn delete(&mut self) -> bool {
        if self.pending.take().is_some() {
            return true;
        }
        self.text.pop().is_some()
    }

    /// Keeps the open letter once its key has rested; true when that changed something.
    fn expire(&mut self) -> bool {
        if self.pending.is_some_and(|(_, _, at)| at.elapsed() >= MULTITAP) {
            self.commit();
            return true;
        }
        false
    }

    fn deadline(&self) -> Option<Instant> {
        self.pending.map(|(_, _, at)| at + MULTITAP)
    }

    fn shown(&self) -> String {
        let mut s = self.text.clone();
        s.extend(self.pending_char());
        s
    }
}

fn text_page(e: &Entry, busy: Option<&str>) -> Ops {
    let mut o = header(P_WIFI);
    o.text(8, 23, "medium", ACCENT, "left", format!("{}  password", clip(&e.net.name, 20)));
    o.rect(W - 46, 21, 40, 16, PANEL);
    o.text(W - 26, 23, "medium", TEXT, "center", e.case.label());

    // The input (its end when long), the open letter highlighted, else a cursor.
    o.rect(4, 40, W - 8, 26, PANEL);
    const VISIBLE: usize = 28;
    let pend = e.pending_char();
    let typed: Vec<char> = e.text.chars().collect();
    let skip = (typed.len() + pend.is_some() as usize).saturating_sub(VISIBLE);
    let vis: String = typed.iter().skip(skip).collect();
    if skip > 0 {
        o.text(7, 47, "small", DIM, "left", "<");
    }
    o.text(16, 43, "large", TEXT, "left", vis.clone());
    let cx = 16 + 10 * vis.chars().count() as i64;
    match pend {
        Some(c) => {
            o.rect(cx, 42, 10, 22, ACCENT);
            o.text(cx, 43, "large", BG, "left", c.to_string());
        }
        None => o.rect(cx + 1, 43, 2, 20, ACCENT),
    }

    // The open key's letters, or how long the password is.
    let y = 72;
    match e.pending {
        Some((k, i, _)) => {
            let g = e.group(k);
            const CELLS: usize = 18;
            let start = if g.len() <= CELLS { 0 } else { i.saturating_sub(CELLS / 2).min(g.len() - CELLS) };
            let mut x = 8;
            for (j, c) in g.iter().enumerate().skip(start).take(CELLS) {
                if j == i {
                    o.rect(x - 1, y - 1, 15, 15, ACCENT);
                }
                let fg = if j == i { BG } else { TEXT };
                if *c == ' ' {
                    o.text(x + 7, y + 2, "small", fg, "center", "sp");
                } else {
                    o.text(x + 7, y, "medium", fg, "center", c.to_string());
                }
                x += 16;
            }
        }
        None => {
            let n = e.text.chars().count();
            let note = if n < 8 { " (8 at least)" } else { "" };
            o.text(8, y + 1, "small", if n < 8 { WARN } else { DIM }, "left", format!("{n} characters{note}"));
        }
    }

    // What each key gives.
    let legend = match e.case {
        Case::Digits => ["S1 1   S2 2   S3 3   S4 4".to_string(), "S5 5   S6 6   S7 7   S8 8 9 0".to_string()],
        case => {
            let g = |k: usize| {
                let s = LETTERS[k].trim_end();
                if case == Case::Upper { s.to_uppercase() } else { s.to_string() }
            };
            [format!("S1 {} S2 {} S3 {} S4 {}", g(0), g(1), g(2), g(3)), format!("S5 {} S6 {} S7 {} sp S8 #?!.", g(4), g(5), g(6))]
        }
    };
    o.text(8, 93, "medium", TEXT, "left", legend[0].clone());
    o.text(8, 109, "medium", TEXT, "left", legend[1].clone());
    o.text(8, 129, "small", DIM, "left", "UP abc/ABC/123   DOWN delete   hold a key: next");
    footer(&mut o, "confirm: connect   down when empty: back", busy);
    o
}

// ------------------------------------------------------------------- input

/// What wakes the main loop: a button or key edge from qonu-link, or word from a background job.
enum Input {
    Button(u8, bool),
    Note(Note),
}

enum Note {
    Toast(String),
    /// The board joined this network: a kept password draft is no longer needed.
    Joined(String),
    Redraw,
}

/// Front-panel buttons and LED&KEY keys from qonu-link (`subscribe`): id 0 confirm, 1 up, 2 down, 8..15 S1..S8.
/// Forever: it reconnects when the daemon restarts.
fn button_events(tx: Sender<Input>) {
    thread::spawn(move || loop {
        if let Ok(mut s) = UnixStream::connect(SOCKET) {
            if writeln!(s, "{}", json!({"id": 1, "method": "subscribe", "params": {}})).is_ok() {
                for line in BufReader::new(s).lines() {
                    let Ok(line) = line else { break };
                    let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                    if v["event"] == "button" {
                        let id = v["id"].as_u64().unwrap_or(99) as u8;
                        if tx.send(Input::Button(id, v["pressed"] == true)).is_err() {
                            return;
                        }
                    }
                }
            }
        }
        thread::sleep(Duration::from_secs(2));
    });
}

const CONFIRM: u8 = 0;
const UP: u8 = 1;
const DOWN: u8 = 2;
/// The LED&KEY's S1; S8 is KEY_S1 + 7.
const KEY_S1: u8 = 8;

/// Where the person is: a page, or a step inside SERVICES or WI-FI.
enum Mode {
    Page,
    List { cursor: usize },
    Menu { unit: String, cursor: usize },
    Ask(Ask),
    Logs { unit: String, back: usize, lines: Vec<String>, at: Instant },
    WifiList { cursor: usize },
    WifiMenu { net: Net, cursor: usize },
    Text(Entry),
}

struct Ui {
    page: usize,
    mode: Mode,
    last_input: Instant,
    toast: Option<(String, Instant)>,
    wifi: Wifi,
    tx: Sender<Input>,
    /// The password last typed for a network, until the board joins it: typing again starts from it.
    draft: Option<(String, String)>,
}

impl Ui {
    fn toast(&mut self, text: impl Into<String>) {
        self.toast = Some((text.into(), Instant::now() + Duration::from_secs(3)));
    }

    fn note(&mut self, n: Note) {
        match n {
            Note::Toast(t) => self.toast(t),
            Note::Joined(ssid) => {
                if self.draft.as_ref().is_some_and(|(s, _)| *s == ssid) {
                    self.draft = None;
                }
            }
            Note::Redraw => {}
        }
    }

    fn scan(&mut self) {
        wifi_job(&self.wifi, &self.tx, "scanning...", scan);
    }

    fn join(&mut self, net: Net, pass: Option<String>) {
        let busy = format!("joining {}...", clip(&net.name, 16));
        if !wifi_job(&self.wifi, &self.tx, &busy, move |w, tx| connect(w, tx, net, pass)) {
            self.toast("Wi-Fi is busy, try again");
        }
    }

    fn entry(&self, net: Net) -> Entry {
        let text = self.draft.as_ref().filter(|(s, _)| *s == net.name).map(|(_, t)| t.clone()).unwrap_or_default();
        Entry { net, text, pending: None, case: Case::Lower }
    }

    /// One button or key press; `repeat` when it comes from holding it.
    fn press(&mut self, id: u8, repeat: bool, st: &mut State) {
        self.last_input = Instant::now();
        let n = PAGES.len();
        let mode = std::mem::replace(&mut self.mode, Mode::Page);
        self.mode = match (mode, id) {
            // The LED&KEY: typing, or else S1..S4 go to a page.
            (Mode::Text(mut e), k) if k >= KEY_S1 => {
                e.key((k - KEY_S1) as usize);
                Mode::Text(e)
            }
            (mode, k) if k >= KEY_S1 => match (k - KEY_S1) as usize {
                p if p < n => {
                    self.page = p;
                    Mode::Page
                }
                _ => mode,
            },
            (Mode::Page, UP) => {
                self.page = (self.page + n - 1) % n;
                Mode::Page
            }
            (Mode::Page, DOWN) => {
                self.page = (self.page + 1) % n;
                Mode::Page
            }
            (Mode::Page, _) => match self.page {
                P_SERVICES if !st.units.is_empty() => Mode::List { cursor: 0 },
                P_CONTROL => {
                    let ok = Command::new("systemctl").args(["kill", "-s", "USR1", "qonu-web.service"]).status().is_ok_and(|s| s.success());
                    self.toast(if ok { "new code" } else { "qonu-web is not running" });
                    Mode::Page
                }
                P_WIFI => {
                    self.scan();
                    Mode::WifiList { cursor: 0 }
                }
                _ => Mode::Page,
            },
            (Mode::List { cursor }, UP) if cursor == 0 => Mode::Page, // up from the first row leaves the list
            (Mode::List { cursor }, UP) => Mode::List { cursor: cursor - 1 },
            (Mode::List { cursor }, DOWN) => Mode::List { cursor: (cursor + 1).min(st.units.len().saturating_sub(1)) },
            (Mode::List { cursor }, _) => match st.units.get(cursor) {
                Some(u) => Mode::Menu { unit: u.name.clone(), cursor: 0 },
                None => Mode::Page,
            },
            (Mode::Menu { unit, cursor }, UP) => Mode::Menu { unit, cursor: cursor.saturating_sub(1) },
            (Mode::Menu { unit, cursor }, DOWN) => {
                let len = actions(st.units.iter().find(|u| u.name == unit), &unit).len();
                Mode::Menu { unit, cursor: (cursor + 1).min(len - 1) }
            }
            (Mode::Menu { unit, cursor }, _) => {
                let items = actions(st.units.iter().find(|u| u.name == unit), &unit);
                let back_to = st.units.iter().position(|u| u.name == unit).unwrap_or(0);
                match items[cursor.min(items.len() - 1)] {
                    Action::Logs => Mode::Logs { lines: log_lines(&unit), unit, back: 0, at: Instant::now() },
                    Action::Restart => {
                        let msg = systemctl("restart", &unit);
                        self.toast(msg);
                        st.units_at = None;
                        Mode::List { cursor: back_to }
                    }
                    Action::Start => {
                        let msg = systemctl("start", &unit);
                        self.toast(msg);
                        st.units_at = None;
                        Mode::List { cursor: back_to }
                    }
                    Action::Stop => Mode::Ask(Ask::Stop(unit)),
                    Action::Remove => Mode::Ask(Ask::Remove(unit)),
                    Action::Back => Mode::List { cursor: back_to },
                }
            }
            (Mode::Ask(ask), CONFIRM) => match ask {
                Ask::Stop(unit) => {
                    let msg = systemctl("stop", &unit);
                    self.toast(msg);
                    st.units_at = None;
                    Mode::List { cursor: st.units.iter().position(|u| u.name == unit).unwrap_or(0) }
                }
                Ask::Remove(unit) => {
                    self.toast(format!("removing {}...", unit.trim_start_matches("fr-app-")));
                    remove_app(&unit, &self.tx);
                    st.units_at = None;
                    Mode::List { cursor: 0 }
                }
                Ask::Forget(net) => {
                    if !wifi_job(&self.wifi, &self.tx, "forgetting...", move |_, tx| forget(tx, &net)) {
                        self.toast("Wi-Fi is busy, try again");
                    }
                    Mode::WifiList { cursor: 0 }
                }
            },
            (Mode::Ask(ask), _) => match ask {
                Ask::Stop(unit) | Ask::Remove(unit) => Mode::Menu { unit, cursor: 0 },
                Ask::Forget(net) => Mode::WifiMenu { net, cursor: 0 },
            },
            (Mode::Logs { unit, back, lines, at }, UP) => {
                let max = lines.len().saturating_sub(LOG_ROWS);
                Mode::Logs { unit, back: (back + 3).min(max), lines, at }
            }
            (Mode::Logs { unit, back, lines, at }, DOWN) => Mode::Logs { unit, back: back.saturating_sub(3), lines, at },
            (Mode::Logs { unit, .. }, _) => Mode::Menu { unit, cursor: 0 },
            (Mode::WifiList { cursor }, UP) if cursor == 0 => Mode::Page,
            (Mode::WifiList { cursor }, UP) => Mode::WifiList { cursor: cursor - 1 },
            (Mode::WifiList { cursor }, DOWN) => {
                let len = self.wifi.view.lock().unwrap().nets.len();
                Mode::WifiList { cursor: (cursor + 1).min(len.saturating_sub(1)) }
            }
            (Mode::WifiList { cursor }, _) => {
                let net = self.wifi.view.lock().unwrap().nets.get(cursor).cloned();
                match net {
                    None => {
                        self.scan(); // nothing listed: look again
                        Mode::WifiList { cursor: 0 }
                    }
                    // A new network with a password: straight to typing it.
                    Some(net) if !net.path.is_empty() && net.kind == "psk" && net.known.is_none() => Mode::Text(self.entry(net)),
                    Some(net) if net.known.is_none() && net.kind != "open" => {
                        self.toast(format!("{} networks: set up with iwctl", net.kind));
                        Mode::WifiList { cursor }
                    }
                    Some(net) => Mode::WifiMenu { net, cursor: 0 },
                }
            }
            (Mode::WifiMenu { net, cursor }, UP) => Mode::WifiMenu { net, cursor: cursor.saturating_sub(1) },
            (Mode::WifiMenu { net, cursor }, DOWN) => {
                let len = wifi_actions(&net).len();
                Mode::WifiMenu { net, cursor: (cursor + 1).min(len - 1) }
            }
            (Mode::WifiMenu { net, cursor }, _) => {
                let items = wifi_actions(&net);
                match items[cursor.min(items.len() - 1)] {
                    WifiAction::Join => {
                        self.join(net, None);
                        Mode::WifiList { cursor: 0 }
                    }
                    WifiAction::Password => Mode::Text(self.entry(net)),
                    WifiAction::Forget => Mode::Ask(Ask::Forget(net)),
                    WifiAction::Back => Mode::WifiList { cursor: 0 },
                }
            }
            (Mode::Text(mut e), UP) => {
                e.commit();
                e.case = e.case.next();
                Mode::Text(e)
            }
            (Mode::Text(mut e), DOWN) => {
                // Holding DOWN deletes everything but does not leave; a fresh press on an empty line does.
                if e.delete() || repeat { Mode::Text(e) } else { Mode::WifiList { cursor: 0 } }
            }
            (Mode::Text(mut e), _) => {
                e.commit();
                if e.text.chars().count() < 8 {
                    self.toast("8 characters at least");
                    Mode::Text(e)
                } else {
                    self.draft = Some((e.net.name.clone(), e.text.clone()));
                    let pass = e.text.clone();
                    self.join(e.net, Some(pass));
                    Mode::WifiList { cursor: 0 }
                }
            }
        };
    }

    /// Held, a button repeats: (first repeat after, then every).
    fn repeat(&self, id: u8) -> Option<(Duration, Duration)> {
        let ms = Duration::from_millis;
        match (&self.mode, id) {
            (Mode::Text(_), k) if k >= KEY_S1 => Some((ms(600), ms(350))), // the next letter
            (Mode::Text(_), DOWN) => Some((ms(500), ms(120))),
            (Mode::Text(_), _) => None,
            (_, UP | DOWN) => Some((ms(400), ms(150))),
            _ => None,
        }
    }

    /// Keeps an open letter whose key has rested; true when the screen changed.
    fn tick(&mut self) -> bool {
        match &mut self.mode {
            Mode::Text(e) => e.expire(),
            _ => false,
        }
    }

    fn deadline(&self) -> Option<Instant> {
        match &self.mode {
            Mode::Text(e) => e.deadline(),
            _ => None,
        }
    }

    fn draw(&mut self, st: &mut State, system: &[Value]) -> Vec<Value> {
        // Two minutes without a press (five while typing): back to the page view.
        let idle = Duration::from_secs(if matches!(self.mode, Mode::Text(_)) { 300 } else { 120 });
        if !matches!(self.mode, Mode::Page) && self.last_input.elapsed() > idle {
            self.mode = Mode::Page;
        }
        let on_wifi = matches!(self.mode, Mode::WifiList { .. } | Mode::WifiMenu { .. } | Mode::Text(_))
            || (matches!(self.mode, Mode::Page) && self.page == P_WIFI);
        let view = {
            let v = self.wifi.view.lock().unwrap();
            if on_wifi && v.busy.is_none() && v.at.is_none_or(|t| t.elapsed() > Duration::from_secs(3)) {
                wifi_refresh_async(&self.wifi);
            }
            v.clone()
        };
        let mut o = match &mut self.mode {
            Mode::Page => match self.page {
                P_SYSTEM => Ops(system.split_last().map_or(vec![], |(_, ops)| ops.to_vec())), // without its present
                P_SERVICES => services_page(st, None),
                P_CONTROL => control_page(),
                _ => wifi_page(&view, st),
            },
            Mode::List { cursor } => {
                refresh_units(st);
                *cursor = (*cursor).min(st.units.len().saturating_sub(1));
                services_page(st, Some(*cursor))
            }
            Mode::Menu { unit, cursor } => menu_page(st, unit, *cursor),
            Mode::Ask(ask) => ask_page(ask),
            Mode::Logs { unit, back, lines, at } => {
                // Following the end: fetch new lines once a second.
                if *back == 0 && at.elapsed() >= Duration::from_secs(1) {
                    *lines = log_lines(unit);
                    *at = Instant::now();
                }
                logs_page(lines, unit, *back)
            }
            Mode::WifiList { cursor } => {
                *cursor = (*cursor).min(view.nets.len().saturating_sub(1));
                wifi_list_page(&view, *cursor)
            }
            Mode::WifiMenu { net, cursor } => wifi_menu_page(&view, net, *cursor),
            Mode::Text(e) => text_page(e, view.busy.as_deref()),
        };
        if let Some((text, until)) = &self.toast {
            if Instant::now() < *until {
                o.rect(8, 120, W - 16, 24, PANEL);
                o.rect(8, 120, 4, 24, ACCENT);
                o.text(W / 2, 125, "medium", TEXT, "center", clip(text, 36));
            } else {
                self.toast = None;
            }
        }
        o.0.push(json!({"op": "present"}));
        o.0
    }

    /// The LED&KEY: while a password is typed, its last 8 characters and the LED of the key whose letter is open;
    /// otherwise the time, and the CPU load as a bar of LEDs.
    fn panel(&self, st: &State) -> Value {
        if let Mode::Text(e) = &self.mode {
            let shown: Vec<char> = e.shown().chars().collect();
            let tail: String = shown[shown.len().saturating_sub(8)..].iter().collect();
            let leds = e.pending.map_or(0u8, |(k, _, _)| 1 << k);
            return json!({"text": tail, "leds": leds, "level": 4});
        }
        let tm = local_tm();
        let cpu = st.history.back().copied().unwrap_or(0.0);
        let lit = ((cpu / 12.5).ceil() as u32).min(8);
        let leds = if lit == 0 { 0 } else { 0xFFu32 >> (8 - lit) };
        json!({"text": format!("{:02}-{:02}-{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec), "leds": leds, "level": 2})
    }
}

fn main() {
    let interval = std::env::args()
        .skip_while(|a| a != "--interval-ms")
        .nth(1)
        .and_then(|v| v.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(1));
    let once = std::env::args().any(|a| a == "--once");
    let mut link = Link { errors_logged: Instant::now() - Duration::from_secs(120) };
    let mut st = State {
        prev_cpu: cpu_times(),
        history: VecDeque::with_capacity(HISTORY),
        prev_net: net_bytes("wlan0"),
        prev_at: Instant::now(),
        wifi: (None, None),
        wifi_at: None,
        mcu: None,
        mcu_at: None,
        units: vec![],
        units_at: None,
    };
    let page_arg = std::env::args().skip_while(|a| a != "--page").nth(1).and_then(|v| v.parse::<usize>().ok());
    let (tx, rx) = mpsc::channel();
    button_events(tx.clone());
    let mut ui = Ui {
        page: page_arg.map_or(0, |p| p.clamp(1, PAGES.len()) - 1),
        mode: Mode::Page,
        last_input: Instant::now(),
        toast: None,
        wifi: Arc::new(WifiShared { view: Mutex::new(WifiView::default()), refreshing: AtomicBool::new(false) }),
        tx,
        draft: None,
    };
    // A button held: it repeats (see Ui::repeat) until released.
    let mut held: Option<(u8, Instant, Duration)> = None;
    let mut last_panel: Option<(Value, Instant)> = None;
    eprintln!("qonu-dash {}: every {} ms, {} pages", env!("CARGO_PKG_VERSION"), interval.as_millis(), PAGES.len());
    thread::sleep(Duration::from_millis(300)); // the first CPU delta
    let mut system = frame(&mut st, &mut link);
    let mut next = Instant::now() + interval;
    let mut redraw = true;
    loop {
        if redraw {
            let ops = ui.draw(&mut st, &system);
            link.call("draw", json!({"ops": ops}));
            let panel = ui.panel(&st);
            if last_panel.as_ref().is_none_or(|(p, at)| *p != panel || at.elapsed() > Duration::from_secs(5)) {
                link.call("panel", panel.clone());
                last_panel = Some((panel, Instant::now()));
            }
            if once {
                break;
            }
        }
        redraw = false;
        let wake = [Some(next), held.map(|h| h.1), ui.deadline()].into_iter().flatten().min().unwrap_or(next);
        match rx.recv_timeout(wake.saturating_duration_since(Instant::now())) {
            Ok(Input::Button(id, true)) => {
                ui.press(id, false, &mut st);
                held = ui.repeat(id).map(|(first, every)| (id, Instant::now() + first, every));
                redraw = true;
            }
            Ok(Input::Button(id, false)) => {
                if held.is_some_and(|h| h.0 == id) {
                    held = None;
                }
            }
            Ok(Input::Note(n)) => {
                ui.note(n);
                redraw = true;
            }
            Err(_) => {}
        }
        let now = Instant::now();
        if let Some((id, at, every)) = held.filter(|h| now >= h.1) {
            ui.press(id, true, &mut st);
            held = Some((id, at + every, every));
            redraw = true;
        }
        if ui.tick() {
            redraw = true;
        }
        // The vitals keep their 1 s deltas whichever screen shows.
        if now >= next {
            next += interval;
            if next < now {
                next = now + interval;
            }
            system = frame(&mut st, &mut link);
            redraw = true;
        }
    }
}
