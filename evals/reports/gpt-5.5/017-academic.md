# Process tracing, Bayesian causal inference, and the problem of mechanisms in comparative-historical research

## Executive assessment

The methodological tension is not simply “qualitative narrative” versus “quantitative formalism.” Bennett and Checkel, Pearl, and Mahoney all reject unstructured causal storytelling; all ask researchers to state what evidence would discriminate among rival explanations. They differ, however, in the *unit at which mechanisms are made operational* and in what counts as solving confounding.

* **Bennett/Checkel-style process tracing** operationalizes mechanisms as temporally ordered processes, sequences, and conjunctures within a case. Its inferential core is diagnostic: gather within-case evidence, derive observable implications, and use hoop, smoking-gun, straw-in-the-wind, and doubly decisive tests to update confidence in rival mechanisms [1]. It treats Bayesian updating as a logic of probative evidence, not as Pearl’s formal graphical calculus.
* **Pearl-style causal inference** operationalizes mechanisms as modular structural equations represented by directed acyclic graphs (DAGs) and structural causal models (SCMs). A causal claim is identified when the graph justifies transforming observational quantities into interventional quantities such as \(P(y\mid do(x))\), often via do-calculus or criteria such as back-door adjustment [2] [3].
* **Mahoney’s Bayesian qualitative position** sits between these. It agrees with process tracers that the key evidence is often within-case, historical, and mechanism-relevant; it uses Bayesian/probative logic to classify how observations affect hypotheses. But Mahoney’s use of Bayes is a logic of qualitative hypothesis testing, not a full DAG-based identification program for average treatment effects [4] [5].

The strongest current consensus is therefore pluralist but design-based: cross-case statistical analysis is best used to estimate patterns, scope, and average or conditional effects; within-case process tracing is best used to test whether a hypothesized mechanism operated in selected cases, identify unmeasured contextual factors, probe rival explanations, and interpret heterogeneity. Integration is now usually framed as multimethod or nested analysis, Bayesian updating/triangulation, or design-based sequencing rather than as a single master method. The unresolved tension is that within-case mechanism evidence usually supports claims about *case-specific causal pathways*, whereas Pearlian and many quantitative designs target *identified estimands* such as average treatment effects. Those are complementary only when the estimand, case-selection rule, temporal ordering, and post-treatment status of mechanism evidence are made explicit.

## 1. Three ways of operationalizing causal mechanisms

### Bennett and Checkel: mechanisms as within-case processes

Bennett and Checkel’s edited volume *Process Tracing: From Metaphor to Analytic Tool* makes process tracing a method for defining, measuring, and testing hypothesized causal mechanisms; the opening chapter, “Process tracing: From philosophical roots to best practices,” was published online in 2014 and appears in the Cambridge volume edited by Andrew Bennett and Jeffrey T. Checkel [1]. Their definition centers on evidence about “processes, sequences, and conjunctures of events within a case,” used to develop or test hypotheses about causal mechanisms that explain that case [1].

This formulation matters because it refuses to equate mechanisms with a list of intervening variables. Some within-case observations are causal links; others are diagnostic clues whose value lies in discriminating among explanations. The method therefore asks researchers to deduce observable process implications and then assess their probative value. Bennett and Checkel inherit the Van Evera/Collier test vocabulary:

| Test type | Inferential role | Implication |
|---|---|---|
| Straw-in-the-wind | Neither necessary nor sufficient | Weakly shifts confidence toward or away from a hypothesis |
| Hoop test | Necessary but not sufficient | Failure can eliminate or seriously weaken a hypothesis; passage may add little |
| Smoking-gun test | Sufficient but not necessary | Passage strongly supports a hypothesis; failure does not eliminate it |
| Doubly decisive test | Necessary and sufficient | Passage confirms one hypothesis and eliminates rivals, though this is rare in social science |

Their best-practice rules push process tracing away from literary narrative and toward explicit causal adjudication: cast the net widely for alternative explanations; be equally tough on rivals; consider source bias; account for most-likely and least-likely case status; justify temporal starting and stopping points; gather diverse evidence but justify when enough has been collected; combine with case comparison where useful; allow induction; deduce observable implications; and accept that even good process tracing may remain inconclusive [1] [6].

### Pearl: mechanisms as structural equations and graphical links

Pearl’s framework starts from a different ontology of evidence. In SCMs, variables are linked by structural equations; the causal diagram encodes which variables are direct parents of which others, which arrows are absent, and which exogenous disturbances are assumed independent [2]. Mechanisms are modular components of the data-generating process, not primarily historically narrated sequences. A Pearlian graph is therefore not a chronology by itself; it is a formal representation of causal assumptions that licenses or forbids statistical operations.

The decisive distinction is between observation and intervention. Pearl’s do-calculus asks when interventional distributions such as \(P(y\mid do(x),z)\) can be rewritten in terms of observable distributions given the graph [3]. The back-door criterion is central: an adjustment set \(S\) is admissible if it contains no descendants of treatment \(X\) and blocks all back-door paths from \(X\) to \(Y\), that is, all paths entering \(X\) through an arrow into \(X\) [2]. This is why confounder identification is not a matter of adding all plausible covariates. It depends on the graph.

Pearl’s d-separation rules distinguish three operations often conflated in applied work:

* **Conditioning on common causes** can close noncausal back-door paths.
* **Conditioning on mediators** can block part of the causal effect or, for direct-effect questions, create bias unless the target is explicitly an intervention on the mediator rather than ordinary regression adjustment [2].
* **Conditioning on colliders or their descendants** can open noncausal paths and create spurious association [7].

Thus Pearl’s framework sharply distinguishes conditioning for description from conditioning for causal identification. The question is not whether a variable predicts the outcome, but whether adjusting for it blocks the right noncausal paths without opening new ones or blocking the causal path of interest.

### Mahoney: mechanisms as qualitative hypotheses tested with Bayesian logic

Mahoney’s 2012 “The Logic of Process Tracing Tests in the Social Sciences” defines process-tracing tests as combining preexisting generalizations with specific observations from within a single case to infer causation in that case. These tests help establish that an initial event or process occurred, that a subsequent outcome occurred, and that the former caused the latter [4]. Like Bennett and Checkel, Mahoney treats hoop, smoking-gun, and straw-in-the-wind tests as qualitative evidence tests, but he evaluates their strength through necessary and sufficient conditions [4].

Mahoney’s later work with Barrenechea makes the Bayesian logic more explicit. Their set-theoretic approach to Bayesian process tracing, first published online in 2017 and appearing in *Sociological Methods & Research* in 2019, treats hypothesis testing as updating beliefs by narrowing the possible states of the world; it classifies hoop and smoking-gun tests as zones in a continuous evidentiary space defined by expectedness and consequentialness of observations [5]. The article’s claim that Bayesian and set-theoretic process tracing are “two sides of the same coin” places Mahoney in dialogue with both QCA and Bayesian confirmation theory, but still apart from Pearl: the object of inference remains the evidentiary weight of observations for within-case hypotheses, not the graphical identification of \(P(Y\mid do(X))\) for a population [5].

## 2. Confounder identification: where the frameworks diverge most sharply

The key divide concerns what counts as identifying a confounder in observational data.

In Pearl’s framework, a confounder is not simply a variable correlated with treatment and outcome. Confounding is a graphical relation: unblocked back-door paths carry noncausal association between treatment and outcome. Identification requires a sufficient adjustment set, and bad adjustment can be as damaging as omitted adjustment. Elwert and Winship’s 2014 review of endogenous selection bias states the point in DAG language: selection bias arises from conditioning—through control, stratification, or sample selection—on a collider, a variable caused by two other variables, one associated with treatment and the other with outcome [7]. They emphasize that endogenous selection can result from conditioning on outcome variables, post-outcome variables, post-treatment variables, and even some pre-treatment variables; confounding, overcontrol, and collider selection are distinct identification problems [7]. Cinelli, Forney, and Pearl’s “Crash Course in Good and Bad Controls” similarly frames “bad controls” as variables whose inclusion causes the regression coefficient to diverge from the intended causal effect [8].

Bennett/Checkel-style process tracing approaches confounding differently. It cannot by itself estimate an average causal effect or guarantee balance between treated and untreated units. Its strength is instead to identify and probe rival explanations within a case: look for omitted variables, inspect residual differences among cases, test whether the proposed pathway actually operated, and use sequencing to assess whether alleged causes preceded and plausibly generated outcomes [1] [6]. Case selection matters: a most-likely case may be useful for testing whether a theory fails under favorable conditions, while a least-likely case may be useful for probing whether a mechanism operates despite adverse conditions [1]. But the method’s best-practice list also concedes its limits: good process tracing may remain inconclusive, and combining process tracing with case comparisons is often desirable [1].

Mahoney’s position again lies between the two. He asks whether a within-case observation was likely under one hypothesis and unlikely under rivals, but he does not require the analyst to write a full DAG and prove graphical identification before drawing case-specific causal conclusions [4]. Barrenechea and Mahoney’s Bayesian/set-theoretic version makes this more continuous and explicit: evidence matters because it changes the set of possible worlds in which a hypothesis remains plausible [5].

## 3. Equifinality: recipes, pathways, and graphs

Equifinality is the problem that the same outcome can arise through multiple causal routes. The frameworks handle it differently.

| Framework | How equifinality is represented | What the analyst does |
|---|---|---|
| QCA/Ragin | Multiple sufficient configurations, e.g. \(AB + CD \rightarrow Y\) | Identify necessary and sufficient set relations; calibrate cases into crisp or fuzzy sets; interpret alternative recipes |
| Bennett/Checkel process tracing | Multiple possible mechanisms leading to the same outcome | Test whether a specific pathway operated in a case; compare rival mechanisms using within-case evidence |
| Pearl/SCM | Alternative directed paths or sufficient causal structures in a graph/model | Specify the graph, identify the target intervention, and decide which paths are confounding paths, causal paths, mediators, or colliders |
| Mahoney | Rival hypotheses about necessary/sufficient conditions and within-case sequences | Use observations as Bayesian/probative tests that narrow plausible worlds |

Ragin’s QCA tradition makes equifinality most explicit. *The Comparative Method* appeared in 1987 and built a Boolean, case-oriented strategy for causal complexity [9]. Later, *Fuzzy-Set Social Science* (2000) and *Redesigning Social Inquiry* (2008) developed fuzzy-set QCA and set-theoretic methods as a “middle path” linking qualitative case knowledge with cross-case patterns [10] [11]. In crisp-set QCA, cases are either in or out of sets; in fuzzy-set QCA, membership ranges from 0 to 1 [12]. Multiple conjunctural causation means that outcomes are usually generated by combinations of conditions, that several combinations may produce the same outcome, and that a condition’s causal role may differ depending on whether it is present or absent in a particular configuration [13]. Necessity and sufficiency are set relations: an outcome may be a subset of a necessary condition, while a sufficient causal combination is a subset of the outcome [12].

Process tracing treats QCA-style equifinality as a prompt for within-case adjudication. If multiple recipes can produce democratic breakdown, revolution, or policy change, the process tracer asks whether the mechanism associated with a given recipe actually occurred in the case. A case may share a configuration with others but still fail a key hoop test if the temporally necessary step is absent. Conversely, smoking-gun evidence may show that one pathway operated even if cross-case data remain compatible with several recipes [1].

Pearl’s approach requires a more explicit causal model. Equifinality becomes a matter of graph specification: if several sufficient paths can produce \(Y\), the analyst must represent the alternative paths, decide which are causal pathways and which are noncausal back-door paths, and identify the target effect accordingly [2] [3]. Pearlian causal inference is therefore stricter about confounding but less naturally attuned than QCA to configurational “recipes” unless those recipes are translated into structural equations, interactions, or path-specific effects.

## 4. Empirical application I: Skocpol’s revolutionary causation

Skocpol’s *States and Social Revolutions* is the classic comparative-historical application against which these tensions can be seen. Published by Cambridge in 1979 and subtitled *A Comparative Analysis of France, Russia, and China*, it analyzes the French Revolution from 1787 through the early nineteenth century, the Russian Revolution from 1917 through the 1930s, and the Chinese Revolution from 1911 through the 1960s [14]. Skocpol defines social revolutions as rapid, basic transformations of state and class structures, accompanied and partly carried through by class-based revolts from below [15].

Her causal account is structural and anti-voluntarist. The book description identifies “state structures, international forces, and class relations” as the three elements that combine to explain the origins and accomplishments of social-revolutionary transformations [14]. Lawson’s 2019 review summarizes the two core causes as state breakdown from military challenge or defeat and administrative weakness, plus agrarian class structures that enable peasantries to mobilize beyond the reach of the state [15]. The mechanism is not revolutionary ideology or leadership intention but patterned relationships among international pressure, state crisis, agrarian class relations, and peasant mobilization [15].

Read through Bennett and Checkel, Skocpol is an early structural comparison whose process claims invite within-case testing: did state fiscal-administrative crisis precede elite rupture? Did international military pressure undermine old-regime capacity? Did agrarian class relations permit peasant collective action? A process tracer would treat each as a sequence to be checked within France, Russia, and China.

Read through QCA, Skocpol looks like a configurational argument: state breakdown may be necessary but not sufficient; agrarian class structure and peasant mobilization form part of a sufficient combination. Indeed, the fsQCA manual uses the example of state breakdown as a necessary but insufficient condition for social revolution to illustrate subset relations [12]. QCA captures the conjunctural character of Skocpol’s claim better than additive regression.

Read through Pearl, however, Skocpol’s account would require a DAG: international pressure affects state breakdown; state breakdown affects elite cohesion, coercive capacity, and peasant opportunity; agrarian class relations affect peasant mobilization; and social revolution is the outcome. The Pearlian challenge would be to distinguish confounders from mediators: for example, administrative weakness may be part of the causal mechanism from international competition to revolution, not a pre-treatment confounder to be controlled away. This illustrates why the same historical variable can be mechanism evidence in process tracing, a set member in QCA, and a mediator or confounder depending on the Pearlian estimand.

## 5. Empirical application II: QCA after Ragin

Ragin’s tradition was designed to handle exactly the forms of causal complexity that Skocpol made visible. Its core claims are conjunctural causation, equifinality, asymmetry, and necessity/sufficiency. Rather than ask for the independent net effect of each variable, QCA asks whether specific combinations of conditions are sufficient or necessary for an outcome [13]. This is why QCA became attractive in comparative case studies with medium-N designs: it allows multiple routes to an outcome while preserving case knowledge.

The tension with Pearlian causal inference is that QCA’s set relations are not automatically causal identification. A truth-table solution showing that \(AB\) is sufficient for \(Y\) does not by itself show that intervening to produce \(A\) or \(B\) would produce \(Y\), nor does it decide whether a condition is a confounder, mediator, or collider. Pearl would require a causal graph and an intervention query. Bennett/Checkel-style process tracing supplies one possible bridge: after QCA identifies candidate configurations, within-case tests can examine whether the implied mechanism operated. Mahoney and Barrenechea’s set-theoretic Bayesian process tracing is another bridge: it translates evidence into changes in the set of plausible worlds and explicitly connects QCA logic with Bayesian updating [5].

The current best use of QCA in this debate is therefore as a configurational cross-case mapping tool, not as a complete substitute for either process tracing or graphical identification. It is strongest at representing equifinality and causal asymmetry; it is weaker when the task is to identify a population-level intervention effect under observational confounding.

## 6. Empirical application III: mixed-methods studies of democratic breakdown and backsliding

The fetched source base did not contain a usable full-text empirical study of democratic breakdown/backsliding comparable to the Skocpol and QCA materials, so this report cannot responsibly ground named post-2010 works, country-year samples, or case lists for that literature. What can be grounded from the available sources is the methodological implication for such studies. Dunning’s chapter in the Bennett/Checkel volume explicitly extends the process-tracing transparency problem to multimethod research that combines formal models or cross-national regressions with case studies [6]. The warning is directly relevant to democratic-breakdown research designs: a cross-case model may identify associations or estimands only under its design assumptions, while the case study can probe whether the proposed erosion mechanism actually operated; the two forms of evidence should not be treated as interchangeable [6].

The same limitation applies to post-treatment evidence about mechanisms. Montgomery, Nyhan, and Torres show that researchers often condition on post-treatment variables when trying to demonstrate mechanisms or rule out alternatives, but that controlling for, dropping, or subsetting on variables affected by treatment can bias causal estimates [16]. Elwert and Winship show why: such conditioning can amount to selection on a collider or its descendant [7]. For democratic-breakdown studies, this means that evidence such as weakened courts, captured media, opposition fragmentation, or military defection may be crucial within-case mechanism evidence, but it must be temporally located. If those features are consequences or mediators of executive aggrandizement, treating them as pre-treatment controls in the cross-case model would risk post-treatment or collider bias [16] [7]. Thus, the available evidence supports the methodological rule, though not a sourced inventory of recent democratic-breakdown applications: cross-case analysis should estimate the chosen effect or pattern, and within-case tracing should test the sequence and mechanism without converting post-treatment mechanism evidence into bad controls.

## 7. How quantitative causal-inference critiques reshaped process tracing after 2010

Since 2010, the most important critiques from quantitative causal inference have concerned selection bias, collider bias, post-treatment conditioning, and bad controls. These critiques did not eliminate process tracing; they made its protocols more explicit.

Montgomery, Nyhan, and Torres’s 2018 AJPS article shows the broader methodological pressure. They argue that controlling for, dropping, or subsetting observations using variables affected by treatment can bias causal estimates, even in experiments; such practices are often motivated by attempts to demonstrate mechanisms or rule out alternatives [16]. They found that 46.7% of experimental articles in *AJPS*, *APSR*, and *JOP* from 2012–2014 used post-treatment conditioning practices [17]. Their warning applies directly to mixed-methods work: mechanism evidence is valuable, but conditioning statistical estimates on post-treatment mechanism variables can destroy identification.

Elwert and Winship’s 2014 review sharpened the selection-bias problem by showing that endogenous selection bias is conditioning on a collider or its descendant; the problem can arise through sample selection, stratification, or regression control [7]. Cinelli, Forney, and Pearl’s 2022 “bad controls” framework further clarified that a control variable is “bad” when its inclusion makes the coefficient diverge from the causal effect it is intended to represent [8]. Imai, Keele, Tingley, and Yamamoto’s 2011 work on causal mechanisms similarly cautioned that identifying mediation effects requires strong assumptions and that randomizing treatment alone is not enough to identify mechanisms [18].

Process-tracing protocols changed in response in five main ways:

1. **Pre-specification of causal sequence.** Analysts are pushed to state whether each piece of evidence is pre-treatment, treatment, mediator, outcome, or post-outcome evidence.
2. **Explicit rival hypotheses.** Bennett and Checkel’s call to cast the net widely and be equally tough on alternatives became more than a qualitative norm; it became a guard against omitted-variable and selection stories [1].
3. **Case-selection transparency.** Researchers increasingly justify whether cases are typical, deviant, most likely, least likely, or selected on the outcome, and they specify what inference such selection can and cannot support [6].
4. **Separation of mechanism testing from effect estimation.** Within-case evidence can support claims that a mechanism operated, but it should not be used as a regression control if it is post-treatment and the estimand is a total effect [16].
5. **Triangulation and multimethod sequencing.** Bennett and Checkel’s advice to seek diverse, independent streams of evidence and combine process tracing with case comparisons where useful became the standard way to reduce dependence on any single biased source [1].

## 8. Current methodological consensus and remaining tensions

As of 2026, the consensus is not that one framework has defeated the others. It is that causal inference is strongest when the research design assigns distinct jobs to distinct forms of evidence.

* **Use Pearlian tools** when the goal is identification of an intervention effect from observational or experimental data. The analyst should state the estimand, draw or otherwise specify causal assumptions, distinguish confounders from mediators and colliders, and justify adjustment sets.
* **Use process tracing** when the goal is to test whether a causal mechanism operated in a particular case, to evaluate sequence and timing, to discriminate among rival explanations, or to interpret why a statistical association appears in some contexts but not others.
* **Use QCA** when the goal is to map equifinal configurations, causal asymmetry, and necessary/sufficient set relations across a moderate number of cases.
* **Use Mahoney-style Bayesian logic** as an evidentiary bridge: within-case and cross-case observations both matter because they change the plausibility of hypotheses, but their inferential contribution must be assessed by how expected and consequential they are under rival explanations [5].

The best integrated designs are therefore nested or multimethod: begin with a theory and a graph/configurational map; estimate cross-case patterns where identification is credible; select cases transparently; trace mechanisms with pre-specified observable implications; and return to the cross-case model if process evidence reveals omitted pathways, heterogeneous effects, or misclassified variables. This is a triangulation logic, but not vague triangulation: it is design-based sequencing with attention to identification.

The unresolved tensions are real. Process tracing can show that a mechanism operated in a case, but it rarely estimates how large the effect is in a population. Pearlian graphs can identify an estimand, but only if the causal model is correctly specified, and they may flatten the historical temporality that process tracers consider essential. QCA represents equifinality elegantly, but set-theoretic sufficiency is not the same as an intervention effect. The practical consensus is to integrate, not collapse, these logics: mechanisms as within-case sequences, mechanisms as structural equations, and mechanisms as Bayesian evidentiary tests each answer different parts of the causal-inference problem.

## Sources

1. [Process tracing: From philosophical roots to best practices](https://stafforini.com/works/bennett-2015-process-tracing-philosophical/)
2. [r402.pdf](https://ftp.cs.ucla.edu/pub/stat_ser/r402.pdf)
3. [r350.pdf](https://ftp.cs.ucla.edu/pub/stat_ser/r350.pdf)
4. [The Logic of Process Tracing Tests in the Social Sciences](https://ideas.repec.org/a/sae/somere/v41y2012i4p570-597.html)
5. [A Set-Theoretic Approach to Bayesian Process Tracing - Rodrigo Barrenechea, James Mahoney, 2019](https://journals.sagepub.com/doi/10.1177/0049124117701489)
6. [Dunning_Process-Tracing-ch-8_final-before-proofs.pdf](http://www.thaddunning.com/wp-content/uploads/2015/10/Dunning_Process-Tracing-ch-8_final-before-proofs.pdf)
7. [Elwert-Winship-2014.pdf](https://users.ssc.wisc.edu/~felwert/causality/wp-content/uploads/2014/07/Elwert-Winship-2014.pdf)
8. [r493.pdf](https://ftp.cs.ucla.edu/pub/stat_ser/r493.pdf)
9. [The Comparative Method by Charles Ragin - Paper](https://www.ucpress.edu/books/the-comparative-method/paper)
10. [Redesigning Social Inquiry](https://press.uchicago.edu/ucp/books/book/chicago/R/bo5973952.html)
11. [Fuzzy-Set Social Science](https://press.uchicago.edu/ucp/books/book/chicago/F/bo3635786.html)
12. [fsQCAManual.pdf](https://sites.socsci.uci.edu/~cragin/fsQCA/download/fsQCAManual.pdf)
13. [23236_book_item_23236.pdf](https://uk.sagepub.com/sites/default/files/upm-assets/23236_book_item_23236.pdf)
14. [States and Social Revolutions](https://www.cambridge.org/core/books/states-and-social-revolutions/A4A4926D8BCB40269FB55582E870D7F1)
15. [International_Affairs_Skocpol_review.pdf](http://eprints.lse.ac.uk/101503/1/International_Affairs_Skocpol_review.pdf)
16. [post-treatment-bias.pdf](https://bpb-us-e1.wpmucdn.com/sites.dartmouth.edu/dist/5/2293/files/2021/03/post-treatment-bias.pdf)
17. [How Conditioning on Posttreatment Variables Can Ruin Your Experiment and What to Do about It](https://ajps.org/2019/06/10/conditioning-on-posttreatment-variables-can-ruin-your-experiment/)
18. [mediationP.pdf](https://imai.fas.harvard.edu/research/files/mediationP.pdf)