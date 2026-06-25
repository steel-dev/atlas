# Payment-terminal comparison for a 25-location Quebec/New Brunswick QSR chain

**Bottom line:** choose **PAX A920 Pro only if the implementation is through a Canadian Oracle-validated path such as Fiserv OCEAN for PAX A920-series Android terminals; otherwise choose a currently Oracle-validated Verifone Engage/Android device rather than Carbon 8, Clover Station Pro/Station Duo, or an uncertified Carbon 8.** The deciding factors are Oracle MICROS/OPI fit and Quebec French compliance, not raw device hardware. Clover has the strongest out-of-box French-facing Canadian materials and 24/7 support, but its Canadian developer documentation says offline payments are not supported and its Canadian semi-integrated device list names Flex/Mini 2 rather than Station Pro/Duo; Oracle’s May 2026 validated OPI partner guide names no Clover partner. Carbon 8 has capable legacy hardware, but the Oracle-validated Verifone Canadian lists name Engage/Trinity/Android models, not Carbon 8. PAX A920 Pro has the best documented French terminal configuration, LTE backup, and tip workflow among the three, and Oracle’s May 2026 guide names Canada support for Fiserv and PAX A920-series Android terminals, although the guide’s named terminal line is A920 rather than expressly “A920 Pro.” [1] [2] [3] [4]

| Rank | Terminal | Peak speed evidence | Outage resilience | Oracle MICROS/KDS fit | Bill 96 / French fit | Table-service tips | Contactless behavior | 5-year TCO verdict |
|---:|---|---|---|---|---|---|---|---|
| **1, conditional** | **PAX A920 Pro** | No p50/p95 Canadian MICROS benchmark; supports contactless, chip-and-PIN, and swipe; Visa Canada gives only generic contactless “as little as 0.5 seconds” and 7× faster than chip & PIN with receipt. [5] [6] | No sourced store-and-forward limits; documented LTE can be backup when Wi‑Fi is unreliable, but terminal requires network to processor. [3] | Best conditional fit: Oracle validates Fiserv in Canada with PAX Android A920-series terminals and OPI sale by credit/debit type 01; must confirm A920 Pro is accepted as the deployed A920-family application. [1] | Strongest: French docs, Android French Canada/France display selection; language change affects all terminal text. [3] | Strong: SecurePay/SecureTable supports customer preset %, custom $, custom %, or no tip; POS initiates payment. [4] | Supports tap, insert, swipe; Canada network thresholds are CAD $250 for Visa/Mastercard/Interac/Amex subject to implementation/lower merchant limits. [5] [6] [7] [8] [9] | Cannot compute a sourced dollar TCO; no sourced CAD hardware/lease, install, monthly support, warranty/EOL, SLA, or PayFacto/processor rates in the fetched material. |
| **2, substitute device required** | **Verifone Carbon 8** | No p50/p95 Canadian MICROS benchmark; hardware supports major NFC/contactless schemes, EMVCo smart card, and triple-track MSR. [10] | Carbon 8-specific outage terms are not established here; related Moneris SAF evidence is for Moneris V400m, not Carbon 8. [11] | Weak for this model: Oracle validates Verifone FIPayeps in Canada, but lists Engage/Trinity/Android models such as M400/P400/T650/CM5/M425/M450/V660/P630, not Carbon 8. [1] | Insufficient sourced evidence for Canadian French prompts, merchant UI, receipts, admin portal, error messages, or support scripts on Carbon 8. | OPI supports sale/refund/void/reversal classes generally; Carbon 8 tip workflow not sourced. [1] | Hardware supports contactless/NFC and EMV/MSR; Canada thresholds apply at acquirer/network level. [10] [6] | Cannot compute a sourced dollar TCO; no sourced CAD hardware/lease, install, monthly support, warranty/EOL, French SLA, or Carbon 8 processing rates. |
| **3** | **Clover Station Pro / Station Duo** | No p50/p95 Canadian MICROS benchmark; Station Duo page describes a 14-inch merchant screen and 8-inch customer screen that lets customers confirm order, tip, pay, and request digital receipt. [12] | Canadian docs explicitly say offline payment is not supported for Canadian merchants; general Clover offline up-to-7-days Mini/Flex content is not usable as Canadian support. [2] [13] | Weakest: Oracle’s validated OPI partner list includes Fiserv, Verifone, etc., but no Clover; Canadian Clover semi-integration list names Flex/Mini 2, not Station Pro/Duo. [1] [2] | Good customer payment flow: Canadian devices support English and French payment flow and return card language/locale for receipt matching; French Station Duo page and 24/7 support are documented. [2] [12] | Customer-facing screen can leave a tip at checkout; Clover Canada’s SDK table states auth/pre-auth and `tipAdjustAuth()` tip adjustment are not supported in Canada, so table-service post-auth adjustment is weaker than a POS-initiated tip prompt. [12] [2] | Accepts swipe, insert, contactless Apple Pay/Google Pay; Canada thresholds apply. [12] | Cannot compute a sourced dollar TCO; Clover Canada Station Duo pricing table says “Contact sales,” and sourced rates/fees/warranty/EOL were not available in the fetched material. [14] |

## 1. Existing estate baseline and gating assumptions as of 2026-06-24

The requested existing-estate facts—**Oracle MICROS Simphony POS version, OPI version, Oracle MICROS KDS/KDS Controller version, current acquirer, lane count per restaurant, and the asserted 25 Quebec/New Brunswick locations as of 2026-06-24**—are not established by the sourced material, so they must be treated as pre-contract discovery gates rather than assumed inputs. The only Oracle version fact grounded here is Oracle’s own Simphony OPI configuration statement: **OPI is supported through Simphony release 19.9, not supported in 19.10 and later, and Oracle says to install/upgrade to OPI version 6.2 including the latest patch before installation/upgrade**. [15]

That version boundary is central: if the chain is already on **Simphony 19.10 or later**, the OPI path cited here is not a supported Simphony configuration; if it is on **Simphony through 19.9 with OPI 6.2**, the Oracle-validated partner/device matrix becomes the governing integration evidence. [15] Oracle’s May 12, 2026 validated OPI partner guide describes OPI as a payment-card interface integrating Oracle Hospitality POS/OPERA/Suite8 and Oracle Retail POS with partner PSPs, but states that Oracle validates OPI transaction types while partner solution providers support the payment solution first-line. [1]

For kitchen display, none of the three payment sources establishes an Oracle MICROS KDS/KDS Controller version or a payment-device-driven change to KDS routing. Operationally, card tenders should be implemented as payment tenders after the POS order has been fired/routed; a payment terminal that requires order ownership or a separate Clover/PayFacto order system would be out of scope for the existing Oracle MICROS KDS unless separately integrated.

## 2. Quebec Bill 96 / Charter of the French Language compliance baseline

For Quebec customer-facing payment flows, the baseline is the **Charter of the French Language, CQLR c C-11**, not a generic “bilingual preferred” requirement:

| Charter section | Requirement grounded in statute | Payment-terminal implication |
|---|---|---|
| **s. 50.2** | Enterprises offering goods/services to consumers must respect consumers’ right to be informed and served in French; enterprises serving non-consumers must inform and serve them in French. [16] | Customer prompts, cashier scripts, payment help, and support escalation must be available in French. |
| **s. 51** | Every inscription on a product, its container/wrapping, or supplied document/object, including directions and warranties, must be in French; menus and wine lists are included; other-language text cannot be more prominent or on more favourable terms. [16] | Terminal labels, supplied guides, on-screen menu/prompt wording, and customer-facing objects should have French at least as favourably presented. |
| **s. 52** | Catalogues, brochures, folders, commercial directories, order forms and similar public documents must be drawn up in French; non-French versions cannot be on more favourable terms. [16] | Merchant/customer commercial documentation, order prompts, and public payment instructions must have French versions. |
| **s. 52.1** | All computer software, including operating systems, installed or uninstalled, must be available in French unless no French version exists; any non-French version is allowed only if the French version is available on no-less-favourable terms and with at least equivalent technical characteristics. [16] | Customer-facing terminal UI, merchant UI used in Quebec stores, and admin software should be available in French with equivalent function. |
| **s. 57** | Invoices, receipts, acquittances and similar documents must be drawn up in French; non-French may be sent only if the French version is available on at least as favourable terms. [16] | Payment receipts and digital receipt flows must produce French receipts, with English not more favourable. |
| **s. 58** | Public signs/posters and commercial advertising must be in French; bilingual signage/advertising is allowed if French is markedly predominant, subject to regulations. [16] | Any customer-facing terminal signage, payment acceptance decals, and promotional payment screens must satisfy French prominence rules. |

Against that baseline, **PAX A920 Pro and Clover are the only candidates with sourced French terminal/payment-flow evidence**. PayFacto’s A920 Pro Canada documentation is itself French and states that the terminal defaults to English but can be changed to French, including Canada or France variants, and that selecting another language changes all text appearing on the terminal. [3] Clover Canada says Canadian devices support both English and French payment flow and that `Payment.TransactionInfo` returns customer card language/locale so custom receipts can match card/receipt language. [2] Carbon 8 has no sourced Carbon-specific Canadian French UI, receipt, error-message, admin-portal, support-script, or language-toggle evidence in this record.

## 3. Peak-hour transaction speed evidence

No sourced document provides **p50/p95 elapsed seconds under Canadian acquirer + Oracle MICROS-connected operation** for **NFC tap, EMV chip, magstripe fallback, tip-prompted sale, or reversal/void authorization** for any of Carbon 8, Clover Station Pro/Station Duo, or PAX A920 Pro. The only quantitative speed evidence is Visa Canada’s network-level contactless statement, which is not terminal-specific: Visa says contactless transactions can complete in **as little as 0.5 seconds**, most transactions under **CAD $250** at participating merchants do not require PIN, and a 2012 Visa timing study found payWave transactions without receipt were on average **7× faster** than typical chip-and-PIN transactions with receipt. [6]

| Flow requested | Carbon 8 | Clover Station Pro/Duo | PAX A920 Pro | Usable conclusion |
|---|---|---|---|---|
| NFC tap p50/p95 | Not sourced; hardware supports major NFC/contactless schemes. [10] | Not sourced; device accepts contactless Apple Pay/Google Pay. [12] | Not sourced; terminal supports presenting contactless card/device. [5] | Rank cannot be based on measured p50/p95; contactless should be fastest because networks avoid PIN below CAD $250 where implemented. [6] |
| EMV chip p50/p95 | Not sourced; EMVCo smart-card reader. [10] | Not sourced; accepts inserted card. [12] | Not sourced; chip-and-PIN insert supported. [5] | Require pilot measurement in Quebec/NB stores before committing peak-lane SLA. |
| Magstripe fallback p50/p95 | Not sourced; triple-track MSR. [10] | Not sourced; accepts swipe. [12] | Not sourced; swipe supported. [5] | Magstripe should be exception/fallback, not peak design path. |
| Tip-prompted sale p50/p95 | Not sourced. | Not sourced; customer screen supports leaving tip. [12] | Not sourced; tip workflow is detailed but timing is not. [4] | PAX has strongest workflow evidence, not speed evidence. |
| Reversal/void authorization p50/p95 | Not sourced; OPI transaction class supports void/reversal generally. [1] | Not sourced; Clover Canada notes refunds/voids with limits. [2] | Not sourced; OPI supports void/reversal classes generally. [1] | Treat void/reversal as a processor/POS integration test case. |

Carbon 8 hardware is broad enough for the requested card-entry modes: its datasheet lists **triple-track MSR (ISO 7810/7811/7813)**, an **EMVCo-approved smart card reader**, **ISO14443 A&B**, **MiFare**, **ISO18092-capable**, **EMVCo L1 certification**, and support for **major NFC/contactless schemes**. The merchant tablet is specified as **Android**, **Intel Quad Core 1.8 GHz**, **8-inch 1280×800 display**, **Bluetooth 4.2 BLE**, **dual-band Wi‑Fi 802.11ac 2.4/5 GHz**, and a base with **RJ45 Ethernet**. [10]

## 4. Offline/outage capability

| Requirement | Carbon 8 | Clover Station Pro/Duo | PAX A920 Pro |
|---|---|---|---|
| Supported offline payment types | Carbon 8-specific SAF terms are not established here. Related Moneris Canada V400m SAF evidence supports **credit-card purchase transactions** and **void of a currently stored offline purchase** only; it excludes Interac debit, EMV fallback, cashback, DCC, Gift/Loyalty, UnionPay, and cards with service code x2x. [11] | **None in Canada:** Clover Canada says offline payment is **not supported** and Canadian merchants cannot use Clover devices to process any payments in offline mode. [2] General Clover offline docs for other contexts say devices can record offline payments when unable to reach the server but cannot verify gateway/card/funds; Mini/Flex default is up to 7 days, with merchant-set amount/total limits, but that does not override the Canada exclusion. [13] | No sourced PayFacto/PAX A920 Pro store-and-forward terms. PayFacto docs state the A920 Pro requires a network connection to communicate with the processor to process transactions, while LTE can serve as backup if Wi‑Fi is unreliable. [3] |
| Maximum offline amount CAD | Carbon 8-specific amount is not established here. Moneris V400m SAF requires merchant risk limits: Daily Cumulative Transaction Limit up to **20% of projected monthly volume approved by Credit** and Maximum Transaction Amount ≤ Daily Cumulative Transaction Limit; no fixed CAD amount. [11] | **CAD $0 effectively for Canada** because offline payments are not supported for Canadian merchants. [2] | Not sourced; network backup rather than offline approval is documented. [3] |
| Stored transaction count | Carbon 8-specific count is not established here; Moneris V400m public help does not state a fixed count. [11] | None for Canada. [2] | Not sourced. |
| Maximum offline duration | Carbon 8-specific duration is not established here; Moneris V400m public help does not state a cap. [11] | None for Canada; general Mini/Flex up-to-7-days is not Canada-supported. [2] [13] | Not sourced. |
| Upload/retry process | Carbon 8-specific upload/retry is not established here. Moneris V400m SAF stores offline purchases securely and automatically forwards them when host connection becomes available. [11] | Not applicable in Canada. [2] | Not sourced. |
| Merchant liability | Carbon 8-specific liability is not established here. Moneris V400m SAF places full liability on merchant, including insufficient funds, blocked/stolen/fraudulent cards, lost/damaged stored data, storage capacity exceeded, and limited/no chargeback remedies. [11] | General Clover offline docs say offline acceptance creates merchant risk because gateway/card/funds cannot be verified; Canada does not support offline mode. [2] [13] | Not sourced. |

**Outage ranking:** (1) PAX A920 Pro for documented LTE backup, though not true offline; (2) Carbon 8 only if a specific Canadian acquirer supplies a Carbon-certified SAF profile; (3) Clover because Canadian offline payments are explicitly unsupported. [3] [2]

## 5. Oracle MICROS / OPI / KDS integration

Oracle’s May 2026 OPI guide is the controlling integration source for certified paths. It names validated partners including **Fiserv, Eigen, Fortis, FreedomPay, Shift4, Stripe, Verifone Payments Connector (FIPay OPI), and Verifone PSDK**, and **does not name Clover**. [1] It also defines the core OPI transaction types: **sale/purchase 01** and **refund 03** are mandatory, **void 08** is mandatory, **reversal 04** and **void of refund 39** are recommended, and **manual authorization 37** and **sales completion 07** are optional. [1]

| Integration dimension | Carbon 8 | Clover Station Pro/Duo | PAX A920 Pro |
|---|---|---|---|
| Certified Simphony/OPI path | Verifone FIPayeps is validated in Canada, but supported terminals listed are Engage, Trinity, and Verifone Android models—not Carbon 8. [1] | No Clover in Oracle validated OPI partner list; Clover Canada semi-integrated devices list Flex/Mini 2, not Station Pro/Duo. [1] [2] | Fiserv operating areas include Canada and supported PAX Android terminals include A920 series; Fiserv OCEAN ONLINE version 7.X supports OPI card payment by credit/debit type 01 with EFTLink OPI Retail Core 17.0. [1] |
| Canadian acquirer/processors supported | Verifone FIPayeps Canada support exists for listed Verifone models, not Carbon 8. [1] | Fiserv/Clover is commercially Canadian, but not Oracle-validated in the sourced OPI list. [1] | Fiserv Canada is the strongest sourced path; Oracle also lists other Canadian-capable partners, but the PAX A920 evidence is tied to Fiserv. [1] |
| Tender mapping | OPI sale/purchase type 01, refund 03, void 08, reversal 04 available at OPI level, but Carbon device certification is not shown. [1] | Would require non-OPI custom tender/middleware; no named Oracle-certified middleware sourced. [1] | OPI type 01 for credit/debit via Fiserv; refunds/voids/reversals must be validated in processor certification scripts. [1] |
| Tip adjustment/post-auth | Carbon-specific support not sourced; OPI supports manual auth/sales completion as optional types, but tip adjustment workflow is not established. [1] | Clover Station can prompt the customer to leave a tip at checkout, but Clover Canada’s SDK table states auth/pre-auth and `tipAdjustAuth()` tip adjustment are not supported in Canada. [12] [2] | PayFacto SecurePay gives a full customer tip prompt workflow, but post-auth/tip-adjust after authorization is not established in the OPI source. [4] |
| Oracle MICROS KDS effect | No sourced payment-device effect on KDS routing. | Clover KDS/printer ecosystem exists, but that is not Oracle MICROS KDS compatibility. [12] | No sourced payment-device effect on KDS routing; POS-initiated SecurePay is most compatible with keeping order routing in MICROS. [4] |

## 6. Language and support comparison

| Language/support item requested | Carbon 8 | Clover Station Pro/Duo | PAX A920 Pro |
|---|---|---|---|
| Canadian French customer prompts | Not sourced. | Canadian Clover devices support English and French payment flow. [2] | Display language can be changed to French, including Canada/France variant; all terminal text changes. [3] |
| Merchant UI | Not sourced. | French Canada product page exists; device/admin language beyond payment flow not fully sourced. [12] [2] | Android display language change affects all terminal text. [3] |
| Receipts | Not sourced. | Custom receipt integrations should use returned language/locale to match card and receipt language. [2] | French receipt behavior not separately sourced; terminal UI is French-capable. [3] |
| Error messages | Not sourced. | Not separately sourced. | Covered only to the extent “all text appearing on the terminal” changes with language. [3] |
| Admin portal | Not sourced. | French page and support access are sourced; full admin portal language not sourced. [12] | Not sourced beyond Android/terminal language. [3] |
| Support scripts / French technical support | Not sourced. | French official page states all Station Duo plans include **24/7 support** and support is reachable through web account Help, device Help, Clover Go Help, or **(888) 263-1938**. [12] | Not sourced. |
| Language toggle behavior | Not sourced. | Payment flow supports English/French; card language/locale is returned. [2] | Settings > Languages & input; select French Canada/France; move language to top if needed; changes all terminal text. [3] |

## 7. Canada contactless limits as of 2026-06-24

| Network | Sourced no-CVM / no-PIN threshold and behavior | Lower limits / fallback |
|---|---|---|
| **Visa payWave** | Up to **CAD $250** contactless; most transactions under $250 at participating merchants do not require PIN; Visa says transactions can complete in as little as 0.5 seconds. [6] | Increased limit from CAD $50 to CAD $250 is subject to merchant/acquirer implementation; contact acquirer. [6] |
| **Mastercard Contactless** | Mastercard announced Canadian enablement for contactless purchases up to **CAD $250**; signatures are not required for contactless payments. [7] | “Once implemented by partners” language means acquirer/merchant implementation controls availability. [7] |
| **Interac Flash / Interac Debit contactless** | Up to **CAD $250 per transaction**; additional cumulative contactless limit is set by the cardholder’s bank/credit union. [8] | When cumulative limit is reached, cardholder is prompted to reset with chip-and-PIN. [8] |
| **American Express contactless** | Contactless purchases up to **CAD $250** at participating American Express contactless merchants. [9] | Retailer contactless limits may apply. [9] |

For this QSR chain, a **CAD $250 network ceiling** means ordinary QSR checks should clear as no-PIN contactless when the acquirer and merchant profile implement the higher limit. High-value catering/table checks, cumulative Interac counters, or merchant-configured lower limits will fall back to chip-and-PIN. [6] [8]

## 8. Five-year TCO model and sensitivity

The sourced record does **not** provide the dollar inputs required to compute a definitive five-year TCO for any of the three devices: Canadian hardware purchase/lease, installation, monthly software/support, warranty term, replacement/EOL cycle, French support SLA, and named acquirer processing rates are not fully priced in the fetched material. Clover’s Canadian Station Duo pricing table directs buyers to **Contact sales**, and the PAX/Carbon sources here do not provide Canadian CAD price books or fee schedules. [14]

Use this formula for procurement once bids are received:

**5-year cost per terminal = hardware or lease + installation + 60 × monthly software/support + replacement cost within 5 years + 5-year processing fees + support uplift.**

**Fleet cost = per-terminal cost × terminals per location × 25 locations.**

Processing-fee sensitivity should be bid on card volume and mix, because processing dominates terminal hardware in most restaurant fleets:

| Scenario | Terminals/location | Fleet terminals | Five-year fixed-device cost formula | Five-year processing-fee formula |
|---|---:|---:|---|---|
| Lean counter | 2 | 50 | 50 × per-terminal five-year fixed cost | 5 × annual card volume × blended ad valorem rate + 5 × annual transaction count × per-transaction fee |
| Typical QSR | 4 | 100 | 100 × per-terminal five-year fixed cost | Same formula; ticket mix drives transaction count. |
| Peak-heavy/table hybrid | 6 | 150 | 150 × per-terminal five-year fixed cost | Same formula; more lanes reduce queue time but do not reduce card fees. |

For annual card volume/ticket mix, require each bidder to quote at least three mixes: **low debit/high Interac**, **balanced credit/debit**, and **high premium-credit/Amex**. The terminal recommendation should not be finalized until bids include: named Canadian acquirer/ISO, all assessment/authorization/batch/PCI/network fees, chargeback fees, replacement policy, cellular data charges for LTE, French support hours/SLA, and whether Oracle/OPI certification work is included.

## 9. Required vs optional features and decision rules

**Required for go-live in Quebec/NB:**

1. **French-first customer payment UI and receipts in Quebec**, aligned to Charter ss. 50.2, 51, 52, 52.1, 57 and 58. [16]
2. **Supported Oracle MICROS payment integration**, not a parallel POS, with the chain’s actual Simphony version checked against Oracle’s OPI support boundary through release 19.9 and OPI 6.2. [15]
3. **No disruption to Oracle MICROS KDS order routing**; payments must remain tender flows after MICROS order entry/routing.
4. **CAD $250 contactless support** for Visa, Mastercard, Interac, and Amex where merchant/acquirer profiles implement it, with chip-and-PIN fallback for above-limit or Interac cumulative-limit cases. [6] [7] [8] [9]
5. **Canadian acquirer certification in writing**, including Interac debit, refunds/voids, tip workflows, and outage behavior.

**Optional but valuable:** LTE backup, customer-facing digital receipt prompt, customer-entered tip presets/custom tip, external kitchen-printer/KDS ecosystem if kept separate from Oracle KDS, and store-and-forward only where the acquirer provides written limits and liability terms.

**Choose-when conditions:**

- **Choose PAX A920 Pro** when Fiserv or another Oracle-validated Canadian path confirms A920 Pro support under the same PAX A920 Android application family, French UI/receipt behavior, Interac support, tip workflow, and LTE backup. [1] [3] [4]
- **Choose Verifone only as a current validated Verifone model, not Carbon 8,** when the processor requires Verifone and can deploy one of Oracle’s listed Canada-supported Verifone Engage/Trinity/Android devices under FIPayeps/PSDK. [1]
- **Choose Clover Station Pro/Duo only outside the Oracle MICROS in-window scope**—for example, a new Clover-native store, kiosk, or non-MICROS concept—because Canadian offline payments are not supported and Oracle’s validated OPI list does not name Clover. [2] [1]

**Fallback if the top option fails certification or French support:** move to a **currently Oracle-validated Verifone Engage/Android model listed by Oracle**, not Carbon 8, and contractually require French customer prompts, French receipts, French support hours/SLA, Interac debit, contactless CAD $250 profiles, tip workflow, and written outage liability before pilot. [1] [16]

## 10. Final ranking by dimension

| Dimension | 1st | 2nd | 3rd | Rationale |
|---|---|---|---|---|
| Peak speed | Tie / not measurable from sourced p50/p95 | Tie | Tie | No device p50/p95 under Canadian MICROS was sourced; only Visa generic contactless speed is quantified. [6] |
| Offline resilience | PAX A920 Pro | Carbon 8 | Clover | PAX has LTE backup; Carbon depends on unsourced Carbon-specific SAF; Clover Canada says offline not supported. [3] [2] |
| Oracle MICROS/KDS fit | PAX A920 Pro, conditional | Carbon 8 via substitute Verifone model | Clover | Oracle validates Fiserv Canada with PAX A920-series Android; Verifone Canada path excludes Carbon 8; no Clover in Oracle list. [1] |
| Bill 96/French support | PAX A920 Pro | Clover | Carbon 8 | PAX documents full terminal language change to French; Clover documents French payment flow and 24/7 support page; Carbon 8 French evidence not sourced. [3] [2] [12] |
| Table-service tip workflow | PAX A920 Pro | Clover | Carbon 8 | PayFacto documents preset/custom/no-tip workflow; Clover customer screen supports checkout tips but Canadian auth/pre-auth and `tipAdjustAuth()` are not supported; Carbon tip workflow is not established here. [4] [12] [2] |
| Contactless behavior | Tie | Tie | Tie | All three support contactless in principle; Canadian thresholds are network/acquirer-controlled CAD $250. [6] [7] [8] [9] |
| 5-year TCO | Not rankable from public sourced dollars | Not rankable | Not rankable | Public sourced materials do not provide the full CAD price/rate/SLA set; require bid-based formula above. [14] |

**Procurement verdict:** run the pilot with **PAX A920 Pro over the Oracle-validated Fiserv/PAX path if and only if A920 Pro is contractually confirmed as certified for the chain’s Simphony/OPI version and French receipt/UI requirements.** Exclude **Clover Station Pro/Duo** from the Oracle MICROS replacement window, and exclude **Verifone Carbon 8** unless the acquirer supplies written Canadian MICROS certification specifically for Carbon 8; otherwise substitute an Oracle-listed Verifone Engage/Android model.

## Sources

1. [G34828_04.pdf](https://docs.oracle.com/en/industries/retail/retail-eftlink/25.0/reopg/G34828_04.pdf)
2. [Canada merchants](https://docs.clover.com/dev/docs/canadian-merchants)
3. [installation-et-configuration-du-terminal.md](https://docs.payfacto.com/centre-de-documentation-payfacto/documentation-canada/terminaux/mobile/pax-a920-pro/installation-et-configuration-du-terminal.md)
4. [processus-de-transaction-complet-avec-securepay.md](https://docs.payfacto.com/centre-de-documentation-payfacto/documentation-canada/applications/secure-payment/module-securepay-guide-utilisateur/processus-de-paiement/processus-de-transaction-complet-avec-securepay.md)
5. [utilisation-du-terminal.md](https://docs.payfacto.com/centre-de-documentation-payfacto/documentation-canada/terminaux/mobile/pax-a920-pro/utilisation-du-terminal.md)
6. [Visa contactless payments](https://www.visa.ca/en_CA/run-your-business/merchant-resources/contactless-payments.html)
7. [Mastercard enables higher contactless payments across Canada](https://www.newswire.ca/news-releases/mastercard-enables-higher-contactless-payments-across-canada-841142394.html)
8. [Interac Debit](https://www.interac.ca/en/resources/personal-resources/personal-faq/interac-debit/)
9. [American Express Contactless Payments | American Express Canada](https://www.americanexpress.com/ca/en/services/ways-to-pay/contactless/)
10. [3559729.pdf](https://fcc.report/FCC-ID/B32CARBON8/3559729.pdf)
11. [Offline Payments (formally known as Store & Forward) processing](https://www.moneris.com/help/V400m-WH-EN/Transactions/Offline_Payments_(formally_known_as_Store_and_Forward)_processing.htm)
12. [Système de point de vente Clover Station Duo | Site officiel de Clover](https://www.clover.com/ca/fr/station-duo)
13. [Handle offline payments](https://docs.clover.com/dev/docs/handling-offline-payments)
14. [Clover Station Duo Price and Service Plans](https://www.clover.com/ca/pricing/station-duo)
15. [Configuration Guide](https://docs.oracle.com/en/industries/food-beverage/simphony/simcg/c_payments_opi.htm)
16. [C-11 - Charter of the French language](https://www.legisquebec.gouv.qc.ca/en/document/cs/c-11)