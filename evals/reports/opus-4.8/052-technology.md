## Bottom line

For petabyte-scale genomics with a hard requirement to satisfy HIPAA **and** GDPR **and** China's data laws (PIPL, Data Security Law, Human Genetic Resources Regulation) *simultaneously*, **no single managed genomics platform meets all of them**. The practical reality is:

- **AWS HealthOmics** is the most complete managed genomics service today — a HIPAA-eligible, fully managed bioinformatics platform supporting WDL, Nextflow, and CWL workflows, a petabyte-scale Sequence Store, and fixed-price Ready2Run pipelines [1][2] — but its higher-level managed data products are being wound down, with variant stores and annotation stores closed to new customers as of late 2025.
- **Google Cloud (Cloud Healthcare API + Terra.bio)** is the strongest for federated, GA4GH-aligned multi-institution analysis and GATK Best Practices, but Google operates **no mainland-China region**, so it cannot keep data resident in China.
- **Microsoft Azure has effectively exited managed genomics**: the Microsoft Genomics service was **retired January 6, 2025**, and Cromwell on Azure has been archived. Azure genomics is now self-managed (CycleCloud, AKS-based Nextflow).
- **China is the binding constraint.** AWS and Azure both run isolated, locally-operated China regions (AWS via Sinnet/NWCD; Azure via 21Vianet) but **neither runs its integrated genomics stack there** — HealthOmics and the former Microsoft Genomics service are not available in China regions. Human genetic resource data is additionally subject to export approval under the HGR regulation regardless of cloud.

**Recommendation:** Use AWS HealthOmics (or GCP/Terra for federation-heavy work) for HIPAA + GDPR workloads in US/EU regions, and adopt a **self-managed Nextflow + GA4GH federation** fallback architecture for the China leg, with genetic-resource data kept resident in-country and only aggregate/derived results exported subject to HGR approval. This avoids tying the China requirement to any managed service that does not exist there.

---

## 1. Platform genomics capabilities

### AWS — HealthLake and HealthOmics
- **HealthOmics** provides **Sequence Stores** and **Reference Stores** for managed storage of omics data, and two workflow execution models:
 - **Private workflows** — bring-your-own pipelines in **WDL, Nextflow, or CWL**, priced on two components: the omics compute instance per task (e.g., omics.c.4xlarge at $0.9180/hr, omics.r.8xlarge at $2.7216/hr) plus run-storage GB-hours [1][2].
 - **Ready2Run workflows** — prebuilt, fixed-cost-per-run pipelines with cost known before the run starts; e.g., the **GATK-BP Germline fq2vcf for 30x genome** workflow is **$10.00/run** [2].
- **Variant and annotation stores** are zero-ETL managed stores (variant store $0.035/GB-month) that prepare data for querying in Athena/SageMaker [2]; these are **closed to new customers as of late 2025**, with existing customers continuing and migration paths available.
- HealthOmics is **HIPAA-eligible**, with audit logging and provenance tracking for clinical/regulatory use [1].
- **HealthLake** is the FHIR-based clinical-data store (separate from the genomics path).

### Google Cloud — Cloud Healthcare API + Terra.bio
- **Cloud Healthcare API** provides managed **FHIR, DICOM, and HL7v2** stores for clinical/health data interchange.
- **Terra.bio** (backed by the Broad Institute and Verily) runs on GCP and executes **Cromwell/WDL** workflows including **GATK Best Practices** pipelines, and is the analysis front end for the **AnVIL** federated dataset ecosystem.

### Microsoft Azure — managed genomics retired
- The **Microsoft Genomics service** (a cloud implementation of **BWA + GATK / Broad Best Practices**, launched 2016) was **retired January 6, 2025**; the `msgen` repository is archived as legacy 2017–2025 binaries.
- **Cromwell on Azure** has been **archived / set read-only** (no further updates, fixes, or support).
- Current Azure genomics is **self-managed**: **Azure CycleCloud** (HPC scheduler), **AKS-based Nextflow**, and the (now archived) Cromwell on Azure. As of 2026 Microsoft has **no managed genomics service**.

---

## 2. Bioinformatics tool / pipeline availability

| Tool / pipeline | AWS | Google Cloud / Terra | Azure |
|---|---|---|---|
| **GATK4** (Broad Best Practices) | Yes (private/Ready2Run workflows) | Yes — native on Terra via Cromwell/WDL | Self-managed (was core of retired MS Genomics) |
| **DeepVariant** | Yes (workflow) | Yes (Google-developed; widely run on GCP/Terra) | Self-managed |
| **DRAGEN** (Illumina) | Available as Ready2Run/partner workflow | Available via Terra/partner | Self-managed |
| **BWA-MEM2** | Yes (workflow) | Yes | Self-managed (was in MS Genomics) |
| **nf-core / Nextflow** | Yes — native Nextflow on HealthOmics private workflows | Yes (Nextflow Tower / self-managed) | Yes — AKS-based Nextflow is the recommended path |

All three can run the standard open-source stack; the difference is **how much is managed**: AWS and Terra offer turnkey managed execution, Azure requires you to assemble it.

---

## 3. Compliance

### HIPAA
- **AWS**: HealthOmics and HealthLake are HIPAA-eligible services covered under AWS's **BAA**; AWS maintains SOC 2 and HITRUST certifications across in-scope services.
- **Google Cloud**: Cloud Healthcare API is HIPAA-covered under Google's **BAA**; Terra documents HIPAA-aligned controls for AnVIL/controlled-access data.
- **Azure**: covered under Microsoft's **BAA** with SOC 2 / HITRUST, but this now applies to general compute (AKS/CycleCloud) rather than a dedicated genomics service.

### GDPR / EU data residency
- All three operate **EU regions** with data-residency controls.
- **Microsoft EU Data Boundary** — commitment to store and process customer data within the EU/EFTA.
- **AWS European Sovereign Cloud** — EU-operated, EU-resident sovereign offering.
- **Google Cloud sovereign controls** — Sovereign Controls / partner-operated options in the EU.

### China data laws (PIPL, Data Security Law, HGR)
- **China is the discriminator.** Genetic data is regulated under **PIPL**, the **Data Security Law**, and the **Human Genetic Resources (HGR) Regulation**, which restricts cross-border transfer/export of human genetic resources and requires approval.
- **AWS China** is operated by **Sinnet (Beijing) and NWCD (Ningxia)** as isolated regions; **Azure China** is operated by **21Vianet** — both are legally separate from the global clouds.
- **Google has no mainland-China region.**
- Critically, the **integrated managed genomics stacks (HealthOmics, the former Microsoft Genomics) are not offered in these China regions**, so a China-resident genomics pipeline must be built from general compute/storage there.

---

## 4. Federated analysis

- **Google/Terra/AnVIL** is the strongest for cross-institution federation: **GA4GH** standards adoption (DRS, WES, Passports/Visas for controlled access), Terra/AnVIL **federated data access** without bulk data movement.
- **AWS HealthOmics** supports **cross-account resource sharing** (e.g., via AWS RAM / resource policies) for sharing stores and workflows across organizations, but is less explicitly GA4GH-oriented.
- **Azure** offers no managed federation layer post-retirement; federation would be hand-built.
- True **federated learning across institutions without data movement** is not a turnkey feature on any of the three; it requires GA4GH-based architecture (Terra/AnVIL is closest) or custom build.

---

## 5. Variant calling performance

Approximate runtime and accuracy for a **30× WGS genome** (precisionFDA Truth Challenge / GIAB benchmarks, well-established field figures):

| Caller | Typical runtime per 30× WGS | Accuracy (SNV/indel F1 on GIAB) |
|---|---|---|
| **DRAGEN** (Illumina, FPGA-accelerated) | ~30 min – a few hours (hardware-accelerated) | Top-tier; repeatedly leads precisionFDA Truth Challenges |
| **DeepVariant** | Several hours on CPU/GPU | Very high F1, competitive with DRAGEN on SNVs |
| **GATK4 HaplotypeCaller** | Longest (many hours, multi-core) | High, the long-standing Best-Practices baseline |

DRAGEN is fastest by a wide margin due to hardware acceleration; DeepVariant and DRAGEN typically lead on accuracy, with GATK4 the reference baseline. (Exact per-run numbers depend on instance type and parallelization.)

---

## 6. Storage cost (petabyte scale)

Approximate list per-GB-month (US regions; tiers are the cost lever at PB scale):

| Tier | AWS S3 | Google Cloud Storage | Azure Blob |
|---|---|---|---|
| Hot / Standard | ~$0.023/GB | ~$0.020/GB | ~$0.018–0.021/GB |
| Cool / Nearline–Cold | ~$0.0125/GB (IA) | ~$0.010/GB (Nearline) | ~$0.010/GB (Cool) |
| Archive | ~$0.004/GB (Glacier Deep ~$0.00099) | ~$0.004/GB (Archive) | ~$0.00099/GB (Archive) |

At PB scale, archive tiering is decisive: 1 PB of hot storage is roughly **$23,000/month (~$276k/yr)** on S3 Standard vs. only a few thousand dollars/month in archive — but archive incurs retrieval fees and latency.

---

## 7. Egress cost traps

- **AWS**: internet egress ~**$0.09/GB** (first tier); cross-region replication and cross-AZ transfer add cost. AWS now offers **free egress when customers fully exit AWS** (free data transfer out to migrate away), aligned with the EU Data Act.
- **Google Cloud**: comparable per-GB internet egress (tiered ~$0.08–0.12/GB); GCP committed to **free egress for customers leaving Google Cloud**.
- **Azure**: similar tiered egress (~$0.087/GB after free tier); free egress to exit under the EU Data Act regime.
- **Trap:** egress is the multi-cloud lock-in. Moving 1 PB out at ~$0.09/GB ≈ **$90,000 per petabyte-transfer**. Cross-region replication for DR/residency doubles storage and adds inter-region transfer. The "free egress on exit" only applies to *full* departure, not ongoing multi-cloud data flows or federated cross-institution traffic.

---

## 8. Compute cost per genome and total annual cost (100,000 WGS)

Per-genome compute for a 30× WGS secondary-analysis pipeline (alignment + variant calling) is roughly **$3–$8 on-demand** and **$1–$3 on spot/preemptible** instances, depending on caller (DRAGEN's acceleration lowers wall-clock but carries licensing). Managed services (HealthOmics private workflows, Terra) bill the underlying compute plus a service layer; self-managed Nextflow on spot is the cheapest.

**Illustrative annual total for 100,000 genomes** (30× WGS ≈ 100 GB raw each → ~10 PB/yr; assumes spot/preemptible compute and archive-tiered storage of cold data):

| Component | AWS | Google Cloud / Terra | Azure (self-managed) |
|---|---|---|---|
| Compute (100k × ~$2–6/genome) | $200k–$600k | $200k–$600k | $150k–$500k (spot) |
| Storage (~10 PB, mixed hot/archive) | ~$1.5M–$3M/yr hot; ~$0.5M archive-heavy | similar, slightly lower list | lowest archive list (~$0.001/GB) |
| Egress (variable; 1 PB out ≈ $90k) | $90k per PB exported | comparable | comparable |
| **Order-of-magnitude annual total** | **~$1M–$3.5M** | **~$1M–$3.5M** | **~$0.8M–$3M** |

Storage dominates at PB scale; aggressive archive tiering and minimizing egress matter far more than per-genome compute differences. These are order-of-magnitude estimates from list prices — actual cost depends on hot/cold split, instance choice, spot availability, and DRAGEN licensing.

---

## 9. Cross-cutting analysis

**Can one platform satisfy HIPAA + GDPR + China simultaneously?** No. HIPAA and GDPR are satisfiable on all three via BAAs, EU regions, and sovereign-cloud commitments (EU Data Boundary, AWS European Sovereign Cloud, GCP sovereign controls). **China breaks the set:**
- Google has no China region at all.
- AWS and Azure have isolated China regions (Sinnet/NWCD; 21Vianet) but **do not run their integrated genomics services there**.
- The HGR regulation independently restricts export of human genetic resources, so even with a China region you cannot freely move genomic data out.

The unavoidable conclusion: **no provider runs a fully integrated managed genomics stack in mainland China**, so the China requirement forces a split architecture.

**Managed convenience vs. raw cost control.** HealthOmics and Terra remove operational burden (managed stores, turnkey GATK/Cromwell, provenance), at a service premium and with vendor lock-in. **Self-managed Nextflow on spot instances** is the cheapest per-genome and portable across clouds, but you own scheduling, reproducibility, and compliance scaffolding. At petabyte scale the storage and egress bill dwarfs the managed-vs-self compute delta, so the decision hinges more on **portability and egress lock-in** than on compute pennies.

**Egress shapes multi-cloud strategy.** Per-GB egress (~$0.09/GB; ~$90k/PB) makes routine cross-cloud data movement prohibitive. "Free egress on exit" helps only for a one-time migration away, not for ongoing federated traffic. This pushes toward **keeping data resident and computing where it lives**, and toward **GA4GH federation** (send the query/compute to the data) rather than copying datasets between clouds or institutions.

---

## 10. Recommendation with fallback

**Preferred:** For HIPAA + GDPR workloads (US/EU), **AWS HealthOmics** is the most complete managed genomics path (sequence stores + WDL/Nextflow/CWL private workflows + Ready2Run, HIPAA-eligible), with **Google Cloud + Terra/AnVIL** preferred where **multi-institution federation and GA4GH standards** are the priority. Use EU regions / European Sovereign Cloud (AWS) or EU Data Boundary / sovereign controls for GDPR residency. Tier cold data to archive aggressively and minimize egress.

**Fallback architecture (required for China + federation):** Because no single managed platform covers China or true cross-institution federation, deploy **self-managed Nextflow (nf-core pipelines) on spot/preemptible compute** as a portable engine, running:
- in **AWS/GCP US-EU regions** for the global cohort, and
- in the **AWS China (Sinnet/NWCD) or Azure China (21Vianet)** region for China-resident data, keeping human genetic resource data in-country and exporting only **aggregate/derived results** subject to **HGR approval**.

Tie the institutions together with **GA4GH federation** (DRS for data location, WES for workflow execution, Passports for controlled access) so analysis goes to the data rather than data crossing borders — which also sidesteps the egress lock-in. This fallback is the only configuration that simultaneously respects China residency, GDPR residency, and HIPAA while preserving cross-institution analysis.

*Note: Many storage, egress, and per-genome compute figures above are list-price/industry-standard estimates; verify current published pricing and DRAGEN licensing for a contractual quote.*

## Sources

1. [AWS HealthOmics Features](https://aws.amazon.com/healthomics/features/)
2. [AWS HealthOmics Pricing](https://aws.amazon.com/healthomics/pricing/)