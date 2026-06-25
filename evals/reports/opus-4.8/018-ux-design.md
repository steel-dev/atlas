# Suggestion Timing, Flow, and Code Quality in AI Code Completion: A Cross-Tool, Cross-Experience Synthesis

## Scope and evidence quality

This report synthesizes nine fetched sources spanning vendor documentation, peer-reviewed HCI research, controlled productivity experiments, and a recent field-deployment study of suggestion timing. Two caveats shape every conclusion below. First, the single richest source on *presentation timing* (arXiv 2511.18842 [1]) studied only experienced developers, so the experience-cohort comparison the question asks for is reconstructed from a *different* set of studies (the GitHub/Microsoft productivity work [2][3][4]). Second, the trust-calibration evidence [5][6] comes from general AI-assisted decision-making, not code completion specifically; it is applied here by analogy and flagged as such. No single source ties latency, task type, experience, and explanation availability together — that synthesis is the analytical contribution, and it rests on bridging across sources.

## 1. Two distinct "latency" numbers — don't conflate them

A recurring confusion in interface design is treating "suggestion latency" as one thing. The evidence shows two separate clocks:

| Clock | What it measures | Documented value | Source |
|---|---|---|---|
| Model-serving latency | Time from request to a returned completion | GitHub Copilot mean response time **<200 ms**; serves 400M+ completion requests/day, ~8,000 req/s peak; uses streaming + globally distributed models; inter-region hops 50–100 ms | [7] |
| Presentation delay | How long the IDE *waits before showing* ghost text after a keystroke pause | Adaptive bounds of **0.80–1.40 s (implementing)** and **1.00–1.60 s (debugging)**, anchored to 97th-percentile inter-keystroke intervals (1.068 s / 1.293 s) | [1] |

The serving-latency target is an engineering floor: Copilot's pipeline pre-processes cursor context, sends a prompt to the model, and streams the response so text begins appearing "as soon as generation begins" [7]. GitHub's own application card confirms inline suggestions are *pause-triggered* — ghost text appears "when you pause while typing" — and that the team tracks **latency, acceptance rate, shown rate, edit quality, and retention** as the core online metrics [8].

The more design-relevant number is the *presentation delay*, and here arXiv 2511.18842 is the only source with controlled data [1]. Its key finding: a suggestion that arrives too eagerly — as the developer is about to resume typing — produces a "blind rejection," and rapid swings in delay caused a "pogo-sticking" artifact that inflated rejections. The team therefore set delay bounds to slightly *exceed* typical pause durations. Sub-200 ms serving is necessary but not sufficient; *when* the suggestion surfaces relative to the developer's cognitive rhythm matters more than how fast the model can generate it.

## 2. Acceptance rate by task type and interruption timing

The strongest empirical result on task-conditioned timing comes from the two-month professional deployment in arXiv 2511.18842 [1]:

| Timing policy | Acceptance rate |
|---|---|
| No delay (eager) | **4.9%** (k=267 / n=5,460; 95% CI 4.3–5.5) |
| Static delay | **15.4%** |
| Adaptive, state-aware delay | **18.6%** |

The adaptive policy used a binary cognitive-state classifier — **IMPLEMENTING vs. DEBUGGING** — trained on IDE telemetry (XGBoost, ~75% accuracy) [1]. The behavioral premise, confirmed in the deployment, is that developers *tolerate frequent short completions while writing or expanding code* but are *more sensitive to interruption while debugging* (reading logs, stepping through errors, root-cause search), which is why debugging warrants a longer delay (Dbase 1.30 s vs 1.10 s) [1]. The team also observed a perception threshold: once acceptance dips below ~10%, developers begin to experience the assistant as distracting (logistic inflection near 0.15) [1]. This maps directly onto the question's "debugging vs. new feature development" axis: new-feature/implementation work is the regime where proactive suggestions pay off; debugging is where they most need to be held back or made on-demand.

Acceptance rate is not a vanity metric. The CACM SPACE-framework study (Ziegler et al., 2,631 matched survey+telemetry responses) found **acceptance rate (accepted-per-shown) is the single best predictor of perceived productivity** (ρ=0.24, P<0.0001), outperforming code-contribution and persistence measures; in a PLS regression the first component (43.2% of variance) and second (13.1%) both drew most strongly on acceptance rate [2]. So timing policies that raise acceptance are, by this evidence, raising the metric most tied to developers' own sense of productivity — though the study cautions that considerable variance stays unexplained [2].

## 3. Microsoft / GitHub productivity studies

| Study | Design | Headline effect | Date |
|---|---|---|---|
| Peng et al., *Impact of AI on Developer Productivity* (MS Research + GitHub + MIT) [3] | RCT, ~95 freelancers, "build an HTTP server in JS" | Treated group **55.8% faster** (95% CI 21–89%, p=0.0017); 71.2 min vs 160.9 min. Success rate +7 pp (not significant) | Feb 2023 |
| Ziegler et al., CACM (SPACE) [2] | 2,631 survey+telemetry | Acceptance rate best predictor of perceived productivity (ρ=0.24) | 2022/2024 |
| Cui et al., *Three Field Experiments* (MS, Accenture, anon. firm), via DX [4] | Field RCTs, 7 / 4 / 2 months | **+26.08% task completion** (PRs; only PR significant), +13.55% commits, +38.38% builds; no drop in build success (code-quality proxy) | Sep 2024 |

Two cross-cutting cautions: in the controlled RCT the *time* gain was large and significant but the *correctness* gain was not [3]; and the field experiments found ~30–40% of developers never even tried Copilot when given access, so access ≠ adoption [4].

## 4. Experience level moderates acceptance, productivity, and risk

The evidence is consistent that **less experienced developers accept more, gain more on output metrics, and adopt faster** — with a quality caveat:

- **Adoption:** shorter-tenure developers 9.5% more likely to adopt; juniors 5.3% more likely [4].
- **Acceptance:** long-tenure developers **4.3% less likely** to accept suggestions; senior developers 1.8% less likely than juniors [4].
- **Output gains:** short-tenure +27–39% vs long-tenure +8–13%; junior +21–40% vs senior +7–16% [4].
- **RCT heterogeneity:** developers with *less* experience benefited most from Copilot [3].
- **Productivity–acceptance link by experience band** (CACM Table 4, correlation of acceptance rate with aggregate productivity): ≤2y 0.178, **3–5y 0.255, 6–10y 0.265**, 11–15y 0.171, ≥16y 0.153 — the link is *strongest in the mid-career 3–10y band* and weaker at both extremes; junior developers both report higher gains and accept more, but the acceptance↔productivity connection persists within every experience subgroup [2].

Mapping to the question's cohorts: the **2–5y** group is exactly where the productivity-acceptance correlation peaks and output gains are largest — the cohort most helped by, and most receptive to, proactive suggestions, but also (per the field study's own conclusion) the cohort at greater risk of accepting buggy or outdated code [4]. The **10+y** group accepts less, gains less on raw output, and shows a weaker acceptance–productivity tie — consistent with using AI more selectively and tolerating fewer interruptions.

## 5. Explanation availability and trust calibration

Here the picture is counterintuitive and important for "should we show why the AI suggested this":

- **Confidence beats explanation for calibration.** Zhang, Liao & Bellamy (FAT* 2020) found that showing a **confidence score** significantly improved trust calibration — people deferred to the AI more when its confidence was high (main effect F(1,64)=4.64, p=.035; calibration interaction F(4,256)=3.82, p=.005). A **local explanation did *not* improve calibration** over baseline (switch rates statistically indistinguishable from no-info, p=.66; H3 rejected) [5]. Crucially, calibrated trust alone did not improve joint accuracy unless the human held complementary knowledge to catch the AI's errors (AI 75% accurate vs human 65%) [5].
- **Explanations can backfire into over-reliance.** The Stanford CSCW 2023 study summarizes a "resilient" prior finding: the mere presence of an explanation tends to *increase* trust and *anchor* people to the AI's answer, so explanations exacerbate or fail to reduce over-reliance unless a **cognitive forcing function** compels engagement — and forcing functions reduce reliance on *correct* answers too, with people performing best in the conditions they trust least [6]. Its own contribution: explanations *can* reduce over-reliance, but only when they lower the cost of verification (make the AI's error obvious) *and* the benefit of engaging is high (hard tasks, higher stakes); on easy tasks people over-rely regardless [6].

Design implication: surfacing a *confidence signal* on a suggestion is better-supported for trust calibration than verbose rationale, and unconditional explanations risk inflating acceptance of wrong code — a particular hazard for the 2–5y cohort that already over-accepts [4][5][6].

## 6. Interruption cost and flow — the reason timing matters at all

The flow rationale is grounded in classic software-engineering interruption research. Parnin's resumption-strategies work cites van Solingen's industrial observation that developers spent roughly **an hour a day managing interruptions** and **typically needed ~15 minutes to recover** from one, and analyzed 10,000+ recorded programming sessions plus 414 survey responses to characterize how programmers rebuild lost context . The cost of a badly timed suggestion is therefore not the few hundred milliseconds of the popup but the disproportionate resumption lag it can trigger if it displaces the developer's working memory mid-thought. This is the mechanism that makes the implementing/debugging distinction matter: an interruption during effortful debugging (long inter-keystroke pauses) is exactly when resumption cost is highest, which is why the adaptive policy lengthens delay in that state [1].

## 7. Cross-tool comparison: interruption profile by mechanism

| Tool | Suggestion unit & trigger | Documented behavior / metrics | Interruption profile |
|---|---|---|---|
| **GitHub Copilot** (inline) | Single-to-multi-line ghost text, pause-triggered; <200 ms serving | Tracks acceptance/shown/edit-quality/retention/latency; acceptance rate = best productivity predictor [8][2][7] | Frequent, low-commitment; lightest per-event interruption, but high frequency makes timing discipline essential |
| **Tabnine** (multi-line) | On-the-fly completions, **full-function completions**, and **natural-language comment-to-code**, in VS Code, JetBrains, VS2022, Eclipse; adapts as you type [9] | Vendor docs describe behavior; no controlled latency/acceptance benchmark in fetched sources | Larger suggestion units (full functions) carry higher cognitive cost to evaluate — better suited to implementation than debugging |
| **Amazon Q Developer / CodeWhisperer** (comment-to-code) | Inline suggestions + chat; comment/intent → code | Dashboard reports inline **acceptance rate = accepted ÷ total suggestions**, and accepted-lines-of-code by feature (feature dev, docs, unit-test gen) [10][11] | Comment-to-code is closest to **on-demand/intent-driven** — the developer signals intent first, lowering surprise-interruption risk |

The clean design read: Copilot's inline model is the most *proactive* and so most exposed to mistimed interruption; comment-to-code (CodeWhisperer/Amazon Q, also offered by Tabnine) is intrinsically more *on-demand* because the developer authors a prompt; Tabnine's full-function predictions sit in between, offering large units that are high-value during feature work but expensive to vet during debugging.

## 8. JetBrains: proactive (local) vs. on-demand (cloud) as a built-in axis

JetBrains operationalizes the proactive/on-demand split architecturally:

- **Local Full Line Code Completion** runs a deep-learning model **entirely on-device**, suggests only syntactically correct whole lines, sends no code over the internet, and is tuned for *fast, real-time* suggestions tied to project context .
- **Cloud-based AI Assistant completion** uses greater compute for more precise single-line, block, and whole-function suggestions .
- JetBrains' analytics expose an **AI code acceptance rate** — accepted suggestions ÷ generated lines — explicitly framed as "an indication of the general quality, relevance, and trust in AI suggestions" .

This is a concrete instantiation of the report's central recommendation: the *low-latency, low-commitment, syntactically-safe* local engine is appropriate for proactive surfacing, while the heavier cloud generations are better gated behind explicit invocation.

## 9. Synthesis: when to surface proactively vs. on-demand

Reconciling latency thresholds, interruption cost, task type, and experience yields the following design rules, each traceable to evidence:

1. **Separate the two clocks.** Keep model-serving latency low (Copilot's <200 ms streaming is the reference point [7]), but treat *presentation delay* as the primary UX lever, not serving speed [1].
2. **Gate presentation on cognitive state, not a fixed timer.** A state-aware delay (≈0.8–1.4 s implementing, ≈1.0–1.6 s debugging) raised acceptance from 4.9% → 18.6% in deployment [1]. Set the delay to *exceed* the local pause distribution to avoid blind rejections [1].
3. **Be proactive during feature/implementation work; be reticent during debugging.** Implementation tolerates frequent inline completions; debugging is where interruption resumption cost (~15 min recovery ) is highest and acceptance is lowest, so suggestions there should be longer-delayed or shifted on-demand [1].
4. **Prefer on-demand / intent-driven modes for large or risky generations.** Comment-to-code (CodeWhisperer/Amazon Q, Tabnine) and whole-function generation should be invoked, not pushed, because the cost of evaluating a large wrong suggestion is high and the developer's authored prompt both signals readiness and reduces surprise [10][9].
5. **Tune defaults by experience.** For **2–5y** developers — highest acceptance, largest output gains, strongest acceptance↔productivity link, but greatest over-acceptance risk — proactive inline suggestions are valuable, but pair them with verification scaffolding [2][4]. For **10+y** developers — lower acceptance, fewer interruptions tolerated — bias toward on-demand and longer delays [4].
6. **Surface a confidence signal rather than relying on free-text rationale to build trust.** Confidence scores calibrate trust; explanations alone tend to inflate acceptance (including of wrong code) unless they make errors easy to spot and the task is hard/high-stakes [5][6]. A cognitive-forcing cue (e.g., a brief verify step) is justified specifically where over-acceptance risk is high — i.e., for junior cohorts and security-sensitive code [6][8].
7. **Instrument acceptance, shown rate, edit quality, retention, and post-accept persistence.** These are the metrics the vendors themselves track [8][2][10]; watch the ~10% acceptance "distraction" threshold as a signal that timing is wrong [1].

The throughline: low serving latency is table stakes, but the decisive design variables are *presentation timing conditioned on task state*, *suggestion size matched to interruption cost*, *experience-tuned defaults*, and *confidence-based (not explanation-heavy) trust signals*. Proactive surfacing earns its keep during implementation for less-experienced developers; on-demand invocation is the safer default during debugging, for large generations, and for senior developers.

## Sources

1. [Optimizing LLM Code Suggestions: Feedback-Driven Timing with Lightweight State Bounds](https://arxiv.org/html/2511.18842)
2. [Measuring GitHub Copilot’s Impact on Productivity – Communications of the ACM](https://cacm.acm.org/research/measuring-github-copilots-impact-on-productivity/)
3. [The Impact of AI on Developer Productivity: Evidence from GitHub Copilot](https://ar5iv.labs.arxiv.org/html/2302.06590)
4. [What three experiments tell us about Copilot’s impact on productivity](https://newsletter.getdx.com/p/copilot-impact-on-productivity)
5. [Effect of Confidence and Explanation on Accuracy and Trust Calibration in AI-Assisted Decision Making](https://ar5iv.labs.arxiv.org/html/2001.02114)
6. [xai-cscw-2023.pdf](https://hci.stanford.edu/publications/2023/xai-cscw-2023.pdf)
7. [How GitHub Copilot Serves 400 Million Completion Requests a Day](https://www.infoq.com/presentations/github-copilot/)
8. [Application card: GitHub Copilot inline suggestions - GitHub Enterprise Cloud Docs](https://docs.github.com/en/enterprise-cloud@latest/copilot/responsible-use/inline-suggestions)
9. [Code Completions | Tabnine Docs](https://docs.tabnine.com/main/getting-started/code-completion)
10. [Descriptions of Amazon Q Developer dashboard usage metrics - Amazon Q Developer](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/dashboard-metrics-descriptions.html)
11. [Unlocking the power of Amazon Q Developer: Metrics-driven strategies for better AI coding | Amazon Web Services](https://aws.amazon.com/blogs/devops/unlocking-the-power-of-amazon-q-developer-metrics-driven-strategies-for-better-ai-coding/)