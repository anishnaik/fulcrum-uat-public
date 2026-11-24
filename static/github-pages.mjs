import { batchReceipt, workspaceSnapshot } from "./github-state.mjs";

const stateBranch = "fulcrum-state";
const workflow = "fulcrum-enqueue.yml";
const validRepo = /^[a-z\d][a-z\d-]*\/[\w.-]+$/iu;
const validId = /^[a-z0-9_-]{1,80}$/iu;
const validRequest = /^[a-f\d]{32}$/u;
const fullSha = /^[a-f\d]{40}$/u;
const digestPattern = /^[a-f\d]{64}$/u;

function failure(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

function repositoryName(repo) {
  if (typeof repo !== "string" || !validRepo.test(repo) ||
      [".", ".."].includes(repo.split("/")[1])) {
    throw failure("Enter a GitHub repository as owner/name.");
  }
  return repo;
}

function requireId(value, pattern = validId) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw failure("Invalid request or batch identifier.");
  }
  return value;
}

function encodedJson(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

function decodedJson(blob) {
  const bytes = Uint8Array.from(atob(blob.content), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function requestId(repo, batch, caseId) {
  // UUID v5, matching Service._freeze's URL namespace and request key.
  const namespace = Uint8Array.from(
    [0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8],
  );
  const name = new TextEncoder().encode(`github.com/${repo}/${batch}/${caseId}`);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return Array.from(hash.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function githubClient(token, fetchGitHub) {
  return async (path, {method = "GET", data, optional = false, diff = false} = {}) => {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw failure("Invalid GitHub API path.");
    }
    const headers = {
      Accept: diff ? "application/vnd.github.diff" : "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
    };
    if (data !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchGitHub(`https://api.github.com${path}`, {
      method, headers, body: JSON.stringify(data),
      cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
    });
    if (optional && response.status === 404) return null;
    if (response.status === 204) return null;
    if (response.ok) return diff ? response.arrayBuffer() : response.json();
    throw failure(`GitHub ${method} returned ${response.status}. Verify repository access and token permissions.`,
      response.status);
  };
}

function stateAccess(github, repo) {
  const root = `/repos/${repo}`;
  const contents = (path) => `${root}/contents/${path}`;
  const blobs = new Map();

  async function blob(sha) {
    if (blobs.has(sha)) return blobs.get(sha);
    const record = decodedJson(await github(`${root}/git/blobs/${sha}`));
    blobs.set(sha, record);
    if (blobs.size > 1024) blobs.delete(blobs.keys().next().value);
    return record;
  }

  async function read(path) {
    const entry = await github(`${contents(path)}?ref=${stateBranch}`, {optional: true});
    if (!entry) return null;
    return entry.encoding === "base64" ? decodedJson(entry) : blob(entry.sha);
  }

  async function create(path, value) {
    const data = {branch: stateBranch, message: `Record ${path}`, content: encodedJson(value)};
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await github(contents(path), {method: "PUT", data});
        return value;
      } catch (error) {
        if (![409, 422].includes(error.status) || attempt === 7) throw error;
        const existing = await read(path);
        if (existing) return existing;
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    throw failure("State write retry limit exceeded.", 503);
  }

  return {root, blob, read, create};
}

function validateCases(inbox, ids, revisions) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length) {
    throw failure("Select between one and 100 distinct cases.");
  }
  const byId = new Map(inbox.cases.map((record) => [record.id, record]));
  return ids.map((id) => {
    const record = byId.get(id);
    if (!record || !Object.hasOwn(revisions, id) || revisions[id] !== record.revision) {
      throw failure("The inbox changed. Refresh and select the current revisions.", 409);
    }
    if (record.eligible === false) throw failure("Selection contains a case excluded by policy.");
    return record;
  });
}

async function privateRepository(github, repo, write = false) {
  const info = await github(`/repos/${repositoryName(repo)}`);
  if (info.visibility !== "private" || (write && !info.permissions?.push)) {
    throw failure("Fulcrum requires a private repository with the requested access.", 403);
  }
  return info;
}

function route(config, caseId, defaultBranch) {
  const override = Object.hasOwn(config.cases ?? {}, caseId) ? config.cases[caseId] : null;
  if (!override) return {branch: defaultBranch, base: null};
  if (typeof override.branch !== "string" || !override.branch || !fullSha.test(override.base)) {
    throw failure("The case destination needs a branch and a full base commit.");
  }
  return override;
}

function assertFrozen(frozen, batch, ids, revisions, retryOf) {
  if (frozen.batch !== batch || frozen.jobs.length !== ids.length ||
      !frozen.jobs.every((job, index) =>
    job.case_id === ids[index] && job.case.revision === revisions[job.case_id] &&
    job.retry_of === retryOf)) {
    throw failure("This batch key already belongs to a different selection.", 409);
  }
}

async function buildJobs(github, repo, batch, config, cases, parent) {
  const target = config.target;
  const info = await privateRepository(github, target);
  const bases = new Map();
  const jobs = [];
  for (const record of cases) {
    const {branch, base} = route(config, record.id, info.default_branch);
    if (!parent && !bases.has(branch)) {
      const head = await github(`/repos/${target}/branches/${encodeURIComponent(branch)}`);
      bases.set(branch, head.commit.sha);
    }
    if (parent && (parent.target !== target || parent.branch !== branch)) {
      throw failure("The target or case changed. Start a fresh patch request.");
    }
    const pinned = parent?.base ?? bases.get(branch);
    if (!fullSha.test(pinned) || (!parent && base && base !== pinned)) {
      throw failure("The configured branch moved. Confirm the intended base before dispatch.", 409);
    }
    jobs.push({
      id: await requestId(repo, batch, record.id), case_id: record.id,
      case: parent?.case ?? record, target, branch, base: pinned, batch, retry_of: parent?.id ?? null,
    });
  }
  return jobs;
}

function matchesPublishedPull(pull, tip, reviewed) {
  return pull?.head?.sha === reviewed.head &&
    pull?.base?.ref === reviewed.branch &&
    pull?.base?.sha === reviewed.base &&
    tip?.commit?.sha === reviewed.base;
}

async function verifyReceipt(github, receipt, reviewed) {
  const stale = failure("The published pull request no longer matches the reviewed candidate.", 409);
  if (!Number.isSafeInteger(receipt.pr_number) || receipt.pr_number < 1) throw stale;
  await privateRepository(github, reviewed.target);
  const root = `/repos/${reviewed.target}`;
  const endpoint = `${root}/pulls/${receipt.pr_number}`;
  const diff = await github(endpoint, {diff: true, optional: true});
  if (!diff) throw stale;
  const [pull, tip] = await Promise.all([
    github(endpoint, {optional: true}),
    github(`${root}/branches/${encodeURIComponent(reviewed.branch)}`, {optional: true}),
  ]);
  if (!matchesPublishedPull(pull, tip, reviewed) ||
      pull.html_url !== receipt.pr_url || receipt.head !== reviewed.head) throw stale;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", diff));
  const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== reviewed.diff_sha256) throw stale;
  return {...receipt, existing: true};
}

async function publication(github, state, payload) {
  const id = requireId(payload.request_id, validRequest);
  const [request, terminal, pr] = await Promise.all([
    state.read(`queue/${id}.json`), state.read(`reports/${id}.json`), state.read(`prs/${id}.json`),
  ]);
  const report = terminal?.report;
  if (terminal?.status !== "completed" || !report?.diff ||
      !fullSha.test(report.head) || !digestPattern.test(report.diff_sha256)) {
    throw failure("This attempt has no reviewed candidate.");
  }
  if (!request || ["target", "branch", "base"].some((key) => request[key] !== report[key])) {
    throw failure("Reviewed destination differs from the authorized request.");
  }
  const {target, branch, base, head, diff_sha256} = report;
  if (head !== payload.head || diff_sha256 !== payload.diff_sha256) {
    throw failure("The candidate changed. Refresh and review it before publishing.", 409);
  }
  const intent = {request_id: id, target, branch, base, head, diff_sha256};
  if (pr?.pr_url) return verifyReceipt(github, pr, intent);
  const existing = await state.read(`publications/${id}.json`)
    ?? await state.create(`publications/${id}.json`, {...intent, requested_at: new Date().toISOString()});
  if (Object.keys(intent).some((key) => intent[key] !== existing[key])) {
    throw failure("The publication request differs from the reviewed candidate.", 409);
  }
  return {queued: true};
}

export function pagesTransport(ops, token, fetchGitHub = globalThis.fetch) {
  const repo = repositoryName(ops);
  const github = githubClient(token, fetchGitHub);
  const state = stateAccess(github, repo);

  async function dispatch(branch, batch) {
    const result = await github(`${state.root}/actions/workflows/${workflow}/dispatches`, {
      method: "POST", data: {ref: branch, inputs: {batch}},
    });
    return result?.html_url ?? null;
  }

  async function config() {
    const value = await state.read("dispatch.json");
    if (!value) throw failure("No deployment configuration was found. Run fulcrum init.", 404);
    return value;
  }

  async function submit(branch, batch, ids, revisions, parent = null) {
    let frozen = await state.read(`batches/${batch}.json`);
    if (!frozen) {
      const [dispatchConfig, inbox] = await Promise.all([config(), state.read("inbox.json")]);
      const cases = validateCases(inbox ?? {cases: []}, ids, revisions);
      const jobs = await buildJobs(github, repo, batch, dispatchConfig, cases, parent);
      const proposed = {batch, jobs, created_at: new Date().toISOString()};
      frozen = await state.create(`batches/${batch}.json`, proposed);
    }
    assertFrozen(frozen, batch, ids, revisions, parent?.id ?? null);
    return {...batchReceipt(frozen), run_url: await dispatch(branch, batch)};
  }

  async function start(branch, payload) {
    const batch = requireId(payload.batch);
    if (batch.startsWith("retry_")) throw failure("This identifier is reserved for explicit retries.");
    return submit(branch, batch, payload.case_ids, payload.case_revisions ?? {});
  }

  async function retry(branch, payload) {
    const id = requireId(payload.request_id, validRequest);
    const [parent, result] = await Promise.all([
      state.read(`queue/${id}.json`), state.read(`reports/${id}.json`),
    ]);
    if (!parent || !["failed", "interrupted"].includes(result?.status)) {
      throw failure("Only a failed or interrupted attempt can be retried.");
    }
    return submit(branch, `retry_${id}`, [parent.case_id], {
      [parent.case_id]: parent.case.revision,
    }, parent);
  }

  async function redispatch(branch, payload) {
    const batch = requireId(payload.batch);
    const frozen = await state.read(`batches/${batch}.json`);
    if (!frozen) throw failure("Unknown patching batch.", 404);
    const receipt = batchReceipt(frozen);
    const queued = await Promise.all(receipt.request_ids.map((id) => state.read(`queue/${id}.json`)));
    const missing = receipt.request_ids.filter((_, index) => !queued[index]);
    return {
      ...receipt, missing_request_ids: missing,
      run_url: missing.length ? await dispatch(branch, batch) : null,
    };
  }

  const operations = {
    snapshot: async () => workspaceSnapshot(github, state, repo, await config()),
    start,
    retry,
    redispatch,
    "create-pr": (_, payload) => publication(github, state, payload),
  };
  return async (action, payload) => {
    if (!Object.hasOwn(operations, action)) throw failure("Unknown Fulcrum operation.");
    const info = await privateRepository(github, repo, action !== "snapshot");
    return operations[action](info.default_branch, payload);
  };
}
