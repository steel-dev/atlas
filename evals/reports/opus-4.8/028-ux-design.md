# Trust-Building Mechanisms for Gig Platforms in Argentina, Colombia, and Brazil

## Executive summary

The three markets share a structural condition — large informal workforces and historically low trust in formal institutions — but differ sharply in the infrastructure available to build trust online. Brazil offers the deepest, state-owned digital-payment rail (PIX) and the most formalized workforce; Colombia has the highest informality and a wallet-led, partially-banked population; Argentina's behavior is dominated by chronic inflation, which pushes users into wallets but makes holding value (and therefore escrow) risky. Because instant, irreversible rails (PIX, Mercado Pago) are now ubiquitous, the classic card-float escrow model is largely obsolete; escrow must instead be a ledger hold inside the platform/wallet. And because roughly half the regional workforce has no formal income paper trail, heavy identity verification trades directly against onboarding of exactly the informal users a gig platform needs to acquire [1].

## 1. Informal economy participation

Ranked from most to least informal, the three markets diverge by roughly 20 points:

| Market | Informal share of employment | Year / source |
|---|---|---|
| Colombia | 56.14% of total employment (down from 56.51% in 2023, 63.24% in 2021) | 2024, DANE [2] |
| Argentina | 42.0% informal employment rate (57.8% formal); ~45.7% when independent/own-account workers are fully counted | Q4 2024, INDEC |
| Brazil | ~35.6% (2025); 36.5% (2024); peaked ~42.7% in 2011 | 2024–25, ILO/Statista |

Regionally, the ILO estimate cited across the KYC literature is that roughly 55% of the LatAm workforce is informal, meaning source-of-funds frequently has no clean paper trail — "a user earning honest money as a street vendor … has no payslip, no tax return, no bank statement" [1]. This is the central design constraint for both verification and escrow.

## 2. Identity verification requirements per market

Each country has its own non-interoperable national ID — "no cross-border registry, no federated identity layer, no equivalent to eIDAS," so a user moving between countries "starts from zero" [1]:

- **Brazil — CPF.** 11-digit number with a checksum, held by essentially every adult; KYC under BCB Resolution 519/2025 requires CPF verification against Receita Federal, mandatory liveness selfie for tier-1 accounts, document OCR (RG/CNH) and biometric match. A Travel Rule applies above R$30,000, and 2024 PIX hardening capped transactions on unregistered devices at R$200. Suspicious-activity reports go to COAF within 24h (urgent) or 60 days (standard) [1].
- **Argentina — DNI.** 8-digit, no checksum, validated against RENAPER with liveness + OCR. Regulators are the UIF (AML) and the CNV, which registers VASPs under Resolution 1058/2025. Foreign-remittance reporting is monthly and capital-controls-driven; inflation forces quarterly retuning of any peso transaction threshold [1].
- **Colombia — Cédula de Ciudadanía.** 8–10 digits, no checksum, validated via the Registraduría Nacional; the new digital cédula carries a chip enabling optional NFC reads. Controls include cédula validation, liveness+OCR, PEP screening against UIAF lists, and risk-scored enhanced due diligence. Identity theft has grown 400% since 2020, and Law 2502/2025 makes AI-enabled identity theft an aggravating offense — the first LatAm law explicitly targeting synthetic identity fraud [1].

The regional KYC guidance is explicit about the friction trade-off: build **tiered onboarding** — "basic identity verification in seconds" for low-risk users, with enhanced due diligence "triggered by risk score, not rule." Legacy 3–7 day batch KYC "is not survivable against PIX-speed payments," and "if every user goes through the maximum-friction flow, conversion collapses" [1].

## 3. Payment and escrow infrastructure per market

| Market | Dominant rail(s) | Settlement / cost | Escrow implication |
|---|---|---|---|
| Brazil | PIX (state-owned, free), 180M+ users, 42% of e-commerce (proj. 51% by 2027) | Instant, irreversible; PIX ~0.33% vs cards 2–5% | Float-based card escrow obsolete; hold must be a ledger entry inside platform/wallet [3] |
| Colombia | PSE bank-redirect (~32% online); wallets Nequi, Daviplata; alt-methods ~50% of e-commerce | Bank-redirect / wallet | Mixed; wallet-balance holds viable, but partial banking limits reach [3] |
| Argentina | Digital wallets = 46% of all payments (Mercado Pago, Ualá); MP had 61.2M active users Q4 2024 | Wallet, inflation-driven | Long ARS holds erode value; favor short windows or USD/stablecoin (Meli Dólar, 2025) [3] |

PIX launched in November 2020 with the Central Bank as sole operator and rule-setter, making it free; by end-2025 it processed ~80 billion transactions worth R$35.3 trillion (~$6.7T), +34% YoY, with 180M+ registered users — "virtually the entire economically active population" [3]. For micro-entrepreneurs and informal businesses, PIX "replaced the cash register, the bank transfer, and the invoicing system all at once" [3]. Argentina's wallet dominance is explicitly inflation-driven: consumers avoid holding money in traditional accounts and use Mercado Pago/Ualá, which pay interest and offer daily liquidity [3]. Colombia's Nequi and Daviplata are "the first banking product for millions of previously unbanked Colombians" [3].

## 4. Rating systems used by regional platforms

- **Mercado Libre (marketplace seller reputation).** Color-coded (gray = insufficient data → green = best), computed over the trailing ~3 months (or full history if under 40 orders) on three metrics: delayed shipments (dispatch within 48 working hours), complaints/quality-of-attention (≤2% for green), and cancellations (≤3% for green). New sellers start gray; first color is assigned after 10 fulfilled orders, and reputation is maintained separately per country marketplace [4]. This is a transaction-outcome model — it rewards delivery reliability rather than identity, which suits a population whose formal credentials are thin.
- **Workana (regional freelancing).** A ranking score weighted toward the most recent 6 months of payments and qualifications ("after six months your income will barely affect your position"); mediations are tracked separately and penalize the freelancer; profile levels are gated by total and recent net income, satisfied-client counts, score, and recent breaches . Workana also operates an explicit escrow: the client pays the full amount upfront and "Workana will hold the funds in escrow until the project is completed," with release at the client's discretion, funded via card, PayPal, Mercado Pago, or Payoneer depending on country.
- **Rappi (delivery super-app).** Resolution is report-driven rather than peer-rating-driven for disputes (see §5).

The common effectiveness lever across these systems is *recency-weighting and outcome metrics* (delivery, complaints, cancellations), which lets a reputation be earned quickly without formal documentation.

## 5. Dispute resolution interfaces and consumer protection

- **Mercado Libre "Compra Protegida"** functions as platform-held buyer protection that behaves like escrow over the transaction window: if the product is not received, the buyer is covered (28 days from purchase in Argentina), and if the buyer regrets the purchase or the item has a problem, coverage runs up to 30 days from receipt, with refunds to the original payment method.
- **Rappi** routes issues through the in-app *Centro de Ayuda* for three defined cases (missing, damaged, or wrong product); support reviews the case and, if compensation is approved, the user chooses Rappi credits or a partial/full refund to the original payment method. In Colombia the statutory *derecho de retracto* (right of withdrawal) is honored, with goods returned to the commercial ally in original condition.
- **Workana** distinguishes *mediations* from *disputes*, escalating held escrow funds when client and freelancer disagree.

These flows sit atop divergent consumer-protection and data regimes:

| Market | Consumer protection | Data protection |
|---|---|---|
| Brazil | Consumer Defense Code (CDC, Law 8,078/1990): strict (no-fault) supplier liability, reverse burden of proof, 7-day online right of withdrawal; enforced via Procon and small-claims courts; Decree 7,962/2013 governs e-commerce | LGPD (Lei 13.709/2018), regulator ANPD, GDPR-style |
| Argentina | Consumer-protection framework with right of withdrawal | Ley 25.326 (2000), EU-adequacy status |
| Colombia | Statutory *derecho de retracto* honored on platforms | Ley 1581/2012 (Habeas Data), regulator SIC |

Brazil's CDC is the most protective for buyers (no-fault liability and reversed burden of proof), which lowers the trust burden a platform must carry itself; in the other markets more of the assurance must be engineered into the product. All three regimes impose consent and security obligations on platforms storing ID and biometric KYC data.

## 6. Financial inclusion and smartphone penetration

| Market | 2023 smartphone adoption (GSMA) | Notes |
|---|---|---|
| Brazil | 88% (proj. 95% by 2030) | Highest of the three [5] |
| Argentina | 76% (proj. 91%) | Subscriber penetration 79% [5] |
| Colombia | 76% (proj. 97%) | Fastest projected growth [5] |

Regionally, GSMA reports 418m mobile-internet users at 65% penetration in 2023, with smartphones at ~80% of connections (rising to 92% by 2030) [5]; Mastercard separately found 418 million LatAm mobile-internet users (65% of population) by end-2023, with over 80% regular internet access in Brazil, Argentina, Chile and Mexico. Account-based financial inclusion lags device access — wallets (Nequi, Daviplata, Mercado Pago) are explicitly described as the "first financial product many people ever hold," with 30–50% of adults lacking any banking product only a few years ago [3].

## 7. User trust attitudes

The strongest quantitative evidence is the MDPI study of the 2023 Latinobarómetro survey (19,205 individuals, 17 LAC countries, logit models): **trust in financial institutions raises the likelihood of digital-payment adoption by 62%**, with a stronger effect among higher-income individuals; younger age, more education, and mobile-phone ownership also correlate positively [6]. Trust in formal financial institutions across LAC is characterized as *low*, eroded by repeated crises — the study names Argentina's 2001 deposit freeze (*corralito*) and Ecuador 2000 — alongside high inequality, widespread informality, fiscal imbalance, low formal financial access, high cash use, and rising fraud [6]. Country-specific work cited (Bailey et al. 2022; Arango-Arango et al. 2017) finds trust in the payment system and in banks both drive adoption in Colombia, and that trust is a binding *limitation* there [6]. Png & Tan (2020): a one-standard-deviation rise in bank trust is associated with a 15.2% reduction in cash use [6].

## 8. Cross-market analysis

### 8.1 Instant-payment ubiquity reshapes escrow trade-offs

Traditional escrow exploited the settlement float between card authorization and capture. PIX and Mercado Pago eliminate that float — PIX is instant and irreversible, settling in seconds versus 1–3 business days for cards/Boleto, at ~0.33% versus 2–5% [3]. The consequence for design:

- **Brazil:** escrow cannot rely on a card hold; it must be a *ledger hold* inside the platform or wallet balance, with explicit release/refund logic, because the money has already moved irreversibly. Brazil's deep Open Finance layer (60M consents, 100B API calls/month) supports richer balance-and-history verification to substitute for that lost reversibility [3].
- **Argentina:** the same wallet-ledger approach works, but inflation makes *holding* value the problem — long ARS escrow erodes principal, so holds should be short or denominated in USD/stablecoin (Meli Dólar) [3].
- **Colombia/cash-on-delivery contexts:** where PSE redirects and partial banking persist and a meaningful share still expects cash settlement, escrow loses its grip entirely on the cash leg; here trust must lean harder on platform guarantee (Compra-Protegida-style coverage) and report-driven refunds rather than on holding funds [3].

### 8.2 Informal-economy experience and reputation-vs-verification priors

A workforce that has operated for decades on informal, relationship-based trust — without payslips, contracts, or formal credit histories — is primed to read *reputation* (delivery track record, peer ratings) as legitimate and to read *formal verification* as either irrelevant or exclusionary. Because ~55% of the regional workforce cannot produce the documents a strict KYC flow demands, treating "no formal income" as "suspicious" excludes half the continent [1]. This produces a **substitution effect**: outcome-based reputation (Mercado Libre's complaint/cancellation metrics; Workana's recency-weighted score) does the trust work that formal credentials cannot, and is reachable quickly (Mercado Libre assigns a color after just 10 orders) [4]. At the same time, low institutional trust (§7) means *over*-reliance on formal verification can actively signal distrust to these users — a **distrust effect** — while the same low trust *raises* the value of a credible, platform-owned guarantee that does not depend on the user trusting a bank.

### 8.3 Tension: fraud control vs. onboarding friction

Heavy verification reduces fraud — and fraud is real and rising: PIX fraud grew 43% YoY to R$2.7 billion in 2024 (Febraban), and Colombian identity theft is up 400% since 2020 [1]. But maximum-friction onboarding "collapses" conversion, and batch KYC cannot keep pace with instant rails [1]. The resolution endorsed by the sources is **tiered, risk-scored onboarding**: seconds-fast basic verification for low-risk users, with enhanced due diligence triggered only by risk signals — letting underbanked informal users in at low limits while reserving heavy checks for high-value or anomalous activity [1].

### 8.4 Recommended trust-building combination per market

| | Brazil | Colombia | Argentina |
|---|---|---|---|
| **Identity** | CPF + liveness; lean tiered onboarding (every adult has a verifiable CPF, lower friction) | Cédula + liveness + strong synthetic-fraud defenses (Law 2502/2025); risk-scored EDD | DNI/RENAPER; thresholds re-tuned for inflation |
| **Payment/escrow** | PIX ledger-hold escrow; exploit Open Finance for history | Wallet-balance escrow (Nequi/Daviplata) + platform guarantee for cash/PSE legs | Short or USD/stablecoin escrow holds to resist peso erosion |
| **Reputation** | Outcome metrics (delivery, complaints, cancellations) — fast to earn | Heavy reliance on reputation given 56% informality | Recency-weighted reputation; reputation substitutes for thin formal credentials |
| **Dispute UI** | Lean on CDC (no-fault liability, 7-day withdrawal) + Compra-Protegida-style coverage | Report-driven refunds + statutory retracto; platform must carry more assurance | Platform-held guarantee, since institutional trust is lowest post-corralito |

**Synthesis:** Brazil can run the *lightest* identity friction and the *cleanest* ledger-escrow because of universal CPF, ubiquitous free instant payments, and the strongest consumer-protection backstop. Colombia, with the highest informality and a partially-banked, wallet-led base, should weight *reputation and platform guarantees* most heavily while hardening identity against a fast-growing synthetic-fraud threat. Argentina's distinctive constraint is monetary, not documentary: trust mechanics must survive inflation (short or dollarized escrow) and a population whose post-*corralito* distrust of banks makes a *platform-owned* guarantee — not a bank-dependent one — the credible anchor. Across all three, the consistent winning pattern is recency-weighted, outcome-based reputation paired with risk-tiered (not blanket) verification and an escrow implemented as a wallet/platform ledger hold rather than a card float.

## Sources

1. [KYC in Latin America: A Complete Country-by-Country Guide (2026)](https://blog.gu1.ai/en/kyc-latam-complete-guide/)
2. [Share of informal employment in Colombia 2024| Statista](https://www.statista.com/statistics/1039930/informal-employment-share-colombia/)
3. [LatAm Payment Systems Compared: Who Is Winning the Race for the Latin American Wallet in 2026? - PaySpace Magazine](https://payspacemagazine.com/articles/latam-payment-systems-compared-who-is-winning-the-race-for-the-latin-american-wallet-in-2026/)
4. [Mercado Libre](https://global-selling.mercadolibre.com/learning-center/news/seller-reputation-learn-how-it-works)
5. [The-Mobile-Economy-Latin-America-2024.pdf](https://www.gsma.com/solutions-and-impact/connectivity-for-good/mobile-economy/wp-content/uploads/2024/06/The-Mobile-Economy-Latin-America-2024.pdf)
6. [Digital Payments Trust in Latin America and the Caribbean](https://www.mdpi.com/2227-7099/13/5/140)