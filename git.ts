// git smart HTTP: pkt-line framing, packfile read/write (from scratch, no
// git binary), and the upload-pack (protocol v2 + v0 fallback) and
// receive-pack (v0) services.
//
// Packfiles written here carry full objects only, never deltas: the suite
// verifies hashes and bytes, not delta counts, and a delta-free pack is
// always valid. Packfiles read here resolve ofs-delta and ref-delta entries
// too, so any well-formed client pack unpacks.

import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  sha1Hex,
  type GitObject,
  type ObjType,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
  raw: Buffer;
}

/**
 * Decode pkt-lines from a buffer. Returns the packets and the offset where
 * the framed section ends (the rest is raw data, e.g. a packfile).
 */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; restOffset: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) break;
    packets.push({
      kind: 'data',
      payload: buf.subarray(offset + 4, offset + len),
      raw: buf.subarray(offset, offset + len),
    });
    offset += len;
  }
  return { packets, restOffset: offset };
}

export function pktLinesText(packets: readonly Pkt[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (version 2, full objects, SHA-1 trailer). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

interface RawPackEntry {
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Apply a git delta to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if ((op & 0x80) !== 0) {
      // Copy op: the offset bytes flagged by bits 0x01..0x08 come first,
      // then the size bytes flagged by 0x10..0x40 — packed sequentially in
      // flag order, one byte per set bit. A running cursor is required:
      // reading at fixed offsets misreads the next instruction whenever
      // only some bits are set.
      let p = offset;
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) { copyOffset = delta[p]!; p += 1; }
      if ((op & 0x02) !== 0) { copyOffset |= delta[p]! << 8; p += 1; }
      if ((op & 0x04) !== 0) { copyOffset |= delta[p]! << 16; p += 1; }
      if ((op & 0x08) !== 0) { copyOffset += delta[p]! * 0x1000000; p += 1; }
      if ((op & 0x10) !== 0) { copySize = delta[p]!; p += 1; }
      if ((op & 0x20) !== 0) { copySize |= delta[p]! << 8; p += 1; }
      if ((op & 0x40) !== 0) { copySize |= delta[p]! << 16; p += 1; }
      offset = p;
      if (copySize === 0) copySize = 0x10000;
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

/**
 * Parse a packfile into resolved objects. Deltas resolve against earlier
 * pack entries or the `resolveBase` lookup (objects the client already has).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): GitObject[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  const raw: RawPackEntry[] = [];
  const offsets: number[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    offsets.push(offset);
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // ofs-delta: base offset encoded backwards
      let b = pack[offset]!;
      offset += 1;
      let baseOffset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[offset]!;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const start = offset;
      const data = inflateSync(pack.subarray(start));
      const consumed = consumedZlib(pack, start, data.length);
      offset = start + consumed;
      raw.push({ type: 'ofs-delta', data, baseOffset: offsets[i]! - baseOffset });
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const start = offset;
      const data = inflateSync(pack.subarray(start));
      offset = start + consumedZlib(pack, start, data.length);
      raw.push({ type: 'ref-delta', data, baseOid });
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const start = offset;
      const data = inflateSync(pack.subarray(start));
      offset = start + consumedZlib(pack, start, data.length);
      if (data.length !== size) throw new Error('pack object size mismatch');
      raw.push({ type, data });
    }
  }
  const resolved: (GitObject | null)[] = new Array(raw.length).fill(null);
  const resolveAt = (index: number): GitObject => {
    if (resolved[index] !== null) return resolved[index]!;
    const entry = raw[index]!;
    if (entry.type === 'ofs-delta') {
      const baseIndex = offsets.indexOf(entry.baseOffset!);
      if (baseIndex < 0) throw new Error('ofs-delta base not in pack');
      const base = resolveAt(baseIndex);
      const data = applyDelta(base.data, entry.data);
      const out: GitObject = { type: base.type, data };
      resolved[index] = out;
      return out;
    }
    if (entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      for (let j = 0; j < raw.length; j += 1) {
        if (resolved[j] !== null && hashObject(resolved[j]!.type, resolved[j]!.data) === entry.baseOid) base = resolved[j]!;
      }
      if (base === undefined && resolveBase !== undefined) base = resolveBase(entry.baseOid!);
      if (base === undefined) throw new Error('ref-delta base not found');
      const data = applyDelta(base.data, entry.data);
      const out: GitObject = { type: base.type, data };
      resolved[index] = out;
      return out;
    }
    const out: GitObject = { type: entry.type as ObjType, data: entry.data };
    resolved[index] = out;
    return out;
  };
  const out: GitObject[] = [];
  for (let i = 0; i < raw.length; i += 1) out.push(resolveAt(i));
  return out;
}

/** Bytes the zlib stream starting at `start` consumes. The uncompressed size bounds it: a zlib stream is at most its output plus a few dozen bytes of framing, so a binary search over that short window finds the exact end. */
function consumedZlib(pack: Buffer, start: number, uncompressedSize: number): number {
  let lo = start + 1;
  let hi = Math.min(pack.length, start + uncompressedSize + 64);
  let found = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(pack.subarray(start, mid));
      found = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('corrupt zlib stream in pack');
  return found - start;
}

// ---------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send (full objects, resolved). */
  objects: GitObject[];
  /** Commits at the depth boundary (reported as shallow). */
  shallow: string[];
  /** Client shallow commits now fully included (reported as unshallow). */
  unshallow: string[];
}

/**
 * Compute what an upload-pack fetch sends: the closure of `wants`, minus
 * what the client already holds (`haves`), optionally depth-limited.
 * `clientShallow` lists the client's shallow boundary commits.
 */
export function planFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  // The client's haves are held — except below a shallow boundary. A
  // shallow clone holds its boundary commit but NOT its ancestors, so the
  // walk stops at each client-shallow commit (the commit plus its tree
  // only) instead of following its parents. Without this cutoff a deepen
  // fetch would conclude the client already holds the parent it is asking
  // for and send an empty pack.
  const shallowSet = new Set(clientShallow);
  const haveClosure = new Set<string>();
  {
    const stack: string[] = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (haveClosure.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      haveClosure.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        for (const t of store.reachable(repo, [view.tree])) haveClosure.add(t);
        if (!shallowSet.has(oid)) for (const parent of view.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const t of store.reachable(repo, [oid])) haveClosure.add(t);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
  }
  // Commit-level BFS from the wants, tracking depth (wants are depth 1).
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    const found = store.commitOf(repo, want);
    if (found !== null) queue.push({ oid: found.oid, depth: 1 });
    else if (repo.objects.has(want)) {
      // A tag object (or a bare tree/blob) the client wants: include it and,
      // for a tag, its target commit at depth 1.
      const object = repo.objects.get(want)!;
      if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        const targetCommit = store.commitOf(repo, target);
        if (targetCommit !== null) queue.push({ oid: targetCommit.oid, depth: 1 });
      }
    }
  }
  const wantedCommits = new Set<string>();
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift()!;
    if (commitDepth.has(oid)) continue;
    commitDepth.set(oid, d);
    wantedCommits.add(oid);
    if (depth !== null && d >= depth) {
      boundary.add(oid);
      continue;
    }
    const found = store.commitOf(repo, oid);
    if (found === null) continue;
    for (const parent of found.view.parents) {
      if (!commitDepth.has(parent)) queue.push({ oid: parent, depth: d + 1 });
    }
  }
  // Depth-aware object closure: each wanted commit contributes itself plus
  // its tree closure only — parents beyond the depth boundary are NOT
  // followed (a depth-1 clone sends the tip commit + its tree/blobs, not the
  // whole history). With no depth limit the BFS above already collected
  // every ancestor, so the full history is still sent.
  const wantClosure = new Set<string>();
  for (const oid of wantedCommits) {
    wantClosure.add(oid);
    const found = store.commitOf(repo, oid);
    if (found !== null) for (const t of store.reachable(repo, [found.view.tree])) wantClosure.add(t);
  }
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined || object.type === 'commit') continue;
    if (object.type === 'tag') {
      wantClosure.add(want);
      const target = parseTag(object.data).object;
      const targetCommit = store.commitOf(repo, target);
      if (targetCommit !== null) {
        wantClosure.add(target);
        for (const t of store.reachable(repo, [targetCommit.view.tree])) wantClosure.add(t);
      } else {
        for (const t of store.reachable(repo, [target])) wantClosure.add(t);
      }
    } else {
      for (const t of store.reachable(repo, [want])) wantClosure.add(t);
    }
  }
  const toSend = new Set<string>();
  for (const oid of wantClosure) if (!haveClosure.has(oid)) toSend.add(oid);
  // A tag object the client wants is in wantClosure already (reachable
  // follows the tag); bare wanted non-commit objects are included too.
  const objects: GitObject[] = [];
  for (const oid of [...toSend].sort()) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  // Shallow boundary: depth-limited commits whose parents were cut off.
  const shallow = [...boundary].filter((oid) => toSend.has(oid)).sort();
  // Unshallow: a client shallow commit whose parents are now all included.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (!wantedCommits.has(oid)) continue;
    const found = store.commitOf(repo, oid);
    if (found === null) continue;
    const parentsIncluded = found.view.parents.every((p) => wantedCommits.has(p) || haveClosure.has(p));
    if (parentsIncluded && found.view.parents.length > 0) unshallow.push(oid);
  }
  return { objects, shallow, unshallow: unshallow.sort() };
}

// ---------------------------------------------------------------------------
// smart-HTTP response helpers
// ---------------------------------------------------------------------------

/** A sideband packet stream: band-1 chunks of `data`, each <= 65500 bytes. */
export function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  if (data.length === 0) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return out;
  }
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

/** Ref lines for a v0 advertisement, HEAD first, then sorted refs. */
export function v0RefLines(repo: Repo, capabilities: string): Buffer[] {
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef) ?? ZERO_OID;
  const caps = capabilities === '' ? '' : `\0${capabilities}`;
  lines.push(pktLine(`${headOid} HEAD${caps}\n`));
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    lines.push(pktLine(`${oid} ${name}\n`));
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = store_peel(repo, oid);
      lines.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  return lines;
}

function store_peel(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object !== undefined && object.type === 'tag') {
    return store_peel(repo, parseTag(object.data).object);
  }
  return oid;
}

/** The peeled commit of an annotated tag ref (for ls-refs / advertisements). */
export function peelOid(repo: Repo, oid: string): string {
  return store_peel(repo, oid);
}

/** Sorted ref entries for ls-refs, with optional peel/symref info. */
export function lsRefEntries(
  repo: Repo,
  opts: { peel: boolean; symrefs: boolean; prefixes: readonly string[] },
): Array<{ oid: string; name: string; peeled?: string; symrefTarget?: string; unborn?: boolean }> {
  const out: Array<{ oid: string; name: string; peeled?: string; symrefTarget?: string; unborn?: boolean }> = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const keep = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  if (keep('HEAD')) {
    if (headOid === undefined) {
      out.push({ oid: ZERO_OID, name: 'HEAD', unborn: true, symrefTarget: opts.symrefs ? headRef : undefined });
    } else {
      out.push({ oid: headOid, name: 'HEAD', symrefTarget: opts.symrefs ? headRef : undefined });
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string; symrefTarget?: string } = { oid, name };
    if (opts.peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') entry.peeled = peelOid(repo, oid);
    }
    out.push(entry);
  }
  return out;
}
