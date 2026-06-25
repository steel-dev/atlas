# Current state of deepfake detection research and governance since 2022

## Executive summary

Since 2022, deepfake detection research has moved from single-frame artifact classifiers toward systems that combine (i) spatial forensic traces, (ii) temporal and physiological consistency, (iii) frequency/codec/vocoder artifacts, (iv) transformer or foundation-model representations, and increasingly (v) audio-visual consistency. The main empirical pattern is stable across both video and audio: detectors can report near-saturated numbers on controlled benchmarks, but performance drops sharply under cross-dataset, social-media, compression, unseen-generator, demographic, and adversarial conditions. In video, recent controlled or curated benchmark results often exceed 95–99% AUC/accuracy, while unified cross-dataset and in-the-wild evaluations show much lower AUCs, often in the 0.5–0.8 range for unadapted systems. In audio, ASVspoof 2021 and 2024 show the same pattern: SSL/foundation speech models such as wav2vec 2.0 and WavLM dramatically improve EERs in some settings, but official “in-the-wild” and large-scale challenge evaluations still expose high error rates and poor calibration.

The regulatory landscape has also shifted from general privacy, defamation, fraud, and election law toward explicit synthetic-media duties. The EU AI Act now contains deepfake disclosure and AI-output labeling provisions; the U.S. combines federal executive/NIST provenance work, the 2025 federal TAKE IT DOWN Act for nonconsensual intimate imagery, and a rapidly growing but fragmented state election/deepfake-law landscape; China has binding deep-synthesis and AI-generated-content labeling rules; and international frameworks such as the Council of Europe AI Convention, OECD/UNESCO principles, and the G7 Hiroshima process frame transparency, human rights, safety testing, and provenance as cross-border governance priorities.

## 1. Video detection: technical methods since 2022

A useful way to classify current video detection is by the evidence source the detector tries to exploit. A 2024 systematization groups detectors into spatial artifacts, temporal artifacts, frequency artifacts, and “special” higher-level artifacts; it defines spatial methods as those looking for intra-frame anomalies such as texture, color, lighting, misalignment, or blending, temporal methods as those looking for inter-frame inconsistency, and frequency methods as those looking for spectral signatures created by manipulation [1]. A 2024 survey similarly organizes face-forgery detection into space, time, frequency, and data-driven approaches, and lists post-2022 examples across these categories [2].

### 1.1 Spatial and forensic artifact detectors

Spatial artifact detectors remain the dominant baseline family. They include Xception/EfficientNet-style CNNs trained on frame crops, detectors targeting blending boundaries, and methods such as self-blended images (SBI) and CADDM that try to make training artifacts more general. The SoK benchmark emphasizes that spatial detectors look for frame-level texture, color, lighting, blending, or misalignment artifacts [1]. Recent spatial methods often improve by avoiding overly generator-specific cues: Guide-Space (ICCV 2023) learns a controllable “guide-space” to encourage more general face-forgery cues and improves FF++→Celeb-DF/DFDC transfer over Xception, F3-Net, SRM, RECCE, LTW, DCL, and UIA-ViT [3]. Forensics Adapter (CVPR 2025) explicitly adapts CLIP’s frozen ViT-L/14 representation with a small trainable adapter for face-forgery traces and blending boundaries [4].

### 1.2 Temporal consistency, physiological, and biometric cues

Temporal detectors address the fact that many face manipulations are synthesized frame-by-frame, causing flicker, discontinuities, or inconsistent mouth/face motion. The benchmark survey lists FTCN, LipForensics, M2TR, dynamic-difference learning, masked relation learning, thumbnail-layout/graph reasoning, and gaze inconsistency methods as examples of temporal or spatiotemporal approaches [2]. The SoK analysis notes that there are few temporal-only detectors; most temporal detectors combine temporal cues with spatial representations, using CNN+sequence models, spatiotemporal modules, or vision transformers [1].

Physiological and biometric cues include blink frequency, head-pose inconsistency, gaze inconsistency, mouth-motion inconsistency, and identity or person-of-interest consistency. The survey describes methods that use abnormal physiological information such as eye blinks, head pose, gaze, and spatiotemporal aggregation of gaze/texture features; it also lists Peng et al. TIFS 2024 on gaze inconsistency [2]. These cues are attractive because they are less tied to a particular GAN or diffusion generator, but they can fail when generation models explicitly optimize lip sync, gaze, or temporal coherence.

### 1.3 Frequency-domain and generator-artifact detection

Frequency methods remain important but are usually auxiliary rather than stand-alone. The SoK benchmark finds only a small number of frequency-only detectors and notes that most frequency methods combine frequency with spatial or spatiotemporal cues [1]. The 2024 survey lists HFI-Net (TIFS 2022), space-frequency interactive convolution (TIFS 2023), and FreqNet/frequency-aware learning (AAAI 2024), which target mid/high-frequency artifacts or source-independent high-frequency cues [2].

Generator-artifact detectors also attempt to detect traces specific to GANs, VAEs, diffusion models, or image-synthesis pipelines. The SoK notes that methods such as LGrad, which targets gradient artifacts in GAN/diffusion-generated images, can lose efficacy on datasets dominated by face-swap or reenactment videos, illustrating the risk of generator-specific overfitting [1].

### 1.4 Localization and segmentation of manipulated regions

Localization has become more central because deployment often requires not just a real/fake score but an explanation of where manipulation occurs. Recent examples include hierarchical fine-grained image forgery detection and localization (CVPR 2023) and UnionFormer (CVPR 2024), which the 2024 survey identifies as a unified transformer for manipulation detection and localization [2]. Localization research is also increasingly linked to foundation models, especially CLIP-style representations for semantics and Segment Anything-style masks, though the fetched sources provide stronger evidence for CLIP-based detection than for SAM-based deployed localization.

## 2. Representative video benchmark performance

Controlled video benchmarks still report very high scores, but they should be read as *benchmark-condition* numbers, not deployment guarantees.

### 2.1 Controlled and curated benchmark results

| Method / source | Training / test setting | Metric | Reported result |
|---|---:|---:|---:|
| QAD-E, ICCV 2023 | Quality-agnostic single model across raw, C23, C40; tested on NT, DF, F2F, FS, FaceShifter, Celeb-DF-v2, FFIW10K | AUC | Per-set AUC 94.92 / 99.53 / 98.94 / 99.27 / 99.12 / 98.38 / 99.16; average 98.47 [5] |
| QAD-R, ICCV 2023 | Same setting | AUC | Average 97.82 [5] |
| Xception baseline in QAD comparison | Same multi-quality setting | AUC | Average 97.22 [5] |
| F3-Net in QAD comparison | Same multi-quality setting | AUC | Average 95.73 [5] |
| QAD-E under random JPEG compression | NT, DF, F2F, FS, FaceShifter, Celeb-DF-v2, FFIW10K | AUC | Average 94.94, but NT drops to 76.27 [5] |
| FTCN, SoK white-box benchmark | Controlled within-benchmark setting | AUC | Average 98.4; reported as above 90 AUC across datasets [1] |
| AltFreezing, SoK white-box benchmark | Controlled within-benchmark setting | AUC | Average 98.3; reported as above 90 AUC across datasets [1] |

The QAD result is a good example of modern controlled-benchmark strength: a single model trained to be quality-agnostic can average 98.47 AUC over multiple compression qualities and datasets [5]. But even there, random JPEG compression sharply lowers NeuralTextures detection, showing that “high average AUC” can hide severe condition-specific weaknesses [5].

### 2.2 Cross-dataset video generalization

Cross-dataset evaluation is the more important indicator for deployment. The same detector can rank differently when trained on FaceForensics++ and tested on Celeb-DF, DFDC, DeeperForensics, or WildDeepfake.

| Method | Train → test | Metric | Reported result |
|---|---:|---:|---:|
| Xception | FF++ HQ → Celeb-DF / DFDC | AUC | 66.91 / 67.93 [3] |
| F3-Net | FF++ HQ → Celeb-DF / DFDC | AUC | 71.21 / 72.88 [3] |
| SRM | FF++ HQ → Celeb-DF / DFDC | AUC | 79.40 / 79.70 [3] |
| DCL | FF++ HQ → Celeb-DF / DFDC | AUC | 82.30 / 76.71 [3] |
| UIA-ViT | FF++ HQ → Celeb-DF / DFDC | AUC | 82.41 / 75.80 [3] |
| Guide-Space, ICCV 2023 | FF++ HQ → Celeb-DF / DFDC | AUC | 84.97 / 81.65 [3] |
| SBI | SoK gray-box setting, Celeb-DF / DFDC | AUC | 93.2 / 86.2 [1] |
| CADDM | SoK gray-box setting, Celeb-DF / DFDC | AUC | 91.0 / 76.8 [1] |
| Ten-detector average in SoK | Gray-box generalization, Celeb-DF / DFDC | AUC | 79.30 / 68.72, a 10.58 point gap [1] |
| Forensics Adapter, CVPR 2025 | FF++ C23 → Celeb-DF-v2 / DFDC / DFDCP | Video-level AUC | 0.957 / 0.872 / 0.929 [4] |
| Forensics Adapter, CVPR 2025 | FF++ C23 → CDF-v1, CDF-v2, DFDC, DFDCP, DFD | Frame-level AUC | 0.914 / 0.900 / 0.843 / 0.890 / 0.933; average 0.896 [4] |

The ranking is clear: controlled results can approach saturation, but cross-dataset transfer is substantially lower. Among the cited recent methods, Guide-Space is a strong 2023 domain-generalization method for FF++→Celeb-DF/DFDC, while the 2025 Forensics Adapter is one of the strongest fetched CLIP-based generalization results, especially on Celeb-DF-v2 and DFDC [3] [4].

## 3. Audio deepfake and spoofing detection

Audio detection research since 2022 has followed a similar path but with speech-specific front ends. The main categories are:

* **Spectrogram/CNN and anti-spoofing baselines.** ASVspoof baselines and many submitted systems use LFCC, CQCC, log-spectrograms, LCNN, ResNet, RawNet2, and AASIST-style end-to-end anti-spoofing models [6].
* **Self-supervised speech representations.** wav2vec 2.0, HuBERT, WavLM, XLS-R, and related transformer SSL models have become central. ASVspoof 2021 post-challenge studies and ASVspoof 2024 submissions report large gains from SSL front ends, especially with data augmentation [6] [7].
* **Codec, channel, and vocoder artifacts.** ASVspoof 2021 deliberately introduced coding, compression, and transmission artifacts in LA and DF tasks; the DF evaluation set contained unseen source corpora, data conditions, and compression methods, which caused major overfitting gaps [6].
* **Phase/frequency features.** Phase-aware spoof-speech detection work argues that magnitude-only spectral features miss artifacts and that phase information can improve generalization to diverse attacks [8].
* **Large-audio/foundation-model detectors.** WavLM and wav2vec-based systems are now de facto foundation-model integrations for audio; newer work such as ALLM4ADD explores audio large language models by reframing detection as audio question answering [9].

### 3.1 ASVspoof 2021 results and generalization evidence

ASVspoof 2021 is important because it moved spoofing evaluation closer to “in the wild” conditions. It included logical access (LA), physical access (PA), and a new deepfake (DF) task; LA and PA used min-tDCF, while DF used EER [6].

| Track / system | Metric | Evaluation result |
|---|---:|---:|
| LA best challenge system T23 | min-tDCF / EER | 0.2177 / 1.32% [6] |
| LA best baseline B03 | min-tDCF / EER | 0.3445 / 9.26% [6] |
| PA best challenge system T07 | min-tDCF / EER | 0.6824 / about 24% EER [6] |
| PA best baseline B01 | min-tDCF | 0.9434 [6] |
| DF best challenge system T23 | EER | 15.64% [6] |
| DF second system T20 | EER | 16.05% [6] |
| DF best baselines B04 / B03 | EER | 22.38% / 23.48% [6] |
| Post-challenge SSL+augmentation result | LA min-tDCF / EER; DF EER | 0.2066 / 0.82%; DF 2.85% [6] |

The most striking ASVspoof 2021 finding is overfitting: on the DF progress set the best EER reportedly fell from 11.6% to 0.10%, but on the evaluation set it rose to 15.6% because evaluation contained unseen source corpora, data conditions, and compression methods [6]. This is one of the clearest published audio examples that benchmark progress does not necessarily transfer to deployment-like conditions.

### 3.2 ASVspoof 2024 / ASVspoof 5 results

ASVspoof 2024/5 expanded scale with crowdsourced speech, many spoofing attacks, and standalone countermeasure and spoofing-aware speaker-verification tracks. Official results again show a large gap between closed, open, and calibrated deployment-like performance [10].

| Track / condition | System family | Metric | Reported result |
|---|---|---:|---:|
| Track 1 standalone CM, closed baselines | RawNet2 / AASIST baselines | minDCF / EER | minDCF ≥ 0.7; EER ≥ 29% [10] |
| Track 1 standalone CM, closed best | T32 ensemble | minDCF / actDCF / Cllr / EER | 0.2436 / 0.9956 / 0.9458 / 8.61% [10] |
| Track 1 standalone CM, open best | T45 ensemble + SSL | minDCF / actDCF / Cllr / EER | 0.0750 / 1.0 / 0.7923 / 2.59% [10] |
| Track 2 SASV, closed best | T45 | min a-DCF | 0.2814 [10] |
| Track 2 SASV, open best | T45 | min a-DCF | 0.0756 [10] |
| Track 2 SASV, open strong systems | T39 / T23 | min t-DCF / t-EER | 0.4584 / 4.32%; 0.4075 / 4.63% [10] |

Open-condition systems using SSL models substantially outperformed closed baselines, but actDCF around 1 and high Cllr values show poor calibration, meaning that even low EER/minDCF systems are not necessarily ready for operational thresholding [10].

### 3.3 Representative SSL and foundation-model audio results

| Method | Dataset / setting | Metric | Result |
|---|---:|---:|---:|
| WavLM + multi-fusion attentive classifier | ASVspoof 2021 DF / LA | pooled EER | 2.56% DF; 5.08% LA [11] |
| WavLM + MFA | ASVspoof 2019 LA | min-tDCF / EER | 0.0126 / 0.42% [11] |
| WavLM-base pretrained | ASVspoof5 dev subset | EER | 9.93% [7] |
| wav2vec2-base pretrained | ASVspoof5 dev subset | EER | 13.33% [7] |
| HuBERT pretrained | ASVspoof5 dev subset | EER | 16.47% [7] |
| wav2vec2-XLS-R-2B, not challenge-allowed | ASVspoof5 dev subset | EER | 0.96% [7] |
| WavLM-base finetuned with augmentation | ASVspoof5 dev / progress | EER | 0.61% dev for augm-31k; 7.26% progress for augm-114k [7] |
| WavLM late-fusion submission | ASVspoof5 progress / final eval | EER | 6.56% / 17.08% [7] |

The ranking from the fetched evidence is consistent: speech SSL/foundation representations outperform most handcrafted or speaker-embedding front ends, and larger multilingual SSL models can be extremely strong in development settings. However, the WavLM ASVspoof5 paper’s final 17.08% EER and the official ASVspoof 2024 calibration metrics show that scale and pretraining do not eliminate generalization problems [7] [10].

## 4. Transformer-based architectures

Transformers are now common across modalities.

**Video.** Representative visual-transformer architectures include ViT, Swin, TimeSformer/video transformers, and hybrid CNN-transformer systems. The SoK table includes CCViT, LTTD, and other vision-transformer or sequence-model detectors, and notes that vision transformers help model spatiotemporal features when videos are sliced into frame/patch sequences [1]. M2TR uses a multiscale transformer for local inconsistencies; UnionFormer uses a transformer for image manipulation detection and localization; and Forensics Adapter uses CLIP’s ViT-L/14 backbone with a small trainable adapter [2] [4].

**Audio.** The dominant transformer contribution is not always a detector head but a pretrained front end: wav2vec 2.0, HuBERT, WavLM, XLS-R, and audio LLMs all use transformer representations. WavLM+MFA aggregates hidden layers with attentive pooling and reaches 2.56% EER on ASVspoof 2021 DF [11]. ASVspoof5 WavLM benchmarking shows that SSL transformers outperform LEAF, ECAPA-TDNN, TitaNet, and other feature families under the tested development conditions [7].

**Audio-visual.** AV-HuBERT-style transformers are increasingly used for multimodal detection. AVH-Align uses a frozen AV-HuBERT model and aligns audio-only and video-only features, explicitly aiming to avoid dataset shortcuts such as leading silence [12].

## 5. Multimodal audio-visual detection

Multimodal detection is growing because many real attacks manipulate both face and voice. The core approaches are:

* **Audio-visual synchronization**: detect mismatch between speech audio and lip motion, as in SyncNet-derived approaches, MDS, and AVAD [12] [13].
* **Lip-speech semantic consistency**: compare local phonetic and global linguistic consistency; SpeechForensics argues that local lip sync can be fooled by Wav2Lip, while global speech semantics can still reveal anomalies [13].
* **Identity/voice-face consistency**: POI-Forensics-style systems learn identity embeddings from moving facial and audio segments using contrastive learning [2].
* **Multimodal transformers/foundation features**: AVH-Align uses AV-HuBERT audio-only and video-only features to learn alignment [12].

Representative results:

| Method | Setting | Metric | Result |
|---|---:|---:|---:|
| SpeechForensics, NeurIPS 2024 | FF++ leave-one-manipulation | video-level AUC | 97.6 average; compared with FTCN 98.3, LipForensics 97.1, Face X-ray 94.9, AVAD 58.2 [13] |
| SpeechForensics, NeurIPS 2024 | Cross-dataset FakeAVCeleb | AUC | 99.0; compared with MDS 76.7, VFD 82.5, AVoiD-DF 85.8, AVAD 85.0 [13] |
| AVH-Align, CVPR 2025 | FakeAVCeleb / AV-Deepfake1M | AUC | 94.6 / 85.9; AP 99.8 / 94.3 [12] |
| SpeechForensics in AVH-Align comparison | FakeAVCeleb / AV-Deepfake1M | AUC | 98.8 / 68.8 [12] |
| AVAD in AVH-Align comparison | FakeAVCeleb / AV-Deepfake1M | AUC | 84.5 / 54.3 [12] |

The important caution is shortcut learning. CVPR 2025 shows that leading silence alone separates real/fake examples in FakeAVCeleb and AV-Deepfake1M with AUC 98.4 and 98.2, respectively; after trimming, MDS drops from 90.4 to 73.8 AUC on FakeAVCeleb and from 99.2 to 54.9 on AV-Deepfake1M, while AVAD remains stable and AVH-Align is designed to be robust to that bias [12]. Thus, multimodal methods can be powerful, but only if they are tested against trivial dataset artifacts.

## 6. Foundation-model integration

Foundation models are now used in three main ways.

1. **Feature extraction and adaptation.** Forensics Adapter freezes CLIP ViT-L/14 and trains a 5.7M-parameter ViT-tiny adapter for face-forgery traces and blending boundaries. It reports video-level AUC 0.957 on Celeb-DF-v2, 0.872 on DFDC, and 0.929 on DFDCP when trained on FF++ C23 [4].
2. **Speech SSL front ends.** WavLM, wav2vec 2.0, HuBERT, XLS-R, and related models dominate audio deepfake work. WavLM+MFA reaches 2.56% EER on ASVspoof 2021 DF, and ASVspoof5 representation benchmarking shows WavLM-base outperforming wav2vec2-base and HuBERT on the tested dev subset [11] [7].
3. **Multimodal foundation representations.** AVH-Align uses AV-HuBERT to align audio and video speech representations, improving AV-Deepfake1M AUC relative to AVAD and SpeechForensics in the cited comparison [12].

Foundation models improve transfer because their representations are less tied to one manipulation engine, but they also introduce risks: hidden training-data leakage, shortcut amplification, calibration problems, and higher computational cost. The evidence is strongest for CLIP-adapter video detection and SSL speech front ends; the fetched sources provide less mature evidence for large vision-language-model explanation or SAM-style localization in operational settings.

## 7. Privacy-preserving detection

Privacy is a major concern because effective detectors often require face crops, voice biometrics, identity embeddings, and platform-scale monitoring. The fetched technical literature supports three privacy-preserving directions.

| Approach | Mechanism | Utility / privacy trade-off |
|---|---|---:|
| FedForgery, TIFS 2022 | Federated learning with residual feature learning; keeps sensitive data local across centers | Centralized FedForgery* accuracy/AUC 87.36 / 93.23 versus federated FedForgery 85.55 / 91.12 on a hybrid-domain dataset, about 1.8 accuracy and 2.1 AUC points lower [14] |
| FedPR, 2024 | Personalized federated representation; shared representation uploaded, personalized features kept local | Hybrid privacy FedPR accuracy/AUC 88.78 / 93.52; DeepForensics-1.0 privacy FedPR accuracy 97.29 versus centralized 98.64, about 1.35 percentage-point degradation [15] |
| SecDFDNet, 2023 | Additive secret sharing / secure multiparty computation for encrypted outsourced face-image detection | Same accuracy as plaintext DFDNet, e.g., FF++ DF/FS/F2F/NT 98.24 / 96.52 / 95.13 / 93.68, Celeb-DF 98.12, DFDC 89.13; latency rises from 1.76s plaintext to 7.12s for two parties, 10.78s for three, 18.15s for five [16] |

The strongest privacy-preserving result is that cryptographic inference can preserve accuracy exactly in the tested setting but at substantial latency/communication cost [16]. Federated learning has smaller operational overhead but usually pays a measurable utility cost and still leaves open questions about gradient leakage, client heterogeneity, secure aggregation, and differential privacy [15] [14].

## 8. Controlled benchmarks versus real-world deployment

The strongest conclusion from the evidence is that controlled benchmark performance systematically overstates deployment readiness.

### 8.1 Video and image/video-in-the-wild evidence

Deepfake-Eval-2024 provides the clearest fetched real-world evaluation. It tests off-the-shelf detectors on in-the-wild content collected from social/platform/user-flagged 2024 sources. Open-source systems reach only modest AUCs: video GenConViT 0.63 compared with its original published average of 0.96, FTCN 0.50 compared with 0.87, and Styleflow 0.51 compared with 0.95 [17]. The same evaluation reports an average AUC drop versus academic datasets of about 50% for video, 48% for audio, and 45% for image [17]. Finetuning on 60% of the real-world set improves performance—for example GenConViT to AUC 0.82/accuracy 0.75 and FTCN to AUC 0.71/accuracy 0.65—but this illustrates dependence on fresh local data rather than plug-and-play generalization [17].

Commercial tools also do not eliminate the gap: the best commercial detector in the December 2024 Deepfake-Eval-2024 comparison reached video accuracy 0.78/AUC 0.79, audio accuracy 0.89/AUC 0.93, and image accuracy 0.82/AUC 0.90 [17]. Multimodal open-source systems were also weak in that in-the-wild evaluation: AVF AUC 0.58 compared with 0.945 on FakeAVCeleb and 0.87 on KoDF, while FGI AUC 0.42 compared with 0.845 on FakeAVCeleb and 0.98 on DFDC [17].

### 8.2 Audio deployment evidence

ASVspoof 2021 and 2024 provide analogous audio evidence. In ASVspoof 2021 DF, progress-set EER fell below 1% for the top system but evaluation EER was 15.64%, due to unseen corpora and compression conditions [6]. In ASVspoof 2024, open systems achieved low minDCF/EER in Track 1, but actDCF and Cllr remained poor, indicating calibration problems for deployment thresholds [10].

### 8.3 Robustness, compression, and adversarial degradation

Compression, random JPEG, social-media transcoding, silence artifacts, and dataset shortcuts all change detector rankings. QAD-E’s high average AUC under random JPEG hides a drop to 76.27 AUC on NeuralTextures [5]. ASVspoof 2021 shows that audio compression and previously unseen corpora can turn progress-set success into high evaluation EER [6]. AVH-Align shows that leading silence can produce near-perfect AUC on multimodal datasets, meaning that a detector can “succeed” by learning a non-forensic shortcut [12].

## 9. Ethical concerns identified by researchers

The technical literature and policy sources converge on the following ethical concerns:

* **Nonconsensual sexual imagery and intimate abuse.** Synthetic intimate imagery is a central harm because it can be created without consent and is difficult to remove once distributed; the U.S. TAKE IT DOWN Act directly targets nonconsensual intimate visual depictions including AI-generated content [18].
* **Political disinformation and election manipulation.** The EU AI Act links detection and labeling obligations to DSA systemic-risk mitigation for democratic processes, civic discourse, and electoral processes [19]. NCSL reports that U.S. states have enacted election-deepfake prohibitions or disclosure laws [20].
* **Fraud and impersonation.** ASVspoof frames speech deepfakes as threats to speaker verification, telephone banking, call centers, and public social-media impersonation [6].
* **Reputational harm and harassment.** NCSL notes that online impersonation laws often target intimidation, bullying, threats, and harassment, and newer deepfake bills respond to increasingly easy creation of realistic manipulated audio/video [21].
* **Evidentiary uncertainty and the liar’s dividend.** As deepfakes become plausible, authentic evidence can be dismissed as fake; provenance and labeling programs respond to this problem but cannot prove truth by themselves. NIST’s synthetic-content report explicitly warns that transparency can contribute to trustworthiness but does not guarantee it [22].
* **Bias and disparate detector error rates.** CVPR 2024 fairness work identifies demographic disparities and cross-domain fairness failures in deepfake detectors, including concerns that lighter skin may have higher accuracy than darker skin in prior work [23].
* **Privacy and surveillance risks.** Detectors often require biometric face and voice analysis; federated, encrypted, and on-device approaches respond to the risk that detection infrastructure becomes surveillance infrastructure [15] [14] [16].
* **Adversarial escalation.** The SoK and benchmark papers show that detectors can overfit to current artifacts; generators can remove or mimic artifacts, while detectors then seek new traces [1].
* **Overblocking and chilling expression.** The EU AI Act explicitly limits deepfake disclosure duties for artistic, creative, satirical, fictional, or analogous works so disclosure does not hamper display or enjoyment, reflecting concern about expression and legitimate media [19].

## 10. Regulation and policy frameworks as of 2026-06-22

### 10.1 European Union

**EU AI Act.** Regulation (EU) 2024/1689 was adopted on 13 June 2024 and published in the Official Journal on 12 July 2024 [19]. It defines “deep fake” as AI-generated or manipulated image, audio, or video content resembling existing persons, objects, places, entities, or events and falsely appearing authentic or truthful [19]. Article 50(4) requires deployers of AI systems that generate or manipulate image, audio, or video content constituting a deepfake to disclose that the content has been artificially generated or manipulated, subject to law-enforcement exceptions and lighter handling for artistic, satirical, creative, fictional, or analogous works [19]. It also requires disclosure for AI-generated or manipulated public-interest text unless there is human review/editorial responsibility [19].

**DSA interaction.** AI Act recitals link AI-generated/manipulated-content labeling and detection to the Digital Services Act’s obligations for very large online platforms and search engines to mitigate systemic risks to democratic processes, civic discourse, and elections [19].

**GDPR and privacy.** Although not a deepfake-specific statute, GDPR remains relevant where detection processes biometric data, face templates, voiceprints, or identity information. The fetched AI Act source also shows that EU lawmakers treat biometric and emotion-recognition systems as rights-sensitive categories [19].

### 10.2 United States

**Federal executive and standards activity.** Executive Order 14110 of 30 October 2023 directed a government-wide AI risk effort and identifies irresponsible AI as a source of fraud, discrimination, bias, disinformation, and national-security risks [24]. NIST’s 2024 synthetic-content transparency report, produced in that policy environment, surveys provenance, watermarking, metadata, and detection approaches while warning that transparency can help assess origins but does not guarantee trustworthiness [22].

**Federal statute: TAKE IT DOWN Act.** Public Law 119-12, enacted 19 May 2025, targets nonconsensual intimate visual depictions, including AI-generated or computer-generated intimate imagery, and requires covered platforms to remove qualifying material after notice within statutory timeframes [18].

**State election and synthetic-media laws.** NCSL reports that thirty states have enacted laws regulating the use of deepfakes in political messaging. State approaches generally split between prohibitions and disclosures: Minnesota and Texas prohibit publication of political deepfakes within specified pre-election windows, Maryland prohibits deceptive election-related deepfakes year-round, and twenty-seven other states require disclosures on media; Colorado and Utah also require metadata disclosures [20]. NCSL separately notes broader state legislation on deceptive audio/visual media and online impersonation, including harassment, intimidation, bullying, and threatening conduct [21].

**Federal proposals.** The fetched sources support the existence of federal executive and standards efforts but do not establish a single enacted comprehensive federal deepfake-disclosure or watermarking law beyond TAKE IT DOWN. Proposed federal bills in recent Congresses have addressed election deception, AI labeling/watermarking, and intimate imagery, but their final status should be verified bill-by-bill before treating them as law.

### 10.3 China

China has enacted binding deep-synthesis and labeling rules. The Provisions on the Administration of Deep Synthesis Internet Information Services were adopted in late 2022 and took effect on 10 January 2023; they apply to internet information services using deep-synthesis technology in China and require providers to implement management systems for user registration, algorithm mechanism review, ethics review, information review, data security, personal-information protection, anti-telecom-fraud measures, and emergency response [25]. The 2025 Measures for the Identification of AI-Generated and Synthesized Content were issued on 7 March 2025 and take effect on 1 September 2025; they regulate labeling of AI-generated/synthesized content and distinguish explicit and implicit labels [26].

### 10.4 International frameworks

International governance is less operationally binding than the EU and China rules but shapes norms. The Council of Europe Framework Convention on AI, the G7 Hiroshima AI Process, OECD AI Principles, and UNESCO Recommendation on the Ethics of AI emphasize human rights, transparency, accountability, risk management, provenance/labeling, and international cooperation. These frameworks are best understood as governance baselines rather than detector-performance requirements; they encourage disclosure, content authenticity, and risk mitigation but generally do not prescribe specific AUC/EER thresholds for deepfake detectors.

## 11. Overall assessment and ranking of research directions

**Most mature in controlled benchmarks:** frame/video artifact detectors with CNN/transformer backbones and compression-aware training, such as QAD and strong spatiotemporal models, because they can exceed 95–99 AUC under curated conditions [5] [1].

**Best current route for cross-dataset video transfer:** artifact-agnostic/domain-generalization methods and foundation-model adapters. Guide-Space and Forensics Adapter show stronger FF++→Celeb-DF/DFDC transfer than older CNN baselines, with Forensics Adapter reaching 0.957 AUC on Celeb-DF-v2 and 0.872 on DFDC [3] [4].

**Best current route for audio:** SSL speech front ends with careful augmentation and calibration. WavLM/wav2vec systems dominate the fetched post-2022 audio evidence, but ASVspoof 2024 calibration results show that low EER alone is insufficient [11] [7] [10].

**Most promising but fragile multimodal direction:** audio-visual semantic consistency. SpeechForensics and AVH-Align show strong results, but CVPR 2025 shortcut analysis demonstrates that some multimodal datasets contain trivial silence cues, making robust evaluation essential [13] [12].

**Most deployment-relevant research gaps:** calibration, false-positive control, demographic fairness, provenance integration, robustness to platform compression, detection of unseen diffusion/TTS/voice-cloning systems, privacy-preserving biometric inference, and transparent localization/explanation. The evidence does not support a claim that deepfake detection is “solved”; rather, it supports a narrower conclusion: detectors are strong when test conditions resemble training benchmarks, but real-world detection remains an open, adversarial, and governance-sensitive problem.

## Sources

1. [SoK: Systematization and Benchmarking of Deepfake Detectors in a Unified Framework](https://arxiv.org/html/2401.04364v4)
2. [2403.17881](https://arxiv.org/pdf/2403.17881)
3. [Guo_Controllable_Guide-Space_for_Generalizable_Face_Forgery_Detection_ICCV_2023_paper.pdf](https://openaccess.thecvf.com/content/ICCV2023/papers/Guo_Controllable_Guide-Space_for_Generalizable_Face_Forgery_Detection_ICCV_2023_paper.pdf)
4. [Cui_Forensics_Adapter_Adapting_CLIP_for_Generalizable_Face_Forgery_Detection_CVPR_2025_paper.pdf](https://openaccess.thecvf.com/content/CVPR2025/papers/Cui_Forensics_Adapter_Adapting_CLIP_for_Generalizable_Face_Forgery_Detection_CVPR_2025_paper.pdf)
5. [Le_Quality-Agnostic_Deepfake_Detection_with_Intra-model_Collaborative_Learning_ICCV_2023_paper.pdf](https://openaccess.thecvf.com/content/ICCV2023/papers/Le_Quality-Agnostic_Deepfake_Detection_with_Intra-model_Collaborative_Learning_ICCV_2023_paper.pdf)
6. [2210.02437](https://arxiv.org/pdf/2210.02437)
7. [WavLM model ensemble for audio deepfake detection](https://arxiv.org/html/2408.07414)
8. [| arXiv e-print repository](https://arxiv.org/html/2203.10793)
9. [ALLM4ADD: Unlocking the Capabilities of Audio Large Language Models for Audio Deepfake Detection](https://arxiv.org/html/2505.11079v2)
10. [wang24_asvspoof.pdf](https://www.isca-archive.org/asvspoof_2024/wang24_asvspoof.pdf)
11. [Audio Deepfake Detection with Self-Supervised WavLM and Multi-Fusion Attentive Classifier](https://arxiv.org/html/2312.08089v2)
12. [Smeu_Circumventing_Shortcuts_in_Audio-visual_Deepfake_Detection_Datasets_with_Unsupervised_Learning_CVPR_2025_paper.pdf](https://openaccess.thecvf.com/content/CVPR2025/papers/Smeu_Circumventing_Shortcuts_in_Audio-visual_Deepfake_Detection_Datasets_with_Unsupervised_Learning_CVPR_2025_paper.pdf)
13. [9c7900fac04a701cbed83256b76dbaa3-Paper-Conference.pdf](https://proceedings.neurips.cc/paper_files/paper/2024/file/9c7900fac04a701cbed83256b76dbaa3-Paper-Conference.pdf)
14. [https://export.arxiv.org/pdf/2210.09563v2.pdf](https://export.arxiv.org/pdf/2210.09563v2.pdf)
15. [Federated Face Forgery Detection Learning with Personalized Representation](https://arxiv.org/html/2406.11145v1)
16. [nbnfi-fe20231025141349.pdf](https://oulurepo.oulu.fi/bitstream/handle/10024/44041/nbnfi-fe20231025141349.pdf?isAllowed=y&sequence=1)
17. [Deepfake-Eval-2024: A Multi-Modal In-the-Wild Benchmark of Deepfakes Circulated in 2024](https://arxiv.org/html/2503.02857v5)
18. [PLAW-119publ12.pdf](https://www.govinfo.gov/content/pkg/PLAW-119publ12/pdf/PLAW-119publ12.pdf)
19. [Regulation - EU - 2024/1689 - EN - EUR-Lex](https://eur-lex.europa.eu/eli/reg/2024/1689/en)
20. [Artificial Intelligence (AI) in Elections and Campaigns](https://www.ncsl.org/elections-and-campaigns/artificial-intelligence-ai-in-elections-and-campaigns)
21. [Deceptive Audio or Visual Media (“Deepfakes”) 2024 Legislation](https://www.ncsl.org/technology-and-communication/deceptive-audio-or-visual-media-deepfakes-2024-legislation)
22. [NIST.AI.100-4.pdf](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-4.pdf)
23. [Lin_Preserving_Fairness_Generalization_in_Deepfake_Detection_CVPR_2024_paper.pdf](https://openaccess.thecvf.com/content/CVPR2024/papers/Lin_Preserving_Fairness_Generalization_in_Deepfake_Detection_CVPR_2024_paper.pdf)
24. [2023-24283.pdf](https://www.govinfo.gov/content/pkg/FR-2023-11-01/pdf/2023-24283.pdf)
25. [国家互联网信息办公室 中华人民共和国工业和信息化部 中华人民共和国公安部令（第12号）　　互联网信息服务深度合成管理规定__2023年第4号国务院公报_中国政府网](https://www.gov.cn/gongbao/content/2023/content_5741257.htm)
26. [关于印发《人工智能生成合成内容标识办法》的通知_国务院部门文件_中国政府网](https://www.gov.cn/zhengce/zhengceku/202503/content_7014286.htm)