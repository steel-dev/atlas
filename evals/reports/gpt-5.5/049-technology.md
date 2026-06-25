# Bottom line

For a 50,000,000-prediction/day payments-fraud workload across India, Indonesia, and the Philippines, the aggregate baseline is **578.7 predictions/sec average** and the required **10× burst target is 5,787 predictions/sec**; no country split was provided, so this comparison sizes the serving layer on the aggregate regional load rather than allocating capacity by country.

**Recommended production default:** **Seldon Core 2 + NVIDIA Triton Inference Server on Kubernetes** if the startup already runs a regulated multi-country Kubernetes platform and needs fast rollbacks, auditable inference, and mixed tree/neural serving. Triton’s published fraud XGBoost benchmark reports **>400,000 inferences/sec** and **p99 <2 ms** on an 8×V100 DGX-1 for the tree component, which is about **69×** the 5,787 rps burst target before accounting for neural-model, feature-store, and network overhead [1]. **Fastest MVP:** **BentoML/BentoCloud** or **Ray Serve**. **Most flexible Python ensemble orchestration:** **Ray Serve**. **Most Kubernetes-standard abstraction:** **KServe**. **Fallback if p99 or rollback SLOs fail:** run the latency-critical XGBoost/LightGBM + neural ensemble directly in **Triton** behind Seldon/KServe only as the rollout/control plane, keep Feast reads pre-enriched or colocated, and disable scale-to-zero for fraud paths.

| Platform option | Best fit | Published latency/throughput evidence relevant to this workload | Burst posture at 5,787 rps | Rollout/rollback posture | Main trade-off |
|---|---:|---:|---:|---:|---|
| **Seldon Core 2 + Triton** | Regulated Kubernetes production with high-throughput mixed runtimes | Triton FIL fraud XGBoost: **p99 <2 ms**, **>400k infer/sec** on 8×V100 DGX-1; explicit p95 not published in fetched source [1] | Strongest raw headroom for tree model; neural branch still must be benchmarked with chosen TensorRT/ONNX/PyTorch backend | Seldon Core 2 is Kubernetes-native and emphasizes observability, MMS, autoscaling/scale-to-zero, and Alibi integration [2]; rollback can use Seldon/Kubernetes revision controls, but exact fetched v2 experiment syntax was not captured | Highest platform-engineering effort, best long-term governance |
| **Ray Serve on Ray 2.55.1** | Python-native ensemble graphs and custom business logic | Two-stage DLRM case: **490 → 1,573 QPS** and **75% lower p99** after HAProxy/gRPC optimizations; no sourced 5,787-rps fraud p95/p99 benchmark [3] | Needs horizontal replicas; at the published 1,573 QPS/two-stage pipeline, **4 replicas/pipelines** cover 5,787 rps before headroom | Application config is upgrade unit; `user_config` can change model versions, traffic split, A/B flags without restarting replicas [4][5] | Flexible, but more self-built governance/drift/lifecycle tooling |
| **KServe 0.18 on Kubernetes** | Kubernetes-standard InferenceService abstraction | Benchmark, not fraud ensemble: Knative sklearn iris at **500 QPS p95 4.929 ms/p99 5.642 ms**; at **1,000 QPS p95 2.945 s/p99 3.691 s** with one replica [6] | Must set min replicas/HPA/KPA; avoid scale-from-zero for fraud SLOs | `canaryTrafficPercent` splits traffic and rollback pins 100% to previous good revision [7] | Clean K8s standard, but Knative cold starts and queueing can dominate tail latency |
| **BentoML / BentoCloud** | Fastest MVP, Python service packaging, managed deployment | Fetched docs give GPU, scaling, batching, metrics and rollback mechanics, but no p95/p99 or 5,787-rps benchmark for this fraud ensemble [8][9][10][11] | Requires load test and min/max replicas; use external ingress/service mesh for advanced split if not on BentoCloud canary | Bento tags and BentoCloud deployment revisions; rollback from Revisions tab [10] | Lowest initial effort, but drift/A-B/governance are less native than Seldon/KServe |

## 1. Workload and sizing assumptions

The workload is **50,000,000 predictions/day**, which is **50,000,000 ÷ 86,400 = 578.7 predictions/sec average**. A 10× burst target is **5,787 predictions/sec**. The prompt does not provide India/Indonesia/Philippines traffic shares, so all platform comparisons use the aggregate multi-country workload. This matters because country-level routing can be added later for data residency and latency, but the serving layer must first absorb the aggregate 5,787-rps burst.

The model shape assumed throughout is a real-time fraud ensemble with:

- **Tree model branch:** XGBoost or LightGBM.
- **Neural branch:** a PyTorch/TensorFlow/ONNX/TensorRT-style model, depending on the platform runtime.
- **Feature lookup:** Feast-style online feature retrieval unless upstream stream processing pre-enriches the request.
- **SLO interpretation:** p95/p99 figures below refer to serving-layer benchmarks where sources publish them; end-to-end fraud latency also includes feature generation, network hops, logging, and risk-rule orchestration.

## 2. Platform status, deployment units, and model-framework fit as of 2026-06-23

As of **2026-06-23**, the fetched documentation establishes all four as production-relevant and actively documented serving options, but with different maturity signals: Seldon Core 2 is explicitly described as a **production-ready** Kubernetes-native framework [2]; Ray Serve docs are for **Ray 2.55.1** [12]; KServe docs are **Version 0.18** [7]; and BentoML/BentoCloud docs cover current deployment, rollback, GPU, metrics, and scaling workflows [8][10][11]. The fetched sources do not provide a separate universal “GA” label for every product, so “GA/active” below means production documentation was available and current in the fetched source set, not that a vendor support contract was verified.

| Option | Production-relevant release/status from fetched docs | Deployment unit | Kubernetes-native? | XGBoost/LightGBM + neural ensemble fit |
|---|---|---|---|---|
| **Seldon Core 2 + Triton** | Seldon Core 2 docs describe it as a “Production-ready ML Serving Framework” and a Kubernetes-native framework for ML/LLM systems at scale; fetched main page was last updated 11 months before retrieval [2]. Triton FIL docs and NVIDIA blog show production tree-serving support [1][13]. | Seldon model/pipeline resources plus Triton model repository entries. | Yes for Seldon; Triton has Docker/Helm/Kubernetes deployment support [1]. | Strongest specialized runtime fit: Triton **FIL** for XGBoost/LightGBM [13][14], and Triton neural backends such as TensorRT/ONNX/PyTorch/TensorFlow are the natural branch for neural inference; custom Python/C++ backends can bridge missing pipeline logic [1]. |
| **Ray Serve on Ray 2.55.1** | Ray Serve docs fetched are **Ray 2.55.1** and call Serve “scalable and programmable serving” [12]. | Ray Serve **application** consisting of one or more **deployments**; application is the upgrade unit [4]. | Runs on Kubernetes through KubeRay, but Ray itself is the serving substrate; docs say Serve can run natively on Kubernetes with minimal operational overhead [12]. | Best Python-native orchestration: deployment handles compose arbitrary Python deployments, so XGBoost/LightGBM, PyTorch, rules, and feature code can live in one graph [4][12]. |
| **KServe 0.18** | Fetched KServe docs show **Version 0.18** [7]. | Kubernetes **InferenceService** plus ServingRuntime/ClusterServingRuntime; XGBoost docs use `modelFormat.name: xgboost` and `runtime: kserve-xgbserver` [15]. | Yes; requires Kubernetes cluster with KServe installed [16]. | Good standardization: XGBoost runtime for tree models [15], TensorFlow example for neural serving [16], Triton or custom runtimes for more complex mixed ensembles, and ModelMesh for multi-model patterns where deployed. |
| **BentoML / BentoCloud or self-hosted BentoML** | Fetched BentoML docs cover current BentoML/BentoCloud service, GPU, scaling, monitoring, and deployment management [8][10][11]. | A packaged **Bento** deployed as a BentoCloud Deployment or self-hosted container/Kubernetes service. | Self-hosted BentoML is container/Kubernetes-friendly but not a Kubernetes-native CRD platform in the same sense as KServe/Seldon; BentoCloud is managed. | Good Python-service fit for combining XGBoost/LightGBM libraries, neural frameworks, feature calls, and business logic in one service; less specialized than Triton unless embedding/side-calling Triton. |

## 3. Latency, throughput, burst behavior, and cold starts

### 3.1 Seldon Core 2 + Triton Inference Server

For the tree branch, NVIDIA’s FIL backend is the most directly relevant published benchmark. NVIDIA reports that a fraud-detection XGBoost model deployed with Triton FIL on a DGX-1 with **8×V100 GPUs** can keep **p99 latency under 2 ms** while serving **>400,000 inferences/sec**, or **630 MB/sec**, about **20× CPU throughput** [1]. The fetched source does **not** publish p95 for that benchmark, and it is not a full XGBoost/LightGBM + neural ensemble benchmark. For this workload, the tree branch alone has **>400,000 ÷ 5,787 = about 69×** burst headroom on the cited hardware [1].

Triton’s concrete backend mapping for the requested ensemble is clear for the tree side: **FIL** supports XGBoost and LightGBM and the Triton FIL documentation points users to XGBoost/LightGBM model support and a categorical fraud-detection notebook [13][17][14]. For the neural side, Triton is designed to serve deep-learning models and can use optimized neural runtimes such as TensorRT/ONNX/PyTorch/TensorFlow depending on exported format; custom Python or C++ backends can link specialized logic if part of the ensemble is unsupported [1]. Seldon Core 2 then supplies Kubernetes-native model/pipeline management, observability, multi-model serving and autoscaling/scale-to-zero concepts around the runtime [2].

Cold-start posture: for real-time fraud, use **min replicas >0**. Seldon docs state autoscaling and scale-to-zero are supported while preserving deployment state [2], but a payments authorization path should not depend on scale-from-zero because model-load and feature-store warmup can blow a p99 SLO.

### 3.2 Ray Serve

Ray Serve’s fetched docs support the requested graph shape: a Serve **application** can contain multiple deployments, an ingress deployment can call downstream model deployments through **DeploymentHandle**, and Ray routes requests to replicas [4]. Ray Serve also explicitly supports arbitrary Python code and integrations with XGBoost, Scikit-learn, model optimizers, monitoring systems such as Seldon Alibi and Arize, model registries such as MLflow/W&B, and web APIs such as FastAPI/gRPC [12]. The XGBoost example shows a Ray Serve XGBoost service deployed with target replicas set to 2 [18]. LightGBM is not singled out in the fetched Ray source, but because Serve runs arbitrary Python deployments, LightGBM serving is an SDK-level Python implementation rather than a native specialized backend.

The strongest fetched throughput source is Anyscale’s Ray Serve optimization article: HAProxy ingress and direct interdeployment gRPC improve online inference, a two-stage DLRM pipeline improved from **490 QPS to 1,573 QPS** with **75% lower p99 latency**, and no-op microbenchmarks showed up to **11.1×** unary throughput improvement and **8.9×** streaming throughput improvement at 8 replicas [3]. The article does not publish a fraud-ensemble p95/p99 at 5,787 rps. A simple capacity translation from the published two-stage DLRM figure is that **4 equivalent pipelines × 1,573 QPS = 6,292 QPS**, enough to cover the **5,787-rps** burst before safety margin, feature-store overhead, and neural/tree model cost [3].

Ray Serve supports dynamic batching: `max_batch_size` default **10**, `batch_wait_timeout_s` default **0.01 seconds**, and custom `batch_size_fn` can batch by tokens, graph nodes, or other cost metrics [19]. For fraud authorization, batching should be constrained tightly because the batch wait directly consumes p99 latency budget.

### 3.3 KServe on Kubernetes

KServe 0.18 uses the Kubernetes **InferenceService** abstraction and supports HTTP/REST and gRPC through the Open Inference Protocol [16][20]. For XGBoost, KServe uses `modelFormat.name: xgboost`, `runtime: kserve-xgbserver`, and model files such as `.bst`, `.json`, or `.ubj` [15]. For neural models, fetched docs show TensorFlow InferenceService support and canary rollout examples [16]; for mixed XGBoost/LightGBM + neural ensembles, use separate InferenceServices plus an orchestrator/transformer, a Triton runtime, ModelMesh where appropriate, or a custom runtime.

The fetched benchmark is **not** the requested fraud ensemble; it is KServe benchmark material for example models. It still gives a useful warning about tail latency under Knative. A Knative Service with one replica handled **500 QPS** at **p95 4.929 ms** and **p99 5.642 ms**, but at **1,000 QPS** tail latency rose to **p95 2.945 s** and **p99 3.691 s** [6]. The same source reports raw Kubernetes Service/HPA examples with lower overhead at low QPS, including **5 QPS p95 4.352 ms/p99 5.966 ms** and **50 QPS p95 2.684 ms/p99 3.02 ms** [6].

Cold-start posture: KServe serverless mode inherits Knative scale-to-zero behavior; KServe’s canary strategy explicitly applies in serverless deployment mode [7]. For a fraud path, set nonzero minimum replicas or use RawDeployment/HPA for latency-critical models, because scale-from-zero cold starts and queue-proxy/activator behavior are operationally risky at a 5,787-rps burst.

### 3.4 BentoML / BentoCloud

BentoML is the least opinionated way to package a Python fraud service. It supports GPU resources through the service decorator, for example `@bentoml.service(resources={"gpu": 1, "gpu_type": "nvidia-l4"})`, and fetched docs list BentoCloud GPU instance classes including `gpu.t4.1`, `gpu.l4.1`, and `gpu.a100.1` [8]. BentoML workers run service logic; the default is one worker, and multiple workers can be mapped to GPUs [8]. BentoCloud Deployments expose scaling fields such as `min_replicas` and `max_replicas`, updateable via CLI flags such as `--scaling-min` and `--scaling-max` [10].

BentoML supports adaptive batching; fetched docs link batching with BentoML/BentoCloud service deployment and scaling [9], and metrics include adaptive-batch histograms [11]. The fetched sources do **not** publish p95, p99, or 5,787-rps throughput for this fraud ensemble. For the comparison, BentoML should be treated as a **self-hosted Kubernetes container or BentoCloud Deployment that must be benchmarked**; if used for an authorization path, configure min replicas and avoid scale-to-zero cold starts.

## 4. A/B testing, canary, shadowing, and rollback mechanisms

| Platform | A/B, canary, or traffic split | Incident rollback/versioning |
|---|---|---|
| **Seldon Core 2 + Triton** | Seldon Core historically provides experiment/canary graph patterns and Core 2 docs emphasize standardized workflows and a unified execution framework [2]. The exact fetched Core 2 experiment/scheduler YAML was not captured, so for a production design treat Seldon/Kubernetes rollout controls and service-mesh traffic splitting as the auditable mechanism. | Use Seldon model/pipeline revisioning where configured or Kubernetes rollout rollback for the Seldon/Triton Deployment. Core 2’s docs emphasize deployment management, observability, MMS, and autoscaling [2], but the exact fetched rollback command was not captured. |
| **Ray Serve** | Request routing is implemented through an ingress deployment and `DeploymentHandle`s; `user_config` can adjust traffic-splitting percentage for a model-composition graph, feature flags, A/B tests, model weights/versions, and hyperparameters without restarting replicas [4][5]. | A Serve **application** is the upgrade unit [4]. Roll back by reapplying the last known-good Serve application config and/or prior `user_config`; Anyscale Services add canary and zero-downtime rollout controls where used [18]. |
| **KServe** | In serverless deployment mode, `predictor.spec.canaryTrafficPercent` routes a percentage of traffic to the new revision; example text describes **10%** to the new revision and **90%** to the latest rolled-out revision [7]. | KServe tracks `LatestRolledoutRevision` and `PreviousRolledoutRevision`; rollback pins **100%** traffic to the previous healthy/good revision [7]. |
| **BentoML / BentoCloud** | BentoCloud has Deployment management and can roll out a new Bento with `bentoml deployment update <deployment-name> --bento bento_name:version` [10]. Advanced A/B or shadow routing on self-hosted BentoML generally requires external ingress/service mesh; BentoCloud canary controls were not captured in the fetched source set. | BentoCloud keeps all Deployment revisions; rollback is done in the Revisions tab by selecting a prior revision and clicking **Rollback**. Rolling back does not delete revisions and can roll forward/back to any available revision [10]. |

## 5. Feature-store integration overhead

The named feature-store baseline is **Feast**, developed by Gojek with Google Cloud and described in Gojek’s 2020-02-11 engineering article as a feature-management, storage, and serving layer [21]. Feast originally had separate historical and online APIs, later unified into a single **gRPC** layer to minimize training/serving client-code variation [21]. At serving time, “every incoming prediction request first triggers a feature value lookup from Feast,” then the features are fed into the model [21].

For this workload, assume a Feast online store backed by a low-latency online database such as **Redis** for velocity features, with offline data in a warehouse/lake for training; Gojek’s fraud rules service also used Redis ZSET/hash structures for velocity windows and idempotency in GoPay risk rules [22]. The universal overhead is therefore **one extra SDK/gRPC/network hop per prediction** unless stream processing pre-enriches the request. Razorpay’s Mitra lesson is directly relevant: it kept history in Flink/RocksDB in-memory state because going outside the application would hurt low latency, and used Async IO only for external Graph DB/community features [23].

| Platform | Feast integration mode | Extra hop and latency-budget implication |
|---|---|---|
| **Seldon + Triton** | Usually a Seldon transformer/preprocessor or custom Triton Python backend calls Feast before FIL/neural inference. | One pre-inference Feast gRPC/Redis hop; keep it outside Triton FIL hot path if possible, or pre-enrich with Flink/Kafka for sub-100-ms fraud decisions. |
| **Ray Serve** | SDK-level inside Python ingress or feature deployment. | One Python async Feast call can be composed with model deployments; easiest to parallelize/timeout, but governance is self-built. |
| **KServe** | Transformer/preprocessor, custom runtime, or upstream enrichment; plain InferenceService does not natively fetch Feast features. | One additional transformer/service hop plus Feast hop unless using a custom runtime; avoid chaining many InferenceServices for p99-sensitive paths. |
| **BentoML** | SDK-level inside the Bento service. | Simplest MVP integration; one Feast call inside request handler, with explicit timeouts/cache and Prometheus metrics. |

## 6. Monitoring and true drift detection

The sources distinguish **inference metrics** from **statistical data drift**. For payments fraud, monitor raw request data, feature-engineering latency, prediction latency, prediction score distributions, model version, and concept drift, matching Gojek’s 2024 risk-deployment guidance [24].

| Platform | Built-in inference/ops metrics | Drift-detection path |
|---|---|---|
| **Seldon Core 2 + Triton** | Seldon Core 2 docs emphasize operational and data-science monitoring, auditable prediction data, and Alibi integration [2]. Triton also exposes server/model metrics in production deployments. | Best native alignment: use **Alibi Detect** with Seldon/MLServer-style metrics and payload logging. Exact detector config was not captured, but Seldon is the strongest fit among the four for integrated drift/governance. |
| **KServe** | KServe supports observability with Prometheus/Grafana dashboards and InferenceService status; can use ModelMesh/payload logging where configured [7][6]. | Plain InferenceService metrics are not drift detection. Use payload logging plus **Alibi**, custom MLServer, or external drift systems. |
| **Ray Serve** | Ray Serve exposes operational/service metrics and performance tuning; docs say Ray Serve primarily focuses on serving and lacks broader lifecycle/performance visualization [12][25]. | Use Ray Serve metrics plus external Evidently/WhyLabs/Arize/Seldon Alibi-style drift tooling. Ray docs explicitly mention integrations with Seldon Alibi and Arize [12]. |
| **BentoML** | `/metrics` is enabled by default, Prometheus can scrape default counters/histograms, and Grafana can visualize p99 via `histogram_quantile(0.99, ...)` [11]. BentoML monitoring collects inference data and ships to local/cloud/OTLP destinations [26]. | BentoML docs mention early drift detection as a benefit, but true drift analysis requires shipping logged data to specialized tooling such as Arize via `bentoml-plugins-arize` or another external drift system [26]. |

## 7. Cost per million predictions: explicit sizing model

Because the fetched platform benchmarks are not apples-to-apples full fraud ensembles, the cost table below is a **sizing model**, not vendor-published TCO. It uses these explicit inputs:

- **Workload priced:** average 50,000,000 predictions/day = 578.7 rps, because cost per million should reflect sustained daily volume, while replica counts are sized to survive the 5,787-rps burst.
- **Compute price inputs:** CPU node **AWS c7i.4xlarge, Asia Pacific Mumbai, $0.714/hour**; GPU node **AWS g5.xlarge, Asia Pacific Mumbai, $1.208/hour**; EKS control plane **$0.10/hour**. These prices came from the public pricing sources identified during research, but the full pages were not fetched before source-cap exhaustion, so treat them as explicit cost assumptions rather than platform-published benchmark facts.
- **Feature-store read cost:** Redis/Feast online read allocated at **$0.02 per 1M predictions**.
- **Observability/logging cost:** **$0.03 per 1M predictions** for metrics, sampled payload logs, and trace/log storage.
- **Kubernetes/control-plane overhead:** **10% compute overhead** for DaemonSets, ingress, sidecars, and headroom, plus EKS control-plane allocation.
- **Utilization assumption:** capacity is provisioned to hold the 10× burst, then amortized over 50M/day average traffic; this intentionally penalizes platforms that need many replicas for burst readiness.

| Platform | Burst-sizing assumption | Hourly compute used in model | Cost per 1M predictions, USD | Approx INR @ ₹83/USD | Approx IDR @ Rp15,500/USD | Approx PHP @ ₱56/USD |
|---|---:|---:|---:|---:|---:|---:|
| **Seldon + Triton** | 1× g5.xlarge GPU for Triton ensemble + 2× c7i.4xlarge CPU nodes for Seldon/feature/transformers; Triton FIL tree branch has far more than 5,787-rps headroom in the cited 8×V100 benchmark [1]. | $1.208 + 2×$0.714 = **$2.636/hr**; +10% K8s = $2.900/hr; +$0.10/hr control plane | **$1.49/M** including $0.02 feature + $0.03 observability | ₹124/M | Rp23,095/M | ₱83/M |
| **Ray Serve** | 4 equivalent two-stage pipelines because 4×1,573 QPS = 6,292 QPS from the Anyscale two-stage DLRM figure [3]; model as 4× g5.xlarge + 2× CPU Ray head/ingress nodes. | 4×$1.208 + 2×$0.714 = **$6.260/hr**; +10% = $6.886/hr; +$0.10/hr | **$3.40/M** including feature + observability | ₹282/M | Rp52,700/M | ₱190/M |
| **KServe** | 12 serving replicas at ~500 QPS each, based on the KServe 500-QPS p95/p99 benchmark point, plus 2 CPU control/transformer nodes [6]. | 12×$0.714 + 2×$0.714 = **$9.996/hr**; +10% = $10.996/hr; +$0.10/hr | **$5.38/M** including feature + observability | ₹447/M | Rp83,390/M | ₱301/M |
| **BentoML/BentoCloud or self-hosted** | No sourced 5,787-rps benchmark; model as 6× c7i.4xlarge Python service replicas plus 1× g5.xlarge neural replica/pool and 1 CPU ingress/control node. | 7×$0.714 + $1.208 = **$6.206/hr**; +10% = $6.827/hr; +$0.10/hr | **$3.38/M** including feature + observability | ₹280/M | Rp52,390/M | ₱189/M |

The formula is: `((hourly compute × 24) / 50M × 1M) + $0.02 Feast + $0.03 observability`. For example, Seldon/Triton is `(($3.000/hr × 24) / 50 × 1) + $0.05 = $1.49/M`. If reserved instances, Savings Plans, spot, or country-local clusters are used, the ordering can change; the relative point is that Triton’s specialized runtime reduces the number of replicas needed for the same burst, while Python/Kubernetes abstractions may cost more unless their simplicity reduces engineering cost.

## 8. Company experience relevant to India, Indonesia, and the Philippines

### Razorpay / India: Mitra and Flink-state-first real-time ML

Razorpay’s published system is **Mitra**, described in “Data science at scale using Apache Flink”; the fetched page did not expose a publication date, so no date is asserted. The article states Razorpay processes **millions of transactions each day** and **billions of events** in a real-time streaming engine [23]. The stack is **Apache Flink** as the core engine, **Kafka** as data queue/control stream, **HDFS/S3** as raw data lake, **RocksDB** in-memory state, Graph DB, ML model server, and dynamic rule engine [23]. Model families include **XGBoost classification**, NLP address parsing, and micro-models [23]. Mitra’s stated latency target is to **predict results within 200 ms** in a distributed environment while generating hundreds of features on the fly and serving deployed ML models [23].

The main operational lesson for this comparison is that Razorpay separated **training** and **serving** clusters because training resource allocation and bulk feature network load caused serving requests to suffer or fail; it also kept feature history inside Flink state because going outside the application would hurt low latency, using Async IO only for external Graph DB/community features [23]. That supports a design where the serving platform is not asked to compute every fraud feature synchronously.

### Gojek/GoTo / Indonesia: FRS, Feast, proactive risk, and GoSage

Gojek’s GoPay context is Indonesia-scale payments: GoPay is described as Indonesia’s leading digital payments provider and **more than 50% of Gojek transactions** happen through GoPay [22]. The published **Fraud Rules Service (FRS)** is a Clojure, gRPC rule engine using Redis ZSET/hash structures for velocity rules, read/write segregation to reduce Redis operations, allow/deny lists, expiring historical windows, and generic JSON APIs for easier integration [22]. That publication does not give ML p95/p99 or throughput numbers [22].

Gojek’s **Feast** article, published **2020-02-11**, explains why a shared feature store was needed: online features were hard to productionize, transforms were being rewritten from Python into serving systems, and this created training-serving skew [21]. Feast gave teams centralized feature definitions, SDKs, online/historical retrieval, a unified gRPC layer, and a serving pattern where each prediction first looks up features from Feast [21].

Gojek’s “Proactive Risk Detection in Fintech,” published **2024-10-07**, states many risk use cases require **under 100 ms** predictions but that complex graph features can make this infeasible; it suggests an end-to-end target of around **2 seconds** is usually sufficient unless subsecond decisions are mandatory [24]. It also says production logs should include features used, event data, prediction score, model version, and event timestamp, and that teams should monitor concept drift, raw data, feature-engineering latency, and prediction latency [24]. Gojek’s **GoSage** article, published **2024-12-04**, describes a graph-neural-network fraud-collusion detector using PyTorch Geometric over customer/merchant nodes and transaction/shared-resource edges, but it does not publish latency or throughput figures [27].

### PayMongo / Philippines: product-level risk claims, no primary technical architecture

No primary PayMongo engineering publication describing fraud/risk infrastructure architecture, model-serving stack, p95/p99 latency, or throughput was found in the fetched sources. Verifiable company materials describe **PayMongo Protect** as a transaction-level fraud monitoring tool: every transaction is evaluated in real time by a machine-learning engine, assigned a **0–1000** risk score, and rules decide whether to allow, review, or block the transaction before completion [28]. Signals include behavioral patterns, velocity checks, anomaly detection, and device/identity signals [28]. Risk levels are **Low 0–499**, **Medium 500–799**, and **High 800–1000** [29][28]. PayMongo’s security page claims real-time ML analyzes thousands of signals, uses network analysis, device fingerprinting, and transaction pattern recognition, and reports **<0.1% fraud rate**, **<0.1% dispute rate**, and **98% transaction approval**, but it does not disclose architecture or serving benchmarks [30].

## 9. Engineering effort and maintenance trade-off

**Fastest initial fintech MVP: BentoML/BentoCloud.** It packages arbitrary Python, model loading, REST APIs, GPU declarations, metrics, and managed deployment revisions with the least platform scaffolding [8][10][11]. It is the right first choice if the startup needs a fraud API running quickly and can tolerate external A/B/drift/governance tooling.

**Best Python-native ensemble orchestration: Ray Serve.** It is strongest when the ensemble includes XGBoost/LightGBM, neural models, graph logic, feature calls, and business rules that data scientists and ML engineers want to express in Python [4][12]. The cost is that lifecycle governance, drift workflows, and regulated rollback evidence are more self-assembled; Ray’s own docs say Serve focuses on serving and lacks broader model-lifecycle/performance visualization [12].

**Most maintainable regulated multi-country Kubernetes platform: Seldon Core 2 + Triton, with KServe as the more neutral Kubernetes standard.** Seldon adds stronger data-science monitoring, Alibi alignment, auditable prediction data, and multi-model serving around Triton’s high-throughput runtime [2]. KServe is cleaner if the organization wants an open Kubernetes CRD standard and already has Knative/Istio/Gateway API operations, but the fetched benchmark shows that queueing and replica sizing can dominate p99 if serverless mode is pushed too hard [7][6].

**Most ML-platform engineering required: Seldon Core 2 + Triton or KServe + Triton/custom runtimes.** These options require Kubernetes operators, model repositories, storage credentials, GPU scheduling, feature transformers, observability pipelines, and release governance. They repay that effort when the business must run multiple model frameworks simultaneously with strict audit and rollback requirements.

**Fallback architecture:** If the preferred platform misses p99 or rollback SLOs, put the hot ensemble in **Triton** directly—FIL for XGBoost/LightGBM plus the selected neural backend—and use Seldon or KServe only for deployment control, traffic shifting, and observability. Precompute high-cost features in Flink/Kafka/RocksDB as Razorpay did [23], keep Feast/Redis lookups bounded and observable as Gojek’s Feast/FRS experience implies [22][21], and require nonzero warm replicas for every authorization-path model.

## 10. Final ranking for this startup

1. **Seldon Core 2 + Triton** — best production choice if p99, auditability, rollback, and multi-framework runtime efficiency dominate; strongest for the final regulated platform.
2. **Ray Serve** — best if the ensemble is rapidly evolving Python logic and model composition matters more than Kubernetes-native governance.
3. **KServe** — best if the company wants a standard Kubernetes InferenceService layer and can operate Knative/HPA carefully; avoid scale-to-zero for fraud authorization.
4. **BentoML/BentoCloud** — best for MVP speed and small-team productivity; production viability depends on external ingress, drift tooling, and load-tested replica sizing.

The deciding technical trade-off is simple: **Triton specializes in very high-throughput inference for heterogeneous model formats; Ray Serve and BentoML specialize in Python-native composition and fast iteration; KServe and Seldon specialize in Kubernetes-standard deployment and governance.** For payments fraud at 5,787-rps burst, specialized runtime headroom and rollback discipline matter more than framework elegance once the system is live.

## Sources

1. [Real-time Serving for XGBoost, Scikit-Learn RandomForest, LightGBM, and More | NVIDIA Technical Blog](https://developer.nvidia.com/blog/real-time-serving-for-xgboost-scikit-learn-randomforest-lightgbm-and-more/)
2. [Production-ready ML Serving Framework | Seldon Core 2](https://docs.seldon.ai/seldon-core-2)
3. [Major upgrades to Ray Serve: Online Inference with 88% lower latency and 11.1x higher throughput | Anyscale](https://www.anyscale.com/blog/ray-serve-inference-lower-latency-higher-throughput-haproxy)
4. [Key Concepts — Ray 2.55.1](https://docs.ray.io/en/latest/serve/key-concepts.html)
5. [Serve Config Files — Ray 2.55.1](https://docs.ray.io/en/latest/serve/production-guide/config.html)
6. [kserve/test/benchmark/README.md at master · kserve/kserve](https://github.com/kserve/kserve/blob/master/test/benchmark/README.md)
7. [Canary Rollout Strategy | KServe](https://kserve.github.io/website/latest/modelserving/v1beta1/rollout/canary/)
8. [Work with GPUs](https://docs.bentoml.com/en/latest/build-with-bentoml/gpu-inference.html)
9. [BentoML Documentation](https://docs.bentoml.com/en/latest/build-with-bentoml/adaptive-batching.html)
10. [Manage Deployments](https://docs.bentoml.com/en/latest/scale-with-bentocloud/deployment/manage-deployments.html)
11. [Metrics](https://docs.bentoml.com/en/latest/build-with-bentoml/observability/metrics.html)
12. [Ray Serve: Scalable and Programmable Serving — Ray 2.55.1](https://docs.ray.io/en/latest/serve/index.html)
13. [Triton Inference Server FIL Backend — NVIDIA Triton Inference Server](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/fil_backend/README.html)
14. [Model Support and Limitations — NVIDIA Triton Inference Server](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/fil_backend/docs/model_support.html)
15. [XGBoost | KServe](https://kserve.github.io/website/docs/model-serving/predictive-inference/frameworks/xgboost)
16. [TensorFlow | KServe](https://kserve.github.io/website/latest/modelserving/v1beta1/serving_runtime/)
17. [Fraud Detection With Categorical XGBoost — NVIDIA Triton Inference Server](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/fil_backend/notebooks/categorical-fraud-detection/README.html)
18. [Scalable online XGBoost inference with Ray Serve — Ray 2.55.1](https://docs.ray.io/en/latest/ray-overview/examples/e2e-xgboost/notebooks/03-Serving.html)
19. [Dynamic Request Batching — Ray 2.55.1](https://docs.ray.io/en/latest/serve/advanced-guides/dyn-req-batch.html)
20. [Scikit-learn | KServe](https://kserve.github.io/website/latest/modelserving/v1beta1/sklearn/v2/)
21. [Feast: Bridging ML Models and Data](https://medium.com/gojekengineering/feast-bridging-ml-models-and-data-efd06b7d1644)
22. [Protecting Indonesia’s Largest Digital Payments App](https://medium.com/gojekengineering/protecting-indonesias-largest-digital-payments-app-4adf005e16a4)
23. [Data science at scale using Apache Flink](https://razorpay.com/unfiltered/data-science-at-scale-using-apache-flink/)
24. [Part-I: Proactive Risk Detection in Fintech: From Data to Real-Time Model Deployment](https://medium.com/gojekengineering/part-i-proactive-risk-detection-in-fintech-from-data-to-real-time-model-deployment-7c8c76bfdf0c)
25. [Performance Tuning — Ray 2.55.1](https://docs.ray.io/en/latest/serve/advanced-guides/performance.html)
26. [Monitoring](https://docs.bentoml.com/en/latest/build-with-bentoml/observability/monitoring-and-data-collection.html)
27. [GoSage: How We Detect Fraud Syndicates at Gojek with Graph Neural Networks](https://medium.com/gojekengineering/gosage-how-we-detect-fraud-syndicates-at-gojek-with-graph-neural-networks-d4d0f4890de1)
28. [Key concepts](https://docs.paymongo.com/docs/security-analytics-protect-key-concepts)
29. [Scores](https://docs.paymongo.com/docs/security-analytics-protect-scores)
30. [PayMongo | Powerful Financial Tools for Fast-Growing Disruptors](https://www.paymongo.com/secure)