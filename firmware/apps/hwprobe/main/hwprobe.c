// Fractonica hardware probe (M0 spikes S0, S2, S4, S5).
// Reports board facts and link quality as one JSON object per line, prefixed with "PROBE ".
// Order: identity -> I2C scan -> OLED test frame -> LED polarity test -> Wi-Fi scan/connect ->
// mDNS lookup of the hub host -> TCP/UDP round trips to the hub echo server -> live loop
// (BOOT button events, RSSI, periodic summary).

#include <ctype.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_chip_info.h"
#include "esp_event.h"
#include "esp_flash.h"
#include "esp_idf_version.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "mdns.h"
#include "nvs_flash.h"

#include "font5x7.h"

#define PROBE(fmt, ...) printf("PROBE " fmt "\n", ##__VA_ARGS__)

#define RTT_SAMPLES 200

static struct {
    char mac[13];
    int oled_sda, oled_scl, oled_addr;
    int wifi_ch, wifi_rssi, wifi_connect_ms;
    char wifi_bssid[18], wifi_ip[16];
    int mdns_ok, mdns_ms;
    char hub_ip[16];
    int tcp_ok, tcp_p50_us, tcp_p99_us, tcp_max_us;
    int udp_ok, udp_lost, udp_p50_us, udp_p99_us;
    int presses;
} R = {.oled_sda = -1, .oled_scl = -1, .oled_addr = -1, .mdns_ok = -1, .tcp_ok = -1, .udp_ok = -1};

static int64_t now_us(void) { return esp_timer_get_time(); }

// ---------------------------------------------------------------- OLED
// SSD1306B with a 72x40 visible window starting at RAM column 28 (0.42" C3 OLED boards).

#define OLED_W 72
#define OLED_H 40
#define OLED_COL0 28

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_oled;
static uint8_t s_fb[OLED_W * (OLED_H / 8)];
static char s_lines[OLED_H / 8][OLED_W / 6 + 1];

static esp_err_t oled_cmds(const uint8_t *cmds, size_t n)
{
    uint8_t buf[40];
    if (n + 1 > sizeof(buf)) {
        return ESP_ERR_INVALID_SIZE;
    }
    buf[0] = 0x00;  // control byte: command stream
    memcpy(buf + 1, cmds, n);
    return i2c_master_transmit(s_oled, buf, n + 1, 50);
}

static esp_err_t oled_init(void)
{
    static const uint8_t init[] = {
        0xAE,        // display off
        0xD5, 0x80,  // clock divide
        0xA8, 0x27,  // multiplex ratio: 40 rows
        0xD3, 0x00,  // display offset
        0x40,        // start line 0
        0x8D, 0x14,  // charge pump on
        0x20, 0x00,  // horizontal addressing
        0xA1, 0xC8,  // segment remap, COM scan descending
        0xDA, 0x12,  // COM pins
        0x81, 0xCF,  // contrast
        0xD9, 0xF1,  // pre-charge
        0xDB, 0x40,  // VCOMH
        0xAD, 0x30,  // internal IREF (SSD1306B)
        0x2E, 0xA4, 0xA6, 0xAF,
    };
    return oled_cmds(init, sizeof(init));
}

static void oled_flush(void)
{
    if (!s_oled) {
        return;
    }
    static const uint8_t window[] = {0x21, OLED_COL0, OLED_COL0 + OLED_W - 1, 0x22, 0, OLED_H / 8 - 1};
    oled_cmds(window, sizeof(window));
    uint8_t buf[OLED_W + 1];
    buf[0] = 0x40;  // control byte: data
    for (int page = 0; page < OLED_H / 8; page++) {
        memcpy(buf + 1, s_fb + page * OLED_W, OLED_W);
        i2c_master_transmit(s_oled, buf, sizeof(buf), 50);
    }
}

static void fb_pixel(int x, int y)
{
    if (x >= 0 && x < OLED_W && y >= 0 && y < OLED_H) {
        s_fb[(y / 8) * OLED_W + x] |= (uint8_t)(1u << (y % 8));
    }
}

static void fb_text(int page, const char *s)
{
    for (int x = 0; *s && x + 5 <= OLED_W; s++, x += 6) {
        const char *hit = strchr(FONT5X7_CHARS, toupper((unsigned char)*s));
        int idx = hit ? (int)(hit - FONT5X7_CHARS) : 0;
        memcpy(&s_fb[page * OLED_W + x], FONT5X7[idx], 5);
    }
}

static void set_line(int i, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(s_lines[i], sizeof(s_lines[i]), fmt, ap);
    va_end(ap);
}

static void oled_show_lines(void)
{
    memset(s_fb, 0, sizeof(s_fb));
    for (int p = 0; p < OLED_H / 8; p++) {
        fb_text(p, s_lines[p]);
    }
    oled_flush();
}

static void oled_test_frame(void)
{
    memset(s_fb, 0, sizeof(s_fb));
    for (int x = 0; x < OLED_W; x++) {
        fb_pixel(x, 0);
        fb_pixel(x, OLED_H - 1);
    }
    for (int y = 0; y < OLED_H; y++) {
        fb_pixel(0, y);
        fb_pixel(OLED_W - 1, y);
    }
    for (int d = 0; d < 6; d++) {  // corner diagonals make clipping obvious
        fb_pixel(2 + d, 2 + d);
        fb_pixel(OLED_W - 3 - d, OLED_H - 3 - d);
    }
    fb_text(2, "  FRACTONICA");
    oled_flush();
}

// ---------------------------------------------------------------- I2C scan

static int scan_bus(int sda, int scl, uint16_t lo, uint16_t hi, uint16_t *found, int max)
{
    i2c_master_bus_config_t cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = (gpio_num_t)sda,
        .scl_io_num = (gpio_num_t)scl,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t bus;
    if (i2c_new_master_bus(&cfg, &bus) != ESP_OK) {
        return -1;
    }
    int n = 0;
    for (uint16_t a = lo; a <= hi && n < max; a++) {
        if (i2c_master_probe(bus, a, 20) == ESP_OK) {
            found[n++] = a;
        }
    }
    i2c_del_master_bus(bus);
    return n;
}

static void oled_setup(void)
{
    // Safe pins only: no USB (18/19), flash (11-17), LED/strap (8) or BOOT (9).
    static const int pins[] = {0, 1, 2, 3, 4, 5, 6, 7, 10, 20, 21};
    const int npins = sizeof(pins) / sizeof(pins[0]);
    uint16_t found[8];
    int sda = CONFIG_HWPROBE_OLED_SDA, scl = CONFIG_HWPROBE_OLED_SCL;

    int n = scan_bus(sda, scl, 0x08, 0x77, found, 8);
    char list[48] = "";
    for (int i = 0; i < n; i++) {
        snprintf(list + strlen(list), sizeof(list) - strlen(list), "%s%d", i ? "," : "", found[i]);
    }
    PROBE("{\"t\":\"i2c_scan\",\"sda\":%d,\"scl\":%d,\"found\":[%s]}", sda, scl, list);

    if (n <= 0) {  // display not on the expected pins: sweep other pairs for 0x3C/0x3D only
        for (int i = 0; i < npins && n <= 0; i++) {
            for (int j = 0; j < npins && n <= 0; j++) {
                if (i == j || (pins[i] == sda && pins[j] == scl)) {
                    continue;
                }
                n = scan_bus(pins[i], pins[j], 0x3C, 0x3D, found, 8);
                if (n > 0) {
                    sda = pins[i];
                    scl = pins[j];
                    PROBE("{\"t\":\"i2c_sweep_hit\",\"sda\":%d,\"scl\":%d,\"addr\":%d}", sda, scl, found[0]);
                }
            }
        }
    }
    if (n <= 0) {
        PROBE("{\"t\":\"oled\",\"present\":false}");
        return;
    }

    uint16_t addr = found[0];
    for (int i = 0; i < n; i++) {
        if (found[i] == 0x3C || found[i] == 0x3D) {
            addr = found[i];
        }
    }
    i2c_master_bus_config_t cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = (gpio_num_t)sda,
        .scl_io_num = (gpio_num_t)scl,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&cfg, &s_bus));
    i2c_device_config_t dev = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = 400000,
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(s_bus, &dev, &s_oled));
    esp_err_t r = oled_init();
    R.oled_sda = sda;
    R.oled_scl = scl;
    R.oled_addr = addr;
    PROBE("{\"t\":\"oled\",\"present\":true,\"sda\":%d,\"scl\":%d,\"addr\":%d,\"init\":\"%s\"}",
          sda, scl, addr, esp_err_to_name(r));
    oled_test_frame();
    vTaskDelay(pdMS_TO_TICKS(3000));
}

// ---------------------------------------------------------------- LED + button

static void led_test(void)
{
    const int gpio = CONFIG_HWPROBE_LED_GPIO;
    gpio_reset_pin((gpio_num_t)gpio);
    gpio_set_direction((gpio_num_t)gpio, GPIO_MODE_OUTPUT);
    for (int i = 0; i < 3; i++) {
        for (int level = 0; level <= 1; level++) {
            gpio_set_level((gpio_num_t)gpio, level);
            set_line(4, "LED PIN %s", level ? "HIGH" : "LOW");
            oled_show_lines();
            PROBE("{\"t\":\"led\",\"gpio\":%d,\"level\":%d}", gpio, level);
            vTaskDelay(pdMS_TO_TICKS(700));
        }
    }
    gpio_set_level((gpio_num_t)gpio, 1);  // off if active-low
}

typedef struct {
    int64_t t_us;
    int level;
} btn_evt_t;

static QueueHandle_t s_btn_q;

static void btn_isr(void *arg)
{
    btn_evt_t e = {.t_us = esp_timer_get_time(), .level = gpio_get_level((gpio_num_t)(intptr_t)arg)};
    BaseType_t woken = pdFALSE;
    xQueueSendFromISR(s_btn_q, &e, &woken);
    if (woken) {
        portYIELD_FROM_ISR();
    }
}

static void button_setup(void)
{
    const int gpio = CONFIG_HWPROBE_BUTTON_GPIO;
    s_btn_q = xQueueCreate(32, sizeof(btn_evt_t));
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << gpio,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .intr_type = GPIO_INTR_ANYEDGE,
    };
    ESP_ERROR_CHECK(gpio_config(&io));
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_isr_handler_add((gpio_num_t)gpio, btn_isr, (void *)(intptr_t)gpio));
    PROBE("{\"t\":\"button\",\"gpio\":%d,\"idle_level\":%d}", gpio, gpio_get_level((gpio_num_t)gpio));
}

// ---------------------------------------------------------------- Wi-Fi + mDNS

#define WIFI_GOT_IP BIT0
#define WIFI_FAILED BIT1
static EventGroupHandle_t s_wifi_ev;

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *d = data;
        PROBE("{\"t\":\"wifi_disconnected\",\"reason\":%d,\"rssi\":%d}", d->reason, d->rssi);
        xEventGroupSetBits(s_wifi_ev, WIFI_FAILED);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        snprintf(R.wifi_ip, sizeof(R.wifi_ip), IPSTR, IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(s_wifi_ev, WIFI_GOT_IP);
    }
}

static void json_safe(char *dst, size_t n, const char *src)
{
    size_t i = 0;
    for (; src[i] && i + 1 < n; i++) {
        unsigned char c = (unsigned char)src[i];
        dst[i] = (c < 0x20 || c == '"' || c == '\\' || c > 0x7E) ? '?' : (char)c;
    }
    dst[i] = 0;
}

static bool wifi_bringup(void)
{
    esp_err_t r = nvs_flash_init();
    if (r == ESP_ERR_NVS_NO_FREE_PAGES || r == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    s_wifi_ev = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());

    set_line(3, "WIFI SCAN");
    oled_show_lines();
    static wifi_ap_record_t recs[16];
    uint16_t num = 16;
    wifi_scan_config_t sc = {0};
    int64_t t0 = now_us();
    esp_wifi_scan_start(&sc, true);
    esp_wifi_scan_get_ap_records(&num, recs);
    PROBE("{\"t\":\"wifi_scan\",\"count\":%d,\"ms\":%d}", num, (int)((now_us() - t0) / 1000));
    for (int i = 0; i < num; i++) {
        char ssid[33];
        json_safe(ssid, sizeof(ssid), (const char *)recs[i].ssid);
        PROBE("{\"t\":\"ap\",\"ssid\":\"%s\",\"ch\":%d,\"rssi\":%d,\"bssid\":\"" MACSTR "\",\"auth\":%d,\"ax\":%d,"
              "\"target\":%s}",
              ssid, recs[i].primary, recs[i].rssi, MAC2STR(recs[i].bssid), recs[i].authmode, recs[i].phy_11ax,
              strcmp((const char *)recs[i].ssid, CONFIG_HWPROBE_WIFI_SSID) == 0 ? "true" : "false");
    }

    wifi_config_t wc = {0};
    snprintf((char *)wc.sta.ssid, sizeof(wc.sta.ssid), "%s", CONFIG_HWPROBE_WIFI_SSID);
    snprintf((char *)wc.sta.password, sizeof(wc.sta.password), "%s", CONFIG_HWPROBE_WIFI_PASS);
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));

    for (int attempt = 1; attempt <= 3; attempt++) {
        set_line(3, "WIFI JOIN %d", attempt);
        oled_show_lines();
        xEventGroupClearBits(s_wifi_ev, WIFI_GOT_IP | WIFI_FAILED);
        t0 = now_us();
        esp_wifi_connect();
        EventBits_t bits = xEventGroupWaitBits(s_wifi_ev, WIFI_GOT_IP | WIFI_FAILED, pdTRUE, pdFALSE,
                                               pdMS_TO_TICKS(15000));
        if (bits & WIFI_GOT_IP) {
            R.wifi_connect_ms = (int)((now_us() - t0) / 1000);
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    if (!R.wifi_ip[0]) {
        PROBE("{\"t\":\"wifi\",\"ok\":false}");
        set_line(3, "WIFI FAILED");
        oled_show_lines();
        return false;
    }
    esp_wifi_set_ps(WIFI_PS_NONE);
    wifi_ap_record_t ap;
    esp_wifi_sta_get_ap_info(&ap);
    R.wifi_ch = ap.primary;
    R.wifi_rssi = ap.rssi;
    snprintf(R.wifi_bssid, sizeof(R.wifi_bssid), MACSTR, MAC2STR(ap.bssid));
    PROBE("{\"t\":\"wifi\",\"ok\":true,\"ip\":\"%s\",\"ch\":%d,\"rssi\":%d,\"bssid\":\"%s\",\"connect_ms\":%d,"
          "\"phy\":\"%s%s%s%s\"}",
          R.wifi_ip, R.wifi_ch, R.wifi_rssi, R.wifi_bssid, R.wifi_connect_ms, ap.phy_11b ? "b" : "",
          ap.phy_11g ? "g" : "", ap.phy_11n ? "n" : "", ap.phy_11ax ? "ax" : "");
    set_line(3, "CH%d %dDBM", R.wifi_ch, R.wifi_rssi);
    oled_show_lines();
    return true;
}

static void hub_lookup(void)
{
    snprintf(R.hub_ip, sizeof(R.hub_ip), "%s", CONFIG_HWPROBE_HUB_IP);
    if (mdns_init() != ESP_OK) {
        return;
    }
    esp_ip4_addr_t a = {0};
    int64_t t0 = now_us();
    esp_err_t r = mdns_query_a(CONFIG_HWPROBE_HUB_HOST, 3000, &a);
    R.mdns_ms = (int)((now_us() - t0) / 1000);
    R.mdns_ok = (r == ESP_OK);
    if (R.mdns_ok) {
        snprintf(R.hub_ip, sizeof(R.hub_ip), IPSTR, IP2STR(&a));
    }
    PROBE("{\"t\":\"mdns\",\"host\":\"%s.local\",\"ok\":%s,\"ip\":\"%s\",\"ms\":%d,\"err\":\"%s\"}",
          CONFIG_HWPROBE_HUB_HOST, R.mdns_ok ? "true" : "false", R.mdns_ok ? R.hub_ip : "", R.mdns_ms,
          esp_err_to_name(r));
}

// ---------------------------------------------------------------- round trips

static int cmp_i64(const void *a, const void *b)
{
    int64_t x = *(const int64_t *)a, y = *(const int64_t *)b;
    return (x > y) - (x < y);
}

static void rtt_stats(int64_t *s, int n, int *p50, int *p99, int *max)
{
    if (n <= 0) {
        *p50 = *p99 = *max = -1;
        return;
    }
    qsort(s, n, sizeof(s[0]), cmp_i64);
    *p50 = (int)s[n / 2];
    *p99 = (int)s[(n * 99) / 100 < n ? (n * 99) / 100 : n - 1];
    *max = (int)s[n - 1];
}

static void tcp_rtt(void)
{
    static int64_t rtt[RTT_SAMPLES];
    int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    struct timeval tv = {.tv_sec = 2};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    struct sockaddr_in sa = {.sin_family = AF_INET, .sin_port = htons(CONFIG_HWPROBE_HUB_PORT)};
    inet_pton(AF_INET, R.hub_ip, &sa.sin_addr);
    int64_t t0 = now_us();
    if (connect(fd, (struct sockaddr *)&sa, sizeof(sa)) != 0) {
        PROBE("{\"t\":\"tcp\",\"ok\":false,\"stage\":\"connect\",\"errno\":%d}", errno);
        close(fd);
        R.tcp_ok = 0;
        return;
    }
    int connect_ms = (int)((now_us() - t0) / 1000);
    int ok = 0;
    for (int i = 0; i < RTT_SAMPLES; i++) {
        uint8_t m[16] = {0};
        int64_t t = now_us();
        memcpy(m, &i, 4);
        memcpy(m + 4, &t, 8);
        if (send(fd, m, sizeof(m), 0) != sizeof(m)) {
            break;
        }
        int got = 0;
        while (got < (int)sizeof(m)) {
            int k = recv(fd, m + got, sizeof(m) - got, 0);
            if (k <= 0) {
                break;
            }
            got += k;
        }
        if (got != (int)sizeof(m)) {
            break;
        }
        rtt[ok++] = now_us() - t;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    close(fd);
    R.tcp_ok = ok;
    rtt_stats(rtt, ok, &R.tcp_p50_us, &R.tcp_p99_us, &R.tcp_max_us);
    PROBE("{\"t\":\"tcp\",\"ok\":%d,\"sent\":%d,\"connect_ms\":%d,\"p50_us\":%d,\"p99_us\":%d,\"max_us\":%d}", ok,
          RTT_SAMPLES, connect_ms, R.tcp_p50_us, R.tcp_p99_us, R.tcp_max_us);
}

static void udp_rtt(void)
{
    static int64_t rtt[RTT_SAMPLES];
    int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    struct timeval tv = {.tv_usec = 300000};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    struct sockaddr_in sa = {.sin_family = AF_INET, .sin_port = htons(CONFIG_HWPROBE_HUB_PORT)};
    inet_pton(AF_INET, R.hub_ip, &sa.sin_addr);
    int ok = 0, lost = 0;
    for (int i = 0; i < RTT_SAMPLES; i++) {
        uint8_t m[16] = {0};
        int64_t t = now_us();
        memcpy(m, &i, 4);
        memcpy(m + 4, &t, 8);
        sendto(fd, m, sizeof(m), 0, (struct sockaddr *)&sa, sizeof(sa));
        uint8_t in[16];
        int k = recv(fd, in, sizeof(in), 0);
        if (k == (int)sizeof(in) && memcmp(in, m, 4) == 0) {
            rtt[ok++] = now_us() - t;
        } else {
            lost++;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    close(fd);
    R.udp_ok = ok;
    R.udp_lost = lost;
    int max;
    rtt_stats(rtt, ok, &R.udp_p50_us, &R.udp_p99_us, &max);
    PROBE("{\"t\":\"udp\",\"ok\":%d,\"lost\":%d,\"p50_us\":%d,\"p99_us\":%d,\"max_us\":%d}", ok, lost, R.udp_p50_us,
          R.udp_p99_us, max);
}

// ---------------------------------------------------------------- main

static void print_summary(void)
{
    PROBE("{\"t\":\"summary\",\"mac\":\"%s\",\"oled\":{\"sda\":%d,\"scl\":%d,\"addr\":%d},"
          "\"wifi\":{\"ip\":\"%s\",\"ch\":%d,\"rssi\":%d,\"bssid\":\"%s\",\"connect_ms\":%d},"
          "\"mdns\":{\"ok\":%d,\"ms\":%d},\"hub_ip\":\"%s\","
          "\"tcp\":{\"ok\":%d,\"p50_us\":%d,\"p99_us\":%d,\"max_us\":%d},"
          "\"udp\":{\"ok\":%d,\"lost\":%d,\"p50_us\":%d,\"p99_us\":%d},\"presses\":%d}",
          R.mac, R.oled_sda, R.oled_scl, R.oled_addr, R.wifi_ip, R.wifi_ch, R.wifi_rssi, R.wifi_bssid,
          R.wifi_connect_ms, R.mdns_ok, R.mdns_ms, R.hub_ip, R.tcp_ok, R.tcp_p50_us, R.tcp_p99_us, R.tcp_max_us,
          R.udp_ok, R.udp_lost, R.udp_p50_us, R.udp_p99_us, R.presses);
}

static void report_identity(void)
{
    esp_chip_info_t ci;
    esp_chip_info(&ci);
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_EFUSE_FACTORY);
    snprintf(R.mac, sizeof(R.mac), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    uint32_t flash = 0;
    esp_flash_get_physical_size(NULL, &flash);
    PROBE("{\"t\":\"identity\",\"model\":%d,\"rev\":%d,\"cores\":%d,\"mac\":\"%s\",\"flash\":%lu,\"idf\":\"%s\"}",
          ci.model, ci.revision, ci.cores, R.mac, (unsigned long)flash, esp_get_idf_version());
}

void app_main(void)
{
    vTaskDelay(pdMS_TO_TICKS(3000));  // give the host time to attach to USB-Serial/JTAG
    PROBE("{\"t\":\"start\",\"app\":\"hwprobe\",\"v\":1}");
    report_identity();

    oled_setup();
    set_line(0, "FRACTONICA");
    set_line(1, "ID %.6s", R.mac + 6);
    set_line(2, "BTN UP N:0");
    oled_show_lines();
    button_setup();
    led_test();

    if (CONFIG_HWPROBE_WIFI_SSID[0] && wifi_bringup()) {
        hub_lookup();
        if (R.hub_ip[0]) {
            set_line(4, "RTT TEST");
            oled_show_lines();
            tcp_rtt();
            udp_rtt();
            if (R.tcp_ok > 0) {
                set_line(4, "TCP %d.%dMS", R.tcp_p50_us / 1000, (R.tcp_p50_us % 1000) / 100);
            } else {
                set_line(4, "NO HUB ECHO");
            }
            oled_show_lines();
        }
    }
    PROBE("{\"t\":\"done\"}");
    print_summary();

    int stable = gpio_get_level((gpio_num_t)CONFIG_HWPROBE_BUTTON_GPIO);
    int64_t last_change = 0, last_tick = now_us();
    for (;;) {
        btn_evt_t e;
        if (xQueueReceive(s_btn_q, &e, pdMS_TO_TICKS(100))) {
            vTaskDelay(pdMS_TO_TICKS(20));  // debounce: settle, then sample
            int level = gpio_get_level((gpio_num_t)CONFIG_HWPROBE_BUTTON_GPIO);
            xQueueReset(s_btn_q);
            if (level != stable && e.t_us - last_change > 20000) {
                stable = level;
                last_change = e.t_us;
                bool down = (level == 0);
                if (down) {
                    R.presses++;
                }
                gpio_set_level((gpio_num_t)CONFIG_HWPROBE_LED_GPIO, down ? 0 : 1);
                PROBE("{\"t\":\"button_evt\",\"state\":\"%s\",\"t_us\":%lld,\"presses\":%d}", down ? "down" : "up",
                      (long long)e.t_us, R.presses);
                set_line(2, "BTN %s N:%d", down ? "DOWN" : "UP", R.presses);
                oled_show_lines();
            }
        }
        if (now_us() - last_tick > 10000000) {
            last_tick = now_us();
            wifi_ap_record_t ap;
            if (R.wifi_ip[0] && esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
                R.wifi_rssi = ap.rssi;
                set_line(3, "CH%d %dDBM", ap.primary, ap.rssi);
                oled_show_lines();
            }
            print_summary();
        }
    }
}
