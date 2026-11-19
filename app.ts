// The HTTP server: routing, the REST v3 surface, and dispatch to the git
// smart-HTTP, GraphQL and MCP modules. One shared in-memory store drives
// every surface.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { executeGraphQL } from './graphql.ts';
import { gitNotFound, handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { handleMcp } from './mcp.ts';
import {
  VIEWER_LOGIN,
  hashObject,
  type Repo,
  type Store,
} from './store.ts';
import { commentView, issueView, labelView, prView, repoView, userView } from './views.ts';

/** "Name <email> epoch tz" -> {name, email, date} for REST commit views. */
function parseIdentity(raw: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(raw.trim());
  if (match === null) return { name: raw, email: '', date: '' };
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(Number.parseInt(match[3]!, 10) * 1000).toISOString(),
  };
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number, extra?: Record<string, string>): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...extra });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface RequestContext {
  store: Store;
  token: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  bodyJson: unknown;
  bodyJsonOk: boolean;
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

/** Paginate `items` by the request's per_page/page, setting a Link header. */
function paginate<T>(ctx: RequestContext, items: readonly T[]): T[] {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(Math.max(perPageRaw, 1), 100) : 30;
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(pageRaw, 1) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (page < totalPages) {
    const base = `${originOf(ctx.req)}${ctx.url.pathname}`;
    const next = `${base}?per_page=${perPage}&page=${page + 1}`;
    const last = `${base}?per_page=${perPage}&page=${totalPages}`;
    ctx.res.setHeader('link', `<${next}>; rel="next", <${last}>; rel="last"`);
  }
  return slice;
}

/** The repo at /repos/{owner}/{name}, or null (unknown owner is a 404, never a 403). */
function repoOf(ctx: RequestContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.repo(owner, name) ?? null;
}

function parseNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

// ---------------------------------------------------------------------------
// REST: repos, branches, commits, contents
// ---------------------------------------------------------------------------

/** GitHub's REST API presents a commit message without the trailing newline
 * that the on-disk object bytes carry (the bytes themselves keep it, so a
 * real git client still verifies the commit hash). */
function displayMessage(message: string): string {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

function listRepos(ctx: RequestContext): void {
  const repos = ctx.store.reposOf(VIEWER_LOGIN).sort((a, b) => a.id - b.id);
  const page = paginate(ctx, repos);
  sendJson(ctx.res, 200, page.map((repo) => repoView(repo)));
}

function createRepo(ctx: RequestContext): void {
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  const name = body.name;
  if (typeof name !== 'string' || name === '') {
    sendJson(ctx.res, 422, { message: 'Validation Failed: name is required' });
    return;
  }
  if (ctx.store.repo(VIEWER_LOGIN, name) !== undefined) {
    sendJson(ctx.res, 422, { message: 'Validation Failed: name already exists on this account' });
    return;
  }
  const repo = ctx.store.createRepo(
    name,
    typeof body.description === 'string' ? body.description : '',
    body.private === true,
  );
  sendJson(ctx.res, 201, repoView(repo));
}

function getRepo(ctx: RequestContext, repo: Repo): void {
  const view = repoView(repo) as Record<string, unknown>;
  view.permissions = { admin: true, maintain: true, push: true, triage: true, pull: true };
  sendJson(ctx.res, 200, view);
}

function patchRepo(ctx: RequestContext, repo: Repo): void {
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  repo.updatedAt = ctx.store.nowIso();
  sendJson(ctx.res, 200, repoView(repo));
}

function deleteRepo(ctx: RequestContext, repo: Repo): void {
  ctx.store.deleteRepo(repo.owner, repo.name);
  sendEmpty(ctx.res, 204);
}

function listBranches(ctx: RequestContext, repo: Repo): void {
  const branches: Array<Record<string, unknown>> = [];
  for (const name of [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort()) {
    const branch = name.slice('refs/heads/'.length);
    const sha = repo.refs.get(name)!;
    branches.push({
      name: branch,
      commit: { sha, url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
      protected: false,
    });
  }
  sendJson(ctx.res, 200, branches);
}

function getBranch(ctx: RequestContext, repo: Repo, branch: string): void {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    notFound(ctx.res, 'Branch not found');
    return;
  }
  sendJson(ctx.res, 200, {
    name: branch,
    commit: { sha, url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  });
}

function listCommits(ctx: RequestContext, repo: Repo): void {
  const ref = ctx.query.get('sha') ?? repo.defaultBranch;
  let tip: string | undefined;
  if (/^[0-9a-f]{40}$/.test(ref)) tip = repo.objects.has(ref) ? ref : undefined;
  else tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  if (tip === undefined) {
    sendJson(ctx.res, 200, []);
    return;
  }
  const history = ctx.store.historyFrom(repo, tip);
  const page = paginate(ctx, history);
  const entries = page.map((entry) => {
    const author = parseIdentity(entry.view.author);
    const committer = parseIdentity(entry.view.committer);
    return {
      sha: entry.oid,
      node_id: `C_${entry.oid}`,
      commit: {
        message: displayMessage(entry.view.message),
        author,
        committer,
        tree: { sha: entry.view.tree },
        url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${entry.oid}`,
        comment_count: 0,
      },
      author: userView(author.name === 'ada iversen' ? VIEWER_LOGIN : author.name),
      committer: userView(committer.name === 'ada iversen' ? VIEWER_LOGIN : committer.name),
      parents: entry.view.parents.map((parent) => ({ sha: parent, url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
      url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${entry.oid}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${entry.oid}`,
    };
  });
  sendJson(ctx.res, 200, entries);
}

function getRef(ctx: RequestContext, repo: Repo, branch: string): void {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    notFound(ctx.res, 'Reference does not exist');
    return;
  }
  sendJson(ctx.res, 200, {
    ref: `refs/heads/${branch}`,
    node_id: `R_${sha}`,
    url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch}`,
    object: { sha, type: 'commit', url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
  });
}

function createRef(ctx: RequestContext, repo: Repo): void {
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  const ref = body.ref;
  const sha = body.sha;
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
    sendJson(ctx.res, 422, { message: 'Validation Failed: ref must start with refs/' });
    return;
  }
  if (typeof sha !== 'string' || !repo.objects.has(sha)) {
    sendJson(ctx.res, 422, { message: 'Validation Failed: sha does not exist' });
    return;
  }
  if (repo.refs.has(ref)) {
    sendJson(ctx.res, 422, { message: 'Validation Failed: Reference already exists' });
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(ctx.res, 201, {
    ref,
    node_id: `R_${sha}`,
    url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace('refs/', '')}`,
    object: { sha, type: 'commit', url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
  });
}

/** Resolve a contents ref (?ref= branch | oid) to a tip commit oid. */
function contentsTip(ctx: RequestContext, repo: Repo): string | undefined {
  const ref = ctx.query.get('ref');
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : undefined;
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
}

function fileContentView(ctx: RequestContext, repo: Repo, path: string, blobSha: string, blob: Buffer): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: blob.length,
    name: path.split('/').at(-1) ?? path,
    path,
    content: blob.toString('base64'),
    sha: blobSha,
    url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/main/${path}`,
    git_url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`,
    download_url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    _links: { self: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, git: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`, html: `https://example.invalid/${repo.owner}/${repo.name}/blob/main/${path}` },
  };
}

function getContents(ctx: RequestContext, repo: Repo, path: string): void {
  const tip = contentsTip(ctx, repo);
  if (tip === undefined) {
    notFound(ctx.res, 'Not Found');
    return;
  }
  const map = ctx.store.fileMapAt(repo, tip);
  const direct = map.get(path);
  if (direct !== undefined) {
    const object = repo.objects.get(direct);
    if (object === undefined || object.type !== 'blob') {
      notFound(ctx.res, 'Not Found');
      return;
    }
    sendJson(ctx.res, 200, fileContentView(ctx, repo, path, direct, object.data));
    return;
  }
  // Directory listing: immediate children of `path` (or the repo root).
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { kind: 'file' | 'dir'; blobSha?: string; subpaths?: string[] }>();
  for (const [filePath, blobSha] of map) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { kind: 'file', blobSha });
    else children.set(rest.slice(0, slash), { kind: 'dir' });
  }
  if (children.size === 0) {
    notFound(ctx.res, 'Not Found');
    return;
  }
  const entries: Array<Record<string, unknown>> = [];
  for (const name of [...children.keys()].sort()) {
    const child = children.get(name)!;
    const childPath = prefix === '' ? name : `${prefix}${name}`;
    if (child.kind === 'file') {
      entries.push({
        type: 'file',
        size: repo.objects.get(child.blobSha!)?.data.length ?? 0,
        name,
        path: childPath,
        sha: child.blobSha,
        url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
        html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/main/${childPath}`,
        git_url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${child.blobSha}`,
        download_url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
      });
    } else {
      // The subtree oid, for a faithful directory entry.
      const sub = new Map<string, { oid: string; mode: string }>();
      for (const [filePath, blobSha] of map) {
        if (filePath.startsWith(`${childPath}/`)) sub.set(filePath.slice(childPath.length + 1), { oid: blobSha, mode: '100644' });
      }
      const oid = ctx.store.buildTreeFromMap(repo, sub);
      entries.push({
        type: 'dir',
        size: 0,
        name,
        path: childPath,
        sha: oid,
        url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
        html_url: `https://example.invalid/${repo.owner}/${repo.name}/tree/main/${childPath}`,
        git_url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${oid}`,
        download_url: null,
      });
    }
  }
  sendJson(ctx.res, 200, entries);
}

function putContents(ctx: RequestContext, repo: Repo, path: string): void {
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  const content = body.content;
  if (typeof content !== 'string') {
    sendJson(ctx.res, 422, { message: 'Validation Failed: content is required' });
    return;
  }
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined && branch !== repo.defaultBranch) {
    // A new branch starts at the default tip.
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const map = tip === undefined ? new Map<string, string>() : ctx.store.fileMapAt(repo, tip);
  const existing = map.get(path);
  const sha = body.sha;
  if (typeof sha === 'string') {
    if (existing === undefined || existing.toLowerCase() !== sha.toLowerCase()) {
      sendJson(ctx.res, 409, { message: 'sha does not match the current file' });
      return;
    }
  }
  const bytes = Buffer.from(content, 'base64');
  const blobSha = hashObject('blob', bytes);
  repo.objects.set(blobSha, { type: 'blob', data: bytes });
  const nextMap = new Map(map);
  nextMap.set(path, blobSha);
  const entries = new Map<string, { oid: string; mode: string }>();
  for (const [filePath, oid] of nextMap) entries.set(filePath, { oid, mode: '100644' });
  const treeOid = ctx.store.buildTreeFromMap(repo, entries);
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  const commitSha = ctx.store.createCommit(repo, treeOid, tip === undefined ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = ctx.store.nowIso();
  const author = parseIdentity(ctx.store.commitOf(repo, commitSha)?.view.author ?? '');
  sendJson(ctx.res, existing === undefined ? 201 : 200, {
    content: fileContentView(ctx, repo, path, blobSha, bytes),
    commit: {
      sha: commitSha,
      node_id: `C_${commitSha}`,
      message,
      author,
      committer: author,
      parents: tip === undefined ? [] : [{ sha: tip }],
      url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitSha}`,
    },
  });
}

function deleteContents(ctx: RequestContext, repo: Repo, path: string): void {
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    notFound(ctx.res, 'Not Found');
    return;
  }
  const map = ctx.store.fileMapAt(repo, tip);
  const existing = map.get(path);
  if (existing === undefined) {
    notFound(ctx.res, 'Not Found');
    return;
  }
  const sha = body.sha;
  if (typeof sha === 'string' && existing.toLowerCase() !== sha.toLowerCase()) {
    sendJson(ctx.res, 409, { message: 'sha does not match the current file' });
    return;
  }
  const nextMap = new Map(map);
  nextMap.delete(path);
  const entries = new Map<string, { oid: string; mode: string }>();
  for (const [filePath, oid] of nextMap) entries.set(filePath, { oid, mode: '100644' });
  const treeOid = ctx.store.buildTreeFromMap(repo, entries);
  const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
  const commitSha = ctx.store.createCommit(repo, treeOid, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = ctx.store.nowIso();
  const author = parseIdentity(ctx.store.commitOf(repo, commitSha)?.view.author ?? '');
  sendJson(ctx.res, 200, { commit: { sha: commitSha, message, author, committer: author, parents: [{ sha: tip }] } });
}

// ---------------------------------------------------------------------------
// REST: labels, issues, comments, pulls
// ---------------------------------------------------------------------------

function listLabels(ctx: RequestContext, repo: Repo): void {
  const labels = [...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name));
  sendJson(ctx.res, 200, labels.map((label) => labelView(repo, label)));
}

function createLabel(ctx: RequestContext, repo: Repo): void {
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  const name = body.name;
  if (typeof name !== 'string' || name === '') {
    sendJson(ctx.res, 422, { message: 'Validation Failed: name is required' });
    return;
  }
  if (repo.labels.has(name)) {
    sendJson(ctx.res, 422, { message: 'Validation Failed: label already exists' });
    return;
  }
  const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : '000000';
  const label = ctx.store.createLabel(repo, name, color);
  sendJson(ctx.res, 201, labelView(repo, label));
}

function listIssues(ctx: RequestContext, repo: Repo): void {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => {
    const byTime = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    const cmp = byTime !== 0 ? byTime : a.number - b.number;
    return direction === 'asc' ? cmp : -cmp;
  });
  const page = paginate(ctx, issues);
  sendJson(ctx.res, 200, page.map((issue) => issueView(repo, issue)));
}

function createIssue(ctx: RequestContext, repo: Repo): void {
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  const title = body.title;
  if (typeof title !== 'string' || title === '') {
    sendJson(ctx.res, 422, { message: 'Validation Failed: title is required' });
    return;
  }
  const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  for (const name of labels) {
    if (!repo.labels.has(name)) {
      sendJson(ctx.res, 422, { message: `Validation Failed: label "${name}" does not exist` });
      return;
    }
  }
  const issue = ctx.store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
  sendJson(ctx.res, 201, issueView(repo, issue));
}

function getIssue(ctx: RequestContext, repo: Repo, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(ctx.res, 'Not Found');
    return;
  }
  sendJson(ctx.res, 200, issueView(repo, issue));
}

function patchIssue(ctx: RequestContext, repo: Repo, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(ctx.res, 'Not Found');
    return;
  }
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? ctx.store.nowIso() : null;
  }
  if (Array.isArray(body.labels)) {
    const labels = body.labels.filter((entry): entry is string => typeof entry === 'string');
    for (const name of labels) {
      if (!repo.labels.has(name)) {
        sendJson(ctx.res, 422, { message: `Validation Failed: label "${name}" does not exist` });
        return;
      }
    }
    issue.labels = labels;
  }
  issue.updatedAt = ctx.store.nowIso();
  sendJson(ctx.res, 200, issueView(repo, issue));
}

function listComments(ctx: RequestContext, repo: Repo, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(ctx.res, 'Not Found');
    return;
  }
  const page = paginate(ctx, issue.comments);
  sendJson(ctx.res, 200, page.map((comment) => commentView(repo, issue, comment)));
}

function createComment(ctx: RequestContext, repo: Repo, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(ctx.res, 'Not Found');
    return;
  }
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  if (typeof body.body !== 'string' || body.body === '') {
    sendJson(ctx.res, 422, { message: 'Validation Failed: body is required' });
    return;
  }
  const comment = ctx.store.addComment(repo, issue, body.body);
  sendJson(ctx.res, 201, commentView(repo, issue, comment));
}

function listPulls(ctx: RequestContext, repo: Repo): void {
  const state = ctx.query.get('state') ?? 'open';
  let prs = [...repo.pulls.values()];
  if (state === 'open') prs = prs.filter((pr) => pr.state === 'open' && !pr.merged);
  else if (state === 'closed') prs = prs.filter((pr) => pr.state === 'closed' || pr.merged);
  prs.sort((a, b) => b.number - a.number);
  const page = paginate(ctx, prs);
  sendJson(ctx.res, 200, page.map((pr) => prView(ctx.store, repo, pr)));
}

function createPull(ctx: RequestContext, repo: Repo): void {
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  const head = body.head;
  const base = body.base;
  const title = body.title;
  if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string' || title === '') {
    sendJson(ctx.res, 422, { message: 'Validation Failed: head, base and title are required' });
    return;
  }
  if (repo.refs.get(`refs/heads/${head}`) === undefined) {
    sendJson(ctx.res, 422, { message: `Validation Failed: head branch "${head}" does not exist` });
    return;
  }
  if (repo.refs.get(`refs/heads/${base}`) === undefined) {
    sendJson(ctx.res, 422, { message: `Validation Failed: base branch "${base}" does not exist` });
    return;
  }
  try {
    const pr = ctx.store.createPullRequest(repo, head, base, title, typeof body.body === 'string' ? body.body : '');
    sendJson(ctx.res, 201, prView(ctx.store, repo, pr));
  } catch (err) {
    sendJson(ctx.res, 422, { message: err instanceof Error ? err.message : 'Validation Failed' });
  }
}

function getPull(ctx: RequestContext, repo: Repo, number: number): void {
  const pr = repo.pulls.get(number);
  if (pr === undefined) {
    notFound(ctx.res, 'Not Found');
    return;
  }
  sendJson(ctx.res, 200, prView(ctx.store, repo, pr));
}

function listPullFiles(ctx: RequestContext, repo: Repo, number: number): void {
  const pr = repo.pulls.get(number);
  if (pr === undefined) {
    notFound(ctx.res, 'Not Found');
    return;
  }
  let files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  try {
    files = ctx.store.diffFiles(repo, pr);
  } catch {
    files = [];
  }
  const baseMap = ctx.store.fileMapAt(repo, ctx.store.mergeBase(repo, repo.refs.get(`refs/heads/${pr.base}`) ?? '', repo.refs.get(`refs/heads/${pr.head}`) ?? '') ?? '');
  const headMap = ctx.store.fileMapAt(repo, repo.refs.get(`refs/heads/${pr.head}`) ?? '');
  const entries = files.map((file) => {
    const sha = file.status === 'removed' ? baseMap.get(file.filename) ?? '' : headMap.get(file.filename) ?? '';
    return {
      sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      blob_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${pr.headRef}/${file.filename}`,
      raw_url: `https://example.invalid/${repo.owner}/${repo.name}/raw/${pr.headRef}/${file.filename}`,
      contents_url: `${originOf(ctx.req)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${file.filename}`,
    };
  });
  sendJson(ctx.res, 200, entries);
}

function mergePull(ctx: RequestContext, repo: Repo, number: number): void {
  const pr = repo.pulls.get(number);
  if (pr === undefined) {
    notFound(ctx.res, 'Not Found');
    return;
  }
  try {
    const result = ctx.store.mergePullRequest(repo, pr);
    sendJson(ctx.res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Merge failed';
    const status = /conflict/i.test(message) ? 405 : 422;
    sendJson(ctx.res, status, { message });
  }
}

// ---------------------------------------------------------------------------
// REST dispatch
// ---------------------------------------------------------------------------

function handleRest(ctx: RequestContext): void {
  const { method } = ctx.req;
  const s = ctx.segments; // after /api/v3
  // GET /api/v3/ and GET /api/v3/meta are public.
  if (s.length === 0 && method === 'GET') {
    sendJson(ctx.res, 200, {
      current_user_url: `${originOf(ctx.req)}/api/v3/user`,
      repository_url: `${originOf(ctx.req)}/api/v3/repos/{owner}/{repo}`,
      user_url: `${originOf(ctx.req)}/api/v3/users/{username}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (s.length === 1 && s[0] === 'meta' && method === 'GET') {
    sendJson(ctx.res, 200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      hooks: [],
      git: [],
      pages: [],
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  // Everything else needs the bearer token.
  if (ctx.token !== '' && ctx.req.headers.authorization !== `Bearer ${ctx.token}`) {
    unauthorized(ctx.res);
    return;
  }
  if (s.length === 1 && s[0] === 'user' && method === 'GET') {
    sendJson(ctx.res, 200, { ...userView(VIEWER_LOGIN), name: 'ada iversen', email: 'adaiversen@example.invalid' });
    return;
  }
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      listRepos(ctx);
      return;
    }
    if (method === 'POST') {
      createRepo(ctx);
      return;
    }
  }
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = decodeURIComponent(s[1]!);
    const name = decodeURIComponent(s[2]!);
    const repo = repoOf(ctx, owner, name);
    if (repo === null) {
      notFound(ctx.res);
      return;
    }
    const rest = s.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') {
        getRepo(ctx, repo);
        return;
      }
      if (method === 'PATCH') {
        patchRepo(ctx, repo);
        return;
      }
      if (method === 'DELETE') {
        deleteRepo(ctx, repo);
        return;
      }
    }
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      listBranches(ctx, repo);
      return;
    }
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      getBranch(ctx, repo, decodeURIComponent(rest[1]!));
      return;
    }
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      listCommits(ctx, repo);
      return;
    }
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      createRef(ctx, repo);
      return;
    }
    if (rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && method === 'GET') {
      getRef(ctx, repo, decodeURIComponent(rest[3]!));
      return;
    }
    if (rest.length >= 2 && rest[0] === 'contents') {
      const path = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
      if (method === 'GET') {
        getContents(ctx, repo, path);
        return;
      }
      if (method === 'PUT') {
        putContents(ctx, repo, path);
        return;
      }
      if (method === 'DELETE') {
        deleteContents(ctx, repo, path);
        return;
      }
    }
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') {
        listLabels(ctx, repo);
        return;
      }
      if (method === 'POST') {
        createLabel(ctx, repo);
        return;
      }
    }
    if (rest.length === 1 && rest[0] === 'issues') {
      if (method === 'GET') {
        listIssues(ctx, repo);
        return;
      }
      if (method === 'POST') {
        createIssue(ctx, repo);
        return;
      }
    }
    if (rest.length === 2 && rest[0] === 'issues') {
      const number = parseNumber(rest[1]!);
      if (number !== null) {
        if (method === 'GET') {
          getIssue(ctx, repo, number);
          return;
        }
        if (method === 'PATCH') {
          patchIssue(ctx, repo, number);
          return;
        }
      }
    }
    if (rest.length === 3 && rest[0] === 'issues' && rest[2] === 'comments') {
      const number = parseNumber(rest[1]!);
      if (number !== null) {
        if (method === 'GET') {
          listComments(ctx, repo, number);
          return;
        }
        if (method === 'POST') {
          createComment(ctx, repo, number);
          return;
        }
      }
    }
    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'GET') {
        listPulls(ctx, repo);
        return;
      }
      if (method === 'POST') {
        createPull(ctx, repo);
        return;
      }
    }
    if (rest.length === 2 && rest[0] === 'pulls') {
      const number = parseNumber(rest[1]!);
      if (number !== null && method === 'GET') {
        getPull(ctx, repo, number);
        return;
      }
    }
    if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'files' && method === 'GET') {
      const number = parseNumber(rest[1]!);
      if (number !== null) {
        listPullFiles(ctx, repo, number);
        return;
      }
    }
    if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'merge' && method === 'PUT') {
      const number = parseNumber(rest[1]!);
      if (number !== null) {
        mergePull(ctx, repo, number);
        return;
      }
    }
  }
  notFound(ctx.res);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createApp(store: Store): ReturnType<typeof createServer> {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const segments = url.pathname.split('/').filter((part) => part !== '');
      if (method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
        const owner = decodeURIComponent(segments[0]!);
        const repoName = decodeURIComponent(segments[1]!.slice(0, -4));
        const rest = segments.slice(2);
        if (token !== '' && req.headers.authorization !== `Bearer ${token}`) {
          unauthorized(res);
          return;
        }
        const repo = owner === VIEWER_LOGIN ? store.repo(owner, repoName) : undefined;
        if (repo === undefined) {
          gitNotFound(res);
          return;
        }
        if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
          const service = url.searchParams.get('service') ?? '';
          handleInfoRefs(store, repo, service, req, res);
          return;
        }
        if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
          const body = await readBody(req);
          handleUploadPack(store, repo, req, body, res);
          return;
        }
        if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
          const body = await readBody(req);
          handleReceivePack(store, repo, body, res);
          return;
        }
        notFound(res);
        return;
      }
      // GraphQL.
      if (url.pathname === '/api/graphql') {
        if (method !== 'POST') {
          notFound(res);
          return;
        }
        if (token !== '' && req.headers.authorization !== `Bearer ${token}`) {
          unauthorized(res);
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { errors: [{ message: 'GraphQL body is not valid JSON.' }] });
          return;
        }
        const answer = Array.isArray(parsed)
          ? parsed.map((entry) => executeGraphQL(store, (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown }))
          : executeGraphQL(store, (parsed ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown });
        sendJson(res, 200, answer);
        return;
      }
      // MCP.
      if (url.pathname === '/mcp') {
        if (token !== '' && req.headers.authorization !== `Bearer ${token}`) {
          unauthorized(res);
          return;
        }
        if (method === 'DELETE') {
          sendEmpty(res, 204);
          return;
        }
        if (method !== 'POST') {
          notFound(res);
          return;
        }
        const body = await readBody(req);
        const outcome = handleMcp(store, body);
        if (outcome.body === null) {
          res.writeHead(outcome.status, { 'content-type': outcome.contentType, 'x-github-request-id': nextRequestId() });
          res.end();
        } else {
          const bytes = Buffer.from(outcome.body, 'utf8');
          res.writeHead(outcome.status, { 'content-type': outcome.contentType, 'content-length': bytes.length, 'x-github-request-id': nextRequestId() });
          res.end(bytes);
        }
        return;
      }
      // REST v3.
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        let bodyJson: unknown;
        let bodyJsonOk = true;
        if (body.length > 0) {
          try {
            bodyJson = JSON.parse(body.toString('utf8'));
          } catch {
            bodyJsonOk = false;
          }
        }
        if (!bodyJsonOk) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const ctx: RequestContext = {
          store,
          token,
          req,
          res,
          url,
          segments: segments.slice(2),
          query: url.searchParams,
          body,
          bodyJson,
          bodyJsonOk,
        };
        handleRest(ctx);
        return;
      }
      notFound(res);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  });
  return server;
}
