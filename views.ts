// The REST v3 view shapes (repo / issue / pull request / comment / label /
// user), shared by the REST surface and the MCP tools so both surfaces read
// back identical objects.

import { globalId, type Issue, type Label, type PullRequest, type Repo, type Store } from './store.ts';

const ORIGIN = 'https://example.invalid';

export function hashName(name: string): number {
  let hash = 5381;
  for (let i = 0; i < name.length; i += 1) hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
  return hash % 100000000;
}

export function userView(login: string): Record<string, unknown> {
  return {
    login,
    id: login === 'adaiversen' ? 1000 : hashName(login),
    node_id: globalId('User', login),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    html_url: `${ORIGIN}/${login}`,
    url: `${ORIGIN}/api/v3/users/${login}`,
  };
}

export function repoView(repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userView(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openIssues,
    license: null,
    topics: [],
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: `${ORIGIN}/${repo.owner}/${repo.name}`,
    url: `${ORIGIN}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${ORIGIN}/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
  };
}

export function labelView(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: hashName(`${repo.id}:${label.name}`),
    node_id: globalId('Label', `${repo.id}:${label.name}`),
    name: label.name,
    color: label.color,
    description: '',
    default: false,
    url: `${ORIGIN}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userView('adaiversen'),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name, color: '000000' } : labelView(repo, label);
    }),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `${ORIGIN}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${ORIGIN}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${ORIGIN}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${ORIGIN}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels`,
    comments_url: `${ORIGIN}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    author_association: 'OWNER',
    milestone: null,
    locked: false,
    assignee: null,
    assignees: [],
  };
}

export function commentView(
  repo: Repo,
  issue: Issue,
  comment: { id: number; body: string; createdAt: string; updatedAt: string },
): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
    user: userView('adaiversen'),
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `${ORIGIN}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${ORIGIN}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    author_association: 'OWNER',
  };
}

export function prView(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  try {
    const files = store.diffFiles(repo, pr);
    changedFiles = files.length;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
  } catch {
    // A pull whose branches vanished still reads back; the diff is empty.
  }
  return {
    id: repo.id * 1000000 + pr.number,
    node_id: globalId('PullRequest', `${repo.id}:${pr.number}`),
    number: pr.number,
    state: pr.merged ? 'closed' : pr.state,
    title: pr.title,
    body: pr.body,
    user: userView('adaiversen'),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.merged || pr.state === 'closed' ? pr.updatedAt : null,
    merged_at: pr.mergedAt,
    merged: pr.merged,
    mergeable: !store.mergeCheck(repo, pr).conflict,
    mergeable_state: store.mergeCheck(repo, pr).conflict ? 'dirty' : 'clean',
    merge_commit_sha: pr.mergeCommitSha,
    draft: false,
    additions,
    deletions,
    changed_files: changedFiles,
    commits: 1,
    head: {
      label: `${repo.owner}:${pr.headRef}`,
      ref: pr.headRef,
      sha: headSha,
      user: userView(repo.owner),
      repo: repoView(repo),
    },
    base: {
      label: `${repo.owner}:${pr.baseRef}`,
      ref: pr.baseRef,
      sha: baseSha,
      user: userView(repo.owner),
      repo: repoView(repo),
    },
    html_url: `${ORIGIN}/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `${ORIGIN}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}
