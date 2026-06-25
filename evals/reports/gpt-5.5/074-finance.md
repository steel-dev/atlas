# Q3 2024 performance attribution and LP-call package

**Bottom line:** the fund underperformed RSP by **-6.6 percentage points / -660 bps** in Q3 2024 (**fund -8.7% vs benchmark -2.1%**), effectively the stated **-650 bps**. On **$5.0B** of AUM, the two largest positions were **NVDA 12% = $600M** and **MSFT 8% = $400M**, so the LP narrative should acknowledge that concentrated AI/cloud exposure amplified the drawdown. The workbook now exports the requested daily chart input table for **2024-07-01 through 2024-09-30** as `daily_price_volume_q3_2024.csv` and `.xlsx`, with `Date`, `NVDA_auto_adjusted_close`, `NVDA_volume`, `NVDA_indexed_price`, `NVDA_daily_return`, the same four fields for `MSFT`, and the same four fields for `RSP`; yfinance’s `download()` supports ticker lists, `start`, `end`, `interval`, `auto_adjust`, and `group_by`, uses an inclusive `start` and exclusive `end`, and returns a DataFrame suitable for this workflow [1]. The completed fund attribution workbook still requires the fund’s private daily NAV/holdings file for the allocation/selection variance split.

## 1) Required inputs, benchmark/proxy map, and exact quantities

| Item | Exact value / implementation | Evidence |
|---|---:|---|
| Fund Q3 2024 return | **-8.7%** | User-provided fund return |
| Benchmark Q3 2024 return | **RSP / S&P 500 Equal Weight benchmark: -2.1%** | User-provided benchmark return; RSP is based on the **S&P 500 Equal Weight Index** [2] |
| Active return | **-6.6 percentage points = -660 bps**, versus the prompt’s rounded **-650 bps** | Computed: -8.7% - (-2.1%) |
| AUM | **$5.0B** | User-provided |
| NVDA position | **12% = $600M** | Computed: $5.0B × 12% |
| MSFT position | **8% = $400M** | Computed: $5.0B × 8% |
| Broad benchmark | **Invesco S&P 500 Equal Weight ETF (RSP)**; underlying index **S&P 500 Equal Weight Index**, Bloomberg index ticker **SPXEWTR**; RSP invests at least 90% of assets in index securities and the index equally weights S&P 500 stocks [2] | [2] |
| Semiconductors | **PHLX Semiconductor Sector Index (SOX)**; modified market-cap-weighted index of companies primarily involved in semiconductor design, distribution, manufacture, and sale [3] | [3] |
| Enterprise software/services | **S&P Software & Services Select Industry Index**, Bloomberg ticker **SPSISS**; comprises S&P Total Market Index stocks in Application Software, Interactive Home Entertainment, IT Consulting & Other Services, and Systems Software sub-industries [4]. ETF proxy: **XSW** where daily tradable history is needed [4] | [4] |
| Cloud infrastructure | Use **CLOU ETF** as the tradable proxy; Global X states its Cloud Computing ETF **CLOU** tracks the **Indxx Global Cloud Computing Index**, not a Dow Jones Cloud Computing Index [5] | [5] |
| Daily data scope | **2024-07-01 through 2024-09-30**; in yfinance use `start='2024-07-01'`, `end='2024-10-01'`, `interval='1d'` because `end` is exclusive [1] | [1] |

## 2) 90-day price, relative-return, and volume-spike chart package

### Chart definitions

| Requested chart | Series | Formula | Required annotations |
|---|---|---|---|
| Absolute price performance | NVDA, MSFT, RSP | `indexed_price = adjusted_close / first_adjusted_close * 100` | Mark Q3 start/end and earnings/catalyst dates |
| Rolling 30-day relative return | NVDA vs RSP; MSFT vs RSP | `stock.pct_change(30) - rsp.pct_change(30)` | Mark periods where relative return drawdown widened |
| Volume spikes with catalysts | NVDA and MSFT daily volume | `volume_z = (volume - rolling_30d_mean) / rolling_30d_std`; flag `volume_z >= 2.0` | Overlay catalyst labels below |

### Daily chart-data export

| Export file | Date range | Columns |
|---|---|---|
| `daily_price_volume_q3_2024.csv`; `daily_price_volume_q3_2024.xlsx` | **2024-07-01 to 2024-09-30** | `Date`; `NVDA_auto_adjusted_close`, `NVDA_volume`, `NVDA_indexed_price`, `NVDA_daily_return`; `MSFT_auto_adjusted_close`, `MSFT_volume`, `MSFT_indexed_price`, `MSFT_daily_return`; `RSP_auto_adjusted_close`, `RSP_volume`, `RSP_indexed_price`, `RSP_daily_return` |

### Catalyst annotations to preload

| Date | Ticker(s) | Chart label | Attribution interpretation | Evidence |
|---|---|---|---|---|
| **2024-07-30 / 2024-07-31** | MSFT | FY2024 Q4 earnings: EPS/revenue beat, Azure miss, Q1 guide below consensus | Stock-specific: Azure growth/capex monetization concern. CNBC reported EPS **$2.95 vs $2.93 expected**, revenue **$64.73B vs $64.39B expected**, but Azure and other cloud services grew **29% vs 31% expected**, and FY2025 Q1 revenue guidance **$63.8B–$64.8B** was below LSEG consensus **$65.24B** [6]. | [6] |
| **2024-08-05** | NVDA, MSFT, tech broadly | Macro risk-off / recession-fear selloff | Macro/factor: risk-off move in major indices amid U.S. recession fears and megacap tech weakness [7]. | [7] |
| **2024-08-28 / 2024-08-29** | NVDA | Q2 FY2025 earnings and Q3 guide; high expectations reset | Stock-specific expectations: official Q3 guide was revenue **$32.5B ±2%**, GAAP/non-GAAP gross margin **74.4%/75.0% ±50 bps**, with Blackwell/Hopper commentary relevant to the transition [8][9]. Morningstar said Q2 results and Q3 forecast were ahead of its prior expectations and FactSet consensus, but the earnings beat was less “eye-popping” than prior quarters and shares weakened [10]. | [8], [9], [10] |
| **2024-09-03 / 2024-09-04** | NVDA | DOJ subpoena / antitrust report | Stock-specific/regulatory: Investopedia reported NVDA extended losses after a Bloomberg report that the Justice Department sent subpoenas to Nvidia and others [11]. | [11] |

## 3) Reproducible Python workbook: data, charts, peers, and attribution

```python
# Q3 2024 tech fund attribution workbook
# pip install yfinance pandas numpy matplotlib seaborn openpyxl

import numpy as np
import pandas as pd
import yfinance as yf
import matplotlib.pyplot as plt

START = '2024-07-01'
END = '2024-10-01' # yfinance end date is exclusive for daily data

FUND_Q3_RETURN = -0.087
RSP_Q3_RETURN = -0.021
ACTIVE_Q3_RETURN = FUND_Q3_RETURN - RSP_Q3_RETURN # -0.066 = -660 bps
AUM = 5_000_000_000
POSITIONS = {'NVDA': 0.12, 'MSFT': 0.08}

TICKERS = 
raw = yf.download(
 TICKERS,
 start=START,
 end=END,
 interval='1d',
 auto_adjust=True,
 group_by='ticker',
 progress=False,
 threads=True
)

# Robust panel extraction for yfinance group_by='ticker'
def get_field(field):
 out = {}
 for t in TICKERS:
 if (t, field) in raw.columns:
 out = raw
 elif t in raw.columns.get_level_values(0):
 out = raw
 return pd.DataFrame(out).dropna(how='all')

px = get_field('Close').ffill()
vol = get_field('Volume').ffill()
ret = px.pct_change()

# Explicit daily data output used by the charts: 2024-07-01 through 2024-09-30.
# With auto_adjust=True, Close is the adjusted/auto-adjusted close returned by yfinance.
chart_tickers = 
daily_price_volume = pd.DataFrame(index=px[chart_tickers].dropna(how='all').index)
for t in chart_tickers:
 daily_price_volume = px
 daily_price_volume = vol
 daily_price_volume = px / px.dropna().iloc[0] * 100
 daily_price_volume = ret
daily_price_volume = daily_price_volume.loc['2024-07-01':'2024-09-30'].reset_index().rename(columns={'Date': 'Date', 'index': 'Date'})
daily_price_volume.to_csv('daily_price_volume_q3_2024.csv', index=False)
daily_price_volume.to_excel('daily_price_volume_q3_2024.xlsx', index=False)

# 1) Absolute price performance chart: NVDA/MSFT/RSP
abs_idx = px].dropna()
abs_idx = abs_idx / abs_idx.iloc[0] * 100

fig, ax = plt.subplots(figsize=(11, 6))
abs_idx.plot(ax=ax, lw=2)
for d, label in {
 '2024-07-31': 'MSFT earnings / Azure miss',
 '2024-08-05': 'Macro risk-off',
 '2024-08-29': 'NVDA earnings / high bar',
 '2024-09-04': 'NVDA DOJ report'
}.items():
 dt = pd.Timestamp(d)
 if dt in abs_idx.index:
 ax.axvline(dt, ls='--', lw=1, alpha=0.6)
 ax.text(dt, ax.get_ylim()[1], label, rotation=90, va='top', fontsize=8)
ax.set_title('Q3 2024 indexed price performance: NVDA, MSFT, RSP (start=100)')
ax.set_ylabel('Indexed price')
ax.grid(True, alpha=0.3)
plt.tight_layout()
plt.savefig('chart_1_absolute_price_performance.png', dpi=200)

# 2) Rolling 30-trading-day relative return versus RSP
rel30 = pd.DataFrame({
 'NVDA_vs_RSP_30d': px.pct_change(30) - px.pct_change(30),
 'MSFT_vs_RSP_30d': px.pct_change(30) - px.pct_change(30)
}).dropna()

fig, ax = plt.subplots(figsize=(11, 6))
(rel30 * 100).plot(ax=ax, lw=2)
ax.axhline(0, color='black', lw=1)
for d, label in {'2024-07-31': 'MSFT', '2024-08-05': 'Macro', '2024-08-29': 'NVDA', '2024-09-04': 'DOJ'}.items():
 dt = pd.Timestamp(d)
 if dt in rel30.index:
 ax.axvline(dt, ls='--', lw=1, alpha=0.6)
 ax.text(dt, ax.get_ylim()[1], label, rotation=90, va='top', fontsize=8)
ax.set_title('Rolling 30-trading-day relative return vs RSP')
ax.set_ylabel('Relative return, percentage points')
ax.grid(True, alpha=0.3)
plt.tight_layout()
plt.savefig('chart_2_rolling_30d_relative_return.png', dpi=200)

# 3) Volume spikes: NVDA/MSFT, 30-day z-score and volume / 30-day average
vol30_mean = vol].rolling(30, min_periods=10).mean()
vol30_std = vol].rolling(30, min_periods=10).std()
vol_z = (vol] - vol30_mean) / vol30_std
vol_ratio = vol] / vol30_mean
spikes = (vol_z >= 2.0)

fig, axes = plt.subplots(2, 1, figsize=(11, 8), sharex=True)
for i, t in enumerate():
 ax = axes
 vol_ratio.plot(ax=ax, lw=1.5, label=f'{t} volume / 30d avg')
 spike_dates = vol_ratio.index.fillna(False)]
 ax.scatter(spike_dates, vol_ratio.loc, color='red', s=25, label='z >= 2 spike')
 for d, label in {
 '2024-07-31': 'MSFT earnings/Azure',
 '2024-08-05': 'Macro risk-off',
 '2024-08-29': 'NVDA earnings',
 '2024-09-04': 'NVDA DOJ report'
 }.items():
 dt = pd.Timestamp(d)
 if dt in vol_ratio.index:
 ax.axvline(dt, ls='--', lw=1, alpha=0.5)
 if (t == 'MSFT' and 'MSFT' in label) or (t == 'NVDA' and 'NVDA' in label) or label == 'Macro risk-off':
 ax.text(dt, ax.get_ylim()[1], label, rotation=90, va='top', fontsize=8)
 ax.set_title(f'{t}: Q3 2024 volume spikes')
 ax.set_ylabel('Volume / 30d avg')
 ax.grid(True, alpha=0.3)
 ax.legend(loc='upper left')
plt.tight_layout()
plt.savefig('chart_3_volume_spikes.png', dpi=200)

# 4) Peer comparison: total and active returns vs RSP
peer_cols = 
peer_px = px.dropna(how='all').ffill()
peer_total = peer_px.iloc[-1] / peer_px.iloc[0] - 1
peer_table = pd.DataFrame({
 'Q3_total_return': peer_total,
 'Active_vs_RSP': peer_total - peer_total
})
peer_table.loc = FUND_Q3_RETURN
peer_table.loc = ACTIVE_Q3_RETURN
peer_table = peer_table.loc]
peer_table.to_excel('peer_relative_performance_vs_RSP.xlsx')

# 4b) Stock-level active contribution bridge for largest named holdings.
# Approximate because 12% NVDA and 8% MSFT are stated holdings, not daily position files.
stock_total = px].dropna().iloc[-1] / px].dropna().iloc[0] - 1
stock_active_bridge = pd.DataFrame([
 {
 'Ticker': 'NVDA',
 'Stated_weight': POSITIONS,
 'Stock_Q3_total_return': stock_total,
 'RSP_Q3_total_return': stock_total,
 'Active_return_vs_RSP': stock_total - stock_total,
 'Approx_contribution_pct_points': POSITIONS * (stock_total - stock_total) * 100,
 'Approx_contribution_bps': POSITIONS * (stock_total - stock_total) * 10000,
 'Basis': 'Approximate: stated holding weight, not daily position file'
 },
 {
 'Ticker': 'MSFT',
 'Stated_weight': POSITIONS,
 'Stock_Q3_total_return': stock_total,
 'RSP_Q3_total_return': stock_total,
 'Active_return_vs_RSP': stock_total - stock_total,
 'Approx_contribution_pct_points': POSITIONS * (stock_total - stock_total) * 100,
 'Approx_contribution_bps': POSITIONS * (stock_total - stock_total) * 10000,
 'Basis': 'Approximate: stated holding weight, not daily position file'
 }
])
stock_active_bridge.to_csv('stock_active_contribution_bridge_q3_2024.csv', index=False)
stock_active_bridge.to_excel('stock_active_contribution_bridge_q3_2024.xlsx', index=False)
print(stock_active_bridge)

# 5) Sector attribution template: replace/fill fund_sector_returns and weights with PM/NAV data
# Required private file columns by Date:
# w_fund_semis, w_fund_software, w_fund_cloud, w_bench_semis, w_bench_software, w_bench_cloud,
# r_fund_semis, r_fund_software, r_fund_cloud, fund_return
# Benchmark sector proxy returns are computed below from ^SOX, XSW, CLOU.
sector_proxy = pd.DataFrame({
 'semis': ret,
 'software': ret,
 'cloud': ret,
 'benchmark_total': ret
}).dropna(how='all')

# Example attribution function once private sector panel is provided.
def brinson_fachler(panel):
 sectors = 
 rows = []
 for s in sectors:
 alloc = (panel - panel) * (panel - panel)
 select = panel * (panel - panel)
 interact = (panel - panel) * (panel - panel)
 rows.append(pd.DataFrame({
 'sector': s,
 'allocation': alloc,
 'selection': select,
 'interaction': interact
 }))
 out = pd.concat(rows).reset_index().rename(columns={'index': 'Date'})
 daily = out.groupby('Date')].sum()
 daily = daily.sum(axis=1)
 return daily

# Variance-share calculation once attribution_daily is available:
def attribution_variance_share(attribution_daily, actual_active_return=None):
 if actual_active_return is None:
 actual_active_return = attribution_daily
 comps = 
 var_active = np.var(actual_active_return.dropna(), ddof=1)
 simple = attribution_daily.var(ddof=1) / var_active
 cov_aware = attribution_daily.apply(lambda x: np.cov(x.loc, actual_active_return, ddof=1)[0, 1] / var_active)
 residual = 1.0 - cov_aware.sum()
 results = pd.DataFrame([{
 'Allocation %': cov_aware * 100,
 'Selection %': cov_aware * 100,
 'Interaction %': cov_aware * 100,
 'Residual %': residual * 100,
 'Total %': 100.0
 }])
 return pd.DataFrame({'simple_variance_share': simple, 'covariance_aware_contribution': cov_aware}), results

# Pending template until the private daily fund NAV/sector/security file is loaded.
sector_variance_results_template = pd.DataFrame([{
 'Allocation %': 'Pending private fund daily NAV/sector/security file',
 'Selection %': 'Pending private fund daily NAV/sector/security file',
 'Interaction %': 'Pending private fund daily NAV/sector/security file',
 'Residual %': 'Pending private fund daily NAV/sector/security file',
 'Total %': 'Pending private fund daily NAV/sector/security file'
}])
sector_variance_results_template.to_excel('sector_active_variance_results_template.xlsx', index=False)

print('Active return:', ACTIVE_Q3_RETURN, 'bps:', ACTIVE_Q3_RETURN * 10000)
print(peer_table)
```

## 4) Sector attribution framework and what can be reported before the private file is loaded

The required sector attribution answer should be produced from the workbook as a **percentage of active-return variance**, not as a static narrative. The results table should be populated only after the private daily fund NAV/sector/security file is loaded:

| Allocation % | Selection % | Interaction % | Residual % | Total % |
|---:|---:|---:|---:|---:|
| Pending private fund daily NAV/sector/security file | Pending private fund daily NAV/sector/security file | Pending private fund daily NAV/sector/security file | Pending private fund daily NAV/sector/security file | Pending private fund daily NAV/sector/security file |

The specific calculation is:

| Component | Daily formula | Variance contribution output |
|---|---|---|
| Allocation | `(w_fund_sector - w_bench_sector) × (r_bench_sector - r_bench_total)` | `cov(allocation, active_return) / var(active_return)` |
| Selection | `w_bench_sector × (r_fund_sector - r_bench_sector)` | `cov(selection, active_return) / var(active_return)` |
| Interaction | `(w_fund_sector - w_bench_sector) × (r_fund_sector - r_bench_sector)` | `cov(interaction, active_return) / var(active_return)` |
| Total active return | Allocation + selection + interaction, reconciled to actual active return where the private daily NAV series is available | Sum of covariance-aware contributions should reconcile to ~100% after residual treatment |

**Implementation call:** use **SOX** for semiconductors, **SPSISS** or daily proxy **XSW** for enterprise software/services, and **CLOU ETF / Indxx Global Cloud Computing Index** for cloud unless a licensed Dow Jones Cloud Computing Index return series is supplied. The reason for the CLOU treatment is definitional: the public CLOU source says the ETF seeks results corresponding to the **Indxx Global Cloud Computing Index** [5], while RSP’s source confirms it is based on the **S&P 500 Equal Weight Index** [2], Nasdaq identifies **SOX** as PHLX Semiconductor [3], and S&P DJI identifies **SPSISS** as the S&P Software & Services Select Industry Index [4].

## 5) Peer comparison template: fund versus ARKK, BGIAX, FSPTX, all benchmarked to RSP

| Vehicle | Benchmark for active return | Workbook ticker | Output metric |
|---|---|---:|---|
| Fund | RSP | Private fund return series; Q3 total return seeded at **-8.7%** | Q3 return; active return seeded at **-660 bps** |
| ARK Innovation ETF | RSP | ARKK | `ARKK_total_return - RSP_total_return` |
| Baillie Gifford American Fund | RSP | BGIAX, or user-specified institutional ticker if different | `BGIAX_total_return - RSP_total_return` |
| Fidelity Select Technology Sector | RSP | FSPTX | `FSPTX_total_return - RSP_total_return` |
| Benchmark | — | RSP | Q3 return; user-provided benchmark return **-2.1%** |

This structure ranks the fund and peers on the same active-return basis: **90-day total return minus RSP total return**. The workbook exports `peer_relative_performance_vs_RSP.xlsx` and can be sorted ascending/descending before the LP call.

## 6) Stock-level active contribution bridge for NVDA and MSFT

The workbook exports `stock_active_contribution_bridge_q3_2024.csv` and `.xlsx` with the following approximate bridge; it is approximate because the **12% NVDA** and **8% MSFT** inputs are stated holdings rather than daily position files.

| Ticker | Stated weight | Stock Q3 total return | RSP Q3 total return | Active return vs RSP | Approx. contribution, percentage points | Approx. contribution, bps |
|---|---:|---:|---:|---:|---:|---:|
| NVDA | 12% | Workbook output from `px` | Workbook output from `px` | `NVDA Q3 total return − RSP Q3 total return` | `12% × (NVDA Q3 total return − RSP Q3 total return)` | `12% × (NVDA Q3 total return − RSP Q3 total return) × 10,000` |
| MSFT | 8% | Workbook output from `px` | Workbook output from `px` | `MSFT Q3 total return − RSP Q3 total return` | `8% × (MSFT Q3 total return − RSP Q3 total return)` | `8% × (MSFT Q3 total return − RSP Q3 total return) × 10,000` |

## 7) Q3 2024 earnings guidance and consensus-revision synthesis: NVDA and MSFT

| Company | Relevant reporting period / date basis | Company guidance or reported guide | Consensus / revision evidence | Attribution read-through |
|---|---|---|---|---|
| **NVIDIA (NVDA)** | Q3 FY2025 outlook issued after Q2 FY2025 results, covering calendar Q3 2024 | Revenue **$32.5B ±2%**; GAAP gross margin **74.4% ±50 bps**; non-GAAP gross margin **75.0% ±50 bps**; GAAP opex about **$4.3B**; non-GAAP opex about **$3.0B**; tax rate **17% ±1%** [8] | **FactSet qualitative evidence:** Morningstar, dated **Aug. 29, 2024**, said Q2 results and Q3 forecast were ahead of its prior expectations and **FactSet consensus estimates**, but did not provide a FactSet before/after revision bridge [10]. **Indicative public proxy, not FactSet/I/B/E/S/broker revision feed:** Visible Alpha consensus dated **Nov. 13, 2024** showed Q3 FY2025 revenue expected at **$33.1B**; Q3 Data Center revenue estimate had risen from **$20.8B** in Jan. 2024 to **$29.0B**, with a more recent increase from **$28.5B to $29.0B**; FY2025 Data Center consensus had risen nearly **$1.0B to $110.5B** since the Q2 release, while FY2026 Data Center gross profit was down nearly **$8B** since the prior quarter [12]. | Fundamental guide supported the AI-demand thesis, but the stock-specific risk was expectations: the position was priced against a high AI/Blackwell ramp bar, with regulatory pressure after the DOJ report also relevant [11]. |
| **Microsoft (MSFT)** | FY2025 Q1 / calendar-Q3 2024 guide after FY2024 Q4 earnings | Revenue guide **$63.8B–$64.8B**, midpoint implying **13.8%** growth, below LSEG consensus **$65.24B**; operating expense midpoint **$15.25B** below StreetAccount consensus **$16.10B** [6] | **I/B/E/S/LSEG public evidence via CNBC:** FY2024 Q4 results beat headline consensus—EPS **$2.95 vs $2.93 expected**, revenue **$64.73B vs $64.39B expected**

## 8) LP-call talking points

1. **Acknowledge the result directly:** Q3 performance was **-8.7%** versus **-2.1%** for RSP, a **-6.6 percentage point / -660 bp** active return, effectively the stated **-650 bps**.
2. **Explain concentration without deflection:** at quarter start, NVDA was **12% / $600M** and MSFT was **8% / $400M** of the **$5B** fund, so two-stock AI/cloud exposure was a central amplifier of the drawdown.
3. **Separate macro from stock-specific drivers:** the **2024-08-05** risk-off move was macro/factor-driven, with major indices sinking amid U.S. recession fears [7]; MSFT-specific pressure came from Azure growth of **29% vs 31% expected** and below-consensus FY2025 Q1 revenue guidance [6]; NVDA-specific pressure came from a high post-earnings expectations bar, Blackwell/Hopper transition scrutiny, and the later DOJ subpoena report [11][8][9].
4. **Be precise on attribution status:** the workbook will report allocation, selection, and interaction as **covariance-aware percentages of active-return variance** once daily fund NAV, active weights, sector weights, and security-level returns are loaded; the exact allocation-vs-selection split should not be asserted before those private inputs are populated.
5. **Maintain the forward NVDA thesis, but define the risk gates:** NVDA guided Q3 FY2025 revenue to **$32.5B ±2%** and non-GAAP gross margin to **75.0% ±50 bps** [8], while consensus still reflected large upward Data Center revisions [12]; monitor Blackwell execution, China/regulatory exposure, and whether Data Center revisions continue to move higher.
6. **Maintain the forward MSFT thesis, with Azure proof points:** MSFT’s revenue guide was below LSEG consensus, but opex guidance was below StreetAccount consensus [6]; the forward case should hinge on Azure reacceleration, AI monetization, and operating discipline, not just headline AI capex.
7. **Commit to risk-control changes:** before the next earnings-heavy window, review max-position bands for top AI exposures, add a volume-spike/earnings-event review trigger, and evaluate sector-beta hedges around semiconductor and cloud/software factor risk using SOX, XSW/SPSISS, and CLOU proxies.

## Sources

1. [yfinance.download — yfinance](https://ericpien.github.io/yfinance/reference/api/yfinance.download.html)
2. [RSP - Invesco S&P 500 Equal Weight ETF fact sheet](https://www.invesco.com/content/dam/invesco/us/en/product-documents/etf/fact-sheet/rsp-invesco-s-p-500-equal-weight-etf-fact-sheet.pdf)
3. [Overview for SOX](https://indexes.nasdaq.com/Index/Overview/SOX)
4. [S&P Software & Services Select Industry Index](https://www.spglobal.com/spdji/en/indices/equity/sp-software-services-select-industry-index/)
5. [Cloud Computing ETF (CLOU)](https://www.globalxetfs.com/funds/clou/)
6. [Microsoft shares dip as cloud miss overshadows better-than-expected revenue and earnings](https://www.cnbc.com/2024/07/30/microsoft-msft-q4-earnings-report-2024.html)
7. [Major indexes sink amid US recession fears, drop in Apple shares](https://www.marketscreener.com/quote/stock/NVIDIA-CORPORATION-57355629/news/Major-indexes-sink-amid-US-recession-fears-drop-in-Apple-shares-47559754/)
8. [Document](https://www.sec.gov/Archives/edgar/data/1045810/000104581024000262/q2fy25pr.htm)
9. [Document](https://www.sec.gov/Archives/edgar/data/1045810/000104581024000262/q2fy25cfocommentary.htm)
10. [Nvidia Earnings: No Signs of an AI Slowdown](https://www.morningstar.com/stocks/nvidia-earnings-no-signs-an-ai-slowdown)
11. [Nvidia Stock Extends Losses After Report of DOJ Subpoenas](https://www.investopedia.com/nvidia-stock-extends-losses-after-report-of-doj-subpoenas-8706089)
12. [Nvidia Earnings Preview: Fiscal Q3 2025](https://visiblealpha.com/blog/nvidia-nvda-earnings-preview-fiscal-q3-2025/)