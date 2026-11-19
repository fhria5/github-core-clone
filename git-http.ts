// The git smart-HTTP services: info/refs advertisements, upload-pack
// (protocol v2, with a v0 fallback) and receive-pack (v0). All state lives
// in the shared store; every push is fast-forward only, refused per ref.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  decodePktLines,
  lsRefEntries,
  pktLine,
  pktLinesText,
  planFetch,
  readPack,
  sidebandPackets,
  v0RefLines,
  writePack,
  type Pkt,
} from './git.ts';
import { ZERO_OID, hashObject, type Repo, type Store } from './store.ts';

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

const V2_CAPABILITIES = [
  'ls-refs=unborn',
  'fetch=shallow filter',
  'object-format=sha1',
  'agent=github-core-clone/1.0',
];

const V0_UPLOAD_CAPABILITIES = (repo: Repo): string =>
  [
    'symref=HEAD:refs/heads/' + repo.defaultBranch,
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'multi_ack',
    'agent=github-core-clone/1.0',
  ].join(' ');

const V0_RECEIVE_CAPABILITIES = (repo: Repo): string =>
  [
    'symref=HEAD:refs/heads/' + repo.defaultBranch,
    'report-status',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    'thin-pack',
    'agent=github-core-clone/1.0',
  ].join(' ');

function sendBinary(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

export function gitNotFound(res: ServerResponse): void {
  const body = Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8');
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  store: Store,
  repo: Repo,
  service: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const v2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
  if (service === 'git-upload-pack') {
    if (v2) {
      // Protocol v2 opens with "version 2" — no # service= preamble: real
      // git clients reject anything before the version line.
      const parts: Buffer[] = [pktLine('version 2\n')];
      for (const cap of V2_CAPABILITIES) parts.push(pktLine(`${cap}\n`));
      parts.push(PKT_FLUSH);
      sendBinary(res, 200, UPLOAD_AD_CT, Buffer.concat(parts));
      return;
    }
    const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
    parts.push(...v0RefLines(repo, V0_UPLOAD_CAPABILITIES(repo)));
    parts.push(PKT_FLUSH);
    sendBinary(res, 200, UPLOAD_AD_CT, Buffer.concat(parts));
    return;
  }
  // git-receive-pack is v0 only.
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  parts.push(...v0RefLines(repo, V0_RECEIVE_CAPABILITIES(repo)));
  parts.push(PKT_FLUSH);
  sendBinary(res, 200, RECEIVE_AD_CT, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function v2LsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  void unborn;
  const entries = lsRefEntries(repo, { peel, symrefs, prefixes });
  const parts: Buffer[] = [];
  for (const entry of entries) {
    let line: string;
    if (entry.unborn === true) {
      line = `unborn ${entry.name}`;
      if (entry.symrefTarget !== undefined) line += ` symref-target:${entry.symrefTarget}`;
    } else {
      line = `${entry.oid} ${entry.name}`;
      if (entry.symrefTarget !== undefined) line += ` symref-target:${entry.symrefTarget}`;
      if (entry.peeled !== undefined) line += ` peeled:${entry.peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Fetch(store: Store, repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'done') done = true;
    // thin-pack, no-progress, ofs-delta, filter: accepted, no effect
    // (this server writes full-object packs, which need none of them).
  }
  const plan = planFetch(store, repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  // Protocol v2: the acknowledgments section is required whenever the
  // client sent any 'have' line — even with 'done' (a real git client
  // errors "expected no other sections to be sent after no 'ready'" if it
  // is missing). With no haves (a fresh clone) it is omitted. Held haves
  // are ACKed, then 'ready'; with no held have the section is NAK.
  // Sections are separated by delim packets; only the last ends in a flush.
  const heldHaves = haves.filter((oid) => repo.objects.has(oid));
  if (heldHaves.length > 0 || !done) {
    parts.push(pktLine('acknowledgments\n'));
    if (heldHaves.length > 0) {
      for (const oid of heldHaves) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0Fetch(store: Store, repo: Repo, lines: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
  }
  const plan = planFetch(store, repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(
  store: Store,
  repo: Repo,
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
): void {
  const { packets } = decodePktLines(body);
  const lines = pktLinesText(packets);
  const v2 = req.headers['git-protocol'] === 'version=2' || (lines.length > 0 && lines[0]!.startsWith('command='));
  if (v2) {
    const command = lines[0] ?? '';
    // Arguments follow the delim packet; everything after it, up to flush.
    const afterDelim: string[] = [];
    let pastDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (packet.kind === 'flush') break;
      if (pastDelim && packet.kind === 'data') afterDelim.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    let out: Buffer;
    if (command.startsWith('command=ls-refs')) out = v2LsRefs(repo, afterDelim);
    else if (command.startsWith('command=fetch')) out = v2Fetch(store, repo, afterDelim);
    else {
      sendBinary(res, 400, UPLOAD_RESULT_CT, Buffer.from('unknown command', 'utf8'));
      return;
    }
    sendBinary(res, 200, UPLOAD_RESULT_CT, out);
    return;
  }
  const out = v0Fetch(store, repo, lines);
  sendBinary(res, 200, UPLOAD_RESULT_CT, out);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(
  store: Store,
  repo: Repo,
  body: Buffer,
  res: ServerResponse,
): void {
  const { packets, restOffset } = decodePktLines(body);
  const lines = pktLinesText(packets);
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === '') continue;
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0 && capabilities.length === 0) capabilities = text.slice(nul + 1).split(' ').filter(Boolean);
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  const useSideband = capabilities.includes('side-band-64k');
  const reportLines: string[] = [];
  // Unpack first: every object the client sent joins the store, whether or
  // not its ref update is accepted (as real git does).
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(restOffset);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const object of objects) {
        const oid = hashObject(object.type, object.data);
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      const isDelete = command.newOid === ZERO_OID;
      const isCreate = command.oldOid === ZERO_OID;
      if (!isDelete && !repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} missing object`);
        continue;
      }
      if (isDelete) {
        if (current === undefined || current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}`);
        continue;
      }
      if (isCreate) {
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
        continue;
      }
      // Update: old must match the current tip and the new tip must descend
      // from it (tags: only an identical re-push is a fast-forward).
      if (current === undefined || current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      if (command.ref.startsWith('refs/tags/')) {
        if (command.newOid !== command.oldOid) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
      } else if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
  }
  const allReportLines = [`unpack ${unpackOk ? 'ok' : unpackDetail}`, ...reportLines];
  let out: Buffer;
  if (useSideband) {
    // With side-band-64k the report-status stream is itself pkt-lined
    // inside band 1, and it ends with its own flush inside the band: the
    // client reads band-1 pkt-lines until that inner flush.
    const inner: Buffer[] = [];
    for (const line of allReportLines) inner.push(pktLine(`${line}\n`));
    inner.push(PKT_FLUSH);
    out = Buffer.concat([...sidebandPackets(Buffer.concat(inner)), PKT_FLUSH]);
  } else {
    const inner: Buffer[] = [];
    for (const line of allReportLines) inner.push(pktLine(`${line}\n`));
    inner.push(PKT_FLUSH);
    out = Buffer.concat(inner);
  }
  sendBinary(res, 200, RECEIVE_RESULT_CT, out);
}
