# Workstation recommendation for Phoenix PACS / 3D mammography deployment

**Bottom line:** Standardize the 12 primary diagnostic/mammography workstations on a mid/high tower class — **Dell Precision 5860 Tower or HP Z4 G5**, with **Lenovo ThinkStation P5 Gen 2** as the third comparable bid — configured with **64GB ECC minimum, 128GB ECC for heavy DBT/large CT users, professional RTX-class graphics, NVMe cache, 10GbE, and 5-year next-business-day onsite service with defective-media/keep-your-drive retention**. Entry towers — Dell Precision 3680, HP Z2 Tower G9, Lenovo ThinkStation P3 — have strong CPU benchmark results and can serve lighter PACS/admin seats, but for a 200-patient/day center handling 500MB+ studies they add integration risk through add-in 10GbE dependency and, for some Core/W680 options, tighter memory ceilings. Electricity is a secondary TCO driver: at **$0.13/kWh**, 12 workstations running **16 hours/day** cost **$6,832.80–$27,331.20 over five years** across representative **150–600W** average draw scenarios.

| Recommended role | Best-fit models | Why this tier wins | Configuration target |
|---|---|---|---|
| Primary diagnostic / 3D mammography readers | **Dell Precision 5860 Tower; HP Z4 G5; Lenovo ThinkStation P5 Gen 2** | ECC memory, Xeon/workstation-class platform, stronger expansion, easier 10GbE integration, enterprise onsite support | 64GB ECC minimum; 128GB ECC for heavy DBT/large CT; professional RTX/Radeon Pro GPU; 2TB+ NVMe OS/cache; 10GbE; 5-year NBD onsite + defective-media retention/keep-drive |
| Lighter PACS, QA, admin, non-heaviest viewing | Dell Precision 3680; HP Z2 Tower G9; Lenovo ThinkStation P3 Tower Gen 2 | Lower cost and high SPECworkstation CPU scores, but 10GbE usually depends on PCIe option and memory ceilings are tighter | 64GB ECC where supported; PCIe 10GbE NIC; NVMe cache; enterprise NBD support |
| Overkill / specialty reconstruction or research | Lenovo ThinkStation P8 / Dell higher Threadripper Pro or Xeon W9 tiers | Much higher Life Sciences/Productivity scores, but higher acquisition/power/cooling cost than routine PACS viewing requires | Reserve only for advanced post-processing or AI/reconstruction workloads |

## Application-driven requirements

Philips IntelliSpace Radiology 4.7 sets the floor well below what a busy mammography/PACS site should actually buy. For Advanced Mammography/tomosynthesis, Philips specifies **Intel 12 logical processors at 2.5GHz or higher**, **24GB+ RAM**, a **high-end OpenGL 3.2 GPU with 2GB onboard memory**, and diagnostic displays including **two 5MP 510(k)-cleared mammography displays**. Philips also distinguishes ordinary network use from large imaging workloads: while the general minimum is lower, **large CT/MR studies over 1,000 slices and mammography tomosynthesis require a 1Gb/s network adapter and 1Gb/s end-to-end server connection**, with local-cache disk sizing dependent on the exams cached [1].

Hologic SecurView DX 12.0+ software-only workstations set a more modern mammography baseline: **Windows 10 IoT Enterprise LTSB/LTSC or Windows 10 Enterprise 64-bit**, **Intel Core i7-6700 3.40GHz minimum**, **Intel Xeon E-2287GE @ 3.31GHz or better recommended**, **32GB RAM minimum / 64GB recommended**, **2×8TB enterprise RAID1 HDD at 200MB/s and 7TB single partition for 2D minimum**, **8TB SSD at 400MB/s recommended**, **Gigabit Ethernet**, and **at least six USB ports**; Hologic directs DBT/multimodality storage sizing to technical sales [2].

For this Phoenix center, those vendor minima should be treated as validation floors, not purchasing targets. The practical target is **10GbE to PACS/VNA**, not merely 1GbE/Gigabit, because 500MB+ DICOM studies, DBT, and 200-patient/day concurrency make network wait time and local-cache refill time more important than the application minimums alone.

## Hardware comparison: current Dell Precision, HP Z, and Lenovo ThinkStation towers

| Model | CPU / platform ceiling | ECC memory support | 10GbE compatibility | Power supply class | Assessment for PACS / 3D mammography |
|---|---:|---|---|---|---|
| **Dell Precision 3680 Tower** | Up to **Core i9-14900K**, 24 cores / 32 threads, 125W | Up to **128GB DDR5 ECC or non-ECC**, up to 4400MT/s | Native **1GbE**, optional **2.5GbE**; 10GbE via PCIe NIC | **300W / 500W / 1000W Platinum** | Strong CPU, good lower-cost seat, but less clean than 5860 where 10GbE and expansion are mandatory [3] |
| **Dell Precision 5860 Tower** | Up to **Xeon W7-2595X / W7-2495X class** | ECC and Dell RMT Pro options | Onboard **1GbE + 10GbE**; additional Intel Ethernet adapters available | **750W Platinum**, optional **1350W Platinum** | Best Dell fit for standardized diagnostic fleet: native 10GbE, ECC, expansion, support tier [4] |
| **HP Z2 Tower G9** | Up to **Core i9-14900K class** on Intel W680 | **4 DIMMs; up to 128GB ECC** or **192GB non-ECC** DDR5 | Integrated GbE plus **Intel X550-T2 dual-port 10GbE NIC** option | **350W / 450W / 500W / 700W**, 90–92% efficiency | Strong lower-cost HP option; acceptable if 128GB ECC ceiling and NIC option meet workflow needs [5] |
| **HP Z4 G5** | **Xeon W-2400 / W-3400 class** | 8 DIMM slots, DDR5 ECC Registered DIMM platform, up to 512GB in HP QuickSpecs configurations | Optional high-speed NICs including **Intel X550-T2 10GbE** | **525W / 775W / 1125W**, 90% efficient | Best HP fit for primary seats: workstation-class ECC, expansion, GPU and network headroom [6] |
| **Lenovo ThinkStation P3 Tower Gen 2** | Core Ultra/Core workstation tier; supports up to one NVIDIA RTX PRO 6000 Blackwell-class GPU in Lenovo PSREF | Up to **256GB** memory; DDR5-5600 UDIMM **ECC or non-ECC** and ECC protection on models with ECC DIMMs and ECC-capable processor | Onboard class generally below 10GbE; 10GbE through PCIe NIC path | **500W / 750W / 1100W**, 92%, 80 PLUS Platinum | Viable lighter-seat bid if configured with ECC and add-in 10GbE; less ideal for one-size diagnostic fleet [7] |
| **Lenovo ThinkStation P5 Gen 2** | Up to one **Intel Xeon 600 Series** processor, up to 48 cores and 300W TDP | Up to **1TB** DDR5-6400 **RDIMM ECC** across 8 DIMM slots; professional RTX PRO GPUs with ECC options | Onboard **2.5GbE** with PCIe expansion for 10GbE add-in | **750W / 1000W**, 92%, 80 PLUS Platinum | Lenovo’s balanced diagnostic-tier comparator; include in bids against Dell 5860 and HP Z4 G5 [8] |

The shortest defensible shortlist is therefore **Dell Precision 5860 / HP Z4 G5 / Lenovo ThinkStation P5**. The **Dell 3680 / HP Z2 / Lenovo P3** tier is cost-attractive, but it should be limited to lighter seats unless the final quote explicitly validates ECC capacity, 10GbE NIC compatibility, GPU/display stack, power supply headroom, and Philips/Hologic supportability.

## SPECworkstation 4.0 performance evidence

SPECworkstation 4.0 does not publish a Philips/Hologic DICOM-load benchmark; the closest available proxies for 500MB+ study handling are **CPU**, **Life Sciences**, **Productivity & Development**, and **Storage**. SPEC states that higher scores indicate better performance [9].

| Vendor / model tested | CPU / GPU in SPEC result | CPU score | Life Sciences | Productivity & Development | Storage | Interpretation for imaging workstation selection |
|---|---|---:|---:|---:|---:|---|
| **Dell Precision 3680** | Core i9-14900K / RTX 6000 Ada | **1.67** | **2.60** | **2.38** | **1.47** | Excellent entry-tower CPU/storage proxy; add 10GbE and watch memory ceiling [9] |
| **Dell Precision 5860 Tower** | Xeon w7-2495X / RTX 5000 Ada | **1.48** | **2.95** | **2.41** | **1.11** | Stronger Life Sciences than entry towers; better platform fit despite slightly lower CPU subscore [9] |
| **HP Z2 Tower G9** | Core i7-14700K / RTX 4000 Ada | **1.50** | **2.19** | **2.13** | **1.11** | Adequate lower-cost HP seat; weaker Life Sciences than Dell 5860 / Lenovo P3 [9] |
| **HP Z4 G5** | Xeon w7-2495X / Radeon Pro W7600 | **1.11** | **2.48** | **2.05** | **0.87** | Platform remains strong; the published SPEC configuration is not the highest-performing Z4 GPU/storage build [9] |
| **Lenovo ThinkStation P3 Tower** | Core i9-14900K / RTX 5000 Ada | **1.67** | **2.67** | **2.31** | **1.12** | Strong benchmark peer to Dell 3680; still an entry-tower platform for networking/expansion purposes [9] |
| **Lenovo ThinkStation P8** | Threadripper Pro 7995WX / RTX 6000 Ada | **2.15** | **6.30** | **3.99** | **1.67** | Performance leader, but materially beyond routine PACS/DBT reading needs unless post-processing/research workloads justify it [9] |

For the 12-seat standard, benchmark ranking alone should not overrule platform suitability. The **Dell 3680 and Lenovo P3 tie at CPU 1.67**, but the **Dell 5860’s Life Sciences 2.95** and native enterprise networking/expansion make it a safer diagnostic standard. The **HP Z4 G5** should be bid with a stronger GPU/NVMe configuration than the SPEC result if HP is the preferred standard, because the tested Z4 result is below the Dell 5860 and Lenovo P3 on CPU/storage proxies [9].

## Power consumption and electricity cost at $0.13/kWh

At **16 hours/day**, **365 days/year**, **12 workstations** consume **70.08 kWh/year per watt of average draw across the fleet**. At the user-specified **$0.13/kWh**, five-year electricity cost ranges from **$6,832.80 at 150W average** to **$27,331.20 at 600W average**. EIA’s March 2026 Arizona commercial average price was **11.97 cents/kWh**, so **$0.13/kWh** is about **8.6% above** that statewide commercial average [10].

| Average draw per workstation | Fleet annual kWh, 12 seats | Annual electricity cost at $0.13/kWh | Five-year electricity cost |
|---:|---:|---:|---:|
| **150W** | **10,512 kWh/year** | **$1,366.56/year** | **$6,832.80** |
| **250W** | **17,520 kWh/year** | **$2,277.60/year** | **$11,388.00** |
| **400W** | **28,032 kWh/year** | **$3,644.16/year** | **$18,220.80** |
| **600W** | **42,048 kWh/year** | **$5,466.24/year** | **$27,331.20** |

This band is useful for sizing TCO sensitivity, but it should not drive the model decision by itself. Even the high-end 600W scenario adds roughly **$20,498.40** more than the 150W scenario over five years for the entire fleet, which is typically less consequential than diagnostic display cost, enterprise support, downtime, 10GbE switching, and over/under-sizing the workstation platform.

## 10GbE and network compatibility

Philips requires **1Gb/s end-to-end** for large CT/MR and mammography tomosynthesis workloads [1], and Hologic SecurView lists **Gigabit Ethernet** [2]. For this use case, **10GbE should be specified anyway** for all primary seats because the center is handling 500MB+ studies and 200 patients/day.

| Model tier | 10GbE posture | Procurement implication |
|---|---|---|
| Dell Precision 5860 | Onboard **1GbE + 10GbE** | Cleanest Dell networking path; fewer add-in-card variables [4] |
| HP Z4 G5 | Optional high-speed NICs including **Intel X550-T2 10GbE** | Specify NIC in base image and validate slot/GPU/storage layout [6] |
| Lenovo ThinkStation P5 Gen 2 | Onboard 2.5GbE class with PCIe expansion for 10GbE | Include qualified 10GbE NIC in the bid and image validation [8] |
| Dell 3680 / HP Z2 / Lenovo P3 | 10GbE usually through optional or add-in NIC path | Acceptable for lighter seats; less ideal for standardized primary diagnostic fleet [3] [5] [7] |

The network budget must include not only NICs but also 10GbE switch ports, optics or Cat6A/Cat6 cabling as appropriate, PACS/VNA server-side throughput, and local-cache policy. A 10GbE client cannot compensate for a congested 1GbE uplink or undersized PACS storage path.

## Enterprise support in Phoenix metro

All three vendors can be bid with enterprise onsite-class support suitable for a healthcare imaging center; the practical difference is the exact SLA available at the Phoenix service address and whether same-day/four-hour parts are quoted, not merely advertised.

| Vendor line | Enterprise support option | Support features relevant to imaging center | Phoenix-metro procurement instruction |
|---|---|---|---|
| **Dell Precision** | ProSupport / ProSupport Plus | **24x7** technical support, in-region ProSupport experts, **next-business-day onsite repair**, Keep Your Hard Drive in ProSupport Plus/optional paths, and same-business-day onsite on select models/locations [11] [12] | Quote **5-year ProSupport Plus** with Keep Your Hard Drive; verify by service address whether same-business-day or 4-hour coverage is available |
| **HP Z** | HP Care Pack for Workstations | **3-year or 5-year Next Business Day Onsite** workstation support, defective-media retention option, remote diagnosis, onsite hardware support, replacement parts/materials, escalation management [13] [14] | Quote **5-year NBD onsite with Defective Media Retention**; verify authorized service coverage and parts SLA for Phoenix address |
| **Lenovo ThinkStation** | Premier Support / Premier Support Plus | **24x7x365** hardware/software support, direct advanced technicians, single point of contact, **next-business-day onsite labor and parts prioritization**, predictive issue detection in Plus [15] | Quote **5-year Premier Support Plus** or Premier NBD with parts prioritization; verify local onsite and any accelerated-parts SLA using the Phoenix address [16] |

For protected health information and failed drives, the support quote should explicitly include **Defective Media Retention / Keep Your Hard Drive** rather than relying on a generic onsite warranty.

## Five-year TCO factors for 12 workstations

The major five-year TCO drivers are, in descending practical importance for this site:

1. **Diagnostic display stack** — Philips Advanced Mammography calls for diagnostic displays including **two 5MP 510(k)-cleared mammography displays** [1]. For mammography readers, monitor acquisition/calibration/support can exceed the incremental cost difference between workstation towers.
2. **Workstation/GPU platform acquisition** — Dell 5860 / HP Z4 / Lenovo P5 cost more than Dell 3680 / HP Z2 / Lenovo P3, but they reduce integration risk through ECC, expansion, and cleaner 10GbE/GPU/storage options [3] [4] [6] [5].
3. **ECC RAM and cache storage sizing** — Hologic recommends **64GB RAM** and **8TB SSD / 400MB/s** for SecurView DX 12.0+ software-only workstations, with DBT/multimodality storage requiring technical sales sizing; Philips local cache disk requirements depend on exams cached [2] [1].
4. **10GbE infrastructure** — The workstation NIC is only one line item; switches, cabling, server-side bandwidth, and PACS/VNA storage throughput determine whether 500MB+ studies open quickly.
5. **Enterprise support and media retention** — 5-year NBD onsite plus defective-media/keep-drive retention reduces downtime and PHI handling risk; Dell, HP, and Lenovo all have suitable enterprise support offerings when quoted correctly [12] [13] [15].
6. **Downtime / spare strategy** — For 200 patients/day, a cold spare or rapid swap image may be cheaper than lost reading capacity while waiting for parts, even with NBD onsite service.
7. **Software validation and image standardization** — Validate the exact GPU driver, display controller, NIC, Windows build, PACS cache location, and Hologic/Philips software versions before cloning to all 12 seats.
8. **Electricity and heat** — At **$6,832.80–$27,331.20 over five years** for the 12-seat fleet across 150–600W average draw, power matters but should not displace platform/support fit [10].

## Final recommendation

**Choose Dell Precision 5860 Tower as the primary standard if Dell pricing/support is competitive; choose HP Z4 G5 as the co-equal alternative if HP’s 5-year Care Pack/DMR and Z ecosystem pricing is better; keep Lenovo ThinkStation P5 Gen 2 as the third bid rather than excluding it.** Configure the primary diagnostic fleet as follows:

- **CPU/platform:** Xeon W / workstation-class tower, with SPECworkstation proxy target around **CPU ≥1.5** and **Life Sciences ≥2.4** where comparable published results exist [9].
- **Memory:** **64GB ECC minimum**, **128GB ECC** for heavy DBT/large CT users.
- **Graphics:** professional RTX/Radeon Pro class sized for the display stack, including mammography-grade 5MP monitors where used [1].
- **Storage:** **2TB+ NVMe OS/cache** at minimum, with Hologic SecurView sizing validated against DBT/multimodality requirements; Hologic’s software-only recommendation includes **8TB SSD at 400MB/s** [2].
- **Network:** **10GbE** from workstation to PACS/VNA path; do not stop at the Philips/Hologic 1GbE/Gigabit floor [1] [2].
- **Support:** **5-year NBD onsite** with **Defective Media Retention / Keep Your Hard Drive** and Phoenix-address SLA verification [12] [13] [15].

If budget forces a mixed fleet, use **Dell Precision 5860 / HP Z4 G5 / Lenovo P5** for the radiologist and mammography diagnostic seats, and use **Dell Precision 3680 / HP Z2 / Lenovo P3** only for lighter PACS review, technologist QA, and administrative workstations after validating ECC configuration, PCIe 10GbE, GPU/display compatibility, and Philips/Hologic supportability.

## Sources

1. [a5a1d9b13cf34189b69ab32500763e29.pdf](https://www.documents.philips.com/assets/Instruction%20for%20Use/20250725/a5a1d9b13cf34189b69ab32500763e29.pdf?feed=ifu_docs_feed)
2. [download](https://www.hologic.com/file/425481/download?token=znTgZ8gH)
3. [precision-3680-spec-sheet.pdf](https://www.delltechnologies.com/asset/en-us/products/workstations/technical-support/precision-3680-spec-sheet.pdf)
4. [https://www.delltechnologies.com/asset/en-my/products/workstations/technical-support/precision-5860-tower-spec-sheet.pdf.external](https://www.delltechnologies.com/asset/en-my/products/workstations/technical-support/precision-5860-tower-spec-sheet.pdf.external)
5. [c08109687](https://www8.hp.com/h20195/V2/GetPDF.aspx/c08109687)
6. [Z4 G5 QuickSpecs v40.pdf](https://h30434.www3.hp.com/psg/attachments/psg/Business-PC-Workstation-POS/59584/3/Z4%20G5%20QuickSpecs%20v40.pdf)
7. [ThinkStation_P3_Tower_Gen_2_Spec.pdf](https://psref.lenovo.com/syspool/Sys/PDF/ThinkStation/ThinkStation_P3_Tower_Gen_2/ThinkStation_P3_Tower_Gen_2_Spec.pdf)
8. [ThinkStation_P5_Gen_2_Spec.pdf](https://psref.lenovo.com/syspool/Sys/PDF/ThinkStation/ThinkStation_P5_Gen_2/ThinkStation_P5_Gen_2_Spec.pdf)
9. [SPECworkstation 4.0 Result Report Summary](https://spec.org/gwpg/wpc.data/specworkstation4_summary.html)
10. [Electric Power Monthly - U.S. Energy Information Administration (EIA)](https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_a)
11. [dell-prosupport-plus-for-pcs-and-tablets-sd-en-amer.pdf](https://i.dell.com/sites/csdocuments/Legal_Docs/en/us/dell-prosupport-plus-for-pcs-and-tablets-sd-en-amer.pdf)
12. [ProSupport Suite for PCs Support Services | Dell US](https://www.dell.com/support/contents/en-us/article/warranty/prosupport-suite-for-pcs)
13. [HP® 5 year Next Business Day Onsite HW Support w/Defective Media Retention for Workstations](https://www.hp.com/us-en/shop/pdp/hp-5-year-next-business-day-onsite-hw-support-w-defective-media-retention-for-workstations)
14. [HP 3 year Next Business Day Onsite Optional CSR Workstations HardwareSupport](https://www.hp.com/us-en/shop/pdp/hp-3-year-next-business-day-onsite-workstation-only-hardware-support-service)
15. [Lenovo Premier Support Plus – IT Support | Lenovo Tech Today US](https://techtoday.lenovo.com/us/en/premier-support-plus)
16. [Lenovo Premier Support with Onsite NBD - extended service agreement - 2 years - on-site - 5WS0T36187 - Warranties - CDW.com](https://www.cdw.com/product/lenovo-2y-premier-support-upgrade-from-1y-depot-cci/5406027)