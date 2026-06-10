interface CommitInfo {
  sha: string;
  shortSha: string;
  dirty: boolean;
  dirtyFiles: string[];
}
interface CommitSummary {
  commitSha: string;
  runCount: number;
  scored: number;
  errors: number;
  avgNormalized: number | null;
  lastRun: number;
  anyDirty: boolean;
}
interface Profile {
  research: string;
  judge: string | null;
  grader: string;
  verifierPanel: string;
  timeoutMs: number | null;
  tokenLimit: number | null;
  concurrency: number;
}
interface CommitsResponse {
  current: CommitInfo | null;
  canRun: boolean;
  profile: Profile | null;
  commits: CommitSummary[];
}
interface CatalogCase {
  caseId: string;
  domain: string;
  problem: string;
  criteriaCount: number;
}
interface CatalogResponse {
  revision: string | null;
  count: number;
  cases: CatalogCase[];
  warning?: string;
}
interface GridRow {
  caseId: string;
  domain: string;
  problem: string;
  criteriaCount: number;
  status: string | null;
  normalized: number | null;
  normalizedSD: number | null;
  passRate: number | null;
  gradedCriteria: number | null;
  criteria: number | null;
  judgeErrors: number | null;
  error: string | null;
  researchModel: string | null;
  judgeModel: string | null;
  dirty: boolean;
  createdAt: number | null;
}
interface Section {
  id: string;
  title: string;
}
interface Criterion {
  sectionId: string;
  id: string;
  requirement: string;
  weight: number;
  verdict?: string | null;
  reason?: string;
  metVotes?: number;
  runs?: number;
}
interface SectionScore {
  id: string;
  title: string;
  criteria: number;
  normalizedScore: number;
  passRate: number;
}
interface RubricScore {
  normalizedScore: number;
  passRate: number;
  normalizedScoreSD?: number;
  passRateSD?: number;
  gradingRuns?: number;
  criteria: number;
  gradedCriteria: number;
  sections: SectionScore[];
}
interface RunDetail {
  status: string;
  score: RubricScore | null;
  report: Criterion[] | null;
  markdown: string | null;
  metrics: unknown;
  diagnostics: unknown;
  profile: {
    researchProvider: string | null;
    researchModel: string | null;
    judgeProvider: string | null;
    judgeModel: string | null;
    grader: string | null;
  };
  latencyMs: number;
  createdAt: number;
  dirty: boolean;
  finishReason: string | null;
  error: string | null;
  judgeErrors: number;
}
interface CaseDetail {
  caseId: string;
  domain: string;
  problem: string;
  sections: Section[];
  criteria: Criterion[];
  run?: RunDetail;
}
interface RunInfo {
  id: string;
  caseId: string;
  domain: string;
  phase: string;
  commit: string;
  dirty: boolean;
  startedAt: number;
  endedAt: number | null;
  sources: number;
  confirmed: number;
  angles: number;
  gradeDone: number;
  gradeTotal: number;
  error: string | null;
}
type WireEvent = { type: string; [key: string]: unknown };
interface LiveState {
  runId: string;
  caseId: string;
  phase: string;
  angles: number;
  sources: number;
  confirmed: number;
  gradeDone: number;
  gradeTotal: number;
  trace: string[];
}

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const SECTION_ORDER = [
  "factual-accuracy",
  "breadth-and-depth-of-analysis",
  "presentation-quality",
  "citation-quality",
];

let commitsInfo: CommitsResponse = {
  current: null,
  canRun: false,
  profile: null,
  commits: [],
};
let selectedCommit: string | null = null;
let catalog: { cases: CatalogCase[]; byId: Record<string, CatalogCase> } = {
  cases: [],
  byId: {},
};
let gridRows: GridRow[] = [];
let runsByCase: Record<string, RunInfo> = {};
let filters: { domain: string; status: string } = { domain: "", status: "" };
let sort = "score";
let detailCaseId: string | null = null;
let es: EventSource | null = null;
let live: LiveState | null = null;

function escapeHtml(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      (({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }) as Record<string, string>)[c],
  );
}
const escapeAttr = (s: unknown): string => escapeHtml(s);

function renderLink(text: string, url: string): string {
  const safe = /^https?:\/\//i.test(url) ? url : "#";
  return (
    '<a href="' +
    escapeHtml(safe) +
    '" target="_blank" rel="noopener">' +
    text +
    "</a>"
  );
}
function inline(s: string): string {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt: string, url: string) =>
    renderLink(txt, url),
  );
  return t;
}
function renderMarkdown(md: string): string {
  const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: string; items: string[] } | null = null;
  let code: string[] | null = null;
  const fp = () => {
    if (para.length) {
      out.push("<p>" + inline(para.join(" ")) + "</p>");
      para = [];
    }
  };
  const fl = () => {
    if (list) {
      out.push(
        "<" +
          list.tag +
          ">" +
          list.items.map((i) => "<li>" + inline(i) + "</li>").join("") +
          "</" +
          list.tag +
          ">",
      );
      list = null;
    }
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code !== null) {
        out.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
        code = null;
      } else {
        fp();
        fl();
        code = [];
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      fp();
      fl();
      out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">");
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      fp();
      if (!list || list.tag !== "ul") {
        fl();
        list = { tag: "ul", items: [] };
      }
      list.items.push(ul[1]);
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      fp();
      if (!list || list.tag !== "ol") {
        fl();
        list = { tag: "ol", items: [] };
      }
      list.items.push(ol[1]);
      continue;
    }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      fp();
      fl();
      out.push("<blockquote>" + inline(bq[1]) + "</blockquote>");
      continue;
    }
    if (line.trim() === "") {
      fp();
      fl();
      continue;
    }
    para.push(line.trim());
  }
  if (code !== null)
    out.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
  fp();
  fl();
  return out.join("\n");
}

const pct = (n: number | null | undefined): string =>
  n == null ? "—" : (n * 100).toFixed(1) + "%";
function scoreColor(n: number | null | undefined): string {
  if (n == null) return "#3a3a3a";
  const h = Math.round(120 * Math.max(0, Math.min(1, n)));
  return "hsl(" + h + ",58%,56%)";
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.json() as Promise<T>;
}
async function postJSON<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string } & T;
  if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
  return j;
}

function saveState(): void {
  try {
    localStorage.setItem(
      "draco.explore",
      JSON.stringify({ commit: selectedCommit, caseId: detailCaseId }),
    );
  } catch {
    /* ignore */
  }
}
function loadState(): { commit?: string; caseId?: string } {
  try {
    return JSON.parse(localStorage.getItem("draco.explore") || "{}");
  } catch {
    return {};
  }
}

function renderTopright(): void {
  const c = commitsInfo.current;
  const opts: { sha: string; label: string }[] = [];
  const cur = c ? c.sha : null;
  const known = new Set(commitsInfo.commits.map((x) => x.commitSha));
  if (cur && !known.has(cur)) {
    opts.push({
      sha: cur,
      label:
        "current " + (c as CommitInfo).shortSha + (c!.dirty ? " ~dirty" : "") + " (0 runs)",
    });
  }
  for (const cm of commitsInfo.commits) {
    const isCur = cm.commitSha === cur;
    const label =
      (isCur ? "current " : "") +
      (cm.commitSha.startsWith("unknown") ? cm.commitSha : cm.commitSha.slice(0, 10)) +
      " — " +
      cm.runCount +
      " runs, avg " +
      pct(cm.avgNormalized) +
      (cm.anyDirty ? " ~dirty" : "");
    opts.push({ sha: cm.commitSha, label });
  }
  const sel =
    '<select class="commit" id="commitSel">' +
    opts
      .map(
        (o) =>
          '<option value="' +
          escapeAttr(o.sha) +
          '"' +
          (o.sha === selectedCommit ? " selected" : "") +
          ">" +
          escapeHtml(o.label) +
          "</option>",
      )
      .join("") +
    "</select>";
  const dirty =
    c && c.dirty
      ? '<span class="pill dirty" title="' +
        escapeAttr(c.dirtyFiles.join("\n")) +
        '">~ ' +
        c.dirtyFiles.length +
        " uncommitted</span>"
      : "";
  const vo = commitsInfo.canRun
    ? ""
    : '<span class="pill warn">view-only · no judge key</span>';
  $("topright").innerHTML = sel + dirty + vo;
  ($("commitSel") as HTMLSelectElement).onchange = (e) => {
    selectedCommit = (e.target as HTMLSelectElement).value;
    saveState();
    void refreshGrid();
  };
}

function renderSummary(): void {
  const scored = gridRows.filter((r) => r.status === "scored");
  const errors = gridRows.filter((r) => r.status === "error").length;
  const run = gridRows.filter((r) => r.status).length;
  const avg = scored.length
    ? scored.reduce((a, r) => a + (r.normalized || 0), 0) / scored.length
    : null;
  const p = commitsInfo.profile || ({} as Partial<Profile>);
  $("summary").innerHTML =
    '<div class="big" style="color:' +
    scoreColor(avg) +
    '">' +
    pct(avg) +
    "</div>" +
    '<div class="kv">avg normalized · <b>' +
    scored.length +
    "</b> scored</div>" +
    '<span class="sep">|</span><div class="kv"><b>' +
    run +
    "</b> / " +
    gridRows.length +
    " run</div>" +
    (errors
      ? '<span class="sep">|</span><div class="kv" style="color:#ff9b95"><b>' +
        errors +
        "</b> errored</div>"
      : "") +
    '<div class="profileLine grow" style="text-align:right">' +
    escapeHtml(
      (p.research || "") + " · judge " + (p.judge || "none") + " · " + (p.grader || ""),
    ) +
    "</div>";
}

function renderToolbar(): void {
  const domains = [...new Set(catalog.cases.map((c) => c.domain))].sort();
  const domSel =
    '<select id="domFilter"><option value="">all domains</option>' +
    domains
      .map(
        (d) =>
          '<option value="' +
          escapeAttr(d) +
          '"' +
          (d === filters.domain ? " selected" : "") +
          ">" +
          escapeHtml(d) +
          "</option>",
      )
      .join("") +
    "</select>";
  const statuses: [string, string][] = [
    ["", "all"],
    ["scored", "scored"],
    ["error", "error"],
    ["notrun", "not run"],
  ];
  const chips =
    '<span class="chiprow">' +
    statuses
      .map(
        ([v, l]) =>
          '<button class="schip' +
          (filters.status === v ? " on" : "") +
          '" data-st="' +
          v +
          '">' +
          l +
          "</button>",
      )
      .join("") +
    "</span>";
  const sopts: [string, string][] = [
    ["score", "sort: score ↑"],
    ["domain", "sort: domain"],
    ["criteria", "sort: criteria"],
  ];
  const sortSel =
    '<select id="sortSel">' +
    sopts
      .map(
        ([v, l]) =>
          '<option value="' +
          v +
          '"' +
          (sort === v ? " selected" : "") +
          ">" +
          l +
          "</option>",
      )
      .join("") +
    "</select>";
  const unrun = gridRows.filter((r) => !r.status).length;
  const runAll =
    commitsInfo.canRun && unrun > 0
      ? '<button class="btn sm" id="runAll">Run ' + unrun + " un-run</button>"
      : "";
  const refresh = '<button class="btn sm" id="refreshCat">↻ catalog</button>';
  $("toolbar").innerHTML =
    domSel + chips + sortSel + '<span class="grow"></span>' + runAll + refresh;
  ($("domFilter") as HTMLSelectElement).onchange = (e) => {
    filters.domain = (e.target as HTMLSelectElement).value;
    renderGrid();
  };
  ($("sortSel") as HTMLSelectElement).onchange = (e) => {
    sort = (e.target as HTMLSelectElement).value;
    renderGrid();
  };
  for (const b of document.querySelectorAll<HTMLElement>(".schip"))
    b.onclick = () => {
      filters.status = b.dataset.st || "";
      renderToolbar();
      renderGrid();
    };
  const runAllEl = document.getElementById("runAll");
  if (runAllEl) runAllEl.onclick = () => void runUnrun();
  $("refreshCat").onclick = async () => {
    try {
      await postJSON("/api/catalog/refresh");
      await loadCatalog();
      void refreshGrid();
    } catch (e) {
      alert((e as Error).message);
    }
  };
}

function cellStatus(row: GridRow): { html: string; color: string } {
  const lr = runsByCase[row.caseId];
  if (lr && lr.phase === "queued")
    return { html: '<span class="badge queued">queued</span>', color: "#f5a524" };
  if (lr && (lr.phase === "researching" || lr.phase === "grading" || lr.phase === "persisting"))
    return { html: '<span class="badge running">' + lr.phase + "</span>", color: "#3ecf8e" };
  if (row.status === "error")
    return { html: '<span class="score" style="color:#ff6b6b">ERR</span>', color: "#ff6b6b" };
  if (row.status === "scored") {
    const c = scoreColor(row.normalized);
    return {
      html: '<span class="score" style="color:' + c + '">' + pct(row.normalized) + "</span>",
      color: c,
    };
  }
  return { html: '<span class="score" style="color:#3a3a3a">·</span>', color: "#1f1f1f" };
}
function visibleRows(): GridRow[] {
  let rows = gridRows.slice();
  if (filters.domain) rows = rows.filter((r) => r.domain === filters.domain);
  if (filters.status === "notrun") rows = rows.filter((r) => !r.status);
  else if (filters.status) rows = rows.filter((r) => r.status === filters.status);
  if (sort === "score")
    rows.sort(
      (a, b) =>
        (a.normalized == null ? 1.1 : a.normalized) -
        (b.normalized == null ? 1.1 : b.normalized),
    );
  else if (sort === "domain")
    rows.sort(
      (a, b) => a.domain.localeCompare(b.domain) || (b.normalized || 0) - (a.normalized || 0),
    );
  else if (sort === "criteria") rows.sort((a, b) => b.criteriaCount - a.criteriaCount);
  return rows;
}
function renderGrid(): void {
  const rows = visibleRows();
  if (!rows.length) {
    $("gridHost").innerHTML = '<div class="empty">no cases match.</div>';
    return;
  }
  $("gridHost").innerHTML =
    '<div class="grid">' +
    rows
      .map((r) => {
        const st = cellStatus(r);
        const sub =
          r.status === "scored"
            ? "pass " +
              pct(r.passRate) +
              " · " +
              r.gradedCriteria +
              "/" +
              r.criteria +
              (r.normalizedSD ? " · ±" + (r.normalizedSD * 100).toFixed(1) : "")
            : r.criteriaCount + " criteria";
        return (
          '<div class="cell" data-id="' +
          escapeAttr(r.caseId) +
          '" title="' +
          escapeAttr(r.problem) +
          '"><span class="bar" style="background:' +
          st.color +
          '"></span><div class="cellTop"><span class="dom">' +
          escapeHtml(r.domain) +
          ' · <span class="cid">' +
          escapeHtml(r.caseId.split("-")[0]) +
          "</span></span>" +
          st.html +
          '</div><div class="prob">' +
          escapeHtml(r.problem) +
          '</div><div class="sub">' +
          escapeHtml(sub) +
          "</div></div>"
        );
      })
      .join("") +
    "</div>";
  for (const el of document.querySelectorAll<HTMLElement>(".cell"))
    el.onclick = () => void openDetail(el.dataset.id as string);
}

async function loadCommits(): Promise<void> {
  commitsInfo = await getJSON<CommitsResponse>("/api/commits");
}
async function loadCatalog(): Promise<void> {
  const data = await getJSON<CatalogResponse>("/api/catalog");
  catalog.cases = data.cases || [];
  catalog.byId = {};
  for (const c of catalog.cases) catalog.byId[c.caseId] = c;
}
async function loadRuns(): Promise<void> {
  try {
    const data = await getJSON<{ runs: RunInfo[] }>("/api/runs");
    runsByCase = {};
    for (const r of data.runs) {
      const prev = runsByCase[r.caseId];
      if (!prev || r.startedAt > prev.startedAt) runsByCase[r.caseId] = r;
    }
  } catch {
    /* ignore */
  }
}
async function refreshGrid(): Promise<void> {
  const data = await getJSON<{ commit: string; rows: GridRow[] }>(
    "/api/grid?commit=" + encodeURIComponent(selectedCommit || ""),
  );
  gridRows = data.rows;
  renderSummary();
  renderToolbar();
  renderGrid();
}

function secTitle(sections: Section[] | undefined, id: string): string {
  const s = (sections || []).find((x) => x.id === id);
  if (s) return s.title;
  return id
    .split(/[-_\s]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
function orderedSectionIds(ids: string[]): string[] {
  const set = [...new Set(ids)];
  return [
    ...SECTION_ORDER.filter((s) => set.includes(s)),
    ...set.filter((s) => !SECTION_ORDER.includes(s)),
  ];
}

function renderRubric(d: CaseDetail): string {
  const run = d.run;
  const items: Criterion[] =
    run && run.report
      ? run.report
      : (d.criteria || []).map((c) => ({ ...c, verdict: null }));
  const sectionIds = orderedSectionIds(items.map((c) => c.sectionId));
  const sectionScores: Record<string, SectionScore> = {};
  if (run && run.score) for (const s of run.score.sections) sectionScores[s.id] = s;
  let html = "";
  for (const sid of sectionIds) {
    const crits = items.filter((c) => c.sectionId === sid);
    const ss = sectionScores[sid];
    html +=
      '<div class="sec"><div class="secHead"><span class="t">' +
      escapeHtml(secTitle(d.sections, sid)) +
      "</span>" +
      (ss
        ? '<span class="s" style="color:' +
          scoreColor(ss.normalizedScore) +
          '">' +
          pct(ss.normalizedScore) +
          " · pass " +
          pct(ss.passRate) +
          "</span>"
        : '<span class="s">' + crits.length + " criteria</span>") +
      "</div>";
    for (const c of crits) {
      const v = c.verdict;
      const pass = (c.weight > 0 && v === "MET") || (c.weight < 0 && v === "UNMET");
      const cls = v == null ? "none" : pass ? "met" : "unmet";
      const wcls = c.weight < 0 ? "wt neg" : "wt";
      html +=
        '<div class="crit"><span class="vdot ' +
        cls +
        '"></span><div><div class="req">' +
        escapeHtml(c.requirement) +
        '</div><div class="' +
        wcls +
        '">weight ' +
        c.weight +
        (v ? " · " + v : "") +
        (c.runs && c.runs > 1 && c.metVotes != null
          ? " · " + c.metVotes + "/" + c.runs + " MET"
          : "") +
        "</div>" +
        (c.reason ? '<div class="reason">' + escapeHtml(c.reason) + "</div>" : "") +
        "</div></div>";
    }
    html += "</div>";
  }
  return html;
}

function renderDetail(d: CaseDetail): void {
  const run = d.run;
  const score = run && run.score;
  const dirty = run && run.dirty ? '<span class="pill dirty">dirty</span>' : "";
  const head =
    '<div class="dHead"><div class="dHeadMain"><button class="btn sm" id="back">← grid</button>' +
    '<h1 class="cat">' +
    escapeHtml(d.domain) +
    '</h1><div class="caseref">' +
    escapeHtml(d.caseId) +
    " · " +
    d.criteria.length +
    ' criteria</div><p class="desc">' +
    escapeHtml(d.problem) +
    '</p><div class="meta">' +
    (score
      ? '<span style="color:' +
        scoreColor(score.normalizedScore) +
        '"><b>' +
        pct(score.normalizedScore) +
        "</b>" +
        (score.normalizedScoreSD
          ? " ±" + (score.normalizedScoreSD * 100).toFixed(1)
          : "") +
        " normalized</span><span>pass <b>" +
        pct(score.passRate) +
        "</b></span><span>" +
        score.gradedCriteria +
        "/" +
        score.criteria +
        " graded</span>" +
        (score.gradingRuns && score.gradingRuns > 1
          ? "<span>" + score.gradingRuns + " judge runs</span>"
          : "")
      : '<span style="color:#5a5a5a">not run for this commit</span>') +
    (run && run.error ? '<span style="color:#ff9b95">errored</span>' : "") +
    (run
      ? "<span>" +
        escapeHtml(
          (run.profile.researchModel || "") +
            " · " +
            (run.profile.judgeModel || "") +
            " · " +
            (run.profile.grader || ""),
        ) +
        "</span><span>" +
        (run.latencyMs ? (run.latencyMs / 1000).toFixed(0) + "s" : "") +
        "</span>"
      : "") +
    dirty +
    "</div></div>" +
    '<div class="dActions">' +
    (commitsInfo.canRun
      ? '<button class="btn primary" id="runBtn">' + (run ? "Re-run" : "Run") + "</button>"
      : "") +
    "</div></div>";

  const right =
    run && run.markdown
      ? '<div class="reportBody"><div class="report">' +
        renderMarkdown(run.markdown) +
        "</div></div>"
      : run && run.error
        ? '<div class="reportBody"><div class="errBox">' +
          escapeHtml(run.error) +
          "</div></div>"
        : '<div class="reportBody empty">no report yet — click Run to generate.</div>';

  $("detailWrap").innerHTML =
    head +
    '<div class="split"><div class="panel"><div class="panelHead">rubric · ' +
    (run && run.report ? run.report.length : (d.criteria || []).length) +
    ' criteria</div><div class="rubric" id="rubric">' +
    renderRubric(d) +
    '</div></div><div class="panel"><div class="panelHead">report</div>' +
    right +
    '</div></div><div id="liveHost"></div>';

  $("back").onclick = closeDetail;
  const runBtn = document.getElementById("runBtn");
  if (runBtn) runBtn.onclick = () => void triggerRun(d.caseId);
  for (const el of document.querySelectorAll<HTMLElement>(".crit"))
    el.onclick = () => el.classList.toggle("open");
  if (live && live.caseId === d.caseId) renderLive();
}

async function openDetail(caseId: string): Promise<void> {
  detailCaseId = caseId;
  saveState();
  $("gridWrap").classList.add("off");
  $("detailWrap").classList.add("on");
  $("detailWrap").innerHTML = '<div class="empty">loading…</div>';
  try {
    const d = await getJSON<CaseDetail>(
      "/api/case/" +
        encodeURIComponent(caseId) +
        "?commit=" +
        encodeURIComponent(selectedCommit || ""),
    );
    renderDetail(d);
    const r = runsByCase[caseId];
    if (r && r.phase !== "done" && r.phase !== "error" && r.phase !== "stopped")
      attachStream(r.id, caseId);
  } catch (e) {
    $("detailWrap").innerHTML =
      '<div class="empty">' + escapeHtml((e as Error).message) + "</div>";
  }
}
function closeDetail(): void {
  detailCaseId = null;
  saveState();
  if (es) {
    es.close();
    es = null;
  }
  live = null;
  $("detailWrap").classList.remove("on");
  $("gridWrap").classList.remove("off");
  void refreshGrid();
}

async function triggerRun(caseId: string): Promise<void> {
  try {
    const { runId } = await postJSON<{ runId: string }>(
      "/api/runs/" + encodeURIComponent(caseId) + "/run",
    );
    attachStream(runId, caseId);
    await loadRuns();
    renderGrid();
  } catch (e) {
    alert((e as Error).message);
  }
}
async function runUnrun(): Promise<void> {
  try {
    await postJSON("/api/runs/run-unrun?commit=" + encodeURIComponent(selectedCommit || ""));
    await loadRuns();
    renderGrid();
  } catch (e) {
    alert((e as Error).message);
  }
}

function renderLive(): void {
  const host = document.getElementById("liveHost");
  if (!host) return;
  if (!live) {
    host.innerHTML = "";
    return;
  }
  const gp = live.gradeTotal ? Math.round((live.gradeDone / live.gradeTotal) * 100) : 0;
  host.innerHTML =
    '<div class="live"><div class="liveHead"><span class="ph">' +
    escapeHtml(live.phase) +
    '</span><button class="btn sm" id="stopBtn">Stop</button></div>' +
    '<div class="liveBody"><div class="counters"><span>angles <b>' +
    live.angles +
    "</b></span><span>sources <b>" +
    live.sources +
    "</b></span><span>confirmed <b>" +
    live.confirmed +
    "</b></span>" +
    (live.phase === "grading"
      ? "<span>grading <b>" + live.gradeDone + "/" + live.gradeTotal + "</b></span>"
      : "") +
    "</div>" +
    (live.phase === "grading"
      ? '<div class="progress"><i style="width:' + gp + '%"></i></div>'
      : "") +
    (live.trace.length
      ? '<pre class="tlog">' + escapeHtml(live.trace.slice(-40).join("\n")) + "</pre>"
      : "") +
    "</div></div>";
  const stopBtn = document.getElementById("stopBtn");
  if (stopBtn)
    stopBtn.onclick = async () => {
      try {
        await postJSON("/api/runs/" + live!.runId + "/stop");
      } catch {
        /* ignore */
      }
    };
}

function attachStream(runId: string, caseId: string): void {
  if (es) {
    es.close();
    es = null;
  }
  live = {
    runId,
    caseId,
    phase: "queued",
    angles: 0,
    sources: 0,
    confirmed: 0,
    gradeDone: 0,
    gradeTotal: 0,
    trace: [],
  };
  if (detailCaseId === caseId) renderLive();
  es = new EventSource("/api/runs/" + encodeURIComponent(runId) + "/stream");
  es.onmessage = (ev: MessageEvent) => {
    let d: WireEvent;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(d, caseId);
  };
  es.onerror = () => {
    if (es) {
      es.close();
      es = null;
    }
  };
}
function handleEvent(e: WireEvent, caseId: string): void {
  if (!live) return;
  const t = e.type;
  if (t === "phase") live.phase = e.phase as string;
  else if (t === "scope_completed") {
    live.angles = (e.angles as unknown[]).length;
    live.trace.push("scope: " + live.angles + " angles");
  } else if (t === "searching") live.trace.push("search: " + (e.query || ""));
  else if (t === "fetching") live.trace.push("fetch: " + e.url);
  else if (t === "source_fetched") {
    live.sources++;
    live.trace.push("✓ " + (e.title || e.url));
  } else if (t === "source_error") live.trace.push("✗ " + e.url);
  else if (t === "claims_extracted") live.trace.push("claims +" + e.count);
  else if (t === "verify_started") {
    live.phase = "verifying";
    live.trace.push("verify " + e.claims + " claims");
  } else if (t === "claim_verified") {
    if (e.status === "confirmed") live.confirmed++;
  } else if (t === "verify_finished")
    live.trace.push("verified: " + e.confirmed + " confirmed, " + e.refuted + " refuted");
  else if (t === "research_finished")
    live.trace.push("research done: " + e.sourcesFetched + " sources");
  else if (t === "grade_progress") {
    live.phase = "grading";
    live.gradeDone = e.done as number;
    live.gradeTotal = e.total as number;
  } else if (t === "grade_finished")
    live.trace.push(
      "graded: " +
        e.status +
        " " +
        (e.normalized != null ? ((e.normalized as number) * 100).toFixed(1) + "%" : ""),
    );
  else if (t === "persisted") {
    void onRunDone(caseId);
    return;
  } else if (t === "error") {
    live.phase = "error";
    live.trace.push("ERROR: " + e.message);
    void onRunDone(caseId);
    return;
  }
  if (detailCaseId === caseId) renderLive();
}
async function onRunDone(caseId: string): Promise<void> {
  if (es) {
    es.close();
    es = null;
  }
  live = null;
  await loadRuns();
  if (detailCaseId === caseId) await openDetail(caseId);
  else await refreshGrid();
}

async function poll(): Promise<void> {
  await loadRuns();
  if (detailCaseId) {
    const r = runsByCase[detailCaseId];
    if (r && !es && r.phase !== "done" && r.phase !== "error" && r.phase !== "stopped")
      attachStream(r.id, detailCaseId);
  } else {
    renderGrid();
  }
}

$("home").onclick = closeDetail;

void (async function init(): Promise<void> {
  try {
    await loadCommits();
    const saved = loadState();
    const known = new Set(commitsInfo.commits.map((c) => c.commitSha));
    const cur = commitsInfo.current ? commitsInfo.current.sha : null;
    selectedCommit =
      saved.commit && (known.has(saved.commit) || saved.commit === cur)
        ? saved.commit
        : cur && known.has(cur)
          ? cur
          : commitsInfo.commits[0]
            ? commitsInfo.commits[0].commitSha
            : cur;
    renderTopright();
    await loadCatalog();
    await loadRuns();
    await refreshGrid();
    if (saved.caseId && catalog.byId[saved.caseId]) await openDetail(saved.caseId);
    setInterval(() => void poll(), 2500);
  } catch (e) {
    $("gridHost").innerHTML =
      '<div class="empty">' +
      escapeHtml((e as Error).message) +
      "<br><br>catalog/commits failed to load — check the server log.</div>";
  }
})();

export {};
