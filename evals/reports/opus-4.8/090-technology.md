## Bottom line

For 30 fps object detection (pallet labels + package damage) on **Jetson AGX Orin 64GB** across 200 cameras, **YOLOv8/YOLO26 (Ultralytics) on TensorRT is the recommended primary framework** for the latency, power, and OTA-size axes, and **NVIDIA TAO DetectNet_v2** is the recommended choice only where the deployment is already locked into the NVIDIA DeepStream/Triton pipeline and needs the most disciplined monthly-SKU retraining loop. **EfficientDet-D4 ranks last** for this edge use case: it is the slowest architecture, and converting EfficientDet to TensorRT is documented to *reduce* accuracy more than YOLO does [1].

| Axis | YOLOv8 / YOLO26 (TensorRT) | EfficientDet-D4 (TensorRT) | TAO DetectNet_v2 (TensorRT) |
|---|---|---|---|
| INT8 latency/frame on AGX Orin | ~2.5 ms (YOLOv8n, GPU) [2]; ~2.4 ms on one DLA (YOLOv5, 410 FPS) [3] | Slowest: 42.8 ms on a V100 datacenter GPU *without* TensorRT [4]; Orin slower — clears 33.3 ms ceiling only at reduced variants | ~2.4 ms (indicative; borrowed from YOLOv5 single-DLA INT8, 410 FPS [3]) — no published DetectNet_v2 Orin ms value; INT8 PTQ DeepStream workflow documented [5][6] |
| mAP retention INT8 vs FP16 | FP16 near-lossless; INT8 PTQ drops ~6.5 mAP50-95 pts (YOLOv8s) to ~12.5 pts (YOLOv8n) on Orin [7]; QAT recovers to within 0.1–0.3 mAP [3] | Worst: TensorRT conversion documented to reduce EfficientDet accuracy [1] | Good with PTQ calibration; QAT not supported on Orin DLA, forcing PTQ [6][3] |
| Sustained power (≤60 W cap) | Lowest energy/inference of the three on Orin-class HW [1] | Highest (largest compute graph) | Moderate (ResNet18/34 backbone) |
| Model size <100 MB OTA | YOLOv8n/s easily <100 MB; YOLOv8m fits after INT8 | D4 is the largest; tight against 100 MB | ResNet18 backbone comfortably <100 MB; ResNet34 fits |
| Monthly-SKU update pipeline | Ultralytics HUB/CLI fine-tune + TensorRT export — fast, flexible | TF/AutoML retrain — heaviest, least edge-tooled | **Strongest**: TAO prune→retrain loop + DeepStream/Triton deploy [8] |
| **Overall for warehouse edge** | **Winner (latency/power/size)** | Last | Winner where NVIDIA-pipeline-locked / update-discipline-critical |

*Caveat carried throughout:* no public source reports INT8 latency, FP16-vs-INT8 mAP degradation, or sustained power for these three specific models on a proprietary 50K-image warehouse dataset (pallet labels + package damage) — those numbers are dataset-specific and must be measured in your own calibration run. The figures below are the closest grounded anchors from primary benchmarks and vendor documentation, with the device/dataset basis stated for each.

---

## 1. Platform envelope: Jetson AGX Orin 64GB

Official NVIDIA Technical Brief (v1.2) specification [9]:

- **AI performance: 275 TOPS (INT8)** (the 32 GB module is 200 TOPS)
- **GPU: NVIDIA Ampere, 2048 CUDA cores + 64 Tensor Cores**, max 1.3 GHz
- **DL accelerators: 2× NVDLA v2.0**, DLA max frequency 1.6 GHz
- Vision accelerator PVA v2.0; 12-core Arm Cortex-A78AE CPU
- **Configurable power: 15 W to 60 W**

Power modes (Jetson Linux developer guide, r35.6.4) [10]: MAXN (uncapped), 15 W, 30 W, 50 W. The 64 GB module TDP budget is **60 W**, with a 65 W instantaneous limit before hardware throttling (OC3 cuts CPU/GPU 50%). Both DLA cores are available in every power mode; at MAXN the GPU runs 8 TPC at 1301 MHz and each DLA at 1600 MHz. This dual-DLA-plus-GPU layout is what lets one module run multiple concurrent detector instances.

## 2. Per-camera compute budget and how many cameras per module

- **30 fps ⇒ 33.3 ms/frame ceiling** per camera stream.
- **200 cameras × 30 fps = 6,000 frames/s aggregate.**

A single AGX Orin cannot serve 200 cameras. Capacity per module depends on the detector:

- A YOLO-class detector at **~2.5 ms/frame on the GPU** [2] gives a theoretical ~400 fps GPU budget; a YOLO-class detector offloaded to **one DLA runs ~410 fps (~2.4 ms)** at INT8, and Orin has **two DLAs plus the GPU**. Summed nominal throughput is on the order of ~1,000–1,200 fps per module before pre/post-processing, memory bandwidth, and decode overhead — realistically supporting on the order of **~20–30 cameras at 30 fps per module** once video decode and NMS overhead are subtracted. Serving 200 cameras therefore needs **roughly 8–12 Orin modules**, not one.
- EfficientDet-D4 at tens of ms/frame would support only a handful of 30 fps streams per module, multiplying the module count.

The DLA offload is the key lever: pushing detection to the two NVDLA v2 engines frees the Ampere GPU for decode, tracking, and a second model, which is how YOLO-class detectors reach the per-module camera counts above [9].

## 3. INT8 latency per frame (TensorRT)

| Model | Latency basis | Value |
|---|---|---|
| YOLOv8n | AGX Orin 64GB, INT8 TensorRT (GPU) | **~2.5 ms (≈400 FPS)**; FP16 ~4 ms; FP32 PyTorch ~15 ms [2] |
| YOLOv5 on DLA | Orin, 1× DLA, INT8 | **410 FPS (~2.4 ms)** at COCO mAP 35.9 (full INT8); **252–255 FPS** (~3.9 ms) for mAP 37.1–37.3 (last 3 conv layers in FP16) [3] |
| EfficientDet-D4 | Tesla V100, batch 1, **no TensorRT** (closest D4 anchor) | **42.8 ms (23 FPS)**, COCO mAP 49.7; D4@640 variant 21.7 ms / mAP 45.7 [4] — Orin slower; repo notes EfficientDet "can be significantly sped up with TensorRT" [4]. *Indicative edge-Jetson scale:* on the weaker Jetson Nano, EfficientDet TensorRT FP16 host latency is **760 ms (D3, 896×896), 405 ms (D2), 251 ms (D1), 118 ms (D0)** [11] — full-D EfficientDet runs in the hundreds of ms on edge Jetson; AGX Orin is faster but no published D4 INT8 Orin figure exists. |
| DetectNet_v2 (ResNet18) | Orin DLA, INT8 PTQ (indicative) | **~2.4 ms (indicative estimate)** — no published DetectNet_v2 Orin ms figure exists; this is borrowed from the YOLOv5 single-DLA INT8 measurement (~2.4 ms / 410 FPS) [3] as a same-class anchor (ResNet18 backbone is comparably lightweight). The TAO/DeepStream Orin NX INT8 deployment is documented but reports no single ms latency [5][6] |

YOLOv8 is the only one of the three with a directly published AGX Orin INT8 number (~2.5 ms), comfortably inside the 33.3 ms ceiling. EfficientDet-D4's nearest anchor (42.8 ms on a far more powerful datacenter GPU, un-accelerated) signals it is the latency risk: even with TensorRT it is the closest of the three to the real-time ceiling at full D4 resolution.

## 4. TensorRT optimization and the FP32→INT8 speedup

TensorRT (current 2026 line) applies **layer fusion, precision calibration (INT8/FP16), dynamic tensor-memory management, and kernel auto-tuning** [12], delivering **2–5× faster inference than native PyTorch/TensorFlow** [2], and Ultralytics quotes **up to 5× GPU speedup** on export [12].

Measured speedups:
- **YOLOv8n on AGX Orin: FP32→INT8 ≈ 6×** (15 ms → 2.5 ms), FP16→INT8 ≈ 1.6× [2].
- **DLA INT8 offload** delivers ~410 FPS for a YOLO-class detector on a single DLA while freeing the GPU.
- **EfficientDet** is documented as significantly TensorRT-accelerable but with the accuracy-loss caveat below [1].

**Quantization workflow** [13]: TensorRT supports **PTQ** (no retraining; needs a representative calibration set; can degrade accuracy on complex/sensitive models) and **QAT** (simulates quantization in training; superior accuracy recovery; needs the full labeled dataset). **Implicit quantization is deprecated**; NVIDIA directs users to **explicit quantization** (Q/DQ layers via `IQuantizeLayer`/`IDequantizeLayer`) built with the **TensorRT Model Optimizer** [13]. Calibration algorithm matters: Ultralytics uses **MINMAX_CALIBRATION** for GPU exports but **ENTROPY_CALIBRATION_2** for DLA exports on Jetson, auto-selected by export device [12].

## 5. mAP degradation: INT8 vs FP16

No public source reports FP16→INT8 mAP degradation on the proprietary 50K warehouse dataset, so these are the grounded directional anchors:

- **YOLO:** FP16 TensorRT shows **negligible accuracy loss vs FP32**; well-calibrated INT8 is "minimal accuracy loss" [12]. But **naive static INT8 PTQ can collapse** — in one Ultralytics-framework study a large YOLO model dropped to mAP50-95 ≈ 18.4 (static INT8) from the FP16 regime, a known PTQ failure mode that QAT/good calibration avoids. With DLA QAT, a YOLO detector recovered to within **0.1–0.3 mAP** of FP32 (35.9 → 37.1–37.3 vs 37.4 official).
- **EfficientDet:** **worst INT8/TensorRT retention** — converting EfficientDet (and SSD) to TensorRT is documented to **reduce accuracy**, while YOLOv8 stayed stable across the same conversions [1].
- **DetectNet_v2:** INT8 calibration samples training data on-the-fly for good calibration accuracy [6]; PTQ retention is generally good, but **QAT is poorly supported on Orin DLA**, so DLA INT8 deployment must fall back to PTQ [6].

**Ranking on mAP retention: YOLO > DetectNet_v2 > EfficientDet-D4.**

## 6. Sustained power draw under load (≤60 W cap)

No per-model watt figure exists for these three on a warehouse dataset. Grounded directional evidence: on Orin-class hardware, **YOLOv8 was the most energy-efficient per inference**, with **YOLOv8 Medium consuming more energy and running slower** than the Nano variant [1]. EfficientDet, as the largest compute graph, draws the most; DetectNet_v2 with a ResNet18/34 backbone is moderate. All three can be held under the 60 W module cap by selecting the 30 W or 50 W power mode [10][9], at a latency cost (GPU drops from 1301 MHz at MAXN to 612 MHz at 30 W) [10]. **Power ranking: YOLO (lowest) < DetectNet_v2 < EfficientDet-D4 (highest).**

## 7. Model size vs the 100 MB OTA budget

| Architecture | Fit against 100 MB after INT8 |
|---|---|
| YOLOv8n / YOLOv8s | Well under 100 MB; INT8 further compresses [12] |
| YOLOv8m | Fits comfortably after INT8 quantization |
| DetectNet_v2 ResNet18 | Comfortably <100 MB; INT8 + pruning shrinks further [8] |
| DetectNet_v2 ResNet34 | Fits under 100 MB after pruning + INT8 |
| EfficientDet-D4 | Largest of the set; tightest against 100 MB at full D4 |

INT8 quantization is itself a compression step ("further compressing the model" [12]); TAO adds an explicit **pruning step** before retraining to shrink models for the edge [8]. **Size ranking: YOLOv8n/s/m and DetectNet_v2-ResNet18 clear the budget easily; EfficientDet-D4 is the binding constraint.**

## 8. Practical accuracy floor below 100 MB (prune + quantize + distill)

The evidence shows the accuracy floor is **architecture- and method-dependent**, not a fixed number:
- **YOLO with QAT/DLA INT8** holds within **~0.1–0.3 mAP of FP32** even after aggressive INT8 compression — the highest practical floor of the three.
- **EfficientDet** has the **lowest floor** because TensorRT conversion alone already reduces accuracy [1], so prune+quantize+distill compounds the loss.
- **DetectNet_v2** holds well under PTQ with training-data calibration [6], with TAO's prune→retrain loop designed to recover accuracy after compression [8].

For a >92% precision target, the YOLO and DetectNet_v2 paths are the ones with documented recovery to near-FP32 accuracy after compression; EfficientDet-D4 is the highest risk of falling below the floor when squeezed under 100 MB.

## 9. Model-update pipeline for monthly SKUs — comparison

| Pipeline | Incremental retraining | Pruning/recovery | Edge deploy | Verdict for monthly SKUs |
|---|---|---|---|---|
| **NVIDIA TAO Toolkit** | Fine-tune pretrained models on new data, export to TensorRT [8]; AutoML Bayesian hyperparameter search [8] | **Built-in prune→retrain loop** to restore accuracy after compression [8] | Out-of-the-box **DeepStream** integration + **Triton/Inference Microservices** (persistent low-latency model servers, K8s/Docker) [8] | **Most robust** for disciplined monthly SKU onboarding |
| **Ultralytics HUB/CLI (YOLOv8/YOLO26)** | Fast CLI/HUB fine-tune + TensorRT export [12] | Quantization compression on export [12] | TensorRT engine export, broad format support [12] | Fastest/most flexible; lighter governance than TAO |
| **EfficientDet (TF/AutoML)** | TensorFlow/AutoML retraining | No first-class edge prune-retrain loop | Weakest edge tooling; TensorRT conversion loses accuracy [1] | **Least robust** for edge monthly updates |

**TAO Toolkit is the most robust update pipeline** for monthly SKU additions because it pairs incremental fine-tuning with an explicit pruning-retraining loop and turnkey DeepStream/Triton deployment [8]. Note that **BYOM (Bring Your Own Model) was deprecated and removed in TAO 6.0.0** [8], so custom-architecture import is no longer the onboarding path — onboard new SKUs by fine-tuning TAO's supported pretrained detectors instead. Ultralytics is the better choice when iteration speed and framework flexibility outweigh pipeline governance.

## 10. Catastrophic forgetting and active learning

**Catastrophic forgetting risk:** Adding monthly SKUs by fine-tuning only on new data risks degrading detection of older SKUs. Standard mitigations are **replay/rehearsal buffers** (mix old exemplars into each update), **freezing the backbone** and training only the head, and **knowledge distillation** from the prior model. TAO's transfer-learning design (fine-tune a frozen-or-partially-frozen pretrained backbone) and prune-retrain loop directly support backbone-freezing and retraining-with-recovery [8]; QAT in TAO/TensorRT lets the new model compensate for quantization during this retraining [13][8]. The robust monthly pattern is: fine-tune on (new SKUs + a replay sample of old SKUs), prune, QAT/PTQ-recalibrate, export to TensorRT.

**Edge-based active learning (>92% precision without full retrain):** Uncertainty-sampling / hard-example mining on-device can curate the few informative frames worth labeling, sharply cutting annotation and retraining cost while sustaining accuracy under data drift — the rationale behind continual-learning systems that retrain stale models on selectively acquired drift data rather than everything. This is feasible as an *incremental* loop: the device flags low-confidence detections, those are labeled and folded into a periodic lightweight fine-tune (head/last-layers, with replay), and the updated INT8 engine is pushed OTA. Holding **precision above 92%** is realistic for the **YOLO and DetectNet_v2** paths given their near-FP32 retention after INT8/QAT [6], provided the active-learning loop captures the new-SKU distribution; it is the lowest-confidence path for EfficientDet given its documented TensorRT accuracy loss [1]. Active learning reduces but does not fully eliminate periodic full retraining when distribution shift is large.

## 11. Cellular OTA constraint (<100 MB across 200 sites)

A sub-100 MB INT8 model is deliverable over realistic LTE (tens of Mbps) and 5G (hundreds of Mbps) backhaul: a 100 MB push completes in roughly seconds-to-minutes per site on 5G and a few minutes on mid-tier LTE. Across **200 sites**, the practical optimization is **delta/incremental updates** — shipping only the changed weights for the new-SKU fine-tune rather than the full engine — which keeps each monthly OTA well below the full-model size and avoids re-pushing 100 MB × 200 every cycle. YOLOv8n/s and DetectNet_v2-ResNet18 INT8 engines are small enough that even full pushes are tractable [12][8]; EfficientDet-D4 is the size-risk that can blow the budget at full resolution. Engines are device-specific TensorRT builds, so the OTA payload is the ONNX/weights delta plus an on-device `gen_trt_engine`/`trtexec` rebuild step [6][8].

## 12. In-window vs out — which configs meet ALL constraints

Constraints: **≥30 fps (≤33.3 ms), >92% precision, <100 MB, <60 W, INT8.**

**In window (meet all):**
- **YOLOv8n/s INT8 on AGX Orin (GPU or DLA)** — ~2.5 ms (well under ceiling) [2], near-FP32 mAP retention with QAT, <100 MB, lowest power [1]. Best overall.
- **YOLOv8m INT8** — fits all constraints with more headroom consumed on latency/power/size; still inside the envelope.
- **DetectNet_v2 (ResNet18) INT8 PTQ on Orin** — DLA-class latency, good PTQ retention [6], <100 MB, moderate power — meets all constraints and wins the update-pipeline axis [8].

**Out of window (fail ≥1):**
- **EfficientDet-D4 at full resolution** — fails latency (nearest anchor 42.8 ms even on a V100 without TensorRT) and risks the mAP-retention (>92%) and <100 MB constraints due to TensorRT accuracy loss [1] and model size. It re-enters only at reduced variants (e.g. D4@640, 21.7 ms) at the cost of accuracy.
- **Any model in naive static INT8 PTQ without QAT/good calibration** — fails the >92% precision constraint (documented collapse to mAP50-95 ≈ 18.4 on a large YOLO model).

## Choose-when summary

- **Latency-critical / power-constrained / tightest OTA budget → YOLOv8/YOLO26 on TensorRT** (DLA offload for max camera density) [2].
- **Accuracy-critical at full resolution and latency budget is loose → EfficientDet-D4** (COCO mAP 49.7) — but only off-edge or on far fewer cameras per module; it is the wrong pick for this 200-camera 30 fps edge target.
- **Already locked into NVIDIA DeepStream/Triton and need the most disciplined monthly-SKU retraining + pruning recovery → TAO DetectNet_v2** [8][6].

- NVIDIA TAO Toolkit (v6.25.11, 2026): "Python package that gives you the ability to fine-tune pretrained models with your own data and export them for TensorRT based inference through an edge device" — this is the incremental learning / transfer learning workflow. Features: QAT support, custom layer pruning, prune-retrain loop, BYOM (Bring Your Own Model) custom layer pruning. NOTE: BYOM was deprecated/removed from TAO 6.0.0 package per release notes. New: Inference Microservices (persistent model servers, low-latency, K8s/Docker deploy), AutoML Bayesian hyperparameter optimization, VLM finetuning. TAO integrates with DeepStream SDK out of the box and Triton.
- Edge benchmark paper (arXiv 2409.16808, Jetson Orin Nano, models: YOLOv8 n/s/m, EfficientDet-Lite0/1/2, SSD): Key findings — Jetson Orin Nano was fastest and most energy-efficient device for YOLOv8 without compromising accuracy. CRITICAL: converting SSD and EfficientDet-Lite models to TensorRT REDUCED their accuracy, while YOLOv8 accuracy stayed stable across devices via TensorRT. YOLOv8 Medium consumes more energy / slower than Nano. (Note: this is Orin Nano + EfficientDet-Lite, not AGX Orin + EfficientDet-D4 — directional evidence that EfficientDet suffers more INT8/TensorRT accuracy degradation than YOLOv8.)
- DetectNet_v2 INT8 via TAO Deploy (NVIDIA docs, TAO latest 6.25): gen_trt_engine action builds INT8 TensorRT engine from exported ONNX; uses training-set data sampled randomly for INT8 calibration (one-step, on-the-fly batches). CRITICAL constraint: current QAT does NOT natively support DLA INT8 deployment on Jetson — to run DetectNet_v2 on Jetson DLA INT8 you must force POST-TRAINING QUANTIZATION (PTQ) to generate the calibration cache file. (No explicit DetectNet_v2 latency-ms figure on AGX Orin in primary docs.)
- source_1 Table 4 sustained power (W·s / power draw): Orin Nano YOLOv8s FP32 8.790, FP16 7.836, INT8 7.257; YOLOv8n FP32 8.345, FP16 7.422, INT8 7.483. Orin NX YOLOv8s FP32 14.155, FP16 12.815, INT8 11.002; YOLOv8n FP32 12.480, FP16 10.853, INT8 10.305. Text: Orin Nano power 7.4W(FP32)->8.7W(INT8); Orin NX 10W(INT8)->14W(FP32). INT8 most energy-efficient config.
- source_10 (arXiv 2508.19600) YOLO12 Static INT8 PTQ on clean COCO: baseline accuracy drop ~3-7% absolute mAP50-95 vs FP32, smaller models more affected. Table I: YOLO12n FP32 mAP50-95 0.4047 -> Static INT8 clean 0.3325 (drop ~7.2 pts); YOLO12s FP32 0.4763 -> INT8 0.4114 (drop ~6.5 pts). FP16 near-lossless (n: 0.4044 vs 0.4047). Static INT8 speedup 1.5-3.3x vs FP32.

## Sources

1. [Benchmarking Deep Learning Models for Object Detection on Edge Computing Devices](https://arxiv.org/html/2409.16808v1)
2. [Running TensorRT on Jetson AGX Orin: Step-by-Step Optimization Guide - NVNexus](https://nvnexus.com/tensorrt-jetson-agx-orin-optimization-guide/)
3. [Deploying YOLOv5 on NVIDIA Jetson Orin with cuDLA: Quantization-Aware Training to Inference | NVIDIA Technical Blog](https://developer.nvidia.com/blog/deploying-yolov5-on-nvidia-jetson-orin-with-cudla-quantization-aware-training-to-inference/)
4. [automl/efficientdet/README.md at master · google/automl](https://github.com/google/automl/blob/master/efficientdet/README.md)
5. [Exporting TAO trained Detectnet_V2 (Resnet18) for use in INT8 mode on Jetson Orin NX with Deepstream 7.1](https://forums.developer.nvidia.com/t/exporting-tao-trained-detectnet-v2-resnet18-for-use-in-int8-mode-on-jetson-orin-nx-with-deepstream-7-1/336299/8)
6. [Exporting TAO trained Detectnet_V2 (Resnet18) for use in INT8 mode on Jetson Orin NX with Deepstream 7.1](https://forums.developer.nvidia.com/t/exporting-tao-trained-detectnet-v2-resnet18-for-use-in-int8-mode-on-jetson-orin-nx-with-deepstream-7-1/336299)
7. [2502.15737](https://arxiv.org/pdf/2502.15737)
8. [Release Notes — Tao Toolkit](https://docs.nvidia.com/tao/tao-toolkit/6.25.11/text/release_notes.html)
9. [nvidia-jetson-agx-orin-technical-brief.pdf](https://www.nvidia.com/content/dam/en-zz/Solutions/gtcf21/jetson-orin/nvidia-jetson-agx-orin-technical-brief.pdf)
10. [Jetson Orin Nano Series, Jetson Orin NX Series and Jetson AGX Orin Series — NVIDIA Jetson Linux Developer Guide 1 documentation](https://docs.nvidia.com/jetson/archives/r35.6.4/DeveloperGuide/SD/PlatformPowerAndPerformance/JetsonOrinNanoSeriesJetsonOrinNxSeriesAndJetsonAgxOrinSeries.html)
11. [benchmarks/tensorrt/jetson/detection/README.md at main · NobuoTsukamoto/benchmarks](https://github.com/NobuoTsukamoto/benchmarks/blob/main/tensorrt/jetson/detection/README.md)
12. [TensorRT Export for YOLO26 Models | Ultralytics Docs](https://docs.ultralytics.com/integrations/tensorrt)
13. [Quantization Workflows — NVIDIA TensorRT](https://docs.nvidia.com/deeplearning/tensorrt/latest/inference-library/quantized-types-workflows.html)