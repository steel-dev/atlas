# Bottom line

The evidence supports a **hybrid touch/screen-reader-with-audio design as the default checkout pattern**, with **optional voice commands for shortcuts and low-risk actions**, not a sequential voice-only checkout. The strongest quantified blind-user evidence is not grocery checkout: **Kane et al.’s Slide Rule study (ASSETS 2008)** compared a spatial touch+audio iPhone prototype with a more sequential Mobile Speak Pocket screen-reader workflow and found faster selection with touch+audio (**11.69 s vs 12.79 s mean task time**) but more selection errors (**17/120 Slide Rule trials, 14.1%, vs 0 Pocket PC errors**) [1]. Voice-command evidence from **JustSpeak (W4A 2014)** shows a plausible voice layer built from Android accessibility labels and ASR confidence hypotheses, but it does **not** report participant counts, task completion, errors, or confidence scores [2]. Payment/authentication evidence from **Briotto Faustino & Girouard (ASSETS 2018)** favors biometric/passcode alternatives over spoken or repeated PIN entry: among **325 blind/low-vision respondents**, fingerprint was the most-used method (**73.0%**) and selected as most secure by **N=184**, while PIN was selected least secure by **N=149** [3].

| Checkout task | Recommended primary modality | Evidence strength | Why |
|---|---:|---:|---|
| Product/list selection | **Hybrid touch + audio/screen reader**, with optional voice search/shortcut | **Moderate analog** | Slide Rule’s nonvisual touch+audio selection was faster than sequential screen-reader navigation (**11.69 s vs 12.79 s**) but less accurate (**14.1% trials with errors vs 0**), so product selection should keep spatial/touch browsing but add confirmation and reversible correction [1]. |
| Quantity adjustment / numeric entry | **Adjustable stepper/picker exposed to screen reader, with optional constrained voice and read-back** | **Weak direct; strong standards rationale** | No blind-user grocery study in the evidence set reports exact quantity/PIN/amount error rates by speech dictation, increment/decrement voice, screen-reader text entry, picker/stepper, or hybrid correction. WCAG requires identified errors, suggestions, reversible/checked/confirmed financial submissions, and non-redundant entry [4]. |
| Cart review for 15+ items | **Reviewable hybrid cart list/table plus summaries; avoid voice-only serial review as the only path** | **Weak direct; moderate analog** | No direct 15+ grocery-cart A/B study with NASA-TLX/Raw TLX/secondary-task workload was grounded. The closest quantified analog is Slide Rule’s list/hierarchy selection, where faster per-item listening in touch+audio (**0.95 s/item vs 1.42 s/item**) came with more missed/incorrect selections [1]. |
| Payment confirmation | **Biometric/platform payment or accessible passcode, plus explicit final review/confirm** | **Moderate authentication survey + strong WCAG** | WCAG 2.2 SC 3.3.4 requires reversible, checked, or review/confirm/correct handling for financial submissions; SC 3.3.8 prohibits authentication that relies only on cognitive-function tests unless an exception/alternative applies [4]. Blind/low-vision respondents favored fingerprint over PIN for accessibility/security [3]. |

## 1. Direct comparative evidence set through 2026-06-24

The available evidence set does **not** include a peer-reviewed A/B study that directly compares **sequential voice-only grocery checkout** with **hybrid touch-plus-audio/screen-reader grocery checkout** for blind or low-vision mobile users, nor a direct **15+ grocery-cart verification** experiment. The grounded comparative and closest-analog evidence set is therefore:

| Study / report | Year | Participants and impairment profile | Device / platform | Task type | Tested modalities | Quantified outcomes available |
|---|---:|---|---|---|---|---|
| **Kane et al., “Slide Rule,” ASSETS** | **2008** | **10 blind screen-reader users**, 8 men/2 women; mean age **41.2** (SD **11.5**); all had **≥10 years** screen-reader experience; **4** smartphone users; **6** had residual vision [1] | **Apple iPhone** touch prototype with pre-rendered speech vs **ASUS MyPal A730 Pocket PC**, Windows Mobile 2003, **Mobile Speak Pocket** [1] | Phone contacts, mail messages, music list/hierarchy selection; **2×3×4 within-subjects**, **240 trials** [1] | Spatial/nonlinear **touch+audio** Slide Rule vs more sequential button/touch screen-reader workflow on Pocket PC | Completion time, selection errors, listening time/item, Likert usability [1] |
| **Zhong et al., “JustSpeak,” W4A** | **2014** | No quantified participant study reported; beta release had “hundreds of users” and positive feedback [2] | Android **4.2+ accessibility service** | System-wide mobile command execution, including commands synthesized from labels/accessibility metadata and chained utterances [2] | Voice-command layer over Android accessibility APIs; not compared experimentally with touch/screen reader | ASR design evidence only; no completion time, errors, SUS, or confidence [2] |
| **Briotto Faustino & Girouard, mobile authentication survey, ASSETS** | **2018** | **325** adults with vision impairment from **12 countries**: **223 blind**, **93 low vision**, **9 other** [3] | Mobile-device authentication survey | Smartphone unlocking/authentication perceptions | PIN, alphanumeric password, pattern, fingerprint, facial recognition, iris scan, voice recognition | Usage and perceived security/accessibility counts; no payment-flow completion or false-acceptance test [3] |

## 2. Product-selection performance

The only grounded quantified selection comparison is Slide Rule’s closest analog to grocery/product list selection.

| Study / task analog | Modality | Completion rate | Mean / median time | Abandonment | Selection-error rate |
|---|---:|---:|---:|---:|---:|
| Slide Rule, overall phone/mail/music selection [1] | Touch+audio iPhone Slide Rule | Explicit rate not reported; **120/120 Slide Rule trials were included in results** | **11.69 s mean** (SD **5.77**) | Not reported | **17/120 trials with errors = 14.1%**; mean **0.20 errors/trial** (SD **0.56**) |
| Slide Rule, overall phone/mail/music selection [1] | Pocket PC + Mobile Speak Pocket sequential screen-reader workflow | Explicit rate not reported; **120/120 Pocket PC trials were included in results** | **12.79 s mean** (SD **7.58**) | Not reported | **0 errors** |
| Slide Rule, phone contacts [1] | Touch+audio vs Pocket PC screen reader | Not separately reported | **8.10 s vs 8.65 s** | Not reported | Touch+audio **0.10 errors/trial**; phone-call subset had **3/40** high-consequence errors; Pocket PC **0** |
| Slide Rule, mail messages [1] | Touch+audio vs Pocket PC screen reader | Not separately reported | **11.44 s vs 12.16 s** | Not reported | Touch+audio **0.18 errors/trial**; Pocket PC **0** |
| Slide Rule, music list/hierarchy [1] | Touch+audio vs Pocket PC screen reader | Not separately reported | **15.54 s vs 17.55 s** | Not reported | Touch+audio **0.33 errors/trial**; Pocket PC **0** |
| Slide Rule, per-item listening [1] | Touch+audio vs Pocket PC screen reader | Not a completion metric | **0.95 s/item** (SD **0.43**) vs **1.42 s/item** (SD **0.46**), F(1,8)=**68.88**, p<.001 | Not applicable | Authors note Pocket PC users were less likely to make errors or miss an item, while Slide Rule enabled faster nonlinear scanning [1] |

**Interpretation for groceries:** product selection benefits from hybrid touch/audio because users can scan faster and exploit spatial/nonlinear access, but the error pattern argues against silent one-shot selection. A grocery app should announce the selected product immediately, support undo/remove/restore, and preserve a sequential screen-reader path for users who prefer accuracy over speed.

## 3. Quantity adjustment and numerical-entry performance

The grounded sources do **not** provide exact blind/low-vision mobile error frequencies for grocery quantity, item count, price, payment amount, or PIN entry separated into speech dictation, voice-command increment/decrement, screen-reader text entry, picker/stepper controls, and hybrid correction flows. What is grounded is a risk model:

| Numeric-entry channel | Grounded evidence | Design implication |
|---|---|---|
| Speech recognition / dictation | JustSpeak reports Google ASR can return multiple scored hypotheses online; for the utterance **“setting”**, hypotheses were **“set ting” 0.90**, **“settings” 0.08**, **“sitting” 0.02** [2]. | Treat voice numeric input as probabilistic. Use constrained grammars such as “set quantity to 2,” reject low-confidence or ambiguous commands, and read back the parsed number before committing high-impact changes. |
| Voice-command increment/decrement | No grounded numeric error rate. JustSpeak supports flexible grammar and chained commands, e.g., **“Open Gmail then refresh”**, but does not quantify command errors [2]. | Voice increment/decrement can be a shortcut only when every change is announced and reversible. |
| Screen-reader text entry / PIN | Briotto Faustino & Girouard report PIN was used by **16.4%** and selected least secure by **N=149**; among those, **33.6%** cited guessability, **30.2%** shoulder surfing, and **22.1%** easy hacking [3]. | Avoid requiring repeated PIN entry inside checkout when platform biometric/passcode authentication is available. |
| Picker/stepper controls | No grounded error-rate study. WCAG 2.2 requires error identification, suggestion, redundant-entry avoidance, and financial review/confirmation patterns [4]. | Use adjustable controls with accessible value/state and deterministic step changes; announce “Quantity, 2, adjustable” and each increment/decrement result. |
| Hybrid correction flows | WCAG 2.2 SC 3.3.1, 3.3.3, 3.3.4, and 4.1.3 require text error identification, suggestions where known, reversible/checked/confirmed financial submissions, and programmatic status messages [4]. | Provide immediate status, focus the faulty field, offer suggested corrections, and keep a touch/screen-reader fallback after failed voice input. |

## 4. Payment confirmation and authentication evidence

No grounded source reports Apple Pay with VoiceOver or Google Pay with TalkBack checkout completion rate, misconfirmation/false-acceptance rate, failed-authentication rate, or trust score in a controlled payment study. The grounded evidence instead combines WCAG’s financial-submission requirements with a large blind/low-vision authentication survey.

| Evidence item | Value | Implication for checkout |
|---|---:|---|
| WCAG 2.2 SC 3.3.4 Error Prevention (Legal, Financial, Data), Level AA | For financial submissions, at least one of reversible, checked/correctable, or reviewed/confirmed/correctable before finalizing is required [4]. | Payment authorization must not be a single unreviewed voice command. |
| WCAG 2.2 SC 3.3.8 Accessible Authentication (Minimum), Level AA | Authentication must not require a cognitive-function test unless an alternative/mechanism/object-recognition/personal-content exception applies [4]. | Provide biometric or platform passcode alternatives and avoid memory-only spoken challenges. |
| Briotto Faustino & Girouard respondents | **325** total; **223 blind**, **93 low vision**, **9 other** [3] | Large enough survey support for authentication preference, but not a transaction-performance study. |
| Fingerprint use and perceived security/accessibility | Fingerprint used by **73.0%**; selected most secure by **N=184**; described as fast/easy and avoiding repetitive PIN typing [3] | Prefer platform biometric/payment confirmation where available, with accessible fallback. |
| PIN perception | PIN used by **16.4%**; selected least secure by **N=149**; reasons included easy to guess **33.6%**, shoulder-surfing **30.2%**, easy hacking **22.1%** [3] | Do not speak full sensitive payment details or require unnecessary repeated PIN entry; mask sensitive numbers and let users choose secure AT-compatible entry. |
| Voice recognition in authentication survey | Voice recognition usage **0%** in Figure 8 [3] | Spoken checkout confirmation should not be treated as an authentication factor. |

For high-consequence confirmation, the optimal strategy is therefore: read the merchant/action, item count, delivery/pickup option, total, and payment method descriptor; require a deliberate final control such as a platform payment sheet confirmation or clearly labeled “Place order” button; and keep cancellation/review reachable until authorization.

## 5. User confidence and subjective usability

The exact blind-user subjective usability data available are from Slide Rule; they show a speed/preference advantage for touch+audio but a control/familiarity advantage for the conventional screen-reader workflow.

| Measure, 5-point Likert where 1=Disagree strongly and 5=Agree strongly | Pocket PC + Mobile Speak Pocket | Slide Rule touch+audio | Interpretation |
|---|---:|---:|---|
| Easy to use | **4.6** (SD **0.52**) | **3.2** (SD **1.40**) | Conventional workflow felt easier [1]. |
| Fun to use | **3.9** (SD **1.20**) | **4.4** (SD **0.52**) | Touch+audio was more enjoyable [1]. |
| Fast to use | **3.8** (SD **0.92**) | **4.3** (SD **0.82**) | Matches measured time advantage [1]. |
| Felt in control | **4.7** (SD **0.48**) | **3.3** (SD **1.16**) | Critical warning for payment and quantity changes [1]. |
| Easy to learn | **4.9** (SD **0.32**) | **4.1** (SD **0.57**) | Screen-reader workflow had learnability advantage [1]. |
| Intuitive | **4.6** (SD **0.52**) | **4.3** (SD **0.95**) | Similar, slightly favoring conventional [1]. |
| Familiar | **3.8** (SD **1.48**) | **2.2** (SD **1.03**) | New gestures reduced familiarity [1]. |
| Features clear to me | **4.8** (SD **0.42**) | **4.7** (SD **0.48**) | Both were understandable [1]. |
| Improve with practice | **3.4** (SD **1.58**) | **4.5** (SD **0.71**) | Users expected gains with touch+audio [1]. |
| Would use on phone | **4.4** (SD **0.52**) | **4.1** (SD **1.45**) | Both acceptable [1]. |
| Overall preference | — | **7/10 preferred Slide Rule** | Preference favored touch+audio despite lower control/ease/familiarity [1]. |

The design consequence is not “voice-only” or “touch-only”; it is a hybrid that preserves users’ sense of control for risky operations while using touch/audio shortcuts where they reduce scan time.

## 6. Cognitive load and long cart verification

No grounded study reports NASA-TLX, Raw TLX, secondary-task, or memory-error workload scores for blind/low-vision users verifying **15+ grocery-cart items** under voice-only serial review versus hybrid touch/audio review. The closest validated list analog in the grounded set is Slide Rule’s phone/mail/music list and hierarchy tasks, but the source notes do not establish a specific 15+ item count per list. Its relevant workload proxy is listening efficiency: touch+audio reduced listening time from **1.42 s/item** to **0.95 s/item**, while increasing errors from **0** to **17/120 trials** [1].

For a 15+ item cart, this supports a conservative workload pattern: do not force a single serial voice readout as the only review mechanism. Provide (1) a grouped summary, (2) an editable item list/table, (3) change-only summaries after edits, (4) a repeat-last-summary command, and (5) final total read-back before payment.

## 7. WCAG 2.2 checkout requirements

| WCAG 2.2 SC | Level | Official name | Normative requirement relevant to checkout |
|---|---:|---|---|
| **3.3.1** | **A** | **Error Identification** | If an input error is automatically detected, the item in error is identified and the error is described to the user in text [4]. |
| **3.3.3** | **AA** | **Error Suggestion** | If an input error is automatically detected and correction suggestions are known, suggestions are provided unless they would jeopardize security or purpose [4]. |
| **3.3.4** | **AA** | **Error Prevention (Legal, Financial, Data)** | For legal, financial, data-change, or test submissions, at least one applies: reversible, checked with opportunity to correct, or confirmed through review/confirm/correct before finalizing [4]. |
| **3.3.7** | **A** | **Redundant Entry** | Information previously entered or provided in the same process is auto-populated or selectable, except when re-entry is essential, security-related, or no longer valid [4]. |
| **3.3.8** | **AA** | **Accessible Authentication (Minimum)** | A cognitive-function test is not required for any authentication step unless an alternative, mechanism, object-recognition, or personal-content exception applies [4]. |
| **4.1.3** | **AA** | **Status Messages** | Status messages are programmatically determined through role/properties so assistive technologies can present them without receiving focus [4]. |
| **2.4.3** | **A** | **Focus Order** | Sequential focus order must preserve meaning and operability [4]. |
| **2.5.3** | **A** | **Label in Name** | The accessible name must contain the visible label text, with the visible text at the start as best practice [4]. |
| **2.5.8** | **AA** | **Target Size (Minimum)** | Pointer targets must be at least **24×24 CSS px**, except for spacing, equivalent target, inline, user-agent, and essential exceptions [4]. |

These criteria map directly to checkout: quantity errors need text and spoken identification; totals and payment submission need review/confirmation; repeated address/payment entry should be selectable rather than retyped; status updates such as “milk added” or “quantity changed to 2” must be programmatically announced without stealing focus.

## 8. WCAG implementation-case evidence

No grounded WCAG 2.2/2.1 mobile-commerce checkout case study in the notes supplies all of organization/project name, date, platform, checkout/form defect, remediation, and measured outcome such as reduced errors or increased completion. The report therefore relies on the normative WCAG requirements above rather than claiming measured case-study gains. The absence of measured checkout case-study outcomes makes the WCAG evidence **strong for required behavior** but **weak for quantified effect size**.

## 9. Assistive-technology interaction primitives and platform voice layer

The grounded platform-specific voice evidence is JustSpeak on Android. It constructs available voice commands from **on-screen labels and accessibility metadata**, manipulates the best-matching actionable object, supports Android accessibility commands and global system commands, and allows multiple commands in one utterance [2]. This establishes one critical implementation dependency: every product, quantity control, cart action, and payment button must have a unique, meaningful accessible label; poor or duplicate labels break both screen-reader navigation and voice-command vocabularies [2].

The grounded developer-facing primitives are:

| Primitive | Grounded API behavior | Checkout use |
|---|---|---|
| Accessible names / labels | Android says each interactive element should have a useful, descriptive label explaining its meaning and purpose; TalkBack announces these labels, and Compose uses `semantics` / `contentDescription` when manual labeling is needed [5]. Android further says labels in collections must be unique so accessibility services can refer to exactly one on-screen element [5]. | Product rows and buttons need unique labels such as “Gala apples, 3 lb bag, $4.99, Add.” |
| Values / state | Android `stateDescription` conveys state changes; `AccessibilityNodeInfo.RangeInfo` represents range controls with type, min, max, and current value via `getCurrent()`, `getMin()`, and `getMax()` [6][7]. | Quantity steppers should expose current quantity and allowable range rather than requiring free-form numeric speech. |
| Adjustable/range actions | Android `ACTION_SET_PROGRESS`, added in API level **24**, sets progress between `RangeInfo.getMin()` and `RangeInfo.getMax()` using `ACTION_ARGUMENT_PROGRESS_VALUE` [8]. | Quantity controls can support deterministic set/increment behavior for AT and voice layers. |
| Custom actions / actions menus | Apple `accessibilityCustomActions` is an array of `UIAccessibilityCustomAction` objects; assistive technologies such as VoiceOver display the custom actions at appropriate times [9]. Android custom actions expose complex interactions such as swipe-to-dismiss to TalkBack, Voice Access, or Switch Access via an actions menu; Android’s example labels the action “Remove article from list” [5]. | Cart rows should expose “Increase quantity,” “Decrease quantity,” “Remove,” “Restore,” and “Substitution preferences” as actions, not only as swipe gestures. |
| Live-region/status announcements | Android live-region constants include `ACCESSIBILITY_LIVE_REGION_ASSERTIVE`, which immediately notifies users and may interrupt screen-reader speech; `ACCESSIBILITY_LIVE_REGION_POLITE`, which notifies users of changes; and `ACCESSIBILITY_LIVE_REGION_NONE`, the default for most views [6]. Android also says `announceForAccessibility` was deprecated in API level **36** and recommends semantically describing UI instead because services may ignore announcement events [6]. | Use polite status for “Added to cart” and assertive/error semantics only for blocking payment or quantity errors. |
| Error semantics | Android recommends `AccessibilityNodeInfo.setError(CharSequence)` and a `TYPE_WINDOW_CONTENT_CHANGED` event with content-change type error for errors such as an incorrect-password message [6]. WCAG 3.3.1/3.3.3 require text error identification and suggestions where known [4]. | Invalid quantity or payment errors should be programmatic, textual, announced, and focusable for correction. |
| Focus/traversal order | Android Views expose accessibility traversal-before/after APIs to define the order in which views are visited; WCAG SC 2.4.3 requires sequential focus order to preserve meaning and operability [6][4]. | Cart rows should read in product → quantity → price → actions → subtotal order. |

The official Apple evidence set here establishes custom actions; it does not establish Apple accessible label/value/hint, adjustable-control, rotor, or modal-dialog details. The implementation conclusion still holds across WCAG and Android/JustSpeak evidence: name every control, expose current values, provide custom row actions, announce status/error changes semantically, preserve focus order, and keep modal payment confirmation reviewable [4][9][5][6][7][2].

## 10. Voice-command reliability and recovery

JustSpeak provides the main grounded voice-command evidence. Its recovery-relevant mechanisms are:

- **Constrained, context-derived command set:** JustSpeak synthesizes commands from visible labels and accessibility metadata rather than accepting arbitrary dictation [2].
- **Flexible grammar:** commands can be phrased multiple ways and chained, such as “Open Gmail then refresh” [2].
- **ASR confidence alternatives:** online Google ASR returned multiple scored hypotheses; the example utterance “setting” produced “set ting” **0.90**, “settings” **0.08**, and “sitting” **0.02** [2].
- **Activation feedback:** JustSpeak provides both visual and audio cues on activation [2].
- **Failure mode:** command quality depends on correct labeling; unlabeled, poorly labeled, or duplicate controls undermine voice command targeting [2].

No grounded source reports barge-in, undo/cancel command success, read-back confirmation rates, or correction-loop error rates for blind/low-vision grocery checkout. For design, the safe synthesis is to use voice commands for shortcuts, require read-back for parsed quantities/totals, expose “undo,” “cancel,” and “repeat summary,” and fall back to touch/screen-reader controls after failed or ambiguous recognition.

## 11. Cart-review design patterns

The grounded evidence does not quantify grocery cart patterns by aisle/category, change-only summaries, editable cart tables/lists, or final total read-back. It does, however, identify the key trade-off: nonlinear touch+audio scanning reduced per-item listening time (**0.95 s/item vs 1.42 s/item**) but increased selection errors (**14.1% trials with errors vs 0**) [1]. For a 15+ item grocery cart, the optimal pattern is therefore:

1. **Immediate low-risk feedback:** after product selection, announce “Added: 1 Gala apple, $0.79” as a status message rather than moving focus unnecessarily, consistent with WCAG SC 4.1.3 [4].
2. **Editable cart list/table:** each row exposes product name, quantity, price, substitution state, and remove/restore actions; this preserves screen-reader review and avoids a voice-only serial bottleneck, consistent with SC 2.4.3 focus order [4].
3. **Grouped summary:** summarize by aisle/category or order section when the list is long, while preserving item-by-item drill-down. This is a design inference from Slide Rule’s faster per-item scanning but higher error rate [1].
4. **Change-only summary after edits:** after quantity or removal changes, announce only the changed item and updated subtotal/total as a status message, consistent with SC 4.1.3 [4].
5. **Final total read-back:** before authorization, read item count, substitutions, fees/taxes, delivery/pickup, and final total, because WCAG SC 3.3.4 requires review/confirm/correct for financial submissions [4].

## 12. Security and privacy constraints for spoken checkout

Security evidence points away from treating speech as the payment authenticator. In the ASSETS 2018 survey, **voice recognition usage was 0%**, while fingerprint was used by **73.0%** and selected most secure by **N=184** [3]. PINs were used by **16.4%** and selected least secure by **N=149**, with shoulder-surfing cited by **30.2%** of those selecting PIN as least secure [3]. WCAG 2.2 SC 3.3.8 requires an accessible authentication path that does not depend on a cognitive-function test without an exception/alternative, and SC 3.3.4 requires reversible/checked/confirmed handling for financial submissions [4].

For spoken checkout, this means: do not speak full card numbers or sensitive tokens; identify payment method with a masked descriptor such as “Visa ending in 1234”; use platform biometric/passcode payment confirmation where possible; and allow a private screen-reader path for sensitive details. Spoken “yes” can confirm a low-risk review step, but it should not substitute for platform payment authorization.

## 13. Evidence-strength synthesis and final recommendations

| Evidence class | Strength | What it supports | What it does not support |
|---|---:|---|---|
| Direct grocery checkout A/B evidence | **Absent in grounded set** | No direct conclusion about 15+ grocery carts | No quantified grocery-specific completion/error/workload comparison |
| Blind-user list-selection analog, Slide Rule | **Moderate** | Hybrid touch+audio can be faster (**11.69 s vs 12.79 s**) and more preferred (**7/10**) than a sequential screen-reader workflow, but can increase errors (**14.1% vs 0**) [1] | Does not test groceries, voice-only workflows, numeric quantities, or payment |
| Voice-command system evidence, JustSpeak | **Weak-to-moderate design evidence** | Context-derived commands, ASR confidence alternatives, flexible grammar, chained utterances [2] | No completion, error, confidence, or workload rates |
| Mobile authentication survey | **Moderate preference/risk evidence** | Blind/low-vision users favor fingerprint for accessibility/security and view PINs as weak [3] | No Apple Pay/Google Pay transaction performance or false-acceptance rates |
| WCAG 2.2 | **Strong normative evidence** | Required error identification, suggestions, financial review/confirmation, non-redundant entry, accessible authentication, status messages, focus order, label-in-name, target size [4] | Does not quantify usability gains |

**Task-by-task recommendation:**

- **Product selection:** favor **hybrid touch+audio/screen-reader browsing plus optional voice search**. Slide Rule shows the speed advantage, but the **14.1%** error rate means every add/select must have immediate feedback and undo [1].
- **Quantity adjustment:** favor **screen-reader adjustable stepper/picker controls** with optional constrained voice. Because numeric error rates are not grounded, the safer pattern is deterministic increment/decrement with value announcement and explicit read-back before checkout [4].
- **Cart review:** favor **hybrid editable review with summaries**, not voice-only serial reading. The closest evidence shows faster per-item audio scanning but higher error exposure; for 15+ carts, grouped/change-only summaries reduce serial listening while the editable list preserves auditability [1].
- **Payment confirmation:** favor **platform biometric/passcode authorization and explicit final confirmation**. WCAG SC 3.3.4 requires review/confirm/correct for financial submissions, and the authentication survey favors fingerprint over PIN while reporting **0%** voice-recognition use [4][3].

**Confirmation strategy:** use lightweight immediate status for low-risk selection; explicit read-back for quantities, substitutions, fees, and totals; a reviewable cart summary before payment; and a required final authorization confirmation for payment.

**Error-recovery model:** announce errors immediately in text/programmatic status; move focus to the faulty field when correction is required; provide suggested corrections where known; make add/remove/quantity changes reversible with undo/remove/restore; include “repeat last summary”; and always provide a fallback from failed or ambiguous voice input to touch/screen-reader controls. This model follows WCAG SC 3.3.1, 3.3.3, 3.3.4, 3.3.7, and 4.1.3 and is consistent with JustSpeak’s ASR-confidence and label-dependency evidence [4][2].

## Sources

1. [assets-08.pdf](https://faculty.washington.edu/wobbrock/pubs/assets-08.pdf)
2. [Zhong2014JustSpeak.pdf](https://3dvar.com/Zhong2014JustSpeak.pdf)
3. [fp017-briotto-faustinoA.pdf](https://cil.csit.carleton.ca/b/wp-content/uploads/2018/07/fp017-briotto-faustinoA.pdf)
4. [Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/)
5. [Principles for improving app accessibility  |  App quality  |  Android Developers](https://developer.android.com/guide/topics/ui/accessibility/principles)
6. [View  |  API reference  |  Android Developers](https://developer.android.com/reference/android/view/View#attr_android:accessibilityLiveRegion)
7. [AccessibilityNodeInfo.RangeInfo  |  API reference  |  Android Developers](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo.RangeInfo)
8. [AccessibilityNodeInfo.AccessibilityAction  |  API reference  |  Android Developers](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo.AccessibilityAction)
9. [accessibilityCustomActions | Apple Developer Documentation](https://developer.apple.com/documentation/objectivec/nsobject-swift.class/accessibilitycustomactions)