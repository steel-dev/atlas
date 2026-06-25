# Conversational UI in Voice-First Healthcare for Elderly Patients with Mild Cognitive Impairment: Evidence on Medication Adherence

## Scope and a caution up front

The question asks for a tight synthesis: how specific conversational interaction patterns in three named voice-first systems (Amazon Alexa, Google Assistant, Catalia Health's Mabu) affect medication adherence in adults 65+ with mild cognitive impairment (MCI), and what longitudinal usability data say about task completion, voice-input errors, and confidence across confirmation strategies and prompt verbosity levels.

The retrieved evidence supports a partial answer, and the most important finding is a negative one about the evidence base itself: **no retrieved study deploys any of these three systems specifically with 65+ MCI patients and measures medication adherence over 90+ days with task-completion, error-type, and confidence metrics broken out by confirmation strategy and verbosity.** The literature instead consists of adjacent pieces — adherence-measurement studies in MCI cohorts, feasibility/RCT deployments of Alexa in non-MCI or younger samples, geriatric voice-UI design experiments, and a vendor press claim for Mabu — that must be triangulated. The synthesis below does that triangulation and flags where cross-study comparison breaks down.

## 1. Medication non-adherence in elderly MCI patients, and the factors that impair voice-first use

Medication non-adherence is common in general (50% or fewer of people adhere to agreed regimens), with forgetting the single most common *unintentional* reason; linking medication-taking to daily routines and using prompts are among the most effective countermeasures [1]. In MCI/early-dementia cohorts specifically, a study nested in the SMART4MD trial (N=387, MCI/mild dementia, mean MMSE 25.57) found baseline non-adherence of 22.5% by pill count, rising to 37.7%–43.5% by self-report instruments, and 26.2% by pill count at 6 months; MCI is associated with difficulty adhering to the polypharmacy regimens older adults typically face [2].

A critical, under-appreciated complication for *measuring* any intervention's effect in this population: self-report adherence questionnaires in MCI/mild dementia have **low sensitivity (0.22–0.40)** though high specificity (0.85–0.96), so they miss many true non-adherers, while pill counts tend to overestimate adherence [2]. This means adherence endpoints in MCI studies are noisy, which weakens the inferential power of every deployment study below.

On the sensory/cognitive factors that impair voice-first use, the geriatric HCI sources converge: older adults face declines in cognitive (reduced memory), perceptual (hearing, vision), and motor (dexterity) function that make voice interfaces both attractive (hands-free, multiple input modes) and difficult [3]. Older adults experience higher error rates and need more time to complete voice tasks [source_4, source_8], and current VUI systems often fail to accommodate reduced hearing, cognitive, and comprehension abilities — older users frequently have trouble hearing or remembering what the system said [4]. Dialogue-based interfaces are themselves cognitively demanding, and error recovery is especially hard for older adults because multiple repair exchanges overburden working memory [3].

## 2. Amazon Alexa: interaction patterns and adherence data

Two retrieved deployments use Amazon Echo devices.

**MedBuddy (custom Alexa skill).** A mixed-methods feasibility study (N=25, 60 days) built a skill that improved on Alexa's native reminder, which by contrast offers only a single reminder, no way to record whether the dose was taken, and no as-needed/PRN support [1]. MedBuddy's interaction design and the user response to it are the most concrete Alexa-specific data retrieved:

- **Reminder scheduling:** multiple reminders spaced 15 minutes apart; one participant noted she "almost always ignored the first two," but three reminders forced action [1].
- **Confirmation/logging:** users verbally reported the medication action; the skill logged it. A recurring **error type** was logging failure — a late-evening dose might not be recorded on the intended day and could cancel the next day's alerts [1].
- **Error recovery failures:** speech-recognition difficulty meant the skill often did not open or required several commands; users had to alert the device multiple times to stop prompts; after saying "I took it," some received one or two extra reminders because Echo routed to the wrong skill [1].
- **Multi-modal gap:** the system was largely voice-only, and participants explicitly asked for a smartphone visual interface to view and edit medication history [1].

Outcomes: interactions occurred on only ~half of study days (mean 50.97 of 60, SD 29.5); self-reported missed doses fell at 1 and 6 months (P<.001) but there was no significant change in taking medication within the same 2-hour window. 91% rated it an effective reminder; 65% would continue using it. Valued features were an external prompt separate from the phone, audibility from another room, multiple reminders, and verbal responses [1]. **Crucial limitation: participants were undergraduate women on oral contraceptives (mean age 21.8) — not elderly and not cognitively impaired** [1].

**Alexa osteoporosis RCT.** A 12-month single-blinded RCT (N=50 postmenopausal women, mean age 64.3) gave the intervention arm an Amazon Alexa delivering education videos, medication reminders, and quizzes [5]. This is the closest thing to a controlled adherence trial, and its result is **null**: 6-month session adherence was 79.5% and 80% completed ≥66% of the program (good feasibility, no withdrawals), but acceptable 12-month medication adherence (medication possession ratio ≥0.8) did not differ between arms (control 83.0% vs DVA 93.0%, P>0.05); knowledge gains were equal across arms, and medication attitudes actually *worsened* in the Alexa arm (net −1.42, P=0.04) [5]. The lesson: high engagement and feasibility did not convert to a measurable adherence benefit, and the sample was still below 65 and non-MCI.

## 3. Google Assistant: design guidance, little deployment evidence

The retrieved Google material is conversation-design *guidance*, not deployment data with elderly cognitively-impaired users. Google's framework defines three confirmation strategies — explicit confirmation (requires an explicit yes/no before acting), implicit confirmation (echoes the parameter/action and proceeds, letting the user correct), and no confirmation — and advises reserving explicit confirmation for rare, high-cost or hard-to-undo actions while using implicit confirmation by default, with one-step corrections [6]. Google Home is cited alongside Alexa as a plausible DVA platform [5], but no retrieved study reports Google Assistant task-completion, error, or adherence outcomes in 65+ MCI users. (Google's standalone Conversational Actions platform was also deprecated, limiting custom health-skill deployment on it.) This is a genuine evidence gap rather than a finding.

## 4. Catalia Health's Mabu and specialized medical voice assistants

Mabu is a home social robot using conversational AI and affective computing to assess mood, record data, manage symptoms, deliver personalized coaching, and relay data (including medication-use frequency) to clinicians; it focused on congestive heart failure, with a Pfizer one-year pilot and prior Kaiser Permanente trials [7]. The only outcome figure retrieved is a vendor analysis of first-year usage claiming **84% of patients are "more likely to keep track of disease symptoms" when they interact with the robot regularly** [7]. This is a press claim, not a peer-reviewed, controlled, MCI-specific adherence outcome, and "tracking symptoms" is not medication adherence. The broader geriatric-robot literature suggests embodied agents using polite speech and gestures can improve patient compliance [3], but the retrieved evidence does not let us quantify Mabu's adherence effect or its 90-day retention. Specialized embodied systems are therefore the *least* documented of the three categories in this evidence set.

## 5. Confirmation patterns, verbosity, and error recovery in geriatric HCI

Here the design-experiment literature is strongest.

- **Verbosity must be low, and speech rate tuned to it.** A Wizard-of-Oz study (N=30, mean age 61.86) found older users speak more slowly to a robot than to a person and expect feedback *slower than their own* speech; critically, there was a **negative correlation between feedback word count and expected speech rate** — the more words a prompt contains, the slower older users want it spoken, because more content overloads their capacity to remember and store it [4]. Short, simple dialogues reduce memory load and increase task completion [4]. Dialogue *task type* (goal vs. non-goal) did not significantly affect expected rate [4].
- **Politeness/verbosity can backfire.** A 5-day in-home field study (N=15) comparing polite vs. direct ("bald-on-record") smart-display speech found older adults were marginally *more tolerant of errors from the direct version*; the authors reason that polite, human-like speech raises competence expectations that recognition errors then violate [3]. The same work categorized older-adult voice interaction into seven speech acts (request, suggest, instruct, comment, welcome, farewell, **repair**) and stressed that error recovery via dialogue is especially burdensome for this group [3].
- **Confirmation strategy.** No retrieved source experimentally compares explicit vs. implicit confirmation *for elderly MCI users* on task-completion or error metrics. Google's guidance (implicit by default, explicit only for high-cost actions, one-step correction) [6] is the available design heuristic; the geriatric evidence that extra exchanges overburden older users [source_5, source_8] argues against verbose explicit confirmation except where the cost of an unintended action is high.

**Voice-input error rates** vary widely by sample health. A 3-month field study (N=32, aged 55+, Amazon Echo Show 10) logged a low average command error rate of **4.9%** (13/20 households below 5%), with autonomous learning by week 4 and positive usability by week 12 [8] — but this was a relatively healthy 55+ sample. By contrast, the elderly/clinical and MCI literature reports higher error rates and longer task times [source_4, source_8], and MedBuddy's (young) users still hit frequent skill-routing and recognition failures [1]. The gap underscores that error rate is highly sensitive to cognitive/sensory status.

## 6. Multi-modal feedback (voice + visual + haptic)

Evidence for multi-modal benefit is suggestive but indirect:

- Smart devices can address older adults' cognitive/perceptual/motor declines precisely *because* they offer multiple interaction modes [3].
- In the Echo Show study, participants explicitly **appreciated the visual feedback on the integrated touch display**, and valued the rotating screen and hands-free access [8].
- MedBuddy users, on a near voice-only setup, asked for a smartphone screen to view/edit history — a request for visual confirmation of state [1].

No retrieved source isolates **haptic** feedback's contribution, nor experimentally quantifies a voice+visual+haptic combination against voice-only on task completion, error reduction, or confidence in MCI patients. The multi-modal claim in the research question is therefore only partially supported: visual augmentation of voice is consistently valued and plausibly reduces memory burden, but haptic-specific and controlled multi-modal evidence is absent from this set.

## 7. Longitudinal engagement, drop-off, and what sustains use beyond 90 days

The strongest longitudinal signal is qualitative. A year-long Johns Hopkins field-research program (a month-long N=15 Alexa deployment plus co-design work) reports that **only ~21 longitudinal in-home VA studies with older adults exist**, and long-term engagement methodology is underdeveloped [9]. What it identifies as driving *sustained* use:

- **Gradual, scaffolded mental-model formation** — step-wise learning with demonstrations and encouragement beats sudden introduction; novices who were coached explored more than people with prior personal VA experience, who were "set in their ways" [9].
- **Rapport and routine integration** — spontaneous continued use emerged when the VA became embedded in daily routine; one participant bought two additional Echo devices for medication, calendar, and meeting reminders ("all I say is 'yes, Alexa'") [9].
- The Echo Show study corroborates a within-3-month trajectory: autonomous operation by week 4, positive usability by week 12, and declining privacy concern over time [8].

The osteoporosis RCT supplies the only hard 6-/12-month retention numbers (79.5% session adherence, no withdrawals) but with a null adherence effect [5]. Mabu's "first-year" 84% figure is a vendor claim without drop-off detail [7]. So while the design ingredients correlated with continued use are identifiable (routine-embedding, low-friction confirmation like "yes, Alexa," scaffolded onboarding), **no source maps specific interaction sequences to 90-day retention vs. abandonment with quantitative drop-off curves** in MCI patients.

## 8. Cross-system comparison and methodological limits

| System | Closest retrieved deployment | Population | Adherence/engagement result | Voice-error / task signal | MCI 65+ relevance |
|---|---|---|---|---|---|
| Amazon Alexa (custom MedBuddy skill) | Feasibility, N=25, 60 d [1] | Undergrad women, mean age 21.8 | Used ~50% of days; self-report missed-dose ↓ (P<.001); 65% would continue | Frequent skill-routing & recognition failures; logging errors | Low (young, no MCI) |
| Amazon Alexa (off-the-shelf) | 12-mo RCT, N=50 [5] | Women, mean age 64.3 | **Null** on adherence (DVA 93% vs control 83% acceptable MPR, P>.05); attitudes worsened | High program completion (80%), good retention | Partial (near-65, no MCI) |
| Google Assistant | None (design guidance only) [6] | — | No deployment data | Defines explicit/implicit/no confirmation | None |
| Mabu (Catalia Health) | Vendor/press analysis [7] | CHF patients | 84% "more likely to track symptoms" (not adherence) | Not reported | None (no MCI/adherence data) |
| Geriatric VUI design refs | WoZ N=30 [4]; field N=15 [3]; field N=32 [8] | 55–62+ older adults | n/a | 4.9% command error (healthy 55+) [8]; lower verbosity → better recall/completion [4] | Partial (older, not MCI) |

Patient-reported **confidence scores** as a distinct, comparable metric were not reported in commensurable form across the three target systems; the closest proxies are MedBuddy's effectiveness/continuation ratings [1] and the Echo Show's usability ratings [8], which are not directly comparable.

**Methodological constraints on cross-study comparison:**
- **Population mismatch** — the named systems' deployments use young or near-65 non-MCI samples; the MCI data come from non-voice adherence-measurement studies [source_2, source_7, source_12].
- **Outcome heterogeneity** — pill-count MPR [source_7, source_12], self-report [source_2, source_12], symptom-tracking [7], usage logs/error rate [8], and qualitative retention [9] are not interchangeable; self-report in MCI is itself low-sensitivity [2].
- **Evidence tier** — ranges from a peer-reviewed RCT [5] to a single vendor press release [7].
- **Design vs. deployment** — the most rigorous interaction-design findings (verbosity, confirmation, politeness, multi-modal) come from controlled experiments with healthy older adults, not from the three deployed systems in MCI patients [source_5, source_8, source_14].

## Bottom line

Across the retrieved evidence, the consistently supported design principles for this population are: low prompt verbosity with speech rate slowed in proportion to word count [4]; minimal, low-burden confirmation and repair because dialogue exchanges overload older users [source_5, source_8]; visual augmentation of voice to offload memory [source_14, source_2]; and scaffolded, routine-embedded onboarding to sustain use [9]. But the specific empirical chain the question targets — these patterns, in Alexa/Google/Mabu, driving measurable 90-day medication adherence in 65+ MCI patients, with confidence and error metrics by confirmation strategy — is **not established by any retrieved source**, and the one controlled adherence RCT on the most-deployed platform (Alexa) returned a null result despite good engagement [5].

## Sources

1. [Medication Adherence Reminder System for Virtual Home Assistants: Mixed Methods Evaluation Study](https://formative.jmir.org/2021/7/e27327)
2. [Frontiers | Is it possible to diagnose therapeutic adherence in mild cognitive impairment and dementia patients in clinical practice?](https://www.frontiersin.org/journals/pharmacology/articles/10.3389/fphar.2024.1362168/full)
3. [Polite or Direct? Conversation Design of a Smart Display for Older Adults Based on Politeness Theory](https://ar5iv.labs.arxiv.org/html/2203.15767)
4. [pdf](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2023.1119355/pdf)
5. [Feasibility and effectiveness of a digital voice assistant for improving anti-osteoporosis medication adherence, and osteoporosis knowledge and attitudes, in postmenopausal women with osteoporosis: A 12-month randomised controlled trial - Archives of Osteoporosis](https://link.springer.com/article/10.1007/s11657-025-01529-0)
6. [Conversation Design  |  Google for Developers](https://developers.google.com/assistant/conversation-design/confirmations)
7. [Pfizer launches pilot with home robot Mabu to study patient response to AI](https://venturebeat.com/ai/pfizer-launches-pilot-with-home-robot-mabu-to-study-patient-response-to-ai/)
8. [Adapting Voice Assistant Technology for Older Adults: A Comprehensive Study on Usability, Learning Patterns, and Acceptance](https://www.mdpi.com/2673-6470/5/1/4)
9. [From Our Lab to Their Homes: Learnings from Longitudinal Field Research with Older Adults](https://arxiv.org/html/2409.15495v1)