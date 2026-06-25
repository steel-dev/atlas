# CI/CD platform comparison for a 200+ service fintech deployment platform

## Executive conclusion

For a fintech platform with 200+ Java, Go, and Python microservices and 50–100 production deployments per day, the best fit depends on whether the organization values **GitOps/progressive-delivery orchestration as a first-class platform primitive** or wants CI to remain the orchestration control plane. Under the representative workload used below, **all three products can produce approximately the same developer-facing critical path** if enough runners or agents are available: about **45 minutes** for a 15-minute build, eight 15-minute test shards run in parallel, and three serial 5-minute deployment gates/stages. GitLab CI DAG pipelines and GitHub Actions reusable workflows do this with declarative job dependencies; Buildkite does it with `depends_on`, `wait`/`block` steps, and dynamically uploaded steps, adding only a small bootstrap/upload overhead for normal-sized generated pipelines [1][2][3][4].

The stronger distinction is operational:

1. **Lowest developer wait time:** tie among the three on the modeled pipeline when runner capacity is provisioned; Buildkite can be fastest in practice if the platform team owns elastic, warm self-hosted agent fleets and uses dynamic generation to skip unaffected work, but that advantage depends on agent engineering rather than the CI syntax itself [4][5].
2. **Lowest platform-maintenance burden across 200+ services:** **Buildkite dynamic pipeline generation** is the most centralizable when a platform team is comfortable owning a generator/template layer: one bootstrap file per repository can call a centrally maintained generator, and platform rules can be inserted centrally. GitLab is close because includes, components, and parent-child pipelines centralize a large share of logic. GitHub reusable workflows reduce duplication, but each repository still has caller workflows, pinned references, secrets passing, and version migration work; workflow templates are repository bootstrap mechanisms rather than live central updates [4][5][6][7][8][9][2].
3. **Best fintech controls with least custom work:** **GitLab** has the most integrated CI/CD control-plane evidence for deployments—protected environments, deployment approvals, visible approval histories, deployment records, job logs, and audit APIs are all in the same product surface [10][11][12][13]. GitHub Enterprise Cloud is also strong for repository governance, environment protection, SAML/SSO, audit log/API, and OIDC, but rollback/progressive delivery is usually implemented by workflow scripts or external deployment systems [14][15][16][17]. Buildkite Enterprise has strong audit export, SSO/SAML, team RBAC, block steps, job-log/build-export governance, and excellent external deployment integration, but progressive delivery and rollback state usually live in Argo CD/Argo Rollouts/Flagger/Spinnaker or custom deployment plugins rather than in Buildkite itself [18][19][5].
4. **Best progressive delivery with automated rollback:** none of the three CI products should be the sole source of rollout truth at 50–100 production deployments/day. The lowest-risk pattern is to let CI start and audit the release while a Kubernetes/GitOps controller owns rollout state, health checks, traffic shifting, and rollback. Among the three compared approaches, **Buildkite dynamic pipelines plus Argo CD/rollout tooling** is the most flexible and lowest-maintenance platform pattern if the organization accepts Buildkite Enterprise and agent/platform engineering; GitLab is the best integrated alternative when the organization wants a single DevSecOps control plane; GitHub Actions is cost-effective and familiar but carries the most per-repository workflow/secrets/versioning overhead at this scale.

**Recommendation:** for the stated goal—minimizing both developer wait time and platform-engineering maintenance burden while supporting canaries with automated rollback—choose **Buildkite dynamic pipeline generation with a centrally versioned generator and GitOps/progressive-delivery controller** for large-scale polyglot microservices, provided the platform team is willing to operate/standardize the agent fleet and evidence pipeline. If the organization prioritizes a single system of record for approvals, environments, and audit over maximum generator flexibility, choose **GitLab CI DAG pipelines**. Use **GitHub Actions reusable workflows** when GitHub-native developer experience and lower hosted Linux minute price are more important than centralized orchestration and rollout-state maturity.

## Representative pipeline model and critical path

Because only the build duration was specified, this report uses one explicit, consistent workload for all three platforms:

- Linux x64 hosted/default runner or comparable self-hosted Linux agent.
- Build job: **15 minutes**.
- Test phase: **8 parallel test jobs, 15 minutes each**.
- Deployment phase: **3 serial stages, 5 minutes each**: e.g., staging deploy, canary/promote gate, production promote/verify.
- Runner capacity: at least 8 parallel test slots plus capacity for the build/deploy job; queue/idle time excluded unless noted.
- Billable compute per run: `15 + (8 × 15) + (3 × 5) = 150 runner-minutes`.
- Critical path with sufficient capacity: `15 + 15 + (3 × 5) = 45 wall-clock minutes`.

| Platform approach | How dependencies/parallelism are expressed | Expected critical path | Billable compute per run | Operational caveat |
|---|---:|---:|---:|---|
| GitLab CI DAG pipelines | Jobs normally follow `stages`; `needs` forms a DAG and can ignore stage order; `parallel:matrix` creates parallel job instances [1]. | ~45 min | 150 GitLab compute minutes at Linux small cost factor 1 | Queued if hosted/shared runner capacity is exhausted; `needs` limits and artifact behavior need careful design [1]. |
| GitHub Actions reusable workflows | Jobs are parallel unless connected with `jobs.<id>.needs`; matrix strategy creates parallel jobs and GitHub maximizes parallel execution subject to runner availability; reusable workflows are called with `jobs.<id>.uses` [2]. | ~45 min | 150 Actions Linux 2-core minutes | Reusable workflow calls are job boundaries; secrets and outputs must be deliberately passed, especially through nested workflows [2][20]. |
| Buildkite dynamic pipeline generation | A bootstrap step generates YAML/JSON and uploads it with `buildkite-agent pipeline upload`; generated steps become jobs on matching agents; ordering is expressed with `depends_on`, `wait`, and `block` steps [3][5][4]. | ~45 min + bootstrap/upload overhead | 150 agent-minutes or equivalent infrastructure time | Dynamic YAML exists only at runtime unless captured; invalid generated YAML fails mid-build; retries require stable step keys or `--replace` [4]. |

The execution-time result is therefore not primarily a product-syntax issue. The dominant factors are runner/agent concurrency, cache locality, dependency downloads, and whether the platform can skip irrelevant work. Buildkite’s dynamic generation is strongest for service/test discovery and change-based pruning; GitLab can do similar work with dynamic child pipelines but has more hierarchy/depth constraints; GitHub can do it with reusable workflows and matrices but usually requires more caller-workflow glue in each repository [4][8][2].

## Cost per 1,000 representative pipeline runs

The modeled workload is **150,000 billable compute minutes per 1,000 runs** before included monthly allowances. The table separates gross list-rate compute from the effect of included enterprise minutes/credits, because fintech usage at 50–100 prod deploys/day would normally exceed free/team allowances once CI, test, preview, and release runs are included.

| Platform | Pricing inputs pinned from sources | Gross compute cost for 1,000 runs | Net after common enterprise monthly included minutes | Hosted vs self-hosted treatment |
|---|---:|---:|---:|---|
| GitLab CI | Free/Premium/Ultimate include 400/10,000/50,000 compute minutes per month; additional compute minutes are $10 per 1,000. Compute usage is job duration/60 × cost factor and excludes `created`/`pending`; Linux x86-64 small/medium/large hosted runner cost factors are 1/2/3, and the default small runner is 2 vCPU/8 GB [21][22][23][24]. | `150,000 / 1,000 × $10 = $1,500` | If the same month’s Ultimate allowance is applied only to these runs: `(150,000 - 50,000) / 1,000 × $10 = $1,000` | GitLab.com hosted runners consume compute quota by duration × cost factor; self-managed/own runners do not consume GitLab.com compute quota but shift cost to infrastructure [22]. |
| GitHub Actions | Enterprise Cloud includes 50,000 standard hosted minutes/month; Team/Pro 3,000; Free 2,000. Private-repo Linux 2-core x64 hosted runners are $0.006/min beyond quota; Linux 1-core is $0.002/min. Public repositories and self-hosted runners are free for Actions minutes; larger runners are always charged [25][15]. | `150,000 × $0.006 = $900` | If the same month’s Enterprise Cloud allowance is applied only to these runs: `(150,000 - 50,000) × $0.006 = $600` | Hosted-runner processing time is billed to the repository owner; self-hosted runners have no Actions minute charge but require internal compute/ops cost [25]. |
| Buildkite dynamic pipelines | Pro is $30 per active user/month; Enterprise is custom with governance features such as SCIM/SAML/ADFS, audit logs, build exports, and pipeline templates. Pro self-hosted agents include 10 agents, then $3.50/agent/month; Enterprise has volume discounts. Hosted Linux agents include 2,000 Linux minutes/month on Pro, with up to 48 vCPU concurrency; small Linux hosted agents are 2 vCPU/4 GB at $0.013/min, medium 4 vCPU/16 GB at $0.026/min, and large 8 vCPU/32 GB at $0.052/min [26][27]. | `150,000 × $0.013 = $1,950` on small hosted Linux agents, before platform subscription/user charges | If applying the Pro 2,000 hosted Linux minutes only to these runs: `(150,000 - 2,000) × $0.013 = $1,924`; Enterprise volume discounts are custom [26]. | Self-hosted Buildkite does not use a GitLab/GitHub-style included-minute model; cost becomes active-user/agent subscription plus customer infrastructure, autoscaling, and idle capacity [26][5]. |

On pure hosted Linux minute price, GitHub Actions is cheapest in the modeled 2-core scenario ($900 gross per 1,000 runs), GitLab is next at small-runner list rate ($1,500 gross), and Buildkite hosted small Linux is highest at $1,950 gross before active-user/subscription charges. On total platform cost, the ranking can invert if Buildkite self-hosted agents are highly utilized and GitHub/GitLab hosted runners incur queue time, larger-runner multipliers, or duplicated work across repositories.

## Maintenance model across 200+ microservices

### GitLab CI DAG pipelines

GitLab gives a platform team several native mechanisms for centralization: `include` can import local, remote, project, or template files; CI/CD components add parameterized reusable units; parent-child and multi-project downstream pipelines split large systems; and dynamic child pipelines can be generated as artifacts [6][7][8][1]. This is a good fit when service teams need a familiar `.gitlab-ci.yml` but the platform team wants a central catalog of build/test/deploy components.

The trade-off is that GitLab centralization still tends to leave each service with YAML composition and versioning decisions. Dynamic child pipelines help monorepos and generated test matrices, but child-pipeline depth and hierarchy limits, artifact-generated config constraints, and downstream status mirroring must be designed deliberately [8]. Global changes can be rolled out by changing a referenced include/component version, but safe backward compatibility requires a versioned component contract and staged migration.

### GitHub Actions reusable workflows

GitHub’s reuse model separates three layers: reusable workflows for full jobs, composite actions for shared step sequences, and workflow templates for repository bootstrapping [28][2]. Reusable workflows are invoked with `jobs.<id>.uses` and typed `on.workflow_call` inputs/secrets/outputs; callers can pin a SHA/tag/branch and pass secrets explicitly or with `secrets: inherit` [2]. This is excellent for standard build/test/deploy modules, and developer familiarity is high in GitHub-centric organizations.

At 200+ services, the main overhead is the caller layer. Each repository needs workflow YAML that calls the reusable workflow, selects inputs, passes secrets, and pins versions. Pinning by SHA/tag improves safety but creates migration work when a platform team needs to roll out a breaking or urgent global change. Workflow templates help new repositories but do not update already-copied workflows. Nested reusable workflows add more explicit secrets passing. The result is moderate centralization with higher repo-by-repo lifecycle management than Buildkite’s generator pattern [2][20].

### Buildkite dynamic pipeline generation

Buildkite is the most flexible centralization model. A repository can contain only a small bootstrap `.buildkite/pipeline.yml`; the real pipeline can be generated at runtime by a centrally maintained script, SDK program, plugin, or Enterprise pipeline template [29][4]. The generator can inspect language, service metadata, changed files, deployment tier, feature flags, or ownership metadata and emit the right jobs. A platform team can enforce common security scans, dependency rules, queue choices, rollout steps, and plugin versions in one generator path [5][4].

The cost is that the generator becomes a product. It needs unit tests, dry-run validation, artifact capture of generated YAML for auditability, duplicate-step safeguards, semantic versioning, and observability. Buildkite’s docs explicitly warn that dynamic output exists only at runtime unless captured, rejected YAML fails after the build has started, retries can duplicate steps unless keys or `--replace` are used, and very large uploads need careful splitting [4]. For a mature platform team, that is usually less total maintenance than 200 service-local workflows; for a small team, it can become a bespoke CI framework.

**Maintenance ranking for 200+ services:**

1. **Buildkite dynamic generation** — best central control and per-service customization from metadata; highest generator ownership burden.
2. **GitLab includes/components + DAG/child pipelines** — strong native reuse with less bespoke tooling; some per-service YAML and GitLab-specific limits remain.
3. **GitHub reusable workflows** — easiest developer adoption in GitHub repos and good modularity; highest ongoing repo-by-repo version/secrets/caller maintenance.

## Secrets rotation and blast-radius control

| Platform | Native mechanisms | Best rotation pattern at 200+ services | Burden/risk |
|---|---|---|---|
| GitLab | Project/group/instance CI/CD variables; masked, hidden, protected, file-type, and environment-scoped variables; external secrets with Vault, Google Secret Manager, Azure Key Vault, AWS Secrets Manager; ID token/OIDC authentication [30][28][12]. | Prefer OIDC to cloud/external secret managers and group-scoped or environment-scoped references. Rotate in the external manager without touching 200 repos. Use protected environments/refs to limit production credential exposure [30][28]. | Masking is not a complete defense against malicious CI code; GitLab explicitly recommends external secrets for sensitive material [30]. |
| GitHub Actions | Repository, environment, and organization secrets/variables; org secret policies for all/private/selected repositories; `gh secret` management; OIDC to cloud providers; environment secrets gated by environment approvals [20][14][16]. | Use org-level secrets only for low-blast-radius shared values; use OIDC for cloud credentials so long-lived credentials are eliminated. Use environment secrets for production-only values and required reviewers before access [20][14][16]. | Secrets are not automatically passed to reusable workflows and must be passed again through nested reusable workflows; repository/environment scoping can create per-repo drift [2][20]. |
| Buildkite | Buildkite Secrets encrypted key-value store; access policies limiting which agents can read secrets; external secret-manager plugins/hooks; OIDC via `buildkite-agent oidc` with short-lived tokens and claims scoped by org/pipeline/agent/cluster/custom subject [31][32]. | Put cloud access behind OIDC/workload identity and centralize non-cloud secrets in Buildkite Secrets or Vault/AWS Secrets Manager plugins. Use agent queues/clusters and access policies to reduce blast radius by service tier or environment [31][32][5]. | More responsibility sits with agent and hook/plugin design; strong isolation requires disciplined queue/cluster segmentation and platform-owned plugins [5]. |

For 200+ services, long-lived per-repository credentials are the wrong default in all three systems. GitLab and GitHub can centralize many values at group/org scope, but OIDC/workload identity is the lower-burden rotation model because there is no secret to rotate in CI. Buildkite’s OIDC and access-policy model is also strong, especially when combined with agent queues/clusters, but the platform team must own those boundaries.

## Compliance audit trails and fintech controls

GitLab is the most integrated for deployment evidence. Deployment approvals can be required for protected environments; deployments are blocked until approvals are granted; self-approval can be prevented by default; approval status shows eligible approvers, approvals required/granted, users who approved, and approval/rejection history; deployment status can also be retrieved by API [10]. GitLab job logs show execution history and timestamps, and GitLab OIDC tokens include claims such as project, user, pipeline, job, ref protection, environment, protected environment, deployment tier, runner environment, and CI config SHA, which are useful for external evidence correlation [12][13].

GitHub Enterprise Cloud supports a strong fintech governance posture through SAML SSO, RBAC, audit log/API, environment protection rules, deployment branches/tags, required reviewers, wait timers, custom deployment protection rules, and environment secrets that are unavailable until approval [15][16][17]. Its limitation is that deployment orchestration evidence can be split among GitHub workflow runs, environment approvals, cloud/Kubernetes deployment systems, and any custom protection-rule app.

Buildkite Enterprise provides an organization audit log with indefinite event storage, 12-month web UI access, GraphQL query/export, event categories for pipelines, templates, teams, SSO providers, SCM settings, tokens, and secrets, and Amazon EventBridge streaming [18]. Platform controls include team RBAC, SSO/SAML integration, block steps for human deployment gates, pipeline templates, build exports, and job-log archiving guidance [18][5]. For fintech evidence, Buildkite is strong when configured deliberately, but because rollout state often lives in Argo CD or Kubernetes, auditors will need correlated evidence across Buildkite, Git, Argo/Kubernetes, and observability systems [19][5].

## Rollback and progressive delivery

### GitLab

GitLab has native deployment/environments concepts and documented canary support through Kubernetes deploy boards and Canary Ingress. Canary deployments can route a percentage of traffic to a canary and mark canary pods on deploy boards; the Canary Ingress weight can be changed through the UI/GraphQL/API, with traffic split such as 45% canary and 55% stable [11]. For rollback, GitLab can run environment jobs/scripts and can integrate with Kubernetes/Helm/Argo-style controllers, but automated rollback decisions generally need to be implemented in the deployment script or delegated to progressive-delivery tooling. GitLab’s advantage is that approvals, deployment records, and CI logs remain in the same system [10][11][13].

### GitHub Actions

GitHub Actions provides environments, required reviewers, wait timers, branch/tag deployment restrictions, environment secrets, and custom deployment protection rules that can call systems such as observability or change-management tools before a deployment proceeds [16]. It does not provide a full native canary controller. A typical implementation calls Helm, kubectl, Argo Rollouts, Flagger, Spinnaker, a feature-flag API, or a cloud deployment service from reusable workflows. Rollback is therefore script-driven or controller-driven; GitHub preserves workflow logs and environment approval evidence, while rollout state and automated rollback evidence live in the external system [14][16].

### Buildkite

Buildkite’s progressive-delivery model is intentionally integration-oriented. Pipelines can use `block` steps for production approvals and can implement canary/staged rollouts directly or via deployment plugins [5]. Its Argo CD deployment documentation describes a Buildkite plugin that monitors deployment health in real time, supports configurable intervals and timeouts, collects logs/artifacts/annotations, and can automatically detect deployment failure and roll back to the last known good state or offer an interactive rollback decision through block steps [19]. This is the strongest sourced automated rollback integration among the three approaches, but the deployment state is Argo CD/GitOps state, not native Buildkite state [19].

For 50–100 daily production deployments, the fastest safe rollback is controller-driven: canary metrics should trigger an abort/revert without waiting for a human to click a CI job. Buildkite plus Argo CD/rollout plugins has the clearest sourced path to that model; GitLab can support it with Auto Deploy/Canary Ingress and external rollout logic; GitHub Actions can support it but usually with more workflow scripting and third-party glue.

## Deployment-scale evidence from similar environments

The fetched materials included vendor documentation and product/customer pages but did not establish a complete, directly comparable trio of fintech case studies with all requested fields—company, platform, repository/service count, deployment frequency, languages, and date. The strongest directly usable scale signals from the fetched sources are therefore treated as context, not as primary proof of the final recommendation:

| Company/source type | Platform signal | Scale/environment signal available in fetched source | Limitations |
|---|---|---|---|
| GitHub customer/pricing pages referencing Spotify and Stripe | GitHub Enterprise customer references [15]. | Shows GitHub Enterprise adoption by large, polyglot technology/fintech-adjacent organizations. | The fetched source does not provide deployment frequency, service count, or CI/CD architecture details. |
| Buildkite documentation referencing Hasura migration | Buildkite dynamic pipelines used to replace YAML with Go and shell scripts [4]. | Relevant to polyglot/dynamic pipeline generation and YAML-reduction pattern. | The fetched doc reference does not provide complete fintech-scale deployment metrics. |
| Buildkite Argo CD deployment docs | Buildkite pipelines triggering Argo CD for Kubernetes/GitOps deployments with auto-rollback plugin pattern [19]. | Relevant to high-frequency Kubernetes rollout architecture. | Product documentation, not a company deployment-frequency case study. |

Because the sourced case-study data is incomplete, the recommendation above is based primarily on documented platform capabilities, pricing inputs, execution models, and operational scaling characteristics rather than unverifiable deployment-frequency anecdotes.

## Final trade-off matrix

| Criterion | GitLab CI DAG | GitHub Actions reusable workflows | Buildkite dynamic generation |
|---|---:|---:|---:|
| Developer wait time on modeled pipeline | ~45 min with adequate runners | ~45 min with adequate runners | ~45 min + small generator overhead; can be lower if generator skips work |
| Gross hosted Linux cost/1,000 modeled runs | ~$1,500 at Linux small factor 1 | ~$900 at Linux 2-core x64 | ~$1,950 on small hosted Linux agents, before user/subscription charges; self-hosted shifts cost to infra |
| Centralized maintenance | Strong includes/components/child pipelines | Moderate reusable workflows; caller YAML remains | Strongest with central generator/templates |
| Per-service customization | Good via inputs/rules/includes | Good via workflow inputs/matrices | Excellent via generator metadata/code |
| Global rollout of pipeline changes | Good if components/includes are centrally referenced and versioned | Slower if callers pin tags/SHAs and need migrations | Fastest if bootstrap calls central generator/template |
| Secrets rotation burden | Low with OIDC/external secrets; medium with variables | Low with OIDC; medium/high with repo/env secret drift and reusable-workflow passing | Low with OIDC/central secrets; requires agent/queue policy discipline |
| Compliance evidence | Strongest single-platform deployment evidence | Strong enterprise governance; evidence split with deploy tooling | Strong Enterprise audit/export; evidence correlated across Buildkite + GitOps |
| Canary/rollback maturity | Native canary visibility; rollback often scripted/external | Mostly external/scripted | Strong external integration; sourced Argo CD plugin supports health monitoring and auto-rollback |

## Closing judgment

If the fintech platform can standardize on GitOps/progressive-delivery controllers and invest in a central CI platform layer, **Buildkite dynamic pipeline generation** best minimizes long-term platform-maintenance burden while preserving the same critical-path speed as GitLab/GitHub and offering the most flexible route to automated rollback via Argo CD or similar tooling [19][5][4]. The platform team should mitigate Buildkite’s main risks by treating the generator as production software: version it, test it, capture generated YAML as artifacts, enforce signed/approved generator changes, segment agents by environment, and export audit logs to the compliance data lake [18][5][4].

If a single integrated DevSecOps control plane and native deployment evidence are more important than generator flexibility, **GitLab CI DAG pipelines** are the safer second choice: they provide comparable execution speed, strong central reuse, integrated approvals/environments/audit evidence, and usable canary primitives [10][11][1].

**GitHub Actions reusable workflows** are the cost leader on public hosted Linux minute pricing and the easiest choice for GitHub-native teams, but for 200+ services its caller-workflow versioning, explicit secrets propagation, and externalized rollout state create the highest ongoing platform-maintenance burden among the three options [2][25][20][16].

## Sources

1. [CI/CD YAML syntax reference | GitLab Docs](https://docs.gitlab.com/ci/yaml/)
2. [Workflow syntax for GitHub Actions - GitHub Docs](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions)
3. [Depends on](https://buildkite.com/docs/pipelines/configure/dependencies)
4. [Dynamic pipelines](https://buildkite.com/docs/pipelines/configure/dynamic-pipelines)
5. [Platform controls](https://buildkite.com/docs/pipelines/best-practices/platform-controls)
6. [Use CI/CD configuration from other files | GitLab Docs](https://docs.gitlab.com/ci/yaml/includes/)
7. [Downstream pipelines | GitLab Docs](https://docs.gitlab.com/ci/pipelines/downstream_pipelines/)
8. [Deployments | GitLab Docs](https://docs.gitlab.com/ci/environments/deployments/)
9. [Reusing workflow configurations - GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/reusable-workflows)
10. [Deployment approvals | GitLab Docs](https://docs.gitlab.com/ci/environments/deployment_approvals/)
11. [Canary deployments | GitLab Docs](https://docs.gitlab.com/user/project/canary_deployments/)
12. [OpenID Connect (OIDC) Authentication Using ID Tokens | GitLab Docs](https://docs.gitlab.com/ci/secrets/id_token_authentication/)
13. [CI/CD job logs | GitLab Docs](https://docs.gitlab.com/ci/jobs/job_logs/)
14. [OpenID Connect - GitHub Docs](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
15. [Pricing · Plans for every developer](https://github.com/pricing)
16. [Deployments and environments - GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
17. [Reviewing the audit log for your organization - GitHub Enterprise Cloud Docs](https://docs.github.com/en/enterprise-cloud@latest/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/reviewing-the-audit-log-for-your-organization)
18. [Audit log](https://buildkite.com/docs/platform/audit-log)
19. [Deploying with Argo CD](https://buildkite.com/docs/pipelines/deployments/with-argo-cd)
20. [Using secrets in GitHub Actions - GitHub Docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)
21. [Compute minutes | GitLab Docs](https://docs.gitlab.com/ci/pipelines/compute_minutes/)
22. [Pricing](https://about.gitlab.com/pricing/)
23. [Hosted runners on Linux | GitLab Docs](https://docs.gitlab.com/ci/runners/hosted_runners/linux/)
24. [Managing compute minutes FAQ](https://about.gitlab.com/pricing/faq-compute-minutes/)
25. [GitHub Actions billing - GitHub Docs](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)
26. [Buildkite Pricing](https://buildkite.com/pricing)
27. [Linux hosted agents](https://buildkite.com/docs/agent/buildkite-hosted/linux)
28. [Use external secrets in CI/CD | GitLab Docs](https://docs.gitlab.com/ci/secrets/)
29. [Pipeline templates](https://buildkite.com/docs/pipelines/templates)
30. [CI/CD variables | GitLab Docs](https://docs.gitlab.com/ci/variables/)
31. [Secrets overview](https://buildkite.com/docs/pipelines/security/secrets)
32. [OIDC in Buildkite Pipelines](https://buildkite.com/docs/pipelines/security/oidc)