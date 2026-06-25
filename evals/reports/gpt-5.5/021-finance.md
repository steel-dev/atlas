# Collar-strategy delta ranges for long stock

**Bottom line.** For a standard listed-equity protective collar on 100 long shares, use a **sold-call delta of about +0.20 to +0.35** and a **bought-put delta of about −0.20 to −0.30** as the practical working range, not a single “correct” delta. A **+0.30 call** is the mainstream covered-call income convention; a **+0.20 call** leaves more upside and lowers the chance the stock finishes above the cap, but it collects materially less premium and may not finance the put. For the put, **−0.30** gives a closer, stronger floor and costs more; **−0.20** is cheaper, leaves a larger unhedged gap, and is easier to make zero-cost. Equal absolute deltas are **not the institutional default**: collars are usually built around a floor/cap or a zero-premium budget, and equity skew often makes OTM puts richer than comparable OTM calls, pushing real-world zero-cost collars toward asymmetric strikes/deltas [1] [2] [3].

| Decision | Recommended range | Use the lower end when… | Use the higher end when… | Main evidence |
|---|---:|---|---|---|
| **Sold call** | **+0.20 to +0.35** | You want more upside room / lower ITM probability / lower assignment likelihood | You want more premium to fund the put and accept a closer cap | tastytrade typically sells near **30 delta** with roughly **45 DTE**; Fidelity frames strike choice by willingness to sell and probability of assignment [4] [5] |
| **Bought put** | **−0.20 to −0.30** | You can tolerate a wider first-loss gap and want lower net cost / easier zero-cost | You want a nearer protection floor and are willing to pay more or cap upside more tightly | OIC frames the put as the **floor** selected by desired protection, not a fixed delta; tastytrade collar example uses a 10% OTM floor rather than a delta target [6] [2] [7] |
| **Symmetry** | **Prefer asymmetric if zero-cost matters** | Buy a cheaper/lower-delta put or sell a higher-delta/lower-strike call to close a debit | Use symmetric deltas only when the net debit/credit is acceptable | OIC skew article: collar buyer may buy higher-IV OTM put and sell lower-IV OTM call in smirk skew [3] |
| **Percent OTM shortcut** | **Do not use fixed 10% blindly** | It may be much lower delta at low IV/shorter tenors | Delta gives a probability/volatility-aware strike | Fidelity’s $50/$55 covered-call example is 10% OTM and “low probability”; model below shows 10% OTM put is only about −0.096 delta under stated assumptions [5] |

## 1) Delta is a useful ITM-probability proxy, not exact assignment probability

OIC/OCC’s delta education defines delta first as a **theoretical estimate of how much an option premium changes for a $1 move in the underlying**. It also says **some traders view delta as the percentage probability an option will wind up in-the-money at expiration**: an at-the-money option is about **0.50 delta / 50% chance of ITM**, and an option below **0.10 delta** is viewed as unlikely to be ITM without a strong underlying move [1]. That supports using **0.20–0.30 delta** strikes as rough “20%–30% ITM probability” anchors, but not as exact assignment odds.

For a collar specifically, the distinction matters. OIC notes calls have positive model deltas and puts negative model deltas, while sold positions reverse the position delta sign; it also notes delta changes with stock price, time to expiration, and implied volatility, and will not precisely predict option-price changes [1]. Assignment adds another layer: Fidelity discusses covered-call strike choice in terms of mathematical probability of assignment, but OIC’s collar page notes early assignment on the short call is possible and generally occurs just before ex-dividend [5] [2]. So a **+0.30 short call** should be read as “roughly 30-delta / roughly 30% ITM-proxy at entry,” not a guaranteed 30% assignment rate.

## 2) Sold call delta: why +0.20 to +0.35 is better than one number

**Recommendation: sell the call around +0.20 to +0.35 delta, with +0.30 as the default starting point.**

The covered-call convention is anchored at **30 delta**. tastylive’s covered-call setup says it enters covered calls with **roughly 45 days to expiration** and “typically” sells the most liquid call **near the 30-delta level**, because that gives a high-probability trade while retaining upside profitability if the stock rises [4]. The explicit tastylive strike-selection guidance here is **near 30 delta** and **roughly 45 DTE** [4].

Fidelity’s guidance is less delta-prescriptive and more goal-based: covered-call sellers should decide whether they intend to sell the stock, are willing to hold or sell, or do not wish to sell, then match that intention to the mathematical probability of assignment [5]. Fidelity states that at-the-money calls have about a **50% probability of assignment**, OTM calls have lower probability, and ITM calls have higher probability; in its $50 JKL example, the **$55 call** is **10% above spot** and has a low probability of assignment because the stock must rise more than 10% before expiration [5]. Fidelity also states active covered-call writers often sell options with **60 days or less** to expiration, while investors with less time may sell **90 days to 6 months or longer**, and says intermediate-term calls often use strikes at least **5% above** the current stock price for adequate premium with less monitoring [5].

**Tradeoff: +0.30 call vs +0.20 call**

| Sold call choice | Premium | Upside cap distance | ITM/assignment proxy | Put-financing ability | Best use |
|---|---:|---:|---:|---:|---|
| **+0.30 delta** | Higher | Closer cap | Higher than +0.20; roughly 30-delta ITM proxy, not exact assignment probability | Better | Income/zero-cost priority; willing to cap upside closer |
| **+0.20 delta** | Lower | Farther cap | Lower; roughly 20-delta ITM proxy | Weaker | Upside-retention priority; less desire to sell stock |

The call range should therefore be wider than a single value: **+0.30** is the mainstream covered-call starting point, but **+0.20** is often more consistent with a shareholder who mainly wants disaster protection and wants the call to be a funding leg rather than an aggressive sale target. Moving above +0.35 pushes the collar toward an income/exit strategy; moving below +0.20 often leaves too little premium to fund meaningful put protection.

## 3) Bought put delta: use −0.20 to −0.30, but choose the floor first

**Recommendation: buy the put around −0.20 to −0.30 delta, but set the strike by the maximum loss/floor you can tolerate.**

OIC’s protective-put education frames the put as a **floor**: a protective put establishes a price below which the stock value cannot fall, and if the stock falls below the strike the investor can exercise the put to liquidate at the strike price [6]. OIC’s collar page similarly says the investor usually selects a call strike above and a put strike below the starting stock price; those strikes are the **ceiling** and **floor**, and the choices affect both hedge cost and protection [2]. This is a floor/loss-tolerance convention rather than a fixed-delta convention.

tastylive’s collar-option page gives the same floor-and-funding framing: buy a put with a strike below the current stock price to set the floor of risk, choose expiration based on outlook/market conditions, and sell an OTM call in the same expiration to help offset the put cost; its numerical collar example uses a **$50 stock**, **$45 put bought for $2/share**, and **$55 call sold for $2/share**, i.e. **10% below/above spot** and **zero net premium** [7]. Option Alpha describes the same core structure—long stock, OTM short call, OTM protective put—and states that the call credit can fund the put, producing a credit, debit, or cost-free collar depending on strike widths [8].

**Tradeoff: −0.30 put vs −0.20 put**

| Bought put choice | Protection floor | Premium cost | Downside gap before protection | Zero-cost feasibility | Best use |
|---|---:|---:|---:|---:|---|
| **−0.30 delta** | Closer to spot | Higher | Smaller | Harder unless call cap is closer or collar accepts debit | Capital preservation / lower drawdown tolerance |
| **−0.20 delta** | Farther from spot | Lower | Larger | Easier | Cost control / willingness to absorb first loss |

Favor **−0.30** when the stock is highly concentrated, the investor has a strict drawdown limit, or the collar is replacing a sell decision. Favor **−0.20** when the position can tolerate a larger first-loss band and the priority is to keep the collar zero-cost or avoid selling a too-close call. A portfolio-volatility objective can justify going lower still: tastylive’s **Nov. 15, 2018** SPY protective-collar study tested **2005–2017** collars with **45 DTE** held to expiration and highlighted a **5-delta put / 16-delta call** collar; after testing deltas, it found that more aggressive option positions performed worse as hedges and that the further-OTM **5-delta put / 16-delta call** combination produced the greatest reduction in portfolio volatility [9]. That result supports using lower deltas when the goal is reducing portfolio volatility rather than setting a close protection floor.

## 4) Symmetric vs asymmetric collars

**Recommendation: do not force equal absolute deltas. Use symmetric deltas only if the net debit/credit and the cap/floor are acceptable; otherwise build an asymmetric collar around the floor and budget.**

OIC’s collar education frames the decision as selecting a call above and a put below spot, with those strikes determining hedge cost and protection [2]. Option Alpha also emphasizes that the collar can be a credit, debit, or cost-free structure depending on strike widths rather than equal deltas [8]. Institutional index methodologies are even more explicit: Cboe’s CLL uses fixed **95/110** moneyness, while CLLZ fixes the put-spread hedge and then selects the call premium to finance it [10] [11].

The reason equal-delta collars often fail to be zero-cost is skew. OIC’s volatility-skew article states that in a smirk-skew environment, a collar investor buying an OTM put and selling an OTM call will likely be buying the higher-implied-volatility option and selling the lower-implied-volatility option; OIC adds that OTM puts are more expensive than OTM calls only in that skew environment and that skew is dynamic [3]. The practical fallback hierarchy is:

1. **Pick the floor first**: choose the put strike/delta that matches the maximum loss you will accept.
2. **Sell the call that best funds it**: start around +0.30; move toward +0.20 only if preserving upside matters more than zero-cost.
3. **If not zero-cost**, choose one: accept a small debit, buy a farther OTM/lower-delta put, or sell a closer/higher-delta call.
4. **Do not chase zero-cost by accident**: zero upfront premium still has the economic cost of upside forfeiture, as the Allspring/Cboe study explicitly notes for CLLZ [12].

## 5) Percentage distance from spot: useful shortcut, but delta is better

A fixed percentage OTM rule is easy to communicate, but it does not map consistently to delta because delta depends on volatility, time to expiration, rates, dividends, and skew [1]. Fidelity gives a covered-call example where a **10% OTM** call on a **$50** stock—the **$55** call—has low assignment probability because the stock must rise more than 10% before expiration [5]. tastylive’s collar example uses a symmetric **10% below / 10% above** collar: **$45 put** and **$55 call** on a **$50 stock**, both priced at **$2/share**, for zero net premium [7].

Under the model example below, however, **10% OTM does not equal 0.20–0.30 delta**. With $100 stock, 45 DTE, 25% flat IV, 4.5% risk-free rate, and no dividend, a **10% OTM call** at $110 is about **+0.164 delta**, while a **10% OTM put** at $90 is only about **−0.096 delta**. In that setup, 0.20–0.30 put protection is much closer than 10% OTM.

## 6) Worked $100-stock example, as of 2026-06-23

**Assumptions for the hypothetical chain:** stock price **$100.00**, expiration **45 DTE**, flat implied volatility **25%**, risk-free rate **4.5%**, dividend yield **0%**, $1 strike increments, Black-Scholes model premiums at mark. These are model marks, not live bid/ask quotes.

| Target | Strike | % OTM from $100 | Model delta | Model premium/share |
|---|---:|---:|---:|---:|
| +0.20 call | $109 | +9% | +0.191 | $0.887 |
| +0.30 call | $106 | +6% | +0.289 | $1.518 |
| −0.20 put | $94 | −6% | −0.208 | $1.078 |
| −0.30 put | $96 | −4% | −0.284 | $1.622 |
| 10% OTM call | $110 | +10% | +0.164 | $0.732 |
| 10% OTM put | $90 | −10% | −0.096 | $0.408 |

**Example collar using the recommended range:**

| Structure | Sell call | Buy put | Net premium/share | Net per 100 shares | Interpretation |
|---|---:|---:|---:|---:|---|
| Symmetric ~0.30 delta | $106 call, +0.289 delta, $1.518 credit | $96 put, −0.284 delta, $1.622 debit | **$0.104 debit** | **$10.42 debit** | Stronger floor; not quite zero-cost under flat-IV model |
| Asymmetric 0.30/0.20 | $106 call, +0.289 delta, $1.518 credit | $94 put, −0.208 delta, $1.078 debit | **$0.440 credit** | **$43.97 credit** | Easier funding; wider downside gap |
| Near-zero practical collar | $108 call, +0.221 delta, $1.067 credit | $94 put, −0.208 delta, $1.078 debit | **$0.011 debit** | **$1.12 debit** | Near-zero with similar ~0.20 deltas |
| Alternative near-zero | $109 call, +0.191 delta, $0.887 credit | $93 put, −0.175 delta, $0.863 debit | **$0.023 credit** | **$2.35 credit** | More upside, lower floor |

For the requested example format:

```text
Stock: $100.00
Sell call: $108 strike, delta +0.221, model credit $1.067/share
Buy put: $94 strike, delta -0.208, model debit $1.078/share
Net debit: $0.011/share, or $1.12 per 100-share collar
```

An exact zero-cost collar in a real chain usually requires changing either the call strike, the put strike, or accepting a small debit/credit. The model’s symmetric ~0.30 collar is a **$10.42 debit per 100 shares**; moving the put from **$96/−0.284** to **$94/−0.208** turns the same $106 call collar into a **$43.97 credit**, while moving the call to **$108/+0.221** against the $94 put produces a near-zero **$1.12 debit**.

## 7) Institutional collar structures

Institutional benchmark collars generally use **moneyness, budget, and roll rules**, not equal deltas.

| Institutional structure | Underlying exposure | Downside leg | Upside/funding leg | Roll rule | Objective/result |
|---|---|---|---|---|---|
| **Cboe S&P 500 95-110 Collar Index (CLL)** | Holds S&P 500 portfolio and collects dividends; the methodology says dividends and sold-call premium are functionally reinvested in the index portfolio | Buys SPX puts at **95%** of S&P 500 value; strike is closest listed strike at or below 95% just before **11:00 ET** | Sells SPX calls at **110%** of S&P 500 value; strike is closest listed strike at or above 110% just before **11:00 ET** | Calls rolled monthly at SPX expiration, usually third Friday; puts use quarterly Mar/Jun/Sep/Dec cycle; if the call strike would be below the standing put on a non-quarterly roll, the put is sold and replaced with a new 5% OTM put of the same quarterly expiration | Fixed 5% floor / 10% cap benchmark for downside hedging with call overwriting [10] |
| **Cboe S&P 500 Zero-Cost Put Spread Collar Index (CLLZ)** | Long S&P 500 index exposure | Monthly buys **2.5% OTM** SPX put, first listed strike below **97.5%** of SPX just before 11:00 ET; sells **5% OTM** SPX put, first listed strike below **95%** | Sells OTM monthly SPX call(s) so call bid premium equals the ask of the 2.5% put minus the bid of the 5% put; if no exact call exists, sells a weighted portfolio of two calls whose weighted-average bid equals the put-spread cost | Monthly roll on third Friday or preceding business day; AM-settled options | Zero-premium put-spread collar: downside buffer financed by call overwriting [11] |
| **Allspring/Cboe calendar put-spread collar overlay** | Passive S&P 500 allocation overlay | Buys **12-month 10% OTM puts** monthly at **1/12 notional** | Sells **4-week 15-delta calls** weekly at **25% notional**; also sells **4-week 5-delta puts** weekly at **12.5% notional** | Overlapping expiries; weekly/monthly schedule | Authors favor delta-based sold-option targeting because it keeps probability of realizing loss on sold options more constant as IV changes [12] |

Cboe describes PPUT, CLL, and CLLZ as hedging benchmarks for risk-averse investors: protective-put strategies hold a stock basket and buy OTM index puts; collar strategies hold a stock basket, buy OTM puts, and sell OTM calls, with the call premium offsetting some or all of the put cost. Cboe explicitly notes the tradeoff: collars may have little or no net upfront cost, but they may lose bull-market upside [13]. Over the **35-year history ending June 30, 2021**—shown by Cboe as **June 30, 1986–June 30, 2021**—Cboe reported that **PPUT, CLL, and CLLZ** had **lower standard deviations** and **less severe maximum drawdowns** than key benchmark indices, and that all three had **betas below 0.75** over that history [13].

The Allspring/Cboe practitioner study gives the clearest performance comparison for a zero-cost collar benchmark. For **July 1986 through September 2021**, CLLZ versus the S&P 500 was reported as follows:

| Index / period | Annualized total return | Standard deviation | Sharpe ratio | Max drawdown |
|---|---:|---:|---:|---:|
| **CLLZ**, July 1986–Sept. 2021 | **7.65%** | **11.7%** | **0.39** | **−43.02%** |
| **S&P 500**, July 1986–Sept. 2021 | **10.83%** | **15.2%** | **0.51** | **−50.91%** |

That is the institutional tradeoff in numbers: CLLZ reduced volatility and drawdown versus the S&P 500, but it also reduced return; Allspring/Cboe concludes that “zero net premium” is not zero economic cost [12].

## 8) Single-stock institutional / concentrated-holder example

A disclosed SEC single-stock collar example is First Data’s FDR Subsidiary Corp. collar on CheckFree Corporation shares. The filed Exhibit 7 termsheet is dated **April 26, 2002** and describes a European cashless collar with JPMorgan Chase Bank on CheckFree common stock (ticker **CKFR**): FDR Subsidiary Corp. bought a put and sold a call on **95,300** reference shares; the **put strike was $19.4089** per share, equal to **100.0%** of the initial share price; the **call strike was $32.4420**, equal to **167.15%** of the initial share price; the valuation period starts **5 calendar years** after the start date; and the counterparty pledged shares equal to the reference share number as collateral [14].

This example is useful because it shows how concentrated-stock collars can look very different from retail 30–45 DTE collars: the put was essentially at-the-money, the call cap was far above spot, and the term was multi-year.

## Final operating rule

Use this decision rule for a long-stock collar:

```text
Sold Call Delta: +0.20 to +0.35
Reason: +0.30 is the covered-call convention; +0.20 preserves more upside and lowers ITM/assignment proxy; higher deltas fund the put better but cap gains sooner.

Bought Put Delta: -0.20 to -0.30
Reason: -0.30 gives a nearer floor and costs more; -0.20 is cheaper, leaves more first-loss exposure, and is easier to finance.

Symmetric vs Asymmetric: Prefer asymmetric when targeting zero-cost.
Reason: collars are normally designed around a floor, cap, and premium budget; skew can make the OTM put more expensive than the OTM call, so equal deltas are not automatically zero-cost.
```

For most investors starting from a $100 stock, a practical first screen is **sell a +0.25 to +0.30 call and buy a −0.20 to −0.30 put**, then adjust the call strike or put strike until the net premium is acceptable. If the primary objective is share retention and upside participation, move the call toward **+0.20**. If the primary objective is downside protection, move the put toward **−0.30** and accept either a tighter call cap or a debit.

## Sources

1. [Options Delta](https://www.optionseducation.org/advancedconcepts/delta)
2. [Collar Protective Collar | Options Education](https://www.optionseducation.org/strategies/all-strategies/collar-protective-collar)
3. [Volatility Skew and Options: An Overview](https://www.optionseducation.org/news/volatility-skew-and-options-an-overview-1)
4. [What is a Covered Call & How Does it Work?](https://www.tastylive.com/concepts-strategies/covered-call)
5. [Selecting a Strike Price and Expiration Date - Fidelity](https://www.fidelity.com/learning-center/investment-products/options/selecting-strike-price-expiration-date)
6. [Protective Put (Married Put)](https://www.optionseducation.org/strategies/all-strategies/protective-put-married-put)
7. [What is a Collar Option Strategy & How to Use it?](https://www.tastylive.com/concepts-strategies/collar-option)
8. [Options Collar Guide [Setup, Entry, Adjustments, Exit]](https://optionalpha.com/strategies/collar-strategy)
9. [The Protective Collar](https://www.tastylive.com/shows/market-measures/episodes/the-protective-collar-11-15-2018)
10. [Cboe_Collar_Indices_Methodology.pdf](https://cdn.cboe.com/api/global/us_indices/governance/Cboe_Collar_Indices_Methodology.pdf)
11. [Cboe_Zero-Cost_Put_Spread_Collar_Indices_Methodology.pdf](https://cdn.cboe.com/api/global/us_indices/governance/Cboe_Zero-Cost_Put_Spread_Collar_Indices_Methodology.pdf)
12. [Allspring_options-based-downside-protection.pdf](https://cdn.cboe.com/resources/indices/whitepapers/Allspring_options-based-downside-protection.pdf)
13. [Benchmark Indices Series: Hedging Downside Exposure with PPUT, CLL and CLLZ Indices | Cboe](https://www.cboe.com/insights/posts/benchmark-indices-series-hedging-downside-exposure-with-pput-cll-and-cllz-indices/)
14. [](https://www.sec.gov/Archives/edgar/data/949341/000091205702021792/a2080834zex-7.htm)