# Edge Computing in Industrial IoT (2024): Three Use Cases Compared

## Bottom line

As of 2024, edge computing is shifting industrial IoT from a "sense-and-haul-to-cloud" model to a tiered architecture (constrained edge → edge cloud → central cloud) in which time-critical inference and control run next to the machine, and the cloud retains training, fleet orchestration, and long-term storage [1][2]. The strongest, hardest-measured edge case is **autonomous mobile robots**, where safety control must close inside single-digit milliseconds (≈6.3 ms latency bound on a 7 ms control cycle, ~1 ms over-the-air on 5G) and video is cut from ~150 Mbps to 20–50 Mbps — a ~67–87% bandwidth reduction — by processing/reducing at the edge [3]. **Energy distribution** is the most latency-stringent in absolute terms (IEC 61850 GOOSE protection messaging in microseconds on a substation LAN, with a few-ms ceiling over wide-area utility networks), and edge intelligence devices deliver faster fault detection/isolation/restoration than centralized SCADA [4][5]. **Manufacturing predictive maintenance** justifies edge mainly through bandwidth and availability rather than microsecond control: on-edge analytics filter high-rate vibration/telemetry locally and forward only results, raising line availability [6][7].

Ranked by the largest *measured* impact in these sources: AMRs (latency + bandwidth, both quantified) > energy distribution (latency, qualitatively faster, with a hard sub-cycle protection ceiling) > predictive maintenance (availability/maintainability, largely qualitative in vendor references).

| Dimension | Predictive maintenance | Autonomous mobile robots | Energy distribution |
|---|---|---|---|
| Latency target | Near-real-time anomaly detection at the cell; not microsecond-bound | ≤6.3 ms control-loop bound on 7 ms cycle; ~1 ms 5G over-the-air [3] | Microseconds on substation LAN (GOOSE/SV); few-ms ceiling wide-area; sub-cycle protection [4] |
| Bandwidth reduction | Forward results not raw streams to cloud (Schuler→Schuler Cloud) [6] | ~67–87% (camera 150 Mbps → 20–50 Mbps) [3] | Forward FDIR results/events, not continuous high-rate sampling [5] |
| Availability/SLA | "Higher availability," targeted maintenance, less unplanned downtime [6][7] | Robot halts on missed deadline → edge guarantees continuity vs cloud round-trip risk [3] | Faster response to grid events than centralized/substation solutions; peer redundancy among ECDs [5] |
| Named platform/example | Siemens Industrial Edge (Schuler, Goglio); PTC ThingWorx + HPE Edgeline (HIROTEC) [6][7] | NVIDIA Isaac Perceptor/Jetson + Kudan SLAM (NexAIoT NexMOV-2); 5G+TSN edge controller [3] | Edge computing devices (ECDs: HPE EL10, Raspberry Pi 4) running containerized FDIR [5] |
| Compute hardware | SIMATIC IPC227E / IPC 427; HPE Edgeline EL20, ProLiant ML110 [6][7] | NVIDIA Jetson (CUDA-accelerated Isaac libraries) [1] | EL10 + Raspberry Pi 4 ECDs, K3s orchestration [5] |

## Reference architecture: edge / fog / cloud tiers

The ETSI Multi-access Edge Computing (MEC) reference model for IoT (ETSI White Paper #59, *Enabling Multi-access Edge Computing in IoT*, June 2023) describes a computing layer split into distinct tiers: a **central cloud**, an **edge cloud** (e.g., Telco Edge), and a wireless/mobile **Far Edge** of constrained devices — UEs, CPEs and edge IoT devices that may be battery-powered, mobile and volatile with limited compute and connectivity [2]. ETSI MEC is integrated with the oneM2M IoT platform; in the most common deployment (Option A) oneM2M acts as the cloud and MEC as the edge, and the paper notes the edge is not fully exploited while the cloud remains the final processing point [2]. The complementary **OpenFog Reference Architecture** (release 1.0, 8 Feb 2017, OpenFog Consortium, since merged into the Industrial Internet Consortium) is a horizontal, system-level architecture distributing compute, storage, control and networking across the cloud-to-thing continuum, organized around core "pillars" including Security, and targeted at IoT applications needing real-time decisions, low latency, improved security and operation under network constraints — across transportation, energy, smart buildings, healthcare and more [8].

The determining factors that push compute to the edge across all three cases are consistent: **latency-critical** control/protection loops, **bandwidth-heavy** sensor streams (vibration, video, sampled values), and **intermittent or constrained connectivity** where a cloud round-trip is unsafe or uneconomic [8][2][3].

## 1) Manufacturing predictive maintenance

**Before (cloud-centric):** Sensors → PLC/gateway → continuous telemetry shipped to cloud/historian for analytics. This concentrates data-volume and storage cost centrally; the Greenko renewable-energy analogue shows the failure mode — moving telemetry from every 30 s to every 10 s per asset would triple ingested volume and stress infrastructure, with a dashboard latency of 1 minute, and historian storage cost rising annually with fleet size [9].

**After (edge-distributed):** Analytics run on an industrial PC at the line/cell, with only results (and exceptions) forwarded upstream. At Siemens' Schuler Pressen press shop, Industrial Edge apps run on a **SIMATIC IPC227E**, collect press data locally and forward results to the Schuler Cloud and Siemens network, integrating into existing installations [6]. Goglio S.p.A. uses **Industrial Edge Management as a Service**, an **IPC 427 Edge** device and **SINAMICS S120 with TRCDATA** to predict and prevent failures on continuous-cycle packaging lines by combining machine knowledge with ML/AI [6]. HIROTEC (a $1.6B automotive parts supplier) paired the **PTC ThingWorx** IoT platform with **HPE Edgeline EL20** gateways (plus ProLiant ML110 Gen9 and StoreEasy NAS) on the factory floor to attack unplanned downtime with predictive analytics [7].

**Quantified impacts:** A controlled edge-cloud benchmark for IoT machinery vibration monitoring (Verma et al., *Manufacturing Letters* 27, Jan 2021, pp. 39–41; DOI 10.1016/j.mfglet.2020.12.004) puts numbers on the latency trade-off: a triaxial MEMS accelerometer (ADXL-345) sampled at **1600 Hz** on a Raspberry Pi 3 generated **~350 KB of data per 10 s** sampling interval, and **end-to-end latency for time-domain feature computation was lower on the edge than in the cloud**, with the trend reversing for the heavier FFT workload (the cloud becomes favorable as on-edge computation time grows) — i.e., whether edge wins is algorithm-dependent, not universal [10]. The vendor references corroborate the direction in *availability* — "improved transparency, higher availability, and targeted maintenance" [6] and reduced unplanned downtime [7]; the Siemens and PTC/HPE references are qualitative on exact latency-ms and data-reduction-% figures. Latency here is near-real-time anomaly detection at the cell rather than a microsecond control bound. Bandwidth reduction comes structurally from forwarding analytic results instead of raw high-rate streams [6].

## 2) Autonomous mobile robots (AMR)

**Before (cloud-centric):** Cloud fleet orchestration with perception, SLAM and path planning executed remotely — viable only if the network meets a hard real-time bound, because the robot trips a safety halt on a missed deadline.

**After (edge-distributed):** Perception, SLAM and navigation run on-board or on an edge server. NexAIoT's **NexMOV-2** AMR was deployed into live factory operations equipped with **Kudan Visual SLAM** and **NVIDIA Isaac Perceptor** (CUDA-accelerated libraries and AI models running on **NVIDIA Jetson**), achieving adaptive navigation with reduced deployment time and cost (Sept 2024) [1]. Where control remains in a "factory cloud" edge server, 5G+TSN is the enabling fabric.

**Quantified impacts (Kehl et al., *Electronics* 2022, 11, 1666; DOI 10.3390/electronics11111666):**
- **Latency:** control commands are sent every **7 ms** cycle (32–80-byte packets); the PLC requires arrival within a **6.3 ms** bound (90% of the cycle) or the robot halts on a safety error; **over-the-air 5G latency stays ~1 ms** for 1042-byte packets [3].
- **Bandwidth:** the camera stream is reduced from ~**150 Mbps to 20–50 Mbps** (lowering resolution while preserving object-detection accuracy) — a **~67–87% reduction** [3].
- **Availability/SLA:** the deterministic deadline *is* the SLA — missing it stops the robot, so edge/near-edge processing is what makes the safety guarantee feasible [3].

## 3) Energy distribution

**Before (cloud-centric):** Centralized SCADA/DMS and historians poll field devices; protection and control logic sits at the substation or control center, and wide-area latency limits how fast and granular grid-edge functions can be.

**After (edge-distributed):** Edge computing devices (ECDs) sit at the grid edge between substation and customer, connected to pole-top reclosers, switches, meters and line sensors, and communicate peer-to-peer for redundancy [5]. A demonstrated **Fault Detection, Isolation and Restoration (FDIR)** application runs as containers (Docker/Kubernetes/K3s) across ECDs built from **HPE EL10 and Raspberry Pi 4** hardware [5]. The architecture envisions *hierarchical grid intelligence*: ECDs give distributed fast response to time-critical events, with the substation layer as a sanity-check tier [5].

**Quantified impacts:**
- **Latency:** the binding standard is **IEC 61850** GOOSE/Sampled-Values messaging — on a substation LAN at 100 Mbit/s, latencies are a **few dozen microseconds**; over wide-area dedicated utility networks the practical **upper limit is a few dozen ms** [4]. Protection messaging operates sub-cycle (the IEC 61850 fast-message transfer-time target is ≤3 ms). The IEEE study concludes edge computing gives **faster response to grid events than centralized or substation-based solutions** [5].
- **Bandwidth:** edge ECDs forward FDIR results and events rather than continuous high-rate field sampling; **5G + IEC 61850** enable real-time field-level sampling for advanced protection/automation/control without saturating central links [5].
- **Availability/SLA:** distributed ECDs with peer communication provide communication and application redundancy and faster fault isolation/restoration [5].

## Enabling layer: 5G private networks and TSN (2024)

Deterministic latency for edge IoT increasingly depends on converged **5G + Time-Sensitive Networking (TSN, IEEE 802.1)**. The AMR prototype shows the pattern in practice: TSN carries scheduled real-time control traffic while 5G provides ~1 ms over-the-air mobility, together meeting the 6.3 ms control deadline [3]. In energy, 5G alongside IEC 61850 is identified as the shift enabling real-time field sampling and advanced grid-edge functions [5].

## Edge platforms and 2024 capabilities

- **AWS IoT Greengrass Core v2.14.0** (16 Dec 2024) added **nucleus lite**, a lightweight open-source runtime with a reduced memory footprint for resource-constrained devices (single-board computers, smart energy meters, hubs); it implements a subset of nucleus functionality and does not yet support managed container artifacts or PKCS11-stored keys, while the v2.14.0 classic nucleus added dual-stack IPv6 endpoints and resilience/memory-leak fixes [11].
- **Siemens Industrial Edge** — Industrial Edge Management (incl. as-a-Service), SIMATIC IPC227E / IPC 427 edge devices for line-level apps [6].
- **NVIDIA Jetson + Isaac** — CUDA-accelerated Isaac Perceptor perception/AI for AMRs [1].
- **PTC ThingWorx + HPE Edgeline** — industrial IoT analytics on rugged on-floor gateways [7].
- **Grid ECDs** — HPE EL10 and Raspberry Pi 4 nodes running containerized apps under K3s [5].

## Cost, security, maintainability trade-offs

**Cost.** Edge adds capital/hardware per node (IPCs, gateways, Jetson modules, ECDs) but offsets cloud egress, ingest and storage growth. The clearest evidence is the cloud-side cost pressure edge relieves: Greenko's historian storage cost rose annually with fleet size and a 3× telemetry increase threatened on-prem capacity [9]; edge filtering (forward results, not raw streams) directly attacks that growth [6]. AMRs cut a 150 Mbps→20–50 Mbps stream, reducing transport cost while requiring on-robot compute [3]; the NexMOV-2 deployment reports *reduced* deployment time and cost from edge AI [1]. Grid ECDs use low-cost commodity hardware (Raspberry Pi 4) for distributed intelligence [5].

**Security.** Edge **expands the physical attack surface** (many field-deployed, sometimes unattended nodes) while **reducing data-in-transit exposure** by keeping sensitive streams local. Security is a named core pillar of the OpenFog architecture [8]. The 2024 Greengrass note makes the field-device tension concrete: nucleus lite lacks PKCS11 secure-element key storage, so AWS advises full-disk encryption on production devices to prevent credential leaks [11]. Industrial control deployments in all three domains are governed by **IEC 62443** (industrial automation and control system security) and **NIST SP 800-82** (ICS/OT security guidance); these frameworks apply most acutely to grid and factory-floor edge nodes that now host containerized logic [5].

**Maintainability.** The cloud-centric model centralizes ops; the edge model multiplies them across a distributed fleet, making **OTA updates, device management and observability** the dominant burden. The energy case is illustrative: FDIR runs as containers under K3s precisely to make start/stop, version updates, scaling and targeted per-device deployment manageable across many ECDs [5]. The Greengrass nucleus-lite/classic split shows vendors engineering for fleet maintainability — a smaller runtime for constrained nodes mixed with full nucleus devices in one fleet [11].

**How the balance differs by industry:**
- **Predictive maintenance** — moderate latency need; edge wins mainly on bandwidth/availability and cost; physical-security and fleet-management burden is contained inside the (relatively controlled) factory; trade-off is favorable and incremental [6][7].
- **AMRs** — latency is the hard constraint and edge is non-negotiable for safety; cost and maintainability burden shifts onto the mobile fleet (on-robot compute, OTA), and 5G/TSN is required infrastructure [3][1].
- **Energy distribution** — strictest latency ceiling and the widest, most exposed physical footprint (pole-top, field-deployed ECDs), so the security and distributed-maintenance burden is highest and IEC 62443/NIST 800-82 hardening plus container orchestration are essential to make the latency/availability gains safe to operate [5][4].

## Verification of vendor case studies

- **NexAIoT NexMOV-2 + NVIDIA Isaac/Jetson + Kudan SLAM** — real, dated **September 2024**; reports reduced AMR deployment time/cost via on-edge AI navigation (no published ms/% figure in the announcement) [1].
- **AWS IoT Greengrass v2.14.0** — real, dated **16 December 2024**; nucleus lite for constrained devices [11].
- **Siemens Industrial Edge — Schuler Pressen / Goglio** — real Siemens references; report higher availability and targeted predictive maintenance (qualitative on exact %/ms) [6].
- **HIROTEC + PTC ThingWorx + HPE Edgeline** — real HPE/PTC case; reports reduced unplanned downtime via edge predictive analytics [7].
- **5G+TSN edge-controlled robotics** — Kehl et al., *Electronics* 2022, 11, 1666 (DOI 10.3390/electronics11111666); the quantified ~1 ms 5G, 6.3 ms control bound and 150→20–50 Mbps figures are from this peer-reviewed source [3].
- **IEEE Power & Energy Magazine, Sept/Oct 2023 "Hierarchical Grid Intelligence"** — real; edge ECDs give faster grid-event response than centralized/substation solutions [5].
- **Greenko (AWS IoT)** — real, dated **Jan 2022**; used here as the cloud-centric baseline (1-minute dashboard latency, 3× data-volume pressure, rising historian cost), not as a 2023–2024 edge case [9].

## Sources

1. [Kudan, NexAIoT, and NVIDIA Collaborate to Deploy AI-Powered AMR in Operational Factories in Taiwan | Kudan Inc.｜Spatial Perception Technology Driving the Advancement of Physical AI](https://www.kudan.io/kudan-nexaiot-and-nvidia-collaborate-to-deploy-ai-powered-amr-in-operational-factories/)
2. [Industrial Edge as a Technological Accelerator for Goglio’s IT Offering](https://references.siemens.com/en/reference/gogliospa?id=42753)
3. [Prototype of 5G Integrated with TSN for Edge-Controlled Mobile Robotics](https://publications.rwth-aachen.de/record/848246/files/848246.pdf)
4. [Latency Measurements in Digital grids](https://www.pacw.org/latency-measurements-in-digital-grids)
5. [PES-Sept-Oct-2023-open-article.pdf](https://ieee-pes.org/wp-content/uploads/2023/09/PES-Sept-Oct-2023-open-article.pdf)
6. [Schuler Pressen smart factory | Siemens](https://www.siemens.com/en-us/company/insights/schuler-pressen-industrial-edge-smart-factory/)
7. [a00003335enw.pdf](https://ingrammicroegypt.com/wp-content/uploads/2022/11/a00003335enw.pdf)
8. [ETSI-WP59-Enabling-Multi-access-Edge-Computing-in-iot.pdf](https://www.etsi.org/images/files/ETSIWhitePapers/ETSI-WP59-Enabling-Multi-access-Edge-Computing-in-iot.pdf)
9. [How Greenko uses AWS IoT and serverless for wind monitoring | Amazon Web Services](https://aws.amazon.com/blogs/industries/how-greenko-uses-aws-iot-and-serverless-solutions-for-wind-monitoring/)
10. [Edge-cloud computing performance benchmarking for IoT based machinery vibration monitoring](https://www.sciencedirect.com/science/article/abs/pii/S2213846320301759)
11. [Release: AWS IoT Greengrass Core v2.14.0 software update on December 16, 2024 - AWS IoT Greengrass](https://docs.aws.amazon.com/greengrass/v2/developerguide/greengrass-release-2024-12-16.html)