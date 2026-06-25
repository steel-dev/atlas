# Methodological Tensions in Difference-in-Differences Under Staggered Adoption

## 1. The core problem: why staggered TWFE breaks down

The recent DiD literature is organized around a single diagnosis: the two-way fixed effects (TWFE) regression that recovers the average treatment effect on the treated (ATT) in the canonical two-group, two-period design generally fails to do so once treatment is adopted at different times by different units and treatment effects are heterogeneous [1].

- **Static TWFE** (outcome on unit and period fixed effects plus a single "treated now" dummy) recovers a common effect *only* if effects are homogeneous across units *and* across time-since-treatment. Under dynamic heterogeneity, its coefficient is a *non-convex* weighted average of period-specific effects whose weights sum to one but can be **negative**, so the estimand can be negative even when every underlying effect is positive; longer-run effects are especially prone to negative weights [1].
- **Goodman-Bacon (2021)** showed the static estimand is a convex weighted average of all possible 2×2 DiD comparisons between units that change treatment status and units that do not — but this includes **"forbidden comparisons"** that use *already-treated* (early-adopting) units as the control group for later adopters. An early-treated unit receives negative weight when it serves as a control for many later-treated units. Mechanically (via Frisch-Waugh-Lovell), the regression weight on an observation is proportional to \(D_{it}-\hat D_{it}\); early adopters in late periods can have \(\hat D_{it}>1\), so their treated outcomes enter with a negative sign [1].
- **Dynamic TWFE** (event-study regression on relative-time dummies) is sensible if heterogeneity is only in time-since-treatment, but **Sun and Abraham (2021)** showed that with heterogeneity *across adoption cohorts* each relative-period coefficient (i) can place negative weight on its own-period effects and (ii) is **contaminated** by effects at *other* relative periods. A critical implication is that the pre-treatment "lead" coefficients are not guaranteed to be zero even when parallel trends holds in every period — so reading pre-trends off a dynamic TWFE event study can be misleading [1].

A parallel literature reached the same conclusion from the weighting side: **de Chaisemartin and D'Haultfœuille (2020)** decompose the TWFE estimand into a weighted sum of group×period ATEs whose weights can be negative, and document substantial negative-weighting in applications [2].

## 2. The proposed solutions and how they differ

All of the heterogeneity-robust estimators share a common logic: define a target parameter — the **group-time ATT**, \(ATT(g,t)=E[Y_{it}(g)-Y_{it}(\infty)\mid G_i=g]\), the effect at time \(t\) for the cohort first treated at \(g\) — identify it from a *clean* (untreated) control group under parallel trends and no anticipation, and then **aggregate** the disaggregated \(ATT(g,t)\)s into event-study or overall summaries using researcher-chosen weights rather than the implicit OLS variance weights [1].

**Callaway and Sant'Anna (2021) — the two-stage aggregation / group-time approach.** Estimate each \(ATT(g,t)\) as a DiD that compares cohort \(g\)'s change from its last pre-treatment period \(g{-}1\) to \(t\) against a clean control group, then aggregate. The control group is either **never-treated** units or **all not-yet-treated** units. Because the baseline is the single last untreated period, identification relies only on **post-treatment** parallel trends (Assumption 4.a), a weaker assumption. The framework extends to *conditional* parallel trends through regression-adjustment, inverse-probability-weighting, and **doubly-robust** estimation (Sant'Anna and Zhao 2020), the last consistent if *either* the outcome or the propensity-score model is correct and efficient if both are [1].

**Borusyak, Jaravel and Spiess (2021/2024) — the imputation approach.** Fit a TWFE model for the untreated potential outcome \(Y_{it}(\infty)=\alpha_i+\lambda_t+\varepsilon_{it}\) using **only not-yet-treated observations**, impute \(\hat Y_{it}(\infty)\) for treated observations, take \(Y_{it}-\hat Y_{it}(\infty)\) as unit-level effects, and aggregate. They derive this as the **efficient** estimator under treatment-effect heterogeneity, and it is exactly efficient under homoskedastic, serially uncorrelated errors. Related imputation-style proposals include Gardner (2021), Liu-Wang-Xu (2022) and Wooldridge (2021) [1][3].

**Sun and Abraham (2021) — the interaction-weighted (IW) estimator.** Use the same \(ATT(g,t)\) building block as Callaway-Sant'Anna but with the comparison group being **never-treated** units or, absent them, the **last-to-be-treated** cohort. It is implemented by saturating the event-study regression with cohort × relative-time interactions (cohort-average treatment effects, CATTs) and then aggregating with cohort-share weights — hence "interaction-weighted." This directly removes the cross-cohort contamination of plain dynamic TWFE [1].

**Other related approaches.** de Chaisemartin and D'Haultfœuille's \(DID_M\) coincides with the Callaway-Sant'Anna estimator for the contemporaneous effect under particular weights, but is designed for **non-absorbing** (on/off) treatment and requires an additional **"no-carryover"** assumption (outcomes depend only on current, not past, treatment status) that the synthesis flags as restrictive [1][2]. **Stacked regression** (Cengiz-Dube-Lindner-Zipperer 2019; Gardner 2021) matches each treated unit to clean controls with event-specific fixed effects and estimates a convex weighted average of \(ATT(g,t)\), but the weights are set by the number of treated units and treatment variance within each stack, not by economic relevance [1].

### Comparison of assumptions

| Estimator | Target | Comparison group | Pre-periods used | Parallel-trends assumption | Treatment-effect heterogeneity | Anticipation |
|---|---|---|---|---|---|---|
| Static/dynamic TWFE | implicit OLS-weighted avg | implicit (incl. already-treated) | implicit | needs PT (Assn 4) | **must be homogeneous** to be valid | no anticipation |
| Callaway-Sant'Anna (CS) | \(ATT(g,t)\), aggregated | never- or not-yet-treated | last pre-period \(g{-}1\) | only **post-treatment** PT (Assn 4.a), weaker | arbitrary heterogeneity OK | no anticipation (Assn 5) |
| Borusyak-Jaravel-Spiess (BJS) | \(ATT(g,t)\), aggregated | all not-yet-treated | **all** pre-periods | PT in **all** periods (Assn 4), stronger | arbitrary heterogeneity OK | no anticipation |
| Sun-Abraham (IW) | CATT \(ATT(g,t)\) | never- or last-to-be-treated | event-study baseline | PT (excludes never-treated variant) | arbitrary heterogeneity OK | no anticipation |
| dCDH \(DID_M\) | switchers' effect | units with constant status | — | generalized PT | arbitrary heterogeneity OK | + **no carryover** |

All of the heterogeneity-robust estimators maintain **no anticipation** (Assumption 5: untreated-period outcomes do not depend on future treatment date) and a version of **parallel trends**; none assumes treatment-effect homogeneity. The substantive trade-offs are along two axes [1]:

- **Efficiency vs. robustness (CS vs. BJS).** Because BJS uses the *average of all pre-treatment periods* as baseline while CS uses *only the last* pre-treatment period, BJS is more efficient when errors are not too serially correlated and parallel trends holds across *all* periods. But BJS relies on the stronger all-period parallel-trends assumption; if untreated potential outcomes trend apart, the violation grows with the distance between compared periods, so BJS (using distant pre-periods) is *more biased* than CS (using only the adjacent period). CS is therefore preferable under high serial correlation or doubts about long-horizon parallel trends; BJS when those concerns are mild [1].
- **Choice of control group.** CS and Sun-Abraham differ in whether not-yet-treated or only never-/last-treated units form the comparison, which changes the exact parallel-trends variant required [1].

The synthesis authors' bottom line is that the *first-order* gain is moving to any estimator with a transparent target parameter and comparison group; in their practical experience the heterogeneity-robust estimators "typically (although not always) produce similar answers," and TWFE is justified only if one is confident effects are homogeneous [1].

## 3. How the newer estimators relate to Roth's (2022) pre-trend concerns

It is important to separate two distinct problems. The staggered-adoption estimators above solve the **aggregation/weighting** problem *conditional on a valid parallel-trends assumption*; they do **not** by themselves validate parallel trends. Roth's critique targets the second problem — how researchers test parallel trends — and is addressed by a *different* set of tools [1].

Roth identifies three issues with the standard practice of testing for pre-trends [1][4]:

1. **Low power.** A non-significant pre-trend does not imply parallel trends holds. In simulations calibrated to papers in three leading economics journals, linear violations of parallel trends that conventional tests would detect only ~50% of the time often produce **bias as large as, or larger than, the estimated treatment effect** [1].
2. **Pre-test (selection) bias.** Conditioning the analysis on having "passed" (not rejected) a pre-trends test selects a non-representative sample of draws and can *exacerbate* the bias from a true violation — estimates are biased in the direction of the (undetected) pre-trend [1][4].
3. **What to do on rejection.** A detected pre-trend signals parallel trends likely fails, yet researchers still want to learn about the effect; testing alone offers no remedy [1].

A telling statistic: because a pre-trends test that detects a violation only half the time will also produce a *spuriously significant treatment effect* about half the time, the practice can yield false positives roughly **ten times** more often than the nominal 5% rate [1].

The literature's responses, which the newer staggered estimators feed into rather than replace, are [1][4]:

- **Power and distortion diagnostics** (Roth 2022): formally assess a pre-test's power against *economically relevant* hypothesized violations and the likely distortion from pre-testing.
- **Non-inferiority tests** (Bilinski-Hatfield 2018; Dette-Schumann 2020): reverse the null and alternative so the null is a *large* trend, rejecting only with strong evidence the trend is small — directly attacking the low-power problem.
- **Sensitivity analysis / partial identification** (Rambachan and Roth 2023, *A More Credible Approach to Parallel Trends*): instead of assuming parallel trends holds exactly, bound post-treatment violations by the magnitude of observed pre-trends (or impose smoothness), producing robust confidence sets and a "breakdown" value at which conclusions change [1].
- Roth's original (2018/2022) work also derives **median-unbiased estimators and corrected confidence intervals** that remain valid when parallel pre-trends are violated [4].

A crucial bridge to the staggered literature: because Sun-Abraham show dynamic-TWFE pre-trend coefficients can be non-zero even under valid parallel trends (and zero under invalid ones), the *event-study plot used to assess pre-trends should itself be built from a heterogeneity-robust estimator* (e.g., Callaway-Sant'Anna), or the pre-test inherits the contamination problem [1]. The synthesis's recommended workflow is therefore: estimate with a heterogeneity-robust method, plot a clean event study, accompany it with power/non-inferiority diagnostics, and report a formal sensitivity analysis [1].

## 4. Methodological dominance in applied journals (2020-2024)

This is the sub-question the retrieved evidence supports **least**. The sources document the *methods* and *recommendations* thoroughly but do not provide a systematic tabulation of adoption rates, by estimator, within AER/QJE/JPE labor- and health-economics papers from 2020-2024, nor whether those authors justify their choice via Monte Carlo or sensitivity analysis. What can be supported:

- The baseline that TWFE was historically dominant: in a survey of the *American Economic Review* over 2010-2012, de Chaisemartin and D'Haultfœuille found that 33 of 337 papers (9.8%) used a two-way fixed effects or closely related regression, rising to 19.1% of empirical papers once theory papers and lab experiments are excluded — and fewer than 10% of those TWFE papers actually had a staggered-adoption design [2]. TWFE remained "by far the leading approach in applied work" for multi-period settings as the new methods emerged.
- Among the heterogeneity-robust alternatives, **Callaway and Sant'Anna (2021)** is the most fully institutionalized: it is the estimator the synthesis develops in greatest detail, has the richest set of extensions (covariates via doubly-robust estimation, multiple aggregation schemes), and ships with widely used statistical packages, alongside packages for BJS and Sun-Abraham, that make implementation and cross-estimator comparison routine [1]. This packaging is the proximate driver of uptake, but a precise adoption *ranking* across the three flagship journals is not established by the retrieved sources.
- On justification practice, the synthesis *prescribes* that researchers report power diagnostics and sensitivity analyses [1], and the methods papers themselves (notably BJS's efficiency results and the broader literature's simulations) rely on Monte Carlo evidence [3][1] — but the sources do not measure how often *applied* authors actually supply such justifications.

**Verdict on dominance.** On the strength of the evidence here, the safest characterization is that the field has converged on a *family* of group-time / imputation estimators rather than a single winner, with Callaway-Sant'Anna the most prominent and best-tooled reference implementation and BJS the leading efficiency-oriented alternative; the synthesis explicitly declines to crown one estimator because they usually agree and the right choice is context-dependent [1]. A rigorous claim about adoption *rates* and *justification practices* specifically in AER/QJE/JPE labor and health papers, 2020-2024, would require a bibliometric/replication study that the retrieved sources do not contain.

## 5. Summary

The staggered-adoption critique (Goodman-Bacon 2021; de Chaisemartin-D'Haultfœuille 2020; Sun-Abraham 2021) established that TWFE makes "forbidden comparisons" and can deliver wrong-signed estimands under heterogeneous, dynamic effects [1][2]. The remedies — Callaway-Sant'Anna's two-stage group-time aggregation, Sun-Abraham's interaction-weighted estimator, and Borusyak-Jaravel-Spiess's imputation estimator — all target transparent group-time ATTs under parallel trends and no anticipation, differing mainly in comparison group and in how many pre-periods they use, which trades efficiency (BJS) against weaker/longer-horizon parallel-trends assumptions (CS) [1][3]. None solves the *credibility* of parallel trends itself; Roth's (2022) demonstration that pre-trend tests are under-powered and induce pre-test bias is met by power diagnostics, non-inferiority tests, and Rambachan-Roth sensitivity analysis, with the added lesson that event-study pre-tests must be built from heterogeneity-robust estimators to be interpretable [1][4]. Claims of outright methodological *dominance* by a single estimator in specific flagship journals over 2020-2024 outrun what the available sources can substantiate.

## Sources

1. [2201.01194](https://arxiv.org/pdf/2201.01194)
2. [Two-way fixed effects estimators with heterogeneous treatment effects](https://arxiv.org/abs/1803.08807v7)
3. [2108.12419](https://arxiv.org/pdf/2108.12419)
4. [1804.01208](https://arxiv.org/pdf/1804.01208)