# The State of Deepfake Detection Research Since 2022: Methods, Performance, Ethics, and Regulation

## 1. Overview

Since 2022, deepfake detection has matured into two parallel but converging research streams — visual (face/video) forgery detection and speech/audio spoof detection — increasingly joined by multimodal audio-visual approaches and the integration of large pretrained foundation models. Two themes dominate the recent literature. First, on standard in-domain benchmarks, detectors have nearly saturated performance (AUC > 0.99 on FaceForensics++, accuracy > 98% on FakeAVCeleb), yet performance collapses under cross-dataset, cross-generator, and real-world degradation conditions. Second, the policy environment has moved quickly, with the EU AI Act, multiple US federal and state laws, China's deep synthesis rules, and the UK Online Safety Act all enacting transparency or criminal provisions. The threat backdrop is substantial: one industry analysis cited in the literature reports a 10× increase in deepfake-based fraud cases from 2022 to 2023, and a study finding ~70% of people cannot reliably distinguish a real voice from a deepfake voice [1].

## 2. Video / Visual Deepfake Detection Methods

State-of-the-art video detection since 2022 has shifted from pure CNNs (Xception, EfficientNet) toward transformer and hybrid architectures, while a parallel line exploits self-supervised "blending"/consistency objectives for generalization [1].

**Transformer and hybrid architectures (named models):**
- **TALL / TALL++** (Xu et al., ICCV 2023; IJCV 2024) — "Thumbnail Layout": randomly sampled frames are arranged into a single thumbnail image processed by a **Swin Transformer** plus a GCN to capture spatiotemporal inconsistency [1].
- **Efficient ViT** (Coccomini et al., ICIAP 2022) — combines EfficientNet with a Vision Transformer [1].
- **M2TR** (multimodal/multi-scale transformer) and **FADE** (Facial Action Dependencies Estimation, AAAI 2023) [1].
- Sequential-patch transformers (Guan et al., NeurIPS 2022) and **Video-Level Blending + Spatiotemporal Adapter Tuning** (Yan et al., 2024) [1].

**Generalization-oriented data/self-supervision methods:**
- **Self-Blended Images (SBI)** (Shiohara & Yamasaki, CVPR 2022) — synthesizes hard fake samples (on an EfficientNet-b4 backbone) to force the model to learn general forgery traces [2].
- Self-supervised adversarial example learning (Chen et al., CVPR 2022) and **Implicit Identity Leakage** analysis (Dong et al., CVPR 2023) [1].

The survey's qualitative conclusion: on easier datasets, both CNN and transformer detectors are near-flawless, but **on the harder DFDC and Celeb-DF datasets, ViT-based architectures are superior**; newer diffusion-generated faces (e.g., the DiffusionFace dataset) pose a markedly greater challenge to all current detectors [1].

## 3. Audio / Speech Deepfake Detection Methods

The dominant paradigm pairs a **self-supervised front-end** (wav2vec 2.0 / XLSR, WavLM) with a graph- or transformer-based back-end, with **RawNet2** and **AASIST** serving as the field's reference systems [3][1].

**Named systems:**
- **RawNet2** (Tak et al., ICASSP 2021) — a learnable SincNet filter plus six ResNet blocks operating directly on the raw waveform; it is the official ASVspoof challenge baseline and one of the most reproducible models [3][1].
- **AASIST / RawGAT-ST** — spectro-temporal **graph attention** back-ends; GNN-based methods achieve the lowest EERs on ASVspoof [1][3].
- **wav2vec 2.0-XLSR front-ends** feeding AASIST, MLP, or transformer back-ends, often with **RawBoost** data augmentation [3].
- **Rawformer** (ICASSP 2023) — RawNet2 front-end with a transformer back-end [3].

## 4. Benchmark Performance Metrics

### 4.1 Video (AUC / accuracy)

From the survey's compiled tables (FF++, DFDC, Celeb-DF) [1]:

| Dataset | Method | Accuracy | AUC |
|---|---|---|---|
| FaceForensics++ | TALL++ | 98.65% | 0.9987 |
| FaceForensics++ | LipForensics | 98.90% | 0.9970 |
| FaceForensics++ | M2TR | 97.93% | 0.9951 |
| FaceForensics++ | RealForensics | – | 0.9900 |
| DFDC | Efficient ViT | – | 0.9510 |
| DFDC | TALL++ | – | 0.9068 |
| DFDC | RealForensics | – | 0.7590 |
| DFDC | LipForensics | – | 0.7350 |
| Celeb-DF | App.+Beh. | 98.50% | 0.9900 |

The contrast between near-perfect FF++ AUCs and the much lower DFDC AUCs (down to ~0.74 for LipForensics) is itself evidence of the generalization gap.

### 4.2 Audio (EER, %)

Single-system SOTA on the ASVspoof series, lower EER is better [3]:

| System (front-end → back-end) | 19-LA | 21-LA | 21-DF |
|---|---|---|---|
| wav2vec2.0-XLSR + AASIST (RawBoost) | – | 0.82 | 2.85 |
| RawNet2 + GAT | 0.83 | 5.59 | – |
| Rawformer | 0.59 | 4.98 | 4.53 |
| SDC+Bi-LSTM → SE-ResNeXt (ICASSP'24) | 0.22 | 3.50 | 3.41 |
| wav2vec2.0-XLSR + MLP | 0.31 | – | – |

On the multimodal FakeAVCeleb benchmark, top systems are also near-saturated: **FRADE** 98.60% acc / 0.9980 AUC, **AVFF** 98.60% / 0.9910; on DFDC, FRADE reaches 97.20% and PVASS-MDD 96.30% accuracy [1].

## 5. Cross-Dataset Generalization

Generalization is the central unsolved problem, and the gap is large and consistent across modalities.

**Audio (trained on ASVspoof19-LA, tested on the In-the-Wild "ITW" set)** [3]:

| System | EER on 19-LA | EER on In-the-Wild |
|---|---|---|
| INTERSPEECH'23 (wav2vec2.0-XLSR, LCNN→Transformer) | 0.63% | 24.50% |
| ECAPA-TDNN (SPL'24) | 1.79% | 29.66% |
| CNN→wav2vec2.0 AASIST (ICASSP'24) | 0.39% | 7.68% |
| wav2vec2.0-XLSR-Vox MLP (ICASSP'24) | 0.13% | 12.50% |

That is an order-of-magnitude degradation — systems at ~0.1–0.6% EER in-domain rise to 7.7–29.7% EER on realistic, unseen data [3].

**Video (cross-dataset and cross-generator):** Detectors trained on FF++ score "very low" when tested on Celeb-DFv1/v2 [2]. The survey's own **BioDeepAV** benchmark (out-of-distribution talking faces from novel generators) shows that F3Net, StA, XceptionNet (FF++-trained) and MRDF (FakeAVCeleb-trained) all exceed 90% AUC in-domain but register **drops larger than 30% AUC** on BioDeepAV, demonstrating failure against unseen generative models [1].

**Named generalization methods:** CLIP/foundation-model adapters (Section 6), SBI and self-blending data synthesis [2], domain-adaptation/meta-learning/self-supervised pretraining pipelines [4], and fairness-generalization training (Lin et al., CVPR 2024) [1].

## 6. Foundation Model Integration

A clear recent trend is adapting large pretrained encoders — especially **CLIP** — for generalizable detection. The **Forensics Adapter (ForAda)** attaches a lightweight adapter to CLIP's ViT image encoder and is trained only on FF++ (c23) [5]. Reported frame-level cross-dataset AUC vs. classic CNN baselines [5]:

| Method | Celeb-DF-v2 | DFDC | DFDCP |
|---|---|---|---|
| Xception (ICCV'19) | 0.737 | 0.708 | – |
| EfficientNet-B4 | 0.749 | – | – |
| Vanilla CLIP (video-level) | 0.777 | 0.742 | – |
| RepDFD (AAAI'25, video-level) | 0.899 | 0.810 | – |
| **Forensics Adapter (frame-level)** | 0.900 | 0.843 | 0.890 |
| **Forensics Adapter (video-level)** | 0.957 | 0.872 | – |

The gains over Xception/EfficientNet (roughly +15–20 AUC points on Celeb-DF-v2 and DFDC) illustrate why CLIP-based adapters have become a leading generalization strategy [5].

## 7. Multimodal Audio-Visual Detection

Audio-visual methods exploit inconsistencies between the two streams (lip-sync, synchrony, emotional coherence) [1]:
- **Joint AV detection** (Zhou & Lim, ICCV 2021) — leverages cross-modal synchronization with inter-attention late fusion [1].
- **Audio-visual person-of-interest** detection (Cozzolino et al., CVPR 2023) [1].
- **Self-supervised AV anomaly detection** (Feng, Chen & Owens, CVPR 2023) — autoregressive transformers flag low-probability AV sequences [1].
- **AVFF** (Oorloff et al., CVPR 2024) — two-stage feature fusion with contrastive learning/autoencoders, then transformer fine-tuning [1].
- **FRADE** (ACMMM 2024) — forgery-aware audio-distilled cross-modal interaction [1].
- **AVoiD-DF** (IEEE TIFS 2023), **AVFakeNet** (dense Swin Transformer), **MRDF** (cross/within-modality regularization, ICASSP 2024), **MIS-AVoiDD**, and **PVASS-MDD** [1].

Reported metrics (FakeAVCeleb): FRADE 0.9980 AUC, AVFF 0.9910 — benchmarks the survey describes as "nearly saturated" [1].

## 8. Privacy-Preserving Detection and Provenance

Two complementary directions address privacy and trust:
- **Federated / on-device learning:** **FL-TENB4**, a Federated-Learning-Enhanced Tiny EfficientNetB4-Lite model for deepfake detection in CCTV environments, keeps data on-device for privacy and low-latency real-time use . Related work includes **FL-GAP** (graph-based adaptive personalization for federated detection) and lightweight federated detection with binarized ViTs/temporal transformers .
- **Watermarking / provenance:** Google DeepMind's **SynthID** embeds imperceptible watermarks into AI-generated image, audio, video, and text to enable later identification [6]; **SynthID-Image** reports watermarking over ten billion images and video frames across Google services . The industry **C2PA Content Credentials** standard provides cryptographic provenance metadata . These are proactive (label-at-generation) complements to reactive (classify-after-the-fact) detection.

## 9. Benchmark vs. Real-World Performance Gap

The gap between controlled benchmarks and deployment is the most consistently documented finding. A dedicated assessment framework (Le et al., EURASIP J. Image & Video Processing, 2024) — described as the first to systematically evaluate detectors under realistic processing — applied compression (H.264 at C23/C40), noise, blur, resolution reduction, and gamma correction to test data [2]. Key results [2]:
- All four detectors evaluated (XceptionNet, Capsule-Forensics, UIA-ViT, and SBI/EfficientNet-b4) degrade under real-world processing; **noise and blurriness are the most prominent degraders**.
- Even **UIA-ViT**, known for strong cross-dataset generalization, degrades under perturbations.
- **SBI** generalizes well cross-dataset yet remains susceptible to compression, noise, and low resolution.
- The proposed **SDAug** (stochastic degradation augmentation) improves robustness while largely preserving clean accuracy; naively training on compressed data improves robustness but drops clean-data AUC by ~0.5–1% [2].

Combined with the audio In-the-Wild results (order-of-magnitude EER increases) [3] and the >30% video AUC drops on unseen generators [1], the evidence shows that benchmark leaderboard numbers substantially overstate field performance against compression, social-media degradation, and novel generators.

## 10. Ethical Concerns

Researchers identify several recurring ethical issues:
- **Non-consensual intimate imagery (NCII):** the term "deepfake" itself originated in 2017 with non-consensual sexual content; large-scale surveys (CHI 2024, 10 countries, 16,000+ respondents) and USENIX SOUPS 2024 work document the prevalence and perceived harm of deepfake pornography as a "violation of the body" [1] (and corroborating literature).
- **Disinformation and erosion of public trust:** the survey frames deepfakes as a "critical threat to public trust and democracy," amplified by social-media spread and a documented 10× rise in deepfake fraud from 2022 to 2023 [1].
- **Detector demographic bias:** Trinh & Liu show that three popular detectors exhibit up to a **10.7% error-rate difference between racial subgroups**; BI-trained detectors perform worst on darker/African faces, and false-positive rates for some Asian/African subgroups reach up to 3× the M-Caucasian reference [7]. Gender error-rate differences are small (0.1–0.3%) but female-subject FPR can be nearly double male FPR (e.g., Xception+BI: 7.7% vs 14.0%) [7]. Crucially, high aggregate AUC (up to 0.962) and accuracy (90.1%) mask these subgroup disparities, so aggregate metrics are insufficient to justify deployment [7]. This bias is partly traced to FF++ being overwhelmingly composed of Caucasian (especially female) subjects [7]. Fairness-oriented methods (Lin et al., CVPR 2024; Ju et al., WACV 2024) have emerged in response [1].
- **Dual-use:** the same generative advances that improve synthesis also enable adversarial evasion of detectors, and detection tooling can itself be misused, motivating explainable/trustworthy detection (e.g., dynamic-prototype methods) [1].

## 11. Regulatory Frameworks

### 11.1 European Union
- **EU AI Act (Regulation (EU) 2024/1689):** entered into force 1 August 2024, with transparency obligations applying from **2 August 2026** [4]. **Article 50** requires: providers of generative AI to mark synthetic audio/image/video/text in a machine-readable, detectable format; and **deployers of AI that generates or manipulates image/audio/video constituting a "deep fake" to disclose that the content is artificially generated or manipulated** (with limited, non-intrusive disclosure for artistic/satirical works). Disclosure must be clear at first interaction/exposure; law-enforcement and human-editorial-review exemptions apply, and the AI Office is to facilitate codes of practice for detection and labelling [4].
- The **Digital Services Act** complements this with platform obligations on illegal content and systemic risks (referenced as part of the EU framework).

### 11.2 United States
- **TAKE IT DOWN Act — Public Law 119-12**, enacted **19 May 2025** ("Tools to Address Known Exploitation by Immobilizing Technological Deepfakes on Websites and Networks Act"). It amends Section 223 of the Communications Act of 1934 (47 U.S.C. 223) to create a federal criminal prohibition on knowingly publishing non-consensual intimate visual depictions, **explicitly including "digital forgery"** — defined as an intimate depiction created through software, machine learning, or AI that, viewed as a whole, "is indistinguishable from an authentic visual depiction of the individual" [8]. Section 3 requires covered platforms to establish a notice-and-removal process within one year of enactment and to **remove a reported depiction within 48 hours**, including reasonable efforts to remove identical copies, enforced by the Federal Trade Commission [8].
- **DEFIANCE Act of 2024 (S. 3696)** — "Disrupt Explicit Forged Images and Non-Consensual Edits Act"; introduced 30 January 2024, passed the Senate, creating a federal **civil action** for victims of non-consensual intimate "digital forgeries" by amending 15 U.S.C. 6851 (Consolidated Appropriations Act, 2022) [8] (status per congressional record).
- **State laws:** **Texas SB 751** (2019) criminalizes fabricating a deceptive video with intent to influence an election (Election Code §255.004); **California AB 730** (2019–2020) barred materially deceptive election deepfakes within 60 days of an election (with a sunset); **California AB 602** created a civil cause of action for non-consensual sexual deepfakes [search results].

### 11.3 China
- **Provisions on the Administration of Deep Synthesis Internet Information Services** — promulgated 25 November 2022, effective **10 January 2023** (CAC/MIIT/MPS). Key provisions: deep synthesis providers must add **prominent labels** to AI-generated content and may not remove/alter/conceal them; must obtain the **consent of individuals** whose biometric (face/voice) information is edited; must conduct security assessments and file with regulators where services have public-opinion or social-mobilization capacity, with administrative penalties and criminal liability where applicable [9].

### 11.4 United Kingdom and International
- **UK Online Safety Act 2023 (c. 50):** Section 188 inserts offence "66B" into the Sexual Offences Act 2003, criminalizing sharing (or threatening to share) intimate photographs or films that "show, or **appear to show**" a person in an intimate state without consent — language that captures deepfakes [search results].
- **International standardization:** the ASVspoof challenge series (including **ASVspoof 5 / 2024**, built from crowdsourced speech with adversarial attacks introduced for the first time) functions as the de facto international evaluation framework for audio spoof/deepfake detection [search results].

## 12. Synthesis and Trade-offs

Ranking the maturity of approaches by current evidence: **multimodal audio-visual detection** and **in-domain unimodal detection** are the most benchmark-saturated (AUC ≥ 0.99), but this saturation is partly an artifact of benchmark homogeneity. **Foundation-model (CLIP) adapters** currently offer the best demonstrated cross-dataset generalization for video (e.g., +15–20 AUC points over Xception on Celeb-DF-v2/DFDC) [5]. **Audio detection** is extremely strong in-domain (EER < 1%) but the most fragile under distribution shift (EER 7.7–29.7% on In-the-Wild) [3]. **Privacy-preserving and watermarking** approaches are the least mature as standalone detectors but valuable as proactive provenance complements [6].

The overriding trade-off is **benchmark performance vs. real-world robustness and fairness**: detectors that top leaderboards degrade by >30% AUC on unseen generators [1], by an order of magnitude in EER on in-the-wild audio [3], and exhibit double-digit error-rate gaps across demographic subgroups [7]. Regulation has responded primarily through **transparency/labeling** (EU AI Act Article 50, China deep synthesis rules) and **harm-specific criminalization** (TAKE IT DOWN Act, DEFIANCE Act, UK OSA), rather than mandating detection accuracy — implicitly acknowledging that current detection cannot be relied upon as the sole safeguard.

## Sources

1. [Deepfake Media Generation and Detection in the Generative AI Era: A Survey and Outlook](https://arxiv.org/html/2411.19537)
2. [Assessment framework for deepfake detection in real-world situations - Journal on Image and Video Processing](https://link.springer.com/article/10.1186/s13640-024-00621-8)
3. [2404.13914v2](http://www.arxiv.org/pdf/2404.13914v2)
4. [AI Act Service Desk - Article 50: Transparency obligations for providers and deployers of certain AI systems](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-50)
5. [Forensics Adapter: Unleashing CLIP for Generalizable Face Forgery Detection](https://arxiv.org/html/2411.19715v3)
6. [SynthID](https://deepmind.google/models/synthid/)
7. [An Examination of Fairness of AI Models for Deepfake Detection](https://ar5iv.labs.arxiv.org/html/2105.00558)
8. [PLAW-119publ12.pdf](https://www.govinfo.gov/content/pkg/PLAW-119publ12/pdf/PLAW-119publ12.pdf)
9. [Provisions on the Administration of Deep Synthesis Internet Information Services](https://www.chinalawtranslate.com/en/deep-synthesis/)