const stateBranch = "fulcrum-state";
const runName = "Fulcrum enqueue ";
const workflow = "fulcrum-enqueue.yml";
const groups = new Set(["queue", "claims", "reports", "prs", "batches",
  "publications", "publication-results"]);

export function batchReceipt(frozen) {
  return {
    batch: frozen.batch,
    created_at: frozen.created_at,
    request_ids: frozen.jobs.map((job) => job.id),
    jobs: frozen.jobs.map((job) => ({
      id: job.id, case_id: job.case_id, case_title: job.case.title,
      revision: job.case.revision, branch: job.branch, base: job.base,
    })),
  };
}

async function stateRecords(github, state) {
  const tree = await github(`${state.root}/git/trees/${stateBranch}?recursive=1`);
  if (tree.truncated) throw new Error("GitHub truncated the state snapshot. Refresh to retry.");
  const records = new Map();
  const relevant = tree.tree.filter(({type, path}) => type === "blob" && (
    /^(inbox|worker)\.json$/u.test(path) ||
    (groups.has(path.split("/")[0]) && /\.(json|md)$/u.test(path))
  ));
  for (let index = 0; index < relevant.length; index += 8) {
    await Promise.all(relevant.slice(index, index + 8).map(async ({path, sha, mode}) => {
      if (mode !== "120000") records.set(path, path.endsWith(".md") ? {sha} : await state.blob(sha));
    }));
  }
  return records;
}

function requestView(records, request, repo) {
  const id = request.id;
  const claim = records.get(`claims/${id}.json`);
  const result = records.get(`reports/${id}.json`);
  const pr = records.get(`prs/${id}.json`);
  const publication = records.get(`publications/${id}.json`);
  const publicationResult = records.get(`publication-results/${id}.json`);
  const {case: frozen, ...rest} = request;
  const view = {
    ...rest, ...claim, ...result, ...pr,
    case_title: frozen.title, revision: frozen.revision,
    status: result?.status ?? (claim ? "running" : "queued"),
  };
  if (publication && !pr) {
    view.publication_pending = !publicationResult;
    view.publication_error = publicationResult?.error;
  }
  if (view.report) {
    const {candidate: _candidate, ...review} = view.report;
    view.report = review;
  }
  if (result) {
    const root = `https://github.com/${repo}/blob/${stateBranch}/reports/${id}`;
    view.report_json_url = `${root}.json`;
    view.report_url = records.has(`reports/${id}.md`) ? `${root}.md` : view.report_json_url;
  } else if (claim) {
    const beat = records.get("worker.json");
    const same = beat?.worker_id === claim.worker_id && beat?.active_request === id;
    view.last_check_in = same ? beat.last_check_in : claim.claimed_at;
    view.stage = same ? beat.stage : null;
    if (Date.now() - Date.parse(view.last_check_in) > 150_000) {
      view.error = "The worker stopped checking in before recording a result.";
    }
  }
  return view;
}

function deliveryStatus(run) {
  if (!run) return "awaiting_action";
  if (run.status !== "completed") return "publishing";
  return run.conclusion === "success" ? "incomplete" : "failed";
}

async function pendingBatches(github, state, repo, records) {
  const batches = [];
  for (const [path, value] of records) {
    if (!path.startsWith("batches/")) continue;
    const receipt = batchReceipt(value);
    const missing = receipt.request_ids.filter((id) => !records.has(`queue/${id}.json`));
    if (missing.length) batches.push({...receipt, missing_request_ids: missing});
  }
  if (!batches.length) return batches;
  const runs = await latestRuns(github, state.root, batches);
  const workflowUrl = `https://github.com/${repo}/actions/workflows/${workflow}`;
  return batches.map((batch) => {
    const run = runs?.get(batch.batch);
    return {
      ...batch,
      status: runs ? deliveryStatus(run) : "unavailable",
      action_status: run?.status,
      action_conclusion: run?.conclusion,
      run_url: run?.html_url,
      workflow_url: workflowUrl,
    };
  }).sort(newestFirst("batch"));
}

async function latestRuns(github, root, batches) {
  const known = new Set(batches.map((entry) => entry.batch));
  const runs = new Map();
  try {
    for (let page = 1; page <= 10; page++) {
      const query = `event=workflow_dispatch&per_page=100&page=${page}`;
      const result = await github(`${root}/actions/workflows/${workflow}/runs?${query}`);
      for (const run of result.workflow_runs) {
        const id = run.display_title.startsWith(runName) && run.display_title.slice(runName.length);
        if (known.has(id) && run.id > (runs.get(id)?.id ?? 0)) runs.set(id, run);
      }
      if (runs.size === known.size || result.workflow_runs.length < 100) return runs;
    }
  } catch {
    return null;
  }
  return runs;
}

function newestFirst(id) {
  return (left, right) => (right.created_at ?? "").localeCompare(left.created_at ?? "") ||
    right[id].localeCompare(left[id]);
}

export async function workspaceSnapshot(github, state, repo, config) {
  const records = await stateRecords(github, state);
  const inbox = records.get("inbox.json") ?? {cases: []};
  const worker = records.get("worker.json") ?? {};
  const requests = [...records].filter(([path]) => path.startsWith("queue/"))
    .map(([, request]) => requestView(records, request, repo)).sort(newestFirst("id"));
  return {
    ...inbox, requests, worker, project_url: config.project_url,
    batches: await pendingBatches(github, state, repo, records), last_check_in: worker.last_check_in,
  };
}
