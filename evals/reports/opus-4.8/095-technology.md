# Competing Digital Identity Standards: A Technical Comparison

## Bottom line

These are not five competitors for one job — they occupy different layers of the identity stack and are largely **complementary**. FIDO2/WebAuthn is an **authentication** primitive (proving you control a key); W3C DIDs/Verifiable Credentials are a **credential** layer (portable, cryptographically verifiable claims); and government schemes (eIDAS/EUDI, Aadhaar, Estonia e-Residency) are **issuance + trust anchors** (a state vouching for who you are). A mature deployment layers all three: a state-issued credential, carried as a VC, unlocked and presented via a FIDO-grade key.

Ranked on the five requested criteria:

| Criterion | W3C DIDs/VCs | FIDO2/WebAuthn | eIDAS 2.0 / EUDI Wallet | Aadhaar (India) | Estonia e-Residency |
|---|---|---|---|---|---|
| **Privacy** | Strongest — selective disclosure + BBS+ ZKP, no central registry [1][2] | Strong — per-RP key pairs prevent cross-site correlation [3] | Mixed — unlinkability mandated but over-identification & batch-issuance risks documented [4][5] | Weakest — centralized biometric DB, linkage concerns [6] | Moderate — federated X-Road, but state-linked identity |
| **Interoperability** | Fragmented (did:web/key/ion/ebsi; JSON-LD vs JWT) [7] | Strongest — single cross-platform cert program [3] | Strong by design via ARF (ISO 18013-5 mDL, SD-JWT) but EU-bounded [7] | India-only [6] | EU/X-Road bounded |
| **Surveillance resistance** | Strongest — no central registry [1] | Strong — no shared secrets, no central IdP [3] | Contested — QWAC/Art. 45 + over-ID debate [8][5] | Weakest — central "honeypot" [6] | Moderate — federated, audited X-Road |
| **Recovery** | Weakest in practice — key rotation / social recovery, no helpdesk [1] | Strong — passkey cloud sync, multi-device [3] | Strong — state re-issuance + wallet recovery | Strong — UIDAI re-issue, biometric re-auth [6] | Moderate — PUK reset, in-person card replacement [9] |
| **Use-case suitability** | Best for cross-border/portable/stateless | Best for login at scale | Best for EU regulated banking/gov | Best for India domestic services | Best for EU business/e-gov access |

No single standard wins outright; the right choice is conditioned on jurisdiction, trust requirements, and whether a state issuer is available — developed below.

---

## 1. What each standard is, and who governs it

**W3C Decentralized Identifiers (DIDs) Core v1.0** became a **W3C Recommendation on 19 July 2022** (REC-did-core-20220719). It defines a new identifier type for verifiable, decentralized digital identity, specifying **DID syntax, DID documents, and DID resolution**. DIDs are explicitly "decoupled from centralized registries, identity providers, and certificate authorities," with the identifier controlled by its subject [1]. Governance is **controller-determined**, but the degree of decentralization **varies by DID method rather than being uniformly rootless**: `did:key` is fully ledger- and registry-independent (keys only), whereas `did:web` relies on existing **domain ownership and TLS** — effectively a CA-like trust anchor — and `did:ebsi` depends on the **EBSI governance framework** [1][7]. Trust derives from cryptography plus whatever anchor the chosen method assumes.

**W3C Verifiable Credentials Data Model** defines the **issuer → holder → verifier triangle** and selective disclosure. v1.1 was a Recommendation on **3 March 2022**; **v2.0 reached full W3C Recommendation status on 15 May 2025** (REC-vc-data-model-2.0-20250515) — it is no longer merely under development. It supports selective-disclosure zero-knowledge proofs via **BBS+ signatures** (cryptosuite `bbs-2023`, bls12381-g2 keys), `DataIntegrityProof`, and JWT/ES256 proofs [2].

**FIDO2/WebAuthn** is an authentication API. **WebAuthn Level 1 became a W3C Recommendation on 4 March 2019**, announced jointly by W3C and the FIDO Alliance as a core component of the FIDO2 specification set; **Level 2 on 8 April 2021**; **Level 3 is a Candidate Recommendation (still in development)** [3]. It uses **public-key challenge-response with no shared secrets**, scoping each credential to one Relying Party. The **Client to Authenticator Protocol (CTAP2)** connects external/roaming authenticators to clients (latest CTAP v2.2, FIDO Alliance Proposed Standard, 28 February 2025) [3]. **Passkeys** are multi-device FIDO credentials: a private key dedicated to one app is created and the public key is stored on the service's FIDO server; users verify locally via biometric/PIN, and the credential can be synced across devices via the platform cloud [3]. Governance combines the **FIDO Alliance certification program** with **platform vendors (Apple/Google/Microsoft)** who implement passkey sync.

**EU eIDAS 2.0 — Regulation (EU) 2024/1183** of 11 April 2024 amends Regulation (EU) No 910/2014 and **entered into force on 20 May 2024** [4]. It mandates that **every Member State provide at least one EU Digital Identity (EUDI) Wallet** to citizens, residents and businesses **by the end of 2026**, to common specifications [4][8]. Trust rests on the **eIDAS trust framework of qualified trust service providers** offering qualified electronic signatures [8]. Technical interoperability is defined by the **Architecture and Reference Framework (ARF)**.

**India's Aadhaar** is a **12-digit random number** issued by the **UIDAI** (sole statutory authority) to residents under the **Aadhaar (Targeted Delivery of Financial and Other Subsidies, Benefits and Services) Act, 2016**. Enrolment is voluntary and captures demographic plus **biometric data (fingerprint, iris, facial photo)**, with biometric de-duplication in the **Central Identities Data Repository (CIDR)** [6]. It is the world's largest biometric ID system: **~1,444,690,723 Aadhaar generated (~1.34 billion live holders)**, with over **175 billion authentications** and **24 billion e-KYC** performed [6]. The **Supreme Court's 2018 Puttaswamy judgment (26 Sep 2018)** read down **Section 57**, which had permitted Aadhaar use "for any purpose" by any body corporate/person, striking down mandatory private-sector use absent backing by law.

**Estonia e-Residency**, launched **December 2014**, is a government-issued smart card / digital ID built on Estonia's **X-Road** data-exchange platform and **PKI**. It is **distinct from the Estonian citizen e-ID** and confers a transnational digital identity (not citizenship or residence). The programme **helps over 140,000 people** and their businesses (the **100,000th e-Residency ID card was issued in the week of February 2023** by the Estonian Police and Border Guard Board), with e-residents from **176+ countries** [9]. Each card carries an 11-digit personal identification code and two certificates (authentication and signing), with security codes **PIN1 (authentication), PIN2 (signing), and PUK (reset)** issued in a sealed envelope [9].

---

## 2. Privacy mechanisms

- **DIDs/VCs** offer the strongest privacy primitives: **selective disclosure** (reveal only the requested attribute, e.g. "over 18" not full birthdate) and **zero-knowledge proofs via BBS+ signatures**, plus the absence of any central registry that could correlate use [1][2].
- **WebAuthn** prevents cross-site tracking structurally: a **distinct key pair is generated per Relying Party**, so the same user's credentials at two sites are cryptographically unlinkable, and the user agent mediates authenticator access to preserve privacy [3].
- **eIDAS/EUDI** is **legally required to support selective disclosure and unlinkability** [5]. However, academic work warns these guarantees are fragile in practice: an ETH Zurich study finds users tend to **overshare** and verifiers tend to request more than needed (**over-identification**) [5], and a cryptographic analysis shows the wallet's reliance on **batch-issued credentials is vulnerable to subversion attacks** that can trace users despite the unlinkability mandate [5].
- **Aadhaar** is the weakest: a **centralized biometric database** that becomes a single linkage point across services. The 2018 Puttaswamy ruling's reading-down of Section 57 was itself a privacy-protective limit on how widely the identifier could be demanded [6].

## 3. Surveillance resistance

The spectrum runs from decentralized to centralized:
- **DIDs/VCs** — no central registry exists to subpoena or breach; the controller holds the keys [1].
- **WebAuthn** — no shared secrets and no central identity provider; per-RP keys leave no cross-site trail [3].
- **Estonia / X-Road** — federated rather than centralized: data stays in distributed registries and is exchanged peer-to-peer with logging, reducing (though not eliminating) a single watchpoint.
- **eIDAS/EUDI** — contested. Two distinct surveillance concerns are documented: the **Article 45 / QWAC controversy**, where mandating browsers trust EU-designated Qualified Website Authentication Certificates drew formal objections from Mozilla, the Internet Society and OpenSSF (2023) as undermining the browser CA security model and enabling potential interception [8]; and the **over-identification** risk above [5].
- **Aadhaar** — the archetypal **centralized biometric honeypot**: ~1.34 billion records in one repository with online authentication logging every transaction [6].

## 4. Recovery mechanisms for lost credentials

| Standard | Recovery path |
|---|---|
| DIDs/VCs | **Key rotation / DID controller update** in the DID document, plus social-recovery schemes; no central helpdesk, so recovery is the user's responsibility and a known usability weakness [1] |
| FIDO/WebAuthn | **Passkey cloud sync** across a user's devices and multi-device registration; losing one device does not lose the credential if synced [3] |
| Aadhaar | **UIDAI re-issue** and **biometric re-authentication**; the number itself is permanent and recoverable against the central DB [6] |
| eIDAS/EUDI | **State re-issuance** plus wallet recovery provisions under the common specifications [4] |
| Estonia e-Residency | **PUK code resets PIN1/PIN2**; a lost card requires in-person re-collection of a replacement [9] |

Government-anchored systems recover best (a state can always re-issue); pure self-sovereign DIDs recover worst (no fallback authority).

## 5. Interoperability

- **DIDs/VCs are the most fragmented.** Competing **DID methods** — `did:web` (web/TLS infrastructure), `did:key` (ledger-independent key pairs), `did:ion` (Microsoft's Sidetree on Bitcoin), `did:ebsi` (European Blockchain Services Infrastructure) — and competing credential formats (**JSON-LD with BBS+ vs JWT/SD-JWT**) mean a VC issued to one wallet may not be usable in another [7].
- **eIDAS/EUDI** standardizes deliberately through the **ARF**, converging on **ISO/IEC 18013-5 (mobile driving licence, mDL)** and **SD-JWT VC** with OID4VC/OID4VP protocols — strong interoperability within the EU, but bounded to it [7].
- **FIDO/WebAuthn** has the cleanest interoperability: a **single cross-platform Alliance certification program** for conformance and interoperability across browsers, OSes and authenticators [3].
- **Aadhaar** is **India-only** and does not interoperate across borders [6].

## 6. Cryptographic basis

- **WebAuthn**: public-key, COSE algorithms **ES256 (P-256), RS256, and EdDSA (Ed25519)** [3].
- **VCs**: **JSON-LD or JWT proofs**, with **BBS+** (`bbs-2023`) for selective-disclosure ZKP [2].
- **eIDAS**: **qualified electronic signatures** from qualified trust service providers [8].
- **Aadhaar**: authentication PID block encrypted with **AES-256** session keys wrapped under UIDAI's **2048-bit RSA** public key; factors include biometric (fingerprint/iris/face), OTP, and demographic data [6].

---

## 7. Use-case fit

**Banking (KYC/AML, SCA).** For EU regulated banking, **eIDAS qualified signatures** carry the clearest legal weight for KYC/AML onboarding and PSD2 Strong Customer Authentication, and the EUDI Wallet is explicitly designed for opening bank accounts [8]. **Aadhaar e-KYC** is the dominant rail for Indian bank onboarding (24+ billion e-KYC operations), though the 2018 Puttaswamy judgment **struck down mandatory private-company contractual use of Aadhaar** — banks and other body corporates cannot compel it absent a purpose backed by law [6]. **FIDO/passkeys** are best for the **login/authentication** step of banking rather than identity proofing — phishing-resistant SCA, not KYC [3]. Verdict: government qualified ID for proofing, FIDO for the recurring authentication.

**Healthcare (portable patient/immunization credentials).** **Verifiable Credentials are the best fit**: they are already the model behind the **EU Digital COVID Certificate (EU DCC)**, the **WHO SMART Trust / Global Digital Health Certification Network** (which took over the HCERT spec from the EU on 1 Jan 2024), and the **DIVOC** verifiable-credential logical model in WHO's Digital Documentation of COVID-19 Certificates (DDCC, FHIR R4-based) [7]. Selective disclosure and holder-controlled presentation directly serve medical-data minimization and consent management, while the issuer/holder/verifier triangle enables cross-border verification of immunization status [2].

**Humanitarian aid for stateless populations.** This is the decisive divergence. **Aadhaar and eIDAS both require a functioning state to issue identity** — useless for someone a state will not recognize. **DIDs/VCs need no state issuer** and can work offline, making them structurally suited to stateless and displaced people. In the field today, **UNHCR's PRIMES** (Population Registration and Identity Management EcoSystem) with its **Biometric Identity Management System (BIMS** — fingerprint, iris and facial photo) registers the displaced, and the **PRIMES Interoperability Gateway (PING)** lets UNHCR hand verifiable identity to host governments (for example, an Eritrean refugee receiving a digital ID card in Ethiopia via a UNHCR–government data transfer). The **World Bank ID4D** Ten Principles on Identification for Sustainable Development (endorsed by 25+ organizations as of 2019, supporting SDG Target 16.9, "legal identity for all"), together with the **ID2020** initiative, frame the goal of inclusive ID for those outside any national registry. **mDL (ISO 18013-5)** verification can occur offline [7]; **Aadhaar authentication is primarily online-dependent** on the CIDR (though UIDAI offers a limited "Aadhaar Paperless Offline e-KYC" mode), a poor fit for low-connectivity humanitarian settings [6].

---

## 8. Offline / connectivity dependence

- **mDL / ISO 18013-5** supports **offline verification** (device-to-verifier proof without a network call), and VCs/passkeys can be verified against cached issuer keys — important for field and low-connectivity use [7][3].
- **Aadhaar authentication is primarily online**, requiring a live call to the central CIDR for biometric/OTP verification, with only a limited "Aadhaar Paperless Offline e-KYC" mode available [6].
- **Estonia e-Residency** requires a card reader and online connection to X-Road services [9].

## 9. Complementarity, not competition

The standards layer cleanly:
- **Issuance / trust anchor**: government schemes (eIDAS/EUDI, Aadhaar, Estonia) or humanitarian issuers (UNHCR) vouch for real-world identity.
- **Credential carriage**: that attestation is expressed as a **W3C Verifiable Credential**, addressed by a **DID**, stored in a wallet — portable and selectively disclosable [1][2].
- **Authentication / unlocking**: **FIDO2/WebAuthn passkeys** authenticate the holder to the wallet and to relying parties without shared secrets [3].

The EUDI Wallet is itself a concrete instance of this stack — a government issuer, VC-style attestations (SD-JWT/mDL), and FIDO-grade device authentication combined [8][7].

## 10. Choose-when conditions

- **Choose decentralized DIDs/VCs** when credentials must be **portable across jurisdictions, state-independent, or privacy-maximizing** — cross-border healthcare, stateless populations, or any context where no trusted central registry should exist. Accept weaker recovery and fragmented interoperability as the cost [1][7].
- **Choose FIDO/WebAuthn** whenever the problem is **authentication at scale** — phishing-resistant login, account access, SCA — regardless of how identity was proofed; it complements rather than replaces a credential system [3].
- **Choose a government ID scheme** when **legal/regulatory acceptance and a state trust anchor are mandatory** and the user is within that jurisdiction: **eIDAS/EUDI** for EU regulated banking, public services and qualified signatures [8]; **Aadhaar** for Indian domestic subsidy delivery and e-KYC, subject to the Puttaswamy limits [6]; **Estonia e-Residency** for non-residents needing access to EU/Estonian e-government and business services [9].

- EUDI privacy critiques (academic): arxiv 2606.06354 "Credential Disclosure in EU Digital Identity Wallets: Privacy Risks" — users likely to overshare; websites request more data than needed (over-identification risk). IACR eprint 2026/1229 "Invisible Traces: Subversion Attacks on Batch-Issued Credentials" — EUDI regulation mandates selective disclosure and unlinkability, but the wallet being developed relies on batch issuance which is vulnerable to subversion attacks tracing users.

## Sources

1. [Decentralized Identifiers (DIDs) v1.0](https://www.w3.org/TR/did-core/)
2. [Verifiable Credentials Data Model v2.0](https://www.w3.org/TR/vc-data-model-2.0/)
3. [Web Authentication: An API for accessing Public Key Credentials - Level 2](https://www.w3.org/TR/webauthn-2/)
4. [European Digital Identity (EUDI) Regulation](https://digital-strategy.ec.europa.eu/en/policies/eudi-regulation)
5. [Credential Disclosure in (EU) Digital Identity Wallets: Privacy Risks and Practical Mitigations](https://arxiv.org/html/2606.06354v1)
6. [Unique Identification Authority of India - Unique Identification Authority of India | Government of India](https://uidai.gov.in/en/about-uidai/unique-identification-authority-of-india)
7. [Verifiable Credentials and Decentralised Identifiers: Technical Landscape](https://ref.gs1.org/docs/2025/VCs-and-DIDs-tech-landscape)
8. [EU Digital Identity Wallet Home - EU Digital Identity Wallet -](https://ec.europa.eu/digital-building-blocks/sites/spaces/EUDIGITALIDENTITYWALLET/pages/694487738/EU+Digital+Identity+Wallet+Home)
9. [About e-Residency | Digital Entrepreneur Solutions from Estonia](https://www.e-resident.gov.ee/about-us/)