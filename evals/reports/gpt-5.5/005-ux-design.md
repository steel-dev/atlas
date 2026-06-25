# Conversational UI patterns and medication adherence in older adults with MCI

## Bottom line

The strongest directly relevant evidence is not from the commercial reminder features themselves, but from a 20-week deployment of MATCHA, a medication “check-in” conversational agent for older adults with mild cognitive impairment (MCI) and care partners, implemented on Google Home Hub / Google Assistant infrastructure. In that study, the interaction pattern most associated with engagement beyond 90 days was **not** a one-way alarm (“take your medication”), but a **reflective, confirmatory check-in**: ask whether the medication was already taken; provide paths for “yes,” “no,” “I don’t remember / need to check the pillbox,” “taking now,” unknown input, and no response; support voice plus touch-screen responses; and notify care partners through phones [1]. Engagement rose from about **18%** in a 4-week first phase to about **67%** in a revised 16-week second phase, and the remaining dyads wanted to continue; use was still ongoing at about 55 weeks at the time of writing [1].

By contrast, deployed general-purpose systems such as Amazon Alexa medication reminders and Google Assistant routines/reminders primarily provide **scheduled prompts and account-linked medication/refill support**, but the fetched evidence does not show that their standard deployed features have been longitudinally tested for medication adherence in 65+ MCI patients. Specialized medical voice/robotic assistants such as Catalia Health’s Mabu add a stronger clinical-engagement model—daily conversations, medication reminders, symptom/mood capture, personalization, and clinician/caregiver reporting—but fetched public evidence is mostly program/pilot reporting rather than peer-reviewed geriatric MCI adherence data [2] [3].

## Evidence base and gaps

The research question asks for longitudinal usability results on task completion rates, voice-input error types, patient-reported confidence scores, prompt verbosity, confirmation strategies, multimodal feedback, and sustained engagement beyond 90 days. The fetched sources support some, but not all, of that matrix:

| Evidence need | What the sources support | Key limitation |
|---|---:|---|
| Older adults 65+ with MCI, medication management, >90 days | MATCHA: 20-week deployment with older adults with MCI and care partners; engagement rose after design revision; continued use reported around 55 weeks [1] | Small sample; engagement/acceptance more directly measured than objective medication ingestion/adherence |
| Objective medication timing after voice reminders | Google Home Mini feasibility with older adults using MEMS caps: adherence 82–100%, mean latency 55 min, 63.7% of reminders followed by cap opening within 30 min [4] | Not MCI; 4 weeks; N=5 MEMS subsample; one-way reminder rather than rich confirmation dialog |
| Longitudinal commercial voice-assistant error rates | Month-long in-home older-adult Alexa study: 24.76% error rate, persistent 20–30% weekly; reminder success 48.60%; intent recognition most common error type [5] | Not medication-specific adherence and not MCI |
| Task completion and usability for health-reminder creation | LLM-powered health VA validation with adults 65+: 100% AVS debrief completion, 96.67% reminder creation, mean SUS 85 [6] | One-session validation, not longitudinal and not MCI |
| Conversational agent message design for medication information | Older adults remembered CA-delivered medication messages more accurately than younger adults; older CAs rated more positively by older adults [7] | Educational messages, not adherence or longitudinal use |
| Commercial deployed Alexa / Google / Mabu comparison | Official/product and pilot descriptions document feature flows and design affordances [8] [9] [10] [3] | Little or no peer-reviewed MCI-specific adherence evidence for standard commercial deployments |

## Comparison of the three deployed-system strategies

### 1. Amazon Alexa medication reminders: low-friction prompting, limited confirmation

Alexa’s deployed medication-reminder flow is designed around account linking, voice-profile/PIN protection, prescription review, reminders, and refill support. The official sequence is: enable/link the pharmacy skill, create a voice profile and passcode/PIN, ask Alexa to manage medications, set preferred reminder times, and when a reminder fires ask what medication is due; later Echo Show/Amazon Pharmacy support adds visual prescription details and proactive refill reminders after PIN/voice-profile confirmation [8] [11].

For older adults with MCI, this design has two strengths: it is familiar, commercially deployed, and relatively low-friction once configured; and it can add visual support on screened devices. But the MCI-specific HCI evidence suggests a major weakness: a pure “take your medication” reminder can increase the risk of **double-dosing** when the person cannot remember whether they already took the medication. MATCHA’s designers explicitly rejected reminder/alarm wording for this reason and used a “check-in” that asks whether medication was already taken [1].

Commercial Alexa also faces the known older-adult voice-assistant error problem. In the month-long in-home study of older adults, reminders were among the weaker interaction types: **251 reminder attempts had a 48.60% success rate**, compared with 90.23% for timers and 83.41% for weather [5]. This does not prove Alexa medication reminders fail clinically, but it does show that reminder creation/use is an error-prone VA task for older adults.

### 2. Google Assistant health tracking/reminders: strong platform substrate, but adherence depends on added dialog design

Google Assistant and related Google health features support routines, reminders, personal results, and access to health/fitness data such as sleep/respiration through Google Fit/Nest contexts; newer Google health-coaching features document conversational logging with follow-up questions and confirmation/summaries, but Google labels the coach as informational rather than medical and not authorized for professional pharmaceutical recommendations or assessments [9] [10] [12]. Those affordances make Google Assistant a capable substrate for health tracking, but the fetched sources did not identify a standard deployed Google Assistant medication-adherence feature longitudinally validated in 65+ MCI users.

The best evidence for Google’s role is therefore MATCHA, which used Google Home Hub/Google Assistant infrastructure but added a medication-specific conversational layer. The platform alone was not the intervention; the intervention was the carefully designed sequence: proactive check-in, explicit confirmation categories, pillbox-check path, “taking now” path, touch alternatives, longer timeout, positive feedback, and care-partner notification [1]. This distinction matters: Google Assistant’s general reminder/routine affordances are necessary but not sufficient for MCI medication safety.

### 3. Catalia Health’s Mabu: most clinically specialized and socially embodied, but least transparent quantitative evidence

Mabu is a specialized medical voice/robotic assistant rather than a general smart speaker. Public descriptions characterize it as a robot wellness coach using tailored, voice-based conversations to ask how patients are feeling, answer treatment questions, gather symptom-management and medication-adherence-trend data, and route insights to clinicians at a specialty pharmacy provider; reporting also describes mood assessment, symptom management, medication-use frequency, unanswered-question summaries, personalization, and affective computing [2] [3]. Compared with Alexa and Google Assistant, Mabu’s interaction model is more longitudinal and care-team oriented: it is designed to maintain a relationship, collect patient-reported outcomes, and close a loop with clinical stakeholders.

That makes Mabu’s strategy conceptually closest to the MATCHA findings: both go beyond alarms toward repeated check-ins and human-care-network visibility. However, the fetched Mabu evidence does not provide peer-reviewed task-completion rates, ASR error types, prompt-verbosity comparisons, confidence scores, or MCI-specific medication-adherence effects. Pfizer described the program as a 12-month pilot using Mabu to gather symptom-management and medication-adherence-trend insights, and secondary reporting cited an initial first-year analysis in which 84% of regular users were more likely to keep track of disease symptoms; that is useful engagement context but not an MCI medication-adherence outcome [2] [3].

## Interaction sequences most associated with sustained engagement beyond 90 days

Across the sources, the most defensible ranking of interaction strategies for older adults with MCI is:

1. **Reflective check-in with explicit status choices and care-partner loop** — strongest evidence. MATCHA moved from 18% to 67% engagement after adding/revising touch buttons, timeout, “taking now,” less overwhelming positive feedback, and more comprehensive phone notifications; all phase-2 dyads wanted to continue and use continued at around 55 weeks [1].
2. **Personalized, context-aware reminder creation with explicit confirmation** — promising but not longitudinal. The LLM health VA guided older adults through AVS debrief, routine elicitation, and medication reminder creation; all five completed the debrief and profile creation, and reminders were created accurately except one medication [6].
3. **Embodied medical companion check-ins** — plausible but underreported. Mabu’s tailored conversations and clinician/caregiver reporting align with sustained-engagement principles, but fetched evidence lacks MCI-specific longitudinal usability metrics [2] [3].
4. **Generic one-way reminders/alarms** — weakest for MCI safety. Objective reminder studies show voice reminders can cue medication behavior, but MCI studies warn that reminder-only phrasing can cause confusion or over-medication if the patient cannot recall prior intake [4] [1].

The specific MATCHA sequence that appears most important is:

1. **Proactive opening:** the assistant initiates at medication time, but frames the event as a check-in rather than an instruction to take medication [1].
2. **Binary-plus-memory status prompt:** “Have you taken it?” with response paths for yes, no, “I don’t remember,” and later “taking now” [1].
3. **If yes:** acknowledge and give positive reinforcement, but keep it short/moderate rather than prolonged celebratory audio [1].
4. **If no:** ask whether the system should check again later and guide the user to specify a repeat time [1].
5. **If unsure:** ask the user to check the pillbox and wait, reducing cognitive burden and double-dose risk [1].
6. **If speech is not understood:** acknowledge the unknown response rather than silently failing; MATCHA indicated feedback would be sent for correction [1].
7. **If no response:** notify both the member and care partner through phones [1].
8. **Offer multimodal input:** allow touch-screen buttons for the same status categories to bypass muffled speech or speech-recognition breakdowns [1].

This sequence is stronger than reminder-only designs because it converts the medication event into a **state verification task**: the system is trying to determine whether the dose is already taken, not simply to command intake.

## Confirmation dialog patterns

The sources support three confirmation principles:

- **Confirm medication status, not just reminder delivery.** MATCHA’s key design choice was to ask whether medication had already been taken because older adults with MCI may not remember prior intake and could take another dose when given a simple reminder [1].
- **Use explicit choices.** MATCHA’s Phase 2 touch options—“Yes I did,” “No I did not,” “I don’t remember,” and “Taking Now”—turned vague natural-language responses into constrained, loggable states while preserving voice interaction [1].
- **Confirm proposed reminder plans.** In the LLM health VA, reminder creation included routine-aware suggestions and explicit confirmation such as “Does that work for you?”; in validation, all participants navigated the debrief and reminder creation, with 29 of 30 reminders created successfully and accurately [6].

For MCI medication adherence, the best confirmation strategy is therefore **status confirmation with recovery branches**, not a simple yes/no acknowledgment that a reminder was heard.

## Error recovery mechanisms and observed error types

The older-adult Alexa error study shows why recovery cannot be treated as an edge case. Across 2,552 one-turn queries, **632 had errors**, a **24.76%** error rate; 98.10% were conversational breakdowns; weekly error rates remained between **20% and 30%** over four weeks [5]. Only **25.47%** of all errors were resolved on the immediate next attempt, and after grouping compounding retries, the distinct-error resolution rate was **46.24%** [5]. The most frequent category was intent recognition, followed by speech-recognition and human/wake-word/activation problems [5].

For medication UI, these error types imply the following design priorities:

| Error or breakdown | Design response supported by evidence |
|---|---|
| Intent misrecognition / wrong skill / misunderstood response | Constrain medication-state choices; add explicit “taking now” rather than treating it as unknown [1] |
| Speech recognition problems / muffled speech | Provide touch-screen equivalents for medication-state responses [1] |
| Wake-word, no-listen, partial-listen, timeout | Use longer timeout and care-partner/member phone notifications on no response [1] |
| Repeated failed retries / snowball errors | Avoid asking users simply to repeat indefinitely; acknowledge failure and route to fallback or caregiver channel [5] [1] |
| Reminder creation errors | Guided, personalized reminder creation with explicit confirmation improves task completion in older-adult validation [6] |

## Multimodal feedback: voice + visual + touch, with cautious use of affective audio

The strongest multimodal finding is from MATCHA. Phase 2 added touch buttons on the Google Home Hub screen because some speech responses were not understood; the buttons mirrored the spoken medication-status intents and gave users a non-speech fallback [1]. The same revision also adjusted affective feedback: the original positive feedback included several seconds of cheering and clapping plus verbal praise, but some participants found it overwhelming, especially with multiple daily medications; the revised version shortened the sound and kept moderate praise [1].

The broader conversational-agent evidence is consistent with this: audiovisual agents can support older adults’ learning and affective engagement with medication information, and older adults in one study remembered CA-delivered medication messages more accurately than younger adults while rating older agents more positively [7]. But the evidence does not establish that more feedback is always better. For MCI medication adherence, the better-supported pattern is **redundant but restrained feedback**: voice prompt + visible/touchable choices + concise auditory confirmation, rather than long celebratory output.

The fetched sources do not provide strong haptic-specific evidence for deployed voice-first medication adherence in older adults with MCI. Haptic feedback should therefore be treated as a plausible accessibility supplement, not as an evidence-backed driver of >90-day engagement in this corpus.

## What longitudinal usability studies reveal

### Task completion and engagement

| Study / system type | Population and duration | Main completion / engagement result |
|---|---|---:|
| MATCHA medication check-in [1] | Older adults with MCI + care partners; 20 weeks total | Phase 1: 476 initiations, 84 responses ≈18% engagement. Phase 2: 1,120 initiations, 760 responses ≈67% engagement; continued use reported around 55 weeks. |
| Google Home Mini voice reminders + MEMS [4] | Older adults 55+, no cognitive impairment; 4 weeks; MEMS subsample N=5 | Medication adherence 82–100%; mean reminder-to-cap-opening latency 55 min; 14.6% within 5 min and 63.7% within 30 min. |
| Older-adult Alexa in-home error study [5] | 15 older-adult homes; 4 weeks | Reminder task success 48.60%; overall one-turn query error rate 24.76%. |
| LLM health VA validation [6] | Adults 65+; one session; N=5 | 100% completed AVS debrief/profile creation; 29/30 medication reminders created successfully and accurately; mean SUS 85. |

The longitudinal evidence therefore favors **engagement through check-in and adaptation**, not simply reminder delivery. The reminder-only Google Home Mini feasibility suggests voice prompts can cue behavior, but the latency data show that a reminder does not equal immediate ingestion [4].

### Voice-input error types

The most detailed error taxonomy comes from the month-long Alexa study: intent recognition errors were the most frequent, followed by speech-recognition and activation/human errors; errors remained common over time rather than disappearing with practice [5]. MATCHA’s Phase 1 also exposed an important medication-specific error: users who said they were taking the medication now were originally counted as unknown because the system lacked a “taking now” intent; adding that path in Phase 2 was part of the engagement-improving redesign [1].

### Confidence and usability scores

Quantitative patient-reported confidence scores across verbosity and confirmation conditions were **not found** in the fetched longitudinal MCI sources. The closest measures are:

- MATCHA Phase 1 modified SUS: **84.66** for MCI members and **86.16** for care partners; Phase 2 interviews described increased assurance/confidence, but confidence was qualitative rather than a numeric score [1].
- LLM health VA: mean SUS **85** (SD 12.90), with individual SUS values from 62.5 to 95; participants described the system as learnable, pleasant, and easy to navigate [6].
- Google Home Mini reminder feasibility measured self-confidence in pain management as part of its descriptive dataset but reported adherence/latency rather than a prompt-strategy confidence comparison [4].

### Prompt verbosity and confirmation strategy

No fetched longitudinal study directly randomizes prompt verbosity levels for older adults with MCI and reports medication adherence, task completion, and confidence scores. The available evidence is still directionally useful:

- MATCHA’s overly long positive feedback was reduced because some participants found it overwhelming [1].
- The LLM health VA explicitly used a hierarchical structure to avoid overwhelming users with verbose responses while still allowing questions and follow-up [6].
- Medication-information CAs used short, approximately 30-second medication explanations and found older adults responded positively, but this was not a longitudinal adherence study [7].

Thus, the safest evidence-based conclusion is that **concise prompts plus optional elaboration** are preferable to uniformly verbose prompts for older adults, especially when medication prompts recur several times per day.

## Overall design implications

For elderly patients with MCI, conversational UI patterns appear to support medication adherence most plausibly when they reduce memory burden, verify medication state, and involve caregivers without removing patient autonomy. The evidence supports this ranked design recipe:

1. **Use check-ins, not commands.** Ask “Have you taken it?” rather than “Take it now,” because MCI users may not remember prior intake [1].
2. **Represent medication state explicitly.** Include yes/no/unsure/taking-now/no-response/unknown states [1].
3. **Add a pillbox-check branch.** When unsure, ask the user to check the pillbox before confirming [1].
4. **Use multimodal response channels.** Voice-first should not mean voice-only; touch-screen buttons materially address speech-recognition breakdowns [1].
5. **Close the loop with caregivers.** Notify care partners for medication-time events or nonresponse, but preserve the patient’s role in confirming status [1].
6. **Keep feedback brief and affectively supportive.** Positive reinforcement can help assurance, but long celebratory sounds become burdensome with repeated medication events [1].
7. **Design for error recovery from the beginning.** Older-adult VA errors are common, persistent, and often not resolved on first retry [5].
8. **Personalize reminder schedules to routines and language.** Older adults may refer to medications by personalized names, routines, or pillbox times; systems such as ACHO and the LLM health VA highlight the importance of customization [13] [6].

## Closing note

The evidence does not support a claim that Alexa’s standard medication reminders, Google Assistant’s standard health tracking/reminder features, or Mabu have each been directly compared in a longitudinal randomized study of 65+ adults with MCI. The most defensible answer is that **MATCHA-style conversational check-ins**—implemented on a commercial assistant but redesigned around MCI medication-state confirmation, multimodal fallback, and care-partner notification—have the clearest observed association with sustained engagement beyond 90 days. General-purpose reminder features are useful substrates, and embodied medical assistants like Mabu are promising, but the specific interaction sequence with the best evidence is the reflective check-in with explicit confirmation and recovery paths [1].

## Sources

1. [A Collaborative Approach to Support Medication Management in Older Adults with Mild Cognitive Impairment Using Conversational Assistants (CAs)](https://dl.acm.org/doi/fullHtml/10.1145/3517428.3544830)
2. [Catalia Health and Pfizer collaborate to better understand patient journeys using artificial intelligence and via robot wellness coach | Pfizer](https://www.pfizer.com/news/press-release/press-release-detail/catalia-health-and-pfizer-collaborate-better-understand)
3. [Pfizer launches pilot with home robot Mabu to study patient response to AI - MedTech Innovator](https://medtechinnovator.org/pfizer-launches-pilot-with-home-robot-mabu-to-study-patient-response-to-ai/)
4. [Voice Assistant Reminders and the Latency of Scheduled Medication Use in Older Adults With Pain: Descriptive Feasibility Study](https://formative.jmir.org/2021/9/e26361/)
5. [Situated Understanding of Errors in Older Adults’ Interactions with Voice Assistants: A Month-Long, In-Home Study](https://arxiv.org/html/2403.02421v3)
6. [Voice Assistants for Health Self-Management: Designing for and with Older Adults](https://arxiv.org/html/2409.15488v2)
7. [Using conversational agents to explain medication instructions to older adults - PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC6371340/)
8. [Alexa can remind you to take your medication](https://www.aboutamazon.com/news/devices/new-ways-to-manage-your-medications-at-home-using-alexa)
9. [Automate daily routines & tasks with Google Assistant - Android - Google Assistant Help](https://support.google.com/assistant/answer/7672035?hl=en)
10. [Get started with the Google Health Coach - Google Health Help Center](https://support.google.com/googlehealth/answer/16961408)
11. [What are the newest Alexa features?](https://www.aboutamazon.com/news/devices/alexa-updates-what-alexa-learned-this-month)
12. [Control Google Fit on your Assistant devices - Google Fit Help](https://support.google.com/fit/answer/10668377?hl=en)
13. [Treatment Adherence in Chronic Conditions during Ageing: Uses, Functionalities, and Cultural Adaptation of the Assistant on Care and Health Offline (ACHO) in Rural Areas - PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC7999645/)