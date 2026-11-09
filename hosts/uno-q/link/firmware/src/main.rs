//! qonu-fw: STM32U585 side of the qonu link on the Arduino UNO Q.
//!
//! - LPUART1 (PG7 TX, PG8 RX, PG6 RTS, PG5 CTS) at 4 Mbaud to Linux `/dev/ttyHS1`, framed with
//!   `qonu-link-proto` (COBS + CRC-32). Receive is a DMA ring that never stops (see `link_rx`).
//! - Heartbeat failsafe: once the host arms it, a missed heartbeat latches the
//!   safe state (host-owned outputs off) until the host clears it.
//! - Independent watchdog (1 s), fed only while both link tasks make progress.
//! - LED4 shows state: green blink = disarmed, green = armed, red blink = tripped.
//!   LED3, the 13x8 LED matrix and the LED&KEY module belong to the host (`SetLed`, `Matrix`, `Panel`) and
//!   go dark when the failsafe trips.
//! - The matrix scan runs on an interrupt-priority executor, so drawing on the SPI display (thread mode) never holds
//!   a matrix row lit longer than the others: that showed as random flicker.
#![no_std]
#![no_main]

mod display;

use core::cell::RefCell;
use core::sync::atomic::{AtomicU32, Ordering::Relaxed};

use embassy_executor::{InterruptExecutor, Spawner};
use embassy_stm32::gpio::{Flex, Input, Level, Output, OutputOpenDrain, Pull, Speed};
use embassy_stm32::mode::Async;
use embassy_stm32::spi::{self, Spi};
use embassy_stm32::time::Hertz;
use embassy_stm32::usart::{self, Uart, UartTx};
use embassy_stm32::wdg::IndependentWatchdog;
use embassy_stm32::interrupt::{InterruptExt, Priority};
use embassy_stm32::{bind_interrupts, dma, interrupt, pac, peripherals};
use static_cell::StaticCell;
use embassy_sync::blocking_mutex::Mutex as BlockingMutex;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;
use embassy_time::{Duration, Instant, Ticker, with_timeout};
use qonu_link_proto::{
    self as proto, Accumulator, ErrorCode, Event, FailsafeState, Fault, FrameError, Info, LinkCounters,
    MAX_FRAME, PanicSite, Request, ResetCause, Response, Up,
};

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
/// SPI clock for the display; the ST7789 accepts up to ~62 MHz. Override with
/// QONU_LCD_MHZ if long jumper wires garble the picture.
const LCD_SPI_HZ: u32 = match option_env!("QONU_LCD_MHZ") {
    Some(m) => parse_u32(m) * 1_000_000,
    None => 40_000_000,
};

const FW: [u8; 3] = [
    parse_u8(env!("CARGO_PKG_VERSION_MAJOR")),
    parse_u8(env!("CARGO_PKG_VERSION_MINOR")),
    parse_u8(env!("CARGO_PKG_VERSION_PATCH")),
];

bind_interrupts!(struct Irqs {
    LPUART1 => usart::InterruptHandler<peripherals::LPUART1>;
    GPDMA1_CHANNEL0 => dma::InterruptHandler<peripherals::GPDMA1_CH0>;
    GPDMA1_CHANNEL1 => dma::InterruptHandler<peripherals::GPDMA1_CH1>;
    GPDMA1_CHANNEL2 => dma::InterruptHandler<peripherals::GPDMA1_CH2>;
    GPDMA1_CHANNEL3 => dma::InterruptHandler<peripherals::GPDMA1_CH3>;
});

/// Runs the LED matrix scan above thread mode (where the link and the display draw). UART4 is unused: its interrupt
/// only serves as this executor's software interrupt.
static EXECUTOR_HIGH: InterruptExecutor = InterruptExecutor::new();

#[interrupt]
unsafe fn UART4() {
    unsafe { EXECUTOR_HIGH.on_interrupt() }
}

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
        ledkey::repaint(); // its task sees the trip and turns the module off
        display::failsafe_banner();
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
        Request::Draw { ops } => {
            if failsafe::state() == FailsafeState::Tripped {
                return Response::Error(ErrorCode::FailsafeTripped);
            }
            for op in &ops {
                display::apply(op);
            }
            Response::Ok
        }
        Request::Matrix { rows } => {
            if failsafe::state() == FailsafeState::Tripped {
                return Response::Error(ErrorCode::FailsafeTripped);
            }
            matrix::set(rows);
            Response::Ok
        }
        Request::Panel { digits, leds, level } => {
            if failsafe::state() == FailsafeState::Tripped {
                return Response::Error(ErrorCode::FailsafeTripped);
            }
            if level > 8 {
                return Response::Error(ErrorCode::InvalidArgument);
            }
            ledkey::set(ledkey::Shown { digits, leds, level });
            Response::Ok
        }
        Request::PanelStatus => Response::Panel { present: ledkey::present() },
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

// ------------------------------------------------------------- LED&KEY

/// The LED&KEY module: a TM1638 with 8 seven-segment digits, 8 LEDs and 8 keys, on STB D12 (PB14), CLK D7 (PB2)
/// and DIO D5 (PA11). Bit-banged, LSB first, all three lines open drain with pull-ups (the module may run at 5 V; its
/// own pull-ups then lift the lines to its level). Every 10 ms the task reads the keys, debounced over two reads, and
/// reports S1..S8 as `Event::Button` ids 8..15; it writes the display when the host changes it and once a second
/// (a module plugged in later shows the picture too). Bytes go one at a time with a yield between them, so the link
/// tasks never wait more than ~60 us.
mod ledkey {
    use super::*;
    use core::cell::Cell;
    use core::future::poll_fn;
    use core::sync::atomic::AtomicBool;
    use core::task::Poll;
    use embassy_stm32::gpio::OutputOpenDrain;
    use proto::{PANEL_DIGITS, PANEL_KEY_FIRST};

    #[derive(Clone, Copy, PartialEq, Eq)]
    pub struct Shown {
        pub digits: [u8; PANEL_DIGITS],
        pub leds: u8,
        /// 0 off, 1-8 brightness
        pub level: u8,
    }

    static WANT: BlockingMutex<CriticalSectionRawMutex, Cell<Shown>> =
        BlockingMutex::new(Cell::new(Shown { digits: [0; PANEL_DIGITS], leds: 0, level: 0 }));
    static DIRTY: AtomicBool = AtomicBool::new(true);

    pub fn set(s: Shown) {
        WANT.lock(|w| w.set(s));
        DIRTY.store(true, Relaxed);
    }

    pub fn repaint() {
        DIRTY.store(true, Relaxed);
    }

    static PRESENT: AtomicBool = AtomicBool::new(false);

    pub fn present() -> bool {
        PRESENT.load(Relaxed)
    }

    /// Half a clock period: 3 us (a 166 kHz clock; the TM1638 takes up to 1 MHz, but open-drain edges are slow).
    const HALF_CYCLES: u32 = 3 * 160;

    async fn yield_now() {
        let mut yielded = false;
        poll_fn(|cx| {
            if yielded {
                Poll::Ready(())
            } else {
                yielded = true;
                cx.waker().wake_by_ref();
                Poll::Pending
            }
        })
        .await
    }

    struct Tm1638 {
        stb: OutputOpenDrain<'static>,
        clk: OutputOpenDrain<'static>,
        dio: OutputOpenDrain<'static>,
    }

    impl Tm1638 {
        fn half(&self) {
            cortex_m::asm::delay(HALF_CYCLES);
        }

        /// One byte, LSB first; the TM1638 latches DIO on CLK's rising edge.
        fn byte(&mut self, mut b: u8) {
            for _ in 0..8 {
                self.clk.set_low();
                if b & 1 != 0 {
                    self.dio.set_high();
                } else {
                    self.dio.set_low();
                }
                self.half();
                self.clk.set_high();
                self.half();
                b >>= 1;
            }
            self.dio.set_high(); // released
        }

        fn read_byte(&mut self) -> u8 {
            let mut v = 0;
            for i in 0..8 {
                self.clk.set_low(); // the TM1638 shifts the next bit out on the falling edge
                self.half();
                if self.dio.is_high() {
                    v |= 1 << i;
                }
                self.clk.set_high();
                self.half();
            }
            v
        }

        fn start(&mut self) {
            self.stb.set_low();
            self.half();
        }

        fn end(&mut self) {
            self.stb.set_high();
            self.half();
        }

        async fn command(&mut self, c: u8) {
            self.start();
            self.byte(c);
            self.end();
            yield_now().await;
        }

        async fn show(&mut self, s: &Shown) {
            self.command(0x40).await; // write data, auto-increment address
            self.start();
            self.byte(0xC0); // from address 0: digit 1, LED 1, digit 2, LED 2, ...
            for i in 0..PANEL_DIGITS {
                yield_now().await;
                self.byte(s.digits[i]);
                self.byte((s.leds >> i) & 1);
            }
            self.end();
            yield_now().await;
            self.command(if s.level == 0 { 0x80 } else { 0x88 | (s.level.min(8) - 1) }).await;
        }

        /// The keys as a bitmask (bit i = S(i+1)), or None when no TM1638 answers: the unused bits 3 and 7 of each
        /// scan byte read 0 on a real chip and 1 on a line that only the pull-up holds.
        async fn keys(&mut self) -> Option<u8> {
            self.start();
            self.byte(0x42);
            self.half(); // Twait before the first clock
            let mut scan = [0u8; 4];
            for b in scan.iter_mut() {
                *b = self.read_byte();
            }
            self.end();
            yield_now().await;
            if scan.iter().any(|b| b & 0x88 != 0) {
                return None;
            }
            // S1..S4 are bit 0 of bytes 0..3, S5..S8 bit 4 (the LED&KEY wires its keys to K3).
            let mut keys = 0u8;
            for (i, b) in scan.iter().enumerate() {
                keys |= (b & 1) << i;
                keys |= ((b >> 4) & 1) << (i + 4);
            }
            Some(keys)
        }
    }

    #[embassy_executor::task]
    pub async fn run(stb: OutputOpenDrain<'static>, clk: OutputOpenDrain<'static>, dio: OutputOpenDrain<'static>) {
        let mut tm = Tm1638 { stb, clk, dio };
        let mut ticker = Ticker::every(Duration::from_millis(10));
        let mut present = false;
        let (mut stable, mut last) = (0u8, 0u8);
        let mut tick: u32 = 0;
        loop {
            ticker.next().await;
            tick = tick.wrapping_add(1);

            let read = tm.keys().await;
            if read.is_some() != present {
                present = read.is_some();
                PRESENT.store(present, Relaxed);
                emit(Event::Panel { present });
                DIRTY.store(true, Relaxed);
                if !present {
                    // Keys held when the module went away are released.
                    for i in 0..8 {
                        if stable >> i & 1 != 0 {
                            emit(Event::Button { id: PANEL_KEY_FIRST + i, pressed: false, t_ms: uptime_ms() });
                        }
                    }
                    (stable, last) = (0, 0);
                }
            }
            if let Some(keys) = read {
                // A change counts once two reads 10 ms apart agree.
                if keys == last && keys != stable {
                    let t_ms = uptime_ms().saturating_sub(10);
                    for i in 0..8 {
                        if (keys ^ stable) >> i & 1 != 0 {
                            emit(Event::Button { id: PANEL_KEY_FIRST + i, pressed: keys >> i & 1 != 0, t_ms });
                        }
                    }
                    stable = keys;
                }
                last = keys;
            }

            if present && (DIRTY.swap(false, Relaxed) || tick % 100 == 0) {
                let mut s = WANT.lock(|w| w.get());
                if failsafe::state() == FailsafeState::Tripped {
                    s.level = 0;
                }
                tm.show(&s).await;
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

/// The link's receiver: a DMA ring on LPUART1 that runs from boot on and is polled every 250 us. Not embassy's
/// `RingBufferedUartRx`: on a receive error (a framing error from a glitch while the MCU resets, say) that one stops
/// the DMA, and its restart keeps a stale read position: from then on every request waited for the DMA's next
/// half-buffer mark, 0.6-1.6 s, until the next reset. Nor `read_until_idle`, which reads the data register itself
/// and so takes a byte off the FIFO when frames arrive back to back. Here nothing stops the ring: the UART's error
/// and idle interrupts stay off, an errored byte is simply not transferred (DDRE is clear), and the CRC drops the
/// damaged frame.
#[embassy_executor::task]
async fn link_rx(mut ring: dma::ReadableRingBuffer<'static, u8>) {
    let mut acc = Accumulator::new();
    let mut chunk = [0u8; 256];
    let mut ticker = Ticker::every(Duration::from_micros(250));
    loop {
        RX_ALIVE.fetch_add(1, Relaxed);
        // PE, FE, NE, ORE: bits 0-3 of ISR, cleared by the same bits of ICR.
        let errors = pac::LPUART1.isr().read().0 & 0x0F;
        if errors != 0 {
            pac::LPUART1.icr().write_value(pac::usart::regs::Icr(errors));
            RX_UART_ERRORS.fetch_add(1, Relaxed);
        }
        loop {
            // The DMA counts a byte as moved once it leaves the UART, a moment before it lands in RAM (the channel
            // has a FIFO, and the display's DMA shares the bus): read only what was there 2 us ago.
            let ready = match ring.len() {
                Ok(0) => break,
                Ok(n) => n.min(chunk.len()),
                Err(_) => chunk.len(), // lapped: the read below reports it and resets the ring
            };
            cortex_m::asm::delay(320);
            match ring.read(&mut chunk[..ready]) {
                Ok((0, _)) => break,
                Ok((n, _)) => {
                    let dropped = acc.feed(&chunk[..n], on_frame);
                    RX_BAD_FRAME.fetch_add(dropped, Relaxed);
                }
                Err(_) => {
                    // The DMA lapped us: the ring resets itself and keeps running.
                    RX_UART_ERRORS.fetch_add(1, Relaxed);
                    break;
                }
            }
        }
        ticker.next().await;
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


/// The front-panel buttons to GND, with the internal pull-ups (protocol v3 `Event::Button`): id 0 confirm on D2 (PB3),
/// 1 up on D3 (PB0), 2 down on D4 (PA12). Polled every 5 ms rather than on EXTI interrupts (with an EXTI line on PA12,
/// the USB D+ pin, the MCU answered every request late): a level counts once it holds for 4 samples (20 ms), so contact
/// bounce never reaches Linux.
#[embassy_executor::task]
async fn buttons(pins: [Input<'static>; 3]) {
    let mut pressed = [false; 3];
    let mut differs = [0u8; 3];
    for (i, pin) in pins.iter().enumerate() {
        pressed[i] = pin.is_low();
    }
    let mut ticker = Ticker::every(Duration::from_millis(5));
    loop {
        ticker.next().await;
        for (i, pin) in pins.iter().enumerate() {
            if pin.is_low() == pressed[i] {
                differs[i] = 0;
                continue;
            }
            differs[i] += 1;
            if differs[i] >= 4 {
                differs[i] = 0;
                pressed[i] = !pressed[i];
                let t_ms = Instant::now().as_millis().saturating_sub(15) as u32; // when the new level began
                emit(Event::Button { id: i as u8, pressed: pressed[i], t_ms });
            }
        }
    }
}

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
    // embassy sets the UART up and transmits; its receiver gets an idle DMA channel (CH3) and is never used: the
    // link's receiver is the ring below, on CH1.
    let uart = if RTSCTS {
        Uart::new_with_rtscts(p.LPUART1, p.PG8, p.PG7, p.PG6, p.PG5, p.GPDMA1_CH0, p.GPDMA1_CH3, Irqs, uart_config)
    } else {
        Uart::new(p.LPUART1, p.PG8, p.PG7, p.GPDMA1_CH0, p.GPDMA1_CH3, Irqs, uart_config)
    }
    .unwrap();
    let (tx, rx) = uart.split();
    core::mem::forget(rx); // dropping it would stop reception
    let request = <peripherals::GPDMA1_CH1 as usart::RxDma<peripherals::LPUART1>>::request(&p.GPDMA1_CH1);
    static RX_RING: StaticCell<[u8; 1024]> = StaticCell::new();
    // SAFETY: CH1 is ours alone, and RDR is LPUART1's receive data register.
    let mut ring = unsafe {
        dma::ReadableRingBuffer::new(
            dma::Channel::new(p.GPDMA1_CH1, Irqs),
            request,
            pac::LPUART1.rdr().as_ptr() as *mut u8,
            RX_RING.init([0; 1024]),
            dma::TransferOptions::default(),
        )
    };
    ring.start();
    pac::LPUART1.cr3().modify(|w| w.set_dmar(true)); // and nothing else: no error or idle interrupts

    emit(Event::Boot { reset_cause });
    spawner.spawn(link_rx(ring).unwrap());
    spawner.spawn(link_tx(tx).unwrap());
    // Above thread mode (see EXECUTOR_HIGH), below the UART and DMA interrupts.
    interrupt::UART4.set_priority(Priority::P7);
    let high = EXECUTOR_HIGH.start(interrupt::UART4);
    high.spawn(matrix::scan(matrix_pins).unwrap());
    // LED&KEY module: STB D12 (PB14), CLK D7 (PB2), DIO D5 (PA11).
    spawner.spawn(
        ledkey::run(
            OutputOpenDrain::new_pull(p.PB14, Level::High, Speed::Low, Pull::Up),
            OutputOpenDrain::new_pull(p.PB2, Level::High, Speed::Low, Pull::Up),
            OutputOpenDrain::new_pull(p.PA11, Level::High, Speed::Low, Pull::Up),
        )
        .unwrap(),
    );
    // Front panel: confirm D2, up D3, down D4 (each to GND).
    spawner.spawn(
        buttons([
            Input::new(p.PB3, Pull::Up),
            Input::new(p.PB0, Pull::Up),
            Input::new(p.PA12, Pull::Up),
        ])
        .unwrap(),
    );

    // SPI display on the UNO header: D13 SCK, D11 MOSI, D10 CS, D9 DC, D8 RES, D6 BL.
    let mut spi_config = spi::Config::default();
    spi_config.frequency = Hertz(LCD_SPI_HZ);
    let lcd_spi = Spi::new_txonly(p.SPI2, p.PB13, p.PB15, p.GPDMA1_CH2, Irqs, spi_config);
    spawner.spawn(
        display::run(
            lcd_spi,
            Output::new(p.PB9, Level::High, Speed::VeryHigh), // CS, idle high
            Output::new(p.PB8, Level::Low, Speed::VeryHigh),  // DC
            Output::new(p.PB4, Level::High, Speed::Low),      // RES
            Output::new(p.PB1, Level::Low, Speed::Low),       // backlight off until the first frame
        )
        .unwrap(),
    );

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
