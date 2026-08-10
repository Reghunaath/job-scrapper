'use strict';

/**
 * A log of every job id returned by a search, so later searches can skip
 * postings you have already been shown.
 *
 * Entries expire after 24 hours, so a job you saw yesterday can resurface
 * today. This is written to disk deliberately: "the last 24 hours" has to
 * outlive a server restart, unlike the scraped jobs themselves which stay in
 * memory only.
 */

const fs = require('node:fs');
const path = require('node:path');

const SEEN_FILE = path.join(__dirname, '..', 'seen-jobs.json');
const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Read the log, dropping anything past the retention window.
 *
 * Returns `{ ids, expired, error }` where `ids` maps job id -> the epoch ms it
 * was first seen. A missing file is normal and reports no error; an unreadable
 * one reports why and starts over rather than failing the scrape.
 */
function loadSeen(file = SEEN_FILE, now = Date.now()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ids: new Map(), expired: 0, error: null }; // no log yet
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* handled below */
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ids: new Map(),
      expired: 0,
      error: `${path.basename(file)} is unreadable — starting a fresh log`,
    };
  }

  const ids = new Map();
  let expired = 0;
  for (const [id, ts] of Object.entries(parsed)) {
    const t = Number(ts);
    if (!Number.isFinite(t)) continue; // ignore junk entries
    if (now - t > RETENTION_MS) {
      expired++;
      continue;
    }
    ids.set(String(id), t);
  }

  return { ids, expired, error: null };
}

/**
 * Add ids to the log and write it back, pruning expired entries at the same
 * time. An id already present keeps its original timestamp, so re-seeing a job
 * does not extend how long it stays suppressed.
 */
function recordSeen(newIds, file = SEEN_FILE, now = Date.now()) {
  const { ids, expired, error } = loadSeen(file, now);

  let added = 0;
  for (const id of newIds) {
    const key = String(id || '').trim();
    if (!key) continue;
    if (!ids.has(key)) {
      ids.set(key, now);
      added++;
    }
  }

  const out = {};
  for (const [id, ts] of ids) out[id] = ts;

  // Write to a temp file and rename, so an interrupted write can't leave a
  // truncated log behind.
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return { added: 0, total: ids.size, expired, error: `could not save ${path.basename(file)}: ${err.message}` };
  }

  return { added, total: ids.size, expired, error };
}

module.exports = { loadSeen, recordSeen, SEEN_FILE, RETENTION_MS };
