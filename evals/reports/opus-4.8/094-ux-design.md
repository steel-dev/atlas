# Adaptive Input for Musicians with Hand Tremor in DAW Environments

## Bottom line

The premise that Ableton Live, Logic Pro, and SteadyMouse each ship a dedicated MIDI "tremor-compensation" feature is incorrect, and the asymmetry matters:

- **Ableton Live** has only static **velocity scaling** (the Velocity MIDI effect, a curve remap of values 1–127), with **no frequency-based tremor smoothing** of incoming MIDI [1].
- **Logic Pro Smart Controls** are a **macro parameter-mapping** tool (one knob → many plug-in parameters); "tremor compensation" is a **misattribution** — the feature does not exist [2].
- **SteadyMouse** *is* genuinely tremor-filtering assistive software, but it dampens **mouse-cursor jitter only**, not MIDI note/velocity/pitch-bend data [3].

So no DAW-native system in this comparison separates pathological tremor from intentional vibrato in real-time MIDI capture. The hard problem is real: pathological tremor (Parkinsonian rest tremor **4–6 Hz**; essential tremor postural **~4–8 Hz, up to 6–12 Hz**) overlaps almost exactly with musical **vibrato at ~4.5–6.5 Hz**, so any frequency filter aggressive enough to remove tremor also rejects legitimate expression [4][5]. The relevant engineering and accuracy evidence comes entirely from **adjacent fields** — biomedical input filtering (Riviere/Thakor WFLC, Rocon TechFilter) and machine-learning motion classification — not from peer-reviewed DAW-specific HCI studies, which do not appear to exist. For an **essential-tremor** user a light, adaptive OS-level or hardware filter (SteadyMouse-style) plus generous velocity scaling is the best fit; for a **Parkinson's** user whose deficits also include bradykinesia and onset delay, a **gaze/head-controlled accessible instrument** such as EyeHarp that bypasses manual MIDI entirely is the stronger choice.

## The signal-separation problem: tremor vs vibrato spectra

The core difficulty is spectral overlap. Reported frequency bands:

| Signal | Frequency | Source |
|---|---|---|
| Parkinsonian rest tremor | 4–6 Hz | [5] (UK Brain Bank "4–6-Hz rest tremor"; EMG study) |
| Essential tremor (postural/action) | ~4–6 Hz, classically 6–12 Hz | [5] (overlaps PD band); StatPearls "postural 6 to 12 Hz" |
| Enhanced physiological tremor | 6–12 Hz | [5] |
| Physiological tremor | 6–14 Hz | |
| Pathological hand tremor (broad) | 3–14 Hz | |
| **Musical vibrato** | **4.5–6.5 Hz** (50–120 cents extent) | |

A 2017 EMG differential-diagnosis study (Parkinsons Dis 2017;2017:1597907) found PD and ET "difficult to distinguish in tremor frequency" because of "superposition of the tremor frequency" — PD at 4–6 Hz and ET also in that range — and had to rely on secondary cues: ET shows more postural tremor, postural frequency runs ~1.5–2 Hz above static (the study measured 1.8 Hz), and ET has no onset delay when lifting the limb whereas PD shows an obvious delay [5]. Because vibrato sits squarely inside the 4–8 Hz tremor band, **frequency alone cannot separate intentional musical oscillation from pathology** — the defining HCI obstacle for any real-time MIDI tremor filter.

## How the three named tools actually behave (shared criteria)

| Criterion | Ableton Live (Velocity effect) | Logic Pro Smart Controls | SteadyMouse |
|---|---|---|---|
| Real domain | MIDI velocity values 1–127 | Plug-in/channel macro mapping | Mouse cursor X/Y + clicks |
| Mechanism | Static curve remap (Range/Lowest → Out Hi/Out Low) [1] | "Learn" mapping one control to many parameters [2] | Detects and removes shaking before it reaches cursor; blocks accidental clicks [3] |
| Tremor-specific? | No | No — "tremor compensation" is a misattribution [2] | Yes — built for ET and Parkinson's/MS variants [3] |
| Filter type | None (no frequency processing) | None | Jitter/lag compensation, zero-phase-style filtering; selectable filter sets ("Feather", "Allegro") [6][3] |
| Frequency cutoff | N/A | N/A | Tunable feel, not a published Hz cutoff [6] |
| Adaptivity | None | None | Tunable filter sets; default "Feather" (light) on fresh install [6] |
| Handles vibrato? | Irrelevant (no smoothing to over-reject) | Irrelevant | N/A to MIDI — operates on cursor, never sees pitch/velocity gestures [3] |

SteadyMouse is current and maintained — **SteadyMouse 2 (v2.8.7.1)**, sold under "SteadyMouse X / SteadyMouse 2" licenses, with an older free version still available [6][4]. Its value to a tremor-affected musician is confined to mouse-driven DAW *editing* (clicking, dragging clips/automation), not to *playing* MIDI.

## HCI/biomedical research on real-time tremor cancellation

The substantive engineering literature lives outside music software:

- **Riviere & Thakor, "Modeling and Canceling Tremor in Human-Machine Interfaces," IEEE Engineering in Medicine and Biology Magazine, 1996.** Introduces the **Weighted-Frequency Fourier Linear Combiner (WFLC)**, an adaptive noise canceller that models tremor as a roughly sinusoidal signal and tracks its time-varying frequency with **zero phase lag — introducing no time delay** into PC input filters or active-compensation systems. It explicitly solves the two classic failures of tremor suppression: feedback delay from phase lag, and inability to track drifting tremor frequency. Applications named: computer input filtering, clinical tremor quantification, microsurgery [7].
- **Rocon, Miranda & Pons, "TechFilter," Technology and Disability 18 (2006) 3–8 (IOS Press).** A microcontroller adapter between mouse and PC running an error-cancelling, **learning** algorithm that performs real-time discrimination between voluntary and tremorous movement using **zero-phase estimation**; it removes the estimated tremor component and treats the remainder as intentional [4].
- **Automatic differentiation of voluntary and tremulous motion (Scientific Reports, 2025; s41598-025-08216-7),** using ensemble empirical mode decomposition + convolutional Bi-directional LSTM, reports the best published classifier metrics on this exact two-class problem (below) [8].

The zero-phase-lag property of WFLC is the crucial bridge to music: because real-time filtering inevitably risks adding latency, only a near-zero-delay filter can stay below musical perceptibility thresholds.

## False-positive / rejection-rate figures

The 2025 voluntary-vs-tremulous classifier reports [8]:

| Metric | Value | Meaning for a musician |
|---|---|---|
| Accuracy | 94.2% | Overall correct classification |
| Precision | 0.96 | Of motions flagged as tremor, fraction truly tremor |
| Specificity | 0.98 | Voluntary motion correctly *kept* → ~**2% false-positive rate** (voluntary gesture wrongly rejected as tremor) |
| F1 score | 0.85 | — |
| AUC-ROC | 0.99 | — |

In this framing a **false positive = voluntary motion wrongly recognized as tremulous** (an intentional gesture suppressed), and a **false negative = tremulous motion wrongly kept as voluntary** (tremor leaks through) [8]. Even a strong 0.98-specificity model rejects ~2 in 100 deliberate gestures — for a violinist that is ~2% of intended vibrato/articulation lost. Other models in the study fell to "greater than 80%" accuracy, with correspondingly higher rejection. No equivalent figure has been published for MIDI vibrato specifically.

## The central tension and the threshold tradeoff

The frequency overlap forces an irreducible **false-positive vs false-negative tradeoff**: a filter cut tight enough to remove 5 Hz tremor will also strip a 5 Hz vibrato, while a cut loose enough to preserve vibrato lets tremor through [5]. Threshold sensitivity is the control that trades these against each other, and it maps onto the user-experience axis:

- **Over-filtering (aggressive threshold):** more tremor artifacts removed, but legitimate expression rejected → frustration, repeated re-takes, longer composition completion times.
- **Under-filtering (permissive threshold):** expression preserved, but noisy/unintended notes survive → manual cleanup, also longer completion times and lower satisfaction.

SteadyMouse's design choices reflect exactly this calibration logic: it ships the **lighter "Feather" set by default** rather than a heavier filter, deliberately erring toward preserving intentional motion at the cost of letting some jitter through [6]. The closest *indicative* task-performance data come from the input-filtering literature rather than from a DAW. TechFilter's user validation (4 patients, each task run filter-off/on/off in randomized order over 40 minutes) reported a **mean 33.3% reduction in tracking error** on a "draw a spiral" task (per-patient range 20–50%) and a **mean 52% reduction in erroneous clicks** on a "goal and click" task (per-patient range 28–100%), with the associated WOTAS limb device achieving consistent ~30% tremor-power reduction and peaks ~80% in severe tremor [4]. These are *indicative* of the accuracy gains an adaptive zero-phase filter can yield, but they measure cursor tracking and clicking, not MIDI capture. **No peer-reviewed DAW study of composition completion time and satisfaction under different threshold calibrations among professional musicians with movement disorders appears in the literature** — the completion-time/satisfaction relationship is inferred from these cursor-task figures [4], the classifier error structure [8], and Riviere/Thakor's input filtering [7], not measured in a DAW.

## Latency, flow, and creative disruption

Real-time filtering is only viable if it does not add perceptible delay. Musical latency thresholds (Schuett, *The Effects of Latency on Ensemble Performance,* Stanford CCRMA, 2002) [9]:

- Delays **under ~7 ms** are "not typically perceptible" and acceptable for desktop/semiprofessional use.
- Small ensembles tolerate only **~5 ms** (Ensemble Performance Threshold); ~40 ms is the acceptable max for large ensembles.
- At **~30 ms** tempo begins to slow.

This validates the ~10–20 ms perceptibility ceiling: a filter must operate well inside it, which is precisely why **WFLC's zero-phase-lag** architecture matters — a lagging low-pass filter would itself disrupt timing [7][9]. Disruption maps onto flow theory: in Csikszentmihalyi's framework (1975/1990), applied to interfaces in Bederson's "Interfaces for staying in the flow" (ACM Ubiquity, 2004), flow depends on **concentration without interruption** and **speed/immediate feedback** [10]. A filter that injects latency or rejects intended gestures violates both characteristics, breaking the optimal-experience state musicians depend on.

## Adaptive assistive music tools (alternative to filtering)

Where filtering the manual gesture is intractable, the design alternative is to change the input modality entirely. **EyeHarp** (Music Technology Group, Pompeu Fabra University; Zacharias Vamvakousis) is a free, open-source (openFrameworks/C++) **gaze- or head-controlled** digital musical instrument, usable with a Tobii eye tracker, designed for cerebral palsy, ALS, muscular dystrophy, upper-limb amputation, and spinal-cord injury. By removing the tremulous hand from the control loop, it sidesteps the tremor/vibrato separation problem rather than solving it in real-time MIDI.

## Motor-skill retention between adaptive and standard interfaces

The motor-learning consideration is that a heavily adaptive interface alters the mapping between user motion and output, so skills learned on the adaptive system may not transfer cleanly to a standard one (and vice versa) — a tension the source material touches only indirectly: SteadyMouse's tunable filter sets and "lighter feel" default exist precisely so users can dial the amount of adaptation up or down to preserve a familiar feel [6], and EyeHarp's distinct gaze/head paradigm trains a control skill orthogonal to keyboard MIDI, with no carryover to manual play. **No peer-reviewed study quantifying motor-skill retention or transfer specifically between adaptive and standard music-input interfaces was located.** The open question is best informed by the motor-learning **specificity-of-learning principle** (Henry, 1968, as reviewed by Wulf & Shea, *Psychonomic Bulletin & Review*, 2002): "learning is specific to the conditions encountered during practice," so learners whose practice conditions match their test/performance conditions hold an advantage [11]. Applied here, skill trained on a heavily adaptive interface should be expected to transfer imperfectly to an unfiltered standard one whenever the two present different motion-to-output mappings.

## Evidence gap and choose-when guidance

**Evidence gap.** Robust data exist for tremor *spectra* (clinical neurology) [5], real-time *cursor/input* tremor cancellation (WFLC, TechFilter) [7][4], and voluntary/tremulous *classification accuracy* [8], plus musical *latency* thresholds [9] and *flow* theory [10]. What is **absent** is any peer-reviewed, DAW-specific study of (a) MIDI vibrato-vs-tremor separation, (b) gesture-rejection false-positive rates in music capture, (c) threshold calibration vs composition completion time/satisfaction, and (d) adaptive-to-standard motor-skill transfer in musicians. The named DAW tools (Ableton, Logic) contribute no tremor functionality at all.

**Which approach fits which profile:**

| User profile | Best-fit approach | Rationale |
|---|---|---|
| **Essential tremor**, plays/edits with hands, deficit is action/postural oscillation ~4–8 Hz | OS-level/hardware cursor filter (SteadyMouse-style, light "Feather" calibration) for editing **+** Ableton velocity scaling to tame uneven note dynamics; reserve any frequency filtering for performance, not vibrato passages | Tremor is action-onset, no rest component; light filtering preserves intentional gestures and stays under latency thresholds [6][3][1][9] |
| **Parkinson's disease**, rest tremor 4–6 Hz plus bradykinesia/onset delay | Dedicated **accessible instrument (EyeHarp, gaze/head control)** that bypasses manual MIDI; SteadyMouse for cursor editing tasks | Manual deficits extend beyond oscillation (slowness, delay) that velocity scaling and frequency filters cannot address; modality change avoids the unsolved separation problem [5][3] |
| Either, wanting expressive vibrato preserved | Avoid aggressive frequency filtering; prefer adaptive zero-phase methods (WFLC-class) if implemented, accept ~2% residual gesture rejection | At a 0.98-specificity classifier ~2% of intended gestures are still rejected; tighter filtering loses vibrato to the overlap band [7][8] |

No DAW velocity-scaling feature is a substitute for tremor cancellation; OS-level filters help only mouse editing; and for the most impaired users a different input modality outperforms any in-MIDI filter.

## Sources

1. [Live MIDI Effect Reference — Ableton Reference Manual Version 12
 | Ableton](https://www.ableton.com/en/manual/live-midi-effect-reference/)
2. [Map screen controls, Logic Pro X Help](https://logicpro.skydocu.com/en/use-smart-controls/map-screen-controls/)
3. [SteadyMouse - Tremor Reducing Mouse Software](https://www.steadymouse.com/)
4. [tad00198.pdf](http://www.neuralrehabilitation.org/projects/tremor/Documents/tad00198.pdf)
5. [Differential Diagnosis of Parkinson Disease, Essential Tremor, and Enhanced Physiological Tremor with the Tremor Analysis of EMG - PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC5573102/)
6. [SteadyMouse - Release Notes](https://www.steadymouse.com/downloads/release_notes/)
7. [Modeling and Canceling Tremor in Human-Machine Interfaces - IEEE Engineering in Medicine and Biology Magazine](https://publications.ri.cmu.edu/storage/publications/pub_files/pub3/riviere_cameron_1996_1/riviere_cameron_1996_1.pdf)
8. [Automatic differentiation of voluntary and tremulous motion using ensemble empirical mode decomposition and convolutional Bi-directional LSTM - Scientific Reports](https://www.nature.com/articles/s41598-025-08216-7)
9. [schuett_honorThesis2002.pdf](https://ccrma.stanford.edu/groups/soundwire/publications/papers/schuett_honorThesis2002.pdf)
10. [Interfaces for staying in the flow](https://ubiquity.acm.org/article.cfm?id=1074069)
11. [Principles derived from the study of simple skills do not generalize to complex skill learning](https://doi.org/10.3758/bf03196276)