# Bottom line

For a 200-camera warehouse deployment, the only defensible production choice from the grounded evidence is **NVIDIA TAO DetectNet_v2 as the robust-update-pipeline winner**, with **Ultralytics YOLOv8s as the fallback when open retraining agility and model-zoo flexibility matter more than NVIDIA-managed Jetson/TensorRT lifecycle control**. **EfficientDet-D4 should be demoted**: it is accurate on COCO, but its TensorRT conversion path is now explicitly deprecated in the NVIDIA TensorRT sample because of `tf2onnx` dependency compatibility problems, which makes monthly SKU-update operations riskier than the other two paths [1].

| Criterion for this deployment | YOLOv8s | EfficientDet-D4 | TAO DetectNet_v2 |
|---|---:|---:|---:|
| 30 fps/camera feasibility | Strong on inference-only evidence: 3.2 ms INT8 mean / 313 fps on Jetson AGX Orin 32GB, but not end-to-end p95 [2] | Unproven on AGX Orin D4; D4 is 1024×1024, 20.7M params, 55.2B FLOPs [3] | Strong for DetectNet_v2-ResNet18/PeopleNet class: Orin INT8 GPU 390 fps in TAO model-zoo table; PeopleNet ResNet34 v2.6 reports AGX Orin GPU 421 fps INT8, both inference-only [4] [5] |
| INT8 mAP retention | No warehouse FP16/INT8 mAP evidence; export/calibration path exists [6] | D0 sample drops 4.2 AP points from FP16 0.341 to INT8 0.299; D4/warehouse evidence absent [1] | Best managed path for QAT/calibration; no pallet_label/package_damage mAP evidence [7] |
| Watts per stream | Board power under this model not reported; 60W AGX Orin 64GB TDP sets upper planning envelope [8] | Same: not reported | Same: not reported; published TAO model-zoo tables separately report GPU and DLA1+DLA2 INT8 throughput for DetectNet_v2-family models [4] |
| Sub-100 MB OTA artifact fit | Likely from parameter count, but exact compressed FP16/INT8 engine sizes were not established; YOLOv8s has 11.2M params [9] | Likely for weights, uncertain for TensorRT engine; exact compressed artifacts were not established; D4 has 20.7M params [3] | Likely for ResNet18; exact compressed artifacts were not established; pruning/retraining is documented [7] |
| Monthly update maintainability | Strong for open training/export; less managed than TAO for Jetson fleet deployment [6] | Weak: TensorFlow→ONNX→TensorRT sample deprecated as of TensorRT 10.14 [1] | Strongest: transfer learning, pruning, QAT, INT8 calibration cache, TAO Deploy/DeepStream path [10] [7] |

The hard capacity target is **200 cameras × 30 fps = 6,000 frames/s aggregate**, with a **≤33.3 ms per-camera frame period** for decode, preprocessing, inference, NMS, and postprocessing. Published figures for YOLOv8s and TAO PeopleNet/DetectNet_v2 are **inference-only**, so fleet sizing below is an inference-capacity screen, not a substitute for an end-to-end DeepStream soak test.

## Benchmark environment and workload definition

The workload is fixed at **6,000 aggregate frames/s**: 200 cameras × 30 fps. A single camera at 30 fps has a **33.333 ms/frame period**, and the practical budget must include decode, preprocessing, inference, NMS, and postprocessing, not just TensorRT engine time.

For Jetson AGX Orin 64GB, the current software baseline on the NVIDIA downloads page is **JetPack 7.2 / Jetson Linux 39.2**, with **CUDA 13.2.1**, **cuDNN 9.20.0**, and **TensorRT 10.16.2**; the same page lists **Jetson Orin Family** support [11]. A prior JetPack 6.2.2 page gives **Jetson Linux 36.5**, **CUDA 12.6**, **TensorRT 10.3**, **cuDNN 9.3**, **VPI 3.2**, and **DLA 3.1 / DLA 3.14 in conflicting passages**, so the current benchmark baseline should be JetPack 7.2 unless compatibility with older deployment containers forces JetPack 6.2.2 [12] [11].

For sustained benchmarking on AGX Orin 64GB, use **MAXN mode ID 0** via `sudo /usr/sbin/nvpmodel -m 0`: **12 online CPU cores**, **CPU max 2201.6 MHz**, **8 GPU TPC**, **GPU max 1301 MHz**, **2 DLA cores**, **DLA core max 1600 MHz**, **DLA Falcon max 844.8 MHz**, and **memory max 3200 MHz** [8]. NVIDIA’s Jetson Linux documentation warns that MAXN is unconstrained and may throttle when module power exceeds the TDP budget, so sustained tests should use the `jetson-agx-orin-devkit-maxn` flash configuration with the more conservative thermal settings; the AGX Orin 64GB module TDP budget is **60W**, with **65W instantaneous CPU_CV_GPU_SOC** before throttling behavior [8].

## Concrete model choices

| Model | Concrete benchmark variant | Input | Parameters / compute | Engine/artifact sizes | Deployment path |
|---|---|---:|---:|---|---|
| Ultralytics YOLOv8 | **YOLOv8s**, not YOLOv8m, for the first benchmark because the 33.3 ms budget and OTA constraint favor the smaller model; YOLOv8m is the accuracy fallback | 640 px | YOLOv8s: **11.2M params**, **28.6B FLOPs**, COCO mAP50-95 **44.9**; YOLOv8m: **25.9M params**, **78.9B FLOPs**, COCO mAP50-95 **50.2** [9] | Exact FP16/INT8 TensorRT engine MB and compressed OTA artifact sizes were not established | `.pt` → ONNX via `yolo mode=export model=yolov8s.pt format=onnx` → TensorRT engine using `trtexec --onnx=... --saveEngine=... --fp16` or `--int8`; Ultralytics also supports TensorRT export with `int8=True`, `data=<dataset.yaml>`, and calibration subset `fraction` [2] [6] |
| EfficientDet-D4 | **EfficientDet-D4 BiFPN with EfficientNet-B4 backbone** | 1024×1024 | **20.7M params**, **55.2B FLOPs**, COCO mAP **49.7**, AP50 **68.4**, AP75 **53.9** in Google table; CVPR paper reports D4 AP **49.4**, AP50 **69.0**, **21M params**, **55B FLOPs**, Titan V batch-1 latency **74 ms** [3] [13] | Exact FP16/INT8 engine MB and compressed OTA artifact sizes were not established | TensorFlow SavedModel → ONNX graph → TensorRT engine using `trtexec` or `build_engine.py`; D4 input in NVIDIA sample is 1024×1024 [1] |
| NVIDIA TAO DetectNet_v2 | **DetectNet_v2-ResNet18** for edge throughput; ResNet34 only if validation accuracy requires it | 960×544×3 for TAO traffic/people model family; TrafficCamNet specifies RGB 960×544×3, NCHW, scale 1/255.0, no mean subtraction [14] | TAO supports ResNet depths **10, 18, 34, 50, 101**; exact DetectNet_v2-ResNet18/34 parameter count was not established [7] | Exact FP16/INT8 engine MB and compressed OTA artifact sizes were not established | DetectNet_v2 train/evaluate/prune/retrain/export → ONNX/ETLT → TAO Deploy `gen_trt_engine` TensorRT FP16/INT8 engine; DeepStream integration is documented [10] [7] |

The custom warehouse dataset specification in the research question—**50,000 images**, train/validation/test counts, class taxonomy including **`pallet_label`** and **`package_damage`**, object-count distribution, SKU/month drift profile, and whether mAP is **mAP@0.5** or **mAP@0.5:0.95**—is not present in the public model/vendor sources. Those values must come from the warehouse dataset manifest before any FP16/INT8 degradation claim can be treated as measured.

## Inference latency, TensorRT gains, and fleet sizing

| Model | Published latency / throughput evidence | TensorRT optimization gain evidence | Inference-only cameras/module at 30 fps | Modules for 200 cameras | Missing for production decision |
|---|---:|---:|---:|---:|---|
| YOLOv8s | Seeed/Ultralytics-style AGX Orin 32GB H01, 640×640, ONNX→`trtexec`: **FP32 mean 7.2 ms / 139 fps**; **INT8 mean 3.2 ms / 313 fps** [2] | FP32→INT8 speedup = **7.2 / 3.2 = 2.25×** from the published figures; PyTorch/ONNX FP16 and TensorRT FP16 were not reported; INT8 calibration set size was not reported in that benchmark [2] | floor(313/30) = **10 cameras/module** | ceil(200/10) = **20 modules** | FP16 baseline mAP, INT8 mAP, mAP drop, p50/p95 latency, GPU/DLA utilization, sustained board power |
| EfficientDet-D4 | No D4 AGX Orin latency found; D4 paper gives **74 ms** batch-1 latency on Titan V and Google/NVIDIA give D4 size/accuracy, not Orin runtime [13] | NVIDIA EfficientDet sample gives D0 only: FP32 **3.25 ms**, FP16 **2.27 ms**, mixed **1.75 ms**, INT8 **1.63 ms**; FP16→INT8 speedup = **2.27 / 1.63 = 1.39×**; INT8 AP drops **0.341→0.299**, i.e. **4.2 points**; calibration guidance is several thousand images, with **5,000 images** good for COCO [1] | Not computable from D4/Orin p95; Titan V 74 ms would fail 30 fps if treated as end-to-end | Not computable | D4 AGX Orin FP16/INT8 latency, p95, mAP, utilization, power |
| TAO DetectNet_v2 | TAO overview reports PeopleNet DetectNet_v2-ResNet18 960×544×3 INT8 on Orin GPU: **390 fps** and DLA1+DLA2 **164 fps**; PeopleNet ResNet34 v2.6 model card reports AGX Orin GPU **421 fps** and DLA1+DLA2 **104 fps**, inference-only with trtexec at Max-N [4] [5] | TAO-exported FP16 vs INT8 speedup for the same warehouse DetectNet_v2 model was not reported; TAO does document INT8 calibration through training data and `gen_trt_engine` [10] | ResNet18 GPU: floor(390/30) = **13 cameras/module**; ResNet34 v2.6 GPU: floor(421/30) = **14 cameras/module**; ResNet18 DLA pair: floor(164/30) = **5 cameras/module**; ResNet34 DLA pair: floor(104/30) = **3 cameras/module** | ResNet18 GPU: ceil(200/13) = **16 modules**; ResNet34 v2.6 GPU: ceil(200/14) = **15 modules**; ResNet18 DLA pair: **40 modules**; ResNet34 DLA pair: **67 modules** | Warehouse FP16/INT8 mAP, p50/p95 latency, exact board power, utilization |

The fleet-sizing result favors **TAO DetectNet_v2-ResNet18/34 on GPU** on published inference-only throughput, followed by **YOLOv8s**, while **EfficientDet-D4 cannot be responsibly sized** without a D4 TensorRT p95 run on the target Jetson image. These module counts should be padded after adding decode, preprocessing, postprocessing/NMS, stream muxing, and thermal throttling behavior because the cited numbers are not end-to-end multi-camera measurements.

## Accuracy, INT8 degradation, and the sub-100 MB OTA floor

The requested **warehouse-specific accuracy floor below 100 MB** cannot be asserted from the public sources because the required measured values—`pallet_label` mAP, `package_damage` mAP, overall mAP, precision, recall, F1, and smallest compressed FP16/INT8/pruned artifacts on the held-out 50K-image dataset—are not in the vendor/model documents. What is grounded is narrower:

| Model | Grounded accuracy/compression evidence | Practical implication for <100 MB OTA |
|---|---|---|
| YOLOv8s | 11.2M params and COCO mAP50-95 44.9 at 640 px; YOLOv8m is 25.9M params and COCO mAP50-95 50.2 [9] | YOLOv8s is the correct first benchmark for OTA and latency; YOLOv8m is a controlled escalation only if warehouse damage/label mAP is below target |
| EfficientDet-D4 | 20.7M params, COCO mAP 49.7/AP50 68.4/AP75 53.9; D0 sample INT8 AP loss is 4.2 points, not D4 [3] [1] | D4 may fit by weights but TensorRT engine size and update complexity are risks; the deprecated conversion sample makes it a poor OTA/monthly-update choice |
| TAO DetectNet_v2 | TAO documents pruning to reduce model size and retraining to recover accuracy, QAT support, and INT8 calibration cache export [7] | Most robust route to a reproducible sub-100 MB OTA package, provided the actual pruned/INT8 artifact is measured and validated on held-out warehouse data |

The **practical accuracy floor** should therefore be set operationally rather than inferred from COCO: reject any sub-100 MB candidate whose held-out warehouse precision falls below **92% overall** or whose `package_damage` recall/precision trade-off is unacceptable for false negatives. On current evidence, the most plausible first compression path is **TAO DetectNet_v2-ResNet18 INT8 with pruning/retraining/QAT**, with **YOLOv8s INT8** as the agile fallback; EfficientDet-D4 is not the practical floor-setting model because the conversion/update path is the least maintainable.

## Model-update pipeline comparison

**NVIDIA TAO DetectNet_v2 is the robust-update-pipeline winner** when the priority is reproducible Jetson/TensorRT deployment. TAO DetectNet_v2 supports pretrained weight loading with `load_graph=false`, transfer learning across different resolutions and domains, random initialization for absent layers, freezing ResNet blocks `[0,1,2,3,4]`, default `batch_size_per_gpu=32`, default `num_epochs=120`, and `enable_qat` for quantization-aware training [7]. Its compression workflow is explicit: prune to reduce parameters, retrain to recover accuracy, export INT8 calibration cache, and generate a TensorRT engine through TAO Deploy `gen_trt_engine`; its recommended INT8 calibration path uses the training data loader directly so preprocessing matches training and batches are randomly sampled across the training set [10] [7].

**Ultralytics YOLOv8s is the fallback** when the priority is fast open retraining, simple class expansion, and model-zoo flexibility. The grounded path is `.pt` training/export to ONNX and then TensorRT via `trtexec`, or Ultralytics TensorRT export with `int8=True`, `data=<dataset.yaml>`, and calibration subset control via `fraction` [6]. Its operational weakness relative to TAO is not model quality but lifecycle control: the evidence here does not include a managed Jetson fleet deployment pipeline equivalent to TAO Deploy/DeepStream.

**EfficientDet-D4 is demoted** despite strong COCO accuracy because the official NVIDIA TensorRT EfficientDet sample is a TensorFlow SavedModel→ONNX→TensorRT path and is **deprecated as of TensorRT 10.14** due to `tf2onnx` dependency compatibility issues [1]. On a JetPack 7.2 / TensorRT 10.16.2 baseline, that is a direct maintenance risk for monthly SKU arrival cycles.

## Active learning and monthly SKU drift

Edge active learning can reduce labeling load, but the fetched evidence does **not** support a categorical claim that it will maintain **>92% precision** for `pallet_label` and `package_damage` without full retraining. Entropy is a standard uncertainty acquisition function because it measures disorder/randomness in model predicted class probabilities, and online active learning can use uncertainty or gradient-based selection [15]. The limiting factor is continual learning: new SKU appearance is a real-world incremental-learning problem, and continual-learning surveys identify catastrophic forgetting—new-task learning degrading old-task performance—as a core constraint, requiring a stability–plasticity trade-off [16].

The safe policy is therefore:

- Use edge triggers for **low confidence / high entropy detections** and for disagreement between FP16 validation and INT8 deployment outputs; the exact confidence/entropy threshold, monthly sample count, human-labeling turnaround, replay-buffer size, and post-update precision must be measured on the warehouse stream because no grounded source reports those values for this task.
- Permit monthly lightweight fine-tuning only when SKU drift is localized to new label/package appearances and held-out replay performance remains above the warehouse floor.
- Force full retraining, not just incremental fine-tuning, when accumulated new-SKU drift causes calibration instability after INT8, when old-SKU false positives rise, or when `package_damage` false negatives increase; the false-negative cost is higher for damage than for pallet-label reading because missed damage is an exception-handling and claims-liability failure rather than only an inventory-identification miss.

## Final ranking

1. **NVIDIA TAO DetectNet_v2-ResNet18** — best production choice for this deployment because it has the strongest Jetson/TensorRT lifecycle, documented transfer learning, pruning, QAT, INT8 calibration, and DeepStream/TAO Deploy integration; published DetectNet_v2-family Orin INT8 throughput is comfortably above 30 fps/camera on an inference-only basis [10] [7] [4].
2. **Ultralytics YOLOv8s** — best fallback for rapid open retraining and flexible model iteration; its grounded Orin INT8 figure, **3.2 ms / 313 fps**, is strong, but the available benchmark lacks the warehouse mAP, p95 latency, utilization, and power data needed for a final production sizing sign-off [2] [9].
3. **EfficientDet-D4** — third choice: strong COCO detector architecture, but ungrounded on AGX Orin D4 INT8 p95/power and burdened by a deprecated TensorRT conversion sample, so its update complexity outweighs any likely accuracy gain for monthly SKU drift [1] [3].

## Sources

1. [TensorRT/samples/python/efficientdet at main · NVIDIA/TensorRT · GitHub](https://github.com/NVIDIA/TensorRT/tree/main/samples/python/efficientdet)
2. [YOLO26 on NVIDIA Jetson Setup & Benchmarks | Ultralytics Docs](https://docs.ultralytics.com/guides/nvidia-jetson)
3. [automl/efficientdet/README.md at master · google/automl](https://github.com/google/automl/blob/master/efficientdet/README.md)
4. [Overview - NVIDIA Docs](https://docs.nvidia.com/tao/tao-toolkit-archive/5.2.0/text/model_zoo/overview.html)
5. [PeopleNet | NVIDIA NGC](https://catalog.ngc.nvidia.com/orgs/nvidia/tao/models/peoplenet/deployable_quantized_v2.6.1)
6. [Model Export with Ultralytics YOLO | Ultralytics Docs](https://docs.ultralytics.com/modes/export/)
7. [DetectNet_v2 — Tao Toolkit](https://docs.nvidia.com/tao/tao-toolkit/latest/text/cv_finetuning/tensorflow_1/object_detection/detectnet_v2.html)
8. [Jetson Orin Nano Series, Jetson Orin NX Series and Jetson AGX Orin Series — NVIDIA Jetson Linux Developer Guide 1 documentation](https://docs.nvidia.com/jetson/archives/r35.6.1/DeveloperGuide/SD/PlatformPowerAndPerformance/JetsonOrinNanoSeriesJetsonOrinNxSeriesAndJetsonAgxOrinSeries.html)
9. [Explore Ultralytics YOLOv8 | Ultralytics Docs](https://docs.ultralytics.com/models/yolov8/)
10. [DetectNet_v2 with TAO Deploy — Tao Toolkit](https://docs.nvidia.com/tao/tao-toolkit/latest/text/tao_deploy/detectnet_v2.html)
11. [NVIDIA JetPack SDK Downloads and Notes](https://developer.nvidia.com/embedded/jetpack/downloads)
12. [JetPack SDK](https://developer.nvidia.com/embedded/jetpack-sdk-622)
13. [Tan_EfficientDet_Scalable_and_Efficient_Object_Detection_CVPR_2020_paper.pdf](https://openaccess.thecvf.com/content_CVPR_2020/papers/Tan_EfficientDet_Scalable_and_Efficient_Object_Detection_CVPR_2020_paper.pdf)
14. [TrafficCamNet | NVIDIA NGC](https://catalog.ngc.nvidia.com/orgs/nvidia/tao/models/trafficcamnet/-)
15. [Active learning for data streams: a survey](https://arxiv.org/abs/2302.08893v4)
16. [A Comprehensive Survey of Continual Learning: Theory, Method and Application](https://arxiv.org/abs/2302.00487)