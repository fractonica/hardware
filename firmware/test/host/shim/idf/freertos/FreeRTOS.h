// Host shim (firmware/test/host/shim/esp_sim.hpp): the spinlock critical sections. One CPU here: entering one
// masks the shim's interrupts (a GPIO edge's ISR runs once the outermost section is left), as a critical section
// on the core that runs the ISRs does.
#pragma once

typedef struct {
    int count;
} portMUX_TYPE;

#define portMUX_INITIALIZER_UNLOCKED {0}

void esp_sim_enter_critical(portMUX_TYPE *mux);
void esp_sim_exit_critical(portMUX_TYPE *mux);

#define portENTER_CRITICAL(mux) esp_sim_enter_critical(mux)
#define portEXIT_CRITICAL(mux) esp_sim_exit_critical(mux)
#define portENTER_CRITICAL_ISR(mux) esp_sim_enter_critical(mux)
#define portEXIT_CRITICAL_ISR(mux) esp_sim_exit_critical(mux)
