# ChatGPT Enterprise DLP with Microsoft Purview: recommendation and implementation plan

**Bottom line:** As of **2026-06-23**, **ChatGPT Enterprise does not have native Microsoft Purview DLP enforcement**: Microsoft’s ChatGPT Enterprise support table marks **Sensitivity labels ✕**, **Encryption without sensitivity labels ✕**, and **Data loss prevention ✕** for ChatGPT Enterprise AI interactions, while marking audit/classification/retention/eDiscovery/Insider Risk/Communication Compliance as supported for captured interactions [1]. If “true DLP” means content-aware prevention before sensitive data leaves the control boundary, the strongest corporate option is **Microsoft 365 Copilot + Microsoft Purview** for Microsoft 365-grounded work. For ChatGPT Enterprise, the best available pattern is **layered risk reduction**: SSO/SCIM and strict workspace controls, Purview Endpoint DLP and Edge Browser Data Security on managed browsers/devices, Defender for Cloud Apps/Entra Conditional Access for web access control and logging, network/proxy restrictions, and a customer-owned OpenAI API gateway for sensitive workflows.

| Option | Native Purview DLP / label enforcement | Prevention before exfiltration | Browser/native/API coverage | Audit, retention, eDiscovery | Corporate recommendation |
|---|---:|---:|---:|---:|---|
| **Microsoft 365 Copilot + Purview** | **Yes**: Microsoft table marks sensitivity labels, encryption, DLP, audit, eDiscovery, retention, Communication Compliance, Insider Risk all supported for AI interactions [2] | **Strongest** for M365 content: DLP policy location can restrict sensitive prompts and files/emails with specified sensitivity labels [2] | Best inside Microsoft 365/Copilot experiences; not a general ChatGPT Enterprise/API replacement | Stored in Microsoft 365 services; captures audit records for prompts/responses/referenced content and eDiscovery/compliance data [3] | **Primary choice for M365-governed AI work** |
| **ChatGPT Enterprise + Purview connector/archive** | **No native DLP**: DLP ✕, labels ✕, encryption without labels ✕ [1] | Mostly **post-hoc compliance**, not native pre-submit block | ChatGPT service paths, GPTs, file uploads, apps/connectors are not directly governed by Purview DLP inside the service | Purview supports auditing, data classification, Insider Risk, Communication Compliance, eDiscovery, retention, Compliance Manager for captured interactions [1] | Use only with compensating controls; do not represent as end-to-end Purview DLP |
| **Purview Endpoint DLP / Edge Browser Data Security for ChatGPT web** | Not native ChatGPT integration; endpoint/browser DLP around third-party AI sites | **Yes, but only at managed endpoint/browser control points**: audit, block with override, block, business justification; Edge can inspect AI prompts before they leave the browser [4][5] | Managed browser/device paths; gaps for unmanaged devices, native apps, API calls, screenshots/offline copying | Activity Explorer/alerts and DSPM for AI views for detected interactions [6][5] | Recommended layer for managed endpoints; not sufficient alone |
| **Defender for Cloud Apps / CASB / proxy controls** | No fetched Microsoft doc identifies a sanctioned ChatGPT Enterprise/OpenAI SaaS API connector; available controls are catalog discovery, sanction/unsanction, app blocking, CA App Control/session proxy, app governance, activity/session logs [7][8][9][10][11] | Access/session enforcement for routed browser traffic; app blocking/warn for unsanctioned domains | Browser sessions and managed endpoint network-protection paths; not native/mobile/API unless blocked/routed separately [7][8] | Cloud Discovery and Conditional Access App Control continuous reports with time, IP, user agent, URLs, bytes uploaded/downloaded [11] | Recommended access-control/logging layer; not content-complete DLP |
| **OpenAI API gateway built by customer** | OpenAI provides API data controls, retention controls, projects/service accounts/RBAC, moderation; not native Microsoft Purview DLP scanning [12][13][14][15] | **Potentially strong if the customer builds pre-submit DLP** using Purview/MIP or other DLP before API call | Covers approved internal app/API workflows; does not govern public ChatGPT unless blocked | Customer-controlled logs plus OpenAI usage/export and API retention controls | Best fallback for sensitive non-M365 AI workflows when ChatGPT Enterprise native DLP is insufficient |

## Evaluation standard: what counts as “true DLP”

For this comparison, **true DLP** means more than privacy promises, encryption, retention, or post-hoc logs. A control scores as true DLP only to the extent it provides:

1. **Prevention before exfiltration** — content is inspected and blocked/warned before prompts, pasted text, or files leave the device/browser/application boundary.
2. **Content inspection of prompts and files** — sensitive information types, trainable classifiers, or equivalent content rules inspect the actual payload, not merely app URL or user identity.
3. **Sensitivity-label awareness** — Microsoft Information Protection/Purview sensitivity labels and encryption/usage rights are recognized where policy depends on labels.
4. **Identity, device, and context policy** — enforcement can vary by user, risk, group, device management state, browser, location, and session.
5. **Coverage of browser, native app, mobile, and API paths** — a control that only handles Edge/Chrome browser uploads is useful but not complete.
6. **Auditability and investigation** — logs identify user, app, activity, prompt/response/file metadata or content where permitted, and policy result.
7. **Legal hold, retention, and eDiscovery** — interactions can be retained, searched, preserved, exported, and deleted according to policy.
8. **Admin enforceability** — admins can centrally configure and force the control, not merely advise users.

By that standard, **Microsoft 365 Copilot + Purview** is the closest end-to-end answer for Microsoft 365 data. **ChatGPT Enterprise + Microsoft controls** can be made safer, but it remains a layered architecture with control gaps, not native end-to-end Purview DLP.

## 1) ChatGPT Enterprise and Microsoft Purview: product support status

Microsoft’s ChatGPT Enterprise Purview page distinguishes clearly between compliance visibility and DLP enforcement. For ChatGPT Enterprise AI interactions, the support table states:

| Microsoft Purview capability for ChatGPT Enterprise | Support status |
|---|---:|
| DSPM and DSPM for AI | ✓ |
| Auditing | ✓ |
| Data classification | ✓ |
| Sensitivity labels | ✕ |
| Encryption without sensitivity labels | ✕ |
| Data loss prevention | ✕ |
| Insider Risk Management | ✓ |
| Communication Compliance | ✓ |
| eDiscovery | ✓ |
| Data Lifecycle Management | ✓ |
| Compliance Manager | ✓ |

[1]

The operational meaning is important: **Purview can ingest/manage ChatGPT Enterprise interactions for classification, auditing, retention, eDiscovery, Communication Compliance, and Insider Risk workflows, but it does not directly enforce Purview DLP policies or Microsoft sensitivity labels inside ChatGPT Enterprise prompts, file uploads, GPT knowledge/actions, connected apps, or responses** [1]. Microsoft’s “other AI apps” page marks **Data loss prevention ✓** for generic browser-based third-party AI sites such as ChatGPT, Google Gemini, and DeepSeek, but that is endpoint/browser control around web use; the ChatGPT Enterprise-specific table still marks **Data loss prevention ✕** [16][1].

ChatGPT Enterprise can be connected to Microsoft Purview for compliance management after running the connector scan; Purview can then show analytics, AI interactions, prompts/responses, and sensitive information type data in Activity Explorer, and use the captured data with Communication Compliance, Data Lifecycle Management, eDiscovery, Insider Risk Management, and Records Management [17]. For eDiscovery, Microsoft identifies item-class search values such as `IPM.SkypeTeams.Message.ConnectedAIApp.Connector.<ChatGPTEnterprise>` for local-machine activities and `IPM.SkypeTeams.Message.CloudAIApp.SaaS.<AppID>` for browser-based activities [1]. Those are investigation/retention controls, not pre-submit native DLP inside ChatGPT.

## 2) Microsoft Purview DLP / Endpoint DLP for generative-AI websites

Purview can enforce content-aware controls for third-party generative-AI sites **at the managed endpoint/browser layer**. Microsoft says Windows computers onboarded to Purview can be configured with **Endpoint Data Loss Prevention** policies that warn or block users from sharing sensitive information with third-party generative AI sites accessed via browser; Microsoft’s example is preventing a user from pasting credit-card numbers into ChatGPT or showing an overridable warning [6][16].

### Purview features and policy objects

| Feature / object | What it does for AI websites | Actions / outputs | Portal or object |
|---|---|---|---|
| **Microsoft Purview Data Loss Prevention policy** scoped to **Devices** | Detects sensitive information types or sensitivity labels on endpoint activity | Audit only, Block with override, Block [18] | Microsoft Purview portal / compliance portal > DLP policies [5] |
| **Endpoint DLP activity: Paste to supported browsers** | Evaluates sensitive content being pasted into supported browsers | Audit, block with override, block; policy tips/notifications; possible brief classification delay [4][18] | Purview DLP rule action **Audit or restrict activities on devices** [4][18] |
| **Endpoint DLP activity: Upload to a restricted cloud service domain** | Restricts upload of protected files to configured service domains, including AI app website groups | Audit, block with override, block [18][5] | Endpoint DLP Settings > Browser and domain restrictions to sensitive data; Sensitive service domain groups [18] |
| **Sensitive service domain group: Generative AI websites** | Preconfigured group used by DSPM for AI default policies | Cannot be edited or deleted; website groups allow up to 100 websites per group and 150 groups, or 15,000 assignable websites [18] | Microsoft Purview Endpoint DLP settings [18] |
| **Browser Data Security in Microsoft Edge** | Inspects text typed or pasted into AI prompts in real time and can block before it leaves the browser | Content-aware pre-submit block for AI prompt text in Edge; Microsoft names ChatGPT consumer, Microsoft Copilot consumer, DeepSeek, and Google Gemini [5] | Microsoft Edge / Purview policy activation [5] |
| **Business justification in policy tips** | Allows user override with justification where policy uses override | User warning/override/justification captured for review [18] | DLP policy tips and Endpoint DLP settings [18] |

### Browser and platform support

| Activity | Supported browsers/platforms from Microsoft docs | Practical consequence |
|---|---|---|
| **Paste to supported browsers** | Microsoft Edge on Windows/macOS; Chrome on Windows/macOS with Microsoft Purview extension, with extension noted as Windows-only in the paste-policy doc; Firefox on Windows/macOS with Microsoft Purview extension, with extension noted as Windows-only in the paste-policy doc; Safari on macOS for the paste scenario [4] | Good managed-browser coverage, but not universal browser/native/mobile/API coverage |
| **Upload to restricted cloud service domain** | Service-domain setting applies to files uploaded with Microsoft Edge, or Chrome/Firefox with the Microsoft Purview extension [18] | File-upload DLP depends on browser and extension support; native apps and non-browser clients are outside this control point |
| **Edge Browser Data Security AI prompt inspection** | Microsoft Edge, with policies activated in Edge for unmanaged AI apps [5] | Strongest pre-submit AI prompt inspection in Microsoft stack, but Edge-centric |

Purview Endpoint DLP is therefore **content-aware before submission** for supported paste/prompt/upload paths, especially in Edge. It is not equivalent to native DLP inside ChatGPT Enterprise because it cannot see every ChatGPT Enterprise path after the content is already inside the service, and it does not apply to non-browser API calls unless those calls traverse a separate customer control point.

## 3) Microsoft Defender for Cloud Apps / CASB and proxy controls for ChatGPT/OpenAI

The fetched Microsoft materials support Defender for Cloud Apps controls for ChatGPT/generative-AI usage through **Cloud Discovery/Cloud App Catalog**, **Generative AI category filtering**, **sanction/unsanction tagging**, **Defender for Endpoint network-protection blocking/warn**, **app governance policies**, **Conditional Access App Control access/session policies**, and **activity/session logging** [7][8][9][10][11]. The materials do **not** identify a sanctioned SaaS API app connector for ChatGPT Enterprise/OpenAI; app connectors generally use SaaS provider APIs, but the grounded ChatGPT/OpenAI controls in the fetched Defender docs are catalog/discovery, tag/block, proxy/session, and logging controls rather than a first-party ChatGPT Enterprise API connector [7][9][11].

| Defender for Cloud Apps control | Available for ChatGPT/generative AI web traffic | Enforces or detects? | Limitation |
|---|---|---|---|
| **Cloud Discovery / Cloud App Catalog category “Generative AI”** | Discover and filter AI apps such as ChatGPT category usage [10] | Detects and inventories | Discovery depends on telemetry/log ingestion path |
| **Sanction / Unsanction tag** | Mark AI apps unsanctioned; unsanctioning enables monitoring and, with Defender for Endpoint integration, blocking [9][8] | Enforces when integrated with MDE; otherwise mainly governance/monitoring | Blocking sync latency up to **3 hours**: up to 1 hour MCAS-to-MDE sync plus up to 2 hours policy push [8] |
| **Defender for Endpoint network-protection block or warn** | Unsanctioned domains propagate to endpoint devices and are blocked by Microsoft Defender Antivirus network protection [8] | Enforces network access on onboarded managed endpoints | Requires MDE onboarding and network protection; does not inspect prompt/file contents as DLP |
| **Conditional Access App Control / session proxy** | Real-time access/session policies for web browser sessions routed through Defender for Cloud Apps [7][11] | Enforces session/access controls for routed browser sessions | Applies only to browser-based interactive sessions; admins should block native client access to prevent bypass [7] |
| **Activity/session logs** | Logs every routed session with time, IP, user agent, URLs visited, and bytes uploaded/downloaded; appears as the continuous report **Defender for Cloud Apps Conditional Access App Control** in Cloud Discovery and can be exported from Microsoft Defender portal > Reports > Cloud Apps > Exported reports [11] | Detects/investigates | Does not provide full content-aware prompt/file DLP by itself |

This makes Defender for Cloud Apps a strong **access-control and shadow-AI governance** layer, not a complete DLP layer. It can block access to public ChatGPT or require browser-based routed sessions, but it is weaker than Purview Endpoint DLP for content-aware prompt/file inspection.

## 4) Microsoft 365 Copilot with Microsoft Purview

Microsoft 365 Copilot is the strongest option when the business need is AI over Microsoft 365 tenant data under Purview governance. Microsoft’s Purview table for **Microsoft 365 Copilot & Microsoft 365 Copilot Chat** marks all of the following supported for AI interactions: DSPM/DSPM for AI, Auditing, Data classification, Sensitivity labels, Encryption without sensitivity labels, Data loss prevention, Insider Risk Management, Communication Compliance, eDiscovery, Data Lifecycle Management, and Compliance Manager [2].

### Protection coverage

| Area | Microsoft 365 Copilot + Purview support |
|---|---|
| **Prompts and responses** | Purview can audit prompts/responses; prompts and responses are included in AI app retention policies for Microsoft 365 Copilot and Copilot Studio [3][19] |
| **DLP** | The **Microsoft 365 Copilot and Copilot Chat** DLP policy location can restrict processing of prompts containing sensitive information types and restrict processing of files/emails with specified sensitivity labels [2] |
| **Files and emails** | DLP can prevent processing of files/emails with specified sensitivity labels; Copilot may reference content with a link rather than summarize when blocked [2][20] |
| **Sensitivity labels / encryption** | Copilot honors Purview Information Protection usage rights from sensitivity labels or IRM; encrypted items require VIEW and EXTRACT rights; Copilot responses can show the highest-priority label and generated content can inherit the highest-priority label where supported [21][3] |
| **Grounding data and access controls** | Copilot presents only data each individual can access using Microsoft 365 controls; Semantic Index honors the user identity-based access boundary [21] |
| **Audit and eDiscovery** | Microsoft 365 can capture audit records for Copilot prompts, responses, and referenced content; Copilot interaction data for eDiscovery/compliance investigations; retained referenced-file versions via cloud attachments and Preservation Hold Libraries [3] |
| **Uploaded files and Copilot Pages** | User-uploaded files are stored in OneDrive Copilot Chat folders; Copilot Pages content is stored in user-owned SharePoint Embedded containers [3] |
| **Communication Compliance and Insider Risk** | Communication Compliance can detect user prompts/responses for AI apps; Insider Risk Management includes risky AI usage such as prompt injection attacks and accessing protected materials [2][6] |
| **Copilot Chat web Endpoint DLP** | Microsoft 365 Copilot Chat web version supports Endpoint DLP capabilities to block paste of sensitive content and block files based on specified sensitivity label [2] |

### Data-access model and limitation as a substitute for ChatGPT Enterprise

Microsoft 365 Copilot is grounded in Microsoft 365 tenant data and Microsoft Graph-connected data, and it honors existing Microsoft 365 identity, permissions, sensitivity labels, encryption/usage rights, and access controls [21][3]. Microsoft says data from Microsoft Graph connectors can be returned in responses only if the user has permission to access it, and agents query on the user’s behalf using the prompt, Copilot activity history, and data the user can access in Microsoft 365 [21].

That strength is also the boundary: Microsoft’s documentation describes Copilot as Microsoft 365/Graph/agent-grounded. It is not documented as a general substitute for ChatGPT Enterprise for arbitrary non-Microsoft-365 knowledge bases, external web/app workflows, custom GPT behavior, or direct OpenAI API/model use. For external sources, Microsoft notes that sensitivity labels/encryption from external sources often are not recognized by Copilot Chat, so Graph connectors/agents do not provide the same universal label semantics as native Microsoft 365 content [20].

## 5) ChatGPT Enterprise administrative, privacy, and retention controls

ChatGPT Enterprise has meaningful enterprise controls, but they are **security, privacy, governance, and audit controls**, not native Purview DLP enforcement.

### Admin/security settings

| Control | Exact capability grounded in sources | Portal / object |
|---|---|---|
| **Domain verification** | Required before additional provisioning/authentication; associates email domains with a ChatGPT Enterprise workspace [22] | ChatGPT Manage Workspace > Identity & Provisioning / OpenAI Identity [23] |
| **SAML SSO** | Enterprise-level authentication through SAML SSO; setup requires an OpenAI plan with Global Admin Console and Global Admin; SSO requires at least one verified domain [23][24] | OpenAI Identity at `admin.openai.com/identity`, also reachable from ChatGPT Identity & Provisioning or API Platform org Identity settings [23] |
| **Domain limits** | Up to **99 verified domains** per Admin Portal; **7-day** verification window; domains can be verified on only one Admin Portal [23] | OpenAI Global Admin Console [23] |
| **Provisioning / SCIM** | Users need provisioning plus authentication; provisioning via manual invites, Automatic Account Creation by verified email domain, or Directory Sync via SCIM based on IdP group membership [22] | ChatGPT workspace Members / Identity & Provisioning [22] |
| **External-domain invites** | Workspace owners can disable external-domain invites for new invitations; does not retroactively block existing users or invitations [22] | ChatGPT workspace Identity & Provisioning [22] |
| **Workspace roles and custom roles** | Enterprise/Edu workspaces can assign app access to custom roles; workspace owners/admins control app availability by role [25] | Workspace settings > Apps; Workspace settings > Permissions & roles > Custom roles [25] |
| **Compliance API / OpenAI Compliance Logs Platform** | Time-stamped records for conversations, uploaded files, workspace GPT configuration and metadata, memories, workspace users; Admin Audit, User Authentication, and Codex Usage logs; immutable time-windowed JSONL with minutes-level latency [26][27] | ChatGPT Enterprise Compliance API / OpenAI Compliance Logs Platform [27] |
| **Data export / SIEM ingestion** | Compliance Logs Platform examples focus on downloading log files for SIEM or data lake ingestion [27] | Compliance API key and log export scripts [27] |
| **Retention controls** | ChatGPT Enterprise/Edu/Healthcare customers control how long data is retained; OpenAI describes a custom data retention window for ChatGPT Enterprise [24][26] | ChatGPT Enterprise workspace/data governance settings; Purview retention can also retain captured ChatGPT Enterprise interactions in Enterprise AI apps [1] |
| **GPT sharing/actions controls** | Admins can allow/block GPT actions, create approved domain lists for GPT actions, use group permissions, manage GPT sharing permissions, view GPT configuration, remove GPTs, transfer ownership, set global GPT capabilities, and approve/restrict third-party GPTs [26] | ChatGPT Enterprise workspace GPT settings [26] |
| **Connectors/apps controls** | In ChatGPT Enterprise/Edu, apps/connectors are disabled by default; owners enable apps in Workspace settings > Apps and assign role-based access; app calls are logged [25] | Workspace settings > Apps; Permissions & roles > Custom roles [25] |
| **File-upload governance** | OpenAI documents five file-ingress paths: direct upload from the computer, Google Drive/SharePoint/OneDrive connected apps, GPT Knowledge, Project Files, and files returned from GPT Actions; file handling can involve text extraction, Code Interpreter/code analysis, image interpretation, and private search-index/vector-store retrieval for larger documents [28]. The admin controls substantiated in the OpenAI sources are: **connector-sourced files** can be enabled/disabled by controlling apps, because Enterprise/Edu apps are disabled by default and owners enable apps in **Workspace settings > Apps** and can scope access by custom role in **Workspace settings > Permissions & roles > Custom roles** [25]; **GPT Knowledge files and GPT Actions** are governed through GPT controls, because Enterprise admins can manage GPT sharing, view GPT configuration, remove GPTs, transfer ownership, set global GPT capabilities, approve/restrict third-party GPTs, and allow/block GPT actions or approved action domains [26]. OpenAI’s documented controls do **not** establish a separate workspace setting to disable all direct file uploads, all Project Files, or Code Interpreter/file-analysis tools as a standalone file-DLP control; those paths require compensating endpoint/browser/API-gateway controls if the data class must be blocked before upload [28][1]. | Workspace settings > Apps; Workspace settings > Permissions & roles > Custom roles; ChatGPT Enterprise workspace GPT settings; ChatGPT conversation/GPT Knowledge/Projects/GPT Actions [25][26][28] |

### SSO/personal-account caveats

SSO enforcement is not a complete control over all ChatGPT usage by corporate-domain users. OpenAI states that users with a verified-domain email who are **not provisioned** in the workspace can continue to access personal ChatGPT accounts after SSO is configured, and provisioned users whose email domain is not verified can continue accessing the Enterprise workspace via password/social login [22]. Therefore, corporate DLP architecture must also control public ChatGPT access via browser/network/CASB policies if personal-account use is a concern.

### OpenAI data-use and security commitments

| Commitment | Exact value |
|---|---|
| **Training use** | OpenAI says customer business data — inputs and outputs from ChatGPT Business, ChatGPT Enterprise, ChatGPT for Healthcare, ChatGPT Edu, ChatGPT for Teachers, and API Platform — is not used to train models by default [24]. OpenAI’s ChatGPT Enterprise tools page also states no customer data or metadata is used for training models [26]. |
| **Ownership/control** | Customer owns and controls inputs/outputs where allowed by law and controls which internal sources are connected [24]. |
| **Retention** | ChatGPT Enterprise, Edu, and Healthcare customers control how long data is retained; ChatGPT Enterprise has a custom data retention window [24][26]. |
| **Encryption** | Data encrypted at rest with **AES-256** and in transit with **TLS 1.2+** between customers/OpenAI and OpenAI/service providers [24]. |
| **Compliance/security audit** | OpenAI says it successfully completed a SOC 2 audit for security/confidentiality; ChatGPT Enterprise page also lists **CCPA, CSA STAR, and SOC 2 Type 2 compliance** [24][26]. The fetched OpenAI enterprise privacy/security source substantiates SOC 2/security-confidentiality but does **not** list ISO certifications; no ISO certification claim is made here [24]. |

These commitments reduce privacy and vendor-risk concerns, but **they are not content-aware DLP enforcement**. They do not inspect a prompt/file for a Purview sensitive information type or sensitivity label and block it before it reaches ChatGPT Enterprise.

## 6) OpenAI API Platform controls for a corporate-controlled ChatGPT-like app

For sensitive non-Microsoft-365 workflows, the most defensible alternative to public ChatGPT Enterprise use is an **internal application using the OpenAI API through a customer-controlled gateway**. OpenAI provides useful platform controls, but the customer must build or integrate DLP scanning before the API call.

| API-side control | Exact grounded value | DLP relevance |
|---|---|---|
| **API data-use policy** | Since **2023-03-01**, data sent to the OpenAI API is not used to train or improve OpenAI models unless the customer explicitly opts in [12]. | Privacy control, not DLP |
| **Default abuse-monitoring retention** | Abuse-monitoring logs may contain prompts/responses and derived metadata; generated for all API usage by default and retained up to **30 days** unless longer required by law or necessary to protect services/third parties [12]. | Logging/abuse control, not customer DLP |
| **Zero Data Retention / Modified Abuse Monitoring** | Eligible customers can seek prior OpenAI approval; both exclude customer content from abuse-monitoring logs with rare image/file limitations; ZDR also treats `store` as `false` for `/v1/responses` and `/v1/chat/completions` [12]. | Reduces OpenAI retention; does not scan for corporate secrets |
| **Where configured** | Platform Settings > Organization > Data controls > Data Retention; organization-level choice between ZDR and Modified Abuse Monitoring; project-level inherit/default, ZDR, MAM, or None [12]. | Governance |
| **Project retention API values** | `organization_default`, `none`, `zero_data_retention`, `modified_abuse_monitoring`, `enhanced_zero_data_retention`, `enhanced_modified_abuse_monitoring` [29]. | Automatable governance |
| **Endpoint ZDR eligibility** | `/v1/chat/completions` and `/v1/responses`: training No, abuse monitoring 30 days, application state none with exceptions, ZDR eligible Yes; `/v1/moderations`: training No, abuse monitoring None, application state None, ZDR eligible Yes; `/v1/files`: training No, abuse monitoring 30 days, application state until deleted, ZDR eligible No; `/v1/vector_stores`, assistants/threads/batches/fine-tuning are not ZDR eligible and retain application state until deleted or per object lifecycle [12]. | Choose endpoints carefully for sensitive data |
| **File/image limitations** | Image/file inputs to `/v1/responses`, `/v1/chat/completions`, and `/v1/images` are scanned for CSAM on submission; potential CSAM images may be retained for manual review even with ZDR/MAM; files can be manually deleted via API/dashboard or auto-deleted with `expires_after` [12]. | Retention exception to account for |
| **Projects/service accounts/API keys/RBAC** | Projects support service accounts list/create/retrieve/update/delete; per-project API keys; project users; rate limits via management API; org/admin RBAC roles, groups/roles, usage dashboard/export, IP allowlist, mTLS, OIDC, and project administration permissions [13][14]. | Enables least privilege and controlled app architecture |
| **Moderation endpoint** | Moderation models detect harmful content in text/images; `omni-moderation-latest` accepts text and image inputs, not audio; image files up to **20 MB**; moderation endpoint is free to use [15]. | Safety moderation, not enterprise DLP |

**Recommendation for API workflows:** Put a customer gateway in front of OpenAI. The gateway should authenticate users via Entra ID, apply Purview/MIP label checks and DLP pre-screening to prompts/files, redact or block sensitive content, log request/response metadata to SIEM, call OpenAI only from approved service accounts/projects, and use ZDR/MAM where eligible. OpenAI’s controls help with privacy, retention, identity, and abuse monitoring, but the native OpenAI API does not replace customer-owned DLP scanning [12][13][14][15].

## 7) Coverage gaps and limitations

| Gap | Affected controls | Why it matters | Mitigation |
|---|---|---|---|
| **Unmanaged devices** | Purview Endpoint DLP, Defender for Endpoint network protection, Intune browser policy | Endpoint DLP and MDE blocking depend on onboarded/managed endpoints; unmanaged personal devices can access ChatGPT unless identity/network controls block them | Entra Conditional Access, require compliant device, block unmanaged device access to ChatGPT Enterprise, network egress controls |
| **Native desktop/mobile apps** | Defender CA App Control, browser DLP | Conditional Access App Control applies only to web browser-based interactive sessions; Microsoft recommends blocking native client access to prevent bypass [7] | Block native client access; allow only managed browser sessions; use MDE/network restrictions |
| **Non-browser API calls** | Purview Endpoint DLP browser/upload controls, Defender session proxy | Browser controls do not inspect arbitrary scripts, SDKs, curl, or backend API calls to OpenAI | Block direct API egress except approved gateway; use service-account-only API access |
| **Encrypted traffic not routed through control point** | CASB/proxy, network DLP | If traffic does not traverse the proxy/session control or endpoint DLP hook, content may not be inspected | Force tunnel/proxy, DNS/firewall egress allowlists, certificate/TLS inspection where legally approved |
| **Copy/paste versus file upload differences** | Endpoint DLP | Paste and upload have different browser/platform support; upload service-domain restrictions apply to Edge or Chrome/Firefox with Purview extension [18] | Use Edge as standard browser; deploy Purview extensions; test both paste and upload policies |
| **Screenshots, photos, retyping, offline exfiltration** | All technical DLP | Endpoint/browser DLP is not a physical-world control; users can photograph or retype sensitive content | Insider Risk, monitoring, training, watermarks where available, least privilege, sanctions for policy violations |
| **Personal ChatGPT accounts** | ChatGPT Enterprise SSO/SCIM | SSO does not stop unprovisioned verified-domain users from using personal ChatGPT accounts [22] | Block/unsanction public ChatGPT for sensitive users/data; allow only enterprise workspace via managed paths |
| **Connected apps/data residency** | ChatGPT Enterprise apps/connectors | OpenAI notes data residency commitments can stop once queries/prompts are sent to a connected application; connected apps must separately meet residency/security requirements [25] | Keep apps disabled by default; approve only assessed apps; restrict app actions and roles |
| **Post-hoc Purview compliance for ChatGPT Enterprise** | Purview ChatGPT Enterprise connector | Captured interactions support classification, retention, eDiscovery, IRM, Communication Compliance, but DLP and labels are not supported for ChatGPT Enterprise interactions [1] | Treat as detection/investigation, not preventive DLP |

## 8) Licensing and prerequisites

| Component | Required license / prerequisite grounded in sources | Notes |
|---|---|---|
| **Microsoft 365 Copilot** | Users need Microsoft 365 Copilot / Microsoft 365 Copilot Chat capability enabled; Purview protections apply to Microsoft 365 Copilot & Copilot Chat AI interactions [2] | Best fit when work is grounded in Microsoft 365 tenant data [21] |
| **Microsoft Purview DLP / Endpoint DLP** | Devices must be onboarded to Microsoft Purview for Endpoint DLP; DLP policy location **Devices** is used for paste/upload endpoint actions [5][30] | Specific license entitlement should be validated against the tenant’s Microsoft Purview plan; controls are deployed in Purview DLP and Endpoint DLP settings |
| **Microsoft Defender for Cloud Apps / Conditional Access App Control** | Defender for Cloud Apps license, standalone or included; Microsoft Entra ID P1 license; relevant apps onboarded to Conditional Access App Control; and a Microsoft Entra Conditional Access policy to route traffic [11] | Required for session/access policies |
| **Defender for Cloud Apps unsanctioned-app blocking** | Defender for Cloud Apps + Defender for Endpoint or Microsoft 365 E5; Microsoft Defender Antivirus real-time protection, cloud-delivered protection, and network protection in block mode; devices onboarded to Defender for Endpoint [8] | Unsanctioned app blocking latency up to 3 hours [8] |
| **Microsoft Entra Conditional Access** | Microsoft Entra ID P1 for Conditional Access policies used with Defender for Cloud Apps session control [11] | Entra CA policy routes browser sessions to Defender for Cloud Apps [11] |
| **Intune / device and browser management** | Managed browser/device configuration is needed to deploy Edge policies, block unmanaged browsers, and enforce Purview extensions [5][10] | Operational prerequisite for reliable browser DLP |
| **ChatGPT Enterprise** | OpenAI plan with Global Admin Console and Global Admin for SSO setup; ChatGPT Enterprise workspace with verified domain; SCIM/SSO configured via OpenAI Identity [23][22] | Enterprise Compliance API key required for Compliance Logs Platform export [27] |
| **OpenAI API enterprise controls** | API organization/project approved for ZDR/MAM if using data-retention controls; OpenAI says approval and additional requirements are needed [12] | Use projects, service accounts, RBAC, IP allowlist, mTLS/OIDC where appropriate [13][14] |

## 9) Recommended corporate implementation

### A. Default routing policy

1. **Route Microsoft 365-sensitive work to Microsoft 365 Copilot.** Use Copilot for summarizing, drafting, reasoning over, and transforming Microsoft 365 files, emails, Teams/SharePoint/OneDrive content, and Graph-connected content where existing Microsoft 365 permissions, labels, DLP, retention, audit, eDiscovery, Communication Compliance, and Insider Risk controls apply [2][21][3].
2. **Permit ChatGPT Enterprise only for approved use cases where native Purview DLP is not required**, and publish a data-handling standard that prohibits restricted labels/secrets unless routed through approved controls. Make clear that ChatGPT Enterprise has Purview DLP ✕ and sensitivity labels ✕ in Microsoft’s own support table [1].
3. **For sensitive non-M365 AI use cases, build an internal OpenAI API application/gateway.** Apply customer-owned DLP pre-screening before OpenAI API calls, and use approved OpenAI API projects, service accounts, ZDR/MAM where eligible, and centralized logging [12][13][14].

### Implementation data-class decision table

| Corporate data class / data type | Allowed AI path | Blocked paths | Required controls |
|---|---|---|---|
| **Restricted / Highly Confidential Microsoft 365 data**: M365 files, emails, Teams/SharePoint/OneDrive content with restricted labels, encryption, regulated records, or other Purview-protected material | **Microsoft 365 Copilot only** when the user has access and Copilot/Purview policy allows processing | ChatGPT Enterprise, public ChatGPT, and direct OpenAI API | Microsoft 365 Copilot Purview DLP location for prompts/files/emails, sensitivity-label and encryption/IRM enforcement, audit/eDiscovery/retention/Communication Compliance/Insider Risk [2][3][21] |
| **Sensitive non-M365 workflows**: approved customer, legal, engineering, operational, or regulated data that is not adequately governed through Microsoft 365/Graph | **Approved internal OpenAI API gateway** | Public ChatGPT, unmanaged ChatGPT Enterprise uploads, direct developer API keys | Entra authentication, customer-owned DLP/MIP pre-screening and redaction before API call, approved OpenAI projects/service accounts, ZDR/MAM where eligible, customer SIEM logging and retention [12][13][14] |
| **Lower-risk approved business use**: non-restricted drafts, brainstorming, public or approved internal reference material, sanitized examples | **ChatGPT Enterprise** with compensating controls | Public ChatGPT unless explicitly sanctioned; direct OpenAI API outside approved projects | SSO/SCIM/domain verification, apps disabled by default except approved apps, GPT/action controls, Compliance Logs export, Purview Endpoint DLP/Edge prompt blocking on managed browsers, Defender for Cloud Apps/Entra CA routing and logging [22][23][25][26][4][5][7][11] |
| **Blocked categories**: secrets/API keys/passwords, highly confidential labels where Copilot policy does not allow processing, export-controlled data without approved environment, payment card/health/HR data outside an approved regulated workflow, data subject to customer contractual no-AI/no-transfer terms | No general-purpose AI path; use only a separately approved regulated workflow if one exists | Public ChatGPT, ChatGPT Enterprise, direct OpenAI API, unmanaged browsers/devices | DLP Block policies for supported paste/upload paths, unsanction public ChatGPT/direct API routes, endpoint/network blocks, SIEM alerts and exception workflow [1][4][18][8] |

### B. ChatGPT Enterprise layered architecture

| Layer | Implementation steps | Enforces or detects? | Known trade-off |
|---|---|---|---|
| **Identity and access** | Verify domains; configure SAML SSO in OpenAI Identity; use SCIM directory sync from Entra ID groups; disable external-domain invites; restrict workspace roles and app/GPT permissions [22][23][25] | Enforces workspace access for provisioned users; detects via auth logs | Does not stop unprovisioned users from personal ChatGPT accounts [22] |
| **Workspace hardening** | Keep apps/connectors disabled by default; approve only required apps; assign apps to custom roles; restrict app actions to read-only/custom action sets where supported; approve GPT action domains; restrict third-party GPTs and GPT sharing [25][26] | Enforces ChatGPT workspace behavior | Reduces user flexibility; app/action granularity varies by app [25] |
| **File controls** | Limit approved file-upload workflows; train users that files may enter text extraction, code analysis, image interpretation, GPT Knowledge, Projects, connected apps, GPT Actions, and private vector-store retrieval paths [28] | Mostly governance/detection inside ChatGPT; prevention requires endpoint/browser/API gateway layer | Native Purview DLP does not inspect inside ChatGPT Enterprise [1] |
| **Purview Endpoint DLP** | In Microsoft Purview portal, create DLP policies with **Devices** location; conditions for sensitive information types and sensitivity labels; actions for Paste to supported browsers, Upload to restricted cloud service domain, Copy to clipboard as appropriate; use Audit only, Block with override, or Block; configure business justification/policy tips [4][18][5] | Enforces content-aware browser/endpoint controls before submission for supported paths | Browser/platform limitations; possible classification delay; false positives need tuning [4][18] |
| **Edge Browser Data Security** | Activate Purview policies in Microsoft Edge for AI prompt inspection; block sensitive typed/pasted prompts before leaving browser; block other browsers or require Purview extension in Chrome/Firefox [5][10] | Enforces strongest pre-submit prompt control in Edge | Edge-centric; users may resist browser restrictions |
| **Defender for Cloud Apps / Entra CA** | In Microsoft Defender portal > Cloud apps > Cloud discovery, filter Category = Generative AI; sanction/unsanction ChatGPT/public AI apps; create app governance policies; in Entra admin center create Conditional Access policy with session control **Use Conditional Access App Control**; in Defender portal create session/access policies [10][11] | Enforces access/session routing for browser sessions; detects app usage | Browser-session only; native/mobile/API bypass unless blocked [7] |
| **Network/proxy restrictions** | Use Defender for Endpoint unsanctioned app blocking, firewall/DNS/SWG allowlists, and proxy rules to block public ChatGPT or direct OpenAI API except approved paths [8][9] | Enforces access control | TLS inspection and proxying raise privacy, performance, and certificate-management concerns |
| **Logging and alerting** | Send Purview Activity Explorer/alerts, Defender session logs, Entra sign-in logs, ChatGPT Compliance Logs JSONL, and OpenAI API usage/export to SIEM; alert on sensitive-info matches, policy overrides, unsanctioned app access, anomalous AI use [6][11][26][27] | Detects/investigates | Logs do not prevent exfiltration unless tied to blocking policies |
| **Approved API gateway** | Build internal app with Entra auth, Purview/MIP/DLP pre-screening, prompt/file redaction, allowlisted tools/models, OpenAI projects/service accounts, ZDR/MAM where eligible, and response logging [12][13][14][15] | Enforces strongest non-M365 sensitive workflow control | Highest engineering and operational burden |

## 10) Audit and investigation outputs

| Option / control | Logs and investigation outputs | Where they live |
|---|---|---|
| **Purview Endpoint DLP / DSPM for AI** | Sensitive information type matches, sensitivity label references, AI interaction activity, DLP policy actions, policy tips/overrides/justifications where configured | Microsoft Purview Activity Explorer, alerts, DSPM for AI reports [6][5][2] |
| **ChatGPT Enterprise captured in Purview** | Prompts/responses, sensitive data identified in prompts/responses, AI interaction analytics; searchable with ChatGPT Enterprise item-class values for eDiscovery [17][1] | Microsoft Purview Activity Explorer; Data Lifecycle Management retention policies; eDiscovery cases/search/export [1][17] |
| **Microsoft 365 Copilot** | Audit records for prompts, responses, referenced content; eDiscovery/compliance interaction data; retained referenced-file versions; user-uploaded files in OneDrive Copilot Chat folders; Copilot Pages in SharePoint Embedded containers [3] | Microsoft Purview Audit, eDiscovery, retention; Microsoft 365 services [3][19] |
| **Communication Compliance / Insider Risk** | User prompts/responses for AI apps, inappropriate communications, sensitive-info sharing, risky AI usage including prompt injection and protected-material access [2][6] | Microsoft Purview Communication Compliance and Insider Risk Management [2][6] |
| **Defender for Cloud Apps** | Routed session logs: time, IP, user agent, URLs visited, bytes uploaded/downloaded; Cloud Discovery reports; unsanctioned/blocked app access alerts if enabled [11][8] | Microsoft Defender portal > Cloud Apps; Cloud Discovery dashboard; Reports > Cloud Apps > Exported reports [11] |
| **Microsoft Entra Conditional Access** | Sign-in and Conditional Access policy outcomes for routing to Defender for Cloud Apps | Microsoft Entra admin center sign-in logs; Defender session-control app must be allowed [11] |
| **ChatGPT Enterprise / OpenAI Compliance Logs** | Conversations, uploaded files, GPT configuration/metadata, memories, workspace users, Admin Audit logs, User Authentication logs, Codex Usage logs; immutable time-windowed JSONL with minutes-level latency [26][27] | OpenAI Compliance Logs Platform / Compliance API; export to SIEM/data lake [27] |
| **OpenAI API Platform** | Usage dashboard/export, project/API key/service-account administration, application logs built by customer gateway, retention-control settings via API | OpenAI Platform organization/project settings and Admin APIs; customer SIEM/data lake [12][13][14] |

## 11) Fallback branches and trade-offs

| If the requirement is… | Recommended branch | Benefits | Trade-offs |
|---|---|---|---|
| **Native or highly reliable Purview DLP for AI prompts/files** | Use **Microsoft 365 Copilot + Purview** for Microsoft 365 work; block ChatGPT Enterprise for restricted labels/data | Best alignment with Purview labels, DLP, audit, retention, eDiscovery, Communication Compliance, Insider Risk [2] | Not a general ChatGPT Enterprise or arbitrary OpenAI API substitute; external data label/encryption support is limited [20] |
| **ChatGPT-style experience for sensitive non-M365 workflows** | Build an internal OpenAI API gateway with customer-owned DLP pre-screening | Can enforce DLP before API call; uses OpenAI API privacy controls, projects, service accounts, ZDR/MAM where eligible [12][13][14] | Engineering cost, latency, model/tool governance burden, false positives, need to maintain logs/redaction |
| **Broad productivity with lower-risk data** | Allow ChatGPT Enterprise with layered controls: SSO/SCIM, strict app/GPT settings, Endpoint DLP, Defender CAAC, logging | High user productivity; better privacy than personal ChatGPT; strong audit trail [24][26][25] | Not native Purview DLP; browser/device gaps; personal-account bypass if public ChatGPT not blocked [1][22] |
| **Zero tolerance for sensitive data in public ChatGPT** | Unsanction/block public ChatGPT and direct OpenAI API except approved gateway; route users to Copilot/API gateway | Reduces bypass and exfiltration risk | Productivity friction; exception process; blocking latency up to 3 hours with MDE unsanctioned-app sync [8] |
| **Adaptive user-risk enforcement** | Use Purview DLP/Adaptive Protection-style policies for elevated-risk users and Defender/Purview alerts | Targets high-risk users and reduces blanket blocking | Requires tuning and operational triage; false positives and user override review |
| **TLS/proxy inspection for unmanaged paths** | Use SWG/proxy with legal/privacy review and certificate management | Can broaden visibility beyond native Microsoft controls | Privacy concerns, app breakage, certificate pinning, encrypted traffic bypass if not forced through proxy |

## Final recommendation

1. **Choose Microsoft 365 Copilot + Purview as the primary corporate AI option for Microsoft 365-grounded work.** It is the only evaluated option where Microsoft’s own Purview table marks sensitivity labels, encryption, DLP, audit, eDiscovery, retention, Communication Compliance, Insider Risk, and Compliance Manager all supported for AI interactions [2]. It also honors Microsoft 365 identity, permissions, Semantic Index access boundaries, and Purview label/IRM usage rights [21][3].

2. **Do not describe ChatGPT Enterprise as having native Microsoft Purview DLP.** Microsoft marks Data loss prevention ✕ and Sensitivity labels ✕ for ChatGPT Enterprise AI interactions [1]. Purview can capture and govern interactions for audit, classification, retention, eDiscovery, Communication Compliance, and Insider Risk, but that is not the same as blocking sensitive prompts/files before they enter ChatGPT Enterprise [1][17].

3. **If ChatGPT Enterprise is approved, deploy it only as a layered-risk-reduction pattern.** Require SSO/SCIM/domain verification, restrict apps/connectors/GPT actions/GPT sharing, enable Compliance Logs export, enforce Purview Endpoint DLP and Edge Browser Data Security on managed endpoints, route browser sessions through Defender for Cloud Apps/Entra Conditional Access, block unsanctioned public ChatGPT/direct API paths, and send all logs to SIEM [22][23][25][4][5][7][8][11][27].

4. **For sensitive non-M365 workflows that need ChatGPT-like flexibility, build an internal OpenAI API gateway.** Use Entra authentication, customer-owned DLP and label checks before submission, approved OpenAI projects/service accounts/API keys, ZDR/MAM where eligible, moderation where relevant, and customer logging/retention [12][13][14][15]. This is the most controllable path when Copilot is too M365-scoped and ChatGPT Enterprise native Purview DLP is unavailable.

5. **Where the business demands native or sufficiently reliable DLP and the data path cannot be forced through managed browser/endpoint/API gateway controls, block or unsanction ChatGPT for that data class.** That is the clearest policy boundary: use Copilot for Purview-covered Microsoft 365 work, use the internal API gateway for approved sensitive custom workflows, and reserve ChatGPT Enterprise for approved lower-risk use cases with monitoring and compensating controls.

## Sources

1. [Use Microsoft Purview to manage data security & compliance for ChatGPT Enterprise](https://learn.microsoft.com/en-us/purview/ai-chatgpt-enterprise)
2. [Use Microsoft Purview to manage data security & compliance for Microsoft 365 Copilot & Microsoft 365 Copilot Chat](https://learn.microsoft.com/en-us/purview/ai-m365-copilot)
3. [Microsoft 365 Copilot data protection architecture](https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-architecture-data-protection-auditing)
4. [Help prevent leakage of sensitive content by restricting paste actions into browsers](https://learn.microsoft.com/en-us/purview/endpoint-dlp-create-policy-restrict-paste-in-browsers)
5. [Step 3: Block sensitive data going to sanctioned AI apps - Prevent data leak to shadow AI](https://learn.microsoft.com/en-us/purview/deploymentmodels/depmod-data-leak-shadow-ai-step3)
6. [Microsoft Purview data security and compliance protections for Microsoft 365 Copilot and other generative AI apps](https://learn.microsoft.com/en-us/purview/ai-microsoft-purview)
7. [Conditional Access app control - Microsoft Defender for Cloud Apps | Microsoft Learn](https://learn.microsoft.com/en-us/defender-cloud-apps/proxy-intro-aad)
8. [Govern discovered apps using Microsoft Defender for Endpoint - Microsoft Defender for Cloud Apps](https://learn.microsoft.com/en-us/defender-cloud-apps/mde-govern)
9. [Govern discovered apps - Microsoft Defender for Cloud Apps](https://learn.microsoft.com/en-us/defender-cloud-apps/governance-discovery)
10. [Manage generative AI apps for your organization](https://learn.microsoft.com/en-us/microsoft-365/copilot/manage-generative-ai-apps)
11. [Create session policies - Microsoft Defender for Cloud Apps](https://learn.microsoft.com/en-us/defender-cloud-apps/session-policy-aad)
12. [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data)
13. [Manage permissions in the OpenAI platform](https://developers.openai.com/api/docs/guides/rbac)
14. [Service Accounts](https://developers.openai.com/api/reference/resources/organization/subresources/projects/subresources/service_accounts/)
15. [Moderation | OpenAI API](https://developers.openai.com/api/docs/guides/moderation)
16. [Use Microsoft Purview to manage data security & compliance for other AI apps](https://learn.microsoft.com/en-us/purview/ai-other-apps)
17. [Connect to and manage ChatGPT Enterprise AI interactions in Microsoft Purview (preview)](https://learn.microsoft.com/en-us/purview/archive-chatgpt-interactions)
18. [Configure endpoint DLP settings](https://learn.microsoft.com/en-us/purview/dlp-configure-endpoint-settings?tabs=purview)
19. [Learn about retention for Copilot and AI apps](https://learn.microsoft.com/en-us/purview/retention-policies-copilot)
20. [Considerations for Microsoft Purview to manage Microsoft 365 Copilot and Channel Agent in Teams for security and compliance](https://learn.microsoft.com/en-us/purview/ai-m365-copilot-considerations)
21. [Data, Privacy, and Security for Microsoft 365 Copilot](https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-privacy)
22. [Getting started with identity and provisioning in ChatGPT Enterprise, Edu, and ChatGPT for Teachers | OpenAI Help Center](https://help.openai.com/en/articles/9672121-getting-started-with-identity-and-provisioning-in-chatgpt-enterprise)
23. [Configuring SSO | OpenAI Help Center](https://help.openai.com/en/articles/9534785-provisioning-sso-for-chatgpt-enterprise)
24. [Enterprise privacy at OpenAI](https://openai.com/enterprise-privacy/)
25. [Admin Controls, Security, and Compliance in apps (Enterprise, Edu, and Business) | OpenAI Help Center](https://help.openai.com/en/articles/11509118-admin-controls-security-and-compliance-in-connectors-enterprise-edu-and-team)
26. [New compliance and administrative tools for ChatGPT Enterprise](https://openai.com/index/new-tools-for-chatgpt-enterprise/)
27. [OpenAI Compliance Logs Platform quickstart](https://developers.openai.com/cookbook/examples/chatgpt/compliance_api/logs_platform)
28. [Optimizing File Uploads in ChatGPT Enterprise | OpenAI Help Center](https://help.openai.com/en/articles/10029836-optimizing-file-uploads-in-chatgpt-enterprise)
29. [Update project data retention](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/projects/subresources/data_retention/methods/update)
30. [Learn about Endpoint data loss prevention](https://learn.microsoft.com/en-us/purview/endpoint-dlp-learn-about)