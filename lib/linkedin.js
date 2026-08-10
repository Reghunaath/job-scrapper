'use strict';

/**
 * Scrapes LinkedIn's public guest jobs endpoints. No login, no credentials —
 * these are the same endpoints an anonymous browser hits.
 *
 * The markup here is not a contract. Every field is extracted independently so
 * that a LinkedIn markup change degrades one field rather than the whole scrape.
 */

const SEARCH_URL =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DETAIL_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PAGE_SIZE = 10; // LinkedIn returns 10 cards per search request
const DETAIL_DELAY_MS = 1200; // throttle between detail fetches
const MAX_RETRIES = 3;
// Hard ceiling on search pages per request. Guest pagination is reported to
// start returning 429 around ten pages from one IP, so skipping a large backlog
// of already-seen jobs must not turn into an unbounded crawl.
const MAX_SEARCH_PAGES = 12;
// Without this, a throttling server that accepts the connection but never
// responds hangs the whole scrape indefinitely.
const REQUEST_TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)
        ? NAMED_ENTITIES[key]
        : m;
    });
}

/** Collapse all whitespace to single spaces and trim. For short single-line fields. */
function clean(str) {
  return decodeEntities(String(str || ''))
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convert an HTML fragment to readable plain text, preserving paragraph breaks. */
function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/\s*(p|div|section|h[1-6]|tr)\s*>/gi, '\n\n')
      .replace(/<\s*li[^>]*>/gi, '\n- ')
      .replace(/<\s*\/\s*li\s*>/gi, '')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** First capture group of `re` against `html`, or '' if no match. */
function match1(html, re) {
  const m = html.match(re);
  return m ? m[1] : '';
}

async function fetchWithRetry(url, label, onWarning = () => {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Report the previous attempt's failure before sleeping on it, so the UI
    // shows trouble as it happens rather than only when it becomes fatal.
    if (attempt > 0 && lastErr) {
      onWarning(`${lastErr.message} — retrying (${attempt}/${MAX_RETRIES})`);
    }
    if (attempt > 0) {
      // Exponential backoff: 1.5s, 3s, 6s
      await sleep(1500 * 2 ** (attempt - 1));
    }
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason =
        err.name === 'TimeoutError'
          ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s`
          : err.message;
      lastErr = new Error(`${label}: ${reason}`);
      continue;
    }

    if (res.ok) return res.text();

    // 429 and 5xx are transient; anything else is not worth retrying.
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        await sleep(Math.min(retryAfter, 30) * 1000);
      }
      lastErr = new Error(`${label}: HTTP ${res.status}`);
      continue;
    }

    throw new Error(`${label}: HTTP ${res.status}`);
  }
  throw lastErr || new Error(`${label}: failed after ${MAX_RETRIES} retries`);
}

/**
 * Parse one page of search-result HTML into job card objects.
 * The response is a bare list of <li> elements, 10 per page.
 */
function parseSearchPage(html) {
  const jobs = [];
  // Cards are delimited by <li>; the entity URN sits on the card's root div.
  for (const chunk of html.split(/<li[\s>]/)) {
    const id = match1(chunk, /urn:li:jobPosting:(\d+)/);
    if (!id) continue;

    const rawUrl = match1(
      chunk,
      /<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/,
    );

    jobs.push({
      id,
      title: clean(
        match1(
          chunk,
          /<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/,
        ),
      ),
      company: clean(
        match1(
          chunk,
          /<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/,
        ),
      ),
      location: clean(
        match1(
          chunk,
          /<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/,
        ),
      ),
      // e.g. "13 hours ago" — the precise recency signal. The `datetime`
      // attribute is date-only, so it can't distinguish 1h from 20h.
      postedText: clean(match1(chunk, /<time[^>]*>([\s\S]*?)<\/time>/)),
      postedDate: match1(chunk, /<time[^>]*datetime="([^"]+)"/),
      url: rawUrl
        ? decodeEntities(rawUrl).split('?')[0]
        : `https://www.linkedin.com/jobs/view/${id}`,
    });
  }
  return jobs;
}

/**
 * Page through the guest search endpoint until `limit` jobs are collected.
 *
 * `hours` maps directly to LinkedIn's own `f_TPR=r<seconds>` filter, which is
 * applied server-side — a 1-hour request genuinely returns only jobs posted in
 * the last hour, so no client-side date filtering is needed.
 */
async function searchJobs({
  keywords,
  location = 'United States',
  geoId = '103644278',
  hours = 24,
  // Takes precedence over `hours` when given, so a caller can ask for a window
  // that isn't a whole number of hours (e.g. "since the last search").
  windowSeconds = null,
  limit = 25,
  startPage = 0,
  excludeIds = new Set(),
  onProgress = () => {},
  onWarning = () => {},
  shouldCancel = () => false,
}) {
  const collected = [];
  const seen = new Set(excludeIds);

  // Known-seen ids don't count toward `limit`, so a run that skips a lot has to
  // page further to still return `limit` fresh jobs. Capped regardless: guest
  // pagination gets unreliable past roughly ten pages.
  const maxPages = Math.min(
    Math.ceil((limit + excludeIds.size) / PAGE_SIZE) + 3,
    MAX_SEARCH_PAGES,
  );

  let page = startPage;
  let exhausted = false;
  // LinkedIn sometimes keeps serving the same cards past a certain offset. If
  // two pages running yield nothing we haven't already seen, treat the window
  // as spent rather than paging forever.
  let barrenPages = 0;
  // Jobs skipped because they were already logged from an earlier search.
  let skippedSeen = 0;

  // LinkedIn's own recency filter, in seconds. Floored at one minute — r0 is
  // meaningless and would return everything.
  const tpr = Math.max(
    60,
    Math.round(windowSeconds != null ? windowSeconds : hours * 3600),
  );

  for (; page < startPage + maxPages && collected.length < limit; page++) {
    if (shouldCancel()) break;
    const params = new URLSearchParams({
      keywords,
      location,
      geoId,
      f_TPR: `r${tpr}`,
      start: String(page * PAGE_SIZE),
    });

    const html = await fetchWithRetry(
      `${SEARCH_URL}?${params}`,
      `search page ${page + 1}`,
      onWarning,
    );
    const pageJobs = parseSearchPage(html);

    // An empty page means we've exhausted results for this time window.
    if (pageJobs.length === 0) {
      exhausted = true;
      page++; // this page is consumed; don't retry it on the next request
      break;
    }

    let added = 0;
    let skippedThisPage = 0;
    for (const job of pageJobs) {
      if (collected.length >= limit) break;
      if (seen.has(job.id)) {
        // Distinguish "you've seen this before" from a duplicate card inside
        // this same run — only the former means paging deeper is worthwhile.
        if (excludeIds.has(job.id)) {
          skippedSeen++;
          skippedThisPage++;
        }
        continue;
      }
      seen.add(job.id);
      collected.push(job);
      added++;
    }

    // A page full of already-seen jobs is expected, not a sign the window is
    // spent — keep paging. Only genuine in-run repeats count as barren.
    if (added === 0 && skippedThisPage === 0 && ++barrenPages >= 2) {
      exhausted = true;
      page++;
      break;
    }
    if (added > 0 || skippedThisPage > 0) barrenPages = 0;

    onProgress({
      phase: 'search',
      done: collected.length,
      total: limit,
      message: `Found ${collected.length} of ${limit} jobs…`,
    });

    if (page > startPage) await sleep(600);
  }

  // `nextPage` is where a follow-up "load more" should resume from.
  return { jobs: collected, nextPage: page, exhausted, skippedSeen };
}

/** Fetch one job's full description and its posted criteria. */
async function fetchJobDetail(id, onWarning = () => {}) {
  const html = await fetchWithRetry(`${DETAIL_URL}/${id}`, `job ${id}`, onWarning);

  // The description lives in a markup div inside <section class="show-more-less-html">.
  // Slice to the closing </section> rather than the first </div>, since the
  // description body itself can contain nested block elements.
  let description = '';
  const start = html.search(/class="[^"]*show-more-less-html__markup[^"]*"/);
  if (start !== -1) {
    const bodyStart = html.indexOf('>', start) + 1;
    const end = html.indexOf('</section>', bodyStart);
    description = htmlToText(
      html.slice(bodyStart, end === -1 ? bodyStart + 20000 : end),
    );
  } else {
    // Fallback for the alternate layout LinkedIn sometimes serves.
    description = htmlToText(
      match1(
        html,
        /class="[^"]*description__text[^"]*"[^>]*>([\s\S]*?)<\/section>/,
      ),
    );
  }

  // Strip the "show more"/"show less" affordance text that survives tag removal.
  description = description
    .replace(/\bShow (more|less)\b/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Criteria are <h3 subheader> / <span text> pairs: seniority, employment type, etc.
  const criteria = {};
  const pairRe =
    /class="[^"]*description__job-criteria-subheader[^"]*"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?class="[^"]*description__job-criteria-text[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
  let m;
  while ((m = pairRe.exec(html)) !== null) {
    const key = clean(m[1]);
    const value = clean(m[2]);
    if (key && value) criteria[key] = value;
  }

  return { description, criteria };
}

/**
 * Fetch descriptions for every job, in sequence and throttled.
 * A failed detail fetch is non-fatal: the job keeps its card data and is still
 * passed to the filter, flagged so you can see the filtering was less informed.
 */
async function enrichJobs(
  jobs,
  {
    onProgress = () => {},
    onWarning = () => {},
    shouldCancel = () => false,
  } = {},
) {
  for (let i = 0; i < jobs.length; i++) {
    // Stop promptly when the client has gone away, rather than working through
    // the whole list first.
    if (shouldCancel()) break;
    const job = jobs[i];
    try {
      const detail = await fetchJobDetail(job.id, onWarning);
      job.description = detail.description;
      job.criteria = detail.criteria;
      job.descriptionFetched = Boolean(detail.description);
      if (!job.description) {
        job.detailError = 'no description found in the response';
        onWarning(`"${job.title}": ${job.detailError}`);
      }
    } catch (err) {
      job.description = '';
      job.criteria = {};
      job.descriptionFetched = false;
      job.detailError = err.message;
      onWarning(`"${job.title}": ${err.message}`);
    }

    onProgress({
      phase: 'detail',
      done: i + 1,
      total: jobs.length,
      message: `Fetching descriptions ${i + 1}/${jobs.length}…`,
    });

    if (i < jobs.length - 1) await sleep(DETAIL_DELAY_MS);
  }
  return jobs;
}

module.exports = {
  searchJobs,
  fetchJobDetail,
  enrichJobs,
  // exported for testing
  parseSearchPage,
  htmlToText,
  clean,
};
