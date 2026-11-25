const $ = (id) => document.getElementById(id);
const sessionProofKey = "fulcrum-session-proof";
const sessionFragment = "#/session/";

const state = {
  snapshot: null,
  activeRequest: null,
  refreshing: null,
  sessionProof: null,
};

const labels = {
  queued: "Queued",
  running: "In progress",
  failed: "Failed",
  completed: "Report ready",
  interrupted: "Interrupted",
  passed: "Passed",
  blocked: "Blocked",
  skipped: "Skipped",
  unavailable: "Unavailable",
  not_run: "Not run",
};

const sourceKinds = {
  issue: "Issue",
  public_issue: "Public issue",
  private_issue: "Private issue",
  advisory: "Private advisory",
  ghsa: "Private advisory",
};

const rankStates = {
  awaiting_assessment: "Awaiting assessment",
  outside_window: "Outside the ranking window",
  ineligible: "Excluded by project policy",
};

const batchStates = {
  awaiting_action: "No queue run was recorded.",
  publishing: "The last recorded queue run was still in progress.",
  incomplete: "The queue run finished with requests still missing.",
  failed: "The queue workflow stopped before publishing all requests.",
  unavailable: "GitHub Actions status is unavailable.",
};

const regressionVerdicts = {
  regression_signal: "Regression signal",
  no_regression_observed: "No regression observed",
  insufficient_evidence: "Insufficient evidence",
};

const workerStates = {
  online: "Online",
  running: "Running",
  stopped: "Stopped",
  "ranking delayed": "Ranking delayed",
};

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function externalUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {
    // Missing or malformed source links stay plain text.
  }
  return null;
}

function externalLink(label, value) {
  const url = externalUrl(value);
  if (!url) return null;
  const link = node("a", label);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function feedback(id, message) {
  const element = $(id);
  element.textContent = message;
  element.hidden = !message;
}

function statusBadge(status, pullRequest) {
  const label = pullRequest ? "PR created" : (labels[status] ?? status ?? "Unknown");
  const badge = node("span", label, "status");
  badge.dataset.status = pullRequest ? "completed" : status;
  return badge;
}

function dateText(value) {
  const time = new Date(value);
  return Number.isNaN(time.valueOf()) ? String(value) : time.toLocaleString();
}

async function api(path, payload) {
  if (state.pagesTransport) return state.pagesTransport(path, payload);
  const options = {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {},
  };
  if (path !== "session" && state.sessionProof) {
    options.headers["X-Fulcrum-CSRF"] = state.sessionProof;
  }
  if (payload !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(`/api/${path}`, options);
  const body = await response.json();
  if (response.ok) return body;
  const error = new Error(body.error || "Fulcrum could not complete the request.");
  error.status = response.status;
  throw error;
}

function sourceList(sources, caseTitle) {
  const list = node("ul", undefined, "sources");
  for (const source of sources) {
    const kind = sourceKinds[source.kind] ?? "Source";
    const identifier = source.number ? `#${source.number}` : source.id;
    const title = source.title === caseTitle && identifier
      ? identifier : source.title || identifier || kind;
    const item = node("li");
    item.append(node("span", kind, "source-kind"));
    item.append(externalLink(title, source.url) ?? node("span", title));
    if (identifier && identifier !== title) {
      item.append(node("code", identifier, "source-revision"));
    }
    if (source.project) item.append(projectContext(source.project));
    list.append(item);
  }
  return list;
}

function projectContext(project) {
  const details = node("details", undefined, "triage-context");
  details.append(node("summary", "Tamis triage"), metadata([
    ["Board priority", project.priority],
    ["State", project.state],
    ["Severity", project.severity],
    ["Component", project.component],
    ["Failed attempts", project.attempts],
    ["Duplicate of", project.duplicate],
    ["Policy exclusion", project.excluded],
  ]));
  return details;
}

function makeCaseRow(record, request, pending) {
  const row = node("tr");
  row.setAttribute("role", "row");
  const rank = node("td", record.rank ?? "—", "rank");
  if (record.rank == null) rank.setAttribute("aria-label", "Unranked");
  const label = node("th", undefined, "case-label");
  label.scope = "row";
  label.setAttribute("role", "rowheader");
  label.append(node("span", record.title, "case-title"),
    sourceList(record.sources ?? [], record.title));
  const reason = record.rationale || rankStates[record.rank_state] || "Awaiting assessment";
  const rationale = node("td", reason, "rationale");
  if (record.duplicate_reason) {
    rationale.append(node("p", record.duplicate_reason, "duplicate-reason"));
  }

  const patching = node("td", undefined, "case-status");
  if (pending) {
    const button = node("button", "Batch incomplete", "link-button");
    button.type = "button";
    button.addEventListener("click", () => setView("requests", true));
    patching.append(button);
  } else if (request) {
    const button = node("button", undefined, "status-action");
    button.type = "button";
    const status = statusBadge(request.status, request.pr_url);
    button.append(status);
    button.setAttribute("aria-label", `View attempt for ${record.title} (${status.textContent})`);
    button.addEventListener("click", () => {
      selectRequest(request.id);
      setView("requests", true);
    });
    patching.append(button);
  } else {
    patching.append(node("span", "Not requested", "muted"));
  }
  for (const cell of [rank, rationale, patching]) {
    cell.setAttribute("role", "cell");
  }
  row.append(rank, label, rationale, patching);
  return row;
}

function renderCases() {
  const {cases, requests} = state.snapshot;
  const sorted = [...cases].sort(
    (left, right) => (left.rank ?? Infinity) - (right.rank ?? Infinity),
  );
  const pending = pendingCaseIds(state.snapshot.batches ?? []);
  const latest = new Map();
  for (const request of requests) {
    if (!latest.has(request.case_id)) latest.set(request.case_id, request);
  }
  const rows = sorted.map(
    (record) => makeCaseRow(record, latest.get(record.id), pending.has(record.id)),
  );
  $("case-rows").replaceChildren(...rows);
  const ranked = sorted.filter((record) => record.rank != null).length;
  $("case-count").textContent = cases.length;
  $("ranking-context").textContent = cases.length
    ? `${ranked} of ${cases.length} cases ranked` : "";
  $("empty-inbox").hidden = !!cases.length;
}

function pendingCaseIds(batches) {
  const cases = new Set();
  for (const batch of batches) {
    const missing = new Set(batch.missing_request_ids);
    for (const job of batch.jobs) {
      if (missing.has(job.id)) cases.add(job.case_id);
    }
  }
  return cases;
}

function selectRequest(id) {
  state.activeRequest = id;
  renderAttempts();
  renderDetail();
}

function openRequest(id) {
  selectRequest(id);
  if (matchMedia("(max-width: 48rem)").matches) $("request-detail").focus();
}

function renderAttempts() {
  const requests = state.snapshot.requests;
  const list = $("request-rows");
  const focused = document.activeElement?.dataset.requestId;
  const rows = requests.map((record) => {
    const item = node("li");
    const button = node("button", undefined, "attempt");
    button.type = "button";
    button.dataset.requestId = record.id;
    button.setAttribute("aria-pressed", String(state.activeRequest === record.id));
    button.append(
      node("strong", record.case_title || record.case_id),
      statusBadge(record.status, record.pr_url),
      node("span", record.attempt_id || record.id, "attempt-id"),
    );
    button.addEventListener("click", () => openRequest(record.id));
    item.append(button);
    return item;
  });

  list.replaceChildren(...rows);
  const focusedRow = rows.find((row) => row.firstChild.dataset.requestId === focused);
  focusedRow?.firstChild.focus({preventScroll: true});
  const waiting = (state.snapshot.batches ?? []).reduce(
    (count, batch) => count + batch.missing_request_ids.length, 0,
  );
  $("request-count").textContent = requests.length + waiting;
  $("empty-requests").hidden = !!requests.length;
  const worker = state.snapshot.worker ?? {};
  $("request-context").replaceChildren(workerEvidence(worker, state.snapshot.last_check_in));
}

function metadata(entries) {
  const list = node("dl", undefined, "metadata");
  for (const [label, value] of entries) {
    if (value == null || value === "") continue;
    list.append(node("dt", label), node("dd", value));
  }
  return list;
}

export function workerEvidence(worker, lastCheckIn) {
  const checkIn = worker.last_check_in || lastCheckIn;
  const info = metadata([
    ["Worker status", workerStates[worker.status] ?? worker.status],
    ["Stage", worker.stage],
    ["Last check-in", checkIn && dateText(checkIn)],
    ["Reason", worker.reason],
  ]);
  info.className = "metadata worker-metadata";
  info.dataset.worker = worker.status || "unknown";
  return info.childElementCount
    ? info
    : node("p", "No worker check-in has been recorded.", "muted");
}

function evidenceChecks(report) {
  const checks = [...(report.checks ?? [])];
  const comparable = new Set(
    checks.filter((check) => check.baseline != null).map((check) => check.name),
  );
  const baseline = new Map((report.baseline_checks ?? []).map((check) => [check.name, check]));
  const candidate = new Map((report.candidate_checks ?? []).map((check) => [check.name, check]));
  const names = new Set([...baseline.keys(), ...candidate.keys()]);
  for (const name of names) {
    if (comparable.has(name)) continue;
    const before = baseline.get(name);
    const after = candidate.get(name);
    checks.push({
      name, baseline: before?.status, status: after?.status,
      detail: after?.detail ?? before?.detail,
    });
  }
  return checks;
}

function checkOutcome(status) {
  const cell = node("td");
  cell.append(status ? statusBadge(status) : node("span", "Not recorded", "muted"));
  return cell;
}

function reportChecks(entries) {
  const table = node("table", undefined, "checks");
  const headings = node("tr");
  for (const label of ["Check", "Baseline", "Candidate", "Details"]) {
    const head = node("th", label);
    head.scope = "col";
    headings.append(head);
  }
  const header = node("thead");
  header.append(headings);
  const body = node("tbody");
  for (const check of entries) {
    const row = node("tr");
    const name = node("th", check.name);
    name.scope = "row";
    row.append(name, checkOutcome(check.baseline), checkOutcome(check.status),
      node("td", check.detail ?? "—"));
    body.append(row);
  }
  table.append(header, body);
  return table;
}

function textList(values) {
  const list = node("ul", undefined, "evidence-list");
  list.append(...values.map((value) => node("li", value)));
  return list;
}

function appendCheckGroup(parent, title, checks) {
  if (!checks.length) return;
  parent.append(node("p", title, "evidence-label"), textList(checks.map((check) => check.name)));
}

function regressionEvidence(report, checks) {
  const section = node("section", undefined, "regression-evidence");
  const verdict = regressionVerdicts[report.regression_verdict] ?? report.regression_verdict;
  section.append(
    node("h4", "Regression review"),
    verdict ? node("p", verdict, "evidence-label")
      : node("p", "No regression verdict was recorded.", "muted"),
  );
  if (report.regression_summary) section.append(node("p", report.regression_summary));
  appendCheckGroup(section, "Newly failing checks", checks.filter(
    (check) => check.regression === true ||
      (check.baseline === "passed" && check.status === "failed"),
  ));
  appendCheckGroup(section, "Pre-existing failing checks", checks.filter(
    (check) => check.baseline === "failed" && check.status === "failed" && !check.regression,
  ));
  return section;
}

function evidenceDetails(report) {
  const runtime = report.runtime ?? {};
  const details = node("details", undefined, "evidence-details");
  const info = metadata([
    ["Diff SHA-256", report.diff_sha256],
    ["Provider", runtime.provider],
    ["Model", runtime.model],
    ["OpenCode", runtime.opencode],
    ["OpenCode SDK", runtime.sdk],
  ]);
  const skills = (report.skills ?? []).filter((skill) => skill.name);
  if (!info.childElementCount && !skills.length) return null;
  details.append(node("summary", "Evidence details"));
  if (info.childElementCount) details.append(info);
  if (skills.length) {
    const list = node("ul", undefined, "evidence-list");
    for (const skill of skills) {
      const item = node("li", skill.name);
      if (skill.version || skill.revision) {
        item.append(metadata([["Version", skill.version], ["Revision", skill.revision]]));
      }
      list.append(item);
    }
    details.append(node("p", "Recorded skills", "evidence-label"), list);
  }
  return details;
}

function diffLineClass(line, inHunk) {
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("\\")) return "diff-meta";
  if (!inHunk && /^(?:diff |index |--- |\+\+\+ )/u.test(line)) return "diff-meta";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-remove";
  return undefined;
}

function reportDiff(text) {
  const diff = node("pre", undefined, "diff");
  const code = node("code");
  let inHunk = false;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    if (line.startsWith("diff ")) inHunk = false;
    const className = diffLineClass(line, inHunk);
    if (className === "diff-hunk") inHunk = true;
    code.append(node("span", line, className));
  }
  diff.tabIndex = 0;
  diff.setAttribute("aria-label", "Exact patch diff");
  diff.append(code);
  return diff;
}

export function reportEvidence(report) {
  const evidence = node("section", undefined, "evidence");
  evidence.append(node("h3", "Review report"));
  if (report.summary) evidence.append(node("p", report.summary, "report-summary"));
  evidence.append(metadata([
    ["Base commit", report.base],
    ["Candidate commit", report.head],
    ["PR repository", report.target],
    ["PR branch", report.branch],
  ]));
  const checks = evidenceChecks(report);
  evidence.append(regressionEvidence(report, checks), node("h4", "Checks"));
  if (checks.length) {
    const region = node("div", undefined, "checks-scroll");
    region.tabIndex = 0;
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", "Baseline and candidate checks");
    region.append(reportChecks(checks));
    evidence.append(region);
  } else {
    evidence.append(node("p", "No checks were recorded.", "muted"));
  }
  const gaps = (report.gaps ?? []).filter((gap) => typeof gap === "string" && gap.trim());
  evidence.append(node("h4", "Evidence gaps"));
  evidence.append(gaps.length ? textList(gaps) : node("p", "No gaps were recorded.", "muted"));
  evidence.append(node("h4", "Exact diff"));
  if (report.diff) {
    evidence.append(reportDiff(report.diff));
  } else {
    evidence.append(node("p", "No candidate diff was recorded.", "muted"));
  }
  const details = evidenceDetails(report);
  if (details) evidence.append(details);
  return evidence;
}

function attemptMetadata(record) {
  const info = metadata([
    ["Attempt", record.attempt_id || record.id],
    ["Retry of", record.retry_of],
    ["Submitted", record.created_at && dateText(record.created_at)],
    ["Claimed", record.claimed_at && dateText(record.claimed_at)],
    ["Worker", record.hostname],
    ["Worker PID", record.pid],
    ["Last check-in", record.last_check_in && dateText(record.last_check_in)],
    ["Last step", record.stage ?? record.last_step ?? record.report?.stage],
    ["Source revision", record.revision],
    ["Target repository", !record.report && record.target ? record.target : ""],
    ["Target branch", !record.report && record.branch ? record.branch : ""],
    ["Base commit", !record.report && record.base ? record.base : ""],
  ]);
  const terminal = ["completed", "failed", "interrupted"].includes(record.status);
  if (!record.report || !terminal) return info;
  const details = node("details", undefined, "run-details");
  details.append(node("summary", "Run details"), info);
  return details;
}

function attemptLinks(record) {
  const links = node("div", undefined, "detail-links");
  for (const [label, url] of [
    ["Queue workflow ↗", record.run_url],
    ["Worker report ↗", record.report_url],
    ["Open pull request ↗", record.pr_url],
  ]) {
    const link = externalLink(label, url);
    if (link) links.append(link);
  }
  return links;
}

function renderDetail() {
  const detail = $("request-detail");
  const record = state.snapshot.requests.find((entry) => entry.id === state.activeRequest);
  if (!record) {
    const batch = state.snapshot.batches?.find(
      (entry) => entry.missing_request_ids.includes(state.activeRequest),
    );
    const message = batch
      ? batchStates[batch.status]
      : "Select a published attempt to see its status and evidence.";
    detail.replaceChildren(node("p", message, "empty"));
    return;
  }

  const heading = node("header", undefined, "detail-heading");
  heading.append(
    node("h2", record.case_title || record.case_id), statusBadge(record.status, record.pr_url),
  );
  detail.replaceChildren(heading);
  if (record.error) detail.append(node("p", record.error, "notice error"));
  detail.append(attemptMetadata(record));
  const links = attemptLinks(record);
  if (links.childElementCount) detail.append(links);
  if (record.report) detail.append(reportEvidence(record.report));
  else detail.append(node("p", "No review report is available for this attempt.", "muted"));
  if (record.publication_error || record.publication_pending) {
    detail.append(node("p", record.publication_error ||
      "Publication was requested before patching paused.", "notice"));
  }
}

function makeBatchRow(batch) {
  const item = node("li");
  const missing = new Set(batch.missing_request_ids);
  const total = batch.request_ids.length;
  item.append(node("h3", `${total - missing.size} of ${total} requests published`));
  item.append(node("p", batchStates[batch.status]));
  if (batch.action_conclusion && batch.action_conclusion !== "success") {
    item.append(node("p", `GitHub Actions outcome: ${batch.action_conclusion}`, "muted"));
  }
  const jobs = node("ul", undefined, "pending-jobs");
  for (const job of batch.jobs) {
    if (missing.has(job.id)) jobs.append(node("li", job.case_title));
  }
  item.append(jobs);
  const link = externalLink("Open queue run ↗", batch.run_url);
  if (link) item.append(link);
  return item;
}

function renderPendingBatches(batches) {
  $("pending-batches").hidden = batches.length === 0;
  $("pending-rows").replaceChildren(...batches.map(makeBatchRow));
}

function renderSnapshot(snapshot) {
  const previous = state.snapshot;
  const previousRequest = previous?.requests.find((entry) => entry.id === state.activeRequest);
  state.snapshot = snapshot;
  state.activeRequest ??= snapshot.requests[0]?.id ?? null;
  const currentRequest = snapshot.requests.find((entry) => entry.id === state.activeRequest);

  const listFields = (records) => records?.map((record) => [
    record.id, record.case_id, record.case_title, record.status, record.pr_url,
  ]);
  const previousList = JSON.stringify(listFields(previous?.requests));
  const changedRequests = previousList !== JSON.stringify(listFields(snapshot.requests));
  const batches = snapshot.batches ?? [];
  const changedBatches = JSON.stringify(previous?.batches) !== JSON.stringify(batches);
  const changedCases = JSON.stringify(previous?.cases) !== JSON.stringify(snapshot.cases);
  if (changedRequests || changedBatches || changedCases) {
    renderCases();
  }
  const changedWorker = JSON.stringify(previous?.worker) !== JSON.stringify(snapshot.worker) ||
    previous?.last_check_in !== snapshot.last_check_in;
  if (changedRequests || changedBatches || changedWorker) {
    renderAttempts();
  }
  if (changedBatches) renderPendingBatches(batches);
  if (!previous || changedBatches ||
      JSON.stringify(previousRequest) !== JSON.stringify(currentRequest)) {
    renderDetail();
  }
  const project = $("project-link");
  const url = externalUrl(snapshot.project_url);
  if (url) project.href = url;
  else project.removeAttribute("href");
  project.hidden = !url;
  $("workspace-nav").hidden = false;
  $("workspace").hidden = false;
}

async function refreshSnapshot() {
  try {
    renderSnapshot(await api("snapshot"));
    feedback("connection", "");
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      state.snapshot = null;
      $("workspace").hidden = true;
      $("workspace-nav").hidden = true;
      $("project-link").hidden = true;
      $("project-link").removeAttribute("href");
    }
    feedback("connection", error.status ? error.message : "Could not connect to Fulcrum.");
  }
}

function refresh() {
  if (!state.refreshing) {
    $("refresh").disabled = true;
    state.refreshing = refreshSnapshot().finally(() => {
      state.refreshing = null;
      $("refresh").disabled = false;
    });
  }
  return state.refreshing;
}

function setView(view, focus) {
  for (const name of ["inbox", "requests"]) {
    $(name).hidden = name !== view;
    if (name === view) $(`view-${name}`).setAttribute("aria-current", "page");
    else $(`view-${name}`).removeAttribute("aria-current");
  }
  if (focus) $(`${view}-heading`).focus();
}

async function connectPages() {
  const form = $("github-connect");
  feedback("connection", "");
  form.hidden = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const control = form.querySelector("button");
    const tokenField = $("github-token");
    const token = tokenField.value.trim();
    tokenField.value = "";
    control.disabled = true;
    feedback("connection", "Connecting to GitHub…");
    try {
      const {pagesTransport} = await import("./github-pages.mjs");
      const transport = pagesTransport($("github-repository").value.trim(), token);
      renderSnapshot(await transport("snapshot"));
      state.pagesTransport = transport;
      form.reset();
      form.hidden = true;
      $("disconnect").hidden = false;
      $("refresh").disabled = false;
      feedback("connection", "");
    } catch (error) {
      feedback("connection", error.status ? error.message : "Could not connect to GitHub.");
    } finally {
      control.disabled = false;
    }
  });
  $("disconnect").addEventListener("click", () => location.reload());
}

async function boot() {
  if (document.body.dataset.transport === "github") {
    await connectPages();
    return;
  }
  const fragment = location.hash;
  if (fragment.startsWith(sessionFragment)) {
    history.replaceState(null, "", location.pathname);
    try {
      const session = await api("session", {token: fragment.slice(sessionFragment.length)});
      rememberSession(session.csrf_token);
      if (state.refreshing) await state.refreshing;
    } catch (error) {
      feedback("connection", error.status ? error.message : "Could not open the Fulcrum session.");
      $("refresh").disabled = false;
      return;
    }
  } else {
    try {
      state.sessionProof = sessionStorage.getItem(sessionProofKey);
    } catch {
      // A fresh launch link can open a session when browser storage is disabled.
    }
  }
  await refresh();
}

function rememberSession(proof) {
  state.sessionProof = proof;
  try {
    sessionStorage.setItem(sessionProofKey, proof);
  } catch {
    // The current page still holds the proof for this session.
  }
}

if (typeof document !== "undefined") {
  window.addEventListener("hashchange", () => {
    if (document.body.dataset.transport !== "github" && location.hash.startsWith(sessionFragment)) {
      boot();
    }
  });
  for (const view of ["inbox", "requests"]) {
    $(`view-${view}`).addEventListener("click", (event) => {
      event.preventDefault();
      setView(view, true);
    });
  }
  $("refresh").addEventListener("click", refresh);
  boot();
}
