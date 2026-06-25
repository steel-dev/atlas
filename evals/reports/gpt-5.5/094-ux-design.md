# UX of adaptive input systems for musicians with hand tremor in DAWs

**Bottom line.** For musicians with essential tremor or Parkinsonian tremor, the core UX problem is not simply “remove 4–12 Hz motion.” The same frequency region is clinically useful for tremor detection—Parkinsonian tremor is commonly around 4–6 Hz, essential tremor commonly around 5–8 Hz or 6–12 Hz depending on study framing—and musically useful for vibrato/tremolo: singer and bowed-string vibrato often sits around 5–6.5 Hz. Therefore, **Ableton Live’s Velocity MIDI effect is the best of the three named approaches for narrow note-dynamics cleanup**, **SteadyMouse is the best for DAW pointer stabilization**, and **Logic Pro Smart Controls are useful for mapping/scaling but are not Apple-documented tremor compensation**. None of the fetched DAW sources documents a real-time classifier that separates pathological tremor from intentional vibrato in MIDI pitch bend, aftertouch, modulation-wheel, or MPE expression.

| Approach, current version baseline | What it can safely improve | What it should not be trusted to filter | Pointer stabilization | Latency/flow implication | Overall rank for DAW musician with tremor |
|---|---:|---:|---:|---:|---:|
| **Ableton Live 12.4.2**, release notes dated **June 11, 2026** | Best for **note-on/note-off velocity** remapping, compression/companding, gating, randomization, and fixed output velocity through the native **Velocity** MIDI effect | Does **not** filter CC1, CC11, pitch bend, channel pressure, poly aftertouch, or MPE pitch/slide/pressure; those carry intentional vibrato/expression | No | MIDI note-dynamics processing is real time and musically local, so least likely to disturb continuous expressivity when restricted to velocity | **#1 for note dynamics; #2 overall** |
| **SteadyMouse v2.8.7.1 / SteadyMouse 2**, Windows pointer tool | Best for mouse cursor shake and accidental-click reduction around DAW UI editing | Does **not** filter MIDI events and cannot distinguish musical vibrato from tremor in captured MIDI | Yes: anti-tremor filtering, accidental-click blocking, icon targeting, system toggle | Higher anti-tremor strength improves stability but increases lag; manual recommends tuning to weakest strength that still removes tremor | **#1 for pointer access; #1 adjunct tool; not a MIDI solution** |
| **Logic Pro 12.2**, current fetched release section; Apple page exposes **Published Date: April 09, 2026** for the support article, not a version-specific 12.2 release date | Useful for Smart Control assignment, range scaling, mapping graphs, and all-or-nothing MIDI event-type input filtering | No Apple-documented Smart Controls tremor compensation, smoothing, frequency filtering, or accessibility parameter for MIDI/automation gestures | Relies on macOS/third-party tools; Logic accessibility page is VoiceOver/UI focused | Scaling can reduce amplitude of control excursions but cannot preserve intentional 4–12 Hz modulation while rejecting pathological 4–12 Hz motion | **#3 for tremor compensation; useful as a mapping layer** |

## 1. Current product facts that determine the UX baseline

### Ableton Live

Ableton’s Live 12 release-notes page lists **Live 12.4.2**, with release notes dated **June 11, 2026**, as the latest stable Live 12 release in the fetched release-notes page [1]. The Live 12 MIDI Effect Reference includes a native MIDI effect named **“Velocity”**; it “alters the velocity values (1–127) of incoming MIDI notes” and remaps incoming values through **Lowest/Range** and **Out Low/Out Hi** ranges [2].

The Velocity effect is a **note-velocity processor**, not a general tremor filter. It can:

- process **Note On velocity**, **Note Off / release velocity**, or both, via the documented release-velocity option [2];
- **gate** notes outside the input range, using Gate mode, or clip/fix values through other modes [2];
- **remap** velocity values through the velocity curve and output ranges [2];
- **compress/expand** velocity response using Drive and Compand, where negative Compand compresses toward the middle of the curve [2];
- **randomize** incoming velocities with its Random control [2].

Ableton’s MPE editor makes the event boundary clear: Live records/edits five per-note MPE dimensions—**Pitch** as per-note pitch bend, **Slide** as per-note Y-axis, **Pressure** as poly aftertouch/MPE pressure, **Velocity**, and **Release Velocity** [3]. The Velocity effect documentation only describes velocity values of incoming MIDI notes, while Ableton’s separate **CC Control** device handles Mod Wheel, Pitch Bend, Pressure, and customizable CC controls [2]. Thus, for the requested event list:

| MIDI dimension | Affected by Ableton Velocity effect? | UX implication |
|---|---:|---|
| Note-on velocity | **Yes** | Safe target for tremor-related dynamic cleanup when the musical goal is even note attack |
| Note-off / release velocity | **Yes, if selected** | Safe only when release velocity is not being used expressively |
| CC1 modulation wheel | **No** | Preserve or handle with separate controller workflow |
| CC11 expression | **No** | Preserve; do not assume velocity smoothing affects it |
| Pitch bend | **No** | Requires performer-controlled bypass if vibrato is intentional |
| Channel pressure / aftertouch | **No** | Requires performer control or external filtering |
| Poly aftertouch | **No** | MPE pressure should be preserved for expressive playing |
| MPE pitch/slide/pressure | **No, except velocity/release-velocity dimensions** | Per-note expression overlaps with vibrato and should not be blanket-filtered |

### Logic Pro

Apple’s Logic Pro for Mac release-notes page lists **Logic Pro 12.2** as the current fetched release section; the fetched page exposes **“Published Date: April 09, 2026”** for the support article, but not a separate version-specific release date for Logic Pro 12.2 [4]. Apple’s Smart Controls documentation describes Smart Controls as **onscreen controls for the selected track** that control channel-strip and plug-in parameters, including software instruments and effects; one screen control can control one or more mapped parameters [5].

Apple’s Smart Controls and controller-assignment documentation supports **assignment and scaling**, not tremor compensation:

- hardware controls including **faders, knobs, buttons, drum pads, pedals, and other controls** can be assigned to Smart Control screen controls; after assignment, the screen control receives MIDI messages from the hardware control [6];
- Smart Control parameter mapping graphs scale input values to output values, with input on the x-axis and output on the y-axis; users can edit curves, choose predefined curves, and change minimum/maximum ranges [7];
- Controller Assignments Expert View exposes **Minimum/Maximum**, **Multiply**, and modes including **Direct, Toggle, Scaled, Relative, Rotate, and X-OR** [8];
- Logic Pro’s Accessibility settings are VoiceOver/UI options—announcing playhead position on playback, recording, or scrubbing, and opening plug-ins in Controls view—rather than tremor compensation or MIDI smoothing [9].

Logic’s MIDI input path includes an all-or-nothing **Input Filter** at the project level. It can block entire incoming event types before the selected MIDI track receives them: **Notes, Program Changes, Pitch Bend, Control Changes, Aftertouch, Polyphonic Aftertouch, and System Exclusive** [10]. That is useful as a safety switch—e.g., temporarily blocking pitch bend from a shaky wheel—but it is not a gesture classifier and cannot preserve intentional vibrato on the same event stream.

| Logic path | Assignable/filterable event types | Smoothing/scaling status | UX implication |
|---|---|---|---|
| Smart Controls external assignment | MIDI hardware controls such as faders, knobs, buttons, drum pads, pedals, and other controls [6] | Range/curve scaling through mapping graphs [7] | Good for reducing amplitude sensitivity of mapped parameters |
| Controller Assignments Expert View | Incoming MIDI values handled through min/max, multiply, and assignment modes [8] | Scaling/mode logic, not temporal smoothing [8] | Can make controls less jumpy but does not detect tremor frequency |
| MIDI Project Input Filter | Notes, program changes, pitch bend, control changes, aftertouch, poly aftertouch, SysEx [10] | Event-type blocking only [10] | Useful emergency bypass; destructive if it blocks expressive dimensions |
| Accessibility settings | VoiceOver/playhead/UI plug-in presentation settings [9] | No Apple-documented tremor filter [9] | Accessibility baseline, not motor tremor compensation |

### SteadyMouse

The SteadyMouse release-notes page begins with **“SteadyMouse v2.8.7.1”** as the current product version in the fetched page [11]. The manual identifies the product family as **SteadyMouse 2** and lists Windows support for **Windows 11 x86/x64/ARM64, Windows 10, Windows 8.1, Windows 8, Windows 7, Windows Vista, Windows XP SP3, Windows Server 2016, and Windows Server 2012**; it states that macOS and Linux support are not yet available [12].

SteadyMouse is explicitly **mouse-pointer tremor filtering**, not MIDI filtering. Its homepage says it is assistive software for Essential Tremor and tremor variants accompanying Parkinson’s disease and multiple sclerosis, detecting and removing shaking motion before it reaches the cursor and blocking accidental clicks [13]. The manual groups controls into **Anti-tremor Filtering**, **Ignore Accidental Clicks**, **Icon Targeting**, and a **System Toggle Switch** [12]. A 2014 Assistive Technology paper describes SteadyMouse as a **Windows-based FIR low-pass-style filter** with different coefficients and order of magnitude at different slider positions, adjusted manually by the user [14].

SteadyMouse’s documented tuning model is practical rather than spectral: start with mouse speed below **10%**, set anti-tremor filter strength around **95%**, try filter sets until tremor no longer gets through, then reduce strength until tremor returns and raise it slightly; the manual recommends filter sets including **Feather, Allegro, Adagio, and Classic**, and recommends keeping mouse speed below **50%** to avoid Windows accuracy loss from upscaling [12]. Its documentation does not state an explicit **4–12 Hz** notch or rejection band; the 4–12 Hz rejection is therefore implicit in pointer stabilization rather than a user-visible frequency-domain control [12], [14].

## 2. Why tremor suppression conflicts with musical expression

The clinical and musical frequency ranges overlap too much for a DAW to treat frequency alone as intent.

| Phenomenon | Documented range/value | Overlap with 4–12 Hz tremor band? | Source |
|---|---:|---:|---|
| Parkinsonian tremor | EMG study: PD tremor **4–6 Hz**, with 25 PD participants in the differential-diagnosis study | Yes | [15] |
| Essential tremor | ET commonly **5–8 Hz** in accelerometry/EMG bedside-review evidence; another clinical framing gives ET commonly **6–12 Hz** | Yes | [16], [17] |
| Enhanced physiologic tremor | **6–12 Hz** in the EMG differential-diagnosis study | Yes | [15] |
| Classical voice vibrato | 75 college vocal music majors: best classical mean rates across vowels **5.0–5.16 Hz**, with voice-part means soprano **5.42 Hz**, mezzo **4.62 Hz**, tenor **4.91 Hz**, baritone **5.11 Hz** | Yes | [18] |
| Voluntary singer vibrato targets | 8 female singers matched faster target **6.1 Hz**; slower target **4.1–4.5 Hz** was less consistent and disrupted oscillatory pattern | Yes | [19] |
| Bowed-string vibrato | Violin/viola study: college violinists around **5.07–5.10 Hz** in the MacLeod dissertation; cited earlier string data include violinists **6.5 Hz**, cellists **5 Hz**, double bassists **4 Hz** | Yes | [20] |
| Guitar pitch vibrato / string bending | PLOS One analyzes electric-guitar string-bending and vibrato-like pitch techniques as intentional pitch modulation; rate-specific values are not reported in the extracted passages | Conceptual overlap when performed in the same 4–12 Hz range | [21] |
| MIDI pitch-bend vibrato, aftertouch vibrato, modulation-wheel LFO | Ableton documents MPE pitch/pressure/slide lanes and an MPE LFO tool for Pitch Bend, Pressure, or Slide with rate and amplitude; musical rates typically mirror vocal/string vibrato when mapped to pitch/amplitude | Yes, when set around 4–12 Hz | [3], [1], [22] |

This produces the central algorithmic conflict:

- **In tremor suppression**, a 4–12 Hz oscillation in hand motion is often treated as involuntary noise, especially for cursor movement or unwanted changes in a continuous controller.
- **In music performance**, a 4–12 Hz oscillation may be the expressive signal: pitch-bend vibrato, aftertouch vibrato, modulation-wheel LFO vibrato, string vibrato, tremolo, or amplitude modulation.

Therefore, the safe filtering boundary is not “filter 4–12 Hz.” It is **filter only dimensions where the performer has declared the dimension non-expressive for the current task**.

| MIDI dimension | Default filtering rule | Reason |
|---|---|---|
| Note-on velocity | Filter/remap allowed | Velocity spikes can be unintentional, and Ableton Velocity is designed for this exact dimension [2] |
| Note-off velocity | Filter/remap allowed only if release velocity is not part of the articulation | Ableton can process release velocity, but release behavior can be expressive [2] |
| CC1 modulation, CC11 expression | Performer-controlled bypass required | These are continuous expressive dimensions; Smart Controls can scale mapped values but cannot separate tremor from intentional oscillation [6], [7] |
| Pitch bend | Performer-controlled bypass required | Vibrato is often intentional in the same 4–12 Hz range; Logic can block pitch bend only as an entire event type [10] |
| Channel pressure / poly aftertouch | Performer-controlled bypass required | Ableton MPE pressure is an expression lane; Logic can block aftertouch but not classify intent [3], [10] |
| MPE pitch/slide/pressure | Bypass by default unless the performer arms a correction pass | These per-note dimensions are the highest-risk site for false rejection of musical expression [3] |
| Mouse pointer movement | Filter allowed, with quick bypass | Pointer shake is not captured as MIDI expression unless mapped through a controller; SteadyMouse includes a system toggle [12] |

## 3. HCI evidence on tremor filtering and false rejection

The strongest fetched evidence is from **assistive pointing**, not DAW/MIDI capture. These studies support practical calibration principles but do not prove composition-time, flow, or professional-musician outcomes.

### SteadyMouse / APSS comparison

Bani Hashem et al.’s 2014 Assistive Technology paper, **“Improving Mouse Controlling and Movement for People with Parkinson’s Disease and Involuntary Tremor Using Adaptive Path Smoothing Technique via B-Spline,”** tested **7 Parkinson’s patients with tremor**; severe/high tremor users who could not hold a mouse were excluded, and no professional musicians or composers were reported [14]. Preliminary sampling used **2 Parkinson’s users with involuntary tremor** and **2 healthy users**, with both Parkinson’s users also participating in final testing [14].

The APSS algorithm used real-time X/Y cursor-trajectory break-point detection plus mean filtering and B-spline smoothing. The threshold parameter **m** was drawn from **{2, 3, 4, 7, 10} pixels**: high tremor used **m = 2–3**, medium tremor used **m = 4**, low tremor used **m = 7–10**, and the default was **m = 4**; adaptation occurred in the first **<5 seconds** [14]. The authors classified tremor by breakpoints per second: **>4** high tremor, **2–4** medium tremor, and **<2** low tremor, which they reported as correct for all cases in the small study while calling for larger Parkinson’s samples [14].

Task-completion times showed no significant APSS–SteadyMouse difference and no observed delay for either technique [14]:

| Participant | APSS TCT, seconds | SteadyMouse TCT, seconds | Faster condition |
|---:|---:|---:|---|
| 1 | 143.3 | 165.0 | APSS |
| 2 | 136.3 | 128.5 | SteadyMouse |
| 3 | 111.2 | 104.3 | SteadyMouse |
| 4 | 76.2 | 69.5 | SteadyMouse |
| 5 | 43.6 | 38.3 | SteadyMouse |
| 6 | 18.6 | 21.9 | APSS |
| 7 | 17.4 | 14.3 | SteadyMouse |

APSS user acceptance used a **12-item, 5-point Likert UAT for APSS only**, not SteadyMouse. About **86%** of participants agreed or strongly agreed APSS was easy to use, and ease-of-use mean was **4.00/5** [14]. The study did not report Flow State Scale, Short Flow State Scale, Creative Flow, SUS, NASA-TLX, UEQ, interruption counts, composition completion times, or motor-skill retention when returning to standard interfaces [14].

### Steady Clicks and click-error filtering

Trewin, Keates, and Moffatt’s **Steady Clicks** work addresses click errors rather than MIDI expression. The 2008 Disability and Rehabilitation: Assistive Technology evaluation used **11 individuals with motor impairments** in a repeated-measures clicking task with and without Steady Clicks; Steady Clicks suppresses slipping while clicking and accidental clicking by freezing the cursor during mouse clicks, preventing overlapping button presses, and suppressing clicks made while the mouse is moving at high velocity. In that study, **5 of 11 participants** selected targets with significantly fewer attempts and improved overall task times. This is a relevant false-rejection/false-acceptance analogue for DAW UI clicks, but it is not evidence about intentional musical vibrato rejection.

### Wobbrock-style pointing and adaptive filtering

The fetched corpus includes Wobbrock-style pointing literature as a related HCI foundation, including ability-based design and enhanced cursor/target-acquisition techniques [23]. These systems generally manipulate pointing mechanics—target acquisition, cursor gain, area cursors, or click stabilization—rather than classifying musical intent. Bani Hashem et al. also cite related pointing techniques such as target acquisition aids and identify SteadyMouse and APSS as trajectory-smoothing approaches [14]. The relevant algorithm families are:

- **low-pass/FIR filtering**, represented by the SteadyMouse description in Bani Hashem et al. [14];
- **adaptive path smoothing**, represented by APSS break-point detection plus mean filtering and B-spline smoothing [14];
- **click-error suppression**, represented by Steady Clicks’ freeze/velocity-click suppression design;
- **target-acquisition assistance**, represented by Wobbrock-style pointing and ability-based design sources [23].

The fetched sources did not establish a DAW/MIDI study reporting false-positive rates for rejecting intentional vibrato, false-negative rates for accepting pathological tremor as MIDI expression, or classifier accuracy for separating pathological tremor from musical vibrato in real-time MIDI capture. The documented false-rejection evidence is therefore extrapolated from pointing and clicking tasks, not from musicians’ continuous-controller performance.

## 4. Real-time MIDI/music-expression evidence

The fetched music sources establish the **overlap problem**, not a solved classifier. Ableton documents MPE capture/editing of per-note pitch, slide, pressure, velocity, and release velocity [3], and Live 12 release notes document an MPE LFO transformation tool that can set an oscillating envelope for **Pitch Bend, Pressure, or Slide** with selectable shape, rate, and amplitude envelope [1]. Those features confirm that the same dimensions a tremor filter might target are first-class musical-expression dimensions.

The fetched sources did not identify a named, evaluated real-time MIDI system that separates pathological tremor from intentional vibrato across pitch bend, aftertouch, modulation-wheel, or MPE streams in DAWs. Accessibility-focused music-technology claims about completion time, satisfaction, creative flow, and skill transfer should therefore be treated as extrapolations unless a DAW/MIDI-specific study is added.

## 5. Calibration decision rules for musicians

Because the frequency band overlaps, calibration should be **task- and dimension-specific**, not global.

### Required safeguards

1. **Per-dimension arming:** enable filtering only on the dimension being corrected—e.g., Ableton Velocity for note-on velocity—not on pitch bend, aftertouch, or MPE pressure unless the performer explicitly arms it [2], [3].
2. **Fast bypass:** provide a physical or key-command bypass for continuous expression. SteadyMouse’s system toggle model is appropriate for pointer stabilization because users can turn all features on/off globally [12].
3. **Raw-data preservation:** record raw MIDI takes where possible before applying destructive gating, because Logic’s Input Filter blocks entire event types before they reach the track [10].
4. **Separate performance and editing modes:** use looser filtering while recording expressive takes and stronger filtering while editing notes, automation points, or mixer controls.

### Low, medium, and high thresholds

| Calibration level | When appropriate | Concrete settings supported by sources | UX risk |
|---|---|---|---|
| **Low sensitivity / light filtering** | Mild tremor, expressive recording, pitch bend/aftertouch/MPE performance | APSS low tremor corresponds to **<2 breakpoints/s** and **m = 7–10 pixels** [14]; SteadyMouse manual says choose the weakest setting that still removes shake [12] | Tremor may leak into data, but creative control is preserved |
| **Medium sensitivity** | General DAW editing and non-expressive controller mapping | APSS medium tremor corresponds to **2–4 breakpoints/s** and **m = 4 pixels**, also its default [14]; Logic Smart Controls can scale mapped values through min/max curves [7] | Some intended small gestures may be compressed |
| **High sensitivity / heavy filtering** | Severe pointer instability, accidental clicks, non-expressive note-entry cleanup | APSS high tremor corresponds to **>4 breakpoints/s** and **m = 2–3 pixels** [14]; SteadyMouse tuning starts at **95%** filter strength and mouse speed **<10%**, then backs off [12] | Highest risk of lag and rejecting intentional nuance; avoid on vibrato-bearing streams |

### Optional convenience settings

- **Velocity compression/companding** in Ableton can reduce unintended note-dynamics variance while leaving pitch/pressure expression intact [2].
- **Logic Smart Control scaling curves** can make a mapped filter cutoff, send level, or instrument macro less sensitive to small controller excursions [7].
- **SteadyMouse Icon Targeting** can reduce fine pointer demand when clicking DAW buttons, and **Ignore Accidental Clicks** can reduce unintended UI actions [12].

### Fallback workflows when DAW-native tremor compensation does not exist

1. **Ableton:** use Velocity only for note dynamics; keep pitch bend/aftertouch/MPE raw; apply MPE editing or transformation after capture rather than live rejection [3], [2].
2. **Logic:** use Smart Controls for range scaling, not tremor filtering; use Input Filter only as a deliberate event-type kill switch; preserve takes before blocking pitch bend or aftertouch [7], [10].
3. **Pointer access:** use SteadyMouse on Windows for DAW UI navigation and editing; on macOS/Logic systems, use OS-level accessibility and external assistive devices rather than expecting Smart Controls to stabilize tremor [12], [9].
4. **Performance design:** map intentional vibrato to a dimension the performer can reliably control—e.g., aftertouch or a foot pedal—while filtering only unrelated note velocity or pointer movement.

## 6. Impact on creative flow, completion time, satisfaction, and skill retention

The documented completion-time and satisfaction evidence is from pointing tasks, not professional composition. The APSS/SteadyMouse comparison provides exact task-completion times for **7 Parkinson’s participants** and reports no significant TCT difference and no observed delay [14]. The APSS-only UAT reports **86%** agreement/strong agreement on ease of use and mean ease-of-use **4.00/5** [14]. Steady Clicks reports that **5/11** motor-impaired participants improved in attempts and overall task time in a clicking task.

No fetched DAW or music-performance case study reports professional musicians with essential tremor, Parkinson’s disease, dystonia, stroke, or other movement disorders completing composition tasks under low/medium/high MIDI filtering thresholds. No fetched source reports Flow State Scale, Short Flow State Scale, Creative Flow, NASA-TLX, SUS, UEQ, interruption counts, or qualitative flow disruption specifically for adaptive DAW/MIDI tremor compensation. Consequently, claims about creative flow should be limited to mechanism-level UX inference: heavy filtering and event-type blocking can interrupt flow by rejecting intentional gestures, while narrowly scoped velocity remapping and pointer stabilization can reduce error-recovery interruptions.

Motor-skill retention and transfer are likewise not established in the fetched DAW/MIDI sources. The APSS study used random ordering to reduce learning effects and a 15-minute training/familiarization session, but it did not measure longitudinal adaptation, washout, after-effects, retention, or performance degradation when users moved between tremor-compensated and standard mouse/MIDI/DAW interfaces [14]. The practical implication is to avoid adaptations that train musicians into a hidden, non-portable control law: keep standard-interface practice sessions, maintain raw-MIDI capture, and make filter state visible.

## 7. Population validity

| Study/system | Participants with movement disorder | Diagnosis detail | Professional musician/composer status | What the result can validly support |
|---|---:|---|---|---|
| Differential diagnosis EMG study | **25 PD, 20 ET, 20 enhanced physiologic tremor** | PD 4–6 Hz; ET overlaps; EPT 6–12 Hz | Not musicians | Tremor frequency overlap and diagnostic ambiguity [15] |
| ET vs PD bedside/accelerometry review | **22 PD, 20 ET** in cited accelerometry/EMG comparison | >95% PD frequencies 4–6 Hz; 95% ET frequencies 5–8 Hz | Not musicians | Clinical overlap with musical vibrato bands [16] |
| Bani Hashem et al. APSS/SteadyMouse | **7 Parkinson’s patients with tremor** final test; preliminary **2 Parkinson’s + 2 healthy** | Severe/high tremor users unable to hold mouse excluded | Not reported as musicians | Pointer smoothing, TCT, APSS UAT only [14] |
| Steady Clicks evaluation | **11 individuals with motor impairments** | Motor impairment not limited to ET/PD in the pinned finding | Not reported as musicians | Click-error suppression and target-selection attempts/time, not MIDI expression |
| Voice vibrato study | **75 college vocal music majors** | No movement disorder | Musicians, but not tremor population | Intentional vibrato rates around 5 Hz [18] |
| MacLeod violin/viola dissertation | **58 high-school/university string players recorded; 48 selected for analysis** | No movement disorder | Student musicians, not professional tremor population | Intentional bowed-string vibrato rates around 5 Hz and cited 4–6.5 Hz string values [20] |

The population mismatch is decisive: the strongest tremor-filtering UX studies involve general computer users with Parkinson’s or motor impairments, while the strongest music-expression studies involve musicians without movement disorders. There is no fetched professional-musician DAW case series tying sensitivity thresholds to composition completion time, satisfaction, creative flow, or skill retention.

## 8. DAW-accessibility baseline as of 2026-06-24

- **Ableton Live:** supports MIDI/key mapping for device controls and records/edits MPE pitch, slide, pressure, velocity, and release velocity; its native Velocity MIDI effect can remap/compress/gate/randomize note velocities but not continuous controller expression [3], [2].
- **Logic Pro:** supports Smart Controls, external hardware assignment, controller-assignment value scaling, parameter mapping graphs, key/control workflows, and MIDI Input Filter event-type blocking; Apple’s Logic accessibility page documents VoiceOver/playhead/UI plug-in options, not tremor stabilization [5], [8], [9], [6], [7], [10].
- **OS/external assistive-device compatibility:** SteadyMouse 2 is Windows-only across Windows 11 through XP SP3 and Windows Server 2016/2012, with macOS/Linux support not available in the manual; it can stabilize DAW pointer interaction on Windows but is outside the MIDI event path [12], [13].

## Final recommendation

Use **two separate adaptation layers** rather than a single tremor filter. First, use **Ableton Velocity or equivalent note-velocity remapping** for discrete note dynamics when the goal is cleaner MIDI note entry. Second, use **SteadyMouse-like pointer stabilization** for DAW editing and clicking. Treat **Logic Smart Controls** as a mapping/scaling layer, not tremor compensation. Do **not** apply frequency-based 4–12 Hz suppression to pitch bend, aftertouch, modulation wheel, CC11 expression, or MPE pitch/slide/pressure unless the performer explicitly arms that filter for a non-expressive passage and can bypass it immediately. The reason is empirical and musical: the same 4–12 Hz band that identifies tremor also contains normal vocal and instrumental vibrato.

- Ableton Live 12 manual section 29.8 is named “Velocity”; it alters velocity values (1–127) of incoming MIDI notes to constrain/remap outgoing velocities within Lowest/Range and Out Low/Out Hi ranges.

## Sources

1. [Live 12 Release Notes
 | Ableton](https://www.ableton.com/en/release-notes/live-12/)
2. [Live MIDI Effect Reference — Ableton Reference Manual Version 12
 | Ableton](https://www.ableton.com/en/manual/live-midi-effect-reference/)
3. [Editing MPE — Ableton Reference Manual Version 12
 | Ableton](https://www.ableton.com/en/manual/editing-mpe/)
4. [Logic Pro for Mac release notes - Apple Support](https://support.apple.com/en-us/109503)
5. [Overview of Smart Controls in Logic Pro for Mac](https://support.apple.com/en-gb/guide/logicpro/lgcp7e59f24b/12.2/mac/15.6)
6. [Assign hardware controls to screen controls in Logic Pro for Mac](https://support.apple.com/en-gb/guide/logicpro/lgcp0155c51f/12.2/mac/15.6)
7. [Use parameter mapping graphs in Logic Pro for Mac](https://support.apple.com/en-gb/guide/logicpro/lgcp71263293/12.2/mac/15.6)
8. [Controller assignments Expert view Value parameters in Logic Pro for Mac](https://support.apple.com/en-by/guide/logicpro/ctls71c308ee/12.2/mac/15.6)
9. [Accessibility settings in Logic Pro for Mac](https://support.apple.com/en-gb/guide/logicpro/lgcpefb6766e/12.2/mac/15.6)
10. [Input Filter project settings in Logic Pro for Mac](https://support.apple.com/en-gb/guide/logicpro/lgcp0683d564/12.2/mac/15.6)
11. [SteadyMouse - Release Notes](https://www.steadymouse.com/downloads/release_notes/)
12. [SteadyMouse - User Manual](https://www.steadymouse.com/manual/)
13. [SteadyMouse - Tremor Reducing Mouse Software](https://www.steadymouse.com/)
14. [steadymouse_resna_publication.pdf](https://www.steadymouse.com/downloads/steadymouse_resna_publication.pdf)
15. [Differential Diagnosis of Parkinson Disease, Essential Tremor, and Enhanced Physiological Tremor with the Tremor Analysis of EMG - PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC5573102/)
16. [Distinguishing essential tremor from Parkinson’s disease: bedside tests and laboratory evaluations - PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3475963/)
17. [Approach to a tremor patient - PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC5144461/)
18. [Vibrato Rate and Extent in College Music Majors: A Multicenter Study - PubMed](https://pubmed.ncbi.nlm.nih.gov/26564579/)
19. [Frequency modulation characteristics of sustained /a/ sung in vocal vibrato - PubMed](https://pubmed.ncbi.nlm.nih.gov/2601313/)
20. [view](https://repository.lib.fsu.edu/islandora/object/fsu%3A181053/datastream/PDF/view)
21. [String Theory - The Physics of String-Bending and Other Electric Guitar Techniques](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0102088)
22. [Vibrato Simulation](https://ccrma.stanford.edu/~jos/pasp/Vibrato_Simulation.html)
23. [taccess-08.pdf](https://faculty.washington.edu/wobbrock/pubs/taccess-08.pdf)