# Staggered-adoption DiD after Goodman-Bacon: estimator trade-offs, assumptions, pre-trends, and evidence on journal adoption

## Executive summary

The staggered-adoption critique is not that Difference-in-Differences (DiD) fails whenever treatment timing varies; it is that the familiar two-way fixed-effects (TWFE) regression generally stops estimating an interpretable average treatment effect when treatment effects differ across cohorts or evolve with exposure length. Goodman-Bacon’s decomposition shows that a TWFE DiD with variation in timing is a weighted average of all possible two-group/two-period DiDs, including comparisons in which already-treated units serve as controls for newly treated units; with dynamic or cohort-heterogeneous effects, those “forbidden” comparisons can put negative or otherwise nontransparent weights on causal effects [source_6, source_7]. The newer estimators all respond by defining cleaner cohort-time causal objects and then aggregating them, but they differ in what information they use and therefore in their identifying-assumption/efficiency trade-off.

The main methodological ranking is:

1. **Callaway–Sant’Anna (CS) group-time aggregation** is the most transparent estimand-first approach: estimate group-time ATT(g,t) using never-treated or not-yet-treated comparison groups, then aggregate to event-time, calendar-time, group, or overall summaries. It is especially attractive when researchers want explicit control over weights and when parallel trends over long pre-period horizons is questionable [source_1, source_7].
2. **Sun–Abraham (SA) interaction-weighted event-study estimators** are targeted most directly at dynamic event-study coefficients. They solve contamination of TWFE leads/lags by estimating cohort-by-relative-time effects and aggregating them using cohort-share weights, typically with never-treated or last-treated cohorts as clean controls [source_2, source_7].
3. **Borusyak–Jaravel–Spiess (BJS) imputation** and closely related **two-stage/Gardner** estimators are conceptually “predict untreated outcomes, then aggregate residualized treated outcomes.” They tend to be more efficient when the untreated-outcome model and parallel trends over all relevant pre-periods are credible, because they use more untreated observations for imputation; but that same feature can make them more vulnerable when long-horizon parallel trends is only approximate [source_10, source_7].

On the requested question of **methodological dominance in AER, QJE, and JPE labor/health applications published 2020–2024**, the fetched evidence does **not** support a defensible numerical adoption-rate claim. The sources retrieved include the core methodological papers, a review listing software implementations, and some journal/article-list material, but not a systematic hand-coded corpus of AER/QJE/JPE labor and health papers with estimator choices, Monte Carlo justifications, and sensitivity-analysis practices. Therefore, the strongest supportable conclusion is negative: **from the fetched sources, no estimator can be shown to have achieved measured dominance in those journals on adoption-rate grounds**. What can be said is that the review evidence treats CS, SA, BJS/imputation, Gardner/two-stage, and related packages as coexisting heterogeneity-robust options rather than identifying a single journal-standard estimator [source_7, source_8].

## 1. The Goodman-Bacon critique: why staggered timing breaks the TWFE default

The canonical two-period/two-group DiD regression has a clear ATT interpretation under parallel trends and no anticipation. In the staggered setting, however, adoption time varies and treatment is often absorbing. The recent literature reviewed by Roth, Sant’Anna, Bilinski, and Poe states the central result sharply: commonly used TWFE generalizations in multi-period staggered settings “often” do not correspond to intuitive causal parameters even under natural extensions of parallel trends and no anticipation [source_7, source_8].

Goodman-Bacon’s contribution is to decompose the TWFE coefficient into a weighted average of simpler 2×2 DiD comparisons. Some comparisons are clean—earlier-treated versus never-treated, later-treated versus never-treated, or treated versus not-yet-treated. Others compare newly treated units to already-treated units. When treatment effects are constant, these comparisons can still line up with a common effect. But when effects differ by cohort or evolve with exposure duration, already-treated controls carry their own treatment effects, so the regression subtracts treatment-effect dynamics from the effect of interest. This is the basis for the now-standard “forbidden comparisons” diagnosis and for concerns about negative or non-economic weights [source_6, source_7].

The issue extends to dynamic TWFE event studies. The review notes that with staggered adoption, event-study coefficients can place negative weight on the treatment effect at a given relative time for some units, and Sun–Abraham show that lead/lag coefficients can be contaminated by effects at other relative times [source_7, source_8]. Thus a conventional TWFE event-study pre-trend coefficient may reject even when pre-treatment parallel trends holds, or fail to reject when it does not, because the coefficient is partly a treatment-effect-heterogeneity artifact rather than a clean placebo effect [1].

## 2. How the proposed solutions handle heterogeneous effects and dynamic timing

### A. Callaway–Sant’Anna: group-time ATT first, aggregation second

Callaway and Sant’Anna’s solution is to make the primitive causal objects explicit: **ATT(g,t)**, the average treatment effect for the cohort first treated in period *g* at calendar time *t*. After estimating these group-time effects, researchers aggregate them into economically meaningful summaries, such as event-time effects, calendar-time effects, group-specific effects, or an overall ATT [source_1, source_7].

This approach handles heterogeneity by **not requiring treatment effects to be equal across cohorts or over exposure lengths**. Heterogeneity is preserved at the ATT(g,t) level; aggregation weights are chosen by the researcher rather than inherited from OLS treatment-variance weights [2]. The review emphasizes two advantages over TWFE: the resulting estimands remain sensible under arbitrary treatment-effect heterogeneity, and the control group used to infer missing untreated potential outcomes is transparent [2].

For dynamic timing, CS can produce an event-study estimand such as a weighted average of ATT(g,g+l), i.e., the average effect *l* periods after adoption across cohorts [2]. The key design decision is the comparison group. CS-type estimators can use never-treated units or not-yet-treated units, depending on availability and maintained assumptions [source_1, source_7].

### B. Sun–Abraham: interaction-weighted event-study coefficients

Sun and Abraham focus on the dynamic event-study problem. Their critique is that a TWFE coefficient on a relative-time indicator is generally not a clean average of effects at that same relative time when effects differ across cohorts or over time. Their fix is to saturate the event-study with **cohort × relative-time interactions**, estimate cohort-specific average treatment effects at each relative time, and then aggregate them with cohort-share weights [source_2, source_7].

This makes SA especially useful when the estimand of interest is a dynamic treatment path rather than a single overall ATT. It handles heterogeneous treatment effects by estimating cohort-relative-time effects before aggregation. It handles staggered timing by using clean comparison cohorts—typically never-treated units if available, or last-treated units when they can serve as untreated controls for earlier event times [source_2, source_7]. The review summarizes SA as an estimator that resembles group-time aggregation but uses never-treated or last-to-be-treated units rather than the not-yet-treated comparison group emphasized in some CS implementations [2].

The main limitation is scope: SA is particularly tailored to event-study dynamics. It is less of a general-purpose aggregation framework than CS and less explicitly efficiency-oriented than BJS. Its main advantage is interpretability of dynamic coefficients under heterogeneity.

### C. Borusyak–Jaravel–Spiess imputation: fit untreated outcomes, impute counterfactuals, aggregate

Borusyak, Jaravel, and Spiess develop a framework for staggered-adoption DiD with heterogeneous causal effects and show that conventional regression estimators require strong treatment-effect homogeneity restrictions to be unbiased for relevant estimands. Their efficient estimator has an intuitive imputation form when treatment-effect heterogeneity is unrestricted [3].

The BJS estimator proceeds in three steps:

1. Fit an untreated-potential-outcome model, often with unit and time fixed effects, using only untreated or not-yet-treated observations.
2. Use the fitted model to impute untreated potential outcomes for treated observations.
3. Compute treated-cell residuals, observed outcome minus imputed untreated outcome, and aggregate them with target weights [source_10, source_7].

This handles heterogeneous effects by never forcing treated residuals to equal a common effect. The treatment-effect heterogeneity is unrestricted at the cell level; restrictions enter through the untreated-outcome model and the aggregation target, not through constant treatment effects [3].

The main trade-off relative to CS is efficiency versus robustness to long-horizon violations. The Roth et al. review explains that, in a simple three-period non-staggered case, CS compares the treated and control groups from the last pre-treatment period to the treated period, whereas BJS compares the treated period to the average of pre-treatment differences. More generally, BJS uses all relevant pre-treatment information, which can improve precision and is efficient under homoskedasticity and serially uncorrelated errors when the stronger parallel-trends assumptions hold [2]. But because BJS relies on parallel trends across all relevant groups and periods, it can be more biased than CS when parallel trends holds only approximately over longer horizons [2].

### D. Gardner/two-stage DiD: residualize using untreated observations, then estimate treatment effects

Gardner’s two-stage DiD is closely related to imputation. The first stage estimates group and time effects using untreated observations only. The second stage subtracts these estimated untreated components from outcomes and regresses the adjusted outcomes on treatment or event-time indicators [source_4, source_7]. In the staggered absorbing-treatment setting, this is another way to avoid already-treated controls contaminating the counterfactual.

The two-stage estimator handles heterogeneity by estimating the untreated outcome process separately from treatment effects. Dynamic effects can be estimated by including event-time indicators in the second stage. Like BJS, the identifying leverage comes from a model for untreated potential outcomes and clean untreated observations; like CS and SA, it avoids the TWFE problem of using already-treated outcomes as untreated counterfactuals [source_4, source_7].

## 3. Assumption comparison

| Estimator family | Core estimand strategy | Parallel-trends requirement | Treatment-effect homogeneity | Anticipation handling | Main strength | Main vulnerability |
|---|---|---|---|---|---|---|
| Goodman-Bacon/TWFE diagnostic baseline | TWFE decomposes into weighted 2×2 DiDs | Parallel trends plus stronger conditions for causal TWFE interpretation | Effectively needs constant or sufficiently homogeneous effects for clean interpretation | Usually assumes no anticipation | Diagnoses why old TWFE fails | Already-treated comparisons and negative/nontransparent weights under heterogeneity [source_6, source_7] |
| Callaway–Sant’Anna | Estimate ATT(g,t), then aggregate | Can rely on post-treatment parallel trends for relevant group-time comparisons; can use never-treated or not-yet-treated controls | Allows arbitrary heterogeneity across cohorts and times before aggregation | No or limited anticipation; anticipation windows can be handled by redefining pre-periods/comparison timing | Transparent weights and controls | Potentially less efficient when earlier pre-periods are informative and valid [source_1, source_7] |
| Sun–Abraham IW | Estimate cohort × relative-time effects, then cohort-share aggregation | Parallel trends for clean comparison cohorts | Allows cohort-specific and dynamic heterogeneity | Requires no anticipation for leads to be valid placebo periods; can use clean cohorts such as never- or last-treated | Clean dynamic event-study coefficients | Less general for non-event-study summaries; depends on availability/validity of clean comparison cohorts [source_2, source_7] |
| BJS imputation | Fit untreated outcome model on untreated cells; impute Y(0); aggregate residuals | Generalized parallel trends/valid untreated-outcome model across all relevant untreated periods | Allows unrestricted treatment-effect heterogeneity in imputation form | No anticipation or modeled/tested anticipation restrictions | Efficiency and clear separation of untreated model from treatment effects | Stronger long-horizon untreated-outcome assumptions; bias risk if approximate parallel trends deteriorates over time [source_10, source_7] |
| Gardner/two-stage | First residualize using untreated observations; second-stage treatment/event-time regression | Additive untreated outcome model/parallel trends using untreated cells | Allows heterogeneity through second-stage aggregation rather than TWFE weighting | Requires no anticipation or appropriate exclusion of anticipatory periods | Simple regression implementation, close to imputation | Same broad concern as imputation: untreated model must be credible [source_4, source_7] |

The most important distinction is not “which estimator allows heterogeneity”—all of the newer estimators are designed to avoid the TWFE homogeneity trap. The distinction is **where the estimator places structure**:

- CS places relatively little structure on how pre-period information is pooled and emphasizes explicit group-time comparisons.
- SA places structure around event-time cohort interactions and solves the dynamic-coefficient contamination problem.
- BJS/Gardner place structure on the untreated-outcome model and use untreated observations efficiently to impute missing counterfactuals.

## 4. Performance assumptions and trade-offs

### Parallel trends

All approaches still require some version of parallel trends; none solves unobserved time-varying confounding by construction. The difference is the version of parallel trends invoked.

CS can be attractive when researchers trust local comparisons around treatment but are wary of imposing parallel trends over long pre-treatment horizons. The Roth et al. review states that in a simple example CS uses the last pre-treatment period, while BJS uses the average of pre-treatment periods; BJS may be more efficient but relies on parallel trends for all groups and time periods, whereas CS relies on a shorter-horizon post-treatment parallel-trends condition [2].

BJS is attractive when the untreated-potential-outcome model is credible over the full pre-treatment history. Under homoskedasticity and serially uncorrelated errors, the BJS estimator is efficient, but this efficiency comes from using more pre-treatment information and hence from stronger assumptions over longer horizons [source_7, source_10].

SA requires parallel trends between treated cohorts and their clean comparison cohorts for each relative-time effect. It is not mainly an efficiency device; it is designed to ensure that event-study coefficients correspond to the intended cohort-relative-time effects rather than contaminated TWFE mixtures [source_2, source_7].

### Treatment-effect homogeneity

This is where the new estimators sharply dominate conventional TWFE. TWFE event-study and static coefficients need strong restrictions—same effects across cohorts and/or same effects across exposure duration—to recover simple causal parameters [source_7, source_10]. CS, SA, BJS, and Gardner instead allow treatment effects to differ by cohort, calendar time, and exposure length, then aggregate explicitly [source_1, source_2, source_4, source_10].

### Anticipation effects

All estimators require either no anticipation or an explicit adjustment for anticipation. The staggered no-anticipation assumption says untreated-period outcomes should not depend on a unit’s future treatment date before treatment starts [source_7, source_8]. CS can accommodate limited anticipation by moving the relevant untreated reference period earlier and redefining which comparisons are clean [4]. SA lead coefficients are interpretable as pre-trend/placebo coefficients only if there is no anticipation in those lead periods; otherwise, pre-treatment relative-time effects may be real anticipatory effects rather than assumption checks [5]. BJS explicitly frames its testing procedure as testing generalized parallel-trend and no-anticipation assumptions using untreated observations only [3]. Gardner/two-stage methods likewise require that observations used to estimate untreated potential outcomes are genuinely untreated and uncontaminated by anticipation [6].

## 5. Which approach dominates AER/QJE/JPE labor and health applications, 2020–2024?

The fetched sources are not sufficient to compute or verify adoption rates for AER, QJE, and JPE labor/health applications from 2020–2024. A valid dominance claim would require a defined corpus, inclusion/exclusion rules for “labor” and “health,” full-text or appendix coding of estimator choice, and coding of whether authors justified choices through Monte Carlo simulations, estimator comparisons, or sensitivity analyses. The materials retrieved do not provide such a corpus-level dataset.

What the sources do support is a more limited methodological-infrastructure conclusion. The Roth et al. review lists multiple software packages for heterogeneity-robust staggered-treatment DiD: `did`/`csdid` for Callaway–Sant’Anna, `eventstudyinteract` and `fixest` implementations for Sun–Abraham, `didimputation`/`did_imputation` for Borusyak et al., `did2s` for Gardner and related methods, and other packages for diagnostics and sensitivity analysis [source_7, source_8]. The same review presents these as a menu of recent DiD methods, not as evidence that one estimator has become dominant in top-five applied publications [source_7, source_8].

Accordingly, the defensible ranking based on the fetched evidence is:

1. **No measured dominance can be established from the fetched sources.**
2. **CS and SA appear especially visible as transparent aggregation/event-study solutions**, with dedicated packages and frequent treatment in the review literature [source_7, source_8].
3. **BJS/imputation and Gardner/two-stage appear increasingly central on efficiency and implementation grounds**, also with dedicated packages and strong methodological claims, but the sources do not show that they dominate applied AER/QJE/JPE labor/health practice [source_10, source_7].

On author justification, the methodological papers themselves use simulations or theoretical comparisons: BJS explicitly reports a simulation study and an application [3], while Gardner’s two-stage paper reports two Monte Carlo studies, each simulating 250 datasets with 50 units over 10 periods, and concludes that the two-stage estimators correctly identify informative average treatment-effect measures and sometimes outperform harder-to-implement alternatives [6]. But the fetched evidence does not allow a claim that applied AER/QJE/JPE labor/health authors in 2020–2024 typically justify estimator choice via their own Monte Carlo simulations. In applied work, the more likely justification documented by the methodological review is estimator-robustness and sensitivity analysis—e.g., using heterogeneity-robust estimators, TWFE diagnostics, and `honestDiD`/`pretrends` tools—rather than paper-specific Monte Carlo evidence [source_7, source_8].

## 6. How the newer estimators address Roth’s concerns about pre-trend testing

Roth’s critique has several layers. Pre-trend tests can have low power; passing a pre-test does not imply post-treatment parallel trends; conditioning analysis on passing a pre-test induces pre-test bias; and standard practice often gives little guidance after a pre-trend rejection [source_5, source_8]. The Roth et al. review states that in simulations calibrated to papers in three leading economics journals, violations that conventional tests detect only half the time can generate biases as large as, or larger than, estimated treatment effects [1].

The newer staggered-adoption estimators address these concerns only partially.

First, they fix a **contamination problem** specific to TWFE event-study pre-trends. Because SA, CS, BJS, and Gardner avoid already-treated controls and heterogeneous-effect contamination, their pre-treatment/event-study coefficients are more interpretable diagnostics of identifying assumptions than TWFE leads [source_2, source_7, source_8]. The review explicitly cautions against dynamic TWFE pre-trend tests in staggered settings because lead coefficients can be contaminated by post-treatment effects at other relative times, so the test may reject even when pre-treatment parallel trends holds, or vice versa [1].

Second, they do **not** make pre-trend testing a proof of parallel trends. Low power and post-treatment extrapolation remain. The review recommends improved diagnostics, including Roth’s power-analysis tools, non-inferiority approaches that test whether pre-trends are large rather than exactly zero, and robust/sensitivity approaches such as Rambachan–Roth bounds when parallel trends may be violated [1].

Third, BJS offers the most explicit estimator-level response to Roth’s pre-testing problem. BJS proposes a robust OLS-based pre-trend test using untreated observations only to test generalized parallel-trend and no-anticipation assumptions. They argue that this test is robust to treatment-effect heterogeneity and, under spherical errors, avoids the inference-after-pre-testing problem described by Roth because the test statistic is uncorrelated—and under normality independent—from the efficient treatment-effect estimator [3]. This is stronger than simply plotting clean pre-trends, although it still depends on the chosen alternative model and does not eliminate low-power concerns for poorly chosen or high-dimensional alternatives [3].

In short, the newer estimators improve pre-trend diagnostics by ensuring the plotted or tested pre-period coefficients are not TWFE artifacts. But Roth’s broader lesson remains: researchers should not treat an insignificant pre-trend test as validation. The best practice implied by the fetched sources is to combine heterogeneity-robust staggered DiD estimation with explicit pre-analysis of detectable violations, sensitivity analysis to plausible deviations from parallel trends, and clear reporting of the estimand and aggregation weights [source_8, source_10].

## Bottom line

The post-Goodman-Bacon literature has converged on a common principle: estimate clean cohort-time or imputed untreated counterfactual effects first, then aggregate transparently. CS emphasizes transparent ATT(g,t) aggregation and weaker/local pre-period use; SA specializes in uncontaminated dynamic event studies; BJS and Gardner emphasize imputation/two-stage residualization and efficiency under stronger untreated-outcome assumptions. None removes the need for parallel trends and no anticipation, but all avoid the treatment-effect homogeneity assumptions that made staggered TWFE unreliable. The fetched sources do not substantiate a numerical claim that any one estimator dominates AER/QJE/JPE labor and health applications in 2020–2024; they support instead a picture of methodological pluralism, with estimator choice depending on the estimand, the credibility of long-horizon parallel trends, the need for dynamic effects, and the desired balance between transparency and efficiency.

## Sources

1. [What’s Trending in Difference-in-Differences? A Synthesis of the Recent Econometrics LiteratureWe thank Brant Callaway, Bruno Ferman, Andreas Hagemann, Kevin Lang, David McKenzie, and David Schönholzer for helpful comments, and Scott Barkowski for suggesting the title.](https://ar5iv.labs.arxiv.org/html/2201.01194)
2. [DiD_Review_Paper.pdf](https://www.jonathandroth.com/assets/files/DiD_Review_Paper.pdf)
3. [2108.12419](https://arxiv.org/pdf/2108.12419)
4. [Callaway_SantAnna_2020.pdf](https://psantanna.com/files/Callaway_SantAnna_2020.pdf)
5. [event_studies_paper.pdf](https://lsun20.github.io/event_studies_paper.pdf)
6. [2sdd_current.pdf](https://jrgcmu.github.io/2sdd_current.pdf)