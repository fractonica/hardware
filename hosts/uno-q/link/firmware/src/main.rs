//! qonu-fw: STM32U585 side of the qonu link on the Arduino UNO Q.
//!
//! - LPUART1 (PG7 TX, PG8 RX, PG6 RTS, PG5 CTS) at 4 Mbaud to Linux `/dev/ttyHS1`, framed with
//!   `qonu-link-proto` (COBS + CRC-32), DMA ring-buffered receive.
//! - Heartbeat failsafe: once the host arms it, a missed heartbeat latches the
//!   safe state (host-owned outputs off) until the host clears it.
//! - Independent watchdog (1 s), fed only while both link tasks make progress.
//! - LED4 shows state: green blink = disarmed, green = armed, red blink = tripped.
//!   LED3 and the 13x8 LED matrix belong to the host (`SetLed`, `Matrix`) and
//!   go dark when the failsafe trips.
#![no_std]
#![no_main]

use core::cell::RefCell;
use core::sync::atomic::{AtomicU32, Ordering::Relaxed};

use embassy_executor::Spawner;
use embassy_stm32::gpio::{Flex, Level, Output, Speed};
use embassy_stm32::mode::Async;
use embassy_stm32::usart::{self, RingBufferedUartRx, Uart, UartTx};
use embassy_stm32::wdg::IndependentWatchdog;
use embassy_stm32::{bind_interrupts, dma, pac, peripherals};
use embassy_sync::blocking_mutex::Mutex as BlockingMutex;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;
use embassy_time::{Duration, Instant, Ticker, with_timeout};
use qonu_link_proto::{
    self as proto, Accumulator, ErrorCode, Event, FailsafeState, Fault, FrameError, Info, LinkCounters,
    MAX_FRAME, PanicSite, Request, ResetCause, Response, Up,
};
use static_cell::StaticCell;

/// Link speed. 4 Mbaud with RTS/CTS measured 0 errors over 2000-call sweeps
/// (p50 0.35 ms per round trip). Override at build time with QONU_BAUD; the
/// daemon's --baud must match.
const BAUD: u32 = match option_env!("QONU_BAUD") {
    Some(b) => parse_u32(b),
    None => 4_000_000,
};
/// Hardware flow control on LPUART1 (RTS PG6, CTS PG5 <-> TLMM GPIO 80/71).
/// On by default; build with QONU_RTSCTS=0 to drop it (daemon: --no-rtscts).
const RTSCTS: bool = match option_env!("QONU_RTSCTS") {
    Some(v) => !(v.len() == 1 && v.as_bytes()[0] == b'0'),
    None => true,
};
const WATCHDOG_US: u32 = 1_000_000;

const FW: [u8; 3] = [
    parse_u8(env!("CARGO_PKG_VERSION_MAJOR")),
    parse_u8(env!("CARGO_PKG_VERSION_MINOR")),
    parse_u8(env!("CARGO_PKG_VERSION_PATCH")),
];

bind_interrupts!(struct Irqs {
    LPUART1 => usart::InterruptHandler<peripherals::LPUART1>;
    GPDMA1_CHANNEL0 => dma::InterruptHandler<peripherals::GPDMA1_CH0>;
    GPDMA1_CHANNEL1 => dma::InterruptHandler<peripherals::GPDMA1_CH1>;
});

// ------------------------------------------------------------ shared state

/// Frames waiting for the TX task: (seq, body).
static OUTBOX: Channel<CriticalSectionRawMutex, (u16, Up), 8> = Channel::new();

static RX_FRAMES: AtomicU32 = AtomicU32::new(0);
static RX_BAD_CRC: AtomicU32 = AtomicU32::new(0);
static RX_BAD_FRAME: AtomicU32 = AtomicU32::new(0);
static RX_UART_ERRORS: AtomicU32 = AtomicU32::new(0);
/// Bumped by each link task at least every 100 ms; the watchdog checks both.
static RX_ALIVE: AtomicU32 = AtomicU32::new(0);
static TX_ALIVE: AtomicU32 = AtomicU32::new(0);
static EVENT_SEQ: AtomicU32 = AtomicU32::new(0);

struct Boot {
    reset_cause: ResetCause,
    last_panic: Option<PanicSite>,
}
static BOOT: BlockingMutex<CriticalSectionRawMutex, RefCell<Boot>> =
    BlockingMutex::new(RefCell::new(Boot { reset_cause: ResetCause::Unknown, last_panic: None }));

/// LED3 (R, G, B), active low, owned by the host and forced off in safe state.
static LED3: BlockingMutex<CriticalSectionRawMutex, RefCell<Option<[Output<'static>; 3]>>> =
    BlockingMutex::new(RefCell::new(None));

fn uptime_ms() -> u32 {
    Instant::now().as_millis() as u32
}

fn emit(event: Event) {
    let seq = EVENT_SEQ.fetch_add(1, Relaxed) as u16;
    let _ = OUTBOX.try_send((seq, Up::Event(event)));
}

// ---------------------------------------------------------------- failsafe

mod failsafe {
    use super::*;

    struct Fs {
        state: FailsafeState,
        deadline: Instant,
    }
    static FS: BlockingMutex<CriticalSectionRawMutex, RefCell<Fs>> = BlockingMutex::new(RefCell::new(Fs {
        state: FailsafeState::Disarmed,
        deadline: Instant::from_ticks(0),
    }));

    pub fn state() -> FailsafeState {
        FS.lock(|fs| fs.borrow().state)
    }

    pub fn heartbeat(ttl_ms: u16) -> Response {
        let (resp, changed) = FS.lock(|fs| {
            let mut fs = fs.borrow_mut();
            let before = fs.state;
            match (before, ttl_ms) {
                (FailsafeState::Tripped, _) => return (Response::Error(ErrorCode::FailsafeTripped), None),
                (_, 0) => fs.state = FailsafeState::Disarmed,
                _ => {
                    fs.state = FailsafeState::Armed;
                    fs.deadline = Instant::now() + Duration::from_millis(ttl_ms as u64);
                }
            }
            (Response::Ok, (fs.state != before).then_some(fs.state))
        });
        if let Some(state) = changed {
            emit(Event::Failsafe { state });
        }
        resp
    }

    pub fn clear() -> Response {
        let cleared = FS.lock(|fs| {
            let mut fs = fs.borrow_mut();
            let was = fs.state == FailsafeState::Tripped;
            if was {
                fs.state = FailsafeState::Disarmed;
            }
            was
        });
        if cleared {
            emit(Event::Failsafe { state: FailsafeState::Disarmed });
        }
        Response::Ok
    }

    /// Trips the failsafe if an armed heartbeat is overdue. Returns the state.
    pub fn check() -> FailsafeState {
        let tripped = FS.lock(|fs| {
            let mut fs = fs.borrow_mut();
            if fs.state == FailsafeState::Armed && Instant::now() > fs.deadline {
                fs.state = FailsafeState::Tripped;
                true
            } else {
                false
            }
        });
        if tripped {
            safe_outputs();
            emit(Event::Failsafe { state: FailsafeState::Tripped });
        }
        state()
    }

    /// Drives every host-owned output to its safe level.
    fn safe_outputs() {
        matrix::set([0; proto::MATRIX_HEIGHT]);
        LED3.lock(|l| {
            if let Some(leds) = l.borrow_mut().as_mut() {
                for led in leds.iter_mut() {
                    led.set_high(); // active low: off
                }
            }
        });
    }
}

// --------------------------------------------------------------- requests

fn handle(req: Request) -> Response {
    match req {
        Request::Ping { nonce } => Response::Pong { nonce, uptime_ms: uptime_ms() },
        Request::GetInfo => {
            let (reset_cause, last_panic) = BOOT.lock(|b| {
                let b = b.borrow();
                (b.reset_cause, b.last_panic)
            });
            Response::Info(Info {
                proto: proto::PROTO_VERSION,
                fw: FW,
                uptime_ms: uptime_ms(),
                reset_cause,
                uid: embassy_stm32::uid::uid(),
                failsafe: failsafe::state(),
                link: LinkCounters {
                    frames: RX_FRAMES.load(Relaxed),
                    bad_crc: RX_BAD_CRC.load(Relaxed),
                    bad_frame: RX_BAD_FRAME.load(Relaxed),
                    uart_errors: RX_UART_ERRORS.load(Relaxed),
                },
                last_panic,
            })
        }
        Request::Heartbeat { ttl_ms } => failsafe::heartbeat(ttl_ms),
        Request::ClearFailsafe => failsafe::clear(),
        Request::SetLed { led: 0, r, g, b } => {
            if failsafe::state() == FailsafeState::Tripped {
                return Response::Error(ErrorCode::FailsafeTripped);
            }
            LED3.lock(|l| {
                if let Some(leds) = l.borrow_mut().as_mut() {
                    for (led, on) in leds.iter_mut().zip([r, g, b]) {
                        led.set_level(if on { Level::Low } else { Level::High });
                    }
                }
            });
            Response::Ok
        }
        Request::SetLed { .. } => Response::Error(ErrorCode::InvalidArgument),
        Request::Fault { kind: Fault::Hang } => {
            #[allow(clippy::empty_loop)]
            loop {} // blocks the executor: nothing pets the watchdog
        }
        Request::Fault { kind: Fault::Panic } => panic!("fault injection"),
        Request::Matrix { rows } => {
            if failsafe::state() == FailsafeState::Tripped {
                return Response::Error(ErrorCode::FailsafeTripped);
            }
            matrix::set(rows);
            Response::Ok
        }
    }
}

// ------------------------------------------------------------- LED matrix

/// The 13x8 LED matrix: 104 LEDs charlieplexed on PF0..PF10. Each pixel lights
/// when its "high" pin drives high and its "low" pin drives low while every
/// other pin floats. The scan task drives one high pin per phase.
mod matrix {
    use super::*;
    use proto::{MATRIX_HEIGHT as H, MATRIX_WIDTH as W};

    const PINS: usize = 11;
    /// Pixel `y * 13 + x` -> `(high pin << 8) | low pin`, from the
    /// `pixel-pairs` table of Zephyr's arduino_uno_q board devicetree.
    const PAIRS: [u16; W * H] = [
        0x0001, 0x0100, 0x0002, 0x0200, 0x0102, 0x0201, 0x0003, 0x0300, 0x0103, 0x0301, 0x0203, 0x0302, 0x0004,
        0x0400, 0x0104, 0x0401, 0x0204, 0x0402, 0x0304, 0x0403, 0x0005, 0x0500, 0x0105, 0x0501, 0x0205, 0x0502,
        0x0305, 0x0503, 0x0405, 0x0504, 0x0006, 0x0600, 0x0106, 0x0601, 0x0206, 0x0602, 0x0306, 0x0603, 0x0406,
        0x0604, 0x0506, 0x0605, 0x0007, 0x0700, 0x0107, 0x0701, 0x0207, 0x0702, 0x0307, 0x0703, 0x0407, 0x0704,
        0x0507, 0x0705, 0x0607, 0x0706, 0x0008, 0x0800, 0x0108, 0x0801, 0x0208, 0x0802, 0x0308, 0x0803, 0x0408,
        0x0804, 0x0508, 0x0805, 0x0608, 0x0806, 0x0708, 0x0807, 0x0009, 0x0900, 0x0109, 0x0901, 0x0209, 0x0902,
        0x0309, 0x0903, 0x0409, 0x0904, 0x0509, 0x0905, 0x0609, 0x0906, 0x0709, 0x0907, 0x0809, 0x0908, 0x000a,
        0x0a00, 0x010a, 0x0a01, 0x020a, 0x0a02, 0x030a, 0x0a03, 0x040a, 0x0a04, 0x050a, 0x0a05, 0x060a, 0x0a06,
    ];
    /// MODER bits of PF0..PF10 (2 bits per pin).
    const MODER_MASK: u32 = (1 << (2 * PINS)) - 1;

    static FRAME: BlockingMutex<CriticalSectionRawMutex, RefCell<[u16; H]>> =
        BlockingMutex::new(RefCell::new([0; H]));

    pub fn set(rows: [u16; H]) {
        FRAME.lock(|f| *f.borrow_mut() = rows.map(|r| r & ((1 << W) - 1)));
    }

    /// Owns PF0..PF10 (the `Flex` pins only reserve them) and drives the port
    /// registers directly, so each phase switches all 11 pins at once.
    #[embassy_executor::task]
    pub async fn scan(_pins: [Flex<'static>; PINS]) {
        let moder = pac::GPIOF.moder().as_ptr() as *mut u32;
        let bsrr = pac::GPIOF.bsrr().as_ptr() as *mut u32;
        let mut ticker = Ticker::every(Duration::from_micros(500));
        loop {
            let rows = FRAME.lock(|f| *f.borrow());
            let mut lows = [0u32; PINS];
            for (y, row) in rows.iter().enumerate() {
                for x in 0..W {
                    if row >> x & 1 != 0 {
                        let pair = PAIRS[y * W + x];
                        lows[(pair >> 8) as usize] |= 1 << (pair & 0xFF);
                    }
                }
            }
            for (high, &low_pins) in lows.iter().enumerate() {
                // SAFETY: GPIOF registers; PF0..PF10 are reserved by `_pins`
                // and only touched here. Read-modify-write keeps PF11..PF15.
                unsafe {
                    let floating = moder.read_volatile() & !MODER_MASK;
                    moder.write_volatile(floating); // blank: every pin floats
                    if low_pins != 0 {
                        bsrr.write_volatile((1 << high) | (low_pins << 16));
                        let mut out = 1 << (2 * high);
                        for pin in 0..PINS {
                            if low_pins >> pin & 1 != 0 {
                                out |= 1 << (2 * pin);
                            }
                        }
                        moder.write_volatile(floating | out);
                    }
                }
                ticker.next().await;
            }
        }
    }
}

fn on_frame(cobs: &mut [u8]) {
    match proto::unframe(cobs) {
        Err(FrameError::BadCrc) => {
            RX_BAD_CRC.fetch_add(1, Relaxed);
        }
        Err(_) => {
            RX_BAD_FRAME.fetch_add(1, Relaxed);
        }
        Ok(frame) => {
            RX_FRAMES.fetch_add(1, Relaxed);
            let resp = match frame.parse::<Request>() {
                Ok(req) => handle(req),
                Err(_) => Response::Error(ErrorCode::BadRequest),
            };
            // If the outbox is full the host times out and retries.
            let _ = OUTBOX.try_send((frame.seq, Up::Response(resp)));
        }
    }
}

// ------------------------------------------------------------------ tasks

#[embassy_executor::task]
async fn link_rx(mut rx: RingBufferedUartRx<'static>) {
    let mut acc = Accumulator::new();
    let mut chunk = [0u8; 64];
    loop {
        RX_ALIVE.fetch_add(1, Relaxed);
        match with_timeout(Duration::from_millis(100), rx.read(&mut chunk)).await {
            Err(_) => {} // idle; the timeout only keeps RX_ALIVE moving
            Ok(Err(_)) => {
                // Overrun/framing/noise: the ring buffer restarts on the next
                // read, and the accumulator drops the damaged frame.
                RX_UART_ERRORS.fetch_add(1, Relaxed);
            }
            Ok(Ok(n)) => {
                let dropped = acc.feed(&chunk[..n], on_frame);
                RX_BAD_FRAME.fetch_add(dropped, Relaxed);
            }
        }
    }
}

#[embassy_executor::task]
async fn link_tx(mut tx: UartTx<'static, Async>) {
    let mut buf = [0u8; MAX_FRAME];
    // A lone delimiter flushes any partial frame the host may be holding.
    let _ = tx.write(&[0]).await;
    loop {
        TX_ALIVE.fetch_add(1, Relaxed);
        if let Ok((seq, up)) = with_timeout(Duration::from_millis(100), OUTBOX.receive()).await {
            if let Ok(n) = proto::encode(seq, &up, &mut buf) {
                let _ = tx.write(&buf[..n]).await;
            }
        }
    }
}

// ------------------------------------------------------------------- main

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let reset_cause = take_reset_cause();
    let last_panic = panic_record::take();
    BOOT.lock(|b| *b.borrow_mut() = Boot { reset_cause, last_panic });

    let mut config = embassy_stm32::Config::default();
    {
        use embassy_stm32::rcc::*;
        config.rcc.hsi = true;
        config.rcc.pll1 = Some(Pll {
            source: PllSource::HSI, // 16 MHz
            prediv: PllPreDiv::DIV1,
            mul: PllMul::MUL10,
            divp: None,
            divq: None,
            divr: Some(PllDiv::DIV1), // 160 MHz
        });
        config.rcc.sys = Sysclk::PLL1_R;
        config.rcc.voltage_range = VoltageScale::RANGE1;
    }
    let p = embassy_stm32::init(config);

    // Port G (PG2..PG15, which carries LPUART1) is powered from VDDIO2, and its
    // I/O buffers stay unpowered until the supply is declared valid.
    pac::PWR.svmcr().modify(|w| w.set_io2sv(true));

    let led3 = [
        Output::new(p.PH10, Level::High, Speed::Low),
        Output::new(p.PH11, Level::High, Speed::Low),
        Output::new(p.PH12, Level::High, Speed::Low),
    ];
    LED3.lock(|l| *l.borrow_mut() = Some(led3));
    let matrix_pins = [
        Flex::new(p.PF0),
        Flex::new(p.PF1),
        Flex::new(p.PF2),
        Flex::new(p.PF3),
        Flex::new(p.PF4),
        Flex::new(p.PF5),
        Flex::new(p.PF6),
        Flex::new(p.PF7),
        Flex::new(p.PF8),
        Flex::new(p.PF9),
        Flex::new(p.PF10),
    ];
    let mut led4_r = Output::new(p.PH13, Level::High, Speed::Low);
    let mut led4_g = Output::new(p.PH14, Level::High, Speed::Low);
    let _led4_b = Output::new(p.PH15, Level::High, Speed::Low);

    let mut uart_config = usart::Config::default();
    uart_config.baudrate = BAUD;
    let uart = if RTSCTS {
        Uart::new_with_rtscts(p.LPUART1, p.PG8, p.PG7, p.PG6, p.PG5, p.GPDMA1_CH0, p.GPDMA1_CH1, Irqs, uart_config)
    } else {
        Uart::new(p.LPUART1, p.PG8, p.PG7, p.GPDMA1_CH0, p.GPDMA1_CH1, Irqs, uart_config)
    }
    .unwrap();
    let (tx, rx) = uart.split();
    static RX_DMA_BUF: StaticCell<[u8; 1024]> = StaticCell::new();
    let rx = rx.into_ring_buffered(RX_DMA_BUF.init([0; 1024]));

    emit(Event::Boot { reset_cause });
    spawner.spawn(link_rx(rx).unwrap());
    spawner.spawn(link_tx(tx).unwrap());
    spawner.spawn(matrix::scan(matrix_pins).unwrap());

    let mut wdg = IndependentWatchdog::new(p.IWDG, WATCHDOG_US);
    wdg.unleash();

    // Supervisor: failsafe deadline, status LED, watchdog.
    let mut ticker = Ticker::every(Duration::from_millis(50));
    let (mut seen_rx, mut seen_tx) = (0, 0);
    let mut progress_at = Instant::now();
    let mut tick: u32 = 0;
    loop {
        ticker.next().await;
        tick = tick.wrapping_add(1);

        let (green, red) = match failsafe::check() {
            FailsafeState::Disarmed => (tick % 20 < 2, false),
            FailsafeState::Armed => (true, false),
            FailsafeState::Tripped => (false, tick % 4 < 2),
        };
        led4_g.set_level(if green { Level::Low } else { Level::High });
        led4_r.set_level(if red { Level::Low } else { Level::High });

        let (rx_now, tx_now) = (RX_ALIVE.load(Relaxed), TX_ALIVE.load(Relaxed));
        if rx_now != seen_rx && tx_now != seen_tx {
            (seen_rx, seen_tx) = (rx_now, tx_now);
            progress_at = Instant::now();
        }
        if Instant::now() - progress_at < Duration::from_millis(500) {
            wdg.pet();
        }
    }
}

// ------------------------------------------------------------ reset cause

fn take_reset_cause() -> ResetCause {
    let csr = pac::RCC.csr().read();
    // Internal resets also pulse NRST, so the pin flag is checked last.
    let cause = if csr.iwdgrstf() {
        ResetCause::IndependentWatchdog
    } else if csr.wwdgrstf() {
        ResetCause::WindowWatchdog
    } else if csr.sftrstf() {
        ResetCause::Software
    } else if csr.lpwrrstf() {
        ResetCause::LowPower
    } else if csr.oblrstf() {
        ResetCause::OptionBytes
    } else if csr.borrstf() {
        ResetCause::PowerOn // BOR is also set by a power-on reset
    } else if csr.pinrstf() {
        ResetCause::Pin
    } else {
        ResetCause::Unknown
    };
    pac::RCC.csr().modify(|w| w.set_rmvf(true));
    cause
}

// ------------------------------------------------------------------ panic

/// The panic location survives the reset in RAM that the runtime doesn't zero.
mod panic_record {
    use super::PanicSite;
    use core::mem::MaybeUninit;

    const MAGIC: u32 = 0x5041_4E43; // "PANC"

    #[repr(C)]
    struct Record {
        magic: u32,
        site: PanicSite,
    }

    #[unsafe(link_section = ".uninit.qonu_panic")]
    static mut RECORD: MaybeUninit<Record> = MaybeUninit::uninit();

    pub fn store(site: PanicSite) {
        unsafe { (&raw mut RECORD).write_volatile(MaybeUninit::new(Record { magic: MAGIC, site })) };
    }

    pub fn take() -> Option<PanicSite> {
        let magic = unsafe { (&raw const RECORD).cast::<u32>().read_volatile() };
        let site = (magic == MAGIC).then(|| unsafe { (&raw const RECORD).read_volatile().assume_init().site });
        unsafe { (&raw mut RECORD).cast::<u32>().write_volatile(0) };
        site
    }
}

#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    let site = match info.location() {
        Some(l) => PanicSite::new(l.file(), l.line(), l.column()),
        None => PanicSite::new("?", 0, 0),
    };
    panic_record::store(site);
    cortex_m::peripheral::SCB::sys_reset()
}

const fn parse_u32(s: &str) -> u32 {
    let b = s.as_bytes();
    let mut i = 0;
    let mut v: u32 = 0;
    while i < b.len() {
        v = v * 10 + (b[i] - b'0') as u32;
        i += 1;
    }
    v
}

const fn parse_u8(s: &str) -> u8 {
    parse_u32(s) as u8
}
