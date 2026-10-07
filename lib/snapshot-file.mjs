import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].every(key => a[key] === b[key]);
async function pinnedFile(filename) {
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw new Error('Snapshot must be a private regular single-link file.');
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const identity = await file.stat({ bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n || !sameFile(before, identity)) throw new Error('Snapshot file identity changed.');
    return { file, identity, async check() {
      const current = await file.stat({ bigint: true });
      const named = await fs.lstat(filename, { bigint: true });
      if (!current.isFile() || !named.isFile() || current.nlink !== 1n || named.nlink !== 1n
        || !sameFile(identity, current) || !sameFile(identity, named)) throw new Error('Snapshot file identity changed.');
    } };
  } catch (error) { await file.close().catch(() => undefined); throw error; }
}

async function digestPinned(file) {
  const hash = createHash('sha256');
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
  return hash.digest('hex');
}

async function writeAll(file, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new Error('Snapshot file write failed.');
    offset += bytesWritten;
  }
}

export async function spoolSnapshot(response, filename, maxBytes, expected) {
  const file = await fs.open(filename, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  let prefix = Buffer.alloc(0);
  try {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      throw new Error('Snapshot exceeds the bridge size limit.');
    }
    for await (const value of response.body ?? []) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) throw new Error('Snapshot exceeds the bridge size limit.');
      if (prefix.length < 64) prefix = Buffer.concat([prefix, chunk.subarray(0, 64 - prefix.length)]);
      hash.update(chunk);
      await writeAll(file, chunk);
    }
    const digest = hash.digest('hex');
    if (digest !== expected) throw new Error('Snapshot download failed SHA-256 verification.');
    return { path: filename, wireSha256: digest, size, prefix };
  } catch (error) {
    try { await response.body?.cancel(); } catch { /* Preserve the primary failure. */ }
    await file.close().catch(() => undefined);
    await fs.unlink(filename).catch(() => undefined);
    throw error;
  } finally { await file.close().catch(() => undefined); }
}


/** Only ciphertext is written; input/archive bytes never become a disk spool. */
async function encryptChunks(chunks, output, key, maxBytes, expectedSha256, checkInput, requireZip = false) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid snapshot recipient key.');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const hash = createHash('sha256'), wireHash = createHash('sha256');
  const file = await fs.open(output, 'wx', 0o600);
  let size = 0, carry = Buffer.alloc(0), prefix = Buffer.alloc(0), admitted = !requireZip;
  const write = async value => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); wireHash.update(bytes); await writeAll(file, bytes); };
  const emit = async bytes => {
    const joined = Buffer.concat([carry, bytes]), length = joined.length - joined.length % 3;
    await write(joined.subarray(0, length).toString('base64'));
    carry = Buffer.from(joined.subarray(length));
  };
  try {
    await write(JSON.stringify({ format: 'flujo-workspace-encrypted', version: 1, iv: iv.toString('base64') }).slice(0, -1) + ',"data":"');
    for await (const value of chunks) {
      let chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) { chunk.fill(0); throw new Error('Snapshot exceeds the bridge size limit.'); }
      hash.update(chunk);
      if (!admitted) {
        const needed = 4 - prefix.length;
        prefix = Buffer.concat([prefix, chunk.subarray(0, needed)]);
        const remainder = chunk.subarray(Math.min(needed, chunk.length));
        if (prefix.length < 4) { chunk.fill(0); continue; }
        if (prefix[0] !== 0x50 || prefix[1] !== 0x4b
          || !((prefix[2] === 3 && prefix[3] === 4) || (prefix[2] === 5 && prefix[3] === 6))) {
          chunk.fill(0); throw new Error('Legacy snapshot is not a ZIP; encrypted exports require recipient-key acknowledgement.');
        }
        admitted = true; await emit(cipher.update(prefix)); prefix.fill(0);
        await emit(cipher.update(remainder));
      } else await emit(cipher.update(chunk));
      chunk.fill(0);
    }
    if (!admitted) throw new Error('Legacy snapshot is not a ZIP.');
    const plaintextSha256 = hash.digest('hex');
    if (expectedSha256 !== undefined && plaintextSha256 !== expectedSha256) throw new Error('Snapshot download failed SHA-256 verification.');
    await checkInput?.();
    await emit(cipher.final());
    await write(carry.toString('base64') + '","tag":' + JSON.stringify(cipher.getAuthTag().toString('base64')) + '}');
    return { path: output, plaintextSha256, plaintextBytes: size, wireSha256: wireHash.digest('hex') };
  } catch (error) {
    await file.close().catch(() => undefined); await fs.unlink(output).catch(() => undefined); throw error;
  } finally { await file.close().catch(() => undefined); carry.fill(0); prefix.fill(0); }
}

export async function encryptSnapshotFile(input, output, key, maxBytes) {
  const pinned = await pinnedFile(input);
  try { return await encryptChunks(pinned.file.createReadStream({ start: 0, autoClose: false }), output, key, maxBytes, undefined, pinned.check); }
  finally { await pinned.file.close().catch(() => undefined); }
}

export async function encryptSnapshotResponse(response, output, key, maxBytes, expectedSha256) {
  try {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('Snapshot exceeds the bridge size limit.');
    return await encryptChunks(response.body ?? [], output, key, maxBytes, expectedSha256, undefined, true);
  } catch (error) { try { await response.body?.cancel(); } catch { /* Preserve the primary failure. */ } throw error; }
}

/** Strict bounded top-level v1 framing; data can precede IV/tag. */
async function envelopeFrame(file) {
  const allowed = new Set(['format', 'version', 'iv', 'tag', 'data']);
  const values = Object.create(null), seen = new Set();
  let state = 'start', text = '', key, quoted = false, escaped = false;
  let offset = 0, metadataBytes = 0, dataStart, dataEnd, dataEscaped = false;
  const fail = () => { throw new Error('Invalid encrypted snapshot framing.'); };
  const finishValue = () => {
    try { values[key] = JSON.parse(text); } catch { fail(); }
    text = ''; state = 'separator';
  };
  const whitespace = ch => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
    if (chunk.some(byte => byte > 127)) fail();
    const part = chunk.toString('ascii');
    for (let i = 0; i < part.length; i++) {
      if (state === 'data') {
        if (dataEscaped) { dataEscaped = false; continue; }
        const marker = /[\\"]/g; marker.lastIndex = i;
        const found = marker.exec(part);
        if (!found) { i = part.length; break; }
        i = found.index;
        if (part[i] === '\\') { dataEscaped = true; continue; }
        dataEnd = offset + i; values.data = ''; state = 'separator'; continue;
      }
      if (++metadataBytes > 16384) fail();
      const ch = part[i];
      if (state === 'done') { if (!whitespace(ch)) fail(); continue; }
      if (state === 'start') { if (whitespace(ch)) continue; if (ch !== '{') fail(); state = 'key'; continue; }
      if (state === 'key') { if (whitespace(ch)) continue; if (ch !== '"') fail(); text = '"'; escaped = false; state = 'key-text'; continue; }
      if (state === 'key-text') {
        text += ch;
        if (text.length > 256) fail();
        if (!escaped && ch === '"') {
          try { key = JSON.parse(text); } catch { fail(); }
          if (!allowed.has(key) || seen.has(key)) fail(); seen.add(key); state = 'colon';
        }
        if (!escaped && ch === '\\') escaped = true; else escaped = false;
        continue;
      }
      if (state === 'colon') { if (whitespace(ch)) continue; if (ch !== ':') fail(); state = 'value'; text = ''; quoted = false; escaped = false; continue; }
      if (state === 'value') {
        if (!text && whitespace(ch)) continue;
        if (key === 'data') {
          if (ch !== '"') fail(); dataStart = offset + i + 1; state = 'data'; continue;
        }
        if (!text) quoted = ch === '"';
        if (!quoted && (ch === ',' || ch === '}')) { finishValue(); i--; continue; }
        text += ch;
        if (quoted && text.length > 1) {
          if (!escaped && ch === '"') finishValue();
          if (!escaped && ch === '\\') escaped = true; else escaped = false;
        }
        continue;
      }
      if (state === 'separator') {
        if (whitespace(ch)) continue;
        if (ch === ',') state = 'key';
        else if (ch === '}') state = 'done';
        else fail();
      }
    }
    offset += chunk.length;
  }
  if (state !== 'done' || seen.size !== 5 || dataStart === undefined || dataEnd === undefined
    || values.format !== 'flujo-workspace-encrypted' || values.version !== 1
    || typeof values.iv !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(values.iv)
    || typeof values.tag !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(values.tag)
    || Buffer.from(values.tag, 'base64').toString('base64') !== values.tag) fail();
  return { dataStart, dataEnd, iv: Buffer.from(values.iv, 'base64'), tag: Buffer.from(values.tag, 'base64') };
}

/** Authenticate and hash decrypted bytes without materializing the JSON/data/ZIP. */
export async function verifyEncryptedSnapshotFile(filename, key, plaintextSha256, maxBytes, expectedWireSha256) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !/^[0-9a-f]{64}$/.test(plaintextSha256)) {
    throw new Error('Invalid snapshot recipient metadata.');
  }
  const pinned = await pinnedFile(filename);
  try {
  if (pinned.identity.size > BigInt(Math.ceil(maxBytes / 3) * 4 + 32768)) throw new Error('Snapshot exceeds the bridge size limit.');
  const frame = await envelopeFrame(pinned.file);
  await pinned.check();
  const decipher = createDecipheriv('aes-256-gcm', key, frame.iv);
  decipher.setAuthTag(frame.tag);
  const hash = createHash('sha256');
  let carry = '', size = 0;
  let jsonCarry = '';
  const accept = bytes => {
    size += bytes.length;
    if (size > maxBytes) { bytes.fill(0); throw new Error('Snapshot exceeds the bridge size limit.'); }
    hash.update(bytes); bytes.fill(0);
  };
  const decode = (text, final = false) => {
    carry += text;
    const count = final ? carry.length : Math.max(0, Math.floor((carry.length - 4) / 4) * 4);
    const part = carry.slice(0, count); carry = carry.slice(count);
    if (part && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part)
      || (!final && part.includes('=')))) throw new Error('Invalid encrypted snapshot framing.');
    const bytes = Buffer.from(part, 'base64');
    if (bytes.toString('base64') !== part) throw new Error('Invalid encrypted snapshot framing.');
    accept(decipher.update(bytes)); bytes.fill(0);
  };
  const decodeJsonData = (raw, final = false) => {
    const input = jsonCarry + raw; jsonCarry = '';
    const pieces = []; let offset = 0;
    while (offset < input.length) {
      const slash = input.indexOf('\\', offset);
      if (slash === -1) { pieces.push(input.slice(offset)); break; }
      pieces.push(input.slice(offset, slash));
      const end = input[slash + 1] === 'u' ? slash + 6 : slash + 2;
      if (end > input.length) { jsonCarry = input.slice(slash); break; }
      const escape = input.slice(slash, end);
      if (!/^\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})$/.test(escape)) throw new Error('Invalid encrypted snapshot framing.');
      pieces.push(JSON.parse('"' + escape + '"')); offset = end;
    }
    if (final && jsonCarry) throw new Error('Invalid encrypted snapshot framing.');
    decode(pieces.join(''), final);
  };
  if (frame.dataEnd > frame.dataStart) {
    for await (const chunk of pinned.file.createReadStream({ start: frame.dataStart, end: frame.dataEnd - 1, autoClose: false })) decodeJsonData(chunk.toString('ascii'));
  }
  decodeJsonData('', true); accept(decipher.final());
  if (hash.digest('hex') !== plaintextSha256) throw new Error('Snapshot plaintext failed SHA-256 verification.');
  await pinned.check();
  const wireSha256 = await digestPinned(pinned.file);
  await pinned.check();
  if (expectedWireSha256 !== undefined && wireSha256 !== expectedWireSha256) throw new Error('Snapshot wire digest changed during verification.');
  return { plaintextBytes: size, wireSha256 };
  } finally { await pinned.file.close().catch(() => undefined); }
}
