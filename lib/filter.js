'use strict';

/**
 * Filters scraped jobs against your requirements in prompt.md by shelling out
 * to the Claude Code CLI in headless mode (`claude -p`). This uses your existing
 * Claude Code subscription — no API key required.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Change this one line to trade quality for speed/cost:
//   claude-haiku-4-5  — fastest, cheapest, fine for this classification
//   claude-sonnet-5   — balanced (default)
//   claude-opus-5     — most capable
const MODEL = 'claude-sonnet-5';

const BATCH_SIZE = 8; // jobs per CLI call — amortizes fixed per-call overhead
// Descriptions are sent in full, deliberately. Restrictions that matter —
// no visa sponsorship, US-citizens-only — sit in the boilerplate at the very
// end of a posting, so any truncation risks cutting exactly the text the
// filter needs to see.
const CALL_TIMEOUT_MS = 180000;

// Batches are filtered in parallel. Each one spawns its own `claude` CLI
// process, so this is capped rather than unbounded: a 100-job run is 13
// batches, and 13 simultaneous CLI processes risk both memory pressure and
// subscription rate limits, which would cost more in retries than the
// concurrency wins. Set FILTER_CONCURRENCY=1 to go back to sequential.
const FILTER_CONCURRENCY = Math.max(1, Number(process.env.FILTER_CONCURRENCY) || 4);

// Every tool the CLI would otherwise load a schema for. Disabling them cut the
// per-call prompt overhead from ~16.8k to ~5.8k tokens in testing, and this task
// needs no tools at all — the job data arrives on stdin.
const DISABLED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Task', 'TodoWrite', 'NotebookEdit', 'BashOutput', 'KillShell', 'SlashCommand',
];

const OUTPUT_CONTRACT = `
You are filtering LinkedIn job postings against the requirements above.

For each job in the JSON array you receive, decide whether it satisfies the
requirements. Judge only from the data given; if a description is missing, judge
from the title, company, location and criteria alone.

Respond with a JSON array and nothing else — no prose, no markdown fences:
[{"id": "<the job's id, copied exactly>", "match": true or false, "reason": "<one short sentence>"}]

Return exactly one object per job, in the same order you received them.`;

/** Pull a JSON array out of a model response that may be fenced or padded with prose. */
function extractJsonArray(text) {
  if (!text) throw new Error('empty response');

  let s = String(text).trim();

  // The CLI wraps output in markdown fences even when told not to.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();

  // Fall back to the outermost bracket pair if there's still surrounding prose.
  if (!s.startsWith('[')) {
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start === -1 || end <= start) throw new Error('no JSON array found');
    s = s.slice(start, end + 1);
  }

  const parsed = JSON.parse(s);
  if (!Array.isArray(parsed)) throw new Error('response was not an array');
  return parsed;
}

/**
 * Run one `claude -p` call. The system prompt goes in a temp file and the job
 * payload on stdin, so no large or quote-heavy string ever reaches the command
 * line — which is what makes this safe under Windows' shell argument handling.
 */
function runClaude(systemPromptFile, payload) {
  return new Promise((resolve, reject) => {
    // On Windows `claude` is a .cmd shim, which spawn can only launch via a shell.
    const useShell = process.platform === 'win32';
    const quote = (s) => (useShell ? `"${s}"` : s);

    const args = [
      '-p',
      '--system-prompt-file', quote(systemPromptFile),
      '--exclude-dynamic-system-prompt-sections',
      '--model', MODEL,
      '--output-format', 'json',
      '--disallowed-tools', ...DISABLED_TOOLS,
    ];

    let child;
    try {
      child = spawn('claude', args, {
        shell: useShell,
        timeout: CALL_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return reject(new Error(`could not start claude: ${err.message}`));
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) =>
      reject(
        new Error(
          `could not run claude: ${err.message}. Is the Claude Code CLI on your PATH?`,
        ),
      ),
    );

    child.on('close', (code, signal) => {
      if (signal) {
        return reject(new Error(`claude timed out after ${CALL_TIMEOUT_MS / 1000}s`));
      }
      // The CLI emits its JSON envelope on stdout for failures too, and the
      // readable message is in `result` — prefer that over dumping raw JSON.
      let envelope = null;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        /* not JSON — fall through to the raw-output paths below */
      }

      if (code !== 0 || (envelope && envelope.is_error)) {
        const detail =
          (envelope && typeof envelope.result === 'string' && envelope.result.trim()) ||
          stderr.trim() ||
          stdout.trim() ||
          'no error output';
        return reject(new Error(`claude failed (exit ${code}): ${detail.slice(0, 200)}`));
      }

      if (!envelope) {
        return reject(
          new Error(`unreadable CLI output: ${stdout.trim().slice(0, 200) || '(empty)'}`),
        );
      }
      resolve(envelope.result);
    });

    child.stdin.on('error', () => {}); // ignore EPIPE if the child dies early
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/** Trim each job down to what the model actually needs to judge it. */
function toPayload(jobs) {
  return JSON.stringify(
    jobs.map((j) => ({
      id: j.id,
      title: j.title,
      company: j.company,
      location: j.location,
      posted: j.postedText,
      criteria: j.criteria || {},
      description: j.description || '',
    })),
    null,
    1,
  );
}

/**
 * Filter every job. Always resolves: a batch that fails twice marks its jobs
 * `match: null` so the run still produces results rather than dying.
 */
async function filterJobs(
  jobs,
  promptText,
  { onProgress = () => {}, onWarning = () => {} } = {},
) {
  if (jobs.length === 0) return jobs;

  const systemPrompt = `${promptText.trim()}\n${OUTPUT_CONTRACT}`;
  const systemPromptFile = path.join(
    os.tmpdir(),
    `job-scrapper-prompt-${process.pid}-${Date.now()}.txt`,
  );
  fs.writeFileSync(systemPromptFile, systemPrompt, 'utf8');

  const batches = [];
  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    batches.push(jobs.slice(i, i + BATCH_SIZE));
  }

  let completed = 0;

  /**
   * Filter one batch. Never throws: a batch that fails twice marks its own jobs
   * and returns, so one bad batch can't take down the others running alongside it.
   */
  const runBatch = async (batch, b) => {
    let verdicts = null;
    let lastErr;
    for (let attempt = 0; attempt < 2 && !verdicts; attempt++) {
      try {
        verdicts = extractJsonArray(await runClaude(systemPromptFile, toPayload(batch)));
      } catch (err) {
        lastErr = err;
        if (attempt === 0) {
          onWarning(`Filter batch ${b + 1} failed (${err.message}) — retrying`);
        }
      }
    }

    if (!verdicts) {
      const detail = lastErr ? lastErr.message : 'unknown error';
      onWarning(
        `Filter batch ${b + 1} failed after a retry: ${detail}. ` +
          `${batch.length} job${batch.length === 1 ? '' : 's'} left unfiltered.`,
      );
      for (const job of batch) {
        job.match = null;
        job.reason = `filter failed: ${detail}`;
      }
    } else {
      // Match verdicts back by id, falling back to position when the model
      // returns an id it invented or dropped.
      const byId = new Map(
        verdicts.filter((v) => v && v.id != null).map((v) => [String(v.id), v]),
      );
      batch.forEach((job, i) => {
        const v = byId.get(String(job.id)) || verdicts[i];
        if (v && typeof v.match === 'boolean') {
          job.match = v.match;
          job.reason = String(v.reason || '').trim();
        } else {
          job.match = null;
          job.reason = 'filter returned no verdict for this job';
        }
      });
    }

    // Batches finish out of order, so report a count rather than "batch 3 of 7".
    completed++;
    onProgress({
      phase: 'filter',
      done: completed,
      total: batches.length,
      message: `Filtered ${completed}/${batches.length} batches…`,
    });
  };

  try {
    const lanes = Math.max(1, Math.min(FILTER_CONCURRENCY, batches.length));
    onProgress({
      phase: 'filter',
      done: 0,
      total: batches.length,
      message:
        lanes > 1
          ? `Filtering ${batches.length} batches, ${lanes} at a time…`
          : `Filtering ${batches.length} batch${batches.length === 1 ? '' : 'es'}…`,
    });

    // Shared cursor: each lane takes the next batch as soon as it frees up, so a
    // slow batch doesn't hold up the queue behind it.
    let cursor = 0;
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        while (cursor < batches.length) {
          const b = cursor++;
          await runBatch(batches[b], b);
        }
      }),
    );
  } finally {
    fs.rmSync(systemPromptFile, { force: true });
  }

  onProgress({
    phase: 'filter',
    done: batches.length,
    total: batches.length,
    message: 'Filtering complete.',
  });

  return jobs;
}

module.exports = {
  filterJobs,
  extractJsonArray,
  MODEL,
  BATCH_SIZE,
  FILTER_CONCURRENCY,
};
