# Cloud genomics platform choice for 100,000 WGS/year

**Bottom line:** For a petabyte-scale genomics platform, **AWS HealthOmics is the strongest managed-genomics choice** because it is a production managed bioinformatics service with WDL, Nextflow, and CWL support, an AWS-run workflow/storage/variant/annotation stack, and Ready2Run GATK, DeepVariant/Parabricks, Sentieon and nf-core content. **Google Cloud with Terra is the strongest federation/research-network choice** because Terra/AnVIL is built around WDL/Cromwell, Dockstore and collaborative workspaces, but Google Cloud Healthcare API itself is a clinical-data API, not a workflow engine. **Azure is not a like-for-like managed-genomics platform as of 2026-06-23**: Microsoft Genomics retired on **2025-01-06 22:59:59.999 PT**, leaving Azure Batch/CycleCloud/AKS-style primitives and archived Cromwell-on-Azure references rather than a supported managed genomics service [1].

| Rank dimension | AWS HealthOmics / HealthLake | Google Cloud / Terra / Healthcare API | Microsoft Azure alternatives |
|---|---|---|---|
| Managed genomics maturity | **1st** — HealthOmics is a HIPAA-eligible managed bioinformatics workflow service with workflows, sequence storage, variant and annotation stores [2]. | **2nd** — Terra is a mature Broad-operated WDL/Cromwell workspace platform on Google Batch/Compute; Healthcare API is clinical data only [3], [4]. | **3rd** — Microsoft Genomics is retired; Batch/CycleCloud are generic compute/HPC services [1], [5], [6]. |
| Bioinformatics tool breadth | **Best native managed breadth** — WDL, Nextflow, CWL; Ready2Run GATK, DeepVariant/Parabricks, Sentieon, nf-core [7], [8]. | **Best GATK/Terra ecosystem** — WDL/Cromwell, Dockstore, GATK Best Practices, notebooks/RStudio/Galaxy, DeepVariant examples [3], [9], [10], [11]. | **Good if self-managed** — Nextflow on Azure Batch, nf-core azurebatch, Cromwell-on-Azure GATK examples; no active managed genomics service [12], [13], [14]. |
| HIPAA/GDPR posture | Strong HIPAA/ISO basis for named services; HealthOmics/HealthLake are HIPAA-eligible; HealthOmics/HealthLake in AWS ISO scope [2], [15], [16]. | Strong HIPAA basis for Cloud Healthcare API, Batch, BigQuery, Cloud Storage, Compute, KMS/HSM; Terra workloads depend on using covered GCP services and avoiding Pre-GA services [17]. | Azure has Microsoft HIPAA BAA via Product Terms/DPA for in-scope Azure services; exact service list is referenced externally, while Batch is generic in-region compute [18], [5]. |
| China feasibility | Weak for the named managed genomics services in this record: HealthOmics/HealthLake regions listed do **not** include mainland China [19], [20]. | Weakest for mainland China deployment: Cloud Healthcare API’s regions list includes many Americas, Asia-Pacific, Europe and Middle East locations plus multiregional **us/eu**, while Terra’s documented execution path is Google Batch/Compute/Cloud Storage; neither is a China-local managed genomics engine in the cited platform architecture [20], [3], [4]. | Best generic-cloud branch if China localization is mandatory, because Azure can be built from generic compute/storage patterns; however Microsoft Genomics itself is retired [1], [5]. |
| Federation readiness | Cross-account AWS primitives exist in the HealthOmics stack notes — Lake Formation, Athena, DataZone-related services — but no GA4GH DRS/TES/WES/TRS/Passports claim is established for HealthOmics [2], [16]. | **Best** — Terra/AnVIL uses WDL/Cromwell, Dockstore, GA4GH-compliant Dockstore export connectors, workspaces and notebooks [9], [21], [10]. | Moderate with generic identity/data-sharing primitives; the cited genomics references cover Nextflow/Cromwell-on-Batch rather than GA4GH federation [12], [13]. |
| Variant-calling performance evidence | Strongest cited managed runtime examples: Ready2Run 30x Parabricks DeepVariant **2:00**, Parabricks HaplotypeCaller **1:15**, GATK-BP fq2vcf **12:30**, bam2vcf **2:45** [8]. | Terra cited examples include GATK4 tutorial NA12878 **22:35** for 64.89 GB at **$5.23**, WGS JointGenotyping **4:05** at **$7.93**; these are not the same FASTQ-to-VCF benchmark [11]. | Cited Azure sources document pipeline availability and generic Batch behavior, but not comparable Azure wall-clock/cost benchmarks for 30x WGS [12], [5]. |
| Egress/TCO risk | High if cross-region/cloud collaboration moves PB-scale data; exact price thresholds are not in the cited record, but HealthOmics stores and workflow data in S3/ECR/analytics services [2]. | High for Terra collaboration if large Cloud Storage inputs are localized or exported; Terra notes large input localization time is billable [3]. | High if self-managed pipelines repeatedly copy between Blob, Batch nodes, tenants or clouds; Nextflow explicitly downloads inputs to nodes and uploads outputs to Blob [13]. |

## 1. Service identity, status and regions as of 2026-06-23

### AWS

**AWS HealthOmics** is the only option in the comparison that is both cloud-native and genomics-specific as a managed service. AWS describes it as a HIPAA-eligible managed bioinformatics workflow service, supporting WDL, Nextflow and CWL workflows and scaling to “tens of thousands of tests per day”; it is not positioned as clinical decision support or medical advice [2]. Its service model has three core layers: managed workflows, petabyte-scale sequence storage, and analytics through variant stores and annotation stores; related services include S3, private ECR images for each private workflow, Lake Formation, Athena and SageMaker/Jupyter notebooks [2].

**HealthOmics regions** in the AWS General Reference are **us-east-1**, **us-west-2**, **ap-southeast-1**, **ap-northeast-2**, **eu-central-1**, **eu-west-1**, **eu-west-2** and **il-central-1**; the APIs are separated as `workflows-omics`, `storage-omics` and `analytics-omics`, with FIPS endpoints in **us-east-1** and **us-west-2** [19]. Important quota values for 100,000-genome planning are: default active GPUs **12 per supported Region**, adjustable, with requests up to **500** automatically approved in **us-east-1/us-west-2**; concurrent tasks per run **25**, adjustable, with requests up to **100** automatically approved in **us-east-1/us-west-2**; active/inactive workflow runs **100,000 per Region**; static run storage **9,600 GiB per run**, adjustable, with **50,000 GiB** auto-approved in **us-east-1/us-west-2**; and maximum run duration **604,800 seconds** [19].

**AWS HealthLake** is a separate clinical interoperability service, not a bioinformatics workflow platform. AWS describes HealthLake as a fully managed, HIPAA-eligible FHIR R4 persistence layer for petabyte-scale clinical interoperability and analytics, with thousands of concurrent requests and sub-millisecond latency; it supports FHIR infrastructure, SMART on FHIR, analytics and AI-ready clinical data, but it is not a WDL/Nextflow/CWL executor [15]. HealthLake regions in the AWS docs include **us-east-2**, **us-east-1**, **us-west-2**, **ap-south-1**, **ap-southeast-2**, **ca-central-1**, **eu-west-1**, **eu-west-2**, **eu-central-1** and **eu-north-1**, with FIPS endpoints for **us-east-1/us-east-2/us-west-2** [22].

### Google Cloud and Terra

**Google Cloud Healthcare API** is a managed clinical-data API, not a genomics analysis service. It ingests, transforms and stores healthcare data in FHIR, HL7v2, DICOM and unstructured text; provides FHIR, HL7v2, DICOM and de-identification APIs; and integrates with BigQuery, AutoML/Gemini-style analytics and IAM/bulk import-export flows [4]. Cloud Healthcare API datasets are created in a fixed regional or multiregional location, and the regions page lists regional locations including **northamerica-northeast1/2**, **us-central1**, **us-east1**, **us-east4**, **us-west1/2/3**, **southamerica-east1**, **asia-east1/2**, **asia-northeast1/2/3**, **asia-south1**, **asia-southeast1/2**, **australia-southeast1/2**, **europe-north1**, **europe-west2/3/4/6**, **me-west1**, **me-central1/2**, plus multiregional **us** and **eu**; the dataset location cannot be changed after creation [20]. The Cloud Healthcare API material positions it as FHIR/HL7v2/DICOM infrastructure, not a WDL, Nextflow, CWL, GATK or DeepVariant executor [4].

**Terra on Google Cloud** is the Google-side genomics analysis platform in this comparison. Terra UI/Rawls submits WDL workflows to built-in Cromwell; six Cromwell runners dispatch tasks to Google Batch/Compute Engine; each task runs a Docker container on a VM, localizes Cloud Storage inputs, writes logs and outputs to Cloud Storage/workspace buckets, and then destroys the VM [3]. Terra’s current execution documentation uses **Google Batch** as the execution backend [3]. Google’s older **Cloud Life Sciences API** was announced deprecated on **2023-07-17** and unavailable after **2025-07-08**; Google Batch is described as the generally available successor supporting Cloud Life Sciences use cases [23].

Terra scale limits that matter for 100,000 genomes are: **3,000 concurrent workflows per user** across submissions; **six** Cromwell runner instances; **4,800 jobs per workspace** per runner; **30,000 jobs at a time** in Cromwell, with excess jobs waiting; up to **28,800 jobs** that Terra can submit on the user’s behalf; and Rawls launch requests submitted to Cromwell in batches of **50** [3]. Preemptible/Spot preemption causes restart delay rather than downtime charges, while large input localization time is billable on GCP [3].

### Microsoft Azure

**Microsoft Genomics is retired and cannot be selected as a like-for-like managed genomics platform.** Microsoft’s Lifecycle page lists Microsoft Genomics under the Modern Lifecycle Policy with start date **2017-10-30** and retirement date **2025-01-06 22:59:59.999 PT** [1].

The current Azure path is therefore a build-it-yourself architecture using generic services. **Azure Batch** runs large-scale parallel and HPC batch jobs by creating/managing VM pools, installing applications and scheduling jobs/tasks; Microsoft states there is no extra charge for Batch beyond the underlying VMs, storage and networking, and that Batch does not move or store customer data outside its deployment region [5]. **Azure CycleCloud** creates autoscaling HPC clusters with familiar schedulers including **Slurm, PBSPro, LSF, Grid Engine and HTCondor**, and Microsoft describes it as the sister product to Azure Batch, not as a genomics managed service [6].

The cited sources establish Azure Batch and CycleCloud as successors in the practical sense of Azure-native compute alternatives, not as a Microsoft-designated managed-genomics successor. **Azure Health Data Services** is a clinical health-data service family rather than a genomics workflow service: Microsoft’s regional-availability page says availability varies by region and feature; **Azure API for FHIR will retire on 2026-09-30**, new Azure API for FHIR deployments were blocked from **2025-04-01**, and customers should migrate to the Azure Health Data Services FHIR service [24]. The page lists FHIR service general availability in regions including **Central India, Japan East, Korea Central, Southeast Asia, Australia East, Canada Central, France Central, Germany West Central, North Europe, Sweden Central, Switzerland North, UK South, UK West, West Europe, Qatar Central, East US, East US2, South Central US, North Central US, West Central US, West US2 and West US3**; DICOM/de-identification/events are GA only in a subset such as Canada Central and East US/East US2 [24].

## 2. Bioinformatics tool availability

### AWS HealthOmics

AWS HealthOmics has the clearest managed workflow-language breadth:

| Capability | Grounded status |
|---|---|
| WDL | Supported; versions **1.0, 1.1 and development** [7]. |
| CWL | Supported; versions **1.0, 1.1 and 1.2** [7]. |
| Nextflow | Supported for stable releases only, not monthly edge; versions listed include **22.04.01 DSL1/DSL2**, **23.10.0 DSL2 default**, **24.10.8 DSL2**, **25.10.0 DSL2**, **26.04.0 DSL2** [7]. |
| Containers/private images | HealthOmics private workflows use private ECR images; S3 stores workflow/store data [2]. |
| Managed stores | Sequence store; variant store for **gVCF/VCF**; annotation store importing **TSV/CSV, VCF or GFF3** mapped to variant-store coordinates [2]. |
| Query/analytics | Lake Formation and Athena are part of the HealthOmics analytics ecosystem; SageMaker/Jupyter notebooks are cited for interactive analytics [2]. |
| HealthLake interoperability | HealthLake is FHIR R4 clinical persistence, not workflow execution; integration is clinical/interoperability-side rather than a HealthOmics workflow engine [15]. |

The HealthOmics Ready2Run catalog provides production-style content rather than just primitives. It includes Broad **GATK-BP fq2bam** with **64 GiB** and estimated **10:10** runtime; **GATK-BP Germline bam2vcf** for a **30x genome**, **39 GiB**, estimated **2:45**; **GATK-BP Germline fq2vcf** for a **30x genome**, **64 GiB**, estimated **12:30**; **GATK-BP Somatic WES bam2vcf**, **86 GiB**, estimated **1:30**; NVIDIA Parabricks WGS workflows for **5x/30x/50x**, including **30x DeepVariant 2:00** and **30x HaplotypeCaller 1:15**; nf-core scRNAseq; Sentieon germline/somatic WES/WGS and long-read workflows; Ultima DeepVariant; AlphaFold/ESMFold; and bases2fastq [8]. Ready2Run workflows are intentionally constrained: they are preconfigured and not editable; users cannot change maximum input file size, compute resources, run storage, workflow definitions or containers, add runs to a run group, or share the workflow, though publisher GitHub workflows can be copied into private workflows where available [8].

### Google Cloud / Terra

Terra’s workflow model is WDL/Cromwell-centric rather than language-neutral. Terra workflow elements include Cloud Storage input paths, Docker images, commands, CPU/RAM/disk runtime settings and Cloud Storage output paths [3]. Terra’s Dockstore integration imports **Dockstore workflows**, not Dockstore tools; Dockstore is GA4GH-compliant and provides Terra-compatible WDL export/connectors [9]. Terra also supports interactive environments — Jupyter Notebooks, RStudio and Galaxy — for analysis adjacent to batch workflows [21].

For GATK, Terra is the strongest ecosystem option. Broad states Terra is its preferred platform for hands-on GATK resources, test data, pipelines and workshop tutorials; Terra Best Practices workspaces are preloaded with fully functional workflows [10]. The current workspace set cited includes Whole-Genome-Analysis-Pipeline / WholeGenomeReprocessingPipeline_v1 producing GVCF and QC metrics, Exome-Analysis-Pipeline, GATK4-Germline-Preprocessing-VariantCalling-JointCalling, Variant_Calling_Spark_Multicore beta, cnn-variant-filter and GATK-SV single/joint calling [10]. DeepVariant is available in the Google/Terra ecosystem through open-source Google DeepVariant, which uses a deep neural network to call variants from next-generation DNA sequencing data, publishes Docker images, and documents Google Cloud quick-start data [25], [26], [27].

### Azure

Azure has workflow-tool availability, but it is self-managed. Microsoft’s Cromwell-on-Azure materials show WDL/Cromwell on Azure Batch and Blob Storage, including GATK Best Practices **WholeGenomeGermlineSingleSample** for preprocessing and initial germline SNP/Indel calling through `UnmappedBamToAlignedBam`, `AggregatedBamQC`, `Qc`, `BamToCram`, `VariantCalling` and `GermlineStructs`, plus somatic Mutect2 examples [12]. The CromwellOnAzure GitHub repository was archived by its owner on **2025-07-28** and is read-only, so it is reference code, not an actively maintained managed service [28].

Nextflow is actively usable on Azure Batch. Nextflow’s Azure documentation says it supports Azure Blob Storage and Azure Batch, with `process.executor = 'azurebatch'` and `workDir = 'az://<BLOB_CONTAINER>/work'`; Nextflow creates an Azure Batch task per Nextflow task, downloads inputs from Blob to the node, runs the process script/container and uploads outputs back to Blob, with autoscale/delete-pool options [13]. nf-core provides an **azurebatch** profile requiring storage account key or SAS, Batch account/key, `az_location` default **westus2**, `vm_type` default **Standard_E*d_v5**, and optional Azure Container Registry credentials for private Docker images; the page was last modified **2025-03-12** [14].

Azure should be treated as self-managed for DRAGEN, Sentieon and any Microsoft Genomics Data Lake/Fabric/OneLake-style architecture: the grounded Azure genomics materials cover Batch, CycleCloud, Nextflow, nf-core and Cromwell-on-Azure rather than a Microsoft-managed service equivalent to HealthOmics or Terra [12], [13], [14], [5], [6].

## 3. HIPAA and GDPR compliance posture

| Compliance issue | AWS | Google Cloud / Terra | Azure |
|---|---|---|---|
| HIPAA program | HealthOmics is described as HIPAA-eligible [2]; HealthLake is a fully managed HIPAA-eligible FHIR service [15]. | Google says HIPAA compliance is shared, no HHS HIPAA certification exists, and Google enters into BAAs as needed [17]. Covered products include Batch, BigQuery, Cloud Healthcare API, Cloud HSM, Cloud KMS, Cloud Logging/Monitoring, Cloud NAT, Cloud Storage, Compute Engine, Persistent Disk and Vertex AI Workbench [17]. | Microsoft offers a HIPAA BAA via Microsoft Product Terms and the Microsoft Products and Services Data Protection Addendum; Microsoft states execution of the customer’s volume licensing agreement includes execution of the HIPAA BAA for in-scope services [18]. |
| Service exclusions / constraints | HealthLake is FHIR clinical data; it does not make HealthOmics a clinical decision service [15]. | Customers must disable or avoid products not explicitly covered by the BAA and must not use Pre-GA offerings with PHI unless expressly permitted [17]. | Microsoft states a BAA does not by itself make a customer solution HIPAA-compliant; the customer remains responsible for application compliance [18]. |
| GDPR / DPA / SCC basis | AWS ISO page shows AWS certifies ISO/IEC **27001:2022**, **27017:2015**, **27018:2019**, **27701:2019**, **22301:2019**, **20000-1:2018**, **9001:2015** and CSA STAR CCM v4.0; HealthOmics, HealthLake, Batch, S3, EBS, KMS, CloudHSM, Lake Formation, Athena, CloudWatch/Logs, CloudTrail, Direct Connect and DataZone are listed in ISO scope [16]. | Google’s HIPAA list covers the key services used by Terra workflows, and Google’s ISO/IEC 27001 compliance page provides the ISO compliance basis for Google Cloud; detailed DPA/SCC terms are not in the cited record [17], [29]. | Azure HIPAA page references Microsoft Product Terms and Microsoft Products and Services DPA, and states Azure/Azure Government align to NIST CSF and are certified under ISO/IEC 27001; detailed GDPR/SCC and per-service ISO 27701/27018 coverage are not in the cited record [18]. |
| EU residency / customer keys | HealthOmics has EU regions **eu-central-1**, **eu-west-1**, **eu-west-2**; HealthLake has **eu-west-1**, **eu-west-2**, **eu-central-1**, **eu-north-1**; AWS ISO scope includes KMS and CloudHSM [19], [22], [16]. | Terra/Google workflows are built from Cloud Storage, Compute/Batch, BigQuery, KMS/HSM and covered services; Google Cloud BAA covers all regions/zones/network paths, but exact Terra workspace region controls are not specified in the cited notes [17], [3]. | Azure Batch keeps customer data in the region where deployed; Azure Batch/Nextflow uses Blob Storage and Batch accounts in configured regions [5], [13]. |

**Compliance verdict:** All three clouds can support HIPAA/GDPR-style controls when deployed in covered services with signed BAAs/DPAs and region/key controls, but only AWS has named genomics services in both HIPAA-eligible and ISO-scope records here. Google has the strongest explicit HIPAA coverage for the primitive services used by Terra workflows. Azure has a broad Microsoft BAA/DPA posture but lacks a current managed genomics service.

## 4. China legal compliance and simultaneous HIPAA/GDPR/China feasibility

The named managed-service region lists are decisive: **AWS HealthOmics regions do not include mainland China**, and **AWS HealthLake regions do not include mainland China** in the AWS endpoint/region docs [19], [22]. Microsoft Genomics is retired globally as of **2025-01-06**, so it is not available as a current managed genomics service in any region [1]. Google Cloud Healthcare API is a clinical-data API rather than a genomics workflow engine, and Terra’s cited execution model is Google Batch/Compute and Cloud Storage workspaces rather than a mainland-China deployment record [3], [4].

For Chinese human genomic data, the legally relevant regime is more restrictive than ordinary cloud residency because human genetic resources and large-scale personal information are regulated by China’s Personal Information Protection Law, Data Security Law, Cybersecurity Law, Biosecurity Law and the human genetic resources/HGRAC regime. None of the named managed-genomics options provides a single deployment pattern satisfying HIPAA, GDPR and China HGRAC/cross-border controls simultaneously: AWS’s named HealthOmics/HealthLake region lists exclude mainland China, Terra runs on Google Batch/Compute/Cloud Storage workspaces rather than a China-local managed genomics service, and Microsoft Genomics is retired [19], [22], [3], [1]. The practical branch is therefore:

* **If China data localization is mandatory:** do not select HealthOmics or Terra as a single global managed platform for Chinese human-genome data. Use a China-local architecture with local legal review and in-country compute/storage; Azure-style generic Batch/HPC patterns are the most portable among the cited Azure primitives, but Microsoft Genomics itself is retired [1], [5].
* **If China is not in scope for raw identifiable genomic data:** use AWS HealthOmics or Terra/Google in US/EU regions with HIPAA/GDPR controls; keep Chinese datasets out of the managed global platform or process only permitted/approved derived outputs.

## 5. Federated analysis across institutions

**Terra/Google ranks first for federation readiness.** Terra is already framed around collaborative workspaces, WDL/Cromwell, Dockstore and AnVIL components. Dockstore is GA4GH-compliant and provides export connectors to Terra; Terra/AnVIL uses Broad Cromwell and includes notebooks/RStudio/Galaxy for interactive analysis [9], [21]. This makes Terra the best fit for cross-institution research networks such as AnVIL-style collaboration when data and workflows can stay in Google/Terra workspaces.

**AWS ranks second.** HealthOmics provides managed genomics stores and analytics, and its adjacent AWS services include Lake Formation and Athena for analytics access; the AWS ISO scope list also includes DataZone and Lake Formation [2], [16]. However, the cited HealthOmics documents establish cross-account/cloud building blocks, not GA4GH DRS/TES/WES/TRS/Passports/Visa support for HealthOmics itself.

**Azure ranks third for managed-genomics federation but remains viable for enterprise federation.** Azure Batch/CycleCloud and Nextflow-on-Azure can support cross-tenant enterprise designs using Azure identity and storage patterns, but the cited genomics sources establish Cromwell/Nextflow execution rather than GA4GH-native federation [12], [13], [14].

## 6. Variant-calling benchmark normalization and performance evidence

A normalized 100,000-WGS comparison should use one benchmark definition across all platforms:

| Benchmark input | Normalized assumption for decision model | Grounded support |
|---|---:|---|
| Samples | **100,000 whole genomes/year** | User workload. |
| Sequencing depth | **30x human WGS** | HealthOmics Ready2Run catalog explicitly lists 30x genome GATK and Parabricks WGS workflows [8]. |
| Variant outputs | gVCF/VCF for germline short variants; optional joint genotyping | HealthOmics variant stores support gVCF/VCF; Terra GATK WGS workflows produce GVCF and QC metrics [2], [10]. |
| Pipeline families | GATK Best Practices HaplotypeCaller and/or DeepVariant/Parabricks | HealthOmics Ready2Run includes Broad GATK-BP and NVIDIA Parabricks DeepVariant/HaplotypeCaller; Terra includes GATK Best Practices and DeepVariant examples [8], [10], [11]. |
| Reference/accuracy | GRCh38 and GIAB precision/recall/F1 are the appropriate comparator for a production benchmark; the cited platform sources provide runtime/cost examples but not a common GIAB F1 table across all three clouds. | Platform sources cited for runtime/tooling, not a shared accuracy benchmark. |

Published/cited performance is not apples-to-apples, so ranking must separate **managed benchmark evidence** from **raw cloud potential**:

| Platform | Cited runtime/cost evidence | Scaling/retry evidence | Decision interpretation |
|---|---|---|---|
| AWS HealthOmics | Ready2Run 30x **Parabricks DeepVariant 2:00**, 30x **Parabricks HaplotypeCaller 1:15**, GATK-BP **fq2vcf 12:30**, GATK-BP **bam2vcf 2:45** [8]. | Active GPUs default **12/Region**, up to **500** auto-approved in us-east-1/us-west-2; concurrent tasks per run **25**, up to **100** auto-approved [19]. | Best cited managed performance evidence; GPU-accelerated Parabricks path is fastest in the cited record. |
| Google/Terra | GATK4 tutorial NA12878 **64.89 GB**, **22:35**, **$5.23**; WGS JointGenotyping **4:05**, **$7.93**; GATK-SV NA12878 **18.17 GiB**, **23 hrs**, **~$7.71** [11]. | Terra: **3,000 concurrent workflows/user**, **30,000 jobs** in Cromwell, **28,800 jobs** submitted on user’s behalf; preemptible preemption restarts after delay and large input localization is billable [3]. | Best research-workspace evidence; not directly comparable to AWS 30x FASTQ-to-VCF Ready2Run timings. |
| Azure | Cromwell-on-Azure demonstrates GATK WDL pipelines; Nextflow on Azure Batch supports task-per-process execution [12], [13]. | Azure Batch can scale parallel jobs to the amount of compute available and supports Spot/auto-scaling; data remains in-region [5]. | Performance depends on self-managed VM/SKU/storage design; the cited record has no comparable 30x WGS runtime/cost table. |

## 7. 100,000-WGS annual workload model and TCO implications

A procurement-ready TCO should price the same workload against live regional price books for compute, object storage, scratch disks/filesystems, workflow orchestration, KMS, monitoring/logging, support and network transfer. The grounded platform evidence here supports a normalized workload and relative TCO ranking, while exact annual dollars must be calculated from the customer’s chosen region, SKU mix and retention policy:

| Workload component | Normalized annual model | Basis |
|---|---:|---|
| Workflow runs | **100,000 primary WGS runs/year**; add reruns explicitly in procurement, e.g., 5% rerun rate would create **105,000 total workflow runs/year** | User workload; rerun rate is a buyer assumption. |
| Platform benchmark | **30x WGS** GATK/DeepVariant family | HealthOmics Ready2Run 30x catalog and Terra GATK/DeepVariant workspaces [8], [10], [11]. |
| Output artifacts | CRAM/BAM, gVCF/VCF, QC metrics/logs; optional joint-genotyping tables | Terra GATK WGS outputs GVCF/QC metrics; HealthOmics supports gVCF/VCF stores [2], [10]. |
| Compute concurrency | AWS: plan GPU quota increase to hundreds if using Parabricks; Terra: plan around 3,000 workflows/user and 30,000 Cromwell jobs; Azure: plan Batch pool quotas/VM capacity | [19], [3], [5]. |
| Storage/control plane | AWS: S3/ECR/HealthOmics stores; Google/Terra: Cloud Storage workspace buckets, Batch/Compute; Azure: Blob Storage plus Batch/CycleCloud | [2], [3], [13], [5]. |

**TCO ranking from grounded evidence, not exact published price tables:**

1. **Lowest likely managed execution cost for GATK-style research workflows: Google/Terra**, because the cited Terra examples show NA12878 GATK4 tutorial at **$5.23** and WGS joint genotyping at **$7.93**, but those examples are not full 30x FASTQ-to-VCF production WGS [11].
2. **Best throughput-per-run evidence: AWS HealthOmics**, because the Ready2Run GPU workflows show 30x Parabricks HaplotypeCaller at **1:15** and DeepVariant at **2:00**; price HealthOmics runs, S3 tiers, NAT, KMS and logs from the selected region’s live price book before contract signature [8].
3. **Most variable TCO: Azure**, because Batch itself has no extra service charge beyond VMs/storage/networking, but total cost depends on VM SKU, storage, network and workflow implementation; Microsoft Genomics no longer provides a managed price envelope [1], [5].

## 8. Data egress traps to treat as design blockers

The main egress risk is architectural: petabyte-scale genomics turns even low per-GB network charges, NAT processing charges, inter-region replication and cloud-to-cloud transfer into major cost drivers.

* **AWS:** HealthOmics uses S3, ECR, sequence/variant/annotation stores, Lake Formation/Athena and notebook/analytics services [2]. Cross-region replication, cross-cloud data sharing, internet downloads and private-container pulls can dominate cost when repeated over petabytes; same-region processing should be the default design.
* **Google/Terra:** Terra localizes Cloud Storage inputs to Batch/Compute VMs and writes outputs/logs back to workspace buckets [3]. Large input localization time is explicitly billable on GCP, and cross-workspace/cloud exports can create hidden network and storage duplication costs [3].
* **Azure:** Nextflow on Azure Batch downloads inputs from Blob to assigned compute nodes and uploads outputs back to Blob for each task [13]. Poorly placed Blob containers, Batch pools, shared filesystems or cross-tenant/cloud copies can multiply I/O and egress costs; Batch itself does not add a fee, but VMs/storage/networking do [5].

For all three providers, the procurement control should require: same-region compute/storage by default; no routine internet egress for raw FASTQ/BAM/CRAM; no cloud-to-cloud movement of raw genomes except approved migrations; explicit budgets for NAT/private-link/interconnect and logging; and collaborator access patterns that analyze in place rather than copy datasets.

## 9. Final recommendation

**Preferred default:** Choose **AWS HealthOmics** if the company wants a production managed genomics platform for 100,000 WGS/year, especially if standardizing on 30x GATK/DeepVariant pipelines, managed sequence/variant/annotation stores and AWS security controls. Its decisive advantages are current managed-service status, WDL/Nextflow/CWL support, Ready2Run GATK/DeepVariant/Sentieon/nf-core catalog, 30x runtime examples, and named HealthOmics/HealthLake HIPAA and ISO-scope support [7], [8], [2], [16].

**Preferred federation/research-network branch:** Choose **Google Cloud with Terra** when cross-institution collaboration, AnVIL-style workspaces, Dockstore/WDL portability, GATK Best Practices workspaces and notebooks are more important than a single hyperscaler-managed genomics service. Do not treat Cloud Healthcare API as the analysis engine; use it for clinical FHIR/HL7v2/DICOM data, with Terra/Batch/Compute for workflows [3], [9], [4], [10].

**Azure branch:** Use **Azure Batch/CycleCloud/Nextflow** only if enterprise standardization on Azure, in-region generic HPC control, or a China-local generic-compute architecture outweighs the lack of a managed genomics platform. Microsoft Genomics retired on **2025-01-06 22:59:59.999 PT**, and Cromwell-on-Azure is archived reference code, so Azure should not be scored as a like-for-like managed alternative to HealthOmics or Terra [28], [1], [5], [6].

**China-localization branch:** If identifiable human genomic data must remain under mainland China/HGRAC-style controls, do not attempt a single global managed deployment spanning HIPAA, GDPR and China with the named services. AWS HealthOmics/HealthLake regions exclude mainland China, Terra’s execution model is Google Batch/Compute/Cloud Storage rather than a China-local genomics service, and Microsoft Genomics is retired [19], [22], [3], [1]. Build a separate China-local processing architecture and exchange only legally approved derived outputs.

**Overall ranking:**

1. **AWS HealthOmics** — best managed genomics and production WGS-throughput evidence.
2. **Google Cloud/Terra** — best federation and Broad/GATK research ecosystem; not a Cloud Healthcare API analysis story.
3. **Azure Batch/CycleCloud** — viable generic HPC fallback, but Microsoft Genomics retirement removes Azure from the managed-genomics shortlist.

## Sources

1. [Microsoft Genomics - Microsoft Lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/microsoft-genomics)
2. [What is AWS HealthOmics? - AWS HealthOmics](https://docs.aws.amazon.com/omics/latest/dev/what-is-healthomics.html)
3. [Overview: Running workflows in Terra](https://support.terra.bio/hc/en-us/articles/360036379771-Overview-Running-workflows-in-Terra)
4. [Cloud Healthcare API](https://cloud.google.com/healthcare-api)
5. [Azure Batch runs large parallel jobs in the cloud - Azure Batch](https://learn.microsoft.com/en-us/azure/batch/batch-technical-overview)
6. [Overview - Azure CycleCloud](https://learn.microsoft.com/en-us/azure/cyclecloud/overview)
7. [Version support for HealthOmics workflow definition languages - AWS HealthOmics](https://docs.aws.amazon.com/omics/latest/dev/workflows-lang-versions.html)
8. [Available Ready2Run workflows in HealthOmics - AWS HealthOmics](https://docs.aws.amazon.com/omics/latest/dev/workflows-r2r-table.html)
9. [How to import a workflow and its parameter file from Dockstore into Terra](https://support.terra.bio/hc/en-us/articles/360038137292-How-to-import-a-workflow-and-its-parameter-file-from-Dockstore-into-Terra)
10. [GATK on the cloud, with Terra](https://gatk.broadinstitute.org/hc/en-us/articles/4524513257499-GATK-on-the-cloud-with-Terra)
11. [Costs of selected featured workflows](https://support.terra.bio/hc/en-us/articles/7420514067995-Costs-of-selected-featured-workflows)
12. [Cromwell on Azure | Jekyll theme for documentation](https://microsoft.github.io/Genomics-Community/cromwell.html)
13. [docs/azure.md at master · nextflow-io/nextflow](https://github.com/nextflow-io/nextflow/blob/master/docs/azure.md)
14. [nf-core](https://nf-co.re/configs/azurebatch/)
15. [Healthcare Analytics & FHIR Server Service - Amazon HealthLake - AWS](https://aws.amazon.com/healthlake/)
16. [ISO Certified](https://aws.amazon.com/compliance/iso-certified/)
17. [HIPAA Compliance on Google Cloud  |  GCP Security](https://cloud.google.com/security/compliance/hipaa)
18. [HIPAA - Azure Compliance](https://learn.microsoft.com/en-us/azure/compliance/offerings/offering-hipaa-us)
19. [Service quotas and endpoints for AWS HealthOmics - AWS General Reference](https://docs.aws.amazon.com/general/latest/gr/healthomics-quotas.html)
20. [Regionen  |  Cloud Healthcare API  |  Google Cloud Documentation](https://cloud.google.com/healthcare-api/docs/regions)
21. [How Terra fits within the AnVIL ecosystem - Terra](https://terra.bio/how-terra-fits-within-the-anvil-ecosystem/)
22. [AWS HealthLake endpoints and quotas - AWS HealthLake](https://docs.aws.amazon.com/healthlake/latest/devguide/reference-healthlake-endpoints-quotas.html)
23. [Migrate to Batch from Cloud Life Sciences
       

    
     

     
      
      Stay organized with collections
     
     
      
      Save and categorize content based on your preferences.](https://cloud.google.com/batch/docs/migrate-to-batch-from-cloud-life-sciences)
24. [Azure Health Data Services regional availability of services and features](https://learn.microsoft.com/en-us/azure/healthcare-apis/services-features-regional-availability)
25. [GitHub - google/deepvariant: DeepVariant is an analysis pipeline that uses a deep neural network to call genetic variants from next-generation DNA sequencing data.](https://github.com/google/deepvariant)
26. [deepvariant/docs/deepvariant-quick-start.md at r1.10 · google/deepvariant](https://github.com/google/deepvariant/blob/r1.10/docs/deepvariant-quick-start.md)
27. [deepvariant/docs/deepvariant-gcp-info.md at 45f2627504c59785ea2b88d0256a2ec347bce7b4 · google/deepvariant](https://github.com/google/deepvariant/blob/45f26275/docs/deepvariant-gcp-info.md)
28. [GitHub - microsoft/CromwellOnAzure: Microsoft Genomics implementation of the Broad Institute's Cromwell workflow engine on Azure](https://github.com/microsoft/CromwellOnAzure)
29. [ISO/IEC 27001 - Compliance | Google Cloud](https://cloud.google.com/security/compliance/iso-27001)