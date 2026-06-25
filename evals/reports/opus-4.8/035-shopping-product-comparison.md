# Selecting a Farm-Management & Traceability Platform for a 5,000-Farmer Coffee Cooperative (Colombia, Ethiopia, Indonesia)

## Bottom line

For an **independent, multi-origin cooperative that wants to own its own farmer data**, the strongest fit is a neutral third-party field platform — **SourceTrace** or **Koltiva (KoltiTrace)** — layered on top of **Fairtrade's free Plot Insights** tool for EUDR geolocation, rather than **Olam AtSource**. AtSource is not a product an independent cooperative can license: it is ofi's (formerly Olam's) **buyer-facing** sustainability dashboard, usable only by companies sourcing through ofi's own supply chain [1][2]. "FairTrace" is also not a farmer field-mapping app — it is **Fairtrace**, FLOCERT's Fairtrade transaction-reporting/assurance platform, now also the channel through which cooperatives share EUDR geolocation data [3].

Recommended ranking for this cooperative's stated criteria:

| Rank | Platform | Basic-phone use | GPS terrain mapping | RA / Fairtrade integration | Multi-language | Offline | Cost fit | Data ownership |
|---|---|---|---|---|---|---|---|---|
| **1** | **SourceTrace (DATAGREEN)** | Strong — runs on Java feature phones [4] | Polygon + area, GPS-enabled [4] | Built-in ICS templates for Rainforest/UTZ, Fairtrade, Organic, GlobalGAP | 14 languages [4] | Yes — built for no-connectivity [4] | Custom enterprise (not published) | Cooperative-owned |
| **2** | **Koltiva (KoltiTrace)** | App-based (Android) + field agents | Polygon mapping, deforestation/LUC [5] | EUDR-focused; certification-aligned [5] | Indonesia/APAC/LATAM/EMEA ops (multi-language) | Mobile app, field-deployed | Custom enterprise | Cooperative/client-owned |
| **3** | **Farmforce (Origin/Orbit/Connect)** | Field-staff Android; farmer app in pilot | Auto-generated GPS polygons [6] | Program tagging (e.g. Rainforest Alliance) [6] | English documented; deployed multi-country | Yes — built to run offline [7] | Subscription; listed kr330/yr base [8] | Client-owned |
| **4** | **Sourcemap** | No farmer phone tier — importer/ERP tool | Plot maps + 4-layer deforestation scan [9] | EUDR DDS to EU TRACES; cert record-keeping [9] | Support in 8 languages [9] | Cloud/ERP | Enterprise | Buyer-side |
| **—** | **Olam AtSource** | Field staff via OFIS Android; farmers via SMS only [2] | GPS points + farm maps [2] | Due-diligence/ESG dashboards [1] | OFIS app multi-language [2] | OFIS app offline-capable | Tied to ofi sales — not licensable independently [1] | **ofi-controlled** |
| **Free overlay** | **Fairtrade Plot Insights** | Cooperative-staff web tool | Upload/validate plot geolocation; deforestation risk [3] | Native to Fairtrade; shares via Fairtrace [3] | Via 3 producer networks (CLAC/NAPP/Africa) [3] | Web upload | **Free** to certified co-ops [3] | Cooperative-owned, consent-based |

---

## The two named anchors are not what the brief assumes

**Olam AtSource** was created by Olam Group in 2018 and is now ofi's "sustainable sourcing solution." It provides traceability to product origin, **350+ sustainability metrics across 10 topics (12 SDGs)**, supply-chain carbon and water footprints, deforestation due diligence, and third-party verification, delivered through a buyer dashboard in three tiers — **AtSourceV** (traceability to farmer-group level, generic footprints, verification every 3 years), **AtSource+** (granular metrics, advanced footprints from primary data, annual verification), and **AtSource∞** (regenerative programs) [1]. Its field data comes from the **Olam Farmer Information System (OFIS)** — an Android app that records farm GPS points, maps farms and infrastructure, supports an Internal Management System for cooperatives, bag-code traceability, digital payments, and farmer SMS messaging; over 100,000 farmers across 21 countries were registered as of the brochure [2]. **Critically, AtSource is a customer-facing layer over ofi's own supply chain** — a cooperative would have to be selling into ofi to use it, so it is not a neutral platform an independent multi-origin cooperative can license to own its data [1][2].

**"FairTrace"** is **Fairtrace**, FLOCERT's online assurance/transaction-reporting platform for the Fairtrade system, built on "virtual handshakes" between supply-chain partners (one party reports a transaction, the counterpart verifies it). It is not a blockchain/QR consumer-traceability product and not a farmer GPS-mapping app. As of June 2026 it is also the channel by which Fairtrade-certified cooperatives share **EUDR-aligned geolocation data** with EU importers, attached to sales contracts for due-diligence statements [3].

---

## Platform-by-platform on the six criteria

**SourceTrace (DATAGREEN).** The strongest match for "basic phones." DATAGREEN Remote runs on **regular Java-enabled feature phones**, smartphones, tablets and POS devices, and is explicitly engineered for **low-bandwidth or no permanent connection** environments using small data packets, with offline batch and online real-time modes [4]. It captures GPS via the phone, biometrics, 1D/2D barcode/QR scanning and mobile printing, and produces digital maps [4]. It captures data in **14 languages** [4]. For certification it lets farmer organizations run a digital **Internal Control System (ICS)** with ready-to-use templates for **Organic, UTZ/Rainforest Alliance, Fairtrade and GlobalGAP**; Cargill used it to digitize **240,000 cocoa farmers** certified under UTZ, Rainforest Alliance and Fair Trade across three African countries, with a GPS app calculating precise certified-farm area. Pricing is custom/enterprise (not published).

**Koltiva (KoltiTrace).** A management-information platform doing polygon mapping of farm boundaries, deforestation and Land-Use-Change/GHG mapping, surveys, training, and a producer app (FarmCloud) with an eWallet (KoltiPay) [5]. Its EUDR service ("Powering 19,000+ upstream and downstream") covers polygon mapping, shipment risk screening, DDS submission and API-driven ERP integration, with operations across Indonesia, APAC, LATAM and EMEA — directly relevant to the cooperative's three origins [5]. It is app/field-agent based rather than feature-phone native; pricing is custom.

**Farmforce.** Field-staff Android app that auto-generates **GPS-mapped polygons** per field, links them to a unique farmer ID and field ID, and supports deforestation/infrastructure mapping; it tags farmers by program (e.g. Rainforest Alliance) and supports customer-specific attributes [6]. The solutions "are built to run offline" [7]. The farmer-facing **Farmforce Connect** app was in pilot and is **Android/smartphone-based** (designed for low literacy, not for feature phones) [7]. A third-party listing shows a flat-rate annual subscription with a **kr330/year base plan**, English-language listing, and Android/web deployment — but that figure is a nominal listing, not enterprise per-farmer pricing for a 5,000-farmer deployment [8].

**Sourcemap.** An importer/ERP-side EUDR and deforestation tool: it collects supplier mapping and due-diligence data, runs a **4-layer deforestation scan**, generates the **Due Diligence Statement (DDS)** with plot maps and submits to the **EU TRACES** portal for 10–10,000 shipments, with outreach support in **8 languages** [9]. It has no feature-phone farmer tier — it sits above the cooperative on the buyer side.

**GeoTraceability** combined GPS/GIS, mobile and barcoding for smallholder inclusion in commodity supply chains (cocoa, coffee, cotton, nuts, minerals); it was acquired into the Optel Group track-and-trace portfolio, so it is now an enterprise/integrator offering rather than a co-op-licensable product. **Cropster Origin** is a coffee sample/lot traceability and roast-quality tool aimed at exporters/roasters, not a smallholder field-mapping system.

**Fairtrade Plot Insights (free).** Launched June 16, 2026, **free to Fairtrade-certified coffee/cocoa cooperatives**: cooperatives upload farm plot geolocation, receive immediate data-quality feedback and visualization, and get deforestation risk analysis powered by **Satelligence** (partner since 2023). From October 2026 the data can be shared with EU exporters/importers through **Fairtrace**, auto-converted to **EUDR-aligned format** and attached to sales contracts for importer DDS. It sits inside a hub called **Unify**; Fairtrade's three producer networks — **Fairtrade Africa, NAPP (Asia-Pacific), CLAC (Latin America/Caribbean)** — are helping **800+** coffee/cocoa cooperatives adopt it [3].

### GPS polygon accuracy in canopy/mountain terrain
All four field platforms use **phone/handheld GNSS**, so accuracy is governed by the device, not the software. The field convention that matters for compliance is the **plot geometry rule**, set by the buyers' standards rather than the apps: Fairtrade requires **polygon data for any single plot ≥4 hectares** and allows **point data for smaller plots** (Coffee Standard 3.1.6) — smallholder coffee plots in these origins are typically below that threshold, so single-point capture is often acceptable, easing the canopy/mountain accuracy burden. SourceTrace, Koltiva and Farmforce all produce polygon-and-area capture; the GNSS-meter accuracy under canopy depends on the field device used (the platform documentation does not publish a meters figure).

### Rainforest Alliance and Fairtrade certification integration
- **SourceTrace** has the most explicit built-in certification support: ICS templates for **Rainforest Alliance/UTZ and Fairtrade**.
- **Farmforce** tags and filters farmers by program including **Rainforest Alliance** and carries customer-defined attributes [6].
- Rainforest Alliance certification itself runs through the **Rainforest Alliance Certification Platform** with the **MultiTrace** traceability module under the 2020 Sustainable Agriculture Standard; any chosen field platform must hand certified-volume data into that platform.
- **Fairtrade** integration for all platforms ultimately routes through **Fairtrace** (FLOCERT) for transaction assurance, and now **Plot Insights** for geolocation [3].

### EUDR
EUDR enforcement for large and medium operators is now slated for **Dec. 30, 2026** (delayed twice from the earlier 30 Dec 2025 date), requiring each shipment to be traceable to plots **not deforested after Dec. 31, 2020** [3]. EUDR-compliant plot/DDS generation is offered by **Sourcemap** (DDS to TRACES) [9], **Koltiva** (polygon mapping → DDS submission) [5], and **Fairtrade Plot Insights/Fairtrace** (free, EUDR-aligned geolocation export) [3]; SourceTrace and Farmforce capture the underlying polygon data feeding these.

### Multi-language for the three origins
- **SourceTrace:** 14 languages [4] — best documented breadth; Spanish/Bahasa coverage expected, Amharic/Oromo to be confirmed at implementation.
- **Sourcemap:** support in 8 languages [9].
- **OFIS/AtSource:** multi-language Android app [2].
- **Koltiva:** operations spanning LATAM, APAC and EMEA imply Spanish and Bahasa Indonesia support [5].
- **Farmforce:** third-party listing shows English [8]; multi-country deployments suggest broader configuration in practice.
- **Plot Insights:** delivered through CLAC (Spanish), NAPP (Bahasa/Asian languages) and Fairtrade Africa networks [3].
Amharic and Oromo coverage is the least documented across all platforms and should be a procurement question for the Ethiopia rollout.

---

## Cost for a 5,000-farmer cooperative

Published per-farmer pricing is thin: SourceTrace, Koltiva and Sourcemap quote enterprise/custom contracts, not list prices. Only two anchored figures exist:

- **Fairtrade Plot Insights: free** to Fairtrade-certified cooperatives — **US$0** for the geolocation/EUDR layer for all 5,000 farmers [3].
- **Farmforce: kr330/year** base plan on a third-party listing [8]. Taken literally as a per-organization flat rate that is roughly **US$30/year**; it is almost certainly a placeholder, not the price of onboarding and mapping 5,000 farmers, which in practice is a custom enterprise contract.

Because the field platforms do not publish per-farmer rates, a defensible budgeting approach is:

1. Adopt **Plot Insights (free)** for EUDR geolocation and Fairtrace sharing now — **$0** [3].
2. Request quotes from **SourceTrace** and **Koltiva** for the full 5,000-farmer field deployment; budget a **custom annual subscription plus one-time onboarding/mapping cost**, which the sources do not disclose as a per-farmer figure.

The honest conclusion: a precise total-annual-cost comparison across the leading candidates cannot be computed from the vendors' published material, so the cooperative should treat **Plot Insights as the zero-cost baseline** and obtain written per-farmer quotes from SourceTrace and Koltiva before committing.

---

## Tension: AtSource vs. neutral platforms — who owns the farmer data

AtSource's design embeds a structural conflict for an independent cooperative. It is a **buyer's dashboard over ofi's supply chain**: the farmer data feeding it (via OFIS) is collected and held within ofi's system, and the analytics serve ofi's customers' due-diligence and ESG reporting [1][2]. A cooperative using it is effectively contributing its farmer and plot data to a counterparty that also buys its coffee — and is locked to selling through that counterparty to benefit. For a multi-origin cooperative selling to several buyers, that is the opposite of data sovereignty.

**Neutral third-party platforms (SourceTrace, Koltiva, Farmforce)** are licensed to the cooperative or its sponsor, so the cooperative retains its own farmer/plot database and can share defined slices with any buyer or certifier [4][5][6]. **Plot Insights** is explicitly **consent-based and cooperative-held**, with traders/brands getting access only in later phases [3]. The recommendation therefore favors a neutral field platform plus Plot Insights precisely so the cooperative — not a single buyer — controls and re-uses its geolocation and compliance data.

---

## Fallback if the preferred paid platform exceeds budget

1. **Start with the free tools.** Adopt **Fairtrade Plot Insights** (free, EUDR-aligned, cooperative-owned) for plot geolocation and **Fairtrace** for transaction reporting [3]. This alone secures EUDR market access for EU-bound coffee at zero licensing cost.
2. **Lean on the producer networks.** Fairtrade's **CLAC, NAPP and Fairtrade Africa** are actively onboarding 800+ cooperatives — a donor/network-subsidized path to data collection and validation support [3].
3. **Stage the rollout.** Begin with field-staff GPS polygon capture (offline Android) in one origin, prove the workflow, then expand. SourceTrace's feature-phone capability lets the cooperative reach members without smartphones during the staged build [4].
4. **Negotiate enterprise/NGO pricing** with SourceTrace or Koltiva once the free baseline is running, rather than buying full licensing upfront.

---

## Origin-specific deployment

- **Colombia (FNC).** The strongest existing infrastructure. The **Federación Nacional de Cafeteros** runs the **Cédula Cafetera/SICA** grower registry (~540,000 coffee growers) and has launched a platform exposing **coffee-plot (lote) coordinates** as the principal requirement to keep exporting to Europe under EUDR [10]. A cooperative here may be able to draw on or align with FNC geolocation data rather than mapping from scratch; connectivity is comparatively good. **CLAC** supports Plot Insights adoption in the region [3].
- **Ethiopia.** The weakest documented platform footprint and the **largest language gap** (Amharic/Oromo coverage is unconfirmed across every platform). Lower rural connectivity makes **SourceTrace's feature-phone + offline** design the most robust field choice [4], with **Fairtrade Africa** as the network support channel [3].
- **Indonesia.** **Koltiva is headquartered/rooted in Indonesia** with established operations there [5], giving the strongest local footprint and Bahasa support; **NAPP** supports Plot Insights adoption across Asia-Pacific [3]. Connectivity is mixed across coffee islands, so offline capability remains essential.

The cross-origin implication: no single vendor is uniformly strongest in all three countries, which reinforces choosing a **neutral, offline-capable, multi-language field platform** (SourceTrace for connectivity/feature-phone resilience, Koltiva for Indonesia depth) **plus the free Plot Insights/Fairtrace layer** for EUDR — rather than a buyer-tied system like AtSource.

## Sources

1. [What is AtSource?](https://www.atsource.io/atsource.html)
2. [New-OFIS-Brochure-1.pdf](https://www.olamgroup.com/content/dam/olamgroup/files/uploads/2017/07/New-OFIS-Brochure-1.pdf)
3. [Fairtrade Launches Free EUDR Geolocation Tool for Coffee Cooperatives](https://dailycoffeenews.com/2026/06/16/fairtrade-launches-free-eudr-geolocation-tool-for-coffee-cooperatives/)
4. [SourceTrace | eService Everywhere | Mobile data management](https://sourcetrace.com/the-platform/)
5. [KoltiTrace | Koltiva](https://www.koltiva.com/koltitrace)
6. [Farmers Database & GPS Mapping - Farmforce](https://farmforce.com/solutions/farmers-database-gps-mapping/)
7. [Farmforce Connect](https://farmforce.com/products/farmer-app/)
8. [Farmforce Reviews Jun 2026: Pricing & Features | SoftwareWorld](https://www.softwareworld.co/software/farmforce-reviews/)
9. [EUDR Compliance & Deforestation Monitoring | Sourcemap](https://www.sourcemap.com/solutions/eudr)
10. [FNC lanzará plataforma que dará acceso a coordenadas de lotes](https://federaciondecafeteros.org/listado-noticias/fnc-lanzara-plataforma-que-dara-acceso-a-coordenadas-de-lotes-cafeteros-principal-requisito-para-continuar-exportando-a-europa/)