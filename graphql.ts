// A small GraphQL executor for the fixed set of documents the conformance
// suite sends (gh-style queries and mutations over Repository / Issue /
// PullRequest, __type introspection, node(id:) and batched operations).
// It is a real parser + validator + executor, not a string matcher: unknown
// fields fail validation with HTTP 200 and an `errors` array naming them.

import {
  VIEWER_LOGIN,
  decodeGlobalId,
  globalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer + parser
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$()[]{}:=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j]!;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selection?: SelectionNode[];
}

export type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition?: string; selection: SelectionNode[] };

export interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  varDefs: string[];
  selection: SelectionNode[];
}

export interface FragmentNode {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }
  private expectName(what = 'name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what} in GraphQL document`);
    return token.value;
  }
  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', varDefs: [], selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('fragment name');
        const on = this.expectName('"on"');
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName('fragment type condition');
        fragments.set(name, { name, typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const type = this.next().value as 'query' | 'mutation';
    let name: string | undefined;
    const next = this.peek();
    if (next !== undefined && next.kind === 'name') name = this.next().value;
    const varDefs: string[] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        varDefs.push(this.expectName('variable name'));
        this.expectPunct(':');
        this.parseTypeRef();
        if (this.isPunct('=')) {
          this.next();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    return { type, name, varDefs, selection: this.parseSelectionSet() };
  }

  private parseTypeRef(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.expectName('type name');
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selection: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      const token = this.peek()!;
      if (token.kind === 'spread') {
        this.next();
        const following = this.peek();
        if (following !== undefined && following.kind === 'name' && following.value === 'on') {
          this.next();
          const typeCondition = this.expectName('inline fragment type');
          selection.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (following !== undefined && following.kind === 'name') {
          selection.push({ kind: 'fragmentSpread', name: this.next().value });
        } else {
          selection.push({ kind: 'inlineFragment', selection: this.parseSelectionSet() });
        }
        continue;
      }
      selection.push(this.parseField());
    }
    this.expectPunct('}');
    return selection;
  }

  private parseField(): FieldNode {
    let name = this.expectName('field name');
    let alias: string | undefined;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName('field name after alias');
    }
    const args: Record<string, ValueNode> = {};
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName('argument name');
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    // Directives: parsed and ignored (the suite sends none).
    while (this.isPunct('@')) {
      this.next();
      this.expectName('directive name');
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          this.expectName('directive argument name');
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
    let selection: SelectionNode[] | undefined;
    if (this.isPunct('{')) selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName('variable name') };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.isPunct('}')) {
        const key = this.expectName('object field name');
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------
// Schema registry (introspection + validation)
// ---------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'id', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'url'],
  User: ['login', 'id', 'name'],
  Ref: ['name', 'id', 'prefix'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'author', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  CommitFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CommitFileEdge: ['node', 'cursor'],
  CommitFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Node: ['id'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

/** Return type of a field, for validation-time type tracking. */
const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'Viewer', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Viewer: { login: 'String', id: 'ID', name: 'String' },
  Repository: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest', createdAt: 'String', updatedAt: 'String', description: 'String', url: 'String' },
  User: { login: 'String', id: 'ID', name: 'String' },
  Ref: { name: 'String', id: 'ID', prefix: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'String', body: 'String', createdAt: 'String', updatedAt: 'String', closedAt: 'String', author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection', url: 'String' },
  PullRequest: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'String', merged: 'Boolean', mergeable: 'String', headRefName: 'String', baseRefName: 'String', files: 'CommitFileConnection', createdAt: 'String', updatedAt: 'String', mergedAt: 'String', author: 'User', url: 'String' },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  CommitFileConnection: { nodes: '[CommitFile]', edges: '[CommitFileEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  CommitFileEdge: { node: 'CommitFile', cursor: 'String' },
  CommitFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  IssueCommentConnection: { nodes: '[IssueComment]', edges: '[IssueCommentEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String', createdAt: 'String', updatedAt: 'String', author: 'User' },
  LabelConnection: { nodes: '[Label]', edges: '[LabelEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  LabelEdge: { node: 'Label', cursor: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  Node: { id: 'ID' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]', description: 'String' },
  __Field: { name: 'String', description: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '[__Type]' },
};

const SCHEMA_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

type Value =
  | { __type: 'Viewer' }
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Ref'; name: string }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { __type: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; body: string; createdAt: string; updatedAt: string } }
  | { __type: 'CommitFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __type: 'Label'; name: string; color: string }
  | { __type: 'Type'; name: string }
  | { __type: 'Connection'; kind: string; items: Value[]; total: number; startIndex: number }
  | { __type: 'Edge'; node: Value; cursor: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __type: 'Payload'; fields: Record<string, Value | null> };

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name] ?? null;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, variables);
  return out;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return -1;
  }
  const match = /^cursor:(\d+)$/.exec(decoded);
  return match === null ? -1 : Number.parseInt(match[1], 10);
}

function paginate(items: Value[], args: Record<string, unknown>): { __type: 'Connection'; kind: string; items: Value[]; total: number; startIndex: number; pageInfo: Value } {
  const first = typeof args.first === 'number' ? args.first : 30;
  const afterIndex = cursorIndex(args.after);
  const start = afterIndex + 1;
  const page = items.slice(start, start + first);
  const endCursor = page.length > 0 ? cursorFor(start + page.length - 1) : null;
  const pageInfo: Value = {
    __type: 'PageInfo',
    hasNextPage: start + page.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? cursorFor(start) : null,
    endCursor,
  };
  return { __type: 'Connection', kind: '', items: page, total: items.length, startIndex: start, pageInfo };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

class GraphQLError extends Error {}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function validateSelection(
  selection: readonly SelectionNode[],
  typeName: string,
  fragments: Map<string, FragmentNode>,
  errors: Array<{ message: string }>,
): void {
  for (const node of selection) {
    if (node.kind === 'fragmentSpread') {
      const fragment = fragments.get(node.name);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment "${node.name}".` });
        continue;
      }
      validateSelection(fragment.selection, fragment.typeCondition, fragments, errors);
      continue;
    }
    if (node.kind === 'inlineFragment') {
      validateSelection(node.selection, node.typeCondition ?? typeName, fragments, errors);
      continue;
    }
    const fields = SCHEMA_FIELDS[typeName];
    if (fields === undefined || !fields.includes(node.name)) {
      errors.push({ message: `Cannot query field "${node.name}" on type "${typeName}".` });
      continue;
    }
    if (node.selection !== undefined) {
      const childType = FIELD_TYPE[typeName]?.[node.name]?.replace(/^\[|\]$/g, '') ?? 'String';
      validateSelection(node.selection, childType, fragments, errors);
    }
  }
}

function executeSelection(
  typeName: string,
  source: Value | null,
  selection: readonly SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> | null {
  if (source === null) return null;
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(node.name);
      if (fragment === undefined) continue;
      // Only apply when the fragment's type condition matches (or is an
      // interface the value implements: Node matches Repository/Issue/PR).
      if (!fragmentApplies(fragment.typeCondition, source)) continue;
      const merged = executeSelection(fragment.typeCondition, source, fragment.selection, ctx);
      if (merged !== null) Object.assign(out, merged);
      continue;
    }
    if (node.kind === 'inlineFragment') {
      if (node.typeCondition !== undefined && !fragmentApplies(node.typeCondition, source)) continue;
      const merged = executeSelection(node.typeCondition ?? typeName, source, node.selection, ctx);
      if (merged !== null) Object.assign(out, merged);
      continue;
    }
    const key = node.alias ?? node.name;
    try {
      const value = resolveField(typeName, source, node, ctx);
      if (node.selection === undefined) {
        out[key] = value;
      } else if (value === null) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        const childType = FIELD_TYPE[typeName]?.[node.name]?.replace(/^\[|\]$/g, '') ?? 'String';
        out[key] = value.map((entry) => executeSelection(childType, entry as Value, node.selection!, ctx));
      } else {
        const childType = FIELD_TYPE[typeName]?.[node.name]?.replace(/^\[|\]$/g, '') ?? 'String';
        out[key] = executeSelection(childType, value as Value, node.selection!, ctx);
      }
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

function fragmentApplies(typeCondition: string, source: Value): boolean {
  if (typeCondition === 'Node') return source.__type === 'Repository' || source.__type === 'Issue' || source.__type === 'PullRequest';
  return source.__type === typeCondition;
}

function decodeGlobalIdArg(id: unknown): { kind: string; key: string } | null {
  if (typeof id !== 'string') return null;
  return decodeGlobalId(id);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prMergeable(store: Store, repo: Repo, pr: PullRequest): string {
  try {
    const check = store.mergeCheck(repo, pr);
    return check.conflict ? 'CONFLICTING' : 'MERGEABLE';
  } catch {
    return 'UNKNOWN';
  }
}

function issueList(repo: Repo, args: Record<string, unknown>): Value {
  const states = (Array.isArray(args.states) ? args.states : ['OPEN']) as string[];
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction ?? 'ASC';
  let issues = [...repo.issues.values()].filter((issue) => states.includes(issueState(issue)));
  issues.sort((a, b) => {
    const cmp = a.seq - b.seq;
    return direction === 'DESC' ? -cmp : cmp;
  });
  const items: Value[] = issues.map((issue) => ({ __type: 'Issue', repo, issue }));
  const page = paginate(items, args);
  page.kind = 'IssueConnection';
  return page;
}

function prList(repo: Repo, args: Record<string, unknown>): Value {
  const states = (Array.isArray(args.states) ? args.states : ['OPEN']) as string[];
  let prs = [...repo.pulls.values()].filter((pr) => states.includes(prState(pr)));
  prs.sort((a, b) => b.number - a.number);
  const items: Value[] = prs.map((pr) => ({ __type: 'PullRequest', repo, pr }));
  const page = paginate(items, args);
  page.kind = 'PullRequestConnection';
  return page;
}

function resolveField(typeName: string, source: Value, field: FieldNode, ctx: ExecContext): Value | string | number | boolean | null | Value[] {
  const args = resolveArgs(field, ctx.variables);
  const store = ctx.store;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return { __type: 'Viewer' };
      if (field.name === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (owner !== VIEWER_LOGIN) return null;
        if (typeof name !== 'string') return null;
        const repo = store.repo(owner, name);
        return repo === undefined ? null : { __type: 'Repository', repo };
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalIdArg(args.id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = store.repoById(Number(decoded.key));
          return repo === undefined ? null : { __type: 'Repository', repo };
        }
        if (decoded.kind === 'Issue') {
          const [repoId, number] = decoded.key.split(':');
          const repo = store.repoById(Number(repoId));
          const issue = repo?.issues.get(Number(number));
          return repo !== undefined && issue !== undefined ? { __type: 'Issue', repo, issue } : null;
        }
        if (decoded.kind === 'PullRequest') {
          const [repoId, number] = decoded.key.split(':');
          const repo = store.repoById(Number(repoId));
          const pr = repo?.pulls.get(Number(number));
          return repo !== undefined && pr !== undefined ? { __type: 'PullRequest', repo, pr } : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        if (SCHEMA_FIELDS[name] !== undefined || SCHEMA_ENUM_VALUES[name] !== undefined) return { __type: 'Type', name };
        return null;
      }
      if (field.name === '__schema') return { __type: 'Type', name: '__Schema' };
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`);
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field.name === 'createIssue') {
        const decoded = decodeGlobalIdArg(input.repositoryId);
        if (decoded === null || decoded.kind !== 'Repository') throw new GraphQLError('createIssue: unknown repositoryId');
        const repo = store.repoById(Number(decoded.key));
        if (repo === undefined) throw new GraphQLError('createIssue: unknown repositoryId');
        const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __type: 'Payload', fields: { issue: { __type: 'Issue', repo, issue } } };
      }
      if (field.name === 'closeIssue') {
        const decoded = decodeGlobalIdArg(input.issueId);
        if (decoded === null || decoded.kind !== 'Issue') throw new GraphQLError('closeIssue: unknown issueId');
        const [repoId, number] = decoded.key.split(':');
        const repo = store.repoById(Number(repoId));
        const issue = repo?.issues.get(Number(number));
        if (repo === undefined || issue === undefined) throw new GraphQLError('closeIssue: unknown issueId');
        issue.state = 'closed';
        issue.closedAt = ctx.store.nowIso();
        issue.updatedAt = issue.closedAt;
        return { __type: 'Payload', fields: { issue: { __type: 'Issue', repo, issue } } };
      }
      if (field.name === 'createPullRequest') {
        const decoded = decodeGlobalIdArg(input.repositoryId);
        if (decoded === null || decoded.kind !== 'Repository') throw new GraphQLError('createPullRequest: unknown repositoryId');
        const repo = store.repoById(Number(decoded.key));
        if (repo === undefined) throw new GraphQLError('createPullRequest: unknown repositoryId');
        const pr = store.createPullRequest(repo, String(input.headRefName ?? ''), String(input.baseRefName ?? ''), String(input.title ?? ''), String(input.body ?? ''));
        return { __type: 'Payload', fields: { pullRequest: { __type: 'PullRequest', repo, pr } } };
      }
      if (field.name === 'mergePullRequest') {
        const decoded = decodeGlobalIdArg(input.pullRequestId);
        if (decoded === null || decoded.kind !== 'PullRequest') throw new GraphQLError('mergePullRequest: unknown pullRequestId');
        const [repoId, number] = decoded.key.split(':');
        const repo = store.repoById(Number(repoId));
        const pr = repo?.pulls.get(Number(number));
        if (repo === undefined || pr === undefined) throw new GraphQLError('mergePullRequest: unknown pullRequestId');
        store.mergePullRequest(repo, pr);
        return { __type: 'Payload', fields: { pullRequest: { __type: 'PullRequest', repo, pr } } };
      }
      if (field.name === 'addComment') {
        const decoded = decodeGlobalIdArg(input.subjectId);
        if (decoded === null || decoded.kind !== 'Issue') throw new GraphQLError('addComment: unknown subjectId');
        const [repoId, number] = decoded.key.split(':');
        const repo = store.repoById(Number(repoId));
        const issue = repo?.issues.get(Number(number));
        if (repo === undefined || issue === undefined) throw new GraphQLError('addComment: unknown subjectId');
        const comment = store.addComment(repo, issue, String(input.body ?? ''));
        const node: Value = { __type: 'IssueComment', repo, issue, comment };
        return { __type: 'Payload', fields: { commentEdge: { __type: 'Edge', node, cursor: cursorFor(issue.comments.length - 1) } } };
      }
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
    }
    case 'Viewer': {
      if (field.name === 'login') return VIEWER_LOGIN;
      if (field.name === 'id') return globalId('User', VIEWER_LOGIN);
      if (field.name === 'name') return 'ada iversen';
      break;
    }
    case 'Repository': {
      const repo = (source as { __type: 'Repository'; repo: Repo }).repo;
      if (field.name === 'id') return globalId('Repository', String(repo.id));
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return { __type: 'User', login: repo.owner };
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : { __type: 'Ref', name: repo.defaultBranch };
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'createdAt') return repo.createdAt;
      if (field.name === 'updatedAt') return repo.updatedAt;
      if (field.name === 'description') return repo.description;
      if (field.name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}`;
      if (field.name === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : { __type: 'Issue', repo, issue };
      }
      if (field.name === 'issues') return issueList(repo, args);
      if (field.name === 'pullRequests') return prList(repo, args);
      if (field.name === 'pullRequest') {
        const pr = repo.pulls.get(Number(args.number));
        return pr === undefined ? null : { __type: 'PullRequest', repo, pr };
      }
      break;
    }
    case 'User': {
      const login = (source as { __type: 'User'; login: string }).login;
      if (field.name === 'login') return login;
      if (field.name === 'id') return globalId('User', login);
      if (field.name === 'name') return login === VIEWER_LOGIN ? 'ada iversen' : login;
      break;
    }
    case 'Ref': {
      const name = (source as { __type: 'Ref'; name: string }).name;
      if (field.name === 'name') return name;
      if (field.name === 'id') return globalId('Ref', name);
      if (field.name === 'prefix') return 'refs/heads/';
      break;
    }
    case 'Issue': {
      const { repo, issue } = source as { __type: 'Issue'; repo: Repo; issue: Issue };
      if (field.name === 'id') return globalId('Issue', `${repo.id}:${issue.number}`);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issueState(issue);
      if (field.name === 'body') return issue.body;
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      if (field.name === 'closedAt') return issue.closedAt;
      if (field.name === 'author') return { __type: 'User', login: VIEWER_LOGIN };
      if (field.name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field.name === 'labels') {
        const items: Value[] = issue.labels.map((name) => {
          const label = repo.labels.get(name);
          return { __type: 'Label', name, color: label?.color ?? '000000' };
        });
        const page = paginate(items, args);
        page.kind = 'LabelConnection';
        return page;
      }
      if (field.name === 'comments') {
        const items: Value[] = issue.comments.map((comment) => ({ __type: 'IssueComment', repo, issue, comment }));
        const page = paginate(items, args);
        page.kind = 'IssueCommentConnection';
        return page;
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pr } = source as { __type: 'PullRequest'; repo: Repo; pr: PullRequest };
      if (field.name === 'id') return globalId('PullRequest', `${repo.id}:${pr.number}`);
      if (field.name === 'number') return pr.number;
      if (field.name === 'title') return pr.title;
      if (field.name === 'body') return pr.body;
      if (field.name === 'state') return prState(pr);
      if (field.name === 'merged') return pr.merged;
      if (field.name === 'mergeable') return prMergeable(store, repo, pr);
      if (field.name === 'headRefName') return pr.headRef;
      if (field.name === 'baseRefName') return pr.baseRef;
      if (field.name === 'createdAt') return pr.createdAt;
      if (field.name === 'updatedAt') return pr.updatedAt;
      if (field.name === 'mergedAt') return pr.mergedAt;
      if (field.name === 'author') return { __type: 'User', login: VIEWER_LOGIN };
      if (field.name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`;
      if (field.name === 'files') {
        const files = store.diffFiles(repo, pr);
        const items: Value[] = files.map((entry) => ({
          __type: 'CommitFile',
          path: entry.filename,
          additions: entry.additions,
          deletions: entry.deletions,
          changeType: entry.status === 'added' ? 'ADDED' : entry.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        }));
        const page = paginate(items, args);
        page.kind = 'CommitFileConnection';
        return page;
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'CommitFileConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection': {
      const conn = source as { __type: 'Connection'; items: Value[]; total: number; startIndex: number; pageInfo: Value };
      if (field.name === 'nodes') return conn.items;
      if (field.name === 'edges') return conn.items.map((node, index) => ({ __type: 'Edge', node, cursor: cursorFor(conn.startIndex + index) }));
      if (field.name === 'pageInfo') return conn.pageInfo;
      if (field.name === 'totalCount') return conn.total;
      break;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'CommitFileEdge':
    case 'IssueCommentEdge':
    case 'LabelEdge': {
      const edge = source as { __type: 'Edge'; node: Value; cursor: string };
      if (field.name === 'node') return edge.node;
      if (field.name === 'cursor') return edge.cursor;
      break;
    }
    case 'PageInfo': {
      const info = source as { __type: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'hasPreviousPage') return info.hasPreviousPage;
      if (field.name === 'startCursor') return info.startCursor;
      if (field.name === 'endCursor') return info.endCursor;
      break;
    }
    case 'IssueComment': {
      const comment = (source as { __type: 'IssueComment'; comment: { id: number; body: string; createdAt: string; updatedAt: string } }).comment;
      const issue = (source as { __type: 'IssueComment'; issue: Issue }).issue;
      const repo = (source as { __type: 'IssueComment'; repo: Repo }).repo;
      if (field.name === 'id') return globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
      if (field.name === 'body') return comment.body;
      if (field.name === 'createdAt') return comment.createdAt;
      if (field.name === 'updatedAt') return comment.updatedAt;
      if (field.name === 'author') return { __type: 'User', login: VIEWER_LOGIN };
      break;
    }
    case 'Label': {
      const label = source as { __type: 'Label'; name: string; color: string };
      if (field.name === 'id') return globalId('Label', label.name);
      if (field.name === 'name') return label.name;
      if (field.name === 'color') return label.color;
      if (field.name === 'description') return '';
      break;
    }
    case 'CommitFile': {
      const file = source as { __type: 'CommitFile'; path: string; additions: number; deletions: number; changeType: string };
      if (field.name === 'path') return file.path;
      if (field.name === 'additions') return file.additions;
      if (field.name === 'deletions') return file.deletions;
      if (field.name === 'changeType') return file.changeType;
      break;
    }
    case 'Node': {
      if (field.name === 'id') {
        if (source.__type === 'Repository') return globalId('Repository', String((source as { repo: Repo }).repo.id));
        if (source.__type === 'Issue') {
          const s = source as { __type: 'Issue'; repo: Repo; issue: Issue };
          return globalId('Issue', `${s.repo.id}:${s.issue.number}`);
        }
        if (source.__type === 'PullRequest') {
          const s = source as { __type: 'PullRequest'; repo: Repo; pr: PullRequest };
          return globalId('PullRequest', `${s.repo.id}:${s.pr.number}`);
        }
      }
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload': {
      const payload = source as { __type: 'Payload'; fields: Record<string, Value | null> };
      if (field.name === 'clientMutationId') return null;
      return payload.fields[field.name] ?? null;
    }
    case '__Type': {
      const name = (source as { __type: 'Type'; name: string }).name;
      if (field.name === 'name') return name;
      if (field.name === 'kind') return SCHEMA_ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const names = SCHEMA_FIELDS[name] ?? [];
        return names.map((fieldName) => ({ __type: 'Type', name: `__Field:${fieldName}` }));
      }
      if (field.name === 'enumValues') {
        const values = SCHEMA_ENUM_VALUES[name] ?? [];
        return values.map((value) => ({ __type: 'Type', name: `__EnumValue:${value}` }));
      }
      break;
    }
    case '__Field': {
      const raw = (source as { __type: 'Type'; name: string }).name;
      if (field.name === 'name') return raw.replace('__Field:', '');
      if (field.name === 'description') return null;
      break;
    }
    case '__EnumValue': {
      const raw = (source as { __type: 'Type'; name: string }).name;
      if (field.name === 'name') return raw.replace('__EnumValue:', '');
      if (field.name === 'description') return null;
      break;
    }
    case '__Schema': {
      if (field.name === 'queryType') return { __type: 'Type', name: 'Query' };
      if (field.name === 'mutationType') return { __type: 'Type', name: 'Mutation' };
      if (field.name === 'types') return Object.keys(SCHEMA_FIELDS).map((name) => ({ __type: 'Type', name }));
      break;
    }
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
}

/** Execute one GraphQL operation object ({query, variables, operationName}). */
export function executeGraphQL(
  store: Store,
  body: { query?: unknown; variables?: unknown; operationName?: unknown },
): Record<string, unknown> {
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL query must be a non-empty string.' }] };
  }
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    document = new Parser(tokenize(body.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'GraphQL document contains no operation.' }] };
  }
  const operation =
    document.operations.find((op) => op.name === body.operationName) ?? document.operations[0]!;
  const ctx: ExecContext = { store, variables, fragments: document.fragments, errors: [] };
  // Validation first: an unknown field is a 200 with errors, not partial data.
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: Array<{ message: string }> = [];
  validateSelection(operation.selection, rootType, document.fragments, validationErrors);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors };
  }
  // The root value is a dummy: Query/Mutation resolvers ignore their source.
  const data = executeSelection(rootType, { __type: 'Viewer' } as Value, operation.selection, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
