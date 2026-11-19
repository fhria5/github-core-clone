// The MCP endpoint (POST /mcp): JSON-RPC 2.0 Streamable HTTP.
//
// Two eras are supported, matching the suite's client:
//  - modern (2026-07-28): `server/discover` returns supportedVersions,
//    serverInfo and capabilities; no handshake, no session.
//  - legacy (2025-11-25 and earlier): `initialize` + `notifications/initialized`.
// The tools run against the same in-memory store as REST and GraphQL.

import { VIEWER_LOGIN, type Store } from './store.ts';
import { issueView, prView, repoView } from './views.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The name of the repository.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The owner login; defaults to the authenticated user.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      number: { type: 'integer', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'number'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  };
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function pickArg(args: JsonRecord, ...names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function resolveRepo(store: Store, args: JsonRecord): { owner: string; repo: string } | null {
  const fullName = pickArg(args, 'full_name', 'fullName', 'repo_full_name');
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/', 2);
    if (owner !== undefined && repo !== undefined && owner !== '' && repo !== '') return { owner, repo };
  }
  const owner = pickArg(args, 'owner', 'owner_login', 'login');
  const repo = pickArg(args, 'repo', 'repository', 'repository_name', 'repo_name', 'name');
  if (typeof owner === 'string' && typeof repo === 'string') return { owner, repo };
  return null;
}

function toolResult(data: unknown): JsonRecord {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data, isError: false };
}

function toolError(message: string): JsonRecord {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: JsonRecord): JsonRecord {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tool = TOOLS.find((t) => t.name === name || t.name.replace(/_/g, '') === normalized || normalized.endsWith(t.name.replace(/_/g, '')));
  if (tool === undefined) {
    throw { code: -32602, message: `Unknown tool: ${name}` };
  }
  // Missing required arguments are a tool error, never an exception.
  const missing = tool.required.filter((prop) => {
    if (prop === 'owner' || prop === 'repo') return resolveRepo(store, args) === null;
    return pickArg(args, prop) === undefined;
  });
  if (missing.length > 0) {
    return toolError(`Missing required argument(s): ${missing.join(', ')}`);
  }
  try {
    switch (tool.name) {
      case 'create_repo': {
        const repoName = String(pickArg(args, 'name', 'repo', 'repository'));
        const owner = typeof pickArg(args, 'owner') === 'string' ? String(pickArg(args, 'owner')) : VIEWER_LOGIN;
        if (owner !== VIEWER_LOGIN) return toolError(`Cannot create a repository for owner ${owner}`);
        const description = typeof pickArg(args, 'description') === 'string' ? String(pickArg(args, 'description')) : '';
        const repo = store.createRepo(repoName, description, pickArg(args, 'private') === true);
        return toolResult(repoView(repo));
      }
      case 'get_repo': {
        const target = resolveRepo(store, args)!;
        const repo = store.repo(target.owner, target.repo);
        if (repo === undefined) return toolError(`Repository not found: ${target.owner}/${target.repo}`);
        return toolResult(repoView(repo));
      }
      case 'create_issue': {
        const target = resolveRepo(store, args)!;
        const repo = store.repo(target.owner, target.repo);
        if (repo === undefined) return toolError(`Repository not found: ${target.owner}/${target.repo}`);
        const title = String(pickArg(args, 'title'));
        const body = typeof pickArg(args, 'body', 'description', 'content', 'text') === 'string' ? String(pickArg(args, 'body', 'description', 'content', 'text')) : '';
        const issue = store.createIssue(repo, title, body, []);
        return toolResult(issueView(repo, issue));
      }
      case 'get_issue': {
        const target = resolveRepo(store, args)!;
        const repo = store.repo(target.owner, target.repo);
        const number = Number(pickArg(args, 'number', 'issue_number', 'pull_number'));
        const issue = repo?.issues.get(number);
        if (repo === undefined || issue === undefined) return toolError(`Issue not found: ${target.owner}/${target.repo}#${number}`);
        return toolResult(issueView(repo, issue));
      }
      case 'list_issues': {
        const target = resolveRepo(store, args)!;
        const repo = store.repo(target.owner, target.repo);
        if (repo === undefined) return toolError(`Repository not found: ${target.owner}/${target.repo}`);
        const state = String(pickArg(args, 'state', 'status') ?? 'open');
        const issues = [...repo.issues.values()]
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => a.number - b.number)
          .map((issue) => issueView(repo, issue));
        return toolResult(issues);
      }
      case 'create_pull_request': {
        const target = resolveRepo(store, args)!;
        const repo = store.repo(target.owner, target.repo);
        if (repo === undefined) return toolError(`Repository not found: ${target.owner}/${target.repo}`);
        const title = String(pickArg(args, 'title'));
        const body = typeof pickArg(args, 'body', 'description', 'content', 'text') === 'string' ? String(pickArg(args, 'body', 'description', 'content', 'text')) : '';
        const head = String(pickArg(args, 'head', 'head_ref', 'head_branch'));
        const base = String(pickArg(args, 'base', 'base_ref', 'base_branch'));
        const pr = store.createPullRequest(repo, head, base, title, body);
        return toolResult(prView(store, repo, pr));
      }
      case 'list_pull_requests': {
        const target = resolveRepo(store, args)!;
        const repo = store.repo(target.owner, target.repo);
        if (repo === undefined) return toolError(`Repository not found: ${target.owner}/${target.repo}`);
        const state = String(pickArg(args, 'state', 'status') ?? 'open');
        const prs = [...repo.pulls.values()]
          .filter((pr) => state === 'all' || (state === 'open' ? pr.state === 'open' && !pr.merged : pr.state === 'closed' || pr.merged))
          .sort((a, b) => a.number - b.number)
          .map((pr) => prView(store, repo, pr));
        return toolResult(prs);
      }
      case 'merge_pull_request': {
        const target = resolveRepo(store, args)!;
        const repo = store.repo(target.owner, target.repo);
        const number = Number(pickArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number'));
        const pr = repo?.pulls.get(number);
        if (repo === undefined || pr === undefined) return toolError(`Pull request not found: ${target.owner}/${target.repo}#${number}`);
        const result = store.mergePullRequest(repo, pr);
        return toolResult({ ...prView(store, repo, pr), sha: result.sha, merged: true });
      }
      default:
        throw { code: -32602, message: `Unknown tool: ${name}` };
    }
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err) throw err;
    return toolError(err instanceof Error ? err.message : 'Tool call failed');
  }
}

export interface McpOutcome {
  status: number;
  body: string | null;
  contentType: string;
}

/**
 * Handle one POST /mcp request body (already read). Returns the HTTP status
 * and the response body (null = empty body).
 */
export function handleMcp(store: Store, rawBody: Buffer): McpOutcome {
  const json = 'application/json';
  let request: unknown;
  try {
    request = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      contentType: json,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  const record = asRecord(request);
  if (record === null || typeof record.method !== 'string') {
    return {
      status: 200,
      contentType: json,
      body: JSON.stringify({ jsonrpc: '2.0', id: (record?.id as string | number | null) ?? null, error: { code: -32600, message: 'Invalid Request' } }),
    };
  }
  const id = record.id as string | number | null | undefined;
  const hasId = id !== undefined && id !== null;
  const params = asRecord(record.params) ?? {};
  const reply = (result: unknown): McpOutcome => ({
    status: 200,
    contentType: json,
    body: JSON.stringify({ jsonrpc: '2.0', id: hasId ? id : null, result }),
  });
  const replyError = (code: number, message: string): McpOutcome => ({
    status: 200,
    contentType: json,
    body: JSON.stringify({ jsonrpc: '2.0', id: hasId ? id : null, error: { code, message } }),
  });
  // Notifications (no id) never get a body.
  if (!hasId) return { status: 202, contentType: json, body: null };
  switch (record.method) {
    case 'server/discover': {
      return reply({
        supportedVersions: [MODERN_REVISION, ...LEGACY_REVISIONS],
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MODERN_REVISION;
      const negotiated = LEGACY_REVISIONS.includes(offered) ? offered : offered === MODERN_REVISION ? MODERN_REVISION : '2025-11-25';
      return reply({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'tools/list': {
      return reply(toolsListResult());
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = asRecord(params.arguments) ?? {};
      try {
        return reply(callTool(store, toolName, args));
      } catch (err) {
        if (err !== null && typeof err === 'object' && 'code' in err) {
          const typed = err as { code: number; message: string };
          return replyError(typed.code, typed.message);
        }
        return replyError(-32603, 'Internal error');
      }
    }
    case 'ping': {
      return reply({});
    }
    default: {
      return replyError(-32601, `Method not found: ${record.method}`);
    }
  }
}
