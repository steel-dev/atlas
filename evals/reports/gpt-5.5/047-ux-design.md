# Telehealth design for rural primary care in Uganda, Kenya, and Tanzania under 2G/3G constraints

## Executive findings

Two low-connectivity interaction patterns in the fetched evidence met the requested **>85% consultation-completion** threshold:

| Program/study | Country and use case | Channel mix and workflow | “Completed” numerator/denominator | Sample and date range | Completion |
|---|---:|---|---:|---:|---:|
| **Babyl Rwanda / Babylon-Babyl national telemedicine service**, BMC Primary Care interrupted time-series | Rwanda; primary-care teleconsultations, including respiratory infections, malaria, UTI, gastritis and diarrhoea | USSD `*811#` registration/booking on any mobile/feature phone; callback phone triage/consultation; SMS e-prescription/lab codes; insurance/pharmacy/lab integration; referral to facility when physical examination, lab confirmation or out-of-scope care was needed | Completed teleconsultations / all recorded Babyl consultations = **3,676,385 / 3,899,788** | Jan 2019-Sept 2023 administrative platform data | **94.3%** completed; 5.7% no-shows [1] |
| **The Addis Clinic provider-to-provider asynchronous telemedicine platform** | Kenya; frontline-health-worker requests for diagnostic and management advice from remote specialists | Mobile-phone app submission by frontline health workers; in-country coordinator triage; asynchronous specialist response | Automatically “answered” cases / submitted cases; answered meant a response from ≥1 specialist | Baseline period Feb 2019-Jan 2020: **726 submitted cases** | **99%** answered, approximately **719/726** [2] |

The strongest fetched evidence that remote care achieved diagnostic quality comparable to in-person care is the Rwanda standardized-patient audit of **Babyl phone telemedicine versus in-person primary care**. For acute malaria, correct case management was ordering a malaria test: in-person average **0.93**, telemedicine effect **-0.01** in the main OLS model and **-0.01** in the DML model, with Romano-Wolf **p=0.71**, i.e. statistically indistinguishable from in-person care. For viral upper respiratory infection (URI), correct case management was **no unnecessary medicines or labs**: in-person average **0.14**, telemedicine effect **+0.28** in OLS and **+0.28** in DML, with **p=0.01**, i.e. about **42%** correct case management in telemedicine versus **14%** in person [3].

The practical design implication is not “video-first telemedicine.” The evidence points to a **low-bandwidth, asynchronous-first model with callback escalation**: collect structured clinical data and low-size media offline, submit via durable queue when connectivity appears, acknowledge by SMS/USSD, allow clinician callback when real-time clarification is needed, and preserve referral and medication workflows even when the app stalls. WHO’s digital-health guidance explicitly distinguishes asynchronous store-and-forward exchanges of video/image files from synchronous real-time exchanges, and frames provider-to-provider telemedicine as a way to link less-skilled workers to specialist support for diagnosis, monitoring and case management [4].

## 1. Connectivity constraints that should shape the product

The relevant constraint for rural primary care in Uganda, Kenya and Tanzania is not absence of mobile networks everywhere; it is **uneven broadband quality, high dependence on mobile access, intermittency, affordability, device limitations and low digital literacy**. The latest fetched regional ITU source reports that Africa’s international bandwidth usage was **80 kbit/s per internet user in 2024**, compared with a global average of **323 kbit/s**, and that at least 30 African countries reported bandwidth below **100 kbit/s**, which is directly relevant to image-heavy teleconsultation design [5].

Country/operator evidence from the fetched materials shows the same pattern:

| Country | Grounded connectivity facts from fetched sources | Product implication |
|---|---|---|
| Uganda | DataReportal/GSMA Intelligence reported **38.6 million** cellular mobile connections in early 2025, equivalent to **76.2%** of population; **14.2 million** internet users and **28.0%** internet penetration; **86.5%** of mobile connections were “broadband” connections via **3G, 4G or 5G**, with the caveat that broadband connections do not necessarily imply mobile-data use [6]. DataReportal’s Uganda page reported median fixed internet speed **22.97 Mbps** but did not provide a median cellular speed in the fetched excerpt [6]. | Do not require smartphones or continuous broadband. Provide USSD/SMS/callback entry points and an offline-first Android/PWA mode. |
| Kenya | DataReportal/GSMA Intelligence reported **68.8 million** cellular mobile connections in early 2025, equivalent to **121%** of population; **27.4 million** internet users and **48.0%** penetration; **94.7%** of mobile connections were “broadband” via **3G, 4G or 5G** [7]. Median mobile internet download speed was **29.97 Mbps** in Jan 2025 [7]. The Addis Clinic model operated in Kenya through app submission and asynchronous specialist response, sustaining **2,604 cases in 2020** and **3,525 in 2021**; baseline completion was **99% answered** [2]. | Kenya can support app-based provider workflows in some settings, but completion falls when the specialist queue is stressed; design must separate capture from upload and include non-app fallback. |
| Tanzania | DataReportal/GSMA Intelligence reported **79.0 million** cellular mobile connections in early 2025, equivalent to **114%** of population; **20.2 million** internet users and **29.1%** penetration; **85.8%** of mobile connections were “broadband” via **3G, 4G or 5G** [8]. DataReportal’s Tanzania page reported median fixed internet speed **18.70 Mbps** but did not provide a median cellular speed in the fetched excerpt [8]. A Dar es Salaam teleconsultation study received **218** telephone inquiries Apr 1-Jun 30 2020, of which **116** followed through and were attended (**53.2%**); insurance noncoverage accounted for **34/102** nonbookings [9]. | Payment, insurance and booking friction can be as important as bandwidth. Avoid requiring prepayment or insurer authorization before the clinical case can be saved and triaged. |

Exact regulator-grade national **2G-only, 3G-only and 4G population coverage**, rural mobile-broadband use and health-worker smartphone ownership were not all established in the fetched sources. The source set did establish that many connections remain voice/SMS-only or not necessarily data-using, and that total internet penetration was only **28.0%** in Uganda, **48.0%** in Kenya and **29.1%** in Tanzania in early 2025 [6] [7] [8]. The product design recommendation is therefore to assume **2G/3G, intermittent connectivity, shared/low-end Android phones and occasional feature phones**, then progressively enhance for 4G/smartphone sites.

## 2. Programs and UX strategies

### 2.1 Babyl Rwanda / Babylon-Babyl

The Rwanda deployment is the exact entity/product requested: **Babyl Rwanda**, operated by Babylon/Babyl in partnership with Rwanda’s public health system. Babyl UK established the Rwanda operation in **2016**; a March 2020 partnership with the Government of Rwanda/Rwanda Social Security Board was framed as a 10-year “Digital-First Integrated Care” arrangement; operations were later taken over by the Rwandan company Irembo in **2023** and the service was suspended/discontinued in **September 2023** for redesign, with subsequent publications describing it as no longer active [10] [1].

The UX pattern is important because it avoided the most bandwidth-sensitive channel. Patients could dial **USSD `*811#`**, register/book using national identity/SIM-linked data, receive triage and consultation by **phone callback**, and receive **SMS prescription or laboratory codes**. The workflow integrated insurance, pharmacy and laboratory fulfilment and referred patients to facilities when the condition required a physical exam, lab confirmation or care outside the telemedicine licence/scope [10] [1].

The completion and quality results are unusually strong for a low-resource national-scale telemedicine program:

- **Completion:** **3,676,385/3,899,788 = 94.3%** completed consultations, Jan 2019-Sept 2023; no-shows **223,403 = 5.7%** [1].
- **By cadre:** GPs completed **1,128,403/1,167,467**; senior nurses **936,512/979,434**; triage nurses **1,611,470/1,752,887** [1].
- **Quality:** in the NBER standardized-patient audit, **2,532** total visits included **1,071** telemedicine and **1,461** in-person visits for malaria and URI. Malaria correct case management was comparable to in-person; URI correct case management was materially better by phone [3].
- **Mechanism:** telemedicine providers asked more questions about symptoms and medical history: **+3.15** questions for malaria and **+5.97** for URI in the DML specification, while visits were shorter by **1.19** and **1.71** minutes respectively and wait time was about **68.5-70.1 minutes** lower [3].

**UX interpretation:** Babyl’s winning low-connectivity pattern was not rich media. It was **USSD discovery/booking + asynchronous administrative state + synchronous callback + SMS fulfilment + referral**. The call-center environment likely reduced distractions and supported structured questioning; the NBER paper reports provider perceptions that phone care made it easier to obtain information and relate to patients [3]. The weakness was dependency on system integration and operating model sustainability: the BMC study links high completion to insurance/lab/pharmacy integration and notes discontinuation in Sept 2023 [1].

### 2.2 mPharma Mutti Doctor

The relevant mPharma product/program in the fetched sources is **Mutti Doctor**. It launched around **October 2021**. A February 2022 mPharma article reported approximately **4,000** people examined/treated in four months across **30** Mutti Doctor locations in Ghana, Nigeria and Kenya [11]; an April 2022 TytoCare/mPharma announcement reported **>8,000** people examined/treated since the June 2021 TytoCare rollout across **35** pharmacies in Ghana, Kenya, Uganda, Zambia and Nigeria [12].

The workflow is pharmacy/clinic-assisted rather than self-serve rural telemedicine. A patient walks into a Mutti pharmacy or “good health shop,” books same-day, receives a free remote physical examination by a virtual doctor, and can obtain instant prescription fulfilment for pickup or delivery [13] [14]. The mPharma article describes community-health-nurse screening, pharmacist fulfilment of prescriptions and call-centre follow-up/reminders after consultation [11]. The device layer is more bandwidth- and skill-intensive than Babyl: mPharma/TytoCare materials describe an all-in-one remote-exam platform for in-depth physical examination, and TechCrunch identified the digital stethoscope, otoscope, thermometer and examination camera with illumination for high-definition skin and throat images [12] [15].

The strongest published UX/KPI finding in the fetched materials is speed: a TytoCare/mPharma announcement reported that **>90%** of patients visiting Mutti Doctor locations had a virtual doctor consultation within **10 minutes** [12]. The fetched sources did **not** report consultation-completion percentage, diagnostic accuracy versus in-person care, explicit offline behavior, or quantified medication-reconciliation outcomes. They did show medication workflow integration at the point of dispensing: prescriptions can be reviewed and filled by the on-site pharmacist, and follow-up is handled through a call centre [11].

**UX interpretation:** Mutti Doctor is best read as a **staff-assisted tele-exam and dispensing interface**, not a proven 2G/3G self-service rural consultation model. Its nurse/pharmacist mediation lowers patient smartphone burden and supports medication access, but its HD image/device assumptions make it less robust than Babyl’s USSD/callback model where bandwidth is poor.

### 2.3 Zipline clinical ordering and supply-chain tools

The relevant Zipline workflow in the fetched sources is not a diagnostic decision-support module; it is a **clinician/health-facility ordering and fulfilment workflow** for medical commodities. Health workers place orders using **WhatsApp, SMS or phone**, allowing fast interactions with no special equipment, software or data entry [16]. Rwanda health personnel at clinics/hospitals submit orders by **SMS, WhatsApp or phone call**; Zipline then packages centrally stored medical products, launches the drone and drops the package at the facility while maintaining cold-chain/product integrity [17].

The UX principle is extremely relevant to rural telehealth medication workflows: use **the lowest-friction channel that already works**, and make fulfilment visible even when the clinical encounter itself is not app-based. Zipline’s capability materials claim **100% on-time and in-full delivery**, **100% cold-chain integrity**, **0% counterfeits**, **100% complete/visible inventory and distribution records**, custom dashboards, GS1-compliant product-level tracking and 24/7 support [16]. Those are vendor claims, so the stronger evidence is the independent Ghana impact evaluation.

Zipline Ghana launched in **2019** with a plan to cover roughly **2,000 facilities** across Ahafo, Ashanti, Bono East, Central, Eastern, Northern, North East, Upper East and Volta. IDinsight’s April 2022 evaluation found:

- Unique products stocked: **+0.966** products versus control, **p=0.045** [18].
- Average percentage of days without stocked vaccine/product: **5 percentage-point** reduction versus a **45-day** control level, an **11%** drop [18].
- For products a facility chose to stock, days without product fell **3 days** versus **14.4** control days, about **20%**, **p=0.06** [18].
- Vaccine stockout duration: **3.2 days** in Zipline facilities versus **5.3 days** in control, a **60%** reduction, **p=0.01** [18].
- Facilities sending vaccination patients away due to stockout: **15%** Zipline versus **25%** control, a **10 percentage-point / 41%** reduction, **p=0.08** [18].
- A separate Ghana vaccine study found last stockout duration **30 days** in served facilities versus **43** in non-served facilities, missed vaccination opportunities **36%** versus **65%**, **79.5%** of served providers ordered from Zipline when stocked out, and access in **<60 minutes** [19].

**UX interpretation:** Zipline should not be described as having published diagnostic clinical decision support in the fetched evidence. Its relevance is **medication and commodity reconciliation at the system level**: if a teleconsultation produces a prescription or referral, the supply chain must expose stock, substitutions and delivery status through SMS/WhatsApp/app/phone rather than assuming an always-online EHR.

## 3. Side-by-side UX comparison

| Dimension | Babyl Rwanda | mPharma Mutti Doctor | Zipline ordering/fulfilment |
|---|---|---|---|
| Synchronous vs asynchronous | Hybrid: USSD booking/state and SMS fulfilment, then synchronous callback consultation | Mostly synchronous virtual doctor consultation in a pharmacy, assisted by nurse and devices | Asynchronous order submission and fulfilment; SMS/WhatsApp/phone order state |
| Entry point | Patient directly via USSD `*811#` on feature phone/mobile; community agents helped low-literacy users | Patient walks into pharmacy/good health shop; nurse/pharmacist mediates | Health worker/facility places commodity order |
| Form structure | Patient registration/booking and call-centre clinical script; source evidence emphasizes structured questioning rather than patient form entry | Staff-assisted vitals and device exam; doctor interface receives clinical measurements/images | Product order fields, inventory and fulfilment dashboards; not diagnostic clinical forms in fetched sources |
| Triage model | Nurse/GP call-centre triage; referral if out of scope/physical exam/lab needed | Nurse precheck plus virtual doctor; urgent referral in case example | Order validation and fulfilment triage at distribution hub |
| Image/document capture | Not central to the documented low-bandwidth workflow | TytoPro HD skin/throat/ear and auscultation captures; higher bandwidth/device burden | Product/order documentation; no diagnostic image workflow found |
| Medication reconciliation | SMS e-prescription/lab codes and pharmacy integration; prescriptions in platform data | On-site pharmacist dispenses or delivers prescription; call-centre follow-up | Stock availability, substitutions and delivery status at commodity level |
| Offline behavior | USSD/SMS/callback tolerant of low bandwidth; no fetched source documents app offline queue | No fetched source documents offline behavior | Multi-channel fallback: SMS/WhatsApp/app/phone; no fetched source documents offline app sync |
| Escalation path | Referral to health facility for physical exam, lab confirmation or out-of-scope care | Referral to nearby imaging/hospital in case example | Facility receives commodities; emergency fulfilment via drone where covered |
| If connectivity fails mid-consult | Best-supported design inference: preserve booking/patient state and retry callback/SMS; source documents USSD/callback/SMS, not a detailed failure protocol | Staff can continue local exam and rebook/phone because patient is physically at pharmacy, but no published failure protocol was fetched | Switch channel among SMS, WhatsApp or phone; orders can be placed without special equipment/software/data entry [16] |

Ranking for low-connectivity rural primary care: **Babyl-style USSD/SMS/callback ranks first for consultation completion and diagnostic quality evidence**; **Zipline-style multichannel ordering ranks first for medication/commodity continuity**; **Mutti Doctor ranks first for assisted physical exam richness but last for 2G/3G robustness** because its strongest differentiator is device-assisted HD examination rather than minimal-bandwidth asynchronous capture.

## 4. Store-and-forward diagnostics: what is established and what remains unproven

The fetched evidence base supports store-and-forward as a **recognized low-bandwidth clinical communication mode**, especially for provider-to-provider diagnosis and case management. WHO states that provider-to-provider telemedicine may occur asynchronously through exchange of video and image files for later review, or synchronously in real time, and is used to obtain diagnostic assistance, remotely monitor vital signs and conduct case-management consultations [4]. The Addis Clinic Kenya evidence operationalizes this: frontline health workers submitted cases through a mobile app, in-country coordinators triaged them, and remote specialists responded asynchronously; baseline **99%** of cases were answered [2].

The fetched sources did not establish exact image-quality thresholds, compression methods, repeat-capture rates or failure rates for dermatology, wounds, ophthalmology, radiology, ultrasound or maternal-child-health store-and-forward diagnostics. Therefore, the safe design conclusion is to treat store-and-forward images as **supporting evidence**, not as the sole basis for diagnosis unless the specialty-specific validation threshold is locally established. For rural primary-care teleconsultations, the minimum case packet should include:

1. Patient identity/contact and consent.
2. Chief complaint and duration.
3. danger signs and vital signs.
4. pregnancy status where relevant.
5. current medicines, allergies and chronic conditions.
6. structured symptom checklist by syndrome.
7. optional compressed images/audio/video with capture-quality checks.
8. clinician question/answer thread and final disposition.
9. referral, prescription and stock/dispensing status.

For image/audio capture under 2G/3G, the UX should make low-quality media recoverable: show a visual example, require focus/lighting/body-site confirmation before upload, compress locally, upload in chunks, and permit a clinician to request “repeat image: too dark/out of focus/wrong distance” without restarting the whole consultation. Because the fetched sources do not provide numerical repeat-capture thresholds, a pilot should measure **unusable-media rate**, **repeat request rate**, **time to specialist response** and **diagnostic concordance with in-person review** before scaling.

## 5. Offline-first architecture for clinical safety

The architecture should implement offline-first as a clinical-safety feature, not only a performance feature. The Community Health Toolkit states that CHT applications are designed for areas with no internet, slow/unreliable internet and good connectivity, and that day-to-day tasks should not rely on an internet connection [20]. CHT uses service workers to cache app code, stores newly created patient/task data in the phone cache, and performs replication to send/receive updates without interrupting the user [20]. It also warns that request timeouts and spinners are not offline-first because users on poor connectivity may wait indefinitely; blocking interaction while waiting for a server response is inappropriate [20].

A clinically relevant offline-first design should therefore include:

- **Local encrypted persistence:** patient registration, consent, draft consultation, medication list, images and audit events remain on device until synced; encryption and role-based access are mandatory because WHO flags privacy/confidentiality and consent challenges, especially for records/images in low-literacy settings [4].
- **Draft states:** every clinical form and image capture step saves locally after each screen so a network interruption, battery loss or app crash does not erase the consultation.
- **Durable message queue:** every outbound item has an idempotency key, timestamp, author, patient, facility, payload hash, retry count and status: `draft`, `queued`, `uploading`, `sent`, `acknowledged`, `needs-info`, `failed`, `superseded`.
- **Background sync/replication:** follow the CHT pattern of sending and receiving updates in the background without blocking workflow [20].
- **Resumable uploads:** split images/audio into chunks and allow retry from the last acknowledged chunk.
- **Conflict resolution:** prefer additive clinical events over destructive overwrites. If two users edit medication history, preserve both entries, mark conflict and require clinician reconciliation before prescribing.
- **Audit trail:** log creation, edits, consent, media capture, prescription, referral, sync, read/access and deletion. FHIR resources explicitly reference AuditEvent in medication workflows, and MedicationRequest supports status and status-change data [21].
- **Consent capture:** record patient consent for teleconsultation and image/media sharing; WHO notes that informed consent for records and images can be challenging where basic/digital literacy is low [4].
- **Role-based access:** separate community health worker, nurse, clinician, pharmacist and supervisor privileges; WHO recommends decision support only where tasks are within the health worker’s defined scope of practice [4].
- **Fallback channels:** SMS/USSD for acknowledgements and structured short updates; voice callback for urgent or failed uploads; WhatsApp, SMS or phone order fallback for medicines/commodities, following Zipline’s multichannel pattern [16].
- **Standards alignment:** represent clinical data using FHIR resources such as Patient, Encounter, Observation, Condition, MedicationStatement, MedicationRequest, MedicationDispense and AllergyIntolerance; WHO’s intervention taxonomy defines digital tracking, decision support, client-to-provider and provider-to-provider telemedicine, and OpenHIE-style architectures should be used for interoperability where national eHealth infrastructure exists [22] [4] [21] [23].

## 6. Medication reconciliation requirements

Medication reconciliation must be first-class in rural telehealth because remote prescribing without a reliable medication list can create avoidable adverse drug events. The primary-care MedRec guide states that the most important outcome is an accurate and comprehensive medication list communicated to the patient with verification of the patient’s understanding; referral requests should include **all prescription and nonprescription medications**, not only those that seem relevant, with complete details of **name, dose, route and frequency** [24]. It also identifies common primary-care barriers: limited access to information sources, incomplete/conflicting sources, multiple pharmacies, low health literacy, language/cultural barriers and EMR designs that do not support MedRec requirements [24].

For this telehealth platform, the medication screen should capture these exact elements before any non-urgent prescription is finalized:

| Category | Required data elements | Standards/workflow grounding |
|---|---|---|
| Current medicines | Medicine name, formulation/strength, dose, route, frequency, start date, indication/reason, last dose taken, adherence, source of information, photo of package if available | MedicationStatement records medicines a patient reports taking; MedicationRequest orders medicine and instructions for administration [21] |
| Recent dispensing | Pharmacy/facility, dispense date, quantity, days’ supply, substitution made, stockout/partial fill, delivery status | MedicationDispense is the FHIR resource for provision of medication supply; Zipline evidence shows stockout reduction is clinically relevant to whether prescribed products are actually available [21] [18] |
| Allergies/adverse reactions | Substance, reaction, severity, date/recency, certainty, “no known allergies” as explicit statement | FHIR AllergyIntolerance supports current allergy lists and explicit nil-known allergy representation [23] |
| Contraindication checks | Pregnancy/breastfeeding status, age/weight where dose-dependent, chronic conditions, renal/hepatic risk where known, HIV/TB/malaria medications and other interaction-prone treatments | WHO recommends decision support only within scope and aligned to health-worker tasks; FHIR Condition/Observation/Medication resources support structured checks [4] [21] |
| Reconciliation decision | Continue, stop, change dose, substitute, prescribe new, refer, or “insufficient history—do not prescribe remotely” | MedicationRequest status includes active, on-hold, ended, stopped, completed, cancelled, draft and unknown; it supports status reason and status changed [21] |
| Patient understanding | Teach-back: patient repeats dose/frequency/duration and red flags; preferred language; SMS summary sent | MedRec guide emphasizes communication to the patient and verification of understanding [24] |

Design rule: if medication history is incomplete and the drug has meaningful contraindication or interaction risk, the platform should not silently continue. It should mark the prescription as **draft/on-hold**, request pharmacy/dispensing history or package photo, and route to clinician callback or in-person referral if the uncertainty cannot be resolved.

## 7. Cognitive-load principles for low-proficiency smartphone users

The Rwanda qualitative Babyl study found that older adults and users with lower digital literacy needed sustained agent assistance; without agent availability, consultation initiation could become impossible, and providers experienced frustration when medication stock-outs and inability to access consultation records created operational problems [10]. WHO similarly reports that health workers with poor digital literacy may not understand generated information, may feel anxious about errors and require training/support; rural and remote workers are also more likely to face poor network coverage, poor electricity access and limited mobile-device access [4].

The clinical UX should therefore reduce intrinsic, extraneous and interruption-related cognitive load:

1. **Progressive disclosure:** show only the current decision: identity → consent → danger signs → chief complaint → syndrome module → medication/allergy → media → disposition. Do not show the full encounter form at once.
2. **Chunking:** each screen should require 3-7 fields maximum, with visible progress and auto-save after every screen.
3. **Defaults and constrained choices:** use local guideline defaults, yes/no/unknown choices, common medicine lists and common symptom durations; allow free text only after “other.”
4. **Recognition over recall:** show pictorial body maps, medicine package photo examples, dose-frequency chips and danger-sign icons rather than requiring memorized terminology.
5. **Point-of-entry validation:** validate impossible values locally, such as adult temperature outside physiologic range, missing pregnancy status before prescribing contraindicated medicines, or image too dark before upload.
6. **Save/resume:** every consultation has a visible state: `Draft saved on this phone`, `Queued`, `Sent`, `Clinician reviewing`, `Needs more information`, `Complete`, `Referred`.
7. **Error recovery:** if the network drops, say “Saved. We will send when network returns. For danger signs call/refer now,” not “Upload failed.”
8. **Minimize duplicate documentation:** reuse patient demographics, medication list, allergies and vital signs across referral, prescription and supply order; CHT’s offline-first model supports local cached data and background replication [20].
9. **Image capture scaffolding:** use on-screen silhouettes, distance guides, flash/lighting prompts, one required overview plus one close-up, compression preview and “retake because blurry/dark” before upload.
10. **Training and supervision:** WHO reports that training, familiarity and support from peers/higher-level staff improve acceptance and use [4]. Build a practice mode and supervisor review queue into the product.

## 8. Recommended design pattern and fallbacks

### Preferred pattern for 2G/3G rural consultations

Use a **store-and-forward clinical packet with callback escalation**, not video-first care.

1. Provider opens an offline-first app/PWA and selects patient or registers minimal identity.
2. App captures consent, danger signs, vitals, complaint, structured syndrome checklist, medication/allergy/pregnancy data and optional images/audio.
3. Data is saved locally and queued immediately.
4. If any data connection exists, the app syncs in background; if not, it prepares an SMS/USSD summary with case ID and urgency.
5. Clinician reviews asynchronously and either completes advice, requests more information, prescribes, or calls back.
6. Prescription/referral is returned by app plus SMS, and medication availability/fulfilment can use Zipline-like SMS/WhatsApp/phone ordering and status channels.

This design combines the two proven high-completion patterns: Babyl’s **94.3%** USSD/callback/SMS completion at national scale [1] and The Addis Clinic’s **99%** baseline asynchronous answered-case rate in Kenya [2]. It avoids the Tanzania teleconsultation failure mode where only **116/218 = 53.2%** inquiries became attended teleconsultations, with insurance/payment friction a major barrier [9].

### Fallback when uploads stall or the clinician is offline

- Keep the case in `queued` or `sent-pending-ack` state; never block the provider with a spinner.
- Send a low-bandwidth SMS/USSD case header: patient ID, age/sex, chief complaint, danger-sign flag, facility, callback number and case ID.
- If danger signs are present, bypass asynchronous review and trigger voice call/referral.
- Retry upload in background using resumable chunks.
- If no acknowledgement arrives within the locally defined service-level target, escalate to phone callback.

This follows CHT’s principle that day-to-day work should not rely on connectivity, that request timeouts/spinners are insufficient, and that replication should occur without interrupting the user [20].

### Fallback when images are unusable

- Do not discard the consultation; mark media as `needs recapture` and allow the clinician to act on structured data if safe.
- Request one specific repeat: “retake close-up in daylight,” “include full limb,” “clean lens,” or “move 30 cm away.”
- If the condition is image-dependent and repeat media fails twice or cannot be uploaded, convert to voice callback or in-person referral.
- Track unusable-image and repeat-capture rates in the pilot because the fetched sources did not establish specialty-specific thresholds.

### Fallback when medication history is incomplete

- Ask for medicine package photos or a readout of name/strength/frequency.
- Query recent dispensing where integrated pharmacy/stock data exists.
- Mark high-risk prescriptions as `draft/on-hold` until allergies, pregnancy status and current medicines are confirmed.
- If the patient uses multiple pharmacies or cannot identify medicines, refer to pharmacy/in-person medication review before prescribing high-risk drugs.

This is consistent with primary-care MedRec guidance that complete medication details and patient understanding are the key outcome, and with its warning that multiple pharmacies and incomplete/conflicting information are common barriers [24].

### Escalation threshold for urgent in-person referral

The platform should require immediate referral or emergency callback when any of the following are entered: severe respiratory distress, altered mental status, seizures, severe dehydration, pregnancy danger signs, severe abdominal pain, suspected sepsis, uncontrolled bleeding, trauma, very young infant with fever, or any clinician-selected “cannot safely assess remotely” flag. This threshold is consistent with the Babyl workflow of referring conditions needing physical exam/lab confirmation/out-of-scope care [10] and WHO’s caution that telemedicine should expand access but not replace health-system strengthening or exceed health-worker scope [4].

## 9. Bottom line

For rural primary care in Uganda, Kenya and Tanzania, the most evidence-aligned UX is **asynchronous-first, offline-first, low-media by default, and callback-enabled**. Babyl Rwanda demonstrates that USSD/callback/SMS plus system integration can complete **94.3%** of nearly **3.9 million** consultations and deliver malaria case management comparable to in-person visits. The Addis Clinic Kenya demonstrates that provider-to-provider asynchronous specialist advice can reach **99%** answered cases in baseline conditions. Zipline demonstrates that multichannel ordering and fulfilment can reduce stockouts and missed vaccination opportunities, which matters because a remote consultation only improves outcomes if medicines and referrals are actually fulfilled. Mutti Doctor shows the value of assisted tele-examination and pharmacy dispensing, but the fetched evidence does not establish completion, diagnostic accuracy or offline performance for that model.

The design should therefore privilege structured questioning, medication reconciliation, save/resume, background sync, SMS/USSD/callback fallbacks, and clear referral thresholds over live video or high-resolution media. Cognitive-load reduction is not a usability luxury; in low-connectivity settings with limited smartphone proficiency, it is a clinical-safety mechanism.

## Sources

1. [Telemedicine implementation and healthcare utilization in Rwanda: interrupted time series of babyl digital health services from 2015 to 2024 - BMC Primary Care](https://link.springer.com/article/10.1186/s12875-026-03179-8)
2. [Frontiers | Use of provider-to-provider telemedicine in Kenya during the COVID-19 pandemic](https://www.frontiersin.org/journals/public-health/articles/10.3389/fpubh.2022.1028999/full)
3. [w34185.pdf](https://www.nber.org/system/files/working_papers/w34185/w34185.pdf)
4. [Evidence and recommendations - WHO guideline Recommendations on Digital Interventions for Health System Strengthening - NCBI Bookshelf](https://www.ncbi.nlm.nih.gov/books/NBK541898/)
5. [D-IND-SDDT_AFR-2025-PDF-E.pdf](https://www.itu.int/dms_pub/itu-d/opb/ind/D-IND-SDDT_AFR-2025-PDF-E.pdf)
6. [Digital 2025: Uganda — DataReportal – Global Digital Insights](https://datareportal.com/reports/digital-2025-uganda)
7. [Digital 2025: Kenya — DataReportal – Global Digital Insights](https://datareportal.com/reports/digital-2025-kenya)
8. [Digital 2025: Tanzania — DataReportal – Global Digital Insights](https://datareportal.com/reports/digital-2025-tanzania)
9. [The changing trend of teleconsultations during COVID-19 era at a tertiary facility in Tanzania - PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC7687499/)
10. [Digital Primary Health in Rwanda: Qualitative Study of User Experiences and Implementation Lessons From Babyl’s Telemedicine Platform](https://www.jmir.org/2026/1/e84832)
11. [Mutti Doctor: A Primary Healthcare Solution Built to Improve Access to Care](https://medium.com/mpharma-insights/mutti-doctor-a-primary-healthcare-solution-built-for-everyone-8cbe517851ca)
12. [mPharma partners with TytoCare for African telehealth](https://www.tytocare.com/news-and-press/african-healthtech-company-mpharma-partners-with-tytocare-to-introduce-comprehensive-telehealth-to-pharmacies/)
13. [mutti Doctor Zambia](https://muttidoctor.mymutti.com/zm/)
14. [mutti Doctor Ghana – Just another Mutti Doctor site](https://muttidoctor.mymutti.com/gh/)
15. [mPharma, a telehealth pioneer out of Ghana, gets physical with 100 virtual centers across Africa | TechCrunch](https://techcrunch.com/2021/10/11/mpharma-a-telehealth-pioneer-out-of-ghana-gets-physical-with-100-virtual-centers-across-africa/)
16. [Zipline-Capabilities-Statement.pdf](https://assets.ctfassets.net/pbn2i2zbvp41/5dpfo3SJfsUZ0Az5fqLA1P/44e71538284dce389d48d3cc05f15142/Zipline-Capabilities-Statement.pdf)
17. [Zipline-Rwanda-Final-June1.pdf](https://reachalliance.org/wp-content/uploads/2021/04/Zipline-Rwanda-Final-June1.pdf)
18. [Zipline-Brief-FINAL-Digital-v3.pdf](https://www.idinsight.org/wp-content/uploads/2022/06/Zipline-Brief-FINAL-Digital-v3.pdf)
19. [Zipline_Ghana_Vaccine_Study.pdf](https://www.updwg.org/wp-content/uploads/2023/08/Zipline_Ghana_Vaccine_Study.pdf)
20. [Offline-First in the CHT](https://docs.communityhealthtoolkit.org/technical-overview/concepts/offline-first/)
21. [MedicationRequest - FHIR v5.0.0](https://www.hl7.org/fhir/medicationrequest.html)
22. [Table 1, Definitions of included digital health interventions - WHO guideline Recommendations on Digital Interventions for Health System Strengthening - NCBI Bookshelf](https://www.ncbi.nlm.nih.gov/books/NBK541888/table/fm-ch1.tab1/)
23. [AllergyIntolerance - FHIR v5.0.0](https://hl7.org/fhir/allergyintolerance.html)
24. [Primary Care MedRec Guide](https://www.ismp-canada.org/primarycaremedrecguide/MedRecProcess.htm)