# On-device AI inference and agent-runtime feasibility on the Arduino UNO Q (QRB2210), as of Nov 2026

Scope: what AI runs locally on the UNO Q (Cortex-A53 x4 @ 2.0 GHz, Adreno 702, Hexagon DSP, 2 GB or 4 GB LPDDR4X), which toolchains, how fast, and what has to go to a host PC or the cloud. Research date: 2026-11-08. The VENTUNO Q is a different, much stronger board (Dragonwing IQ8-series SoC). Its numbers do NOT carry over to the UNO Q, and some search-engine summaries mix the two up (see the accelerators section).

---

## 1. Local LLM inference: runtimes, tokens/sec, RAM (2 GB vs 4 GB), tool calling

### Takeaway
LLMs on the UNO Q run only on the CPU, through llama.cpp (Arduino's official App Lab path) or Ollama. Sub-1B to 1.1B Q4 models measure a consistent **~4.5–5.5 tok/s generation and ~10 tok/s prompt processing** on all four A53 cores. One unverified outlier claims ~8 tok/s. Prompt processing that slow is the real bottleneck for agents: one tool-calling decision with a ~400-token tool prompt takes **~49 s cold and ~11–16 s with KV-cache reuse**. Qwen3.5-0.8B can call a couple of tools (14/16 in a small test). Gemma 3 1B can't call tools through the stock template. Models at 1.5B and above don't fit in 2 GB.

### Cited Findings

**Official runtime configuration (primary source: Arduino's GitHub)**
- The App Lab "Large Language Model - Text" brick (`arduino:llm`) uses `llamacpp:Qwen3.5-0.8B-Q4_0` by default on the UNO Q. The VENTUNO Q default is `genie:qwen3_4b_instruct_2507`, which runs on Qualcomm's Genie/QNN runtime. Default context `LLAMA_ARG_CTX_SIZE` is 16384. — [arduino/app-bricks-py llm/brick_config.yaml](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/llm/brick_config.yaml)
- The UNO Q llama.cpp service (`service_compose.unoq.yaml`) runs the container `llamacpp-runner` with `mem_limit: 2500m` / `memswap_limit: 2500m`. Settings: 4 threads, `LLAMA_ARG_BATCH=512`, `UBATCH=128`, flash-attention on, `LLAMA_ARG_MODELS_MAX=1`, reasoning off (`LLAMA_ARG_THINK_BUDGET=0`), OpenAI-compatible server on port 9999. — [service_compose.unoq.yaml](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_services/llamacpp/service_compose.unoq.yaml)
- The UNO Q runner image ships a **CPU-only** llama.cpp build (`llamacpp-cpu-20261103.tar.gz`, installed to `/opt/pkg-cpu`) and starts `llama-server --device none`. — [llamacpp-runner Dockerfile](https://github.com/arduino/app-bricks-py/blob/main/containers/ai/llamacpp-runner/Dockerfile), [run-model-router.sh](https://github.com/arduino/app-bricks-py/blob/main/containers/ai/llamacpp-runner/scripts/run-model-router.sh)
- App Lab's model picker offers Gemma 3 1B (722 MB, `gemma-3-1b-it-Q4_0`) and Qwen 3.5 0.8B (507 MB). — [raspberry.tips, local AI chatbot, 21 Aug 2026](https://raspberry.tips/en/arduino/arduino-uno-q-local-ai-chatbot)

**Measured throughput on UNO Q**

| Source (date, RAM) | Runtime | Model / quant | Prompt proc. | Generation | Notes |
|---|---|---|---|---|---|
| [Mischianti, 4 Nov 2026, 4 GB ABX00173](https://mischianti.org/arduino-uno-q-a-local-ai-agent-that-drives-the-hardware/) | App Lab llama.cpp | Qwen3.5-0.8B Q4_0 | 9.8 tok/s | 4.6 tok/s (~3.4 words/s) | load 7.0 s; first word (short msg) 5.3 s |
| same | same | Gemma 3 1B Q4_0 | 10.0 tok/s | 5.3 tok/s | load 9.0 s; first word 5.1 s |
| same (streaming runs) | same | Qwen3.5-0.8B Q4_0 | — | 4.49 / 4.42 tok/s | TTFT 9.20 s on first run, 0.85 s on second; 73.5 s for a long answer |
| same (streaming) | same | Gemma 3 1B Q4_0 | — | 5.01 tok/s | TTFT 2.24 s; 104.4 s for a long answer |
| [raspberry.tips, 21 Aug 2026, likely 4 GB](https://raspberry.tips/en/arduino/arduino-uno-q-local-ai-chatbot) | llama-server `--device none` | Gemma 3 1B Q4_0 | ~9.7 tok/s | ~5.5 tok/s, stable across runs | TTFT ~2 s; 3-sentence answer ~14 s; longer answers >1 min; all 4 cores ~99% |
| [Geerling sbc-reviews #83, Oct 2025, 2 GB](https://github.com/geerlingguy/sbc-reviews/issues/83) | Ollama | tinyllama:1.1b | — | 5.34 / 5.50 / 5.50, avg **5.44 tok/s** | `deepseek-r1:1.5b` **failed**: needed 1.5 GiB, only 1.0 GiB free |
| [raspberry.tips review, 8 Nov 2026, 4 GB](https://raspberry.tips/en/arduino/arduino-uno-q-review-vs-raspberry-pi-5) | Ollama | tinyllama | — | — | time to first answer 4.2 s (Pi 5: <1 s) |
| [dev.to "UnoQ's Claw", May 2026, 4 GB](https://dev.to/david_laurenvil_5d43bea48/i-built-the-unoqs-claw-a-tiny-agentic-ai-assistant-that-lives-inside-an-arduino-uno-q-g48) | llama-server, mlocked, q8_0 KV cache, 8K ctx | Qwen3.5-0.8B Q4_0 (~490 MB) | not given | "roughly 8 tok/s" | **Unverified outlier**, ~1.6x every other report. Same author: a cold prefill plus decode on one `read_file` tool iteration took "roughly 10 to 20 minutes" |

- Multimodal: SmolVLM-500M under llama.cpp on the CPU gave a prompt eval of 4.08 tok/s and ~22.3 s per image query on a **2 GB** board (peak RAM 780 MB of 1.70 GB available). The **4 GB** board gave 3.96 tok/s and ~23.3 s (peak 1.21 GB of 3.58 GB). The vision encoder took >90% of compute, and CPU sat at 99–100%. SmolVLM-256M (Q8_0) was less reliable for captioning. — [Hackster, "Running local VLMs on Arduino UNO Q", 15 Jun 2026](https://www.hackster.io/sologithu/running-local-vlms-on-arduino-uno-q-with-the-app-lab-70e8e3)
- An Edge Impulse tutorial runs SmolLM2-135M-Instruct and SmolVLM2-500M-Video-Instruct through **yzma**, a Go wrapper for llama.cpp by Ron Evans. No tok/s figures are given. — [Hackster News](https://www.hackster.io/news/how-to-run-high-performance-llms-locally-on-the-arduino-uno-q-5d537abafc29), underlying guide [Arduino Project Hub (Marc Pous)](https://projecthub.arduino.cc/marc-edgeimpulse/running-local-llms-and-vlms-on-the-arduino-uno-q-with-yzma-74e288)

**Memory and system context**
- RAM, llama-server process (4 GB board): Qwen 950 MB after load, **growing to 2.5 GB (the container limit) after many requests**. Gemma stayed at ~980 MB because it reuses almost no cache. The author warns: "On a 2 GB UNO Q, keep an eye on it." — [Mischianti](https://mischianti.org/arduino-uno-q-a-local-ai-agent-that-drives-the-hardware/)
- System RAM on 4 GB: ~720 MB idle, ~930 MB with Gemma 3 1B loaded ("of 3.6 GB"). The article says memory was never the bottleneck. — [raspberry.tips chatbot](https://raspberry.tips/en/arduino/arduino-uno-q-local-ai-chatbot)
- The whole QClaw agent (Go gateway + llama-server + Qwen3.5-0.8B, 8K ctx) runs at "around 1.3 GB" on a 4 GB board. — [dev.to](https://dev.to/david_laurenvil_5d43bea48/i-built-the-unoqs-claw-a-tiny-agentic-ai-assistant-that-lives-inside-an-arduino-uno-q-g48)
- On a 2 GB board, Geekbench 6 multi-core crashed until a 2 GB swapfile was added. — [Geerling](https://github.com/geerlingguy/sbc-reviews/issues/83)
- Storage limit: the root partition (~9.8 GB) filled up during model download. The fix was moving Docker's data root to the ~17 GB `/home/arduino` partition. — [raspberry.tips chatbot](https://raspberry.tips/en/arduino/arduino-uno-q-local-ai-chatbot)
- Memory bandwidth is low, and it bounds LLM decode. tinymembench C copy: 2212 MB/s, NEON copy: 2268.5 MB/s, random read latency at 64 MiB: 196 ns. — [Geerling](https://github.com/geerlingguy/sbc-reviews/issues/83). sysbench memory: 5,041 MiB/s on UNO Q vs 11,837 on Pi 5. sysbench CPU (4 threads): 4,043 vs 10,589 events/s. — [raspberry.tips review](https://raspberry.tips/en/arduino/arduino-uno-q-review-vs-raspberry-pi-5)
- CPU: Geekbench 6 gave 187 single-core / 530 multi-core. HPL gave 9.597 Gflops. — [Geerling](https://github.com/geerlingguy/sbc-reviews/issues/83)

**Tool calling with small models (only published test found)**
- Setup: Qwen3.5-0.8B with two tools, `read_temperature()` and `set_fan(on, reason)`, temperature 0.2, 16 test prompts.
- Results: "Agent (tools) fan right" **14/16** with 0 unwanted fan moves. The misses were "I'm cold." and "I'm sweating like crazy.", where the model read the temperature and stopped. In "choice" mode (no tools, the code picks from a list), Qwen scored 14/16 and Gemma 3 1B also scored 14/16.
- **Gemma 3 1B: "The chat template drops the tools"**, so it never sees them, and `chat()` silently returns plain text.
- Latency: prompt with tools 386 tokens. First tool decision cold **49 s**, same decision with cache **11 s**. Agent time per message 16 s. Choice-mode time per message 6.9 s (Qwen) vs 12.5 s (Gemma). Prompt reused from cache: 367 of 386 tokens.
- End-to-end runs: chat with a tool call took 54.55 s on the first question (including model load) and 29.34 s on the second. A background "monitor" decision with two tool calls took **83.33 s**.
- All of the above: [Mischianti, 4 Nov 2026](https://mischianti.org/arduino-uno-q-a-local-ai-agent-that-drives-the-hardware/)
- QClaw (8 tools, ~3.4K-character tool schema) adds a regex pre-router (23 rules over 15 skills) that inlines the matching SKILL.md so the model needs fewer iterations. A "direct path" without the agent loop had ~33% lower latency on factual prompts. No reliability numbers were published. — [dev.to](https://dev.to/david_laurenvil_5d43bea48/i-built-the-unoqs-claw-a-tiny-agentic-ai-assistant-that-lives-inside-an-arduino-uno-q-g48)
- Factual reliability is poor. Gemma 3 1B described the UNO Q as "a modified Uno board" and gave the wrong core count ("Two"). — [raspberry.tips chatbot](https://raspberry.tips/en/arduino/arduino-uno-q-local-ai-chatbot). Mischianti's advice: "Give it facts through tools, never ask it for them." — [Mischianti](https://mischianti.org/arduino-uno-q-a-local-ai-agent-that-drives-the-hardware/)

**VENTUNO Q numbers (a different SoC; do not apply to the UNO Q)**
- Arduino's llama.cpp guide for the VENTUNO Q reports ~7.4 tok/s on the Adreno GPU with OpenCL and ~25 tok/s via NPU. — [Arduino docs, VENTUNO Q llama.cpp](https://docs.arduino.cc/tutorials/ventuno-q/llama-cpp/). The VENTUNO Q is "powered by Qualcomm Dragonwing IQ8 Series". — [edge-ai-vision.com, Mar 2026](https://www.edge-ai-vision.com/2026/03/arduino-announces-arduino-ventuno-q-powered-by-qualcomm-dragonwing-iq8-series/). A web-search summary claimed the VENTUNO Q uses "the same Qualcomm chip family" as the UNO Q. That is wrong.

### Inferences
- The numbers agree with each other. Prefill at ~10 tok/s puts a 386-token tool prompt at ~39 s, which matches the measured 49 s cold decision once load and generation are added. Rough rule: **every 100 tokens of uncached prompt cost ~10 s, and every 100 generated tokens cost ~20 s.**
- An MCP tool catalog of even 5–10 tools (often 1–3K tokens of JSON schema) gives a cold first turn of roughly **2–5 minutes** on-device. That is consistent with the "10–20 minutes per iteration" QClaw anecdote for an 8-tool, ~3.4K-character schema with longer contexts (estimate).
- Decode is memory-bandwidth-bound. A ~0.5 GB Q4 weight file at ~2.2–5 GB/s gives a theoretical ceiling of ~4–10 tok/s, so the observed ~4.5–5.5 tok/s is near the limit. Software tuning is unlikely to give more than modest gains. The 8 tok/s claim would need independent confirmation.
- Estimates for models nobody has benchmarked on the UNO Q (not measured):
  - Qwen 1.5B Q4 (~1 GB weights): ~2–3 tok/s generation, ~4–5 tok/s prefill. Likely fits on 4 GB but not comfortably on 2 GB (Ollama's 1.5B model already failed on 2 GB).
  - 3B+ Q4: ~1 tok/s and impractical.
  - Gemma 3 270M / SmolLM2-135M/360M: probably ~10–20 tok/s generation, but their tool-calling reliability is unproven.
- 2 GB vs 4 GB: a 0.8–1B Q4 model loads in about 1 GB on either board. On 2 GB, KV-cache growth (Qwen reached 2.5 GB on 4 GB), Docker, the EI runner and the Python app compete for ~1.7 GB of usable RAM. That leaves little room for anything else. The 4 GB board is the realistic minimum for "local LLM + other bricks".
- Small models handle a 1–2-tool, single-step, low-stakes decision about 85–90% of the time (14/16 in one test). They aren't suited to multi-step planning over a real MCP tool catalog.

### Gaps
- No UNO Q benchmarks were found for Qwen2.5/Qwen3 1.5B, Gemma 3 270M, SmolLM2/3, Phi, Llama 3.2 1B, IQ/Q8_0 vs Q4_0 comparisons, or llama-bench (pp512/tg128) runs. No MLC-LLM or ExecuTorch results on QRB2210/QCM2290/RB1 were found either.
- No systematic tool-calling benchmark (e.g. BFCL-style) on the UNO Q beyond the 16-prompt Mischianti test.
- Whether Arduino's CPU build uses Arm-optimized Q4_0 repacking (the A53 has no i8mm/dotprod) wasn't verified. The VENTUNO Q build flags (`armv8.7a+dotprod+i8mm`) don't apply to the A53.
- No Ollama-vs-llama.cpp head-to-head on the same model on the UNO Q.

---

## 2. Accelerators: Hexagon DSP/HVX, Adreno 702 GPU, NPU, QNN/QAIRT, LiteRT delegates, OpenCL/Vulkan, AI Hub

### Takeaway
Arduino's own stack uses **no accelerator for LLMs on the UNO Q**. Every QNN/Hexagon-backed brick is VENTUNO Q only. The QRB2210 has **no dedicated NPU/HTP**, only a Hexagon DSP (reportedly v66) aimed at audio and sensor work. No public evidence shows QNN, the Hexagon backend or the AI Hub working on the UNO Q. The only accelerator path with any official mention is an Edge Impulse "UNO Q (GPU)" export target for the Adreno 702, and no speedup numbers have been published for it. Community GPU compute (Vulkan via Mesa Turnip) gives wrong results in llama.cpp.

### Cited Findings
- **Arduino's split between the boards is the strongest primary evidence.**
  - The generic/VENTUNO Q llama.cpp service uses the image `llamacpp-npu-runner`, maps `/dev/fastrpc-cdsp`, mounts the host Hexagon firmware at `/usr/share/qcom`, and sets `GGML_HEXAGON_*` variables, with `mem_limit: 12g`. — [service_compose.yaml](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_services/llamacpp/service_compose.yaml)
  - The UNO Q override swaps in the CPU-only runner with `--device none`. — [service_compose.unoq.yaml](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_services/llamacpp/service_compose.unoq.yaml)
  - The Hexagon build workflow ("Build llama.cpp with Hexagon and CPU support") sets `GGML_HEXAGON=ON` and `GGML_OPENCL=ON` with `-march=armv8.7a+fp16+dotprod+i8mm`. Those flags target the VENTUNO Q class and can't run on an A53. — [build-llamacpp.yml](https://github.com/arduino/app-bricks-py/blob/main/.github/workflows/build-llamacpp.yml), [CMakeUserPresets.json](https://github.com/arduino/app-bricks-py/blob/main/containers/ai/llamacpp-npu-runner/builder/CMakeUserPresets.json)
- **QNN bricks are VENTUNO Q only** (`supported_boards: ["ventunoq"]`, `ai_frameworks_compatibility: qnn`). Checked on 2026-11-08: ASR (`whisper-small-quantized`), TTS (`pipertts_en`), OCR (`easy-ocr`), pose estimation, gesture recognition, VLM (`genie:qwen3_vl_4b_instruct`), multimodal LLM (`llamacpp:gemma-4-E2B_q4_0-it-multimodal`) and video object tracking (`yolox-small-qnn-object-tracker`). Object detection uses `yolox-qnn-object-detection` on the VENTUNO Q but `yolox-object-detection` (`yolo-x-nano.eim`) on the UNO Q. — [arduino/app-bricks-py, src/arduino/app_bricks/*/brick_config.yaml](https://github.com/arduino/app-bricks-py/tree/main/src/arduino/app_bricks)
- **No NPU.**
  - "Out of the box, AI runs on the four CPU cores." The Hexagon DSP is for audio, sensor data and light AI tasks, and Qualcomm does not list a dedicated NPU. — [raspberry.tips review, 8 Nov 2026](https://raspberry.tips/en/arduino/arduino-uno-q-review-vs-raspberry-pi-5)
  - The same site's earlier chatbot article says the "NPU" is unused and is marketed mainly for image processing. — [raspberry.tips chatbot](https://raspberry.tips/en/arduino/arduino-uno-q-local-ai-chatbot). That contradicts the review's "no dedicated NPU". The review's wording is more consistent with Qualcomm's spec sheets.
- **Hexagon DSP.**
  - Qualcomm's product brief describes an always-on Hexagon DSP for low-power sensor fusion and voice/audio. — [Qualcomm QRB2210 product brief (RB1)](https://docs.qualcomm.com/bundle/publicresource/87-61720-1_REV_A_QUALCOMM_ROBOTICS_RB1_PLATFORM__QUALCOMM_QRB2210__PRODUCT_BRIEF.pdf), [Rev D brief](https://docs.qualcomm.com/doc/87-61720-1/87-61720-1_REV_D_Qualcomm_Dragonwing_QRB2210_Processor_Product_Brief.pdf)
  - A third-party overview lists it as Hexagon QDSP6 **v66** with an LPASS audio DSP, and lists "lightweight AI inference" among its tasks. — [manuals.plus product overview](https://manuals.plus/m/071ebc306e4de7a81ba5a1c172c51c07924643849013ddf971caacb59108a4bb). Unverified secondary source; seen only in a search summary.
  - A Qualcomm selector guide reportedly describes a "6th Gen Qualcomm AI Engine" for the QRB2210. — [Qualcomm IoT selector guide (PDF)](https://www.qualcomm.com/content/dam/qcomm-martech/dm-assets/documents/Qualcomm-Application-Processors-for-IoT-Selector-Guide.PDF). Seen via a search summary and not confirmed by direct reading. "AI Engine" is a marketing umbrella for CPU+GPU+DSP, not an NPU.
- **SNPE/QAIRT.** SNPE ships a `hexagon-v66` DSP runtime and lists v66 support for many SM6xxx/SM4xxx/QCM/QCS parts. QCM2290/QRB2210 did not appear in the excerpt reviewed. — [QAIRT 2.44 SNPE overview (mirror)](https://qairt-2-44-docs.pages.dev/SNPE/general/overview). The QAIRT 2.33 notes list known issues on the "DSP v66 and AIP backends". — [Qualcomm QAIRT 2.33 release notes](https://docs.qualcomm.com/doc/KBA-250421151446/KBA-250421151446_REV_1_QAIRT_2_33_0_Partner_Release_Notes.pdf)
- **AI Hub.** AI Hub apps support NPU acceleration on "Snapdragon chipsets supported by the QAIRT SDK". FP16 needs Hexagon **v69+**, and INT8/INT16 runs on all Snapdragon chipsets. — [qualcomm/ai-hub-apps](https://github.com/qualcomm/ai-hub-apps). No evidence was found that the QRB2210, QCM2290 or RB1 is an AI Hub target device. — [qualcomm/ai-hub-models](https://github.com/qualcomm/ai-hub-models), [AI Hub release notes](https://workbench.aihub.qualcomm.com/docs/hub/release_notes.html)
- **ONNX Runtime QNN EP** is documented for Android and Windows Snapdragon devices only, not embedded Linux. — [onnxruntime.ai QNN EP](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html)
- **Edge Impulse QNN delegate** docs cover Android/Snapdragon Hexagon NPUs, not the UNO Q. — [Edge Impulse QNN on Android](https://docs.edgeimpulse.com/tutorials/topics/android/qnn-acceleration)
- **Open community question.** An Arduino forum thread titled "Status of Qualcomm QNN / TFLite delegate / Edge Impulse QNN acceleration – UNO Q" asks whether acceleration needs the QNN/TFLite delegate stack beyond the generic ARM64 runner. It had no confirmed answer as far as could be seen; the page returned 403, so this is based on the search snippet only. — [Arduino Forum](https://forum.arduino.cc/t/status-of-qualcomm-qnn-tflite-delegate-edge-impulse-qnn-acceleration/1447565)
- **Adreno 702 GPU.**
  - The Edge Impulse legacy App Lab flow lets you deploy as "Linux aarch64" or **"Linux Arduino UNO Q (GPU)"**, both producing an `.eim`. — [Edge Impulse, Run Arduino App Lab](https://docs.edgeimpulse.com/hardware/deployments/run-arduino-app-lab). The GPU is used only for models exported to the "Arduino UNO Q (GPU)" target. — [raspberry.tips review](https://raspberry.tips/en/arduino/arduino-uno-q-review-vs-raspberry-pi-5)
  - The Edge Impulse board page doesn't name the GPU target or explain the mechanism (TFLite GPU delegate vs OpenCL). — [Edge Impulse UNO Q board docs](https://docs.edgeimpulse.com/hardware/boards/arduino-uno-q)
  - An RS DesignSpark article says Edge Impulse can deploy to "either the … Arm processor complex or its Adreno 702 GPU" (secondary). — [RS DesignSpark PCB inspection pt 1](https://www.rs-online.com/designspark/automating-pcb-inspection-with-arduino-uno-q-part-1-introduction)
- **Vulkan / llama.cpp on the Adreno 702.** The GPU enumerates as "Turnip Adreno (TM) 702" through Mesa. — [web search summary of Arduino forum post](https://forum.arduino.cc/t/status-of-qualcomm-qnn-tflite-delegate-edge-impulse-qnn-acceleration/1447565)
  - llama.cpp issue #25906 (Jul 2026) covers a 4 GB UNO Q with Mesa Turnip 26.2.99 and Qwen2.5-1.5B Q4_K_M: Vulkan "returns garbage". It shows MUL_MAT errors (avg_err 0.49), `test-backend-ops` MUL_MAT failures for small n, GET_ROWS/SET_ROWS failures for q4_0/q8_0, and a crash in `ggml_vk_submit`. **Closed "not planned" on 5 Sep 2026 with no maintainer response.** — [ggml-org/llama.cpp#25906](https://github.com/ggml-org/llama.cpp/issues/25906)
  - GPU graphics scores: glmark2-es2 290, vkmark 741. — [Geerling](https://github.com/geerlingguy/sbc-reviews/issues/83)
  - Same-family evidence on a much stronger Adreno: on Snapdragon 778G (Adreno 642L) and 8 Gen 2, llama.cpp OpenCL offload was "slower at every layer count" than the CPU. — [vovaxa55/snapdragon778g-llama-cpp-opencl-bench](https://github.com/vovaxa55/snapdragon778g-llama-cpp-opencl-bench)
- An Arduino forum question about running ONNX models on the UNO Q GPU/NPU got only a one-line reply suggesting the CPU is best suited. — [Arduino Forum, ONNX on GPU/NPU (via search snippet)](https://forum.arduino.cc/t/running-onnx-models-on-arduino-uno-q-gpu-npu-for-faster-inference/1458610)

### Inferences
- For LLMs on the UNO Q, plan around CPU only. The Hexagon path in llama.cpp (`GGML_HEXAGON`) targets HTP-class Hexagon v73+ with HMX. A v66 DSP without HTP is very unlikely to be supported, and Arduino doesn't enable it for the UNO Q (inference from the build config plus the reported v66 version).
- QNN's older "DSP" backend or SNPE's v66 DSP runtime could in principle run INT8 CNNs on the cDSP from Linux via FastRPC. But no public report, no Arduino image support and no QRB2210 support-matrix row were found. Treat it as an unvalidated R&D project, not a dependable path.
- The Adreno 702 is a low-end GPU. Snapdragon 778G-class Adreno already loses to its CPU in llama.cpp, so the 702 won't speed up LLMs. At best it can help small TFLite CNNs exported through Edge Impulse's GPU target, and that speedup is unquantified.

### Gaps
- No measured latency/FPS comparison of the Edge Impulse "UNO Q (GPU)" target vs CPU on the same model.
- The Hexagon version (v66) for the QRB2210 wasn't confirmed from a Qualcomm primary document. Whether `/dev/fastrpc-cdsp` (or `adsprpc`) and the cDSP firmware exist and are user-accessible on Arduino's Debian image wasn't verified; the hardware/OS researchers may have that.
- No rusticl/freedreno OpenCL results or proprietary Adreno OpenCL availability reports for the 702 on Linux were found.
- The AI Hub device list wasn't checked directly (no definitive "not listed" statement found).

---

## 3. Official AI features: App Lab Bricks, Edge Impulse integration, shipped models, how they run, performance

### Takeaway
On the UNO Q, App Lab ships CPU-run Edge Impulse `.eim` models: YOLOX-nano detection, MobileNetV2 classification, "Hey Arduino" KWS, glass-breaking audio, motion and anomaly models. They run in Docker containers on the A53 cores, alongside a CPU llama.cpp LLM brick, a **Cloud LLM brick** (Claude/GPT/Gemini) and an **MCP Client brick**. Speech (ASR/TTS), OCR, pose, VLM and tracking bricks are VENTUNO Q only. Published performance is thin: about 10 FPS live object detection on the CPU, ~6 ms for a FOMO model, and several seconds of lag in early face-detection demos.

### Cited Findings
- **Brick inventory** (app-bricks-py, last push 2026-11-06), from directory names. AI-relevant: `object_detection`, `video_objectdetection`, `image_classification`, `video_imageclassification`, `keyword_spotting`, `audio_classification`, `motion_detection`, `visual_anomaly_detection`, `vibration_anomaly_detection`, `llm`, `cloud_llm`, `cloud_asr`, `mcp_client`, `vlm`, `multimodal_llm`, `asr`, `tts`, `ocr`, `pose_estimation`, `gesture_recognition`, `video_object_tracking`, `mood_detector`, `camera_code_detection`. — [arduino/app-bricks-py](https://github.com/arduino/app-bricks-py/tree/main/src/arduino/app_bricks)
- **Default UNO Q models**, all Edge Impulse `.eim` files run by `ei-models-runner` containers:
  - `yolo-x-nano.eim` (object detection)
  - `mobilenet-v2-224px.eim` (image classification)
  - `keyword-spotting-hey-arduino.eim`
  - `glass-breaking.eim` (audio classification)
  - `updown-wave-motion-detection.eim`
  - `fan-anomaly-detection.eim`
  - concrete-crack visual anomaly models
  - Each runner serves an HTTP API, e.g. port 1337 for object detection and 1340 for KWS. — [object_detection brick_compose.yaml](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/object_detection/brick_compose.yaml), [keyword_spotting brick_compose.yaml](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/keyword_spotting/brick_compose.yaml)
  - The runner caches a "V8 compile cache" (`node-compile-cache`), so the EI runner is Node.js-based. — same compose files
- The "Hey Arduino" KWS model has three labels: background, hey_arduino, other. — [Arduino forum, via search snippet](https://forum.arduino.cc/t/newbie-question-why-does-hey-arduino-not-work/1458884). One user found the KWS brick limited to spotting one word. — [Edge Impulse forum](https://forum.edgeimpulse.com/t/uno-q-keywords-spotting-documentation/17389)
- **Edge Impulse integration.** App Lab 0.5.0 (March 2026) added Edge Impulse model integration: pick UNO Q as the deployment target in Studio, then "Go to Arduino". The legacy flow (App Lab 0.1.23, now deprecated) put `.eim` files in `/home/arduino/.arduino-bricks/ei-models/`. Supported types: object detection (example FOMO MobileNetV2 0.35), KWS/audio classification, image classification, motion anomaly, visual anomaly. No performance numbers are given. — [Edge Impulse, Run Arduino App Lab](https://docs.edgeimpulse.com/hardware/deployments/run-arduino-app-lab)
- `edge-impulse-linux-runner` works on the board and needs a 64-bit OS. The docs warn to disable VS Code extensions such as Copilot over Remote-SSH to avoid "potential memory issues". — [Edge Impulse UNO Q board docs](https://docs.edgeimpulse.com/hardware/boards/arduino-uno-q)
- Arduino account sign-in is required to deploy EI models through App Lab bricks. — [Hackaday.io project (via search snippet)](https://hackaday.io/project/206102/instructions)
- A regression blocking custom-model selection in the video object detection brick was fixed in arduino-app-cli 0.11.1. — [Edge Impulse forum (via search summary)](https://forum.edgeimpulse.com/t/arduino-uno-q-object-detection-wont-work/18222)
- **Cloud LLM brick.** Default model IDs: `ANTHROPIC_CLAUDE = "claude-sonnet-5-5"`, `OPENAI_GPT = "gpt-6-luna"`, `GOOGLE_GEMINI = "gemini-3.5-flash-lite"`. It supports reasoning-effort mapping, and the API key comes from the App Lab Brick Configuration. — [cloud_llm/models.py](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/cloud_llm/models.py)
- **MCP Client brick.**
  - It connects to one or more MCP servers over HTTP (`/mcp` streamable endpoint) and exposes their tools as **LangChain tools**. Those go to `CloudLLM(tools=...)` or the on-device `LargeLanguageModel(tools=...)`. It supports bearer tokens and headers, and installs with `pip install arduino_app_bricks[mcp_client]`.
  - An app can bundle its own MCP server as a Docker-backed custom brick, for example the Docker MCP Gateway or a FastMCP server.
  - Source: [mcp_client/README.md](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/mcp_client/README.md)
- **Local LLM brick** = the llama.cpp CPU server described in section 1. The brick builds requests, runs tools and keeps memory, and the model runs in a separate container on port 9999. — [Mischianti](https://mischianti.org/arduino-uno-q-a-local-ai-agent-that-drives-the-hardware/)
- **Measured or observed performance:**
  - Live camera object detection: about 10 FPS on the CPU (no per-frame ms given). — [raspberry.tips review](https://raspberry.tips/en/arduino/arduino-uno-q-review-vs-raspberry-pi-5)
  - FOMO "bottles vs cans": ~6 ms inference, 244 KB peak RAM, 77.6 KB flash. — [Hackster VLM article](https://www.hackster.io/sologithu/running-local-vlms-on-arduino-uno-q-with-the-app-lab-70e8e3)
  - Early webcam face detection showed a "significant DELAY of several seconds before the image would update" (Nov 2025, no measurements). — [Hackster, Running ML/AI on UNO Q](https://www.hackster.io/vsupacha/running-ml-ai-on-arduino-uno-q-59ff07)
  - The pre-loaded models are quantized Edge Impulse models that trade some accuracy for speed. — [Tech Explorations (via search summary)](https://techexplorations.com/blog/arduino/arduino-uno-q-hands-on-with-arduinos-dual-brain-ai-board/)
  - One tester found the face-detection sample more accurate than the generic object_detection brick (subjective). — [Hackster](https://www.hackster.io/vsupacha/running-ml-ai-on-arduino-uno-q-59ff07)

### Inferences
- Every official on-device AI feature on the UNO Q is CPU (plus the optional EI GPU export). QNN-accelerated bricks are the VENTUNO Q's selling point, which implies Arduino and Qualcomm don't expose the QRB2210's DSP for general ML.
- The MCP Client brick + Cloud LLM brick combination is Arduino's own supported pattern for "cloud brain, board-side tools". It runs in Python/LangChain on the board, and the MCP servers can be co-located containers.

### Gaps
- No official Arduino or Edge Impulse latency/FPS/RAM table for the default bricks (YOLOX-nano, MobileNetV2, KWS) on the UNO Q.
- The `cloud_asr` provider and model weren't inspected.
- Whether the KWS/audio bricks use the Hexagon/LPASS DSP (no evidence that they do) is unknown.

---

## 4. Small vision/audio models (YOLO, MobileNet, KWS, Whisper, TTS) and camera support

### Takeaway
Small Edge Impulse-class vision models (FOMO, YOLOX-nano, MobileNetV2) run in real time or near it on the CPU: about 10 FPS for live detection, single-digit ms for FOMO. Heavier pipelines (Ultralytics YOLO + OpenCV) struggle. Offline speech recognition and TTS have no official UNO Q brick; those are VENTUNO Q only. Whisper-tiny-class STT on the A53 is an unmeasured estimate. USB webcams through a powered USB-C hub are the documented camera path. MIPI-CSI exists but needs a carrier board and device-tree work.

### Cited Findings
- Live object detection ~10 FPS on the CPU. — [raspberry.tips review](https://raspberry.tips/en/arduino/arduino-uno-q-review-vs-raspberry-pi-5)
- FOMO ~6 ms, 244 KB RAM. — [Hackster](https://www.hackster.io/sologithu/running-local-vlms-on-arduino-uno-q-with-the-app-lab-70e8e3)
- A user found Ultralytics + OpenCV too resource-intensive on the board, while the Edge Impulse App Lab workflow worked. — [Edge Impulse forum (via search summary)](https://forum.edgeimpulse.com/t/arduino-uno-q-object-detection-wont-work/18222)
- SmolVLM-500M: ~22–23 s per image query on the CPU, with the vision encoder >90% of time. — [Hackster](https://www.hackster.io/sologithu/running-local-vlms-on-arduino-uno-q-with-the-app-lab-70e8e3)
- ASR (`whisper-small-quantized`, QNN) and TTS (`pipertts_en`, QNN) bricks are `supported_boards: ["ventunoq"]` only. — [asr brick_config](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/asr/brick_config.yaml), [tts brick_config](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/tts/brick_config.yaml). A forum thread titled "LLM+Kokoro does not work" suggests users are trying CPU TTS. — [Arduino forum (title only)](https://forum.arduino.cc/t/llm-kokoro-does-not-work/1460434)
- No whisper.cpp benchmarks on Cortex-A53 / Pi 3 were found. Nearest data, all on much faster cores:
  - Pi 5 (A76): tiny.en at "1-2x real-time". — [PromptQuorum](https://www.promptquorum.com/power-local-llm/local-whisper-stt-comparison)
  - RK3588 (4xA76+4xA55): tiny RTF 0.10, small 0.47. — [Turing Pi](https://turingpi.com/whisper-cpp-piper-tts-arm64-turing-pi-rk3588/)
- **Camera:**
  - The documented examples use USB webcams and USB microphones through a powered USB-C hub. The board has a single USB-C port. — [Edge Impulse UNO Q docs](https://docs.edgeimpulse.com/hardware/boards/arduino-uno-q), [Hackster](https://www.hackster.io/vsupacha/running-ml-ai-on-arduino-uno-q-59ff07)
  - The UNO Q has 2x MIPI-CSI via the expansion connector (carrier board required), with ISPs rated up to 13 MP. An IMX219 setup needs a device-tree change. — [raspberry.tips review](https://raspberry.tips/en/arduino/arduino-uno-q-review-vs-raspberry-pi-5)
  - A smartphone-as-camera approach also exists. — [raspberry.tips](https://raspberry.tips/en/arduino/arduino-uno-q-smartphone-camera)

### Inferences
- **Estimate, not measured:** the UNO Q's multi-thread CPU throughput is ~2.5x lower than a Pi 5 (sysbench 4,043 vs 10,589). whisper.cpp tiny/tiny.en would then run around or slower than real time on the UNO Q, so batch transcription of short commands is feasible but streaming STT is marginal. Keyword spotting (EI) + short-utterance STT, or cloud STT (the `cloud_asr` brick), is the practical voice pattern. Moonshine-tiny-class models may do better but are untested here.
- For agent "reflexes" (presence, object detected, wake word, anomaly), EI models on the CPU are fast enough and leave cores for other work. Running a VLM or LLM at the same time will saturate all four cores (both hit ~99% CPU alone).

### Gaps
- No measured YOLOX-nano or MobileNetV2 ms/frame or FPS on the UNO Q CPU vs GPU target. No YOLOv8n/YOLO11n TFLite/ONNX numbers on QRB2210.
- No whisper.cpp, Moonshine, Vosk or Piper benchmarks on UNO Q or Pi 3-class A53 hardware were found.
- No CSI camera performance or ISP/libcamera support status for ML pipelines (the hardware researcher may cover this).

---

## 5. Agent runtimes and MCP clients on small ARM Linux: footprint and hybrid patterns

### Takeaway
An on-device agent loop that calls a remote LLM API is cheap on the UNO Q.
- Go/Rust agents claim single-digit-MB RSS.
- Python/LangChain stacks (including Arduino's own CloudLLM + MCPClient bricks) probably need tens to ~100+ MB.
- Node/OpenClaw-class stacks reportedly need >1 GB, which is a bad fit for the 2 GB board.

The hybrid pattern that has actually been shown on the UNO Q is: MCU reflexes (STM32), code-enforced rules (Python), and an LLM proposer, with deterministic pre-routing to shrink prompts.

### Cited Findings
- Sipeed's comparison table: OpenClaw RAM >1 GB, nanobot (Python, HKUDS) >100 MB, PicoClaw (Go) <10 MB (10 MB minimum, 64 MB recommended). Self-reported vendor figures. — [CNX Software, Feb 2026](https://www.cnx-software.com/2026/02/10/picoclaw-ultra-lightweight-personal-ai-assistant-run-on-just-10mb-of-ram/)
- ZeroClaw (Rust) claims <5 MB memory and a 3.4 MB binary (self-reported README). Both PicoClaw and ZeroClaw need 64-bit, and the Pi Zero 2 W's 512 MB is described as enough. — [fast.io overview](https://fast.io/resources/openclaw-raspberry-pi-zero-2w-picoclaw-zeroclaw-edge-projects/), [ZeroClaw mirror](https://git.hoyer.xyz/harald/zeroclaw/src/commit/6fd8b523b92cc58533ec7fb712496fe69075b057), [It's FOSS, OpenClaw alternatives](https://itsfoss.com/openclaw-alternatives/)
- QClaw on the UNO Q:
  - Go agent gateway (channel adapters, multi-iteration loop, pre-router, tool dispatcher) plus a Python direct-path REPL.
  - 8 allow-listed tools: file ops, `arduino` compile/flash, camera, sysfs LED, network, i2cdetect.
  - Whole system ~1.3 GB including the local model. The MPU reflashes the STM32 over SWD via GPIO ("sub-second flash").
  - Source: [dev.to](https://dev.to/david_laurenvil_5d43bea48/i-built-the-unoqs-claw-a-tiny-agentic-ai-assistant-that-lives-inside-an-arduino-uno-q-g48)
- Mischianti's three layers ("Brain" LLM, "Rules" Python gates, "Reflexes" STM32):
  - The STM32 turns the fan on at ≥45 °C regardless of Linux.
  - If the Linux heartbeat (every 0.5 s) is missing for 2,000 ms, the sketch falls back to a 35 °C thermostat.
  - `set_fan` refuses no-op changes, refuses to override an active reflex, and refuses switches within 60 s.
  - The Python process's peak memory varied by only 512–1152 KB across runs (Python delta only, not the model).
  - Hardware is driven via the Arduino Bridge (`Bridge.call/notify/provide`), not MCP.
  - The summary rule: "let the model propose, let your code decide what's allowed, and let the microcontroller have the last word."
  - Source: [Mischianti](https://mischianti.org/arduino-uno-q-a-local-ai-agent-that-drives-the-hardware/)
- Arduino officially documents MCP Client brick → Cloud LLM (e.g. `google:gemini-2.5-flash` in the example) and → local `LargeLanguageModel`. Tools are LangChain `BaseTool`s, and MCP servers can be bundled as Docker custom bricks. — [mcp_client README](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/mcp_client/README.md)
- An Edge Impulse expert project combines the UNO Q with Gemini (cloud) as a lab assistant. — [Edge Impulse docs, AI-driven lab assistant UNO Q + Gemini](https://docs.edgeimpulse.com/projects/expert-network/ai-driven-ancillary-lab-assistant-uno-q-gemini)
- App Lab runs each brick as a Docker container (llama.cpp, ei-models-runner and others), with the user app in Python. Container memory adds to the agent's footprint, e.g. the llama.cpp container capped at 2,500 MB. — [service_compose.unoq.yaml](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_services/llamacpp/service_compose.unoq.yaml)

### Inferences
- **Estimates, not measured on the UNO Q:**
  - A Python MCP client + Anthropic/OpenAI SDK (httpx, pydantic) typically sits at ~40–80 MB RSS. Adding LangChain pushes it toward ~100–200 MB.
  - Node.js 20+ agent CLIs start at ~50–100 MB, and full coding-agent CLIs reach several hundred MB.
  - Go/Rust clients: 5–30 MB.
  - All of these fit easily in 2 GB when no local LLM runs. Local-LLM + Docker + Python + EI runner on 2 GB is the tight case.
- The CPU cost of a cloud-brain agent loop is negligible: JSON + TLS over WiFi, with measured WiFi throughput of 277/174 Mbps. — [Geerling](https://github.com/geerlingguy/sbc-reviews/issues/83). End-to-end latency is then dominated by the cloud model (seconds), not by the board, while the local model takes 16–83 s per decision.
- Hybrid split that fits the evidence:
  - UNO Q runs the MCP server(s) exposing hardware tools, EI perception models (KWS, detection, anomaly) as event sources, safety gates in code, and MCU reflexes.
  - The planner/"agent brain" (a large model with the full MCP tool catalog) runs on a host PC or in the cloud, connecting to the board's MCP server over the network or running on the board as a thin Go/Python client.
  - An optional local Qwen3.5-0.8B handles offline fallback, intent classification among a few fixed choices ("choice mode" was faster and as accurate as tool mode in Mischianti's test), or summarizing sensor events. Keep its prompts short and KV-cache-friendly.

### Gaps
- No measured RSS for Python vs Node vs Go MCP clients on UNO Q or Cortex-A53 boards. The figures above are general estimates.
- No published latency comparison of local vs cloud LLM for the same UNO Q task.
- PicoClaw/ZeroClaw footprints are maintainer claims, not independent measurements.

---

## 6. Thermals and power under sustained AI load

### Takeaway
The UNO Q draws very little power, roughly **0.4–0.5 W idle to ~2–3.5 W under CPU load** at the board, with higher figures when the measurement includes a dock or display. A bare board stays at about **61–69 °C** under a 5-minute CPU+GPU stress test. Throttling hasn't been documented, and LLM tok/s stays stable across runs. One reviewer saw Geekbench multi-core lockups, and default boost was left off.

### Cited Findings
- **Geerling (2 GB, wall power, WiFi).**
  - Power: idle 0.5 W; stress-ng `--matrix 0` 1.9 W; Geekbench multi 2.5 W; HPL 3.5 W (2.74 Gflops/W); "LLM inference: about 6.1 W", which is inconsistent with the other figures and possibly a different setup. A later comment reports ~2.9 W idle with the LED matrix active, and a USB-C dock adds 4–5 W.
  - Temperature: SoC 63–65 °C by thermal camera without boost enabled. The author was cautious about enabling CPU boost without cooling.
  - Stability: Geekbench multi-core locked up, and an HPL compile was killed.
  - Source: [geerlingguy/sbc-reviews#83](https://github.com/geerlingguy/sbc-reviews/issues/83)
- **raspberry.tips** (4 GB): 0.4 W idle, 1.4 W under full load (stress-ng, 4 cores) and ~1.4 W under LLM load; Pi 5 for comparison ~3.0 W idle / ~8.8 W load. Running cost about $1/year. No temperature data. These figures are lower than Geerling's, and the methodology is unspecified. — [raspberry.tips review](https://raspberry.tips/en/arduino/arduino-uno-q-review-vs-raspberry-pi-5), [raspberry.tips chatbot](https://raspberry.tips/en/arduino/arduino-uno-q-local-ai-chatbot)
- **Tom's Hardware:** ~3.3 W idle and 4.5 W peak with all cores loaded, used as a desktop. These figures come from a search-engine summary; the page fetch failed, so they are unverified. — [Tom's Hardware review](https://www.tomshardware.com/raspberry-pi/arduino-uno-q-review)
- **element14 RoadTest** (4 GB/32 GB): `stress-ng` CPU+GPU for 300 s, no heatsink or fan. Thermal zones went from ~39–41 °C idle to ~61–69 °C peak, with no throttling reported. — [element14 RoadTest](https://community.element14.com/products/roadtest/rv/roadtest_reviews/1920/roadtest-of-arduino-uno-q-4gb-ram-32-gb-emmc-storage-single-board-computer). Another element14 review estimated 4–5 W under full load. — [element14](https://community.element14.com/products/roadtest/rv/roadtest_reviews/1906/arduinos-uno-q-the-new-single-board-computer)
- Arduino recommends a ≥15 W USB-C supply, well above measured draw. — [Arduino forum (via search summary)](https://forum.arduino.cc/t/what-is-the-power-consumption-of-the-arduino-uno-q/1408753)
- A PCBWay heatsink project claims a simulated full-load peak of ~55 °C, "below the throttling threshold". This is a vendor simulation, not a measurement. — [PCBWay](https://www.pcbway.com/project/sponsor/HeatSink_and_Cover_for_Arduino_Uno_Q_a38a140d.html)
- Sustained LLM generation was "stable across runs" at ~5.5 tok/s, and ~4.5 tok/s for Qwen "regardless of answer length". These are indirect signs of no throttling over minutes-long generations. — [raspberry.tips chatbot](https://raspberry.tips/en/arduino/arduino-uno-q-local-ai-chatbot), [Mischianti](https://mischianti.org/arduino-uno-q-a-local-ai-agent-that-drives-the-hardware/)

### Inferences
- A continuously running local LLM pins all four cores at ~99% and puts the SoC in the 60s °C in open air. That is likely sustainable, but inside an enclosure a passive heatsink is advisable (inference; no enclosed-case data).
- Power isn't a constraint for any placement option. Even a constantly busy UNO Q is a few watts, far below a host PC. The "brain placement" decision should rest on latency and capability, not energy.

### Gaps
- No published throttling trip points, `scaling_cur_freq` traces under long LLM runs, or enclosed-case thermal tests.
- Power during LLM inference is inconsistent across sources (1.4 W vs ~6.1 W). Measurement points (board vs wall, with or without dock) differ.

---

## 7. Synthesis question: where should the "agent brain" live in an MCP-driven hardware control system on the UNO Q?

### Takeaway
Put the **planning/agent brain off-board**: a host PC model or a cloud API (Claude/GPT/Gemini, which Arduino's Cloud LLM brick already supports). Use the UNO Q for MCP tool serving, perception, safety rules and real-time reflexes. A local Qwen3.5-0.8B is viable only as an **offline fallback or narrow classifier** with very few tools and short, cached prompts. At ~5 tok/s generation and ~10 tok/s prefill, every on-device decision costs 7–80 s, and its tool use is roughly 85–90% reliable even on trivial tasks.

### Cited Findings
- On-device decision latency: 6.9 s (choice mode), 16 s (agent with tool, warm), 49 s (cold), 83 s (two-tool monitor decision). — [Mischianti](https://mischianti.org/arduino-uno-q-a-local-ai-agent-that-drives-the-hardware/)
- An 8-tool on-device agent took 10–20 min per cold tool iteration (single anecdote). — [dev.to](https://dev.to/david_laurenvil_5d43bea48/i-built-the-unoqs-claw-a-tiny-agentic-ai-assistant-that-lives-inside-an-arduino-uno-q-g48)
- No accelerator path for LLMs on the UNO Q. Arduino's runner is CPU-only, and Hexagon/QNN is VENTUNO Q only. — [app-bricks-py](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_services/llamacpp/service_compose.unoq.yaml)
- Arduino officially supports MCP Client brick → Cloud LLM brick (Claude Sonnet 5.5 default for Anthropic) and → local LLM. — [mcp_client README](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/mcp_client/README.md), [cloud_llm/models.py](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/cloud_llm/models.py)
- Small models confabulate facts, so feed facts via tools. — [raspberry.tips chatbot](https://raspberry.tips/en/arduino/arduino-uno-q-local-ai-chatbot), [Mischianti](https://mischianti.org/arduino-uno-q-a-local-ai-agent-that-drives-the-hardware/)

### Inferences
- Recommended tiering:
  1. **STM32 MCU:** hard real-time reflexes, interlocks and watchdog fallback (heartbeat loss → safe state).
  2. **UNO Q Linux:** MCP server(s) exposing hardware tools with code-level gates and rate limits; EI models (KWS, YOLOX-nano/FOMO detection, anomaly) as event sources; a thin MCP client/agent loop (Go/Rust for minimal RAM, or Python/LangChain via the App Lab bricks for convenience); optionally a local Qwen3.5-0.8B for offline degraded mode and fixed-choice intent routing.
  3. **Host PC or cloud:** the planning LLM with the full tool catalog and long context. Either it connects to the board's MCP server over the network, or the board's thin client calls the cloud API.
- On a 2 GB board, skip the local LLM and run only the MCP server, EI models and a cloud-calling client. Choose the 4 GB board if an offline local-LLM fallback is needed.
- If on-device language understanding must be fast, use non-generative approaches: KWS + small intent classifiers, or "choice mode" with a 1–2-token answer and cached prefix. Free-form tool-calling generation is too slow.

### Gaps
- No head-to-head study of local vs cloud brains on the UNO Q (task success, latency, cost).
- No data on network-loss behavior or latency budgets for cloud-brain control loops on this board.
