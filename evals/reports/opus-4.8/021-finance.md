# Delta Ranges for a Protective Collar on Long Stock

## Bottom line

For a standard protective collar on 100 shares, the conventional construction is:

- **Sold (short) OTM call: ~0.20–0.40 delta, most often cited near 0.30.** This caps upside while collecting premium; a 0.30-delta call carries roughly a 30% chance of finishing in-the-money [1][2].
- **Bought (long) OTM put: ~0.15–0.30 delta, typically ~0.20.** This sets the downside floor at lower cost than an ATM put [1].
- **Use an *asymmetric* delta collar, not a symmetric one.** Because of equity volatility skew, equal-delta call and put strikes are *not* equal-percentage strikes, and equal-percentage strikes do not produce equal premiums. To get a true zero-cost collar you must sell a slightly higher-delta call (~0.25–0.30) against a slightly lower-delta put (~0.20) [1][3].

The collar is mildly bullish with a strong risk-management tilt: you want the stock to drift up toward the call strike while being protected against a crash below the put strike [1].

## 1. Sold-call delta

**Range: 0.20–0.40, commonly ~0.30 (or ~0.25 in a zero-cost collar).** Delta on a short call functions as an approximate probability of assignment: a 0.30-delta call ≈ 30% chance of finishing ITM, a 0.25-delta call ≈ 75% chance of expiring worthless, and a conservative 0.15-delta call ≈ 85% chance of keeping the shares (assignment roughly once every 6–7 cycles) [2]. The trade-off is direct:

- **Lower-delta call (~0.15–0.20):** strike farther OTM, more upside room, but thinner premium — harder to fully fund the put.
- **Higher-delta call (~0.30–0.40):** strike closer to the money, fatter premium (easier zero-cost), but a tighter cap on gains and higher assignment risk [1][2].

Most retail collar traders place the call strike **5–10% above** the current price [1].

## 2. Bought-put delta

**Range: 0.15–0.30, commonly ~0.20.** A lower-delta (farther-OTM) put is cheaper but starts protecting only after a larger drop; a higher-delta (closer-to-money) put protects sooner but costs more, pushing the collar into a net debit [1]. Retail convention places the put strike **5–10% below** the current price [1]. The institutional benchmark (CLL, below) standardizes on a **5% OTM** put [4].

## 3. Symmetric vs. asymmetric — and the volatility-skew reason

**Verdict: asymmetric.** Equity puts trade at a *higher* implied volatility than equity calls the same distance from the money — the IV-versus-strike curve is a downward "smirk" (low-strike puts at high IV, ATM moderate, high-strike calls at lower IV), a structural feature priced in since the 1987 crash [3]. Consequences:

- At **equal delta**, a put pays more than a call, so an equal-delta collar tends to leave money on the table or run a debit.
- At **equal percentage distance** from spot, the put is richer than the call, so an equidistant ("symmetric") collar often incurs a **net debit** rather than the hoped-for credit — a point Blue Collar Investor makes explicitly for index/ETF options, and which a pending dividend (raising put premium, lowering call premium) worsens [5].

To neutralize the skew and reach zero cost you therefore either buy the put **farther OTM** (lower delta, ~0.20) or sell the call **closer in** (higher delta, ~0.25–0.30). The widely cited zero-cost starting point is a **~0.25-delta short call against a ~0.20-delta long put** [1]. Skew is largest on broad-market ETFs and large-caps and smallest on high-flying growth names, so the degree of asymmetry needed varies by underlying [3].

Three structural variants follow from where you set the strikes [1]:

| Variant | Call vs. put | Net cash | Use when |
|---|---|---|---|
| Zero-cost | ~0.25 call / ~0.20 put | ≈ $0 | Want free insurance, neutral lean |
| Credit collar | Call closer to money than put | Small credit | Leaning bearish, accept tighter cap |
| Debit collar | Put closer to money than call | Small debit | Want tighter downside, expect a drop |

## 4. Zero-cost mechanics and worked example ($100 stock)

A zero-cost collar matches premiums: the call sold funds the put bought, so net debit/credit ≈ $0 [1]. Note that "zero-cost" is a structuring goal, not a free lunch — you forfeit upside above the call strike, and in practice skew/dividends can leave a small residual debit or credit [5].

```
Stock: Own 100 shares at $100
Sell call: $110 strike (10% OTM), Delta ≈ 0.25–0.30, premium ≈ $2.00
Buy put: $90 strike (10% OTM), Delta ≈ 0.20–0.25, premium ≈ $2.00
Net options: ≈ $0 (zero-cost collar)
Tenor: ~30 days (typical retail collar 30–90 days)

Outcomes over the cycle (per 100 shares):
 Stock > $110 → shares called at $110; max gain = (110−100)×100 = $1,000
 $90 ≤ Stock ≤ $110 → both options expire worthless; keep shares
 Stock < $90 → put exercised, sell at $90; max loss = (100−90)×100 = $1,000
```

This converts an open-ended position (unlimited upside / up to $10,000 downside) into a bounded ±$1,000 range [1]. To skew toward zero cost on a real chain, the put would typically sit a touch farther OTM (e.g., $90) than the call is (e.g., $109–110) because the put is richer per unit distance [3].

## 5. Tenor conventions

Retail collars commonly use **30–90 day** options on both legs. The institutional benchmark deliberately mismatches tenors. The **Cboe S&P 500 95-110 Collar Index (CLL)** holds the S&P 500, **buys 3-month (quarterly) SPX puts struck 5% OTM (95% of spot)** for protection and **sells 1-month (monthly) SPX calls struck 10% OTM (110% of spot)**, rolling at SPX expirations (typically the third Friday); a "cross-roll" replaces the standing put if a new call strike would fall below it [4]. Variants: **CLL3M** uses a 3-month put *and* 3-month 10% OTM call (both quarterly); **CLL1M** (Risk Managed Income) pairs a monthly 5% OTM put with a monthly *at-the-money* call [4]. The longer-dated put plus shorter-dated, repeatedly-sold call is the standard institutional way to lower net hedging cost while keeping continuous downside protection.

## 6. Institutional collar usage and performance

Collars are a mainstream institutional hedge for large or concentrated equity exposure:

- **Concentrated single-stock positions.** The CAIA study *De-Risking Concentrated Stock Positions* (Boczar & Pai, Intelligent Edge Advisors) describes the equity collar — long puts (struck at or, more typically, below market) financed by short calls (struck above market) — as the standard tool for executives/insiders to preserve unrealized gains affordably, retain dividends and some upside, and defer capital-gains tax; it notes many holders still judge strategic collars "too costly" because of forfeited upside [6].
- **Pension funds.** LGIM America documents pension plans using collar structures to cut the volatility of return-seeking equity portfolios and limit drawdown while still meeting funding targets, "defining the range of equity outcomes" to control funded status [7].
- **Academic / OIC research.** Szado & Schneeweis's *Loosening Your Collar: Alternative Implementations of QQQ Collars* (University of Massachusetts, Isenberg School; sponsored by the Options Industry Council) found that over a 138-month window a passive QQQ collar (2% OTM 6-month put + 2% OTM 1-month call) returned **>185% (≈9.6%/yr)** while long QQQQ went through a "lost decade"; during April 1999–Sept 2002 QQQQ fell **>75%** peak-to-trough (−23.3%/yr, 42% volatility) while the collar sharply curtailed the loss [8].

**CLL vs. S&P 500 (July 1, 1986 – Dec 31, 2014, excess of cash; Israelov & Klein, AQR / *Journal of Alternative Investments*, Summer 2016):**

| Metric | CLL collar | S&P 500 |
|---|---|---|
| Excess return | 3.2%/yr | 7.3%/yr |
| Volatility | 10.7% | 15.7% |
| Sharpe ratio | 0.30 | 0.47 |
| Beta | 0.62 (upside 0.68 / downside 0.58) | 1.00 |

The collar cut volatility by roughly a third and damped both up- and downside exposure, but at a materially lower return — and AQR noted that the CLL's actual implementation was *not* truly zero-cost despite the strategy's zero-cost marketing [9].

## 7. Delta-as-probability — the caveat

Delta is a useful but imperfect probability proxy. Formally, the true risk-neutral probability of finishing ITM is N(d₂) while delta ≈ N(d₁); across the 0.15–0.35 range traders actually use, the gap is only a few percentage points, so "0.30 delta ≈ 30% ITM" is a sound working shortcut [2]. Limits: Black-Scholes assumes lognormal returns and constant volatility, whereas real return distributions have fat tails and skew, so delta understates true crash odds; and delta is dynamic — it decays toward zero as expiration nears (theta) and can climb from 0.25 to 0.45+ if the stock rallies into the strike, so a "safe" short call can migrate into assignment territory [2].

## 8. Tax and assignment considerations

- **Qualified covered call (QCC) rules.** Under IRC §1092 and Treasury regs (26 CFR §1.1092(c)-1; IRS TD 8990, effective April 29, 2002), writing a *qualified* covered call against owned stock is not treated as a straddle, preserving favorable holding-period/tax treatment — but only if the call meets term limits (granted not more than 12 months before expiration) and strike/benchmark conditions (not too deep ITM). Adding the protective put to form a collar can disturb this: **Revenue Ruling 2002-66** specifically addresses how collars affect QCC status, since a collar can create a straddle and suspend the stock's holding period.
- **Early assignment near ex-dividend.** Fidelity notes that a short call's early-assignment risk spikes when an in-the-money call's underlying goes ex-dividend: if the dividend exceeds the call's remaining time value, the call owner will likely exercise early to capture the dividend, forcing you to deliver shares and the dividend. The fix is to close or roll the short call (later expiration or higher strike) before the ex-dividend date — a real constraint when collaring a dividend-paying stock [10].

## Synthesis — recommended deltas

```
Sold Call Delta: 0.20 to 0.40 (target ~0.25–0.30)
 Reason: caps upside while collecting enough premium to fund the put;
 0.30 delta ≈ ~30% assignment probability; lower delta = more
 upside but less premium, higher delta = more credit but tighter cap.

Bought Put Delta: 0.15 to 0.30 (target ~0.20)
 Reason: sets the downside floor 5–10% below spot at lower cost than an
 ATM put; lower delta = cheaper but protection starts after a
 bigger drop; higher delta = better protection but pushes to a debit.

Symmetric vs. Asymmetric: ASYMMETRIC.
 Equity volatility skew makes puts richer than equidistant calls, so to hit
 zero cost you sell a slightly higher-delta call (~0.25–0.30) against a
 slightly lower-delta put (~0.20). An equal-% (symmetric) collar usually
 runs a small net debit.

Example Collar:
 Stock: $100 (own 100 shares)
 Sell call: $110 strike, Delta ≈ 0.25–0.30, premium ≈ $2.00
 Buy put: $90 strike, Delta ≈ 0.20–0.25, premium ≈ $2.00
 Net credit/debit: ≈ $0 (zero-cost); bounded outcome +$1,000 / −$1,000
 Tenor: ~30 days (retail), or institutional CLL-style 3-month put / 1-month call

Sources: CBOE Collar Indices Methodology [4]; OptionsPilot collar guide
[1]; Income Factory delta-as-probability [2]; TheOptionsBench
volatility skew [3]; Blue Collar Investor [5]; Szado & Schneeweis /
OIC QQQ collar study [8]; CAIA concentrated-stock study [6]; LGIM
pension collar [7]; Israelov & Klein / AQR CLL performance [9];
Fidelity ex-dividend assignment [10].
```

## Sources

1. [Collar Strategy: Covered Call with Protective Put](https://optionspilot.app/collar-strategy)
2. [What Delta Actually Tells You When You Sell a Covered Call — Income Factory](https://incomefactory.ai/learn/delta-as-probability-covered-calls)
3. [Selling Calls vs Selling Puts: Volatility Skew](https://theoptionsbench.com/guides/selling-calls-vs-selling-puts-skew/)
4. [Cboe_Collar_Indices_Methodology.pdf](https://cdn.cboe.com/api/global/us_indices/governance/Cboe_Collar_Indices_Methodology.pdf)
5. [The Collar Strategy from a Delta Perspective | The Blue Collar Investor](https://www.thebluecollarinvestor.com/the-collar-strategy-from-a-delta-perspective/)
6. [8_de-risking_1-18-18.pdf](https://caia.org/sites/default/files/8_de-risking_1-18-18.pdf)
7. [Tailor Your Risk by Buttoning-up with an Equity Collar](https://am.landg.us.com/insights/thought-leadership/tailor-your-risks-with-an-equity-collar/)
8. [oic-collar-qqq_030222-phone-update.pdf](https://www.optionseducation.org/getmedia/60c7d2e2-4ab5-47af-a742-a20abb4b2f9d/oic-collar-qqq_030222-phone-update.pdf)
9. [Risk-and-Return.pdf](https://www.aqr.com/-/media/AQR/Documents/Journal-Articles/Risk-and-Return.pdf)
10. [Dividends and Options Assignment Risk - Fidelity](https://www.fidelity.com/learning-center/investment-products/options/dividends-options-assignment-risk)