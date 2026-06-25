# Farm-management and traceability platform choice for a 5,000-farmer coffee cooperative

**Bottom line.** For an independent cooperative in Colombia, Ethiopia, and Indonesia, **Farmforce or Koltiva KoltiTrace MIS are the strongest practical short-list platforms** because the public evidence shows true first-mile farmer/field records, GPS polygon mapping, certification/audit workflows, and offline/low-connectivity field use. **AtSource should be treated as an ofi buyer ecosystem, not a neutral cooperative platform**: it is branded as ofi/olam food ingredients AtSource and fed by ofi field tools, but the public material describes customer-facing sustainability dashboards and ofi-operated farmer systems rather than direct licensing to an independent cooperative [1] [2]. **Fairfood Trace/FairTrace is strong for inclusive low-tech transaction verification via NFC cards, QR and SMS, but weak for EUDR-grade plot polygons and certification audits on the public evidence** [3] [4].

## 1. Headline decision matrix

Weights reflect the cooperative’s requested criteria: basic-phone usability 20%, GPS mapping 25%, certification integration 20%, languages 10%, offline functionality 15%, cost 10%. Scores are 1–5, based only on cited public evidence; “not published” is penalized on cost/language because the cooperative cannot budget or localize confidently from public material.

| Rank | Platform | Basic-phone usability 20% | GPS plot mapping 25% | Certification / buyer fit 20% | Languages 10% | Offline 15% | Cost 10% | Weighted score / 5 | Procurement reading |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | **Koltiva KoltiTrace MIS** | 2 | 5 | 4 | 4 | 5 | 2 | **3.90** | Best EUDR/coffee-origin fit where buyer will co-fund; strong in Indonesia and stated operations in Colombia/Ethiopia [5] [6]. |
| 2 | **Farmforce Origin/Orbit/Connect** | 2 | 5 | 5 | 3 | 4 | 2 | **3.85** | Best neutral first-mile/certification platform if the cooperative needs audit-ready records and shapefile exports; pricing is demo/quote-based [7] [8]. |
| 3 | **Fairfood Trace / FairTrace** | 4 | 1 | 2 | 2 | 4 | 3 | **2.80** | Best low-tech farmer payment/transaction verification add-on; not sufficient alone for EUDR polygon mapping [3] [4]. |
| 4 | **AtSource / ofi AtSource** | 1 | 3 | 4 | 2 | 3 | 1 | **2.65** | Strong if the buyer is ofi and AtSource supply-chain participation is offered; weak as an independent cooperative procurement option [1] [9]. |
| 5 | **Cropin Cloud / Cropin Trace** | 3 | 2 | 2 | 4 | 2 | 2 | **2.55** | Enterprise digital-agriculture stack with farmer engagement channels; public evidence here is thinner on coffee-cooperative EUDR polygons [10] [11]. |
| 6 | **SourceTrace DATAGREEN** | 2 | 2 | 2 | 2 | 2 | 2 | **2.00** | Appears relevant to agriculture traceability, but the fetched public source is too generic for a top-three decision [12]. |
| 7 | **Farmerline Mergdata** | — | — | — | — | — | — | **Not scored** | Not enough fetched source evidence in this record to score fairly. |
| 8 | **Satelligence / Trade in Space** | — | — | — | — | — | — | **Not scored** | EUDR/remote-sensing tools may complement, but no fetched platform evidence in this record supports scoring for smallholder cooperative traceability. |

**Recommendation.** Use **one global first-mile platform** only if the selected vendor can contract directly with the cooperative in all three countries and configure language packs locally. On the evidence above, the preferred path is **Koltiva KoltiTrace MIS where EUDR buyer co-funding is available**, with **Farmforce as the independent-platform fallback**. If AtSource or Fairfood Trace is available only through a specific buyer/vendor ecosystem, do not base the cooperative’s core registry on them; use Farmforce or Koltiva for the core registry and add Fairfood cards only where low-tech payment verification is the inclusion priority.

## 2. Platform-by-platform findings

### AtSource / ofi AtSource

**Identity and access.** AtSource is branded publicly as an ofi/olam food ingredients sustainable sourcing solution. ofi describes AtSource as a sustainability solution that provides traceability to product origin, sustainability metrics, assurance, third-party verification, and dashboards for customers [1]. AtSource was created by Olam Group in 2018 [13], and ofi is described as an operating group born out of Olam, with coffee among its businesses [14].

**Smallholder-facing channels as of 2026-06-23.** Public evidence supports these channels:

| Channel | Public evidence and implication |
|---|---|
| Web dashboard | Yes, buyer/customer-facing: AtSource has dashboard/login and customer sustainability-metrics positioning [15] [13]. |
| Field-agent data capture | Yes, through **ofi Farmer Information System (OFIS)**: ofi field teams collect farm/community infrastructure locations, manage training, and track finance/input distribution/purchases; OFIS has registered **>550,000 farmers in >30 countries** and feeds data into AtSource [2]. |
| Farmer smartphone app | Yes, but through **ofi Direct**, not clearly AtSource itself: farmers can offer produce, set prices, get paid, and access advice/finance/supplies; **>90,000 farmers in 12 countries** use ofi Direct [16]. A coffee traceability case says ofi sourced via a proprietary smartphone app, tagging each transaction with farm location and date [14]. |
| SMS | Not described in the fetched public sources. |
| USSD | Not described in the fetched public sources. |
| IVR | Not described in the fetched public sources. |
| Direct 2G/basic-phone use without smartphone | **No public evidence of direct basic-phone use**; farmers with no internet are described as being supported by ofi field teams using OFIS [2]. |

**GPS and offline.** OFIS collects farm and community infrastructure locations, and ofi Direct geotags/timestamps transactions [2] [16]. ofi Track and Trace integrates on-the-ground digital apps and ERP systems and enables traceability from farm plots to customers, serving as the backbone for ofi’s EUDR compliance [9]. The fetched public sources do not specify polygon boundary walking, GeoJSON/KML/Shapefile export, cached maps, Android offline forms, sync conflict rules, hectare calculations, or positional accuracy.

**Certification/buyer fit.** AtSourceV provides traceability to farmer-group/estate level, risk and performance assessment against reference sustainability requirements, action plans, country-level risk profiles, generic carbon/water footprints, deforestation due diligence, and third-party verification every three years [1]. AtSource+ adds granular supply-chain metrics, primary-data environmental footprints, annual third-party verification, deforestation due diligence, and targeted-program impact stories [13]. This is strong for ofi customers buying AtSource products, but public material does not show independent cooperative licensing.

**Languages and cost.** The fetched public sources do not publish interface languages, cooperative-configurable localization, per-farmer pricing, setup fees, mapping fees, certification-module fees, support fees, or minimum contract size.

### Fairfood Trace / “FairTrace”

**Identity and access.** The fetched sources identify the product as **Trace by Fairfood**, not Fairtrade International. Trace is a blockchain-enabled agri-food platform for farm-to-fork traceability, with a Web Dashboard, Connect Mobile App, Farmer Cards, APIs/Connect, and consumer QR-code storytelling [17] [18].

**Smallholder-facing channels as of 2026-06-23.**

| Channel | Public evidence and implication |
|---|---|
| Web dashboard | Yes: dashboard shows farmer/company/supply-chain counts, maps of farmer/supplier locations, stock, transactions, recent activity and tasks [19]. |
| Android app | Yes for collectors: Farmer Cards are supported only for Android devices, and the Connect app is used by collectors to scan/tap NFC/QR cards [20] [21]. |
| QR/code scanning | Yes: each farmer card has a QR code used to identify the farmer when scanned with the Connect app [20]. Consumer QR storytelling is also part of Trace [18]. |
| NFC | Yes: cards use NFC/Mifare technology and unique Farmer IDs [20]. |
| SMS | Yes, for farmer verification/access to data: farmers can verify payments via QR scan or SMS even where internet and smartphone access are limited [3] [20]. |
| USSD | Not described in fetched public sources. |
| IVR | Not described in fetched public sources. |
| Direct basic-phone use | **Partly**: a farmer can verify/access payment data by SMS, but transaction capture requires a collector’s Android/NFC-capable phone; the farmer does not directly operate the full platform from a 2G handset [3] [20]. |

**Offline and sync.** Connect supports offline onboarding/enrolling of farmers and recording on-site transactions without internet; when connected, the app syncs with Trace and users can access/download transactions online by logging into Trace [18] [4]. The public docs do not specify conflict-resolution rules, offline GPS polygon capture, cached maps, or offline inspection/audit forms.

**GPS and data.** Trace’s base farmer fields include first name, last name, city/village, country, province/state, latitude, longitude, country code, phone/mobile, email, gender, date of birth, household size, and descriptions [4]. The dashboard maps farmer and supplier locations [19]. Public evidence does not show polygon boundary walking, farm-area calculation in hectares, GeoJSON/KML/Shapefile export, satellite/remote mapping, or positional accuracy.

**Deployments.** Connect was tested for more than two years with two farmer cooperatives in Indonesia and digitized close to **15,000 nutmeg transactions** from rural Indonesian islands [4]. Farmer Cards were reported as used by **340 farmers**, especially Indonesian smallholder nutmeg farmers [3]. The fetched sources mention coffee storytelling, including Pure Africa/Moyee, but do not establish a 5,000-farmer coffee cooperative deployment in Colombia, Ethiopia, or Indonesia [18] [22].

**Languages and cost.** Card-printing procedures require verifying the language of the card design [20], but fetched sources do not publish Spanish, Amharic, Oromo, Bahasa Indonesia, English/French interface support, cooperative-configurable localization, per-farmer pricing, card cost, setup, training, mapping, support, or minimum contract size.

### Koltiva KoltiTrace MIS

**Smallholder traceability and deployments.** Koltiva describes KoltiTrace as an end-to-end traceability platform covering farmer profiles, supplier registration/surveys, price notifications, production traceability, verified digital transactions from seed to table, geolocation mapping, deforestation mapping, GHG/LUC analysis, training/coaching records, and producer surveys [23]. For coffee, Koltiva reports **475,000+ coffee producers registered**, **1.1 million hectares** of verified production area, and **470+ businesses** registered, operating across major origins including **Indonesia, Colombia, Ethiopia, Brazil, Uganda and others** [5]. In Indonesia, a cited coffee case reports Adena Coffee digitized traceability for **1,900 smallholders across 30 villages** in Aceh’s Gayo highlands for deforestation-free/EUDR-compliant shipments [5]. In the Americas, Koltiva reports **25,274 coffee producers** digitally validated across eight Latin American countries, including Colombia [24].

**Offline.** Koltiva states KoltiTrace supports offline plot mapping and mobile/web setup for upstream/downstream EUDR compliance [6]. It also states field teams can perform polygon mapping, plot-level risk assessments, supplier screening, and DDS submissions on-site, then sync with a single user action when connectivity is available [25]. Koltiva’s GIS expert says FarmXtension mobile app works offline using pre-downloaded maps and satellite signals, syncing data once connectivity is restored [26].

**GPS mapping.** KoltiTrace supports GPS coordinates or polygon data and recommends polygon mapping for deforestation-risk accuracy [6]. Field agents can walk plot boundaries to collect farm polygons; the platform can use existing GeoJSON plot data with plot locations and sizes for initial EUDR checks [26] [6]. Public material does not state meter-level positional accuracy or external GNSS receiver support.

**Certification and EUDR.** Koltiva explicitly links its services to EUDR, Rainforest Alliance and Fairtrade, stating coffee EUDR requires legally sourced, traceable, deforestation-free shipments and that Rainforest Alliance/Fairtrade add sustainability frameworks [5]. Its EUDR toolkit collects farm polygons and supplier data, groups shipments into traceable compliant batches, flags and resolves geo-risk and land legality, submits DDS to TRACES manually/semi-automatically, and shares DDR with downstream buyers [6].

**Languages and cost.** Koltiva’s global site lists operations in **94 countries**, **21 customer-success offices**, and country/language pages including Thai, Vietnamese, German, Spanish and French [27] [28]. Public fetched material does not establish Amharic, Oromo, or Bahasa Indonesia UI support, although Koltiva is Swiss-Indonesian and has Indonesia operations [5]. Pricing is not published; cost elements mentioned include farmer registration, GPS mapping and platform integration as traceability cost drivers [25].

### Farmforce

**Smallholder traceability.** Farmforce is a first-mile platform, not only enterprise reporting. Farmforce Origin uses a farmer database where field staff register each farmer with photo and GPS-mapped polygons; each farmer receives a unique ID, and family members can be linked [7]. Farmforce records farmer profiles, fields, growing activities, harvest/purchasing, training, payments, surveys, certification data, and barcode/bag-level traceability back to farmer field [7] [29]. Farmforce states it serves NGOs, multinationals and cooperatives and provides web and mobile apps for first-mile data collection [30].

**Offline.** Farmforce Connect is described as a farmer app under pilot, and Farmforce says its solutions are built to run offline [31]. The fetched public evidence does not specify conflict-resolution mechanics, whether maps can be cached, or exactly which inspection forms and GPS workflows work offline.

**GPS mapping.** Farmforce supports GPS-mapped polygons, mobile-app field mapping, shapefile import through the web platform, and shapefile export for Global Forest Watch overlay [29] [8]. Its deforestation-monitoring workflow includes satellite-aided polygon mapping, on-ground quality checks via mobile app, correction for overlaps, duplicate removal, geography and size validation, approval/rejection of polygons, and reports for EUDR compliance [8]. Public material does not state meter-level positional accuracy or external GNSS receiver support.

**Certification and EUDR.** Farmforce explicitly lists Organic, Fairtrade and Rainforest Alliance certifications/auditing on its first-mile platform [30]. Origin says certification requirements can be loaded into Farmforce surveys for digital data collection by field staff using the mobile app; compliance surveys can include Farm Sustainability Assessment questions, branching and automated scoring [7]. Its EUDR/deforestation module tracks mapped fields, checks deforestation, sets certification status such as Rainforest Alliance, and links product bags to mapped deforestation-free plots [8].

**Deployments, languages and cost.** The fetched Farmforce source shows a SaaS deployment across **11 cooperatives** and **nearly 6,000 smallholder farmers** in Côte d’Ivoire cocoa, but not coffee in Colombia/Ethiopia/Indonesia [8]. Farmforce’s homepage states global reach categories for countries, languages, crops, farmers and mapped fields, but the fetched page rendered the figures as zeros, so exact language counts are not usable here [30]. Pricing is not published; public call to action is “Request a Demo” [30].

### Cropin Cloud / Cropin Trace

Cropin’s fetched public pages describe a SaaS-based agtech stack, a traceability/blockchain product, a farm-management product, and farmer engagement in local language through email, SMS, WhatsApp and mobile apps [10] [32] [11]. Cropin’s global presence list includes Indonesia and Ethiopia but not Colombia in the fetched page [33]. The fetched sources here do not establish a coffee-cooperative deployment in Colombia/Ethiopia/Indonesia, offline polygon boundary walking, GeoJSON/KML/Shapefile export, Rainforest Alliance/Fairtrade modules, exact interface languages for Spanish/Amharic/Oromo/Bahasa Indonesia, or pricing.

### SourceTrace DATAGREEN

The fetched SourceTrace page describes an agriculture traceability/value-chain platform and customer references for digital collection and linking of cocoa farmer/farm/community data and end-to-end value-chain traceability [12]. In this evidence record, it is relevant to smallholder traceability but not sufficiently established for the cooperative’s top-tier shortlist: no fetched source here confirms coffee/cooperative deployments in Colombia, Ethiopia or Indonesia, offline GPS polygons, certification modules, exact languages, or pricing.

### Farmerline Mergdata; Satelligence / Trade in Space

These named options should remain watch-list items rather than evaluated finalists in this report because the fetched evidence record does not contain platform-specific sources sufficient to ground the required channel, offline, GPS, certification, deployment, language and cost facts. For EUDR-focused procurement, Satelligence/Trade in Space-type remote-sensing tools may be useful as a risk-screening layer, but the core cooperative system still needs farmer registry, plot geometry, transaction and audit workflows.

## 3. Certification and buyer-data fit

### Rainforest Alliance 2020 Sustainable Agriculture Standard

The cooperative platform must be able to hold, inspect and export at least: member registry/group-management records, farm/plot and geolocation data, internal inspection records, training and remediation data, production estimates, purchase/sales traceability, segregation or mass-balance records where relevant, and transaction-certificate data for buyer claims. In the fetched platform evidence, **Farmforce** fits these workflows best because it explicitly supports certification/auditing for Rainforest Alliance and digital certification surveys by field staff [30] [7]. **Koltiva** also fits well where the buyer’s concern is EUDR plus voluntary standards, because it combines farmer/household profiling, farm surveys, land legality, Rainforest Alliance/FairTrade support, product traceability and DDR/DDS workflows [28] [6]. **AtSource** can support buyer sustainability reporting and third-party verified sourcing claims inside ofi’s ecosystem [1] [13]. **Fairfood Trace** can evidence farmer payments, premiums and transaction histories but would need manual or external tools for RA inspection and polygon datasets [4].

### Fairtrade coffee and trader requirements

The cooperative platform must support member registry, democratic/cooperative records, farm/plot data, production and sales traceability, buyer and invoice references, Fairtrade sales volumes, premium payments and premium-use documentation, and audit evidence. In the fetched platform evidence, **Farmforce** explicitly mentions Fairtrade certification/auditing and premium payments as part of certification recordkeeping [30] [7]. **Fairfood Trace** is useful for payment/premium transparency because its APIs include payments and premiums, and its transaction fields include price, currency, invoice, buyer reference and seller reference [4]. **Koltiva** states support for FairTrade and product traceability from seed to table [28] [23]. **AtSource** provides third-party verified sustainability metrics for customers, but fetched material does not show Fairtrade cooperative audit exports [1].

### EUDR buyer requirement for coffee

The platform must support geolocation tied to the plot of land, traceable batches/shipments, due-diligence statement support, legality checks, deforestation-risk screening, and records showing no deforestation after the **31 December 2020** EUDR cut-off date [26]. The fetched Koltiva geolocation discussion states the EUDR plot-size rule plainly: for plots **larger than 4 hectares**, geolocation must be provided by polygons using latitude/longitude points with **six decimal digits** around the plot perimeter; for plots **smaller than 4 hectares**, operators and non-SME traders may use one latitude/longitude point [26]. Koltiva also states all geolocation data must be converted into **GeoJSON** for EUDR compliance, and reports current application dates of **30 December 2025** for large businesses and **30 June 2026** for small businesses, with penalties up to **4% of EU turnover** and possible market prohibition [26]. On actual platform evidence, **Koltiva** is strongest for EUDR because it collects polygons/supplier data, groups shipments, flags geo-risk and land-legality issues, and supports TRACES DDS submission manually/semi-automatically [6]. **Farmforce** is also strong because it maps polygons, exports shapefiles for Global Forest Watch overlay, validates overlaps/duplicates/size/geography, and generates EUDR reports [8]. **AtSource** is strong only for ofi supply chains because ofi Track and Trace is described as the backbone of ofi EUDR compliance [9]. **Fairfood Trace** lacks public polygon/EUDR evidence and should not be the sole EUDR system [4].

## 4. GPS in mountainous coffee terrain

For Colombia’s Andes, Ethiopia’s highlands and Indonesia’s coffee uplands, the operational risk is the same even when country context differs: steep slopes, canopy, narrow valleys and intermittent mobile networks make single-shot phone coordinates less reliable than walked polygons with validation. The platform implication is direct:

- Prefer **polygon boundary walking plus quality checks** for plots over 4 ha and for any plot near forest boundaries, even when a point would be legally allowable.
- Require the field app to support offline capture in no-connectivity areas, because Koltiva’s East Africa discussion identifies rural connectivity gaps as a barrier and states offline-first systems are needed [25].
- Validate polygons for overlaps, duplicates and size/geography errors; Farmforce explicitly provides these quality checks [8].
- Use pre-downloaded maps where available; Koltiva explicitly states offline operation with pre-downloaded maps and satellite signals [26].
- Treat remote-sensing risk flags as screening, not a substitute for plot walks: Koltiva’s Land Use Tracker is described as using medium-resolution satellite imagery with **10-meter-per-pixel clarity** for land-cover change and deforestation detection [26].
- Meter-level smartphone-GNSS accuracy under canopy/slope and external GNSS receiver support were not stated in the fetched platform sources, so they should be made RFP requirements rather than assumed vendor capabilities.

## 5. Offline functionality and GPS comparison

| Platform | Offline farmer registration / forms | Offline GPS point/polygon | Cached maps | Sync/conflict method | GPS method/export | Positional accuracy |
|---|---|---|---|---|---|---|
| AtSource / OFIS / ofi Direct | OFIS used by field teams for surveys; exact offline mode not stated [2]. | Farm/community locations and geotagged transactions; polygon workflow not stated [2] [16]. | Not stated. | Not stated. | Farm-plot traceability via ofi Track and Trace; export formats not stated [9]. | Not stated. |
| Fairfood Trace | Yes: Connect can onboard farmers and record transactions without internet [18] [4]. | Latitude/longitude fields only; offline GPS capture not specified [4]. | Not stated. | Syncs with Trace when connected; conflict rules not stated [4]. | Point latitude/longitude; dashboard map; no polygon/export evidence [4] [19]. | Not stated. |
| Koltiva KoltiTrace MIS | Yes: field teams can do plot-level risk assessments, supplier screening and DDS submissions offline [25]. | Yes: offline polygon mapping and GPS/polygon collection [6] [26]. | Yes: pre-downloaded maps [26]. | Single user action sync when network returns; conflict rules not detailed [25]. | GPS points, walked polygons, GeoJSON data import/checks, land-use/deforestation overlay; Land Use Tracker imagery is described as **10 m/pixel** for deforestation detection, not as handset positional accuracy [6] [26]. | Handset positional accuracy not stated. |
| Farmforce | Offline built to run offline; exact forms not detailed [31]. | Mobile app maps field locations; offline GPS detail not stated [29] [31]. | Not stated. | Not stated. | GPS polygons, shapefile import, shapefile export to GFW, satellite-aided polygon checks [29] [8]. | Not stated. |
| Cropin | Farmer engagement through SMS/WhatsApp/mobile apps; offline specifics not established here [11]. | Not established in fetched source. | Not stated. | Not stated. | Traceability and farm-management products; export/mapping details not established here [32] [10]. | Not stated. |
| SourceTrace | Agriculture traceability page only; offline specifics not established here [12]. | Not established here. | Not stated. | Not stated. | Not established here. | Not stated. |

## 6. Usability: basic-phone farmers vs smartphone-equipped agents

**Direct basic-phone inclusion is rare.** Among the evaluated platforms, the clearest farmer basic-phone channel is **Fairfood Trace SMS verification**, but even there, full transaction capture depends on collectors using Android/NFC devices [3] [20]. Cropin states farmer engagement can use SMS, WhatsApp and mobile apps, but the fetched evidence does not tie those channels to a coffee cooperative traceability workflow [11]. AtSource does not publish SMS/USSD/IVR channels; ofi’s no-internet farmers are served through field teams using OFIS, and ofi Direct is a mobile app [2] [16]. Farmforce and Koltiva are strongest for smartphone-equipped extension teams, not direct 2G self-service.

**Implications.**

- For low-literacy and basic-phone farmers, **Fairfood cards reduce farmer training burden** because the farmer can verify by SMS or QR and the collector handles Android capture [3].
- For audit and EUDR data quality, **enumerator/extension-agent Android workflows are safer** because trained staff can walk polygons, attach photos, run inspections and correct geometry errors; Koltiva and Farmforce provide the strongest evidence for this model [26] [8].
- For adoption, the cooperative should not require every farmer to own a smartphone. The practical design is: farmer ID/card + SMS receipt/verification where possible; extension-agent Android app for registration, inspections, GPS polygons and purchases.

## 7. Country fit

| Country | Operating fit | Platform implication |
|---|---|---|
| Colombia | Spanish language, Andes coffee terrain, cooperative/exporter structures, and EUDR/RA/Fairtrade buyer demands. Koltiva reports Latin American coffee validation including Colombia [24]. | Use Koltiva if the buyer wants EUDR/DD reports; use Farmforce if the cooperative wants a buyer-neutral audit platform. Require Spanish UI/support in the RFP. |
| Ethiopia | Highland terrain, fragmented smallholder systems, and rural connectivity constraints. Koltiva lists Ethiopia among major coffee origins and East Africa connectivity gaps as a traceability barrier [5] [25]. | Offline-first extension-agent workflows are essential. Require Amharic and Oromo localization in the RFP because fetched vendor sources do not establish them. |
| Indonesia | Bahasa Indonesia context, island/upland connectivity constraints, strong coffee/exporter EUDR pressure. Koltiva reports major Indonesia coffee deployments including 1,900 Gayo smallholders; Fairfood tested Connect with Indonesian cooperatives and nutmeg farmers [5] [4]. | Koltiva has the best Indonesia coffee/EUDR evidence. Fairfood cards are a useful add-on for farmer payment verification, not the core polygon registry. |

A **single global platform** is more practical than a mixed regional core if the same cooperative must maintain one member registry, certification evidence store, and EUDR geometry dataset. A **mixed stack** is practical only as: Koltiva or Farmforce as core registry/GPS/audit system, plus Fairfood cards for payment transparency where farmer smartphone access is low.

## 8. Cost and 3-year TCO

Public fetched sources do not publish the exact unit pricing requested—per farmer per year, per field agent/device, setup/onboarding, training, mapping per plot/hectare, certification module, support, or minimum contract—so the only defensible procurement position is to treat AtSource, Koltiva, Farmforce, Cropin and SourceTrace as **quote-only from public evidence**, and Fairfood Trace as **not publicly priced despite open-source components and Farmer Cards** [30] [25] [18].

Because vendor prices are unpublished, the exact USD TCO requested cannot be computed from the public evidence; the comparable public-price table is therefore:

| Platform | Year-1 implementation cost | Recurring annual cost | 3-year total | Cost/farmer/year | Pricing basis in fetched evidence |
|---|---:|---:|---:|---:|---|
| AtSource / ofi | Quote-only / not published | Quote-only / not published | Quote-only / not published | Quote-only / not published | No independent cooperative pricing in public sources [1]. |
| Fairfood Trace | Quote-only / not published | Quote-only / not published | Quote-only / not published | Quote-only / not published | Open-source components described, but no service/card/unit pricing [18] [20]. |
| Koltiva KoltiTrace MIS | Quote-only / not published | Quote-only / not published | Quote-only / not published | Quote-only / not published | Public source identifies cost drivers—farmer registration, GPS mapping, platform integration—not unit prices [25]. |
| Farmforce | Quote-only / not published | Quote-only / not published | Quote-only / not published | Quote-only / not published | Public pages use “Request a Demo,” with no unit pricing [30]. |
| Cropin | Quote-only / not published | Quote-only / not published | Quote-only / not published | Quote-only / not published | No fetched unit pricing [10]. |
| SourceTrace | Quote-only / not published | Quote-only / not published | Quote-only / not published | Quote-only / not published | No fetched unit pricing [12]. |

The RFP should therefore require vendors to quote the following comparable schedule for **5,000 farmers, 3 years**:

| Cost line | Required vendor quote basis | Why it matters |
|---|---|---|
| Platform subscription | USD/farmer/year and minimum annual fee | Makes AtSource/Koltiva/Farmforce/Cropin comparable. |
| Setup/onboarding | One-time USD for 5,000 farmers, 3 countries, 3 language packs | Prevents hidden implementation cost. |
| Field-agent licenses | USD/user/year or USD/device/year | Extension-agent model is required for polygons/inspections. |
| Mapping | USD/plot or USD/hectare; separate point vs polygon price | Plot count drives EUDR cost. |
| Certification module | USD/year and standards included | RA/Fairtrade audit readiness must not be a custom add-on. |
| Support/training | USD/country/year and included training days | Three-country rollout needs local training. |
| Data export/API | USD/year and formats included | Must include GeoJSON/shapefile/API transaction exports. |

**TCO formula for bid comparison.** For each vendor bid:

- **Year-1 implementation cost** = setup + training + initial mapping + devices + year-1 subscription + year-1 support.
- **Recurring annual cost** = annual subscription + support + certification module + API/export fees + new/remapped plot fees.
- **3-year total** = Year-1 implementation cost + 2 × recurring annual cost.
- **Cost per farmer per year** = 3-year total ÷ 5,000 ÷ 3.

**Sensitivity to plot count and devices.** Require vendors to quote three scenarios: **1 plot/farmer = 5,000 plots**, **2 plots/farmer = 10,000 plots**, and **3 plots/farmer = 15,000 plots**. Require a field-agent device scenario of **1 agent per 100 farmers = 50 devices/users** and **1 agent per 50 farmers = 100 devices/users**. The platform that is cheap per farmer but charges heavily per polygon can become more expensive in Ethiopia/Colombia, where smallholders may manage multiple plots; the platform that includes polygon validation and export in the base license may be cheaper over three years even with a higher subscription.

## 9. Procurement fallback

1. **Preferred: Koltiva KoltiTrace MIS** if the cooperative’s main buyer risk is EUDR and the vendor will contract directly with the cooperative across Colombia, Ethiopia and Indonesia. It has the strongest coffee-origin evidence, explicit polygon/offline/GeoJSON/DDS/TRACES workflows, and Indonesia/Colombia/Ethiopia coffee relevance [5] [6].
2. **Independent-platform fallback: Farmforce** if Koltiva pricing or contracting is buyer-led. It has the clearest neutral first-mile/certification evidence: farmer/field IDs, GPS polygons, shapefile import/export, GFW checks, audit surveys, Fairtrade/Rainforest Alliance references, and bag-level traceability [7] [8].
3. **Budget/inclusion add-on: Fairfood Trace Farmer Cards** where the cooperative needs low-tech farmer payment verification and SMS/QR receipts. Do not use it alone for EUDR because public evidence shows point latitude/longitude, not polygons or hectare calculations [3] [4].
4. **Buyer-ecosystem fallback: AtSource** only where ofi is the buyer and participation in ofi’s AtSource/OFIS/ofi Direct/Track-and-Trace system is offered. It is strong for ofi customer sustainability reporting but not established publicly as an independent cooperative platform [1] [9].

**RFP pass/fail requirements.** Before award, require written vendor confirmation of: Spanish, Amharic, Oromo and Bahasa Indonesia UI/support or configurable translations; Android offline registration, inspection forms and polygon capture; cached maps; GeoJSON export plus shapefile import/export; RA and Fairtrade audit templates; EUDR Article 9 due-diligence data exports; sync conflict rules; external GNSS support or stated accuracy limits; and a 3-year fixed-price quote for 5,000 farmers under the 5,000/10,000/15,000-plot scenarios.

## Sources

1. [Sustainability with AtSource](https://www.ofi.com/en-us/sustainability/sustainability-with-atsource)
2. [ofi's Farmer Information System](https://www.ofi.com/en-gb/sustainability/ofi-farmer-information-system)
3. [Farmer cards -](https://fairfood.org/farmer-cards/)
4. [Trace Connect - Trace Knowledge Center](https://docs.fairfood.org/trace_connect)
5. [Koltiva Empowers 475,000 Coffee Producers Worldwide and Strengthens Indonesia’s Leadership in Sustainable Coffee](https://www.koltiva.com/post/koltiva-empowers-475-000-coffee-producers-worldwide-and-strengthens-indonesia-s-leadership-in-sustai)
6. [Koltiva | Trusted Global Service Provider for EUDR Compliance](https://www.koltiva.com/eudrcompliance)
7. [Farmforce Origin (IMS)](https://farmforce.com/products/information-management-system-ims/)
8. [Deforestation Monitoring - Farmforce](https://farmforce.com/solutions/deforestation-monitoring/)
9. [Supply Chain Excellence Through Track and Trace | ofi](https://www.ofi.com/en-us/sustainability/supply-chain-excellence)
10. [Traceability and Blockchain Systems for Agri Supply Chains](https://www.cropin.com/products/traceability)
11. [Data-Driven Agri-Insurance: A Smarter Future Ahead](https://www.cropin.com/platform/cropin-cloud)
12. [Best Agriculture Traceability Software - Farming Apps, Agri Value Chain and AI Driven Farm Management System](https://www.sourcetrace.com/)
13. [What is AtSource?](https://www.atsource.io/atsource.html)
14. [ofi, Melitta partner for differentiated & traceable coffee](https://www.ofi.com/en-us/news-and-events/press-release/ofi-and-Melitta-partner-to-offer-consumers-differentiated-and-fully-traceable-coffee)
15. [AtSource](https://www.atsource.io/)
16. [ofi Direct](https://www.ofi.com/en-us/sustainability/ofi-direct)
17. [Blockchain tool Trace | Traceability in food supply chains | Fairfood](https://fairfood.org/solutions-for-a-fair-supply-chain/blockchain-tool-trace/)
18. [Trace Knowledge Center - Trace Knowledge Center](https://docs.fairfood.org/introduction)
19. [Dashboard - Trace Knowledge Center](https://docs.fairfood.org/trace_dashboard)
20. [Farmer card - Trace Knowledge Center](https://docs.fairfood.org/farmercard)
21. [Connect -](https://fairfood.org/connect/)
22. [Fairfood farmer cards: Increasing connectivity in the first mile -](https://fairfood.org/resources/fairfood-farmer-cards-trace-transactions/)
23. [KoltiTrace | Koltiva](https://www.koltiva.com/koltitrace)
24. [KOLTIVA Empowers Digital Traceability for Sustainable Coffee: Over 25,000 Coffee Farmers Across the Americas Digitally Validated](https://www.koltiva.com/post/koltiva-empowers-traceability-over-25000-coffee-farmers-across-americas)
25. [Top Barriers to Traceability Adoption in East African Agriculture Sector](https://www.koltiva.com/post/barriers-to-traceability-adoption-in-east-african-agriculture)
26. [Geolocation Challenge: Koltiva's GIS Expert on Supply Chain Transparency](https://www.koltiva.com/post/post-geolocation-data-gis-expert-for-deforestation-monitoring-and-supply-chain-transparency)
27. [Koltiva | Beyond Traceability | Transforming Agriculture Supply Chains](https://www.koltiva.com/)
28. [Global EUDR Compliance Tools by KOLTIVA | Trusted by Over 19,000 Upstream and Downstream Businesses](https://www.koltiva.com/global-eudr-compliance-tools-for-upstream-and-downstream-businesses)
29. [Farmers Database & GPS Mapping - Farmforce](https://farmforce.com/solutions/farmers-database-gps-mapping/)
30. [Farmforce - Tackling Food's First Mile](https://farmforce.com/)
31. [Farmforce Connect](https://farmforce.com/products/farmer-app/)
32. [Farm Management Software for Efficient Farm Operations](https://www.cropin.com/products/farm-management-software)
33. [Cropin | SaaS-based AgTech | Smart Farming App | Agriculture Technology](https://www.cropin.com/)