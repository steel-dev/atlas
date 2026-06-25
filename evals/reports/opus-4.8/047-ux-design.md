# Designing Telehealth for Low-Connectivity Rural Primary Care in Uganda, Kenya, and Tanzania

## 1. The connectivity reality your design must survive

Any design decision flows from the actual network and device environment in the three target markets. The headline figures:

| Market | Internet penetration | Mobile connections | Network mix / coverage | Median mobile download |
|---|---|---|---|---|
| **Uganda** (Digital 2024) | 27.0% (13.30M users); 73% of population offline; 72.9% rural [1] | 33.34M = 67.7% of population [1] | National median masks rural 2G/3G reality | 35.03 Mbps (urban-weighted national median) [1] |
| **Kenya** (Digital 2025) | 48.0% (27.4M users); 52% offline [2] | 68.8M = 121% of population [2] | 94.7% of connections are "broadband" (3G/4G/5G) per GSMA — so ~5.3% remain 2G-only [2] | 29.97 Mbps [2] |
| **Tanzania** (TCRA, Q ending June 2024) | 39.3M internet subscriptions, 99.6% mobile-wireless [3] | — | 2G still **17.74M** subscriptions; infrastructure base 13,470 2G BTS + 12,366 3G NodeB + 11,777 4G eNB + 754 5G gNB; 4G population coverage 80% (geographic only 69%); 3G pop coverage 89%/geo 73% [3] | 3G ~11–12 Mbps; 4G ~35–42 Mbps [3] |

Two design-critical facts follow. First, **median speeds are urban-weighted and overstate the rural experience**: Tanzania's own regulator reports 4G covers 80% of the *population* but only 69% of the *geography* [3], and rural Uganda (where 72.9% of people live [1]) sits disproportionately in the uncovered fraction. Second, **voice/USSD/SMS reaches far more people than data apps**: Uganda has 67.7% mobile-connection penetration but only 27% internet use [1], and Tanzania still carries 17.7M 2G subscriptions [3]. A feature-phone-first channel is not a fallback in this region — for the rural primary-care population it is the primary channel.

## 2. Three platforms, three divergent UX strategies

The three named platforms solve very different problems, and conflating them obscures the lesson. Only one is a patient-facing primary-care teleconsultation system; the other two are, respectively, a clinic-embedded device-mediated exam and a supply-chain reconciliation tool.

### 2.1 Babylon Health's Rwanda deployment ("Babyl") — voice/USSD-first synchronous triage
Babyl operated 2016–2023 and signed a 10-year partnership with the Government of Rwanda in March 2020 for "Digital-First Integrated Care" for all Rwandans aged 12+, delivering ~4.5 million consultations [4]. It was explicitly designed for a country where only ~10% of people had smartphones [4]. Its architectural answer to intermittent connectivity was to **avoid data dependence entirely**:

- **Access channel = USSD `*811#`**, which runs on *any* mobile phone, including basic feature phones, with no app or internet [4]. USSD is a session-based signalling channel that works over 2G voice infrastructure.
- **Consultation = synchronous voice call**, not video or chat [4][5].
- **Asynchronous tail = SMS**: the e-prescription is sent by SMS with a unique code to both the patient and the partner pharmacy, and lab orders flow through an integrated HMIS [5].
- A **three-tiered, nurse-led** model handled load: triage nurses took 44.2% of consultations under standardized protocols, escalating to senior nurses (25.6%) or general practitioners (30.2%), running ~3,000 consultations/day and freeing an estimated 8,750 physician-hours monthly [5].
- **Identity and payment were folded into the same low-bandwidth flow**: registration via national ID (NIDA), insurance verification (Mutuelle de Santé / RSSB), and a mobile-money co-pay [4].
- An April 2021 **"shared device access"** change (register/consult from any phone using only the national ID) raised female registrations by 64% and daily consultations by 55%, peaking near 5,000/day [4].

The generalizable lesson: **synchronous voice over USSD/SMS sidesteps the offline problem rather than solving it** — there is no large payload to lose to a dropped packet, and the interaction degrades gracefully to the most resilient bearer available.

### 2.2 mPharma — clinic-embedded, device-mediated synchronous exam + pharmacist reconciliation
mPharma's telemedicine is **"Mutti Doctor"**: virtual doctor offices physically located inside community pharmacies, equipped with connected point-of-care instruments — an all-in-one digital stethoscope, otoscope, thermometer, and examination camera — through which a licensed doctor in the capital performs a remote exam [6]. This is a **hub-and-spoke synchronous model**, not a patient-facing offline app: the connectivity burden sits at a fixed, staffed pharmacy site rather than on a rural patient's handset.

Medication reconciliation lives in **"Bloom,"** mPharma's web application for pharmacists, which holds patient medication history, treatment guidelines, real-time drug information, refills, reminders and pharmacist–patient messaging [6]. Across markets mPharma runs a Vendor-Managed Inventory (VMI) system [6]. Notably, mPharma **abandoned its original SMS-prescription approach as impractical** and pivoted to an e-prescription platform launched first in Zambia then Ghana [6] — a cautionary counterpoint to Babyl's successful SMS use, showing that SMS works for short codes/notifications but not as a structured clinical record channel. It operates 500+ pharmacies across Ghana, Nigeria, Kenya, Uganda, Zambia, Ethiopia, Rwanda, Togo and Benin, and openly cites internet connectivity in remote areas as a constraint [6].

### 2.3 Zipline — text-first supply-chain ordering and stock reconciliation
Zipline is **not a consultation tool**; it is end-to-end medical-supply drone delivery (Rwanda, Ghana, plus Japan/USA as of 2022) whose relevance here is its **medication availability and order-reconciliation UX** [7]. Its ordering interface is deliberately multi-channel and low-bandwidth: "a customer places an order via **text, mobile or web app**" [7]. Order-to-delivery runs under ~40 minutes (request 8:00, launch 8:05–8:10, delivery 8:25–8:40), versus the 8–21 day turnaround of Ghana's Regional Medical Stores [7]. Measured impact in the IDinsight evaluation:

- Stockout-at-presentation in control facilities was **41%** for severe-malaria treatment and **73%** for anti-snake serum; Zipline cut these by **26 and 42 percentage points** (37% and 56% relative reductions) [7].
- Vaccine-stockout referrals: 15% of Zipline facilities vs 25% control (41% decrease, p=0.08) [7].
- Health workers reported **28% higher satisfaction** with medicine availability; **92%** of facility heads found Zipline convenient [7].

Zipline's roadmap was to consolidate ordering into a single customer-facing mobile app giving government partners **real-time access to ordering data** and to streamline onboarding for low-proficiency users [7] — i.e., keep the resilient SMS/text channel for ordering while moving reconciliation/visibility to an app.

### 2.4 What generalizes vs. what is deployment-specific

| Pattern | Babyl | mPharma | Zipline | Generalizes? |
|---|---|---|---|---|
| Resilient low-bandwidth channel | USSD `*811#` + voice + SMS [4] | Fixed-site broadband; SMS dropped [6] | Text/SMS ordering [7] | **Yes** — text/USSD as the floor channel |
| Synchronous vs async | Synchronous voice; async SMS tail [5] | Synchronous device exam [6] | Async order → fulfilment [7] | Mixed; depends on whether physical exam data is needed |
| Burden placement | On any handset | On a staffed pharmacy hub [6] | On facility/health worker [7] | **Deployment-specific** — hub model needs fixed connectivity |
| Reconciliation | e-prescription via SMS to patient + pharmacy [5] | Bloom medication history + VMI [6] | Real-time stock data via app [7] | **Yes** — separate the lightweight transaction from the heavier record |

The clearest cross-platform rule: **carry the transaction on the most resilient bearer (USSD/SMS/voice) and reserve data/app surfaces for reconciliation and record-keeping that can sync later.** mPharma's hub-and-spoke device exam generalizes *only* where a fixed, connected site exists — it does not solve the last-mile rural-handset problem the way Babyl's USSD model does.

## 3. Consultation completion rates: what drives >85%

The strongest documented completion evidence is Babyl's. Across an interrupted-time-series study (2015–2024), **completion rates consistently exceeded 94%** across all consultation categories — 94.3% for respiratory infections versus 87% for malaria, the latter lower because it requires lab confirmation [5]. No-show rates were 3.6% for triage nurses, 1.1% for senior nurses, and 1.0% for GPs [5]. The interaction patterns associated with these rates:

1. **A feature-phone-universal entry point** (USSD `*811#`) so device ownership is never a barrier [4].
2. **Synchronous voice** that completes in a single session, eliminating the multi-step drop-off of app flows [5].
3. **Tight integration of identity, insurance, payment, labs and pharmacy** — the study found each additional system integration was associated with a **12–15% increase in completion rates** [5]. Insurance coverage mattered concretely: Mutuelle beneficiaries (74.9% of users) had a 4.1% no-show rate, RSSB/RAMA members just 0.5% [5].
4. **Nurse-led triage tiers** that match case complexity to the right provider and keep the funnel moving [5].

The design takeaway for completion above 85%: minimize the number of independent steps that can fail, run the clinical interaction in one synchronous session on the most resilient bearer, and remove downstream friction (payment, prescription redemption) by integrating it into the same flow.

## 4. Asynchronous vs. synchronous: how the choice affects diagnostic accuracy

The accuracy evidence is reassuring and specific. Store-and-forward/asynchronous teleconsultation is **clinically acceptable and broadly comparable to in-person care for well-defined conditions**, with the gap driven by provider skill and case type rather than by the asynchronous modality itself:

- **Teledermatology meta-analysis** (Bourkas et al., *BMJ Open* 2023, DOI 10.1136/bmjopen-2022-068207; 44 studies): pooled teledermatology-vs-face-to-face diagnostic agreement **68.9%, kappa 0.67** [8]. The decisive split was expertise, not modality: **71% agreement (kappa 0.69) when dermatologists did both** vs only **44% (kappa 0.52) for non-specialists** [8]. For reference, face-to-face-vs-face-to-face agreement was 82.4% and teledermatologist-vs-teledermatologist 76.4% [8]. Agreement rose with **image-acquisition training and digital (vs analog) photography** [8].
- **Synchronous vs asynchronous, head-to-head**: Edison et al. (2008) found face-to-face vs synchronous teledermatology at **80%** and vs asynchronous store-and-forward at **73%** — async modestly lower than live [9].
- **Rural-India RCT** (Verma et al., *JMIR*, DOI 10.2196/42775): overall telemedicine-vs-in-person concordance **~74%**, with **no significant difference between synchronous and asynchronous** modes (P=.32) [9]. Accuracy was strongly case-dependent: hypertension 95% (kappa 0.93) and diabetes 93% (kappa 0.89) at the top; cardiology 33% and nonspecific symptoms 30% at the bottom [9].
- **Rural Kenya** (Qin et al., 2012, n=102): **78.4% diagnostic** and **89.2% treatment** concordance [9].

**Design rules reconciling the evidence:**

- Asynchronous store-and-forward is safe to use where the diagnosis hinges on **structured, capturable data** (vitals, a good photograph, lab values) — hypertension, diabetes, dermatology, malaria-with-RDT. Reserve **synchronous** interaction for **nonspecific, history-dependent, or high-acuity** presentations where the small synchronous accuracy premium (≈80% vs 73% [9]) and real-time questioning matter most.
- Because accuracy tracks **provider expertise more than modality** [8], route store-and-forward cases to the most qualified available reader and invest in **image-acquisition training** — the single most reproducible accuracy lever in the literature [8].
- Babyl's nurse-triage-then-escalate tiering [5] is the operational embodiment of this rule: cheap synchronous triage filters cases, and only ambiguous ones consume scarce physician attention.

## 5. Offline-first architecture for low-bandwidth health apps

Where a true data app is warranted (e.g. an EMR/diagnostic capture tool used by the provider at a clinic), the established pattern is the **CouchDB/PouchDB offline-first stack**, used in production by Medic Mobile / the Community Health Toolkit:

- **Local-first persistence with deferred sync**: PouchDB holds data locally (IndexedDB) and continuously replicates to a central CouchDB "whenever convenient," giving a fully functional offline-first progressive web app set up in roughly six lines of code [10]. The app never blocks on the network; the sync queue drains opportunistically when a bearer is available.
- **Conflict resolution**: CouchDB keeps a Git-like revision tree. When two offline edits collide, CouchDB deterministically picks an **arbitrary-but-consistent winner** (the same on every node after sync) and **preserves all losing revisions** so nothing is lost and the conflict can be resolved later [11]. Two conflict classes exist: *immediate* (a `409` on `put()` with a stale `_rev`, handled by retry/upsert expressed as a delta) and *eventual* (two peers edited the same doc offline) [11]. The app chooses the policy — last-write-wins, first-write-wins, or surfacing both versions to a clinician [11].
- **Conflict-avoidance by design ("every doc is a delta" / "accountants don't use erasers")**: never update or delete documents — only append new immutable, timestamp-keyed records, then aggregate [11]. This is the right model for **append-only clinical event logs and inventory/medication ledgers**, where each observation, prescription, or stock movement is a new record rather than an edit — making merge conflicts structurally impossible and preserving a full audit trail.

For images and other large payloads, store them as **attachments** to documents so they replicate within the same conflict-aware sync mechanism, and compress aggressively before they enter the queue (see §6).

## 6. Cognitive load and image-capture UX for low-proficiency users on interrupted networks

> **Evidence caveat.** The sources retrieved this run do not include a dedicated cognitive-load-theory (CLT) paper or a dedicated image-capture-UX specification. The principles below are stated as established design practice and are anchored to the empirical levers that *are* documented in the retrieved clinical sources (image-acquisition training, digital imaging, single-session flows, deferred sync); they should be treated as design guidance corroborated where cited, not as claims drawn from a CLT primary source.

**Cognitive load framing.** CLT distinguishes *intrinsic* load (inherent task difficulty — e.g., judging whether a skin lesion is adequately framed), *extraneous* load (imposed by poor interface design — confusing forms, unclear errors, lost work after a dropped connection), and *germane* load (effort that builds useful skill). For low-smartphone-proficiency rural providers facing frequent interruptions, the design goal is to **minimize extraneous load** so the user's limited working memory is spent on the clinical judgment, not on fighting the tool. Concretely:

- **Decompose long clinical forms into short, single-purpose steps** and persist every field locally on entry, so a network drop never discards work — the offline-first persistence of §5 is itself a cognitive-load intervention because it removes the fear and rework of lost data [10][11].
- **Prefer structured pickers and standardized protocols over free text.** Babyl's nurse triage ran on standardized protocols [5]; structuring the input both raises completion and constrains the decision space the user must hold in mind.
- **Carry the clinically essential transaction on the most resilient channel** (voice/USSD/SMS), as Babyl does, so the user is never asked to operate a complex data UI under a failing connection at the moment that matters [4][5].

**Image-capture workflow (diagnostic photos under interrupted networks).** The accuracy literature gives a clear, evidence-backed mandate: **diagnostic agreement rises with image-acquisition training and with digital (rather than analog) imaging** [8], and store-and-forward accuracy is acceptable when the capturable data is good [9]. Translating this into interaction patterns:

1. **Guided capture** — on-screen framing guides, reference exemplars, and prompts for the standardized views the reader needs — operationalizes the "image-acquisition training" lever that the meta-analysis identifies as the biggest reproducible accuracy gain [8].
2. **On-device quality validation before the photo is accepted** (blur/exposure/framing checks) keeps a re-shoot in the same session rather than discovering an unusable image after a slow upload — reducing both extraneous load and round-trips.
3. **Progressive, aggressive compression** of the image before it enters the sync queue, sized to 2G/3G realities (3G ≈ 11–12 Mbps but rural throughput is far lower and intermittent [3]).
4. **Resumable, deferred upload** through the offline-first sync queue, storing the image as a document attachment so it replicates with the same conflict-aware, "whenever convenient" mechanism and never blocks the consultation [10][11].

Together these reconcile **cognitive-load reduction with clinical completeness**: the form is short and forgiving, but the *captured payload* (vitals, a validated photo, the structured complaint) is complete enough to support an accurate asynchronous read — which the concordance data show is where store-and-forward succeeds or fails [9][8].

## 7. Regulatory and data-governance context

This was a required peripheral item, and a candid limitation: **the sources retrieved this run do not establish the specific telehealth statutes, data-protection acts, or remote-provider licensing rules for Uganda, Kenya, and Tanzania.** What the gathered evidence does show is that a working deployment integrates with **national identity and insurance systems and government partners** as a matter of course — Babyl integrated NIDA national ID, Mutuelle/RSSB insurance, and operated under a formal 10-year government partnership in Rwanda [4], and Zipline's roadmap explicitly gives **government partners real-time access to ordering data** [7]. Any Uganda/Kenya/Tanzania deployment should therefore treat government data-sharing, identity integration, and licensing of remote providers as first-class design constraints, but the precise legal instruments (e.g. each country's Data Protection Act and telemedicine practice guidelines) must be confirmed against primary legal sources not retrieved here.

## 8. Synthesis: a design recipe for the three target markets

1. **Default to a feature-phone-universal channel** (USSD/voice/SMS) for the core consultation and transaction, because in Uganda 73% of people are offline and Tanzania still carries 17.7M 2G subscriptions [1][3]. Babyl's >94% completion was built on exactly this [4][5].
2. **Use synchronous voice for triage and ambiguous/high-acuity cases; use asynchronous store-and-forward for structured, capturable conditions** (hypertension, diabetes, dermatology, malaria-with-RDT), where concordance with in-person care is high and the async penalty is small (≈73–80%) [9][8].
3. **Maximize completion by integrating identity, payment, labs and pharmacy into one flow** — each integration was worth ~12–15% in completion [5].
4. **Where a data app is needed, build it offline-first** on a CouchDB/PouchDB-style local store with deferred sync, append-only "delta" records for clinical and inventory logs, and an explicit conflict policy [10][11].
5. **Make image capture guided, quality-validated on-device, compressed, and resumably uploaded**, and invest in image-acquisition training — the most reproducible accuracy lever in the evidence [8].
6. **Place connectivity burden on fixed, staffed sites where a richer exam is required** (the mPharma device-hub model), but do not rely on it for last-mile rural reach [6].
7. **Treat government identity/insurance integration and (separately confirmed) national data-protection and licensing law as design constraints from day one** [4][7].

## Sources

1. [Digital 2024: Uganda — DataReportal – Global Digital Insights](https://datareportal.com/reports/digital-2024-uganda)
2. [Digital 2025: Kenya — DataReportal – Global Digital Insights](https://datareportal.com/reports/digital-2025-kenya)
3. [Communication Statistics report for end of June 2024_EN_1721315046.pdf](https://www.tcra.go.tz/uploads/text-editor/files/Communication%20Statistics%20report%20for%20end%20of%20June%202024_EN_1721315046.pdf)
4. [Telemedicine implementation and healthcare utilization in Rwanda: interrupted time series of babyl digital health services from 2015 to 2024 - BMC Primary Care](https://link.springer.com/article/10.1186/s12875-026-03179-8)
5. [Telemedicine in Rwanda - Babyl Rwanda](https://telemedicineabc.com/projects/telemedicine-rwanda/)
6. [Mutti Doctor: A Primary Healthcare Solution Built to Improve Access to Care](https://medium.com/mpharma-insights/mutti-doctor-a-primary-healthcare-solution-built-for-everyone-8cbe517851ca)
7. [Zipline-Brief-FINAL-Digital-v3.pdf](https://www.idinsight.org/wp-content/uploads/2022/06/Zipline-Brief-FINAL-Digital-v3.pdf)
8. [Diagnostic reliability in teledermatology: a systematic review and a meta-analysis](https://doi.org/10.1136/bmjopen-2022-068207)
9. [Diagnostic Concordance of Telemedicine as Compared With Face-to-Face Care in Primary Health Care Clinics in Rural India: Randomized Crossover Trial](https://doi.org/10.2196/42775)
10. [CouchDB takes Medic Mobile to the front lines of healthcare work](https://blog.couchdb.org/2017/09/19/couchdb-takes-medic-mobile-to-the-front-lines-of-healthcare-work/)
11. [Conflicts](https://pouchdb.com/guides/conflicts.html)