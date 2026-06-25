# Bitcoin institutional asset analysis as of 2025-01-15

**Bottom line.** Bitcoin’s institutional demand impulse materially exceeded miner issuance over 2024-10-01 to 2025-01-15: IBIT alone took in **$16.013bn**, equal to **5.42×** estimated miner sell pressure, while all U.S. spot Bitcoin ETFs took in **$17.620bn**, or **5.97×** miner sell pressure. The Hash Ribbon was positive on 2025-01-15 — 30D hash-rate MA **788.56 EH/s** vs 60D **774.50 EH/s**, spread **+14.06 EH/s** — indicating no active miner capitulation. The main nuance is that IBIT weekly flows had only a weak contemporaneous correlation with same-week Bitcoin returns (**+0.079**), while aggregate U.S. spot ETF flows correlated more clearly (**+0.381**), so price action was more consistent with systemwide ETF demand than with IBIT alone. [1][2][3]

| Dimension | Result | Interpretation |
|---|---:|---|
| Hash Ribbon on 2025-01-15 | 30D MA **788.56 EH/s** > 60D MA **774.50 EH/s**; spread **+14.06 EH/s** | Positive ribbon; no active miner capitulation signal. [2] |
| IBIT net flows, 2024-10-01 to 2025-01-15 | **+$16.013bn** | Large direct institutional absorption via BlackRock’s spot Bitcoin ETF; public weekly table below is from Farside daily data, cross-checked to BlackRock SEC aggregate Q4 capital transactions. [1][4][5] |
| All U.S. spot Bitcoin ETF net flows | **+$17.620bn** | Aggregate ETF channel exceeded IBIT by $1.607bn, despite some weeks when non-IBIT ETFs offset IBIT inflows. [1] |
| Estimated miner issuance / sell pressure | **34,650 BTC**, **$2.953bn** | Conservative assumption: 450 BTC/day issued and miners sell 100% of subsidy at average weekly BTC price. [3][4] |
| Absorption ratio | IBIT **5.42×**; all ETFs **5.97×** | Institutional ETF demand more than offset modelled miner issuance over the window. [1][3] |
| Contemporaneous weekly correlation with BTC returns | IBIT **+0.079**; all ETFs **+0.381** | IBIT alone was a poor weekly timing indicator; broader ETF demand tracked price better. [1][3] |
| Conservative 2030 valuation range | Bear **~$68k**, base **~$185k**, bull **~$395k** | Demand-elasticity model tied to institutional allocation and digital-gold penetration; deliberately below ARK’s higher $300k/$710k/$1.5m 2030 benchmark cases. [6][7] |

## 1. Hash Ribbon status as of 2025-01-15

Hash Ribbons compare daily simple moving averages of network hash rate: miner capitulation is conventionally flagged when the **30D MA falls below the 60D MA**, and recovery is flagged when the **30D MA crosses back above the 60D MA**; a full “buy” signal also requires price confirmation. [8]

Using the fetched daily hash-rate series, the 2025-01-15 reading was:

| Date | Daily hash rate | 30D hash-rate MA | 60D hash-rate MA | Spread | Status |
|---|---:|---:|---:|---:|---|
| 2025-01-15 | **847.123 EH/s** | **788.56 EH/s** | **774.50 EH/s** | **+14.06 EH/s** | Positive ribbon; no active miner capitulation. [2] |

The recent ribbon history inside the flow window matters for interpretation: the ribbon crossed bearish on **2024-10-08** and back bullish on **2024-10-12**. By 2025-01-15, therefore, the signal was not a fresh capitulation event but a post-recovery, expansionary hash-rate state. [2]

## 2. IBIT weekly net inflows, BTC price movement, and miner sell pressure

The requested weekly IBIT flow history is calculated from Farside’s public daily U.S. Bitcoin ETF flow table, which reports IBIT and peer ETF net flows in **US$m** and includes a real-time-data warning that the table may contain errors or inaccuracies. BlackRock SEC filings provide official aggregate capital-share activity; the Q4 2024 aggregate derived from BlackRock’s Q3 and full-year filings is directionally consistent with the Farside daily roll-up used for week-by-week timing. [1][4][5]

BlackRock official filings anchor the aggregate scale: at **2024-09-30**, IBIT had **$23.330686624bn** net assets, **644.0m** shares outstanding, and **366,448 BTC** at fair value; at **2024-12-31**, it had **$51.519566547bn** NAV, **970.44m** shares outstanding, and **551,918 BTC** at fair value. BlackRock reported FY 2024 share creations of **982.160m** shares and redemptions of **11.724m** shares, with capital-share contributions of **$37.829056553bn** and redemption distributions of **$541.725936m**; subtracting Q3 YTD figures implies Q4 2024 net capital-share transactions of **$15.756942174bn**. [4][5]

Miner sell pressure is modelled conservatively as **100% of block subsidy sold**, using post-April-2024 subsidy **3.125 BTC/block** and an average **10-minute** block interval, or **450 BTC/day**. USD miner pressure is 450 BTC/day times the average BTC close for each weekly segment. [3][4]

| Week ending | Period included | IBIT flow (US$m) | All U.S. spot BTC ETF flow (US$m) | BTC return | Est. miner sell pressure (US$m) | IBIT/miner ratio | All ETF/miner ratio |
|---|---|---:|---:|---:|---:|---:|---:|
| 2024-10-04 | Oct 1–Oct 4 | 63.1 | -362.9 | 2.02% | 109.9 | 0.57× | -3.30× |
| 2024-10-11 | Oct 7–Oct 11 | 140.6 | 308.8 | 0.33% | 138.5 | 1.02× | 2.23× |
| 2024-10-18 | Oct 14–Oct 18 | 1,141.1 | 2,129.6 | 3.59% | 151.4 | 7.54× | 14.06× |
| 2024-10-25 | Oct 21–Oct 25 | 1,147.0 | 997.6 | -1.08% | 151.2 | 7.59× | 6.60× |
| 2024-11-01 | Oct 28–Nov 1 | 2,148.9 | 2,220.2 | -0.61% | 159.6 | 13.46× | 13.91× |
| 2024-11-08 | Nov 4–Nov 8 | 1,251.1 | 1,631.2 | 12.88% | 164.4 | 7.61× | 9.92× |
| 2024-11-15 | Nov 11–Nov 15 | 1,892.1 | 1,671.0 | 2.67% | 200.5 | 9.44× | 8.33× |
| 2024-11-22 | Nov 18–Nov 22 | 2,053.5 | 3,353.1 | 9.34% | 213.6 | 9.61× | 15.70× |
| 2024-11-29 | Nov 25–Nov 29 | 405.3 | -135.1 | 4.68% | 213.4 | 1.90× | -0.63× |
| 2024-12-06 | Dec 2–Dec 6 | 2,630.8 | 2,729.7 | 4.23% | 219.2 | 12.00× | 12.45× |
| 2024-12-13 | Dec 9–Dec 13 | 1,514.3 | 2,167.1 | 4.13% | 223.6 | 6.77× | 9.69× |
| 2024-12-20 | Dec 16–Dec 20 | 1,446.5 | 457.2 | -7.80% | 228.4 | 6.33× | 2.00× |
| 2024-12-27 | Dec 23–Dec 27 | -21.1 | -377.6 | -0.55% | 217.2 | -0.10× | -1.74× |
| 2025-01-03 | Dec 30–Jan 3 | -139.5 | 256.0 | 5.90% | 214.0 | -0.65× | 1.20× |
| 2025-01-10 | Jan 6–Jan 10 | 497.6 | 312.8 | -7.23% | 216.6 | 2.30× | 1.44× |
| 2025-01-17 | Jan 13–Jan 15 partial | -158.1 | 261.2 | 6.34% | 131.2 | -1.21× | 1.99× |
| **Total** | **Oct 1–Jan 15** | **16,013.2** | **17,619.9** | — | **2,952.7** | **5.42×** | **5.97×** |

The flow/price relationship was positive but not decisive. Across 16 weekly observations, the correlation between **IBIT weekly net flows** and same-week BTC close-to-close returns was only **+0.079**; the correlation between **all U.S. spot BTC ETF flows** and BTC returns was **+0.381**. In practice, the strongest price weeks, such as the week ending **2024-11-08** with BTC **+12.88%**, did have large inflows, but several high-IBIT-flow weeks had negative BTC returns, including **2024-11-01** and **2024-12-20**. [1][3]

## 3. Supply-absorption model

The requested model defines “new supply” as **miner issuance + ETF creation/redemption net flows**. Economically, ETF inflows are demand for Bitcoin rather than native protocol issuance, so the useful absorption statistic is **ETF inflows ÷ miner issuance/sell pressure**; the signed “new supply” formulation is still reproducible by converting ETF flows into BTC at average weekly BTC price and adding them to miner issuance. [1][3]

On that basis, institutional inflows more than offset modelled miner selling over the window:

| Measure, 2024-10-01 to 2025-01-15 | IBIT only | All U.S. spot BTC ETFs |
|---|---:|---:|
| Net ETF flows | **$16.013bn** | **$17.620bn** |
| Estimated miner issuance | **34,650 BTC** | **34,650 BTC** |
| Estimated miner sell pressure | **$2.953bn** | **$2.953bn** |
| Absorption ratio: ETF inflows ÷ miner sell pressure | **5.42×** | **5.97×** |
| Weekly correlation: flow vs BTC return | **+0.079** | **+0.381** |
| ETF flow converted to BTC at weekly average prices | **190,252 BTC** | **210,888 BTC** |
| “New supply” under requested signed definition: miner BTC + ETF-flow BTC | **224,902 BTC** | **245,538 BTC** |

This supports a clear conclusion: **yes, institutional ETF inflows historically offset miner issuance during this window**, and by a large margin. The conclusion is strongest for the aggregate U.S. spot ETF complex, because IBIT alone occasionally diverged from both total ETF flows and BTC returns — for example, IBIT was positive in the week ending **2024-12-20**, but total ETF flows were only **$457.2m** and BTC fell **7.80%**. [1][3]

The broader institutional backdrop was consistent with that absorption result. CoinShares reported that digital asset investment products had record **$44.2bn** global inflows in 2024, almost **4×** the prior 2021 record; U.S. spot-based ETFs saw **$44.4bn** of inflows, and Bitcoin products saw **$38bn**, equal to **29%** of Bitcoin product AUM. Chainalysis similarly described the January 2024 U.S. spot Bitcoin ETP launch as transformative for institutional interest and inflows, while noting the ETP effect cannot be fully isolated from other market drivers. [9][10]

## 4. Bitcoin as an institutional asset: investment characteristics and three-case valuation model

Bitcoin is best analysed as a scarce, non-cash-flow asset whose expected return depends primarily on adoption and demand elasticity, not discounted earnings or coupons. BlackRock’s December 2024 portfolio-sizing framework states that Bitcoin has **no underlying cash flows** and that expected return depends mainly on future adoption; for investors with appropriate governance and risk tolerance, BlackRock frames **1–2%** as a reasonable multi-asset allocation range, with allocations above **2%** increasing portfolio risk disproportionately. [6]

Regulation and macro conditions are the key non-flow sensitivities. The SEC approved listing and trading of spot Bitcoin ETP shares on **2024-01-10**, improving regulated access, but the SEC Chair explicitly stated that the approval did not approve or endorse Bitcoin itself and highlighted volatility and misuse risks. After the analysis date, the U.S. policy backdrop became more constructive: a **2025-01-23** White House order supported responsible digital-asset growth and requested a federal framework, SEC **SAB 122** effective **2025-01-30** rescinded the SAB 121 crypto-safeguarding accounting guidance, and a **2025-03-06** White House order created a Strategic Bitcoin Reserve using forfeited government BTC. [11][12][13][14]

The macro backdrop at the analysis date was still restrictive: the FOMC maintained the federal funds target range at **4.25%–4.50%** on **2025-01-29**, said inflation remained somewhat elevated, and continued balance-sheet runoff. That makes falling real rates/liquidity easing a bull-case sensitivity and sticky inflation/high terminal rates a bear-case sensitivity. [15]

### Scenario framework and valuation range

The scenario model uses ARK’s published 2030 TAM anchors — **~$200tn** global market portfolio ex-gold, **~$18tn** gold market cap, and deterministic Bitcoin supply approaching **~20.5m BTC** by 2030 — but applies more conservative penetration rates than ARK’s published bear/base/bull targets of **~$300k / ~$710k / ~$1.5m**. ARK’s own institutional-investment penetration assumptions are **1% / 2.5% / 6.5%** and digital-gold penetration assumptions are **20% / 40% / 60%**; the model below deliberately uses lower bear/base assumptions and caps the bull institutional allocation at BlackRock’s **2%** risk-budget level. [6][7]

Formula:

**BTC price = [(Institutional allocation % × $200tn) + (Digital-gold penetration % × $18tn) + Sovereign/other demand] ÷ 20.5m BTC**

Institutional demand elasticity:

- **1 bp** of the $200tn institutional TAM = **$20bn** demand = **~$976/BTC** on 20.5m BTC supply.
- **25 bp** of institutional allocation = **$500bn** demand = **~$24.4k/BTC**.
- **1.0%** institutional allocation = **$2.0tn** demand = **~$97.6k/BTC**.

| Case | Adoption / institutional demand | Regulatory environment | Macro rates / liquidity | Model assumptions | Network value | Implied BTC price |
|---|---|---|---|---|---:|---:|
| **Bear** | ETF channel persists but adoption stalls below BlackRock’s 1–2% range | Access remains available but rulemaking/frictions limit bank and advisor adoption | Sticky inflation; restrictive real rates; risk appetite weak | **0.25%** institutional allocation; **5%** digital-gold penetration; **$0** sovereign/other demand | **$1.4tn** | **~$68k** |
| **Base** | Gradual institutional adoption reaches the low end of BlackRock’s range | Spot ETF access remains durable; custody/accounting clarity improves incrementally | Rates ease gradually; liquidity neutral-to-supportive | **1.0%** institutional allocation; **10%** digital-gold penetration; **$0** sovereign/other demand | **$3.8tn** | **~$185k** |
| **Bull** | Institutional adoption reaches BlackRock’s 2% risk-budget cap; ETF demand remains structurally positive | U.S. framework becomes clearer; reserve/sovereign narrative strengthens | Falling real rates and stronger liquidity support scarce assets | **2.0%** institutional allocation; **20%** digital-gold penetration; **$0.5tn** sovereign/other demand | **$8.1tn** | **~$395k** |

**Recommendation / classification.** On the evidence above, Bitcoin should be classified as a **scarce institutional alternative asset with positive but highly adoption-sensitive expected return**, not as an income asset or a pure inflation hedge. The base-case valuation is **~$185k/BTC** under a conservative 2030 demand model; the defensible range is **~$68k–$395k**, with upside/downside dominated by institutional allocation elasticity of **~$976/BTC per 1 bp** of the $200tn institutional TAM. Given BlackRock’s risk-budget framing, the institutional-quality portfolio implementation is a **1% strategic allocation** for eligible multi-asset portfolios with explicit drawdown tolerance, rising toward **2%** only under bull-case evidence of durable ETF inflows, clearer regulation, and lower macro-rate headwinds. [6][7][15]

## Appendix: data sources, assumptions, and reproducibility

### Source URLs and query inputs

| Data item | Source / URL | Use in model |
|---|---|---|
| Hash Ribbon definition | LookIntoBitcoin Hash Ribbons: `https://www.lookintobitcoin.com/charts/hash-ribbons/` | Defines 30D/60D hash-rate MA capitulation and recovery interpretation. [8] |
| Hash-rate series | SatoshiMacro/mempool JSON: `https://satoshimacro.com/assets/data/btc-hashrate.json` | Calculates 2025-01-15 30D and 60D hash-rate MAs. [2] |
| IBIT and U.S. spot ETF daily flows | Farside: `https://farside.co.uk/bitcoin-etf-flow-all-data/` | Daily IBIT and total ETF flows in US$m; weekly aggregation. [1] |
| BTC prices | Yahoo chart API: `https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?period1=1727740800&period2=1736899200&interval=1d` | BTC weekly close-to-close return and average price for miner USD pressure. [3] |
| IBIT official aggregate data | SEC IBIT 2024 10-K: `https://www.sec.gov/Archives/edgar/data/1980994/000143774925006260/bit20241231_10k.htm`; SEC IBIT Q3 10-Q: `https://www.sec.gov/Archives/edgar/data/1980994/000143774924033812/bit20240930c_10q.htm` | Cross-checks Farside scale with official creations/redemptions, NAV, shares, and BTC held. [4][5] |
| ETF regulatory approval | SEC statement, 2024-01-10: `https://www.sec.gov/newsroom/speeches-statements/gensler-statement-spot-bitcoin-011023` | Regulatory access and risk framing. [11] |
| Portfolio sizing | BlackRock, “Sizing bitcoin in portfolios”: `https://www.blackrock.com/institutions/en-us/insights/thought-leadership/portfolio-design/sizing-bitcoin-in-portfolios` | 1–2% allocation framework; no-cash-flow/adoption-driven return framing. [6] |
| Valuation TAM benchmarks | ARK, “ARK’s Price Target For Bitcoin In 2030”: `https://www.ark-invest.com/articles/valuation-models/arks-bitcoin-price-target-2030` | $200tn institutional TAM, $18tn gold TAM, ~20.5m BTC supply, and ARK benchmark targets. [7] |
| Fund-flow context | CoinShares Jan. 6 2025 fund-flow note | 2024 global and U.S. spot ETF inflow context. [9] |
| Adoption context | Chainalysis North America 2024 report | ETP launch impact on institutional adoption, with isolation caveat. [10] |
| Macro rates | FOMC Jan. 29 2025 statement: `https://www.federalreserve.gov/monetarypolicy/files/monetary20250129a1.pdf` | Restrictive-rate scenario input. [15] |
| 2025 regulatory developments | White House Jan. 23 2025 EO; SEC SAB 122; White House Mar. 6 2025 Strategic Bitcoin Reserve EO | Forward scenario regulation assumptions. [12][13][14] |

### Core assumptions

- Flow window: **2024-10-01 through 2025-01-15**.
- Weekly grouping: weeks ending Friday; first and last weeks are partial.
- Farside flows: US$m; positive values are net creations/inflows, negative values net redemptions/outflows. [1]
- Miner issuance: **3.125 BTC/block × 6 blocks/hour × 24 hours/day = 450 BTC/day**. [4]
- Miner sell pressure: assumes miners sell **100%** of subsidy; excludes transaction fees, miner treasury management, hedging, OTC inventory, and exchange float effects.
- BTC returns: close-to-close over each weekly segment from the Yahoo BTC-USD daily close series. [3]
- Valuation supply: **20.5m BTC** by 2030, consistent with ARK’s deterministic supply assumption; no active-float uplift is applied, even though ARK notes liveliness near **60%** and roughly **40%** vaulted supply. [7]

### Spreadsheet formulas

Assume daily columns: `Date`, `IBIT_USDm`, `TotalETF_USDm`, `BTC_Close`.

```text
WeekEnd = Date + MOD(6 - WEEKDAY(Date,2), 7)
IBIT_USDm_week = SUMIFS(IBIT_USDm, WeekEnd, w)
AllETF_USDm_week = SUMIFS(TotalETF_USDm, WeekEnd, w)
BTC_Return_week = (BTC_Close_End / BTC_Close_Start) - 1
AvgBTC_week = AVERAGEIFS(BTC_Close, WeekEnd, w)
CalendarDays_week = EndDate - StartDate + 1
MinerBTC_week = 450 * CalendarDays_week
MinerSellUSDm_week = MinerBTC_week * AvgBTC_week / 1,000,000
IBITFlowBTC_week = IBIT_USDm_week * 1,000,000 / AvgBTC_week
AllETF_FlowBTC_week = AllETF_USDm_week * 1,000,000 / AvgBTC_week
NewSupplyBTC_IBIT_user_definition = MinerBTC_week + IBITFlowBTC_week
NewSupplyBTC_AllETF_user_definition = MinerBTC_week + AllETF_FlowBTC_week
IBIT_AbsorptionRatio = IBIT_USDm_week / MinerSellUSDm_week
AllETF_AbsorptionRatio = AllETF_USDm_week / MinerSellUSDm_week
Correlation_IBIT_vs_BTC = CORREL(weekly_IBIT_USDm_range, weekly_BTC_Return_range)
Correlation_AllETF_vs_BTC = CORREL(weekly_AllETF_USDm_range, weekly_BTC_Return_range)
```

Scenario model formulas:

```text
BTC_Price = ((InstitutionalAllocationPct * 200,000,000,000,000)
 + (DigitalGoldPenetrationPct * 18,000,000,000,000)
 + SovereignOtherDemandUSD) / 20,500,000

InstitutionalElasticity_per_1bp = (0.0001 * 200,000,000,000,000) / 20,500,000
 = 975.61 USD/BTC

InstitutionalElasticity_per_25bp = (0.0025 * 200,000,000,000,000) / 20,500,000
 = 24,390 USD/BTC
```

## Sources

1. [Bitcoin ETF Flow – All Data (US$m) – Farside Investors](https://farside.co.uk/bitcoin-etf-flow-all-data/)
2. [btc-hashrate.json](https://satoshimacro.com/assets/data/btc-hashrate.json)
3. [https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?period1=1727740800&period2=1736899200&interval=1d](https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?period1=1727740800&period2=1736899200&interval=1d)
4. [bit20241231_10k.htm](https://www.sec.gov/Archives/edgar/data/1980994/000143774925006260/bit20241231_10k.htm)
5. [bit20240930c_10q.htm](https://www.sec.gov/Archives/edgar/data/1980994/000143774924033812/bit20240930c_10q.htm)
6. [Sizing bitcoin in portfolios | BlackRock](https://www.blackrock.com/institutions/en-us/insights/thought-leadership/portfolio-design/sizing-bitcoin-in-portfolios)
7. [ARK’s Price Target For Bitcoin In 2030](https://www.ark-invest.com/articles/valuation-models/arks-bitcoin-price-target-2030)
8. [Hash Ribbons Indicator | BM Pro](https://www.lookintobitcoin.com/charts/hash-ribbons/)
9. [Digital Asset Fund Flows | January 6th 2025](https://coinshares.com/us/insights/research-data/fund-flows-6-1-25/)
10. [North America: Institutional Momentum and U.S. Bitcoin ETPs Propel Crypto Further Into the Mainstream - Chainalysis](https://www.chainalysis.com/blog/north-america-crypto-adoption-2024/)
11. [Statement on the Approval of Spot Bitcoin Exchange-Traded Products](https://www.sec.gov/newsroom/speeches-statements/gensler-statement-spot-bitcoin-011023)
12. [Strengthening American Leadership in Digital Financial Technology](https://www.whitehouse.gov/presidential-actions/2025/01/strengthening-american-leadership-in-digital-financial-technology/)
13. [SEC.gov | Staff Accounting Bulletin No. 122](https://www.sec.gov/rules-regulations/staff-guidance/staff-accounting-bulletins/staff-accounting-bulletin-122)
14. [Establishment of the Strategic Bitcoin Reserve and United States Digital Asset Stockpile](https://www.whitehouse.gov/presidential-actions/2025/03/establishment-of-the-strategic-bitcoin-reserve-and-united-states-digital-asset-stockpile/)
15. [monetary20250129a1.pdf](https://www.federalreserve.gov/monetarypolicy/files/monetary20250129a1.pdf)