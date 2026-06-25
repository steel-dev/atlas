# Trust-building mechanisms for gig-platform expansion in Argentina, Colombia, and Brazil

## Executive summary

Trust design in these three markets should not be copied market-by-market. The same four mechanisms—ratings, identity verification, escrow/payment protection, and dispute resolution—need different weight because labor informality, payment rails, and platform precedents create different baseline expectations.

**Recommended weighting by market**

| Market | Baseline condition | Highest-weight trust mechanisms | Why |
|---|---:|---|---|
| **Colombia** | Informal employment remains the highest of the three: **55.1%** nationally in Feb–Apr 2026; rural/dispersed areas reached **83.0%** [1]. | **Dispute interfaces + payment protection + low-friction identity** | Users are familiar with mobile-number wallets and bank debit rails, but high informality means many providers and customers may be newly formalized on-platform. Colombian law also makes traceable e-commerce PQR channels, radicado numbers, follow-up, and payment-reversal procedures especially salient [2][3]. |
| **Argentina** | INDEC’s Q4 2025 urban EPH showed **43.0%** labor informality among employed persons and **36.3%** of salaried workers without pension deductions [4]. | **Payment protection/escrow + recognizable reputation cues** | Mercado Libre/Mercado Pago has trained users to expect protected checkout, seller reputation, claims, and platform intervention. Instant wallet/bank transfers are widespread, but off-platform QR/transfers are excluded from Mercado Libre protection, so a new platform must clearly distinguish protected in-app payment from direct transfer [5][6][7]. |
| **Brazil** | Official IBGE PNAD Contínua snippets show **39.0%** annual average informality in 2024, with Q4 2024 around **38.6%**; direct IBGE page fetches were blocked, so this figure should be refreshed before launch. | **Verified identity + Pix-aware payment protection + public-status disputes** | Pix is ubiquitous, instant, final, and low-value retail-heavy; this builds payment confidence but also raises expectation of immediate settlement and skepticism if a platform “holds” money without clear rules [8]. Brazil also has strong consumer-protection precedents: CDC withdrawal rights, e-commerce response duties, Procon, and consumidor.gov.br status/evaluation workflows [9][10][11]. |

Across all three, users’ prior experiences with incumbents create **trust transfer** when a new platform reuses familiar cues—stars, protected payment labels, wallet/bank identities, order histories, claim status, refund paths—but also **skepticism** when a cue is used without the protection users associate with it. A “verified” badge without visible DNI/cédula/CPF-linked onboarding, a “protected payment” label that still allows off-platform settlement, or a chat-only dispute flow without traceable case IDs can damage adoption rather than reduce friction.

---

## 1. Market context: informality and why trust must do extra work

The platform will be onboarding users whose work and payment histories often sit partly outside formal contracts, formal payroll, or card-based commerce. That makes platform trust mechanisms not merely “UX polish” but substitutes for missing institutional trust.

| Country | Latest sourced informality measure | Scope/date | Design implication |
|---|---:|---|---|
| **Argentina** | **43.0%** of employed persons informal; **36.3%** of salaried workers had no retirement/pension deduction | INDEC EPH, Q4 2025, 31 urban agglomerates; published 2026-03-18 [4] | Do not assume providers can rely on formal employer records. Use identity + transaction history + protected payments as the trust stack. |
| **Colombia** | **55.1%** of employed persons informal nationally; **41.2%** in 13 metro areas; **42.4%** in 23 cities; **83.0%** in rural/dispersed areas | DANE, Feb–Apr 2026 mobile quarter; page updated 2026-06-12  | Highest need for low-friction onboarding and robust dispute/payment protection, especially outside large cities. |
| **Brazil** | **39.0%** annual average informality in 2024; Q4 2024 snippet around **38.6%** | IBGE PNAD Contínua 2024 snippets; official page fetch blocked | Brazil has the lowest informality among the three, but still large enough that platform trust must combine identity, ratings, and payment guarantees. Refresh official IBGE figure before launch. |

**Analytical takeaway:** Colombia needs the most “institutional replacement” in the interface: clear case numbers, evidence upload, payment reversal, and human escalation. Argentina needs strongest continuity with Mercado Libre/Mercado Pago mental models. Brazil needs Pix-native clarity: instant payment does not equal immediate release to the counterparty if platform protection applies.

---

## 2. Identity verification and KYC/AML: required local trust anchors

Identity verification should be designed as a **trust cue** and a **compliance gate**, but not as a single heavy front door for every user. In informal markets, over-strict onboarding can suppress supply; under-strict onboarding increases fraud, account takeover, and dispute cost.

| Country | Regulator/legal framework | Required identity anchors | UX design implications |
|---|---|---|---|
| **Argentina** | UIF Resolution 49/2024 for virtual-asset service providers, sanctioned 2024-03-22 and published 2024-03-25, under Law 25.246 as amended by Law 27.739; CNV registry involvement for PSAVs. UIF Resolution 43/2024 uses similar DNI/CUIT/CUIL/CDI identification fields for other obliged entities [12][13]. | Individuals: valid **DNI** or foreign ID/passport, nationality, birth data, **CUIL/CUIT/CDI** where applicable, address, phone/email, principal activity. Customer-base reports include name, national ID, CUIT/CUIL, nationality, PEP status [12]. | Use DNI + CUIL/CUIT validation for payout/account limits. Separate “basic verified” from “payout/tax verified” so informal workers can browse or quote before full formalization. Cash or wallet top-ups above thresholds require stronger checks. |
| **Colombia** | UIAF AML framework; SARLAFT for financial and broader obliged sectors, SAGRILAFT for real-sector companies; SuperSociedades lists 2024–2025 SAGRILAFT circular updates [14][15]. | Customer due diligence verifies identity with reliable documents/data: **cédula de ciudadanía**, NIT/RUT-type tax ID where applicable, passport; checks may use Registraduría, Contraloría, Datacrédito. Beneficial-owner identification and PEP screening are part of SARLAFT/SAGRILAFT [14]. | Use cédula-first onboarding for individuals; RUT/NIT for business providers. Because many users are mobile-wallet users rather than cardholders, pair ID with phone-number wallet verification and progressive limits. |
| **Brazil** | Banco Central Circular 3.978 of 2020-01-23, based on Law 9.613/1998 and Law 13.260/2016; payment-institution authority under Law 12.865/2013; COAF reporting [16]. | Individuals: full name, residential address, **CPF**; legal entities: **CNPJ**; foreign users: travel document or foreign registration if CPF/CNPJ not required [16]. | CPF verification is a high-recognition trust cue. For businesses and MEI-like providers, CNPJ badges can signal stronger accountability. Because Pix keys often map to CPF/CNPJ/phone/email, show the verified payout name before transaction confirmation. |

**Weighting:** identity should be **most visible in Brazil**, where CPF/CNPJ and Pix expectations are strong; **most progressive in Colombia**, where excluding informal workers would harm liquidity; and **tied to payout/protection in Argentina**, where DNI/CUIT-CUIL supports both compliance and Mercado Pago-style trust.

---

## 3. Payment rails and financial inclusion: what users already trust

Payment design must respect what users already use. The core decision is whether to support instant settlement only, platform-held funds only, or a hybrid. Evidence points to a hybrid: local instant rails for funding and payout, but platform-controlled release for protected jobs.

| Country | Dominant local rails and latest figures | Trust implication for escrow/protection |
|---|---|---|
| **Argentina** | BCRA’s Nov 2025 retail-payments report recorded **666.3m** immediate peso transfers worth **ARS 70.1tn**, up **20.3%** YoY in count; **73%** involved a CVU wallet at origin and/or destination. Interoperable QR transfer payments reached **76.9m** operations worth **ARS 1.6tn**, up **29.1%** YoY; **98.4%** were QR-initiated; payers split **52.6% CBU** bank accounts and **47.4% CVU** payment accounts. BCRA listed **84** interoperable digital wallets and **61** PCT acceptors [6]. | Users understand wallets and QR transfers, but Mercado Libre’s own protection excludes QR/off-platform payments and transfers [5]. A gig platform should fund escrow via Mercado Pago/CBU/CVU/QR but make clear that protection applies only inside the platform ledger. |
| **Colombia** | Transfiya passed **20m** users and processed **298m** immediate transfers in 2024, across 25 banks/cooperatives/wallets/SEDPEs, using only cellphone numbers. PSE operates as a 24/7 bank-account/electronic-deposit debit button with in-flow status and real-time merchant notices. DaviPlata reached **18.5m** customers by 4Q24, with **4.5m** using it as their only financial product; Nequi’s official page reported **>27m** users, while a Jan 2025 interview said Nequi closed 2024 with ~**22m** clients [17][18][19][20][21]. | Colombia is mobile-number and wallet-friendly. Escrow funding should support PSE and wallet rails, but refund/reversal UX must align with Colombian e-commerce rules: complaint to provider + issuer notification within 5 business days for payment reversal [2][3]. |
| **Brazil** | Pix/SPI is a BCB-operated RTGS instant-payment infrastructure where settled transactions are final and irrevocable. By Dec 2024 SPI had **40** mandatory and **823** optional participants; Dec 2024 saw **5.71bn** interbank Pix settlements, up **35.52%** vs Dec 2023; 2024 settled value was **BRL 22.12tn**. Average Dec 2024 Pix value was **BRL 407.90**, median below **BRL 39**, and 90% below **BRL 400**; record daily volume was **252.13m** transactions on 2024-12-20 [8]. | Pix is a powerful trust transfer mechanism for funding/payout, but finality means the platform—not the rail—must provide buyer protection, cancellation logic, and dispute credits. Avoid calling Pix payment “reversible”; call the platform balance/guarantee reversible where applicable. |

**Design conclusion:** instant rails should be used for **funding and payout speed**, not as a substitute for escrow. In all three markets, users will adopt faster if they can pay with familiar rails while seeing a familiar platform-held status: “funded,” “in progress,” “delivered,” “under review,” “released/refunded.”

---

## 4. Escrow, guarantees, and milestone payments: what is already accepted

Escrow-like models are operationally used in the region, but users encounter them under different labels: “Compra Protegida,” “Depósito en Garantía,” compensation/refund policies, or marketplace withholding until delivery.

| Platform/model | Countries relevant | Mechanism | Trust lesson |
|---|---|---|---|
| **Mercado Libre / Mercado Pago Compra Protegida** | Argentina and broader Mercado Libre markets | Buyer money is protected if product does not arrive within 28 days from purchase, or if the buyer regrets/product has a problem within applicable post-receipt windows. Flow: start claim → seller notified → seller tries to resolve → Mercado Libre Compra Protegida team intervenes and can refund. Excludes QR/off-platform payments and money transfers [5]. | Users understand platform protection if payment stays inside the platform. This is the strongest adoption cue in Argentina and a useful cue in Colombia/Brazil where Mercado Libre also operates. |
| **Workana fixed-price escrow** | Regional freelance model across LATAM, including target markets | Client accepts proposal and deposits the total fixed-price project value in Workana. Workana holds funds until requirements are met; client reviews work and releases payment. Parties may agree partial milestone releases. If parties cannot agree, Workana arbitrates; only in-platform communications count as evidence; if the freelancer met initial specs, Workana releases payment to the professional [22]. | For skilled services, milestone escrow is legally/operationally familiar and should be offered for higher-value tasks, not forced for every small gig. Evidence capture must remain in-app. |
| **Rappi compensation/refund workflow** | Colombia/Brazil/Argentina analogues | Customers report missing, bad-condition, or different products through the in-app Help Center; support evaluates and may compensate/refund via RappiCréditos or the original payment method; evidence such as photos/video/order support may be requested [23]. | Delivery users expect fast, order-linked support, not a legalistic escrow explanation. For low-value delivery-like gigs, use instant provisional credits/refunds with post-review risk controls. |

**Country weighting:**
- **Argentina:** make escrow/payment protection the lead mechanism. Users already distinguish protected Mercado Libre checkout from unprotected direct transfers.
- **Colombia:** combine escrow with strong dispute traceability because users may rely on PSE/wallet reversals and SIC-style PQR expectations.
- **Brazil:** explain escrow as “platform guarantee” layered on Pix finality. Pix itself does not reverse after settlement; the platform promise must be explicit.

---

## 5. Rating and reputation mechanisms users already know

Ratings work best when they combine simple public cues with hidden abuse controls. In high-informality markets, star ratings alone are not enough because new workers lack history; however, incumbent platforms show which cues users recognize.

| Platform | Mechanism | Relevance to new gig platform |
|---|---|---|
| **Mercado Libre** | Seller reputation is explicitly intended to generate trust. It uses color thermometer level, Mercado Líder medal status (Silver/Gold/Platinum), transaction history, positive/neutral/negative ratings ratio, buyer-claim rate, delayed handling-time rate, and seller cancellation rate. Periods are typically 60 or 365 days depending on volume/country; fraudulent, invalid, and rejected-payment transactions are excluded [7]. | Use transaction-weighted reputation, not raw average stars. Show cancellations, on-time completion, dispute rate, and completed jobs. Badges should be earned and explainable. |
| **Uber** | Bilateral 1–5 star ratings after each trip; rider rating is an average of the last 500 trips. Drivers and riders provide feedback; repeated low ratings can lead to warnings, improvement opportunities, and deactivation. Drivers may dispute feedback; Uber excludes ratings outside driver control [24][25]. | Bilateral ratings are familiar for transport/service interactions, but protect workers from retaliatory or irrelevant ratings. Show recent reliability separately from lifetime average. |
| **Rappi** | Merchant-side courier reporting can happen from order history or an active order; merchants can rate couriers positively/negatively, and Rappi follows up for the reason when rating is negative [26]. | For three-sided marketplaces, ratings need issue categories and incident reporting, not just stars. Merchant/customer abuse should be reportable with evidence. |
| **GetNinjas** | Brazilian services marketplace guidance says client evaluations help future clients choose professionals with more confidence and influence decisions before hiring [27]. | In home/local services, text reviews and portfolio/history cues matter. Pair reviews with identity and job completion counts. |

**Recommended rating architecture**

1. **Public simple cue:** stars or score band plus “verified identity.”
2. **Transaction-weighted detail:** completed jobs, cancellations, response time, on-time delivery, dispute rate.
3. **Contextual badges:** “DNI/CUIT verified,” “cédula/RUT verified,” “CPF/CNPJ verified,” “on-time pro,” “protected-payment eligible.”
4. **Bilateral but asymmetric protections:** customers and workers rate each other, but ratings tied to disputes, force majeure, abusive behavior, or platform-caused delays should be suppressible or appealable.
5. **Cold-start bridge:** for new informal providers, use verified identity, training completion, small-job probation, and escrow eligibility before enough ratings accumulate.

---

## 6. Dispute-resolution obligations and effective interface patterns

The clearest cross-market lesson is that disputes must be **case-based, traceable, evidence-friendly, and locally compliant**. Chat alone is insufficient unless it creates a case record.

### Legal/procedural baseline

| Country | Consumer/dispute framework | Required or expected procedural features |
|---|---|---|
| **Argentina** | COPREC under Law 26.993 and Consumer Defense Law 24.240 handles individual consumer conflicts up to 55 SMVM and is prior/mandatory before consumer audit/court actions. Consumers file via approved forms and may use electronic channels; conciliation lasts up to 30 business days, extendable by 15. Provider no-show can trigger a 1 SMVM fine, with up to one-third for the consumer [28]. | Platform should provide downloadable case records, claim history, seller/provider notices, and resolution outcome documents that can support COPREC escalation. |
| **Colombia** | Law 1480/2011, enforced by SIC. Article 50, as amended by Law 2439/2024, requires easy-access e-commerce attention channels, traceability, radicado number, date/time, and follow-up. Article 58 requires provider response within 15 business days with evidence. Article 51 and Decree 587/2016 enable payment reversal for e-commerce fraud, unauthorized transactions, nonreceipt, wrong item, or defect; consumer must complain to provider and notify issuer within 5 business days; payment participants have 15 business days to execute reversal [2][3]. | Colombia needs the most formal ticketing UX: radicado/case number, timestamps, evidence upload, response deadline, status tracking, and reversal instructions. |
| **Brazil** | CDC Law 8.078/1990 gives a 7-day right of withdrawal for distance contracts and immediate refund. Decree 7.962/2013 regulates e-commerce with clear information, facilitated service, payment/data security, supplier response within 5 days, same-tool withdrawal, immediate confirmation, and notice to financial/card institution to prevent charge or refund. Consumidor.gov.br lets consumers register complaints online/app, company responds, Senacon/Procons monitor, and consumer rates resolved/not resolved and satisfaction 1–5; companies have up to 10 days to respond and consumers up to 20 days to evaluate [9][29][10][11]. | Brazilian users will recognize public-status, response-deadline, and satisfaction-evaluation flows. Mirror consumidor.gov.br patterns inside the app and make Procon/consumidor.gov.br escalation easy. |

### Platform interface patterns that should be used

- **In-app Help entry from each order/job:** Rappi’s flow—Account → Orders → select order → Help—anchors the dispute to the transaction and reduces ambiguity [23].
- **Structured issue categories:** missing item, bad condition, different item, no-show, late delivery, unsafe behavior, nonpayment, scope change, abusive customer/provider.
- **Evidence upload:** photos, video, chat, delivery proof, GPS/check-in logs, files, milestone deliverables. Workana’s arbitration rule that only in-platform communications count as evidence makes this especially important for freelance/service gigs [22].
- **Status and SLA tracking:** Colombia requires traceability and follow-up; Brazil and Argentina users also benefit from visible stages.
- **Human escalation:** after seller/provider response or timeout, platform mediation should intervene, as Mercado Libre’s Compra Protegida does when seller resolution fails [5].
- **Refund/release controls:** distinguish refund to original method, wallet credit, platform credit, and escrow release. In Brazil, do not imply Pix rail reversal after final settlement; frame refunds as platform-funded or ledger-controlled where applicable [8].
- **Local-language support:** Spanish for Argentina/Colombia, Portuguese for Brazil, with locally familiar labels: reclamo/radicado/PQR in Colombia, COPREC-ready claim record in Argentina, Procon/consumidor.gov.br escalation language in Brazil.

---

## 7. Fraud, abuse, nonpayment, and skepticism: what prior trust experiences change

The gathered sources do not provide a single comparable fraud-rate dataset across Argentina, Colombia, and Brazil for gig platforms. What they do establish is the **risk environment that users experience through platform rules**:

- Mercado Libre excludes fraudulent, invalid, and rejected-payment transactions from seller reputation calculations, indicating that reputation systems must account for fraudulent activity rather than treat every failed transaction as normal performance [7].
- Mercado Libre’s Compra Protegida specifically excludes QR/off-platform payments and money transfers, a strong signal that off-platform settlement is a known protection gap [5].
- Colombian law explicitly provides reversal for fraud, unauthorized transactions, nonreceipt, wrong item, and defective products in electronic commerce [2][3].
- Brazil’s Pix rail is final and irrevocable once settled, so scams or wrong-recipient transfers cannot be solved by assuming the payment rail will reverse; the platform must design its own hold/release/refund layer [8].
- Rappi’s courier-reporting and compensation policies show operational concern with courier/customer/merchant incidents, missing items, product condition, and wrong orders [26][23].
- Uber’s ratings, deactivation review, safety toolkit, RideCheck, GPS tracking, phone anonymization, and verified profiles show that ride/service platforms combine reputation with safety and account controls [24][25].

**Implication for adoption:** users who have been trained by Mercado Libre, Rappi, Uber, and consumer-protection portals will ask: “Who holds the money? Who is verified? What happens if the other party disappears? Can I prove my side? How fast will I be refunded or paid?” A new platform that answers these questions visibly at the moment of hiring/payment will lower adoption friction; one that hides them in terms and conditions will inherit skepticism from prior scams, nonpayment, fake reviews, or off-platform transfer losses.

---

## 8. How prior trust-system experiences affect adoption

### Trust transfer that lowers friction

1. **Mercado Libre/Mercado Pago mental model, strongest in Argentina.** Users understand protected checkout, seller reputation, claims, and platform intervention. Reusing “protected payment,” “claim,” “seller/provider response,” and “platform mediation” patterns can accelerate adoption, provided protection boundaries are explicit [5][7].
2. **Pix in Brazil.** Pix makes instant funding and payout feel normal. It lowers payment friction, especially for low-value jobs, but only if the platform explains when funds are held and when released [8].
3. **Nequi/DaviPlata/Transfiya/PSE in Colombia.** Phone-number transfers and PSE bank debits reduce card-dependence. They support adoption among users who may not rely on credit cards but do use wallets or bank/electronic-deposit accounts [17][18][19][20][21].
4. **Uber/Rappi ratings.** Bilateral stars, courier reporting, and order-linked help are already familiar, so users will accept post-job rating and incident reporting as normal platform behavior [24][26][25][23].
5. **Government dispute portals.** Colombia’s radicado/PQR and Brazil’s consumidor.gov.br response/evaluation patterns make case numbers, timestamps, status, and satisfaction ratings credible trust cues [9][29][2].

### Inherited expectations that raise the bar

1. **Protected means protected.** In Argentina especially, if users see a Mercado Pago-like or Compra Protegida-like cue but discover that direct transfers, QR payments, or cash are not covered, trust will fall quickly [5].
2. **Instant payment means instant visibility.** Pix, Transferencias 3.0, Transfiya, Nequi, DaviPlata, and PSE condition users to expect real-time confirmation. If escrow introduces delay, the UI must show why: “funds received,” “held for job completion,” “eligible for release on acceptance,” not simply “pending” [8][6][17][18][19][20][21].
3. **Ratings can be distrusted if they look manipulable.** Mercado Libre’s reputation is transaction-weighted and excludes invalid/fraudulent transactions; Uber allows some review/dispute and excludes factors outside driver control [7][24][25]. A new platform using only average stars and text reviews may look weaker.
4. **Informal cash habits persist.** High informality means users may still prefer cash or direct transfer for price or tax reasons. The platform should allow discovery/quoting but reserve protection, insurance, and dispute mediation for in-app payment, making the trade-off explicit.

---

## 9. Country-specific product guidance

### Argentina: lead with protected payment and Mercado Libre-style reputation

**Recommended stack**
1. **Payment:** allow CBU/CVU/wallet funding and interoperable QR funding, but show “protected only if paid in-app.”
2. **Escrow:** default for services above a threshold; optional for small repeat jobs; milestone escrow for project work.
3. **Ratings:** Mercado Libre-style reputation panel: completed jobs, cancellations, claims, on-time completion, positive/neutral/negative feedback, plus verified DNI/CUIT-CUIL badge.
4. **Disputes:** claim flow modeled on Compra Protegida: open claim → provider response → evidence → mediation → refund/release. Exportable record for COPREC.

**Why:** Argentina’s wallet/transfer infrastructure is broad and Mercado Libre has established the strongest marketplace-protection precedent [5][6][7].

### Colombia: prioritize traceable disputes and mobile-wallet inclusion

**Recommended stack**
1. **Payment:** support PSE, Transfiya-compatible transfers where operationally possible, Nequi/DaviPlata-like wallet flows, and bank accounts.
2. **Identity:** cédula-first onboarding; RUT/NIT for business providers; progressive KYC tied to payout limits.
3. **Escrow:** use funded-but-held balances for first jobs, high-risk categories, or new providers; allow partial release/milestones for freelance work.
4. **Disputes:** strongest formal ticketing of the three: PQR/radicado number, timestamp, evidence upload, deadline, reversal instructions, human escalation.

**Why:** Colombia combines the highest informality, large wallet adoption, and the clearest statutory requirement for traceable e-commerce attention channels and payment-reversal workflows [2][3][30][18].

### Brazil: make Pix instant but platform protection explicit

**Recommended stack**
1. **Payment:** Pix funding and payout as default; card/wallet alternatives where needed.
2. **Escrow:** explain “Pix paid to platform guarantee” versus “released to provider.” Use clear stages because Pix settlement itself is final and irrevocable.
3. **Identity:** CPF for individuals; CNPJ for companies; display verified legal/payout name before confirmation.
4. **Disputes:** consumidor.gov.br-inspired flow: complaint opened, company/provider response deadline, mediation, resolved/not resolved, satisfaction rating, Procon/consumer escalation path.
5. **Ratings:** bilateral star ratings for transport/delivery-like jobs; text reviews and portfolio for home services; badges for CNPJ/CPF verification and completion history.

**Why:** Brazil’s Pix scale makes instant payment the adoption default, but consumer-law and Procon expectations require transparent complaint handling and refund/withdrawal support [8][9][10][11][16].

---

## 10. Final comparative ranking of mechanisms

| Mechanism | Argentina | Colombia | Brazil |
|---|---|---|---|
| **Escrow/payment protection** | **1st** — strongest trust transfer from Mercado Libre/Mercado Pago; must distinguish protected in-app payment from QR/direct transfer. | **2nd** — important, especially for new providers and high-risk jobs, but must integrate with PSE/wallet reversal expectations. | **2nd** — essential layer on top of Pix finality; explain hold/release clearly. |
| **Dispute interface** | **2nd** — claims and mediation should be COPREC-ready. | **1st** — legal PQR/radicado, evidence, response deadlines, and reversal workflow make this central. | **1st/2nd** — tied with identity/payment; consumidor.gov.br and Procon patterns make status transparency important. |
| **Identity verification** | **3rd** — DNI/CUIT-CUIL needed for payout and risk, but should be progressive. | **3rd** — cédula/RUT necessary, but heavy front-door KYC may exclude informal supply. | **1st/2nd** — CPF/CNPJ is a highly legible trust cue and supports Pix-name confidence. |
| **Ratings/reputation** | **2nd/3rd** — transaction-weighted reputation is familiar and powerful. | **4th alone; stronger when combined** — ratings help, but high informality and new-user cold start require identity/payment/disputes around them. | **3rd** — useful, especially Uber/99/GetNinjas analogues, but should be backed by CPF/CNPJ and dispute safeguards. |

**Bottom line:**
- In **Argentina**, win trust by looking and behaving like a protected marketplace: in-app funds, claim flow, transaction-weighted reputation.
- In **Colombia**, win trust by being procedurally reliable: wallet/PSE inclusion, radicado-style support, evidence, deadlines, and reversals.
- In **Brazil**, win trust by being Pix-native but not Pix-naïve: instant funding/payout, CPF/CNPJ verification, and an explicit platform guarantee/dispute layer.

A new gig platform should therefore launch with one common architecture—verified identity, protected in-app payment, bilateral/transaction-weighted reputation, and case-based disputes—but localize the emphasis and labels so each market recognizes the trust system from platforms and institutions it already uses.

## Sources

1. [DANE - Empleo informal y seguridad social](https://www.dane.gov.co/index.php/estadisticas-por-tema/mercado-laboral/empleo-informal-y-seguridad-social)
2. [Ley 1480 de 2011 - Gestor Normativo](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=44306)
3. [https://www.mincit.gov.co/ministerio/normograma-sig/procesos-de-apoyo/gestion-juridica/decretos/decreto-587-de-2016.aspx](https://www.mincit.gov.co/ministerio/normograma-sig/procesos-de-apoyo/gestion-juridica/decretos/decreto-587-de-2016.aspx)
4. [mercado_trabajo_eph_4trim25AF451E16DE.pdf](https://www.lt9.com.ar/wp-content/uploads/2026/03/mercado_trabajo_eph_4trim25AF451E16DE.pdf)
5. [Comprá sin límites, nosotros te cuidamos](https://www.mercadolibre.com.ar/compra-protegida)
6. [Informe mensual de pagos minoristas, noviembre de 2025 | BCRA](https://www.bcra.gob.ar/publicaciones/informe-mensual-de-pagos-minoristas-noviembre-de-2025/)
7. [Reputación de vendedores](https://developers.mercadolibre.com.ar/es_ar/como-empezar/reputacion-de-vendedores)
8. [SPI_2024.pdf](https://www.bcb.gov.br/content/financialstability/spi_annual_reports/SPI_2024.pdf)
9. [Consumidor](https://www.consumidor.gov.br/pages/conteudo/publico/1)
10. [L8078compilado](https://planalto.gov.br/ccivil_03/leis/l8078compilado.htm)
11. [Decreto n� 7962](https://planalto.gov.br/ccivil_03/_ato2011-2014/2013/decreto/d7962.htm)
12. [Argentina.gob.ar](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-49-2024-397597/texto)
13. [Argentina.gob.ar](https://www.argentina.gob.ar/normativa/nacional/397424/texto)
14. [https://www.uiaf.gov.co/sites/default/files/2024-06/articulos/archivos/Documento_Preguntas_frecuentes.pdf](https://www.uiaf.gov.co/sites/default/files/2024-06/articulos/archivos/Documento_Preguntas_frecuentes.pdf)
15. [SAGRILAFT - Grupo de Supervisión de Programas y Riesgos Especiales - Asuntos Económicos Societarios - Inicio](https://www.supersociedades.gov.co/web/asuntos-economicos-societarios/sagrilaft)
16. [Circ_3978_v3_P.pdf](https://normativos.bcb.gov.br/Lists/Normativos/Attachments/50905/Circ_3978_v3_P.pdf)
17. [Transfiya supera los 20 millones de usuarios en Colombia y procesó 298 millones de transferencias en 2024](https://www.latamfintech.co/articles/transfiya-supera-los-20-millones-de-usuarios-en-colombia-y-proceso-298-millones-de-transferencias-en-2024)
18. [Davivienda-Results-Report-4Q24.pdf](https://ir.davivienda.com/wp-content/uploads/2025/02/Davivienda-Results-Report-4Q24.pdf)
19. [Persona](https://www.pse.com.co/)
20. [Nequi cerró con 22 millones de clientes en 2024: ¿Qué viene para el 2025?](https://www.valoraanalitik.com/nequi-cerro-con-22-millones-de-clientes-en-2024-que-viene-para-el-2025/)
21. [Sobre Nequi - Conoce qué es Nequi y cómo trabajamos para ti](https://www.nequi.com.co/personas/conocenos/somos-nequi)
22. [Depósito en Garantía (Escrow)](https://help.workana.com/hc/es/articles/360041401574-Dep%C3%B3sito-en-Garant%C3%ADa-Escrow)
23. [Legal | Rappi Colombia | Política de Compensaciones y Reembolsos de Rappi - Colombia](https://legal.rappi.com.co/colombia/politica-de-compensaciones-y-reembolsos-de-rappi-colombia/)
24. [Understanding driver ratings | Usuários | Ajuda da Uber](https://help.uber.com/pt-BR/riders/article/como-funcionam-as-avalia%C3%A7%C3%B5es?nodeId=fa1eb77f-ad79-4607-9651-72b932be30b7)
25. [How Ratings Work - Driver App Basics](https://www.uber.com/br/en/drive/basics/how-ratings-work/)
26. [Como faço para relatar uma experiência ruim com um Rappi Entregador? | Rappi Brasil](https://merchants.rappi.com/pt-br/como-faco-para-relatar-uma-experiencia-ruim-com-um-rappi-entregador)
27. [Como avaliar um profissional no GetNinjas? - Blog GetNinjas](https://blog.getninjas.com.br/como-avaliar-um-profissional-no-getninjas/)
28. [Argentina.gob.ar](https://www.argentina.gob.ar/normativa/nacional/ley-26993-235275/texto)
29. [Reclamar contra serviço ou produto de empresas privadas - Consumidor.gov.br](https://www.gov.br/pt-br/servicos/reclamar-contra-servico-ou-produto-de-empresas-privadas)
30. [Reporte de la Infraestructura Financiera e Instrumentos de Pago 2025 | Banco de la República](https://banrep.gov.co/es/publicaciones-investigaciones/reporte-infraestructura-financiera-instrumentos-pago/2025)