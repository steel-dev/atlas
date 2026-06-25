# An Options-Trading Framework for a $700 Account Targeting $200–300/Week

*Educational illustration only. This is not personalized financial advice, not a recommendation to trade, and not a solicitation. As shown below, the stated return target is not sustainably achievable and carries a high probability of total loss of the $700.*

## Bottom line

The target itself is the most important finding. Netting **$200–300/week on a $700 account is a ~28.6%–42.9% weekly return.** Compounded across 52 weeks, that is roughly **4.7×10⁵ to 1.1×10⁸ times the starting capital** — a figure with no basis in any documented trading edge. No position-sizing rule, strategy, or screen reconciles a disciplined process with this target: the two are in direct conflict. A risk-controlled framework (risking 1–5% per trade, i.e., **$7–$35**) produces expected weekly returns one to two orders of magnitude below $200–300; conversely, hitting $200–300 weekly requires staking most or all of the account on one or two directional bets, which is gambling with a near-certain path to ruin over time. The framework below is therefore presented as a *risk-controlled discipline* — the correct structure — alongside an explicit demonstration of why the dollar target forces abandoning it.

| Framework dimension | Risk-controlled rule (the discipline) | What the $200–300/wk target forces instead |
|---|---|---|
| Risk per trade | 0.25–1% (Van Tharp); 1–5% = **$7–$35** on $700 [1] | Effectively 50–100% of account per trade |
| Per-trade expectancy needed | ~0.4–0.6R is strong/achievable [2][3] | **1.43R sustained** (5 trades/wk, $35 risk) — not documented anywhere |
| Strategies | Long call/put, debit spread, narrow credit spread | Concentrated single-leg OTM lottery tickets |
| Win-rate × R:R to hit target | n/a (rule caps drawdown) | e.g. **81% win at 2:1**, or **61% at 3:1**, or **41% at 5:1** — every week |
| Probability of total loss | Near-zero with positive edge + small risk [2] | High; risk of ruin → ~certain at this sizing |

---

## 1. Position sizing and maximum risk per trade

The standard risk-controlled rule is to risk a **fixed small percentage of the account on each trade**, sized off a predefined stop. The Van Tharp Institute states the "typical recommended risk per trade" is **0.25%–1%**, with most traders risking between 0.25% and 1% to protect capital; it frames risk as a predefined "R" and evaluates trades in R-multiples, holding that *position sizing — not the trading system — determines whether you achieve your objectives* [1].

On a $700 account:

| Risk % | Max $ loss per trade |
|---|---|
| 0.25% | $1.75 |
| 1% | $7.00 |
| 2% | $14.00 |
| 5% (already aggressive) | $35.00 |

A single standard option contract controls 100 shares, so even one contract often risks more than $35 unless it is a cheap, narrow, or deep-OTM position — meaning the $700 account is *capital-constrained before strategy selection even begins*.

The mathematics linking risk-per-trade to survival comes from the **Kelly criterion** and **risk-of-ruin**. The Kelly fraction is **f\* = p − q/b = p − (1−p)/b**, where *p* is win probability, *q*=1−*p*, and *b* is the net odds (proportion gained on a win); a zero edge (*b*=*q/p*) recommends betting nothing, and a negative edge yields a negative *f\** [4]. Practitioners typically bet *fractional* Kelly (e.g., half) to dampen volatility and protect against overestimating their edge — and overestimating *p* makes the realized bet diverge from optimal and *raises* risk of ruin [4].

Risk of ruin is **RoR = ((1 − Edge)/(1 + Edge))^Units**, where **Edge = (WinRate × R:R) − LossRate** and **Units = Account ÷ Risk-per-trade** [2]. The two levers that drive RoR toward zero are (a) a *positive* edge and (b) *small* per-trade risk, which gives many units of cushion. The worked reference case — 55% win rate, $150 average win, $100 average loss, $10,000 account, $200 risk — gives Edge = +37.5%, 50 units, and RoR well under 0.01% [2]. A 45% win rate with a 1.2:1 reward and $500 risk on a $5,000 account gives a **negative edge (−1%)** and effectively *certain* ruin [2]. The $700 / $200-target combination sits firmly in the second regime: large per-trade risk, few units, and an edge no real strategy delivers.

## 2. Permitted strategies and their risk profiles

| Strategy | Max loss | Max gain | Capital tied up | Fit for $700 account |
|---|---|---|---|---|
| Long single-leg call/put (debit) | Premium paid | Theoretically large (call) / large (put) | Premium only | Workable; defined risk = full premium [5] |
| Vertical **debit** spread (bull call / bear put) | Net debit | Width − net debit | Net debit only | Best fit; lowest capital, defined risk [5][6] |
| Vertical **credit** spread (bull put / bear call) | Width − credit | Credit received | Collateral = max loss (frozen) | Constrained — collateral often exceeds the account [7] |

**Long single-leg call/put (debit):** the maximum loss is exactly the premium paid — a fully defined-risk profile — which is why a long option is the simplest fit for a small account.

**Vertical debit spread (bull call / bear put):** buy one option and sell a further option to cut cost. Per the OCC's OptionsEducation.org, for a bull call spread **maximum loss = net premium paid** and **maximum gain = high strike − low strike − net premium paid** (i.e., width minus debit). The OCC's illustration: long 1 XYZ 60 call, short 1 XYZ 65 call [5]. This is the most capital-efficient defined-risk directional structure for $700.

**Vertical credit spread (bull put / bear call):** here the broker freezes the **buying power reduction (BPR) = (width × 100) − credit received**, which equals the maximum loss, and the same calculation applies in cash, margin, and IRA accounts [7]. This is the binding constraint on a $700 account:

| Spread width | Collateral (≈ max loss) | % of $700 account |
|---|---|---|
| $1 wide | ~$100 | 14% |
| $2 wide | ~$200 | 29% |
| $5 wide | ~$375–500 | 54–71% |
| $10 wide | ~$1,000 | **143% — exceeds the account** [7] |

ROI per spread is roughly constant (~30–33%) across widths, so wider does not mean better — width must be picked off the account size and the 1–2% risk rule [7]. On $700, credit spreads are realistically limited to **$1–$2 wide**; even a single $5-wide spread consumes more than half the account.

## 3. Stock selection: technicals

**Liquidity / volume floor.** Relative volume (RVOL) = today's volume ÷ average daily volume over a reference window (typically 10–20 days): 1.0 = average, **1.5 = "elevated" (50% above baseline)**, and above 3.0 often signals a major catalyst. A practical swing screen sets **price > $10–15**, **average daily volume > 1–1.5 million shares** (cutting ~8,000 tickers to ~500 liquid names), and a trend filter of the **50-day SMA above the 200-day SMA**.

**Support/resistance.** Mark the highest price over the last 3–6 months as resistance and the lowest as support, draw horizontal lines where price reversed two to three times, and treat a level tested 2+ times as stronger; broken support becomes resistance. Confirm with **volume spikes 20%+ above the 20-day average** when price tests a level (a high-volume bounce signals genuine buyers; a low-volume breakout is suspect and often fails within 1–3 days).

**Momentum indicators (specific thresholds):**
- **RSI(14):** 0–100 oscillator; **>70 = overbought** (pullback risk), **<30 = oversold** (bounce/reversal).
- **MACD:** MACD line = 12-period EMA − 26-period EMA; signal line = 9-period EMA of the MACD line; histogram = difference. **Buy = MACD crosses above signal; sell = crosses below.**
- **9/21 EMA (and 50/200 SMA):** trend direction and dynamic support/resistance.
- **Confirmation:** take a long only when the three align — price above rising 9/21 EMAs, MACD bullish cross, and RSI rising but still below 70.

## 4. Strike and expiry selection for 3–21 day holds

**Delta band.** Delta doubles as a rough probability of finishing in-the-money (0.50 ≈ 50%, 0.30 ≈ 30%, 0.10 ≈ 10%) and as a sensitivity measure (a 0.30-delta call moves ~1/3 as much as the stock; 0.80-delta moves ~80%) [6]. For a directional 3–21 day hold, select within roughly a **0.30–0.70 delta band**, tied to conviction and theta tolerance: a strong setup in cheap/fair IV favors **ITM (~0.65 delta)** for maximum delta and low vol drag; an elevated-IV setup favors an **ATM debit spread** that sells the expensive far strike to cut IV drag [8]. Far-OTM "cheap" tickets (0.10 delta) are the documented mistake — a $0.80 weekly that expires worthless even on a favorable-but-slow move [6].

**Expiry / DTE.** Theta decay is *not* linear and gamma rises nonlinearly as expiration nears: at ~45 DTE theta is gentle and gamma negligible, but the decay curve **steepens through the 14–21 DTE window**, and in the final 0–7 DTE gamma becomes "the single most important number on your risk screen" — a 0.30-delta option can jump to 0.60 delta overnight on a 2% move when only days remain, so stops become unreliable. Option buyers are generally advised to use longer expiries (the OptionsPilot framework recommends **45–90 DTE for buyers**, 30–45 DTE for sellers; weekly <7 DTE for experienced traders only). For a **3–21 day hold, the practical rule is to enter around 30–45 DTE and exit before the final ~7–14 DTE gamma/theta danger zone** — never let a long position run into the last two weeks where time decay and gamma turn sharply against it. (The question's "7–30 DTE" range overlaps this but skews shorter than the buyer-optimal window; the deeper the position runs below ~21 DTE, the faster theta bleeds it.)

## 5. Liquidity filters and their drag on a small account

| Filter | Threshold |
|---|---|
| Minimum option volume | **≥100 contracts/day** [9] |
| Minimum open interest | **≥500 contracts** (commonly ≥500–1,000) [9] |
| Maximum bid-ask spread | **≤10% of price** (tighter ≤5% / ≤$0.10 preferred) [9] |
| Strike range scanned | within ±10% of spot [9] |

On a $700 account these filters are not optional. If a $1.00 option has a $0.10 spread (10%) and you cross it on entry and exit, you lose ~$0.20 round-trip — **20% of the premium gone to friction before the trade is right or wrong.** Wide spreads "quietly erode any edge" [9], and on tiny positions that drag can exceed the entire mathematical edge, which is why a hard spread cap and an open-interest/volume floor matter more here than for a large account.

## 6. Hypothetical example trades

*Illustrative prices and chains; not live quotes.*

### Example 1 — Bull call (debit) spread on a momentum stock

- **Underlying:** "XYZ" trading at **$200**, RVOL 1.7, price above rising 9/21 EMA, MACD bullish cross, RSI 58, just broke $198 resistance on volume.
- **Structure:** Buy the **$200 call (0.55 delta)**, sell the **$205 call (0.35 delta)**, **35 DTE** (plan to exit by ~14 DTE).
- **Net debit:** **$2.00** ($200 per spread); spread width $5.
- **Position size:** 1 contract = **$200 risk = 28.6% of the $700 account.** (Note: this already violates the 1–5%/$7–$35 rule — illustrating that even the "conservative" example over-risks a $700 account.)
- **Max loss:** $200 (net debit) if XYZ ≤ $200 at expiry [5].
- **Max gain:** width − debit = $5 − $2 = **$3.00 = $300** if XYZ ≥ $205 [5]. Reward:risk = 1.5:1.
- **Target:** close at ~$2.50–$2.75 mid (≈ +$50–$75), not held to expiry, to avoid pin/gamma risk near the short strike [5][6].

| XYZ at exit | Spread value | P/L per contract |
|---|---|---|
| $195 | ~$0.20 | −$180 |
| $200 | ~$0.80 | −$120 |
| $202.50 | ~$1.80 | −$20 |
| $204 | ~$2.80 | +$80 |
| ≥ $205 (held to expiry) | $5.00 | **+$300 (max)** |

### Example 2 — Bull put (credit) spread, width-constrained by the account

- **Underlying:** "ABC" at **$50**, holding above support at $48 (tested twice), RSI rising off 40, MACD turning up.
- **Structure:** Sell the **$48 put (~0.30 delta)**, buy the **$47 put**, **30 DTE entry (plan to exit by ~14 DTE)**, **$1-wide** (the widest defensible on $700).
- **Net credit:** **$0.30** = $30 received.
- **Collateral / BPR / max loss:** (width × 100) − credit = ($1×100) − $30 = **$70 frozen = 10% of the account** [7].
- **Position size:** 1 contract; max loss $70 = 10% of account (still above the 1–5% rule).
- **Max gain:** the **$30 credit** (~43% ROI on $70 collateral) if ABC ≥ $48 at expiry [7].
- **Target:** buy back at ~$0.10–$0.15 (capture 50–67% of credit), exiting at **~14 DTE** — well before the final-week gamma/pin zone [10]. Entering at 30 DTE and closing by ~14 DTE gives an **effective hold of ~16 days, within the 3–21 day window**; the spread is never carried into the last two weeks where gamma and pin risk spike.

| ABC at expiry | Outcome | P/L per contract |
|---|---|---|
| ≥ $48 | both puts expire worthless | **+$30 (max)** |
| $47.70 | breakeven (strike − credit) | $0 |
| $47.50 | short ITM, long cushions | −$20 |
| ≤ $47 | both ITM, max loss | **−$70** |

To even approach $250/week with Example 2's $30-credit spreads, one would need **~8–10 such positions winning simultaneously every week**. Each spread freezes **$70** of collateral [7], so **8 positions tie up $560 (80% of the account) and 10 positions tie up $700 (100% of the account)** — the entire $700 committed at once with no buffer, and every one of the 8–10 must win in the same week. This is internally consistent with the −$70 (10%-of-account) max loss per spread shown in the Example 2 P/L table: 10 × $70 = $700, the whole account, and a single loss among them erases roughly a quarter of the week's $200–300 target. It concretely demonstrates the capital constraint.

## 7. Required win rate, edge, and the expectancy distribution

Using **Expectancy = (Win Rate × Average Win) − (Loss Rate × Average Loss)** per trade [3], and assuming the (already-aggressive) cap of **5 trades/week at $35 max risk**, the target of $250/week requires **$50 expected profit per trade = 1.43R**. Solving for the win rate needed at each reward:risk:

| Reward:Risk | Win rate required for 1.43R/trade |
|---|---|
| 1:1 | 122% — impossible |
| 1.5:1 | 97% |
| 2:1 | 81% |
| 3:1 | 61% |
| 5:1 | 41% |

By contrast, what *strong, realistic* edges actually produce on the same 5-trade, $35-risk week:

| Win rate | Reward:Risk | Expectancy | Weekly expected profit |
|---|---|---|---|
| 50% | 1:1 | 0.00R | $0 |
| 70% | 1:1 | 0.40R | ~$70 |
| 60% | 1.5:1 | 0.50R | ~$87 |
| 50% | 2:1 | 0.50R | ~$88 |
| 40% | 3:1 | 0.60R | ~$105 |

Even a genuinely excellent system — **0.5–0.6R per trade** — produces roughly **$70–$105/week**, not $200–300, and that is *before* the bid-ask drag and commissions that make near-zero expectancy "fragile" [3]. The only way to bridge the gap is to multiply per-trade risk by 5–10×, which simultaneously collapses the unit count and drives risk of ruin toward certainty [2].

## 8. Day-trade turnover constraint (PDT)

If trades are closed *intraday*, the **FINRA Rule 4210 pattern-day-trader rule** historically applies: an account is flagged as a pattern day trader on **4 or more day trades within 5 business days** (when those day trades exceed 6% of total trades), and a flagged account **must maintain $25,000 minimum equity** [11]. A $700 account cannot meet that, so under the legacy rule it is effectively capped at **3 day trades per rolling 5 business days** — the practical workaround the question references — which constrains intraday turnover and pushes the strategy toward multi-day holds. Note that as of 2026, FINRA has adopted **new intraday margin standards** (filed as SR-FINRA-2025-017, SEC accelerated approval April 14, 2026, Release No. 34-105226) that **eliminate the PDT designation and the $25,000 minimum**, replacing trade-counting with real-time intraday-equity monitoring; repeated intraday margin deficits can restrict an account for up to 90 days [12]. The Day-Trading Risk Disclosure Statement is embodied in FINRA Rule 2270 [11].

## 9. Disclaimer and red flag

This is an **educational illustration, not personalized financial advice** and not a recommendation. The headline conclusion stands: a **~29–43% weekly** return on $700 has no foundation in any documented edge, and pursuing it requires position sizing that drives **risk of ruin toward certainty** [2]. A disciplined framework — 1–5% risk per trade, defined-risk debit spreads, liquidity-filtered momentum setups, 30–45 DTE entries exited before the gamma zone — is the correct structure, but it produces **tens of dollars, not hundreds, of expected weekly profit**, and the most probable outcome of forcing the $200–300 target on a $700 account is **total loss of the account**.

## Sources

1. [Free Position Sizing Calculator | Van Tharp Institute](https://vantharpinstitute.com/tools/position-sizing-calculator/)
2. [Risk of Ruin Calculator – Probability of Account Loss](https://tradingcalcs.com/tools/risk-of-ruin-calculator)
3. [Trading Expectancy Formula](https://tradjana.com/resources/understanding-expectancy)
4. [Kelly criterion - Wikipedia](https://en.wikipedia.org/wiki/Kelly_criterion)
5. [Bull Call Spread (Debit Call Spread)](https://www.optionseducation.org/strategies/all-strategies/bull-call-spread-debit-call-spread)
6. [Moneyness and Strike Selection](https://academy.tradeology.app/options-trading/moneyness-and-strike-selection)
7. [Buying power reduction (BPR) — SellCallPut](https://sellcallput.com/blog/options-credit-spreads-buying-power-reduction/)
8. [Complete Guide to Directional Options Trading | FlashAlpha Research](https://flashalpha.com/articles/complete-guide-directional-options-trading)
9. [Options Liquidity and Market Execution - Quantitative Edge](https://fabiobaruffa.com/options-liquidity-and-market-execution)
10. [How to Choose the Right Options Expiration Date: A DTE Selection Framework](https://optionspilot.app/blog/how-to-choose-options-expiration-date-dte)
11. [Am I a Pattern Day Trader? | Syndication](https://syndication.finra.org/content/am-i-pattern-day-trader)
12. [Understanding the New Intraday Margin Requirements](https://www.finra.org/investors/insights/intraday-margin-requirements)