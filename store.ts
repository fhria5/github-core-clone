// The forge's in-memory store: repositories, git objects, issues, pull
// requests, labels and comments. One process, one store, shared by the REST
// v3, GraphQL v4, MCP and git smart-HTTP surfaces, so a change made on any
// surface reads back identically on the others.
//
// Determinism: no wall clock and no unseeded randomness anywhere in this
// file. Every timestamp comes from MAKEFUN_TRIAL_NOW (or a fixed fallback)
// plus a monotonic counter, so two runs on the same instance produce the
// same object ids and the same replies.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

/** The login the trial's bearer token names (the sealed scenario's viewer). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** The SHA-1 git object id of `type` + `data` ("<type> <len>\0<data>"). */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into entries (mode, name, 20-byte oid). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/**
 * Compare two tree entry names the way git sorts them: directory names sort
 * as if they had a trailing slash.
 */
function treeNameKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's raw bytes from entries (sorted git-style). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeNameKey(a);
    const kb = treeNameKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's raw bytes. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's raw bytes. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) out += `parent ${parent}\n`;
  out += `author ${fields.author}\n`;
  out += `committer ${fields.committer}\n`;
  out += `\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's raw bytes. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// Issues, pull requests, comments
// ---------------------------------------------------------------------------

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  numberSeq: number;
}

/** Opaque, stable Relay-style global ids (base64 of a typed key). */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoIdSeq = 1;
  private issueIdSeq = 1;
  private commentIdSeq = 1;
  private pullIdSeq = 1;
  private commitCounter = 0;
  private readonly trialEpochSec: number;
  private readonly trialNowIso: string;

  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = raw === '' ? NaN : Date.parse(raw) / 1000;
    this.trialEpochSec = Number.isFinite(parsed) ? Math.floor(parsed) : 1700000000;
    this.trialNowIso = Number.isFinite(parsed)
      ? new Date(this.trialEpochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      : '2026-11-14T06:30:00Z';
  }

  /** The fixed "now" every created_at / merged_at carries (deterministic). */
  nowIso(): string {
    return this.trialNowIso;
  }

  /** A distinct commit timestamp: trial epoch + a monotonic counter. */
  nextCommitTimestamp(): number {
    const ts = this.trialEpochSec + this.commitCounter;
    this.commitCounter += 1;
    return ts;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.repoIdSeq,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: this.trialNowIso,
      updatedAt: this.trialNowIso,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      numberSeq: 1,
    };
    this.repoIdSeq += 1;
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  nextIssueId(): number {
    const id = this.issueIdSeq;
    this.issueIdSeq += 1;
    return id;
  }

  nextCommentId(): number {
    const id = this.commentIdSeq;
    this.commentIdSeq += 1;
    return id;
  }

  nextPullId(): number {
    const id = this.pullIdSeq;
    this.pullIdSeq += 1;
    return id;
  }

  // ------------------------------------------------------------- git objects

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** All object ids reachable from `tips` (commits, trees, blobs, tags). */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    if (ancestor === ZERO_OID) return true;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /** The first common ancestor commit of two commits, or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stackA.push(parent);
    }
    const stackB = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const oid = stackB.pop()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stackB.push(parent);
    }
    return null;
  }

  /** The commit object at a ref, or null when the ref is missing/not a commit. */
  refCommit(repo: Repo, ref: string): { oid: string; view: CommitView } | null {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return null;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return { oid, view: parseCommit(object.data) };
  }

  /** The commit object for an oid (following an annotated tag once). */
  commitOf(repo: Repo, oid: string): { oid: string; view: CommitView } | null {
    const object = repo.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      return this.commitOf(repo, target);
    }
    if (object.type !== 'commit') return null;
    return { oid, view: parseCommit(object.data) };
  }

  /** The full path -> {oid, mode} file map of a tree, recursively. */
  fileMap(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a file map; returns the root tree oid. */
  buildTreeFromMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object (author/committer: the token owner) and store it. */
  createCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const ts = this.nextCommitTimestamp();
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
    const data = buildCommit({
      tree: treeOid,
      parents,
      author: identity,
      committer: identity,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** The history of a ref, newest first (walk first-parent chains fully). */
  history(repo: Repo, ref: string, limit = 1000): { sha: string; view: CommitView }[] {
    const tip = repo.refs.get(ref);
    if (tip === undefined) return [];
    const out: { sha: string; view: CommitView }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const found = this.commitOf(repo, oid);
      if (found === null) continue;
      out.push({ sha: found.oid, view: found.view });
      for (const parent of found.view.parents) stack.push(parent);
    }
    return out;
  }

  /** Peel a tag object to its commit oid (or return the oid unchanged). */
  peelToCommit(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      return this.peelToCommit(repo, parseTag(object.data).object);
    }
    return oid;
  }

  // ------------------------------------------------------------- lookups

  /** Short alias: the repo at owner/name, or undefined. */
  repo(owner: string, name: string): Repo | undefined {
    return this.getRepo(owner, name);
  }

  /** Short alias: every repo owned by `owner`. */
  reposOf(owner: string): Repo[] {
    return this.listRepos(owner);
  }

  /** The repo with this numeric id, or undefined. */
  repoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  /** The history from a commit oid (not a ref name), newest first. */
  historyFrom(repo: Repo, tip: string, limit = 1000): { oid: string; view: CommitView }[] {
    const out: { oid: string; view: CommitView }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const found = this.commitOf(repo, oid);
      if (found === null) continue;
      out.push({ oid: found.oid, view: found.view });
      for (const parent of found.view.parents) stack.push(parent);
    }
    return out;
  }

  /** The full path -> blob oid file map at a commit oid (empty when unknown). */
  fileMapAt(repo: Repo, tip: string): Map<string, string> {
    const found = this.commitOf(repo, tip);
    if (found === null) return new Map();
    const raw = this.fileMap(repo, found.view.tree);
    const out = new Map<string, string>();
    for (const [path, entry] of raw) out.set(path, entry.oid);
    return out;
  }

  // ------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  // ------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
    const number = repo.numberSeq;
    repo.numberSeq += 1;
    const issue: Issue = {
      id: this.nextIssueId(),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq: number,
      createdAt: this.nowIso(),
      updatedAt: this.nowIso(),
      closedAt: null,
      comments: [],
    };
    repo.issues.set(number, issue);
    repo.updatedAt = this.nowIso();
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: this.nextCommentId(), body, createdAt: this.nowIso(), updatedAt: this.nowIso() };
    issue.comments.push(comment);
    issue.updatedAt = this.nowIso();
    return comment;
  }

  // ------------------------------------------------------------- pull requests

  createPullRequest(repo: Repo, head: string, base: string, title: string, body: string): PullRequest {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined) throw new Error(`Validation Failed: head branch "${head}" does not exist`);
    if (baseSha === undefined) throw new Error(`Validation Failed: base branch "${base}" does not exist`);
    for (const existing of repo.pulls.values()) {
      if (existing.headRef === head && existing.baseRef === base && existing.state === 'open' && !existing.merged) {
        throw new Error('Validation Failed: a pull request already exists for these branches');
      }
    }
    const number = repo.numberSeq;
    repo.numberSeq += 1;
    const pr: PullRequest = {
      id: this.nextPullId(),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      seq: number,
      createdAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    repo.pulls.set(number, pr);
    repo.updatedAt = this.nowIso();
    return pr;
  }

  /**
   * The three-way merge of a pull request: files changed on the head side
   * over the merge base, applied onto the base tip. A file changed on both
   * sides to different content is a conflict.
   */
  mergeCheck(repo: Repo, pr: PullRequest): { conflict: boolean; tree: Map<string, string>; conflictPaths: string[] } {
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseMap = base === null ? new Map<string, string>() : this.fileMapAt(repo, base);
    const headMap = this.fileMapAt(repo, headTip);
    const tipMap = this.fileMapAt(repo, baseTip);
    const tree = new Map(tipMap);
    const conflictPaths: string[] = [];
    const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
    for (const path of paths) {
      const inBase = baseMap.get(path);
      const inHead = headMap.get(path);
      const inTip = tipMap.get(path);
      const headChanged = inHead !== inBase;
      const tipChanged = inTip !== inBase;
      if (headChanged && tipChanged && inHead !== inTip) {
        conflictPaths.push(path);
        continue;
      }
      if (headChanged) {
        if (inHead === undefined) tree.delete(path);
        else tree.set(path, inHead);
      }
    }
    return { conflict: conflictPaths.length > 0, tree, conflictPaths };
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePullRequest(repo: Repo, pr: PullRequest): { sha: string } {
    if (pr.merged) throw new Error('Pull request is already merged');
    if (pr.state !== 'open') throw new Error('Pull request is closed');
    const check = this.mergeCheck(repo, pr);
    if (check.conflict) throw new Error(`Merge conflict: ${check.conflictPaths.join(', ')}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    const entries = new Map<string, { oid: string; mode: string }>();
    for (const [path, oid] of check.tree) entries.set(path, { oid, mode: '100644' });
    const treeOid = this.buildTreeFromMap(repo, entries);
    const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}`;
    const sha = this.createCommit(repo, treeOid, [baseTip], message);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = this.nowIso();
    pr.mergeCommitSha = sha;
    pr.updatedAt = this.nowIso();
    repo.updatedAt = this.nowIso();
    return { sha };
  }

  /** The changed files of a pull request: merge-base tree vs head tree. */
  diffFiles(repo: Repo, pr: PullRequest): Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> {
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseMap = base === null ? new Map<string, string>() : this.fileMapAt(repo, base);
    const headMap = this.fileMapAt(repo, headTip);
    const out: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
    for (const path of [...paths].sort()) {
      const inBase = baseMap.get(path);
      const inHead = headMap.get(path);
      if (inBase === inHead) continue;
      const oldData = inBase === undefined ? null : repo.objects.get(inBase)?.data ?? null;
      const newData = inHead === undefined ? null : repo.objects.get(inHead)?.data ?? null;
      const { additions, deletions } = lineDiff(oldData, newData);
      out.push({
        filename: path,
        status: inBase === undefined ? 'added' : inHead === undefined ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return out;
  }
}

/** Line counts of a simple LCS diff (null = file absent). */
function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  // Drop the empty tail element a trailing newline produces.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: n - common, deletions: m - common };
}
