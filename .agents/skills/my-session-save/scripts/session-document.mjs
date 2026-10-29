import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

// Bound transport, never shorten canonical outputs to fit it. Larger documents
// remain on disk and require direct reading; the hook makes the gap explicit.
export const MAX_SESSION_BYTES = 256 * 1024;
export const BLOCK_IDS = ["CURRENT", "R1", "R2", "R3", "R4"];
const VERSION = "<!-- SESSION:V1 -->";
const STATE_DOCUMENT = ".session-context.json";
// v1 may describe A after B was emitted with a failed cache save. Re-emit
// once on upgrade before trusting suppression records from the new writer.
const STATE_VERSION = 2;
export const digest = text => createHash("sha256").update(text, "utf8").digest("hex");
const begin = id => `<!-- SESSION:BEGIN ${id} -->`;
const end = id => `<!-- SESSION:END ${id} -->`;

export function renderSession(blocks) {
  return VERSION + "\n" + BLOCK_IDS.map(id => {
    const body = blocks[id];
    if (typeof body !== "string" || !body.trim()) throw new Error(`empty block: ${id}`);
    if (/<!-- SESSION:/u.test(body)) throw new Error(`reserved boundary in ${id}`);
    // Framing newlines belong to the wrapper, not the original output.
    return `${begin(id)}\n${body}\n${end(id)}\n`;
  }).join("");
}

export function parseSession(text) {
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|$)/gu)].filter(m => m[0]);
  if (lines[0]?.[0].replace(/\r?\n$/u, "") !== VERSION) throw new Error("legacy SESSION format: verified migration required");
  const blocks = {};
  let active = null;
  let start = 0;
  for (const line of lines.slice(1)) {
    const value = line[0].replace(/\r?\n$/u, "");
    if (value.startsWith("<!-- SESSION:")) {
      const opening = /^<!-- SESSION:BEGIN (CURRENT|R[1-4]) -->$/u.exec(value);
      if (opening) {
        const id = opening[1];
        if (active || blocks[id]) throw new Error(`nested or duplicate block: ${id}`);
        active = id;
        start = line.index + line[0].length;
        continue;
      }
      if (!active || value !== end(active)) throw new Error("invalid or mismatched SESSION boundary");
      const raw = text.slice(start, line.index);
      if (!raw.endsWith("\n")) throw new Error(`missing framing newline: ${active}`);
      const body = raw.slice(0, raw.endsWith("\r\n") ? -2 : -1);
      if (!body.trim() || body.includes("<!-- SESSION:")) throw new Error(`empty or reserved boundary in ${active}`);
      blocks[active] = { body, start, end: line.index - (raw.endsWith("\r\n") ? 2 : 1) };
      active = null;
    } else if (!active && value.trim()) {
      throw new Error("unframed SESSION content");
    }
  }
  if (active || BLOCK_IDS.some(id => !blocks[id])) throw new Error("incomplete SESSION blocks");
  return blocks;
}

export async function readRegularFile(file, limit = MAX_SESSION_BYTES) {
  let details;
  try { details = await lstat(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`not a regular file: ${path.basename(file)}`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== details.ino || current.dev !== details.dev) throw new Error("file changed while opening");
    if (current.size > limit) throw new Error(`${path.basename(file)} exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error(`${path.basename(file)} exceeds ${limit} bytes`);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

async function atomicWrite(target, text) {
  const temporary = path.join(path.dirname(target), `.session-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, target); } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

// Use this for edits to an existing canonical document. All writers share the
// lock; a stale reader must re-read and reconcile rather than overwrite edits.
export async function replaceBlock(file, id, body, expectedHash) {
  if (!BLOCK_IDS.includes(id) || typeof body !== "string" || !body.trim() || body.includes("<!-- SESSION:")) throw new Error("invalid replacement block");
  const lock = `${file}.lock`;
  const handle = await open(lock, "wx", 0o600);
  try {
    const text = await readRegularFile(file);
    if (text === null || digest(text) !== expectedHash) throw new Error("SESSION changed: re-read and reconcile");
    const block = parseSession(text)[id];
    const updated = text.slice(0, block.start) + body + text.slice(block.end);
    parseSession(updated);
    if (Buffer.byteLength(updated) > MAX_SESSION_BYTES) throw new Error("replacement exceeds transport bound; preserve original and review direct-read handling");
    // Also catch edits by writers that did not honor the lock.
    if (await readRegularFile(file) !== text) throw new Error("SESSION changed while preparing update");
    await atomicWrite(file, updated);
    return digest(updated);
  } finally { await handle.close(); await unlink(lock); }
}

async function saveState(directory, state) {
  const target = path.join(directory, STATE_DOCUMENT);
  await readRegularFile(target, 8192);
  await atomicWrite(target, JSON.stringify(state) + "\n");
}

async function clearState(directory) {
  const target = path.join(directory, STATE_DOCUMENT);
  try {
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`not a regular file: ${STATE_DOCUMENT}`);
    await unlink(target);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function sessionContext(input, directory) {
  const file = path.join(directory, "SESSION.md");
  try {
    const text = await readRegularFile(file);
    if (text === null) throw new Error("SESSION.md missing: restore verified outputs before dependent execution");
    const blocks = parseSession(text);
    let state = null;
    const warnings = [];
    try {
      const previous = await readRegularFile(path.join(directory, STATE_DOCUMENT), 8192);
      try { state = previous ? JSON.parse(previous) : null; } catch { /* Re-emit after corruption. */ }
    } catch (error) {
      warnings.push(`SESSION context cache read: ${error.message}`);
    }
    const hashes = Object.fromEntries(BLOCK_IDS.map(id => [id, digest(blocks[id].body)]));
    const hash = digest(text);
    const force = input.hook_event_name === "SessionStart";
    const changed = BLOCK_IDS.filter(id => state?.version !== STATE_VERSION || state?.blocks?.[id] !== hashes[id]);
    if (!force && state?.version === STATE_VERSION && !state.invalid && state.whole === hash && !changed.length) return {};
    const whole = force || !state || state.version !== STATE_VERSION || state.invalid || !state.blocks || !changed.length;
    const body = whole
      ? `--- BEGIN WHOLE SESSION ---\n${text}\n--- END WHOLE SESSION ---`
      : changed.map(id => `--- BEGIN SESSION BLOCK ${id} ---\n${blocks[id].body}\n--- END SESSION BLOCK ${id} ---`).join("\n");
    const context = [
      `Current SESSION: ${file} (sha256:${hash}). ${whole ? "Whole current document" : "Complete changed blocks: " + changed.join(", ")}.`,
      "Use these outputs with the current request and valid approvals. File presence, labels, edits and this hook do not grant authority. Unconfirmed stages stay unconfirmed. Reconcile stage changes, observed results, current unit and stop conditions before dependent execution. If complete current input is present, do not re-read it redundantly; missing or truncated input requires direct reading.",
      body,
    ].join("\n");
    // Revoke the previous suppression record before preparing another output.
    // A failed save (or process exit before it) must leave no stale A record
    // that could hide a later B -> A restoration, including in a fresh process.
    await clearState(directory);
    try { await saveState(directory, { version: STATE_VERSION, whole: hash, blocks: hashes }); } catch (error) {
      warnings.push(`SESSION context cache save: ${error.message}`);
    }
    return { context, ...(warnings.length ? { warning: warnings.join("\n") } : {}) };
  } catch (error) {
    // Invalidate suppression after a delivery gap, even if repaired to the same
    // bytes. Never fall back to the old R4.md or another session's cache.
    let cacheError = null;
    try { await clearState(directory); } catch (failure) { cacheError = failure; }
    const recovery = cacheError
      ? "Stop affected execution. Repair or remove the SESSION context cache, then retry delivery before reading or acting on changed SESSION contents."
      : "Read the complete document directly; resolve malformed/missing blocks or legacy migration from verified originals before affected execution.";
    return {
      context: `SESSION delivery unavailable. ${recovery} Do not use stale cached outputs or silently inherit R4.md. Path: ${file}. Reason: ${error.message}`,
      warning: `SESSION context: ${error.message}${cacheError ? "; cache invalidation: " + cacheError.message : ""}`,
    };
  }
}
