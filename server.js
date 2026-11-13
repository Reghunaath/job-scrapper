'use strict';

/**
 * Local server for the LinkedIn job scraper.
 *
 *   node server.js   ->  http://localhost:5173
 *
 * No dependencies, no build step. Results live in memory only and are lost on
 * restart.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { searchJobs, enrichJobs } = require('./lib/linkedin');
const { filterJobs, MODEL } = require('./lib/filter');
const { loadBlacklist, BLACKLIST_FILE } = require('./lib/blacklist');
const { loadSeen, recordSeen, SEEN_FILE } = require('./lib/seen');

const PORT = Number(process.env.PORT) || 5173;
const PROMPT_FILE = path.join(__dirname, 'prompt.md');
const RESUME_FILE = path.join(__dirname, 'resume.md');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

const MAX_JOBS = 100;
const ALLOWED_HOURS = [1, 2, 3, 6, 12, 24];
const DEFAULT_KEYWORDS = 'Software Developer Entry Level Associate';

/** Last scrape's results — in-memory only, by design. */
let lastJobs = [];
/** Pagination state, so "load more" resumes instead of re-fetching. */
let lastQuery = null; // { keywords, hoursParam, windowSeconds, windowText, ranAt }
let nextPage = 0; // search page a follow-up request should resume from
let exhausted = false; // LinkedIn has no more results for this query
let scrapeInFlight = false;
let scrapeStartedAt = 0;

// Safety valve: if a scrape somehow never releases the flag, don't lock the app
// out forever.
const STALE_SCRAPE_MS = 15 * 60 * 1000;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readPrompt() {
  try {
    return fs.readFileSync(PROMPT_FILE, 'utf8');
  } catch {
    return '';
  }
}

function readResume() {
  try {
    return fs.readFileSync(RESUME_FILE, 'utf8');
  } catch {
    // No resume on disk is not an error — scoring simply has nothing to go on.
    return '';
  }
}

/**
 * Strip the human-facing header from prompt.md so only the requirements below
 * the `---` divider reach the model. Falls back to the whole file if there is
 * no divider.
 */
function promptForModel(raw) {
  const idx = raw.indexOf('\n---');
  const body = idx === -1 ? raw : raw.slice(idx + 4);
  return body.trim() || raw.trim();
}

// Ceiling for a "since last search" window. LinkedIn's own filter stops at 24
// hours, and the seen-ids log expires at 24 hours too, so a longer gap gains
// nothing.
const MAX_SINCE_MINUTES = 24 * 60;

/** Human label for a recency window given in seconds. */
function describeWindow(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `last ${mins} minute${mins === 1 ? '' : 's'}`;
  if (mins % 60 === 0) {
    const hrs = mins / 60;
    return `last ${hrs} hour${hrs === 1 ? '' : 's'}`;
  }
  return `last ${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Sort matches first, then unfiltered, then non-matches. */
function sortJobs(jobs) {
  const rank = (j) => (j.match === true ? 0 : j.match === null ? 1 : 2);
  return [...jobs].sort((a, b) => rank(a) - rank(b));
}

async function handleScrape(req, res, url) {
  const count = Math.min(
    Math.max(parseInt(url.searchParams.get('count'), 10) || 25, 1),
    MAX_JOBS,
  );
  const hoursParam = (url.searchParams.get('hours') || '').trim();
  const sinceLast = hoursParam === 'since';
  const keywords = (url.searchParams.get('keywords') || '').trim() || DEFAULT_KEYWORDS;
  const wantsAppend = url.searchParams.get('append') === '1';

  // Resolve the recency window up front — "since last search" reads the previous
  // run's start time, which is overwritten later in this request.
  let windowSeconds = 24 * 3600;
  let sinceError = null;
  let sinceMinutes = null;
  if (sinceLast) {
    if (wantsAppend && lastQuery && lastQuery.windowSeconds) {
      // "Load more" continues the window the visible results came from rather
      // than measuring a new, much shorter one.
      windowSeconds = lastQuery.windowSeconds;
    } else if (lastQuery && lastQuery.ranAt) {
      // The previous run's window ended at its start time, so measuring from
      // there covers the interval between the two searches.
      //
      // Round UP, not to nearest: rounding down would leave a sliver at the
      // start of the interval that no search ever covers, since the next run
      // measures from this one. Rounding up overlaps the previous window
      // instead, and that costs nothing — the seen-ids log drops the repeats
      // before any description fetch or Claude call.
      const raw = (Date.now() - lastQuery.ranAt) / 60000;
      sinceMinutes = Math.max(1, Math.min(MAX_SINCE_MINUTES, Math.ceil(raw)));
      windowSeconds = sinceMinutes * 60;
    } else {
      sinceError =
        'No earlier search to measure from — choose a time window for the first run.';
    }
  } else {
    const hoursRaw = parseInt(hoursParam, 10);
    windowSeconds = (ALLOWED_HOURS.includes(hoursRaw) ? hoursRaw : 24) * 3600;
  }
  const windowText = describeWindow(windowSeconds);

  // Only continue a previous run when it's the same query and there's more to get.
  const sameQuery =
    lastQuery &&
    lastQuery.keywords === keywords &&
    lastQuery.windowSeconds === windowSeconds;
  const append = wantsAppend && sameQuery && lastJobs.length > 0 && !exhausted;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  if (sinceError) {
    send('error', { message: sinceError });
    return res.end();
  }

  if (scrapeInFlight && Date.now() - scrapeStartedAt < STALE_SCRAPE_MS) {
    send('error', { message: 'A scrape is already running. Wait for it to finish.' });
    return res.end();
  }
  scrapeInFlight = true;
  scrapeStartedAt = Date.now();

  let cancelled = false;
  const shouldCancel = () => cancelled;
  req.on('close', () => {
    cancelled = true;
  });

  // Non-fatal problems (retries, unreachable job pages, failed filter batches).
  // Streamed as they happen and also replayed in the final payload.
  const warnings = [];
  const MAX_WARNINGS = 100;
  const onWarning = (message) => {
    if (warnings.length >= MAX_WARNINGS) return;
    warnings.push(message);
    send('warning', { message });
    console.warn(`  warning: ${message}`);
  };

  try {
    if (!append) {
      // Fresh scrape — drop whatever the previous query left behind.
      lastJobs = [];
      nextPage = 0;
      exhausted = false;
      lastQuery = { keywords, hoursParam, windowSeconds, windowText, ranAt: scrapeStartedAt };
    } else if (lastQuery) {
      // "Load more" is still a search, so it becomes the latest run.
      lastQuery.ranAt = scrapeStartedAt;
    }

    send('progress', {
      phase: 'search',
      done: 0,
      total: count,
      message: append
        ? `Looking for ${count} more jobs…`
        : `Searching LinkedIn for "${keywords}" (${windowText})…`,
    });

    // Jobs logged by an earlier search within the last 24 hours are skipped, so
    // every run surfaces postings you have not been shown yet.
    const seen = loadSeen();
    if (seen.error) onWarning(seen.error);
    const excludeIds = new Set([...lastJobs.map((j) => j.id), ...seen.ids.keys()]);

    const result = await searchJobs({
      keywords,
      windowSeconds,
      limit: count,
      startPage: append ? nextPage : 0,
      excludeIds,
      onProgress: (p) => send('progress', p),
      onWarning,
      shouldCancel,
    });

    const found = result.jobs;
    const skippedSeen = result.skippedSeen || 0;
    nextPage = result.nextPage;
    exhausted = result.exhausted;

    // Log every id the search returned, before anything is filtered out, so a
    // job dropped by the blacklist or by Claude also stays gone next time.
    const logged = recordSeen(found.map((j) => j.id));
    if (logged.error && logged.error !== seen.error) onWarning(logged.error);
    if (skippedSeen > 0 || logged.added > 0) {
      console.log(
        `  seen log: skipped ${skippedSeen} already seen, logged ${logged.added} new ` +
          `(${logged.total} ids in the last 24h)`,
      );
    }
    if (skippedSeen > 0) {
      send('progress', {
        phase: 'seen',
        done: found.length,
        total: found.length + skippedSeen,
        message: `Skipped ${skippedSeen} job${skippedSeen === 1 ? '' : 's'} already seen in the last 24 hours.`,
      });
    }

    if (found.length === 0) {
      // Everything on offer having been seen before says nothing about whether
      // LinkedIn has more results deeper in, so don't declare the search spent.
      if (skippedSeen === 0) exhausted = true;
      send('done', {
        ranAt: scrapeStartedAt,
        windowText,
        windowSeconds,
        jobs: lastJobs,
        added: 0,
        skippedSeen,
        hasMore: !exhausted,
        warnings,
        message: append
          ? 'No more jobs available for this search.'
          : skippedSeen > 0
            ? `No new jobs — all ${skippedSeen} found in the ${windowText} were already seen.`
            : `No jobs posted in the ${windowText}. Try a wider window.`,
      });
      return res.end();
    }

    // Drop blacklisted companies here, before the detail fetch — so they cost
    // neither a request nor a Claude call.
    const blacklist = loadBlacklist();
    const jobs = [];
    const blockedCompanies = new Set();
    for (const job of found) {
      if (blacklist.isBlocked(job.company)) blockedCompanies.add(job.company);
      else jobs.push(job);
    }
    const blocked = found.length - jobs.length;

    if (blocked > 0) {
      send('progress', {
        phase: 'blacklist',
        done: jobs.length,
        total: found.length,
        message: `Skipped ${blocked} job${blocked === 1 ? '' : 's'} from blacklisted companies.`,
      });
      console.log(
        `  blacklist: skipped ${blocked} job(s) from ${[...blockedCompanies].join(', ')}`,
      );
    }

    // Every job found was blacklisted. That says nothing about whether LinkedIn
    // has more results, so leave `exhausted` as the search reported it.
    if (jobs.length === 0) {
      send('done', {
        ranAt: scrapeStartedAt,
        windowText,
        windowSeconds,
        jobs: lastJobs,
        added: 0,
        blocked,
        skippedSeen,
        hasMore: !exhausted,
        warnings,
        message:
          `All ${blocked} job${blocked === 1 ? '' : 's'} found were from blacklisted ` +
          `companies (${[...blockedCompanies].join(', ')}).` +
          (exhausted ? '' : ' Load more to keep looking.'),
      });
      return res.end();
    }

    if (cancelled) return res.end();

    await enrichJobs(jobs, {
      onProgress: (p) => send('progress', p),
      onWarning,
      shouldCancel,
    });

    if (cancelled) return res.end();

    const prompt = promptForModel(readPrompt());
    if (!prompt) {
      for (const job of jobs) {
        job.match = null;
        job.reason = 'prompt.md is empty — nothing to filter against';
      }
    } else {
      // The resume rides along with the requirements so the model can score fit
      // and name gaps in the same pass — one CLI call, not two.
      const resume = promptForModel(readResume());
      const systemText = resume
        ? `# My resume\n\n${resume}\n\n# Filtering requirements\n\n${prompt}`
        : prompt;

      await filterJobs(jobs, systemText, {
        onProgress: (p) => send('progress', p),
        onWarning,
      });
    }

    // Stable sort: existing jobs keep their relative order and newly added ones
    // land at the end of their group, so the list doesn't reshuffle underneath you.
    lastJobs = sortJobs([...lastJobs, ...jobs]);

    const matched = lastJobs.filter((j) => j.match === true).length;
    const skipped =
      (blocked > 0 ? ` ${blocked} blacklisted skipped.` : '') +
      (skippedSeen > 0 ? ` ${skippedSeen} already seen skipped.` : '');
    send('done', {
      ranAt: scrapeStartedAt,
      windowText,
      windowSeconds,
      jobs: lastJobs,
      added: jobs.length,
      blocked,
      skippedSeen,
      hasMore: !exhausted,
      warnings,
      message:
        (append
          ? `Added ${jobs.length} more. ${matched} of ${lastJobs.length} jobs match your requirements.`
          : `${matched} of ${lastJobs.length} jobs matched your requirements.`) + skipped,
    });
  } catch (err) {
    console.error(`  error: ${err.message}`);
    send('error', { message: err.message, warnings });
  } finally {
    scrapeInFlight = false;
    if (!res.writableEnded) res.end();
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  switch (url.pathname) {
    case '/':
    case '/index.html':
      return fs.readFile(INDEX_FILE, (err, data) => {
        if (err) return sendJson(res, 500, { error: 'index.html is missing' });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      });

    case '/api/config':
      return sendJson(res, 200, {
        model: MODEL,
        promptFile: PROMPT_FILE,
        blacklistFile: BLACKLIST_FILE,
        blacklistCount: loadBlacklist().count,
        seenFile: SEEN_FILE,
        seenCount: loadSeen().ids.size,
        hours: ALLOWED_HOURS,
        maxJobs: MAX_JOBS,
        defaultKeywords: DEFAULT_KEYWORDS,
      });

    // Re-read from disk each time, so edits to prompt.md show up without a restart.
    case '/api/prompt':
      return sendJson(res, 200, { prompt: readPrompt(), path: PROMPT_FILE });

    case '/api/jobs':
      return sendJson(res, 200, {
        jobs: lastJobs,
        hasMore: lastJobs.length > 0 && !exhausted,
        query: lastQuery,
      });

    case '/api/scrape':
      return handleScrape(req, res, url);

    default:
      return sendJson(res, 404, { error: 'Not found' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use — the job scraper is probably ` +
        `already running.\n  Open http://localhost:${PORT} in your browser, or ` +
        `close the other window first.\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Job scraper running at http://localhost:${PORT}`);
  console.log(`Filtering with ${MODEL} via the Claude Code CLI`);
  console.log(`Requirements: ${PROMPT_FILE}`);
});
