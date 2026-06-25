# Temperature-controlled transport options for a West Africa pharmaceutical/vaccine cold chain

## Executive assessment

For a West Africa cold chain covering long intercity and last-mile routes with 12+ hours of no reliable electricity, the evidence supports a **tiered procurement strategy rather than a single-vendor answer**:

1. **Best fit for high-volume trunk routes:** a diesel/self-powered refrigerated truck or trailer specified to WHO PQS refrigerated-vehicle requirements, using either Thermo King or Carrier Transicold refrigeration, with local service commitments written into the contract. WHO describes refrigerated vehicles as insulated, thermostatically controlled vehicles with dedicated refrigeration; vans/small trucks are typically vehicle-engine powered, while larger trucks/trailers use independent diesel refrigeration and may also have electric standby [1]. WHO PQS refrigerated-vehicle specifications also require non-idle refrigeration for at least 48 hours when a loaded vehicle is parked without mains electricity [2].
2. **Best fit where real-time visibility must survive cellular gaps:** **Carrier Transicold with Lynx Fleet** ranks ahead of Thermo King on the evidence retrieved because Lynx explicitly supports 4G LTE plus satellite switching, with backup battery and solar charging for the telematics device [3]. Thermo King TracKing supports real-time GPRS/GPS monitoring and control, but the fetched Thermo King sources do not show satellite fallback [4].
3. **Best active off-grid vaccine-specific alternative:** the **Toyota Tsusho/B Medical Systems refrigerated vaccine transport vehicle (RVTV)** is the strongest documented active off-grid alternative: WHO PQS E002/001, Toyota Land Cruiser 78 platform, 396 L vaccine refrigerator, 2–8°C operation, and 16 hours of battery autonomy without power [5] [6] [7]. Its integrated remote temperature monitoring uses 2G/3G/4G cellular and GPS, but not satellite in the fetched evidence [6].
4. **Best low-capital/off-grid method for lower-volume 12+ hour legs:** WHO PQS E004 passive cold boxes and vaccine carriers are suitable when the required journey plus safety margin fits the product’s cold/cool life and when staff can reliably prepare coolant packs. WHO notes these passive devices are used primarily for vaccine transport and use ice-packs or other thermal storage materials [8]. WHO guidance shows prequalified large cold boxes with cold life ranges of 53.6–156.0 hours and large vaccine carriers of 30.3–50.2 hours, but cool-water-pack performance can be much shorter [9].
5. **Cost-per-dose cannot be determined by brand from public evidence alone.** Ghana and Benin costing sources provide useful benchmarks and equipment lives, but no retrieved source gives Thermo King vs Carrier vs RVTV purchase price, West Africa route utilization, maintenance cost, fuel burn, or dose-throughput by vendor. Ghana’s costing study reports $5.65 total routine immunization cost per dose, including $1.55 per dose for vaccine collection/distribution/storage and $0.13 per dose for cold-chain maintenance [10]. Those are program benchmarks, not vendor-specific transport prices.

## WHO PQS requirements that should anchor procurement

The procurement specification should treat WHO PQS as the floor, not as an optional feature. WHO’s E002 refrigerated-vehicle category defines refrigerated vehicles as vans, trucks and semi-trailers with insulated, thermostatically controlled cargo compartments and dedicated refrigeration units capable of maintaining a controlled temperature range [1]. For vaccine use, the PQS refrigerated-vehicle specification requires a cloud-based GPS/satellite vehicle tachograph, wired or wireless temperature sensors visible to the driver, audible alarms for temperatures below 2°C or above 8°C, and temperature data captured at least every five minutes using EN13486 or PQS E006/TR03.2-compliant devices [11].

For West Africa, the most important PQS implication is resilience when the vehicle is not plugged in. The WHO refrigerated-vehicle specification states that if a loaded vehicle is parked without mains electricity, provision must be made for non-idle refrigeration to run for at least 48 hours [2]. That requirement is more demanding than the user’s 12+ hour no-electricity journey requirement. It points procurement away from electric-standby-only configurations and toward either independent diesel refrigeration, vehicle-powered systems with validated battery/backup capacity, or passive/active off-grid vaccine systems whose autonomy is documented.

The procurement package should also include service and training requirements. WHO’s E002 specification requires workshop manuals, spare parts, tools, and training; it also requires temperature data review and daily checks as part of operational procedures [11]. Because Accra, Lagos, Dakar and Abidjan do not have equally documented service depth in the sources reviewed, these requirements should be converted into city-by-city service-level obligations.

## Option comparison

| Criterion | Thermo King pharma transport | Carrier Transicold pharma transport | Active off-grid RVTV | Passive cold boxes/carriers + RTM |
|---|---:|---:|---:|---:|
| 12+ hour no-grid reliability | Strong if specified with independent diesel/vehicle-powered refrigeration and PQS-like backup; fetched Lagos service source notes Thermo King V-series direct-drive and T-series independent-engine units with electric standby [12]. | Strong if diesel/self-powered truck or trailer refrigeration is specified; Vector HE 19 has diesel and standby cooling/heating capacities [13]. Vector eCool is promising but fetched source does not state a 12h autonomy guarantee [14]. | Strong for last-mile/off-grid: 16h battery autonomy without power, vehicle charging while driving, AC charging when parked [6] [7]. | Strong for 12h if selected by rated cold/cool life and packed correctly; WHO reports many cold boxes/carriers exceed 12h, but cool-water-pack life can be shorter [9]. |
| Real-time monitoring | TracKing uses GPRS and GPS for real-time tracking, remote setpoint and temperature monitoring, pre-trip reports, EN12830 logging, and 24/7 fleet monitoring options [4]. No satellite fallback found. | Best documented: Lynx Fleet supports real-time map, alerts, probes/door switches, APIs, 4G LTE plus satellite switching, backup battery and solar charging [3]. | Integrated RTMD monitors temperature, door/lid openings and GPS over web; requires 2G/3G/4G coverage and sends SMS/email alarms [6]. No satellite found. | Nexleaf ColdTrace Transport is WHO PQS E006-102; BLE sensor + smartphone app gives up to 1-minute logging, immediate alerts, GPS-tagged trip summaries and cloud analytics [15]. No satellite found. |
| WHO PQS fit | Thermo King pharma range is GDP-qualified, but fetched sources do not show a specific WHO PQS E002 Thermo King vehicle listing [16]. It can be part of a PQS-compliant build if the full vehicle meets E002. | Carrier equipment is suitable for controlled transport, but fetched sources do not show a specific WHO PQS E002 Carrier vehicle listing. It can be part of a PQS-compliant build if the full vehicle meets E002 [13]. | Direct WHO PQS fit: E002-001 listing, valid to 31 May 2027, supplied to AFRO [5]. | Direct WHO PQS category: E004 is for cold boxes/vaccine carriers; Nexleaf transport monitor is PQS E006-102 [8] [15]. |
| Maintenance evidence in target cities | Strongest in Lagos; evidence also for Accra and Dakar; Abidjan only third-party multi-brand evidence. | Strongest in Lagos and documented Dakar contact; Ghana training presence but no fetched Accra dealer; Abidjan only third-party multi-brand evidence. | Vehicle platform is Toyota Land Cruiser 78 and product supplied to AFRO, but fetched sources do not provide city-level RVTV service network [5] [6]. | Lowest refrigeration maintenance burden; still requires coolant-pack freezers, box inspection/replacement, logger support and SOP compliance [9]. |
| Cost per delivered dose | Cannot be sourced by brand; likely favorable only at high utilization because trucks have high fixed costs. | Same; telematics may add monthly service cost but can reduce excursion risk. | Capacity smaller than large trucks but purpose-built for rough last-mile; cost per dose depends heavily on utilization and dose volume. | Lowest capex per route for small loads; labor/SOP risk and lower payload can raise cost on high-volume routes. |

## Reliability during 12+ hour journeys with no electricity access

### Thermo King

Thermo King’s pharma materials support the product’s relevance for pharmaceutical transport, but not a public, source-backed guarantee for every West Africa route. Thermo King states that its PharmaSolutions range includes GDP-qualified equipment for temperature-controlled pharmaceutical transport across trailers, trucks, last-mile delivery and portable refrigeration [16]. Its trailer materials emphasize fully variable airflow for precise pharma temperature control, and its truck range is described as supporting reliability and precise temperature control [16].

For the no-electricity requirement, the stronger evidence comes from WHO’s general vehicle categories and a Lagos service source. WHO states that larger refrigerated trucks and semi-trailers typically have independent diesel-powered refrigeration and that both smaller and larger vehicle types may have electric backup [1]. Integrated Motors Industries in Lagos states that it sells, services and repairs Thermo King V-series direct-drive units and T-series independent-engine units, and that units can be supplied with electric standby so cooling can continue when the vehicle engine or unit engine is off and mains is available [12]. Therefore, Thermo King is a credible 12+ hour no-grid option **if procured as an independent-engine/diesel or otherwise validated self-powered system**, not merely as an electric-standby unit.

### Carrier Transicold

Carrier Transicold’s retrieved product evidence is strongest for trailer-scale diesel/standby refrigeration and telematics. Carrier’s Vector HE 19 page lists diesel and standby cooling/heating capacities across multiple configurations [13]. Carrier also describes its product line as including generator sets, direct-drive and diesel truck units, and trailer refrigeration systems [17].

Carrier’s Vector eCool is the most innovative Carrier option found: it combines all-electric E-Drive refrigeration with an energy recovery and storage system that converts trailer kinetic energy into electricity, recharges from braking/axles, and can be grid-charged in under four hours when parked [14]. However, the fetched source does not state that Vector eCool can maintain vaccine temperatures for 12+ hours without grid access, nor does it establish serviceability in the target West African cities. It should therefore be treated as a pilot or emissions-reduction option only after Carrier provides route-specific autonomy calculations, spare-parts support and failure-mode validation.

### Active off-grid RVTV

The Toyota Tsusho/B Medical Systems RVTV is the most directly documented active off-grid vaccine solution. WHO’s listing identifies it as E002-001, a standard refrigerated vehicle supplied to AFRO, with temperature readout and alarm in the cab, downloadable temperature tracking, programmable temperature control, 24-hour fuel standby/failure backup and electric standby/failure backup [5]. The manufacturer brochure states that the vehicle integrates a refrigerator into a Toyota Land Cruiser 78, has 396 L vaccine storage capacity, operates at +2°C to +8°C, and uses two integrated rechargeable batteries providing 16 hours of autonomy [6]. Toyota states the refrigerator can operate for approximately 16 hours without power and can be charged by the vehicle while driving and from an external source when parked [7].

This makes the RVTV better aligned than conventional truck refrigeration for rough rural last-mile legs and health-post deliveries, though it has much lower payload than a truck or trailer. It is not the best choice for high-volume central-to-regional replenishment unless the route volumes fit its 396 L capacity.

### Passive cold boxes and vaccine carriers

WHO E004 passive devices are non-powered containers used primarily for vaccine transport and temporary storage, using coolant packs or other thermal storage materials [8]. WHO guidance warns that older or damaged containers may have shortened cold life, so route planning must account for condition as well as catalogue rating [9]. It also states that cold/cool/warm life are measured under controlled test conditions and that correct use of coolant packs is critical [9].

For 12+ hour journeys, passive boxes are technically robust when selected correctly. WHO’s guidance reports that large cold boxes have cold life ranges of 53.6–156.0 hours, small cold boxes 57.9–132.3 hours, large vaccine carriers 30.3–50.2 hours, and small vaccine carriers 17.8–21.5 hours; however, cool-water-pack performance is shorter, with large vaccine carriers as low as 6 hours and small vaccine carriers as low as 3 hours [9]. For freeze-sensitive vaccines, procurement should prioritize freeze-preventive boxes or validated cool-pack SOPs rather than simply choosing the longest frozen-icepack cold life.

## Real-time temperature monitoring: cellular vs satellite

Carrier ranks first on communications resilience from the fetched evidence. Lynx Fleet explicitly supports satellite and cellular connectivity, switching between 4G LTE and satellite signals, and can keep the telematics device powered with backup battery and solar charging even when the refrigeration unit is off [3]. It also supports real-time maps, exception alerts for temperature/setpoint/geofence/power/fuel/battery conditions, integration of fuel sensors, temperature probes and door switches, and API/TMS integration [3].

Thermo King ranks second. TracKing is a web-based solution using GPRS and GPS to track shipments in real time; it supports remote monitoring and control of setpoint, return/discharge/load temperatures, pre-trip reporting, scheduled pre-cooling and EN12830 datalogging [4]. Thermo King’s pharma page also says TracKing detects deviations, supports immediate action, provides temperature reports/graphs and includes door sensor data [16]. The limitation is that the retrieved sources show GPRS/GPS but not satellite fallback.

For off-grid alternatives, the Toyota/B Medical RVTV’s integrated RTMD provides real-time monitoring of temperature, door/lid openings and GPS, with web access, SMS/email alarms and a SIM chip for the warranty term; it requires 2G/3G/4G coverage [6]. Nexleaf ColdTrace Transport, a WHO PQS E006-102 logger, uses a BLE sensor inside the vaccine carrier and a smartphone app to deliver up to one-minute logging, immediate alerts and GPS-tagged trip summaries; it has ±0.5°C accuracy, IP67 rating and a battery designed to last up to five years [15]. In Tanzania, ColdTrace Transport generated over 500 hours of data from 146 trips covering 9,450 km, detected excursions on 82% of trips including four WHO freeze alarms, and prompted 85 user actions [18]. This supports its operational value, but it remains phone/cellular dependent for real-time oversight.

## Maintenance capability in Accra, Lagos, Dakar and Abidjan

Maintenance evidence is uneven. The strongest conclusion is that **Lagos is the best-supported city for both major brands**, while **Abidjan is the least clearly documented for authorized service** in the fetched sources.

| City | Thermo King evidence | Carrier Transicold evidence | Procurement implication |
|---|---|---|---|
| Accra | Directory listing for Thermo King Gh. Ltd. at Kanda Highway Extension, North Ridge [19]. | Carrier has a WFP Transport Training Centre page referencing Ghana, but fetched evidence did not identify an authorized Carrier Transicold Accra dealer [20]. | Require named service provider, spare-parts stock and response SLA before award. |
| Lagos | IMI in Oshodi sells, services and repairs Thermo King V-series and T-series units; Sun Group/RTS Nigeria specializes in Thermo King products for vans, trucks and trailers [12] [21]. | Mandilas/Carrier evidence states annual maintenance contracts across Nigeria, qualified engineers and Carrier Transicold capability for refrigerated trucks carrying medicines [22]. | Strongest service base; Lagos can serve as regional maintenance hub if cross-border response is contracted. |
| Dakar | Valea Thermo King Senegal is listed in Dakar [23]. | Carrier contact page lists Senegal among selectable countries and provides a Dakar sales contact [24]. | Reasonable evidence for both brands; still require proof of spare-parts inventory and technician certification. |
| Abidjan | No fetched official Thermo King Abidjan dealer; the only relevant Côte d’Ivoire evidence is Trans-Cold Plus, which lists a +225 contact and says it maintains all brands including Thermo King [25]. | No fetched official Carrier Abidjan dealer; the same Trans-Cold Plus source says it maintains Carrier equipment and offers on-site/remote diagnostics, preventive maintenance, repairs and 24/48h emergency intervention [25]. | Highest service-risk city; do not treat this as proof of authorized Abidjan coverage without contractual authorization, parts and calibration proof. |

The procurement consequence is material. Thermo King’s general pharma source cites a large global service network with more than 500 service points in 75 countries [4], but global density does not prove coverage in Accra, Dakar or Abidjan. Carrier’s global materials similarly establish broad product/service capability, but city-level evidence was incomplete outside Lagos and Dakar [17] [24]. For vaccines, the contract should require calibrated temperature-probe service, refrigeration-unit preventive maintenance, emergency recovery procedure, loaner unit or contingency cold storage, and documented technician training in each city.

## Total cost per vaccine dose delivered under WHO PQS standards

No fetched source provides a defensible vendor-specific cost per vaccine dose for Thermo King, Carrier or the RVTV in West Africa. The correct interpretation of the evidence is therefore: **public sources support cost-model inputs and benchmarks, not a final brand ranking by dollars per dose**.

The strongest cost benchmarks come from Ghana and Benin immunization costing studies. Ghana’s nationwide economic cost table reports total routine immunization cost of $5.65 per routine dose administered, with vaccine collection/distribution/storage at $1.55 per dose and cold-chain maintenance at $0.13 per dose [10]. Ghana’s new vaccine introduction analysis reports $2.45 per dose for total economic delivery cost, split between $1.22 start-up and $1.23 ongoing delivery cost [10]. Benin reports total immunization cost of $3.53 per dose, with vaccine collection/distribution/storage at $0.40 per dose and cold-chain maintenance at $0.02 per dose [26]. These figures show the order of magnitude of immunization logistics costs, but they are program-level historic estimates, not procurement prices for a specific refrigerated vehicle brand.

Useful-life assumptions also come from the costing studies. Ghana used 15 years for walk-in cold rooms, 8 years for refrigerators/freezers, 5 years for cold boxes and 3 years for vaccine carriers [10]. Benin used 5 years for vehicles and spare parts, 8 years for refrigerators, 5 years for cold boxes and 3 years for vaccine carriers [26]. These are reasonable starting points for an economic cost model, but they should be updated with current West Africa pricing, duties, fuel and service costs.

### Capacity-to-dose scenarios

WHO’s vaccine-volume method calculates volume by multiplying doses by packed vaccine volume per dose and converting cm³ to litres [27]. Because vaccine presentations vary, the table below shows capacity scenarios rather than claiming a single dose count.

| Equipment/load | Net vaccine capacity cited | Approx. doses at 5 cm³/dose | 10 cm³/dose | 20 cm³/dose | 50 cm³/dose |
|---|---:|---:|---:|---:|---:|
| Toyota/B Medical RVTV | 396 L [6] | 79,200 | 39,600 | 19,800 | 7,920 |
| WHO example truck loaded with cold boxes | 2,232 L [27] | 446,400 | 223,200 | 111,600 | 44,640 |
| B Medical RCW25 passive box | 20 L [28] | 4,000 | 2,000 | 1,000 | 400 |

These scenarios illustrate the main cost trade-off. A large Thermo King or Carrier truck can reduce fixed cost per dose only if routes are high-volume and utilization is high. The RVTV is likely more expensive per litre than a passive box or truck payload, but it provides validated active refrigeration, rough-road mobility and 16h off-grid autonomy for last-mile routes [6] [7]. Passive boxes have low capital cost and low maintenance burden, but they can become expensive operationally if they require many trips, repeated coolant preparation, high supervision effort, or if excursions cause wastage.

### Cost model required for procurement

For an actual award decision, require each bidder to price the same route and payload assumptions:

- vehicle or container purchase price, import duties, conversion cost and WHO PQS/GDP qualification documentation;
- annual preventive maintenance, emergency repair, spare-parts kit and calibration costs in Accra, Lagos, Dakar and Abidjan;
- fuel or energy use for a 12–24h trip, including standby/no-idle operation;
- telematics hardware, monthly cellular/satellite fees, data retention and alarm escalation service;
- expected trip frequency, backhaul use, payload utilization and packed vaccine volume per dose;
- validated contingency plan for breakdown, border delay, ferry/port delay or cellular outage;
- expected wastage or excursion risk, backed by lane qualification and historical temperature reports.

A simple economic formula should be applied consistently:

**Cost per delivered dose = annualized vehicle/container cost + annual maintenance + fuel/energy + drivers/per diem + telematics + qualification/calibration + contingency cost + expected wastage cost, divided by valid doses delivered within +2°C to +8°C.**

## Ranking by procurement use case

### High-volume national or cross-border trunk routes

**Recommended rank: Carrier or Thermo King diesel/self-powered refrigerated truck/trailer, with Carrier ahead if satellite monitoring is mandatory.**

Both brands can support truck/trailer refrigeration for long journeys when specified with independent diesel/self-powered capability and WHO PQS-like monitoring/backup requirements [1] [13] [12]. Carrier’s decisive advantage from the fetched evidence is Lynx Fleet’s explicit satellite-plus-cellular connectivity [3]. Thermo King remains competitive where local Thermo King service is stronger or where TracKing/GDP qualification is sufficient [4] [16].

### Remote last-mile routes with poor roads and no grid

**Recommended rank: Toyota/B Medical RVTV first, passive PQS boxes second, conventional truck third.**

The RVTV is purpose-built for vaccine transport, has WHO PQS E002-001 status, 396 L capacity and 16h autonomy, and uses a Land Cruiser 78 platform suited to rough terrain [5] [6] [7]. Passive boxes are reliable for 12+ hour legs when correctly packed, but they do not actively recover from heat gain after repeated door openings or poor packing [9]. Conventional trucks may be oversized or less maneuverable for rural health-post routes.

### Lowest-capital small-volume outreach

**Recommended rank: WHO PQS passive cold boxes/carriers plus Nexleaf or equivalent PQS temperature logger.**

Passive boxes require no vehicle refrigeration, can exceed 12h cold life, and have simpler maintenance [8] [9]. Nexleaf ColdTrace Transport adds real-time driver alerts and GPS-tagged trip summaries; Tanzania pilot evidence suggests alerts can trigger corrective actions during transport [15] [18]. This combination is not a substitute for high-volume trunk refrigeration, but it is the most pragmatic low-capital option for small loads.

## Procurement recommendation

Proceed with a **three-lot procurement**:

1. **Lot 1 — Trunk refrigerated vehicles:** accept Thermo King and Carrier builds only if the full vehicle meets WHO PQS E002-like performance, includes non-idle operation for at least 48h without mains, calibrated driver-visible alarms, five-minute logging, and lane qualification. Choose Carrier where satellite fallback is a hard requirement; choose Thermo King where service coverage and lifecycle pricing are superior on the specific lane [2] [3] [4].
2. **Lot 2 — Off-grid vaccine vehicles:** include Toyota/B Medical RVTV or equivalent WHO PQS E002 active vaccine vehicle for rough-road regional-to-district and district-to-health-post routes [5] [6].
3. **Lot 3 — Passive last-mile kits:** procure WHO PQS E004 cold boxes/carriers with freeze-prevention where needed, standardized coolant packs, SOP training, and WHO PQS E006 transport loggers such as ColdTrace Transport for visibility [8] [15] [9].

Do not award on equipment price alone. The most important differentiators for West Africa are: verified no-grid autonomy, satellite or cellular coverage on the actual lanes, city-level maintenance SLAs, calibrated monitoring, and cost per **valid dose delivered**, not cost per kilometre or cost per vehicle.

## Sources

1. [E002: Refrigerated Vehicles | WHO - Prequalification of Medical Products (IVDs, Medicines, Vaccines and Immunization Devices, Vector Control)](https://extranet.who.int/prequal/immunization-devices/e002-refrigerated-vehicles)
2. [https://extranet.who.int/prequal/sites/default/files/document_files/E002%20Refrigerated%20Vehicles%20Product%20Specification%20RV01.2.pdf](https://extranet.who.int/prequal/sites/default/files/document_files/E002%20Refrigerated%20Vehicles%20Product%20Specification%20RV01.2.pdf)
3. [Lynx™ Fleet Telematics | Carrier](https://www.carrier.com/us/en/cold-chain/truck-trailer/lynx-fleet/)
4. [Fleet management](https://europe.thermoking.com/tk-pharmasolutions/fleet-management)
5. [E002-001 | WHO - Prequalification of Medical Products (IVDs, Medicines, Vaccines and Immunization Devices, Vector Control)](https://extranet.who.int/prequal/immunization-devices/e002-001)
6. [BR_LUX_VCC_RVTV__EN_ED042026.pdf](https://www.bmedicalsystems.com/en/wp-content/uploads/sites/2/2026/04/BR_LUX_VCC_RVTV__EN_ED042026.pdf)
7. [First Refrigerated Vehicle for Vaccine in the World to Obtain WHO's Performance, Quality and Safety Prequalification | Corporate | Global Newsroom | Toyota Motor Corporation Official Global Website](https://global.toyota/en/newsroom/corporate/34993722.html)
8. [E004: Cold boxes and vaccine carriers | WHO - Prequalification of Medical Products (IVDs, Medicines, Vaccines and Immunization Devices, Vector Control)](https://extranet.who.int/prequal/immunization-devices/e004-cold-boxes-and-vaccine-carriers)
9. [content](https://iris.who.int/server/api/core/bitstreams/ddf20565-7a3f-4f43-877e-87151fc9a73b/content)
10. [FINALREPORT_GHANA.pdf](https://immunizationeconomics.org/wp-content/uploads/2024/01/FINALREPORT_GHANA.pdf)
11. [E002 Refrigerated Vehicles Product Specification RV01.3.pdf](https://extranet.who.int/prequal/sites/default/files/document_files/E002%20Refrigerated%20Vehicles%20Product%20Specification%20RV01.3.pdf)
12. [Refrigerated Transport Systems - INTEGRATED MOTORS INDUSTRIES](https://imi.com.ng/services-transportation-cooling-units/)
13. [Vector HE 19 - Carrier Transicold trailer refrigeration unit](https://www.carrier.com/truck-trailer/en/eu/products/eu-truck-trailer/trailer/vector-high-efficiency-19/vector-he-19-showcase.html)
14. [Carrier Transicold Launches First Autonomous Electric Refrigeration System – the Vector eCool](https://www.carrier.com/truck-trailer/en/eu/news/news-article/carrier_transicold_launches_first_autonomous_electric_refrigeration_system_the_vector_ecool.html)
15. [E006-102 | WHO - Prequalification of Medical Products (IVDs, Medicines, Vaccines and Immunization Devices, Vector Control)](https://extranet.who.int/prequal/immunization-devices/e006-102)
16. [Thermo King PharmaSolutions Range](https://europe.thermoking.com/tk-pharmasolutions/pharmasolutions-product-range)
17. [New Carrier Transicold Lynx Fleet Mobile App to Enhance Temperature-Controlled Fleet Management](https://www.carrier.com/refrigeration/en/worldwide/news/news-article/new-carrier-transicold-lynx-fleet-mobile-app-to-enhance-temperature-controlled-fleet-management.html)
18. [ColdTrace-Transport-Case-Study.pdf](https://www.nexleaf.org/wp-content/uploads/2023/11/ColdTrace-Transport-Case-Study.pdf)
19. [Thermo King Gh. Ltd. - Yellow Pages Ghana](https://yellowpages.com.gh/business/thermo-king-gh-ltd-446037)
20. [UN World Food Programme Transport Training Centre | Carrier](https://www.carrier.com/us/en/cold-chain/sustainability/un-wfp-transport-training-centre/)
21. [REFRIGERATED TRANSPORT SYSTEMS DIVISION](https://sungroupe.com/refrigerated-transport-systems-division/)
22. [Nigeria’s food refrigeration industry is big, yet untapped – G.M. Cooling Division, Mandilas Group - Businessday NG](https://businessday.ng/interview/article/nigerias-food-refrigeration-industry-is-big-yet-untapped-g-m-cooling-division-mandilas-group/)
23. [VALEA THERMO KING SENEGAL - Froid / Climatisation](https://www.goafricaonline.com/sn/540571-valea-thermo-king-froid-climatisation-dakar-senegal)
24. [Contact Us](https://www.carrier.com/truck-trailer/en/eu/contact-us/)
25. [maintenance - Transcoldplus](https://www.transcoldplus.com/maintenance-2/)
26. [FINALREPORT_BENIN.pdf](https://immunizationeconomics.org/wp-content/uploads/2024/01/FINALREPORT_BENIN.pdf)
27. [content](https://iris.who.int/server/api/core/bitstreams/6f85c5d2-3b44-42ae-b749-780bb9de21b6/content)
28. [Vaccine Transport Box RCW25 - B Medical Systems](https://www.bmedicalsystems.com/en/product/rcw25/)