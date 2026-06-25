# Educational options-trading framework for a $700 account targeting $200–$300/week

**Bottom line:** a $200–$300 weekly target on a $700 account requires **28.6%–42.9% gross weekly return before commissions, fees, taxes, slippage, and losing streaks**. With the risk controls below—**5%–10% max defined risk per trade = $35–$70**, and **20%–30% max total open risk = $140–$210**—the target is mathematically possible only with an unusually high edge, frequent trading, or reward-to-risk outcomes that are difficult to sustain. The framework therefore prioritizes defined-risk structures and treats the target as an aggressive feasibility exercise, not a promise.

| Decision point | Framework rule | Why it matters |
|---|---:|---|
| Account equity | $700 | Small account; each contract must fit risk caps. |
| Target | $200–$300/week | Equals **28.6%–42.9%** of account equity per week. |
| Max defined risk/trade | **$35–$70** | 5%–10% of $700. |
| Max total open risk | **$140–$210** | 20%–30% of $700 across all trades. |
| Holding window | **3–21 DTE** setups; close before expiration unless assignment/exercise is intentional | OCC states long options can expire worthless and the holder can lose the entire premium paid [1]. |
| Preferred strategies | Long calls/puts and vertical debit spreads | Defined risk; long-only options have no assignment risk before expiration. |
| Conditional strategy | Vertical credit spreads only when collateral is accepted and early assignment risk is understood | OCC states American-style options may be exercised before expiration and assigned to short-option writers [1]. |
| Excluded | Naked short calls/puts and undefined-risk spreads | Loss can exceed the $700 account. |

This is educational only and not personalized financial advice.

## 1) Regulatory and risk premises that set the framework

- **OCC options-risk baseline:** the current OCC *Characteristics and Risks of Standardized Options* available as of 2026-06-24 states that an option holder can lose the entire amount paid for an option in a short time because an option is a wasting asset and can expire worthless; this means a buyer can lose **100% of premium paid** [1].
- **Assignment/exercise risk:** the same OCC disclosure explains that American-style options may be exercised at any time before expiration and that OCC assigns exercises to clearing-member accounts with identical short options; after assignment, the writer must perform under the exercise terms. Therefore **short options, including the short leg of a credit spread, carry early exercise and assignment risk before expiration** [1].
- **FINRA Rule 4210 / day-trading equity premise:** the requested $25,000 pattern-day-trader minimum is not the current Rule 4210 result as of 2026-06-24. FINRA’s 2026 Rule 4210 intraday-margin changes became effective **2026-06-04**, allow transition through **2027-10-20**, and FINRA investor guidance states the prior PDT framework is being replaced, including no $25,000 minimum equity requirement and no PDT trade-count designation under the new requirements [2].
- **Settlement:** the SEC T+1 securities settlement cycle compliance date is **2024-05-28**; OIC explains option premium payment finalizes the next trading day and, under T+1, option exercise/assignment delivery of shares and strike-price payment settle on the next business day after exercise/assignment [3] [4].

## 2) Position sizing and portfolio risk

For a $700 account, the sizing rule is deliberately restrictive:

| Rule | Calculation | Dollar limit |
|---|---:|---:|
| Conservative max loss/trade | 5% × $700 | **$35** |
| Upper-bound max loss/trade | 10% × $700 | **$70** |
| Conservative total open risk | 20% × $700 | **$140** |
| Upper-bound total open risk | 30% × $700 | **$210** |

Operational rules:

1. Enter only trades with **defined max loss** known at order entry.
2. Size contracts so worst-case loss is **≤ $70**, and preferably **≤ $35–$50** when spreads or slippage are wide.
3. Do not open new trades if total worst-case risk across all open trades would exceed **$210**.
4. Because T+1 settlement can make proceeds/collateral unavailable until the next business day after option trades, exercises, or assignments, assume capital may not recycle instantly [3] [4].
5. Use limit orders near mid-price; skip if fills require violating the liquidity filter below.

## 3) Permitted and excluded option strategies

| Strategy branch | When permitted | Max loss | Max profit | Assignment risk |
|---|---|---:|---:|---|
| Long call / long put | Directional setup; 3–21 DTE; option cost fits $35–$70 risk cap | Premium paid × 100 × contracts | Theoretically substantial for calls; limited by stock going to zero for puts | No assignment risk while held long before expiration; buyer can still lose 100% of premium if option expires worthless [1]. |
| Vertical debit spread | Directional setup; 3–21 DTE; net debit fits risk cap | Net debit × 100 × contracts | Spread width × 100 × contracts − debit | Short leg can be assigned if held into exercise risk; risk is defined by the long leg, but close before expiration to avoid operational assignment risk [1]. |
| Vertical credit spread | Conditional only; 3–21 DTE; broker accepts collateral; investor understands early assignment | Spread width × 100 × contracts − credit | Credit received × 100 × contracts | Yes: short leg can be assigned before expiration [1]. |
| Naked short calls/puts; undefined-risk spreads | Excluded | Can exceed account equity | Varies | Excluded because losses can exceed the $700 account. |

## 4) Stock-selection filters

A setup must pass **all** filters before looking at the option chain:

| Filter | Required rule | Source basis |
|---|---|---|
| Share liquidity | Underlying stock or ETF must trade **at least 1,000,000 shares/day over the last 20 trading days**. | Investopedia defines average daily trading volume as a measure of how actively a security trades and says higher ADTV generally indicates greater liquidity and easier entry/exit; TradeAlgo’s swing-screening rule uses at least 500,000 20-day average shares and notes larger accounts can raise the floor to 1,000,000, so this framework uses the stricter **1,000,000** threshold [5] [6]. |
| Support/resistance location | Take bullish trades only near a prior **20-day low/support**, VWAP, or 20-day EMA reclaim; take bearish trades only near a prior **20-day high/resistance**, VWAP rejection, or 20-day EMA rejection. Breakouts must be within **2%** of a 20-day/50-day high with rising volume over 3–5 days after at least 10 trading days of consolidation; pullbacks must be within **2%–5%** of the 20-day moving average. | Investopedia defines support as a price level below which price may not drop and resistance as a level where buyers back off, and says moving averages/trendlines can identify these zones; TradeAlgo provides the concrete 20-day moving-average and 20-day/50-day-high rules [7] [6]. |
| Momentum | Bullish: RSI(14) **50–70**. Bearish: RSI(14) **30–50**. Avoid initiating new bullish longs above 70 or bearish puts below 30 unless using a breakout-specific plan. | StockCharts states RSI was developed by J. Welles Wilder, defaults to 14 periods, and is a 0–100 oscillator; it cites bull-market RSI ranges of 40–90 with 40–50 support and bear-market ranges of 10–60 with 50–60 resistance, supporting the stricter bullish 50–70 and bearish 30–50 bands [8]. |

## 5) Strike, expiry, and liquidity filters

### Strike/expiry rules

- Use **3–21 DTE** options for the planned holding period.
- For long calls/puts and debit spreads, buy a **0.30–0.60 delta** option or use the long leg in that range.
- For credit spreads, sell the short strike around **0.15–0.30 delta**; this fits options-education material that treats delta as a probability proxy, where at-the-money options are near 0.50 delta and lower-delta options are lower probability/lower cost, and credit-spread education that identifies 20–30 delta short strikes as a common balanced range [9] [10] [11].
- Prefer exits before the final 1–3 DTE unless the assignment/exercise plan is explicit, because gamma and exercise mechanics become more operationally important near expiration.

### Option-chain liquidity rules

| Liquidity filter | Minimum / maximum rule | Source basis |
|---|---:|---|
| Open interest | **≥ 500 contracts** at the chosen strike; prefer ≥ 1,000 | TradingBlock identifies open interest as a key liquidity measure; Options Playbook says high open interest tends to mean greater liquidity and smaller price discrepancies [12] [13]. |
| Option volume | **≥ 100 contracts/day** at the chosen strike; prefer ≥ 500 | TradingBlock uses volume as a core liquidity metric; ApexVol’s screener guide recommends at least 500 average daily option contracts for individual stocks, so the framework uses 100 as a hard minimum and 500 as preferred [12] [14]. |
| Bid-ask spread | For low-priced options, spread must be the lesser of **$0.10 or 10% of mid-price**; for spreads, evaluate combined net spread. | Sources emphasize that illiquid options have wide bid-ask spreads and that clean fills matter; ApexVol gives an example where a $0.40 spread on a $1.80 option, or 22%, is too much slippage, so this framework uses a stricter house limit [12] [14]. |

## 6) Hypothetical example trades

The examples use real option-chain snapshots as educational inputs, but the trades themselves are hypothetical and must still pass the technical filters at the time of decision.

### Example 1 — AAPL bullish call debit spread, latest snapshot 2026-06-24

**Setup idea:** AAPL is trading near $294.30; assume the technical screen shows price reclaiming VWAP/20-day EMA, RSI(14) in the bullish 50–70 band, and 20-day average share volume above 1,000,000. Use a debit spread instead of a single long call because a single 0.30–0.60 delta AAPL call costs more than the $70 risk cap.

| Chain input | Long leg | Short leg |
|---|---:|---:|
| Ticker / underlying price | AAPL at **$294.30** as of **2026-06-24 10:00:09 AM EST** | Same |
| Expiry shown in chain | 2026-06-26 option-chain table; framework would normally require 3–21 DTE, so this is a chain-data illustration rather than an ideal DTE example | Same |
| Strike | Buy **300 call** | Sell **302.50 call** |
| Bid / ask / mid | 300C bid **$1.51**, ask **$1.59**, mid **$1.55** | 302.5C bid **$0.79**, ask **$0.84**, mid **$0.815** |
| Delta | **0.33** | **0.21** |
| Volume | **10,078** | **2,644** |
| Open interest | **11,511** | **6,057** |
| Liquidity pass? | OI > 500; volume > 100; $0.08 spread is below $0.10 and about 5.2% of mid | OI > 500; volume > 100; $0.05 spread is below $0.10 and about 6.1% of mid |

Source: Tim’s Stock Lists AAPL option chain for AAPL at $294.30 as of 2026-06-24 10:00:09 AM EST, with bid, ask, volume, open interest, IV, delta, gamma, theta, and last-updated fields [15].

**Hypothetical order:** Buy 1 AAPL 300/302.50 call debit spread at a **$0.74 net debit** using mid-prices: $1.55 − $0.815 = $0.735, rounded to $0.74.

| Item | Value |
|---|---:|
| Contracts | 1 spread |
| Entry debit | **$0.74** × 100 = **$74** |
| Max loss | **$74**, slightly above the $70 upper cap; acceptable only if filled at **≤ $0.70**, otherwise reduce/skip |
| Spread width | $2.50 |
| Max profit at expiration | ($2.50 − $0.74) × 100 = **$176** |
| Target profit | 50%–75% of debit = **$37–$56**, or close near $1.10–$1.30 spread value |
| Breakeven at expiration | $300 + $0.74 = **$300.74** |

**Expiration P/L scenarios, excluding commissions/fees:**

| AAPL price at expiry | Spread intrinsic value | P/L on 1 spread |
|---:|---:|---:|
| ≤ $300.00 | $0 | **−$74** |
| $300.74 | $0.74 | **$0** |
| $301.50 | $1.50 | **+$76** |
| ≥ $302.50 | $2.50 | **+$176** |

### Example 2 — NVDA bullish call debit spread, latest snapshot 2026-06-24 / latest market close

**Setup idea:** NVDA is trading around $200.04–$200.90 in the latest fetched chain snapshots; assume price holds support/VWAP, RSI(14) is 50–70, and volume passes the 1,000,000-share threshold. Use a tight debit spread to keep risk near $35–$70.

| Chain input | Long leg | Short leg |
|---|---:|---:|
| Ticker / underlying price | NVDA close **$200.04**, data as of market close **2026-06-23**; Tim’s 2026-06-24 snapshot shows NVDA **$200.90** | Same |
| Expiry shown in chain | 2026-06-24 active chain in thetaOwl; Tim’s 2026-06-24 source lists available expirations including 2026-07-10, but the extracted rows are a near-expiry chain, so this is a chain-data illustration rather than an ideal 3–21 DTE example | Same |
| Strike | Buy **200 call** | Sell **202.50 call** |
| Bid / ask / mid | 200C bid **$1.87**, ask **$1.92**, mid **$1.895** | 202.5C bid **$0.87**, ask **$0.90**, mid **$0.885** |
| Delta | **0.511** | **0.235** |
| Volume | **38,621** | **120,442** |
| Open interest | **929** | **605** |
| Liquidity pass? | OI > 500; volume > 100; $0.05 spread is below $0.10 and about 2.6% of mid | OI > 500; volume > 100; $0.03 spread is below $0.10 and about 3.4% of mid |

Sources: thetaOwl NVDA chain, data as of market close 2026-06-23, gives NVDA close $200.04 and option rows with strike, bid, ask, volume, OI, IV, delta, and Greeks; Tim’s NVDA chain shows NVDA $200.90 as of 2026-06-24 9:24:37 AM EST and available expirations including 2026-07-10 [16] [17].

**Hypothetical order:** Buy 1 NVDA 200/202.50 call debit spread at a **$1.01 net debit** using mid-prices: $1.895 − $0.885 = $1.01.

| Item | Value |
|---|---:|
| Contracts | 1 spread |
| Entry debit | **$1.01** × 100 = **$101** |
| Max loss | **$101**, above the $70 rule; must be resized by waiting for a cheaper fill, choosing a narrower/cheaper spread, or skipping |
| Spread width | $2.50 |
| Max profit at expiration | ($2.50 − $1.01) × 100 = **$149** |
| Target profit | 50%–75% of debit = **$50–$76**, or close near $1.51–$1.77 spread value |
| Breakeven at expiration | $200 + $1.01 = **$201.01** |

**Expiration P/L scenarios, excluding commissions/fees:**

| NVDA price at expiry | Spread intrinsic value | P/L on 1 spread |
|---:|---:|---:|
| ≤ $200.00 | $0 | **−$101** |
| $201.01 | $1.01 | **$0** |
| $202.00 | $2.00 | **+$99** |
| ≥ $202.50 | $2.50 | **+$149** |

Because the example spread violates the $70 max-risk rule at the quoted mid, the framework answer is to **skip it unless a lower-risk structure is available**. This is the intended discipline for a $700 account.

## 7) Expected-value math for the $200–$300/week target

Use the per-trade expected value formula:

**EV per trade = p × average win − (1 − p) × average loss**

where *p* is win rate. If average loss is the risk cap and average win is a reward-to-risk multiple, the win rate required for a weekly target is:

**p = (target/trades per week + loss) ÷ (win + loss)**

### If risking $35 per trade

| Trades/week | Reward:risk | Avg loss | Avg win | Win rate needed for $200/week | Win rate needed for $300/week |
|---:|---:|---:|---:|---:|---:|
| 3 | 1:1 | $35 | $35 | Impossible: required EV/trade $66.67 exceeds max win | Impossible: required EV/trade $100 exceeds max win |
| 3 | 1.5:1 | $35 | $52.50 | Impossible | Impossible |
| 3 | 2:1 | $35 | $70 | **96.8%** | Impossible |
| 5 | 1:1 | $35 | $35 | Impossible | Impossible |
| 5 | 1.5:1 | $35 | $52.50 | **85.7%** | Impossible |
| 5 | 2:1 | $35 | $70 | **71.4%** | **90.5%** |
| 8 | 1:1 | $35 | $35 | **85.7%** | Impossible |
| 8 | 1.5:1 | $35 | $52.50 | **68.6%** | **82.9%** |
| 8 | 2:1 | $35 | $70 | **57.1%** | **69.0%** |

### If risking $70 per trade

| Trades/week | Reward:risk | Avg loss | Avg win | Win rate needed for $200/week | Win rate needed for $300/week |
|---:|---:|---:|---:|---:|---:|
| 3 | 1:1 | $70 | $70 | **97.6%** | Impossible |
| 3 | 1.5:1 | $70 | $105 | **78.1%** | **97.1%** |
| 3 | 2:1 | $70 | $140 | **65.1%** | **81.0%** |
| 5 | 1:1 | $70 | $70 | **78.6%** | **92.9%** |
| 5 | 1.5:1 | $70 | $105 | **62.9%** | **74.3%** |
| 5 | 2:1 | $70 | $140 | **52.4%** | **61.9%** |
| 8 | 1:1 | $70 | $70 | **67.9%** | **76.8%** |
| 8 | 1.5:1 | $70 | $105 | **54.3%** | **61.4%** |
| 8 | 2:1 | $70 | $140 | **45.2%** | **51.2%** |

Interpretation: the target depends less on one “perfect” strategy than on the distribution of wins and losses. At the strict $35 risk level, even 5 trades/week with 2:1 winners requires about **71.4%** wins for $200/week and **90.5%** wins for $300/week. At the $70 risk level, 5 trades/week with 2:1 winners requires about **52.4%** wins for $200/week and **61.9%** for $300/week, but the account is then using the top of the 10% per-trade risk band and can reach the $210 weekly open-risk ceiling quickly.

## 8) Operating checklist

1. Confirm account equity and buying power; do not exceed **$35–$70 max loss per trade** or **$140–$210 total open risk**.
2. Confirm the underlying trades **≥ 1,000,000 shares/day over 20 trading days** [5] [6].
3. Confirm price is at a defined support/resistance zone: prior 20-day high/low, VWAP, or 20-day EMA; use TradeAlgo’s 2% breakout and 2%–5% pullback constraints as concrete guards [7] [6].
4. Confirm RSI(14): **50–70 bullish**, **30–50 bearish** [8].
5. Use **3–21 DTE**; choose long/debit-spread delta **0.30–0.60** or credit-spread short-strike delta **0.15–0.30** [9] [10] [11].
6. Confirm option liquidity: **OI ≥ 500**, **volume ≥ 100/day**, and bid-ask spread no more than the lesser of **$0.10 or 10% of mid** for low-priced options [12] [14] [13].
7. Use defined-risk orders only; avoid naked short options and undefined-risk spreads.
8. Close or reduce positions before expiration unless exercise/assignment is intended and funded; OCC assignment mechanics and T+1 settlement make short-leg assignment and next-day settlement operational risks [1] [4].

## Sources

1. [](https://www.theocc.com/getmedia/a151a9ae-d784-4a15-bdeb-23a029f50b70/riskstoc.pdf)
2. [Interpretations of Rule 4210 (valid from June 4, 2026)](https://www.finra.org/rules-guidance/guidance/interps-4210-202606)
3. [SEC.gov | Shortening the Securities Transaction Settlement Cycle](https://www.sec.gov/exams/educationhelpguidesfaqs/t1-faq)
4. [The Impact of T+1 on Options](https://www.optionseducation.org/news/understanding-t-1-conversion)
5. [Understanding Average Daily Trading Volume (ADTV) for Smart Investing](https://www.investopedia.com/terms/a/averagedailytradingvolume.asp)
6. [How to Find Stocks for Swing Trading: A Data-Driven Screening Process | TradeAlgo](https://www.tradealgo.com/trading-guides/stocks/how-to-find-stocks-for-swing-trading-a-data-driven-screening-process)
7. [Support and Resistance Basics](https://www.investopedia.com/trading/support-and-resistance-basics/)
8. [Relative Strength Index (RSI) | ChartSchool | StockCharts.com](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/relative-strength-index-rsi)
9. [Options Delta](https://www.optionseducation.org/advancedconcepts/delta)
10. [Hitting the right strike price | Fidelity](https://www.fidelity.com/viewpoints/active-investor/hitting-the-right-strike-price)
11. [Put Credit Spread & Call Credit Spread: 65-70% Win Rate (2026 Guide)](https://apexvol.com/strategies/credit-spread)
12. [Options Screener: How to Find the Best Trades - ApexVol](https://www.apexvol.com/learn/options-screener-guide)
13. [What Is A Bull Call Spread? - Fidelity](https://www.fidelity.com/learning-center/investment-products/options/options-strategy-guide/bull-call-spread)
14. [Understanding Open Interest in Options Trading - The Options Playbook](https://www.optionsplaybook.com/options-introduction/open-interest)
15. [Tim's Stock Lists | AAPL Options Chain](https://timsstocklists.com/Options/OptionsChain?ticker=AAPL)
16. [NVDA Options Chain | thetaOwl](https://thetaowl.com/options/NVDA/chain)
17. [Tim's Stock Lists | NVDA Options Chain](https://timsstocklists.com/Options/OptionsChain?ticker=NVDA&expiration=2026-07-10)