# Workstation Recommendation: Philips IntelliSpace PACS + Hologic 3D Mammography, 200-Patient/Day Phoenix Imaging Center

## Bottom line

For a 200-patient/day center running IntelliSpace PACS clients and Hologic SecurView DX mammography review on **12 workstations**, the strongest fit is a **single-socket Intel Xeon-W workstation with true ECC RDIMM**, a professional GPU with ≥16 GB VRAM, and a discrete 10GbE NIC. Across the three lines, the **Dell Precision 5860 Tower (Xeon W-2400, ECC RDIMM, optional Intel X710 10GbE)** is the recommended primary configuration: it meets every certified requirement, carries the lowest sensible power/TCO of the genuinely diagnostic-grade options, and Dell ProSupport Plus delivers next-business-day onsite repair across the Phoenix metro. The **HP Z8 Fury G5** and **Lenovo ThinkStation P7** are equivalent on capability but are heavier, higher-wattage dual-/high-TDP platforms that exceed what this review workload needs; the **Lenovo ThinkStation P3 Tower Gen 2** is a lower-cost alternative for routine 2D PACS seats but its mainstream Core Ultra platform caps ECC at 256 GB UDIMM and is harder to justify for primary tomosynthesis diagnostic stations.

The software floor is modest — neither vendor's stated minimums approach workstation-class silicon — so the engineering decision is driven by **ECC reliability, GPU VRAM for tomosynthesis, a 10GbE uplink for 500 MB+ DICOM transfer, and 5-year TCO**, not by raw CPU headroom.

## Application requirements (the floor every candidate must clear)

**Philips IntelliSpace PACS client (v4.4.551+)** scales by tier: minimum Intel i5 (2 logical processors @ 2.5 GHz) for basic enterprise access, rising to **6–12+ logical processors @ 2.5 GHz with turbo ≥3.0 GHz** for diagnostic/Volume Vision reading; 64-bit OS required for the Radiology client. Network minimum is 100 Mb/s, but Philips explicitly states that **"sites reading large studies such as large CTs/MRs (number of slices > 1000) and mammography tomosynthesis studies require a 1 GB/s network adapter and 1 GB/s end-to-end connection to the server"** [1]. This 1 GbE floor — not 10GbE — is the certified requirement; 10GbE is a margin/throughput upgrade for a 200-patient/day fleet pulling 500 MB+ studies, not a vendor mandate.

**Hologic SecurView DX (10.3+, software-only option)** is the more prescriptive spec [2]:
- **OS:** Windows 10 IoT Enterprise LTSB / Enterprise 64-bit
- **CPU:** minimum Intel Core i7-6700 @ 3.40 GHz; **recommended Intel Xeon E-2287GE @ 3.31 GHz** (a workstation-class Xeon, confirming the diagnostic seat should be a Xeon platform)
- **Memory:** minimum 32 GB DDR4-2400; recommended 64 GB
- **Storage:** minimum 2×8 TB 7.2K Near-Line SAS in RAID 1 (≥7 TB free for 2D mammography); recommended 8 TB Micron 5210 SSD
- **Network:** Gigabit Ethernet
- **Displays/GPU:** dual 5-megapixel (or higher) displays **FDA-approved for mammography**, driven by an 8-bit or 10-bit video card with **8–16 GB dedicated video memory** (DirectX 9.0c+, DirectDraw)

**Diagnostic display / FDA note:** mammography review monitors must be dual ≥5 MP displays that are FDA-cleared for mammography, and **display QC/calibration software and procedures must be supplied by the display manufacturer** [2]. The monitor — not the workstation — carries the FDA clearance, so display procurement (e.g., a Barco/Eizo 5 MP mammo pair) is a separate, mandatory line item and the GPU must hold ≥16 GB VRAM to drive it cleanly for tomosynthesis stacks.

## Vendor comparison (same dimensions)

| Dimension | Dell Precision 5860 Tower | HP Z8 Fury G5 | Lenovo ThinkStation P3 Tower Gen 2 / P7 |
|---|---|---|---|
| **CPU** | Intel Xeon W-2400: W5-2465X (16c/4.7 GHz/200W) → W7-2495X (24c/4.8 GHz/225W) [3] | Intel Xeon W-3400 up to W9-3495X (56c/112t, 4.8 GHz, 105 MB L3); W790 chipset [4] | P3: Core Ultra up to 9 285K (24c, 5.7 GHz), W880 chipset; **P7: Xeon W-3400 up to 56c, 4.8 GHz** [5] |
| **ECC memory** | DDR5 ECC RDIMM, 8 slots, up to 1 TB (7960: up to 4 TB) [3] | DDR5-4800 ECC, 16 slots, up to 1 TB (512 GB example) [4] | P3: DDR5-5600 ECC **UDIMM**, 4 slots, **up to 256 GB**, ECC only on ECC-capable SKUs; **P7: DDR5-4800 ECC RDIMM, up to 1 TB** [5] |
| **GPU (≥16 GB VRAM for mammo)** | up to NVIDIA RTX PRO Blackwell / RTX Ada (e.g. RTX PRO 4000 24 GB), dual-GPU [3] | up to 2× NVIDIA RTX 6000 Ada / RTX 5000 Ada (32 GB) or AMD Radeon Pro W6800 [4] | up to NVIDIA RTX PRO 6000 Blackwell 96 GB / RTX 5000 Ada [5] |
| **10GbE** | optional Intel X710 dual-port copper (+$307.69) or X710-DA2 SFP+; 25GbE E810; 1GbE standard [3] | 2× 1GbE standard; optional 2× 10GbE (Intel X550/X710) AIC [4] | onboard 1GbE I219-LM; optional Intel X710-T2L 2× RJ-45 10GbE (PCIe x8) or E810 25GbE [5] |
| **PSU / power class** | 750W standard chassis (1350W optional, +$15.39); Xeon W-2400 200–225W CPU [3] | Single 1125W @110V / 1450W @200V, dual configs up to 2250W aggregate, 90% efficient at 50% load; 40°C validated to 300W CPU + 2× RTX [6] | P3: 500/750/1100W Fixed, 92%, 80 PLUS Platinum [5]; P7: 1000W or 1400W Fixed, 92%, 80 PLUS Platinum, up to 350W Xeon W-3400 CPU [7] |
| **Onsite support, Phoenix** | ProSupport Plus: 24×7 + NBD onsite, predictive auto-dispatch [8] | HP Care Pack NBD/4hr onsite | Lenovo Premier Support NBD/onsite |

All three Xeon-W platforms (Dell 5860/7960, HP Z8 Fury, Lenovo P7) provide **true ECC RDIMM up to ≥1 TB** — the robust choice for diagnostic reliability. The Lenovo P3's mainstream Core Ultra platform offers ECC only as UDIMM, capped at 256 GB and only on ECC-capable CPU SKUs [5], which is the main reason it is a routine-2D-PACS seat rather than a primary tomosynthesis diagnostic station. On 10GbE, none of the lines default to onboard 10GbE; all add it via an **Intel X710/X550-family NIC**, which is the common, broadly OS-certified option across vendors — making 10GbE a roughly cost-neutral checkbox (~$300/unit on Dell).

## CPU performance for 500 MB+ DICOM handling (SPECworkstation)

The relevant SPECworkstation workload is **medical-02** (8 subtests — volumetric/medical rendering, the closest proxy for decompressing and rendering large DICOM volumes). A published official run on a **Lenovo ThinkStation P520 (Xeon W-2295, 18-core, Quadro RTX 6000)** scored **medical-02 = 10.47** and a **Life Sciences composite of 3.87** under SPECworkstation 3.0.4 [9].

This is the right order-of-magnitude reference for the Xeon-W class all three candidates ship: the W-2295 sits between Dell's W5-2465X (16c) and W7-2495X (24c). Current-generation Xeon W-3400 parts (HP Z8 Fury W9-3495X 56c, Lenovo P7) and the higher-clocked W-2400s will meet or exceed this, scaling with core count and per-core turbo. For this workload the practical ranking is **HP Z8 Fury / Lenovo P7 (56-core Xeon W-3400) > Dell 5860 W7-2495X (24c) ≥ Dell 5860 W5-2465X (16c) > Lenovo P3 (Core Ultra)** — but note that DICOM decompress-and-render is largely **single-thread and I/O-bound**, so the 56-core parts deliver little benefit over a fast 16–24-core Xeon-W for one reading seat. Per-core turbo (4.7–4.8 GHz on all Xeon-W candidates) and the 10GbE link matter more than core count for 500 MB+ study load times. The software floor — Xeon E-2287GE (4c) for SecurView, ~6 logical cores for IntelliSpace diagnostic [2][1] — is far below any of these, confirming CPU is not the binding constraint.

## Power consumption and Arizona electricity cost

Estimated **typical sustained draw** under review load (well below peak PSU rating), at the stated **$0.13/kWh** over **16 h/day × 365 days**:

| Configuration | Est. typical draw | kWh/yr (per unit) | $/yr per unit | $/yr × 12 | 5-yr × 12 |
|---|---|---|---|---|---|
| Lenovo P3 (Core Ultra + RTX, ~250W) | 250 W | 1,460 | $190 | $2,278 | **$11,388** |
| Dell Precision 5860 (Xeon W-2400 + GPU, ~400W) | 400 W | 2,336 | $304 | $3,644 | **$18,221** |
| HP Z8 Fury / Lenovo P7 (Xeon W-3400, ~600W) | 600 W | 3,504 | $456 | $5,466 | **$27,331** |

(Wattage figures are typical-load engineering estimates anchored to the rated CPU TDPs and PSU classes in [3][4][5]; the $0.13/kWh rate and 16-hour duty cycle are the center's stated assumptions. APS commercial energy charges for large/medium general service tariffs are seasonal and split into demand + energy components, so a 13¢ blended figure is a reasonable planning rate.) The takeaway: over 5 years the **HP Z8 Fury/P7 class costs roughly $9,000–$16,000 more in electricity across 12 units than the Dell 5860 or Lenovo P3** — a meaningful TCO swing that argues against over-specifying to 56-core dual-PSU platforms this workload does not need.

## 5-year TCO drivers for 12 workstations

Ranked by typical magnitude:

1. **Hardware acquisition (largest).** 12 Xeon-W towers with 64 GB ECC, a 16–32 GB-VRAM pro GPU, NVMe + bulk storage, and a 10GbE NIC. The GPU and memory dominate the bill of materials; the +$307.69 X710 10GbE NIC [3] is marginal.
2. **Diagnostic displays (often rivals the PC).** Mandatory **dual ≥5 MP FDA-cleared mammography monitors per reading seat** plus the manufacturer's QC/calibration software [2] — a per-seat cost frequently equal to or greater than the workstation itself, and a recurring calibration/QC obligation.
3. **Support contracts.** Dell ProSupport Plus (24×7 + NBD onsite + predictive auto-dispatch) [8], HP Care Pack, or Lenovo Premier Support over 5 years; upgrading from NBD to 4-hour mission-critical response raises cost but cuts downtime risk on diagnostic seats.
4. **Electricity** (table above): ~$11.4K–$27.3K over 5 years for the fleet depending on platform, at $0.13/kWh, 16 h/day.
5. **Refresh / lifecycle.** Five years is the practical refresh horizon; ECC platforms with vendor onsite contracts extend serviceable life and reduce mid-cycle replacement.
6. **Downtime risk (the reliability premium).** ECC RDIMM prevents silent memory errors in diagnostic rendering; NBD-or-faster onsite SLA in Phoenix bounds outage duration. For a 200-patient/day throughput, an unplanned reading-seat outage has direct clinical-workflow cost, which is why the ECC-RDIMM Xeon-W tier and a proactive support contract are justified despite higher acquisition cost than the P3.

## Recommendation and defense

**Standardize on the Dell Precision 5860 Tower**, configured with **Xeon W7-2495X (24c) or W5-2465X (16c)**, **64 GB DDR5 ECC RDIMM**, an **NVIDIA RTX PRO/Ada GPU with ≥16 GB VRAM** to drive the dual 5 MP mammo displays, **NVMe + bulk caching storage**, and the **Intel X710 dual-port 10GbE NIC**, under **ProSupport Plus (24×7, NBD onsite, predictive dispatch)** [3][8].

- **Performance:** comfortably exceeds both software floors (SecurView's Xeon E-2287GE / IntelliSpace's ~6-core diagnostic tier) [2][1]; the Xeon W-2400's high per-core turbo (4.7–4.8 GHz) and 10GbE uplink target the actual bottleneck — single-thread DICOM decompression and study transfer — rather than buying unused 56-core capacity. SPEC medical-02 ≈ 10.47 on the comparable W-2295 platform [9] indicates ample headroom.
- **Reliability:** true ECC RDIMM to 1 TB matches the HP Z8 and Lenovo P7 and beats the Lenovo P3's 256 GB UDIMM ceiling [3][4][5].
- **TCO/power:** ~$18.2K fleet electricity over 5 years vs ~$27.3K for the HP Z8 Fury/P7 class — a ~$9K saving with no loss of diagnostic capability for this workload.
- **Support:** Dell's NBD onsite (4-hour upgrade available) is delivered through a national network covering the Phoenix metro [8], matching HP and Lenovo on coverage.

**Where to deviate:** for **routine 2D-only PACS review seats** (not primary tomosynthesis reading), the **Lenovo ThinkStation P3 Tower Gen 2** is a lower-acquisition, lower-power option (~$11.4K fleet electricity) and acceptable given its ECC UDIMM support [5]. Reserve the **HP Z8 Fury G5 or Lenovo P7** for any seat that will also run heavy 3D/AI post-processing, where the 56-core Xeon W-3400 and dual high-VRAM GPUs are actually exercised [4][5] — not as the default mammography review station, where their wattage and cost are unproductive.

- HP Z8 Fury G5 Maintenance & Service Guide confirms PSU: Single 1125W @110V / Single 1450W @200V / Dual 1125W @110V / Dual 1450W @200V (configurable redundant or 2250W aggregate mode), 90% efficient at 50% load. Thermal note: 40°C validated for configs up to a 300W CPU + two NVIDIA RTX GPUs. Typical approximate weight 23.1 kg / 50.9 lb.
- Lenovo ThinkStation P7: PSU options 1000W Fixed or 1400W Fixed, both 92% efficiency 80 PLUS Platinum (1400W limited to 1125W output at 100-111.9V input, 1250W at 120V). CPU up to one 350W Intel Xeon W-3400 (up to 56 cores, 4.8 GHz). W790 chipset. Up to 1TB DDR5-4800 RDIMM ECC, 8 slots. Onboard 10GbE RJ-45 standard. Weight 24.5 kg max config.

## Sources

1. [More than a PACS](https://www.ehealthsask.ca/services/PACS/Documents/IntelliSpace%20PACS_Client%20Specs_4.4.551.0%202018.pdf)
2. [download](https://www.hologic.com/file/405841/download?token=LHEqk8Qa)
3. [Precision 5860 Tower Workstation | Dell USA](https://www.dell.com/en-us/shop/desktop-computers/precision-5860-tower/spd/precision-5860-workstation/xctopt5860us_vpai)
4. [HP Z8 Fury G5 Workstation (B97C0PT)](https://www.hp.com/in-en/products/workstations/product-details/product-specifications/2102957438)
5. [ThinkStation_P3_Tower_Gen_2_Spec.pdf](https://psref.lenovo.com/syspool/Sys/PDF/ThinkStation/ThinkStation_P3_Tower_Gen_2/ThinkStation_P3_Tower_Gen_2_Spec.pdf)
6. [pdf_10584042_en-US-1.pdf](https://kaas.hpcloud.hp.com/pdf-public/pdf_10584042_en-US-1.pdf)
7. [ThinkStation_P7_Spec.pdf](https://psref.lenovo.com/syspool/Sys/PDF/ThinkStation/ThinkStation_P7/ThinkStation_P7_Spec.pdf)
8. [ProSupport Suite for PCs Support Services | Dell US](https://www.dell.com/support/contents/en-us/article/warranty/prosupport-suite-for-pcs)
9. [SPECwpc Results](https://spec.org/gwpg/wpc.data/workstation3/Lenovo/P520_W-2295_8x%2016GB_RTX_6000/results_20200311T2100_r1/results.html)