import { workspaceSnapshot } from "./github-state.mjs";

const stateBranch = "fulcrum-state";
const validRepo = /^[a-z\d][a-z\d-]*\/[\w.-]+$/iu;
const retiredActions = new Set(["start", "retry", "redispatch", "create-pr"]);

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

function decodedJson(record) {
  const bytes = Uint8Array.from(atob(record.content), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function githubClient(token, fetchGitHub) {
  if (!token) throw failure("Enter a GitHub access token.");
  return async (path, {optional = false} = {}) => {
    const response = await fetchGitHub(`https://api.github.com${path}`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
    });
    if (optional && response.status === 404) return null;
    if (response.ok) return response.json();
    throw failure(`GitHub GET returned ${response.status}. Verify repository access and token permissions.`,
      response.status);
  };
}

function stateAccess(github, repo) {
  const root = `/repos/${repo}`;
  const blobs = new Map();

  async function blob(sha) {
    if (blobs.has(sha)) return blobs.get(sha);
    const record = decodedJson(await github(`${root}/git/blobs/${sha}`));
    blobs.set(sha, record);
    if (blobs.size > 1024) blobs.delete(blobs.keys().next().value);
    return record;
  }

  async function config() {
    const entry = await github(`${root}/contents/dispatch.json?ref=${stateBranch}`, {optional: true});
    if (!entry) throw failure("No deployment configuration was found. Run fulcrum init.", 404);
    return entry.encoding === "base64" ? decodedJson(entry) : blob(entry.sha);
  }

  return {root, blob, config};
}

export function pagesTransport(ops, token, fetchGitHub = globalThis.fetch) {
  const repo = repositoryName(ops);
  const github = githubClient(token, fetchGitHub);
  const state = stateAccess(github, repo);

  return async (action) => {
    if (retiredActions.has(action)) throw failure("Patching is paused.", 410);
    if (action !== "snapshot") throw failure("Unknown Fulcrum operation.");
    if ((await github(state.root)).visibility !== "private") {
      throw failure("Fulcrum requires a private operations repository.", 403);
    }
    return workspaceSnapshot(github, state, repo, await state.config());
  };
}
