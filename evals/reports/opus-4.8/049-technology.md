# MLOps platforms for real-time fraud detection on 50M daily payment transactions (India / Indonesia / Philippines)

## Bottom line

For an ensemble that combines gradient-boosted trees (XGBoost, LightGBM) on CPU with neural networks on GPU, under a real-time fraud SLA, the two **Triton-backed Kubernetes platforms — Seldon Core 2 and KServe — are the strongest technical fit**, because both natively run GBMs (XGBoost/LightGBM) *and* NN frameworks (PyTorch/TensorFlow) on the same serving fabric and can chain them in a server-side inference graph. NVIDIA's published fraud-detection benchmark on the Triton FIL backend shows tree models serving at **>400,000 inferences/sec with p99 latency under 2 ms** on GPU (≈20× CPU throughput) [1], which is the headline reason multi-framework ensembles favor Triton-backed serving.

- **KServe** is the leanest operationally of the two K8s options: declarative `InferenceService`, Knative-based autoscaling with **scale-to-zero**, and the simplest canary/rollback model (`canaryTrafficPercent`) [2][3]. Its weakness is **cold start of 2–5 s** on scale-from-zero [3], which is unacceptable on the request path but acceptable for non-default canary/standby revisions.
- **Seldon Core 2** is the most flexible for true ensembles (MLServer for CPU GBM + Triton for GPU NN, composable pipelines, native A/B and multi-armed-bandit experiments, Alibi-Detect drift) but carries the heaviest Kubernetes operational burden [4][5][3].
- **Ray Serve** offers the most expressive Python model-composition API (mix CPU and GPU deployments in one app) and best-in-class autoscaling, but **brings no optimized framework runtime** — you serve raw Python, so peak GBM/NN throughput trails Triton [6].
- **BentoML** has the lowest initial-deployment effort and good adaptive batching (benchmarked ~1,000+ RPS, p95 < 50 ms on ResNet50 on modest hardware) [7][3], best for a small team, but is a Python-first runtime subject to GIL limits and is "a separate abstraction layer" on Kubernetes rather than K8s-native [3][8].

The real industry signal: **Razorpay (India)** serves fraud scoring within a **200 ms** budget on a Flink-based stack (Mitra) using XGBoost [9]; **Gojek (Indonesia)** targets **<100 ms** for most risk predictions, falling back to a **~2 s** end-to-end target when full features can't be computed in time, and originated Feast and the Merlin/CaraML serving platform [10][11]; **PayMongo (Philippines)** runs real-time per-transaction ML scoring (risk score 0–1000) but publishes no serving-stack internals [12]. None of the three publicly names Seldon/KServe/Ray/BentoML — their disclosures bound the *latency budget*, not the platform choice.

---

## 1. Latency budget derivation (the SLA the platform must hit)

| Quantity | Value | Basis |
|---|---|---|
| Daily transactions | 50,000,000 | question premise |
| Average TPS (÷86,400 s) | ~580 TPS | computed |
| Realistic peak TPS (assume ~4× diurnal peaking) | ~2,300 TPS | computed estimate |
| 10× burst requirement over peak | ~23,000 TPS | question premise (10× normal load) |
| Per-transaction scoring budget (Razorpay) | **200 ms** | [9] |
| Per-transaction target (Gojek, most use cases) | **<100 ms**; **~2 s** end-to-end when features lag | [10] |

Average load (~580 TPS) is modest; the binding constraint is the **10× burst (~23k TPS)** while holding p99 under the ~100–200 ms budget that Razorpay and Gojek publish [9][10]. A single Triton GPU replica serving tree models at >400k inf/s p99<2 ms [1] has enormous headroom for the GBM leg; the NN leg and feature retrieval dominate the budget. The platform must therefore (a) autoscale fast enough to absorb 10× without queue-driven 503s, and (b) keep cold start off the hot path — which directly disfavors scale-to-zero on the *default* serving revision.

Feature retrieval eats into this budget: Razorpay generates "hundreds of features on the fly" within "a few milliseconds" using Flink in-memory state to avoid leaving the application [9], and Gojek generates categorical/graph/tabular features "within milliseconds" [10]. Any platform here sits *downstream* of the feature store (Feast online store, originated at Gojek [10]); the feature-store round-trip is a concrete, quantifiable slice of the budget, not just abstract overhead. Per Feast's performance-tuning guide, the online-store read dominates `get_online_features()` latency, with typical **p50** by backend: **Redis/Dragonfly <1 ms, DynamoDB 2–5 ms, PostgreSQL 3–10 ms, Bigtable 3–8 ms, Cassandra/ScyllaDB 2–5 ms** [13]. Feast's own rule of thumb: use Redis if the **p99 budget is under 10 ms**; use DynamoDB for serverless AWS scaling [13]. Crucially, a **public-internet round-trip adds 5–50 ms** versus a same-VPC/private-endpoint path, so the store must be co-located in-VPC to stay single-digit-ms [13]; Redis batches all feature-view reads into one HMGET pipeline so adding features does not add round trips [13]. Practically, a Redis online store contributes ~1–5 ms (read + serialization) and a DynamoDB store ~2–5 ms to the end-to-end path — i.e., roughly **2–5% of Razorpay's 200 ms budget and up to ~5–10% of Gojek's sub-100 ms target** — leaving the rest for model inference. **None of the four serving platforms (Seldon Core 2, KServe, Ray Serve, BentoML) has a native Feast integration**; feature retrieval is wired in as custom code (a transformer/pre-processor step or in-app client call), which is why the round-trip is additive on top of the platform's own inference latency rather than absorbed by it [13].

---

## 2. Platform-by-platform comparison (same sub-dimensions)

| Dimension | Seldon Core 2 | KServe | Ray Serve | BentoML |
|---|---|---|---|---|
| **Multi-framework ensemble** | MLServer (XGBoost/LightGBM/SKLearn CPU) + Triton (PyTorch/TF/ONNX/TensorRT, FIL for GBM on GPU); composable pipelines [4] | InferenceService runtimes incl. Triton, SKLearn/XGBoost server; V2 protocol [3] | Python model composition, mix CPU/GPU deployments in one app; framework-agnostic, no optimized runtime [6] | Bento packaging + Runners for sklearn/XGBoost/NN; Service-API pipelines [3] |
| **p95/p99 latency** | Pre-packaged MLServer/Triton = production-grade; graph adds ~1–2 ms; Triton FIL p99 <2 ms on GPU [3][1] | Triton/TorchServe runtimes for perf; latency depends on runtime [3] | Per-Python-replica; GIL-bound for CPU work [6] | ResNet50: 1000+ RPS, p95 <50 ms on modest HW; GIL-limited [3] |
| **Throughput / burst** | HPA + optional Knative scale-to-zero; Triton dynamic batching | Knative KPA autoscale on concurrency/RPS, scale-to-zero [14] | "Best-in-class" replica autoscaling + dynamic batching [6] | Adaptive batching; 503 if max_latency_ms exceeded [7] |
| **A/B / traffic split** | Experiments: weighted candidates, A/B, multi-armed bandit native [5][3] | `canaryTrafficPercent` %, tag-routing [2] | Programmatic routing in Python ingress [6] | Service logic / BentoCloud [3] |
| **Versioning / rollback** | Predictor graph + experiment swap | Each update = new revision; rollback via `canaryTrafficPercent: 0` to pin prior revision [2] | Redeploy app/replicas [6] | Bento version pinning [3] |
| **Drift monitoring** | Alibi-Detect native + payload logging [4][3] | Payload logging → Alibi/drift; Knative metrics [3] | Custom/Evidently | Prometheus metrics + custom [3] |
| **Cold start** | Multi-container (executor+model+transformer), ≥512 MB/replica [3] | **2–5 s** scale-from-zero (Knative) [3]; GPU node scale-up >2 min risk [issue] | Replica/actor startup (Ray) | Image pull + process start |
| **Initial vs ongoing effort** | High (deep K8s, multi-container) [3] | Medium-high (K8s + Knative control plane 1–2 GB) [3] | Medium (KubeRay) | **Lowest** initial; pip + `bentoml serve`; separate abstraction on K8s [3][8] |

### Seldon Core 2 + Triton
Seldon Core 2 serves models through **two backends**: MLServer and NVIDIA Triton. MLServer carries **LightGBM (`.bst`), XGBoost (`.bst`/`.json`)**, SKLearn, MLFlow, Spark MLlib, HuggingFace, plus **Alibi-Detect** (drift) and Alibi-Explain. Triton carries **PyTorch (TorchScript), TensorFlow (SavedModel), ONNX, TensorRT, OpenVINO**, and **Triton FIL** for tree models on GPU [4]. This is the cleanest match to the GBM-on-CPU + NN-on-GPU ensemble: both legs are first-class and composable in an inference graph (graph execution adds only ~1–2 ms [3]). A/B testing and multi-armed bandits are native — an **Experiment** defines a weighted traffic split across candidate models/pipelines, with each candidate's share = its weight ÷ sum of weights [5]; the older SeldonDeployment graph also exposes a `RANDOM_ABTEST` node with a `ratioA` parameter [3]. Drift is handled by deploying Alibi-Detect detectors alongside models [4]. Cost of this flexibility is operational: multi-container deployments (executor + model server + optional transformer), ≥512 MB/replica baseline, and "significant operational expertise" to wire up observability [3].

### KServe
KServe exposes a single declarative **`InferenceService`** resource and supports multiple runtimes including the SKLearn/XGBoost server and **Triton** (for GPU NN and FIL tree models), all behind the V2 inference protocol [3]. Autoscaling is via the **Knative Pod Autoscaler (KPA)**, scaling on average in-flight requests per pod (concurrency) and supporting **scale-to-zero** [14]. Canary and rollback are the simplest of any platform here: add `canaryTrafficPercent: 10` to send 10% to the new revision and 90% to the previous; **promote** by removing the field (old revision auto-scales to zero); **roll back** by setting `canaryTrafficPercent: 0`, which pins 100% traffic back to the previous good revision while keeping both pods running for fast re-cutover [2]. Tag routing (`serving.kserve.io/enable-tag-routing`) lets you address `prev-`/`latest-` explicitly [2]. The cost: **2–5 s cold start** on scale-from-zero [3] (a known failure mode when GPU node scale-up exceeds the scale-to-zero window), plus the Knative control plane itself (1–2 GB RAM) [3]. Mitigation for fraud: keep `minReplicas ≥ 1` on the default revision and reserve scale-to-zero for canary/standby.

### Ray Serve
Ray Serve is a **framework-agnostic** Python serving library whose defining feature is **model composition**: multiple `@serve.deployment` units are bound into one application and called like ordinary function calls (`DeploymentHandle.remote()`), each deployment free to request different resources (CPU vs GPU) and run on different machines [6]. It provides dynamic request batching (`@serve.batch`), replica-count autoscaling described as "best-in-class," and multi-node/multi-GPU serving, runnable on Kubernetes via KubeRay [6]. The trade-off relevant here: Ray Serve **ships no optimized framework runtime** — you run your own model code in Python, so for the GBM and NN legs it will not match Triton's FIL/TensorRT throughput, and CPU-bound paths face the Python GIL [6][3]. A/B testing and rollback are done in code (route in the ingress deployment; redeploy to change versions) rather than via a declarative spec.

### BentoML
BentoML packages a model + service into a **Bento**, uses the **Runner** abstraction to load sklearn/XGBoost/NN models, and supports **adaptive batching** — a server-side dispatcher that groups requests until a batch window or `max_batch_size` is met, continuously tuning batch size/window to traffic (larger under load, smaller for latency when quiet), returning **HTTP 503** if `max_latency_ms` is exceeded [7]. Benchmarks cited for it: **1,000+ RPS at p95 <50 ms on ResNet50 on modest hardware**, with the caveat that the Python runtime is GIL-bound for CPU work [3]. It wins decisively on developer experience — `pip install bentoml`, define a service in Python, `bentoml serve`, then `bentoml containerize`; no Kubernetes knowledge required to start, deployable to BentoCloud or K8s [3]. The flip side: it is "less Kubernetes-native than KServe… a separate abstraction layer," with a "smaller community for production-grade" serving and runtime knobs hidden behind the Python-first abstraction [8].

---

## 3. Cost per million predictions on mixed CPU/GPU infrastructure

The sources do **not** publish dollar-per-million-prediction figures or India/Indonesia/Philippines regional cloud pricing, so an exact cost table cannot be grounded here. What the evidence does establish about the cost *shape*:

- **GPU is justified for the GBM leg only at high concurrency.** Triton FIL delivers **>400k inferences/sec at p99<2 ms on GPU, ~20× CPU throughput** (NVIDIA DGX-1, 8×V100) [1]. At ~580 average TPS even the burst (~23k TPS) is two orders of magnitude below one GPU's tree-model ceiling, so GBM scoring is cheapest on CPU (MLServer/SKLearn server) and GPU pays off mainly to consolidate the NN leg and the GBM leg on shared Triton hardware [1].
- **Scale-to-zero economics** favor KServe/Knative for intermittent or per-region standby models — pods scale to zero when idle, at the cost of 2–5 s cold start on the next request [3][14]; this lowers idle GPU spend but is unsafe for the always-on default scorer.
- **Per-replica baseline footprint** affects cost density: Seldon ≥512 MB/replica (multi-container), KServe adds Knative control-plane overhead (1–2 GB), BentoML can run a simple sklearn model in ~256 MB [3].

Net: BentoML/Ray minimize fixed infra cost on a small fleet; KServe minimizes idle cost via scale-to-zero on bursty/standby tiers; Triton (under Seldon or KServe) minimizes cost-per-prediction at high throughput by consolidating frameworks on one GPU.

---

## 4. Industry disclosures (Razorpay, Gojek, PayMongo)

**Razorpay (India).** Its platform **Mitra** uses a Kappa+ streaming architecture: **Apache Flink** core engine, **Kafka** for data and control streams, **RocksDB** in-memory state, HDFS/S3 data lake, with **XGBoost** classification models, NLP for address parsing, and micro-models [9]. Key SLA: **predict within 200 ms** in a distributed environment while generating "hundreds of features on the fly," with feature generation + prediction in "a few milliseconds"; 100+ Flink tasks process millions of transactions/day [9]. Notably, Razorpay **separates training and serving clusters** for independent scaling because bulk training traffic chokes serving — the same separation-of-concerns principle these serving platforms enforce [9].

**Gojek (Indonesia).** Gojek's risk team covers account takeover, user/merchant scam, and promotion abuse; most risk use cases require predictions **under 100 ms**, but because full models + features often can't hit that, they trigger the model on the *closest prior event* and treat a **~2 s end-to-end** latency as "usually sufficient" [10]. Features span categorical, graph (e.g., order-graph component size), and tabular signals over last minute/month/year windows, generated within milliseconds [10]. Every prediction is logged with features, event data, score, **model version**, and timestamp, and they monitor **concept drift**, feature-engineering latency, and prediction latency [10]. Model upgrades = retrain then deploy a replacement [10]. Gojek also **originated Feast** (the open-source feature store, with Google Cloud) and the **Merlin** serving platform (now CaraML), a Kubernetes-friendly model management/deployment/serving system [10][11] — directly relevant because Feast is the most likely online feature store feeding any of these serving platforms within the sub-100 ms budget.

**PayMongo (Philippines).** PayMongo's **Protect** evaluates every transaction in **real time before it completes** via an ML engine that assigns a **risk score 0–1000** (Low 0–499, Medium 500–799, High 800–1000), applies a rules engine, and decides allow/review/block; signals include behavioral patterns, velocity checks, anomaly detection, and device/identity signals, with dashboard explainability of top contributing signals [12]. It currently covers **Cards**, with e-wallets (GCash, Maya, GrabPay) and QR Ph "coming soon" [12]. PayMongo publishes **no serving-stack internals** (no framework, latency, or platform disclosure) — it establishes the Philippine real-time per-transaction context but not a platform comparison data point [12].

---

## 5. Cross-platform synthesis: latency vs cost vs operational complexity

**Multi-framework ensemble (GBM CPU + NN GPU) → Triton-backed platforms win.** Only Seldon Core 2 and KServe put both legs on the same optimized runtime fabric: MLServer/SKLearn-server for CPU GBM and Triton (incl. FIL) for GPU NN/tree models, with server-side ensembles avoiding host↔device data shuffling [4][1][3]. Ray Serve and BentoML can *compose* the two frameworks but run them as ordinary Python, forgoing Triton's FIL/TensorRT throughput and incurring GIL limits on CPU paths [6][3].

**Ranking by dimension (for this workload):**
- **Lowest latency / highest throughput at scale:** Triton FIL under Seldon or KServe (>400k inf/s, p99<2 ms GBM) [1] > BentoML (1000+ RPS p95<50 ms, GIL-bound) [3] ≈ Ray Serve (no native runtime) [6].
- **Lowest operational complexity:** BentoML (no K8s to start) > KServe (declarative, but needs Knative) > Ray Serve (KubeRay) > Seldon Core 2 (multi-container, deepest K8s) [3][8].
- **Best A/B + safe rollback during incidents:** Seldon (native experiments/MAB) and KServe (declarative `canaryTrafficPercent`, instant `:0` rollback) [5][2] > Ray/BentoML (code/version-pin) [6][3].
- **Lowest idle cost:** KServe (scale-to-zero) [14], at the price of 2–5 s cold start [3].

**Engineering effort, mapped to a startup-sized team.** For a small team that does *not* already run Kubernetes/Knative, **BentoML** has the lowest initial cost (pip, Python, `bentoml serve`, `bentoml containerize`) and the tightest iteration loop [3], but you assume more responsibility for production hardening, drift, and high-throughput tuning (and the GIL ceiling) [3][8]. **KServe** is the best balance for a team willing to run Kubernetes: declarative deploys, scale-to-zero economics, and one-line canary/rollback reduce *ongoing* incident toil [2][14], though Knative adds control-plane overhead and cold-start management [3]. **Seldon Core 2** gives the richest ensemble + experiment + drift feature set but the heaviest setup and maintenance burden — justified only once a dedicated platform engineer exists [3]. **Ray Serve** suits a Python-heavy team that wants programmatic composition and is comfortable operating Ray/KubeRay, but its lack of an optimized runtime makes it a weaker choice when raw GBM/NN inference throughput is the constraint [6].

**Practical recommendation pattern** consistent with the evidence: keep the **default fraud scorer always-on (`minReplicas ≥ 1`)** to avoid cold start on the hot path [3], serve the **GBM leg on CPU (MLServer/SKLearn server)** and the **NN leg on GPU via Triton** [4][1], front feature retrieval with **Feast online store** sized to fit the residual budget after inference within Razorpay's 200 ms / Gojek's <100 ms envelope [9][10], and reserve **scale-to-zero for canary and per-region standby tiers** to control idle GPU cost [14]. A startup choosing one platform should pick **KServe** for the K8s-native balance of latency, scale-to-zero cost control, and the simplest rollback, escalating to **Seldon Core 2** only when native experiments/MAB and Alibi-Detect drift become first-order requirements.

## Sources

1. [Real-time Serving for XGBoost, Scikit-Learn RandomForest, LightGBM, and More | NVIDIA Technical Blog](https://developer.nvidia.com/blog/real-time-serving-for-xgboost-scikit-learn-randomforest-lightgbm-and-more/)
2. [Canary Rollout Example | KServe](https://kserve.github.io/website/docs/model-serving/predictive-inference/rollout-strategies/canary-example)
3. [BentoML vs Seldon Core vs KServe: Model Serving Framework Comparison 2026](https://reintech.io/blog/bentoml-vs-seldon-core-vs-kserve-model-serving-framework-comparison)
4. [Inference Artifacts | Seldon Core 2](https://docs.seldon.ai/seldon-core-2/user-guide/models/inference-artifacts)
5. [Experiments | Seldon Core 2](https://docs.seldon.ai/seldon-core-2/user-guide/experiment)
6. [Ray Serve: Scalable and Programmable Serving — Ray 2.55.1](https://docs.ray.io/en/latest/serve/index.html)
7. [Adaptive batching](https://docs.bentoml.com/en/latest/get-started/adaptive-batching.html)
8. [Chapter 45: Inference servers and orchestration: KServe, BentoML, Seldon, Ray Serve, Triton Inference Server — The Holy Grail](https://www.kunwar.page/chapter/045-inference-servers-and-orchestration-kserve-bentoml-seldon-ray-serve-triton-inference-server)
9. [Data science at scale using Apache Flink](https://razorpay.com/unfiltered/data-science-at-scale-using-apache-flink/)
10. [Part-I: Proactive Risk Detection in Fintech: From Data to Real-Time Model Deployment](https://medium.com/gojekengineering/part-i-proactive-risk-detection-in-fintech-from-data-to-real-time-model-deployment-7c8c76bfdf0c)
11. [Models Architecture | CaraML Docs](https://docs.caraml.dev/introduction/architecture/architecture)
12. [Key concepts](https://docs.paymongo.com/docs/security-analytics-protect-key-concepts)
13. [Online Server Performance Tuning | master | Feast: the Open Source Feature Store](https://docs.feast.dev/master/how-to-guides/online-server-performance-tuning)
14. [Autoscaling with Knative Pod Autoscaler | KServe](https://kserve.github.io/website/docs/model-serving/predictive-inference/autoscaling/kpa-autoscaler)