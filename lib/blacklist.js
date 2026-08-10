'use strict';

/**
 * Company blacklist. Jobs from these companies are dropped after the search and
 * before anything else happens to them — no description fetch, and nothing sent
 * to Claude.
 *
 * The file is re-read on every scrape, so edits take effect without a restart.
 */

const fs = require('node:fs');
const path = require('node:path');

const BLACKLIST_FILE = path.join(__dirname, '..', 'blacklist.txt');

// Legal-entity suffixes carry no identity: "Cummins" and "Cummins Inc." are the
// same employer. Stripped from both sides so either spelling works in the file.
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp',
  'corporation', 'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'nv', 'bv',
  'ab', 'oy', 'as', 'pvt', 'pte', 'srl', 'spa', 'sas',
]);

/**
 * Reduce a company name to a comparable form: lowercase, punctuation flattened
 * to spaces, trailing legal suffixes removed.
 */
function normalize(name) {
  const words = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  // "Foo Group Ltd." -> "foo group"; repeat for stacked suffixes like "Ltd Co".
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) {
    words.pop();
  }

  return words.join(' ');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a matcher from blacklist lines.
 *
 * Entries match on whole words rather than raw substrings, so "Apple" blocks
 * "Apple" and "Apple Inc" without also blocking "Applebee's", while a partial
 * name like "Cummins" still blocks "Cummins Inc.".
 */
function compile(lines) {
  const entries = [];

  for (const line of lines) {
    // `#` starts a comment, so the file can be annotated.
    const text = line.split('#')[0].trim();
    if (!text) continue;

    const key = normalize(text);
    if (!key) continue; // a line of only punctuation

    entries.push({ raw: text, re: new RegExp(`\\b${escapeRegExp(key)}\\b`) });
  }

  const isBlocked = (company) => {
    const norm = normalize(company);
    if (!norm) return false;
    return entries.some((e) => e.re.test(norm));
  };

  return { entries, isBlocked, count: entries.length };
}

/** Read and compile the blacklist. A missing file is not an error. */
function loadBlacklist(file = BLACKLIST_FILE) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return compile([]); // no file yet — nothing is blocked
  }
  return compile(raw.split(/\r?\n/));
}

module.exports = { loadBlacklist, normalize, compile, BLACKLIST_FILE };
