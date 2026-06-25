## Bottom line

For a 25-location quick-service chain whose existing back-of-house runs **Oracle MICROS Simphony**, **Verifone is the only one of the three vendors with a native, Oracle-certified payment path** into Simphony (via the Oracle Payment Interface / SPI and Oracle MICROS Payment Cloud Service). The Carbon 8 is a Verifone device, but Oracle's *named, certified* in-store PIN-entry device for Simphony is the **Verifone P400**, not the Carbon 8 — and Oracle's payment-device-assignment procedure explicitly excludes "mobile phones, handheld devices, and tablets," which is the Carbon 8's merchant-tablet form factor [1]. The cleanest in-window answer is therefore a **fixed P400-class Verifone terminal on the OPI/SPI path**, not the Carbon 8.

- **Clover Station Pro (now Station Duo) is excluded** as the primary terminal for a MICROS shop: it is a closed Fiserv/Clover-OS ecosystem with its own POS apps and cloud, and does **not** natively integrate with Oracle MICROS Simphony [2]. Choosing Clover effectively means replacing Simphony, not integrating with it.
- **PAX A920 Pro** is processor-agnostic and an excellent **mobile/handheld table-service** device, but it is **not an Oracle-certified Simphony terminal** in Oracle's documentation; it fits as a standalone or non-MICROS deployment, or alongside MICROS only through a third-party middleware/gateway, not as a native Simphony PED.
- All three meet the **CAD $250** Canadian contactless tap limit and can run a French-default interface, satisfying **Quebec's Bill 96**; the operational risk is integration, not the chip.

**Ranking against your criteria** (1 = best):

| Criterion | Verifone (Carbon 8 / P400) | Clover Station Pro/Duo | PAX A920 Pro |
|---|---|---|---|
| Peak transaction speed | 1 (tie) | 1 (tie) | 3 (handheld, lighter CPU) |
| Offline / store-and-forward | 1 (configurable floor + total limit, SAF) | 2 (7-day default, amount limits) | 1 (HW-capable, app-dependent) |
| Oracle MICROS Simphony integration | **1 (only native/certified path)** | 3 (none — closed ecosystem) | 2 (not certified; middleware only) |
| Bill 96 French-default compliance | 1 (tie) | 1 (tie) | 1 (tie) |
| 5-yr TCO (processor flexibility) | 1 (tie, processor-agnostic) | 3 (locked Fiserv rates) | 1 (tie, processor-agnostic) |
| Mobile table service | 2 | 3 (countertop) | **1 (purpose-built handheld)** |

**Recommendation:** Standardize on **Verifone on the OPI/SPI path** as the countertop/integrated terminal for MICROS Simphony, and add **PAX A920 Pro handhelds** for table-service tip-on-device where a mobile form factor matters and the lane can run on the same processor-agnostic gateway. **Avoid Clover** unless you are prepared to abandon Oracle MICROS.

---

## 1. Hardware and peak transaction speed

| Spec | Verifone Carbon 8 | Clover Station Pro / Station Duo (Duo 2) | PAX A920 Pro |
|---|---|---|---|
| Processor | Merchant tablet Intel Quad Core 1.8 GHz; consumer PIN display 600 MHz Cortex-A9 32-bit RISC [3] | Qualcomm Snapdragon 660 octa-core (Duo 2: 4×1.8 GHz + 4×2.2 GHz) [4] | 32-bit quad-core Cortex-A53 @1.4 GHz + dedicated 32-bit RISC ARMv7 encryption core [5] |
| OS | Android (merchant) + Verifone V/OS (consumer display) [3] | Clover-hardened Android (AOSP) 8.1 → 10.0 (Duo 2: 10.0) [4] | PAXBiz, "powered by Android" [5] |
| Display(s) | 8" 1280×800 merchant + 5" 854×480 consumer, Gorilla Glass [3] | Dual: 14" 1920×1080 merchant + 7" (Duo) / 8" (Duo 2) customer-facing [4] | Single 5.5" 720×1440 IPS touchscreen [5] |
| Memory | — | 2 GB RAM / 16 GB Flash [4] | 1 GB RAM / 8 GB Flash, microSD to 128 GB [5] |
| Battery | 5000 mAh [3] | Countertop (mains-powered) | 3.7 V / 5150 mAh Li-Ion [5] |
| Printer | Optional attachable thermal, 30 mm roll [3] | Built-in (per model) | Built-in 2"/80 mm-per-second thermal [5] |
| Form factor | Compact mobile POS (counter or mobile) [3] | Fixed dual-screen countertop [4] | Handheld/mobile, 11.3 oz [5] |

**Peak transaction speed.** None of the three manufacturer datasheets publishes a guaranteed "seconds-per-transaction" figure, so this is a measured/operational characteristic rather than a quoted spec [3][4][5]. On hardware grounds, the **Clover Station Duo 2** (Snapdragon 660 octa-core, up to 2.2 GHz, dual screen so the customer can tap while staff ring the next order) and the **Carbon 8** (Intel quad-core 1.8 GHz with a dedicated consumer PIN display) are the strongest for high-throughput peak-hour lanes; the **PAX A920 Pro** (single 1.4 GHz quad-core, single screen, handheld) is built for mobility rather than maximum fixed-lane throughput. In practice, EMV contactless tap-to-approve on all three is typically a few seconds; the throughput differentiator at peak is the **dual-screen** capability (Carbon 8 and Clover separate the customer-payment surface from the order surface), not raw CPU. Treat per-transaction timings as device-and-network-dependent rather than as a vendor-quoted number.

## 2. Offline / store-and-forward during internet outages

- **Verifone (Carbon 8 / SCA):** Native **Store and Forward (SAF)**. When the host/gateway is unreachable, the device locally and conditionally approves transactions **below a configured floor limit until a configured total limit is reached**, queues them with `RESPONSE_TEXT = "Transaction Approved Offline,"` and forwards them to the gateway once connectivity is restored. SAF covers EMV chip transactions (except those using Online PIN as CVM) and, by parameter, VOID/ACTIVATE/CREDIT(Refund). Verifone explicitly does **not guarantee** later host approval — the merchant carries the risk [6]. Works across Fiserv/FDRC and other gateways (processor-agnostic) [6].
- **Clover Station Pro/Duo:** Offline payments are supported but **merchant/gateway-configured**. By default Clover Station, Station 2018, Mini, Mobile and Flex accept offline payments **for up to 7 days**; merchants can disable them or set three limits — the **days-before-going-online limit** (default 7), an **amount limit on each offline transaction**, and a **total offline-payments limit** (cumulative amount processed while offline, enforced via the SDK's `PAYMENT_AMT_OVER_TOTAL_OFFLINE_LIMIT` error) [7][8]. The Remote Pay SDK exposes three risk-tiered overrides of those merchant limits: `AllowOfflinePayment` (least risk — prompts the merchant with an offline challenge), `ApproveOfflinePaymentWithoutPrompt` (more risk — no prompt, faster) and `ForceOfflinePayment` (most risk — takes offline regardless of connection and overrides all merchant limits) [7]. While offline the device cannot verify the gateway, card validity, or funds, and the auth code/first-6 digits may not be available until reconnection and successful processing — merchant bears the decline risk [8].
- **PAX A920 Pro:** PCI PTS POI v5.1 security policy states the device is "designed to process **online and offline** financial transactions in an attended environment," confirming hardware-level offline capability; the actual store-and-forward limits and sync behavior depend on the payment application/processor configuration loaded onto it.

**Verdict:** Verifone gives the most explicitly controllable outage policy (floor + total limits, defined queue/forward semantics); Clover is workable but its 7-day default carries accumulation risk; PAX is capable but its offline policy is whatever the chosen processor app enforces.

## 3. Oracle MICROS Simphony integration

This is the decisive criterion for a MICROS shop.

- **Simphony's payment plumbing** is the **Oracle Payment Interface (OPI)** and the newer **SPI** driver, fronted by **Oracle MICROS Payment Cloud Service (PCS)**. Oracle's certified in-store PIN-entry device for Simphony (e.g., kiosk configurations on Simphony 19.4.2+) is the **Verifone P400**. Verifone is Oracle's certified payment-terminal partner; Oracle ships P400 CAL/Linux packages for Simphony workstations.
- **Carbon 8 (Verifone):** In-window by vendor, but the *certified model named in Oracle's documentation is the P400, not the Carbon 8*. Oracle's "Assign Payment Device" procedure states that under PCS you configure payment terminals "(for example, Verifone p400)" and explicitly that the device-assignment "option is **not available on mobile phones, handheld devices, and tablets**" [1]. Because the Carbon 8's merchant unit is an 8" Android **tablet**, it falls in the form factor Oracle excludes from PCS PED assignment — so the native, certified Simphony PED is the fixed **P400-class** Verifone terminal, not the Carbon 8 itself. Standardize on a P400-class Verifone PED on the OPI/SPI path.
- **Clover Station Pro/Duo:** **No native Oracle MICROS integration.** Clover is the closed Fiserv/Clover-OS ecosystem with its own POS apps, SDKs, and cloud; payment processing is tied to Fiserv [2]. Independently, Oracle's Simphony payment-device documentation names only the Verifone P400 as the PCS terminal and lists no Clover device [1]. A MICROS shop adopting Clover is replacing Simphony, not integrating with it.
- **PAX A920 Pro:** Processor-agnostic Android terminal, but **not listed as an Oracle-certified Simphony PED** in Oracle's documentation. It can serve a MICROS environment only through third-party middleware/gateway, not as a native OPI/SPI device.

**In-window vs out:** Only **Verifone** satisfies the *Bill 96 French-default + native MICROS integration* constraint together. **Clover is excluded** by the MICROS constraint (closed ecosystem). **PAX is excluded** from the *native* MICROS path but remains viable as a standalone/mobile terminal.

## 4. Quebec Bill 96 and New Brunswick language compliance

- **Quebec — Bill 96 / Charter of the French Language (An Act respecting French, the official and common language of Québec, SQ 2022, c 14).** The OQLF actively enforces French on **payment terminal interfaces and operating instructions** ("l'affichage du mode d'utilisation d'un terminal de paiement"): a terminal not available in French, or only partially in French, is a violation. **Charter art. 57** requires invoices, receipts, and similar documents to have a French version available on terms at least as favourable; **art. 58** requires public commercial signage in French (bilingual only if French is markedly predominant). Operationally, customer-facing prompts (tap/insert, amount, tip, approved/declined, receipt) must **default to French**; English may be offered additionally but not in place of French.
- **New Brunswick — Official Languages Act.** New Brunswick is Canada's only officially bilingual province; the divergence is that NB obligations run primarily to **government/public-sector and designated services** offering English **and** French equally, rather than imposing a French-*default* private-commerce rule the way Bill 96 does. Practically, a single **bilingual, French-first-capable** terminal configuration satisfies both jurisdictions: French-default to clear Bill 96 in Quebec, with English equally available to serve anglophone customers in New Brunswick.

**Per-terminal bilingual support.** All three platforms run Android-based software and support multilingual customer-facing prompts, so each can be configured **French-first with English available** — the compliance gate is *configuration and OQLF-acceptable wording*, not hardware. (The vendor datasheets confirm the OS/platform but do not each spell out a French-default toggle, so validate the deployed prompt set against OQLF expectations at rollout.) On this criterion the three are effectively tied; none is disqualified by Bill 96.

## 5. Contactless tap limit

The current Canadian contactless ceiling is **CAD $250 per transaction** (raised from $100 effective **January 29, 2021**), with a separate cumulative contactless limit set by each issuer (commonly **$500**) after which a Chip-&-PIN transaction is required to reset; merchants may **not** set a lower per-transaction tap limit on terminals. All three terminals support EMV/NFC contactless and the relevant schemes — the **PAX A920 Pro** datasheet explicitly lists Interac Flash, Visa payWave, Mastercard Contactless, Amex, Discover D-PAS and UnionPay qUICS [5]; the **Carbon 8** lists ISO14443 A&B, MiFare, ISO18092, EMVCo L1 contactless and "major NFC/contactless schemes" [3]; **Clover** devices include NFC readers across the Station line [4]. All three honor the $250 tap limit; none differentiates here.

## 6. Tip adjustment for table service and KDS compatibility

- **Tip workflow.** For QSR-with-table-service, the relevant flows are **tip-on-device** (customer taps a tip % / amount on the customer-facing prompt) and **pre-auth + tip-on-receipt adjustment**. The **PAX A920 Pro** is purpose-built for at-table, tip-on-device handheld service (mobile, customer-facing single screen) [5]; the **Carbon 8** and **Clover Station Pro/Duo** both present a **dedicated customer-facing display** (Carbon 8 5" consumer screen; Clover 7"/8" customer screen) ideal for on-screen tip selection at the counter [3][4]. Pre-auth tip-adjustment for table service, however, is governed by the **POS application** that drives the terminal: in a MICROS environment, tip adjustment/pre-auth-tip is a **Simphony** workflow executed through the OPI/SPI-connected Verifone PED, whereas on Clover the tip workflow is handled inside **Clover's own POS app** (not Simphony).
- **Kitchen Display System (KDS).** KDS is a **POS function, not a payment-terminal function** — it is the POS (Simphony) that drives the kitchen displays, and the payment terminal does not "talk to" the KDS directly. Your existing **Oracle MICROS Simphony KDS** is therefore driven by Simphony regardless of terminal; a **Verifone** terminal on the OPI/SPI path keeps order capture and KDS native to Simphony, whereas **Clover** would route ordering through Clover's ecosystem and **not** integrate with your Simphony KDS [2]. PAX, as a payment-only terminal, leaves KDS to Simphony where it is deployed alongside MICROS. This again favors keeping Simphony (and thus a Verifone terminal) for KDS continuity.

## 7. Processing fees, hardware cost, replacement cycle, French support, and 5-year TCO

**Processing-fee structure (model basis — vendor-published Canadian QSR card rates are not in the cited sources; the structural difference is the decision driver):**

| | Verifone (Carbon 8 / P400) | Clover Station Pro/Duo | PAX A920 Pro |
|---|---|---|---|
| Processing model | **Processor-agnostic** hardware — you choose the acquirer/gateway and negotiate interchange-plus rates independently [6] | **Locked to Fiserv/Clover** processing; rates set by Clover/Fiserv plan, not separable from the hardware [2] | **Processor-agnostic** — runs on whatever acquirer's payment app is loaded [5] |
| 5-yr fee leverage | High — re-negotiable / portable | Low — captive to Fiserv pricing | High — re-negotiable / portable |

**Trade-off:** Clover's hardware list price is typically lower and the all-in-one experience is simpler, but its **processing fees are captive to Fiserv** for the life of the device, so over five years across 25 locations the loss of rate-negotiation leverage usually dominates any hardware saving. **Verifone and PAX are processor-agnostic**, so a QSR doing meaningful card volume can shop interchange-plus pricing and re-tender the processing contract without replacing terminals — the larger lever in a 5-year TCO at chain scale.

**Hardware cost, replacement cycle, French support.** The cited sources do not publish per-unit street prices, a stated replacement-cycle in years, or vendor French-language support hours for Quebec/New Brunswick. As industry-standard planning assumptions (validate with each vendor's Canadian quote): payment terminals of this class are typically refreshed on a **4–5 year cycle** (driven by PCI PTS expiry and EMV/contactless certification updates — the PAX A920 Pro carries **PCI PTS 5.x** [5], and PTS approvals have finite validity), and all three vendors offer Canadian/bilingual merchant support, with Verifone and Clover/Fiserv operating Canadian support desks; confirm guaranteed **French-language** support hours and channels in the contract for both provinces.

**5-year TCO across 25 locations (framework).** Per-platform 5-year cost = (hardware units × unit price) + replacement at the 4–5-year cycle boundary + (annual card volume × effective discount rate × 5) + support. The processing-fee term **dominates** for any real QSR volume, so:

- **Verifone / PAX:** higher up-front hardware in some cases, but **processing fees are negotiable and portable**, minimizing the dominant cost term and allowing re-tender mid-cycle without hardware replacement.
- **Clover:** lower hardware entry, but **processing fees locked to Fiserv** for 5 years across all 25 sites — the captive fee stream typically outweighs the hardware saving, and switching processors later means replacing the fleet.

Because the precise unit prices and negotiated rates are deal-specific, the defensible conclusion is directional and robust: **over 5 years at 25 locations, processor-agnostic Verifone/PAX deliver lower and more controllable TCO than Clover's locked Fiserv processing**, independent of the hardware-price gap.

## 8. Choose-when summary

- **Native Oracle MICROS Simphony dependency (your situation):** Choose **Verifone on the OPI/SPI path** using a **P400-class fixed PED** — the device Oracle names for PCS [1] — rather than the Carbon 8, whose tablet form factor is excluded from Oracle's PED assignment [1]. It is the only native, certified integration, preserves your Simphony KDS and tip-adjustment workflows, and keeps processing fees negotiable [6].
- **Mobile / table-service tip-on-device:** Add **PAX A920 Pro** handhelds — handheld, 5150 mAh battery, built-in printer, full contactless including Interac Flash, processor-agnostic — best where servers take payment at the table, deployed alongside Simphony via gateway/middleware [5].
- **Standalone / non-MICROS, all-in-one simplicity:** **Clover Station Pro/Duo** is the strongest *if you are willing to leave Oracle MICROS*; for a chain committed to Simphony it is excluded by the closed Fiserv/Clover ecosystem and locked processing [4][2].

- Verifone Carbon 8 specs (Verifone datasheet): Merchant tablet processor Intel Quad Core 1.8 GHz, 8" 1280×800 Gorilla Glass display, runs Android. Consumer display 5" 854×480, runs Verifone V/OS, 600 MHz Cortex A9 32-bit RISC. Connectivity Bluetooth 4.2 BLE, WiFi DualBand 802.11ac. Base has 2 USB ports, RJ45 Ethernet, cash drawer port. Optional thermal printer. Triple track MSR.

## Sources

1. [Point-of-Sale User Guide](https://docs.oracle.com/en/industries/food-beverage/simphony-essentials/simsl/t_mgr_proc_assign_payment_device.htm)
2. [Why Clover](https://docs.clover.com/dev/docs/semi-integration-introduction)
3. [carbon8_datasheet_ltr_080717.pdf](https://verifone.co.il/wp-content/uploads/2017/11/carbon8_datasheet_ltr_080717.pdf)
4. [Clover devices—Technical specifications](https://docs.clover.com/dev/docs/clover-devices-tech-specs)
5. [](https://www.pax.us/wp-content/uploads/2023/01/A920-Pro-Data-Sheet_Feb2021.pdf)
6. [](https://verifone.cloud/print/pdf/node/20078)
7. [Per-transaction settings to allow your app to override settings](https://docs.clover.com/dev/docs/using-per-transaction-settings)
8. [Handle offline payments](https://docs.clover.com/dev/docs/handling-offline-payments)