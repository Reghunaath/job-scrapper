# LinkedIn job scraper

A local single-page app that scrapes recent LinkedIn job postings and filters
them with Claude against requirements you write in `prompt.md`.

## Run it

Double-click **`run.bat`**. It starts the server and opens
<http://localhost:5173> in your browser. Leave the console window open while you
use the app; press `Ctrl+C` there to stop it.

Or from a terminal:

```sh
node server.js
```

Then open <http://localhost:5173>. There is no install step — no dependencies,
no build.

**Requirements:** Node 18+ (tested on 22) and the Claude Code CLI on your `PATH`.
Filtering runs through `claude -p` on your existing subscription, so no
`ANTHROPIC_API_KEY` is needed.

## Using it

Pick how many jobs to scrape and how recent they must be, then hit **Scrape**.
The time window maps to LinkedIn's own recency filter, so "last 1 hour" really
does return only jobs posted in the last hour.

**Since last search** measures the gap between now and when your previous
search started, rounds it **up** to the next whole minute, and uses that as the
window — so a search 37m20s after the last one asks LinkedIn for `f_TPR=r2280`
(38 minutes). Rounding up rather than to nearest is deliberate: rounding down
would leave a sliver at the start of the interval that no search ever covers,
whereas rounding up merely overlaps the previous window, and the seen-ids log
drops those repeats for free. The option is disabled until you
have run one search, is floored at one minute and capped at 24 hours, and
**Load more** keeps the window the visible results came from rather than
measuring a new, shorter one.

A line under the controls shows when the last search ran, how long ago that was,
and which window it used.

Matching jobs are listed first with Claude's one-line reasoning. Everything else
is collapsed behind a toggle.

**Load more** at the bottom fetches the next batch — the same number set in "How
many jobs" — and adds it to what's already on screen. It resumes from the search
page the last run stopped at, so it never re-fetches or re-filters jobs you
already have. Existing results keep their position; new ones are appended within
their group. The button hides itself once LinkedIn has no more results for that
search. Changing the keywords or time window starts a fresh list.

## Skipping jobs you have already seen

Every job id a search returns is logged to `seen-jobs.json`, and later searches
skip anything already in that log. Ids expire after 24 hours, so a posting you
saw yesterday can resurface today.

Ids are logged at search time, before any other filtering, so a job dropped by
the blacklist or rejected by Claude also stays gone for the next 24 hours rather
than being re-fetched and re-judged.

Skipped jobs do not count toward the number you asked for — the search pages
deeper to still return a full batch of new ones (capped at
`MAX_SEARCH_PAGES` in `lib/linkedin.js`, since guest pagination gets unreliable
past roughly ten pages). Each run reports how many it skipped.

To start over and allow everything through again, delete `seen-jobs.json`.

## Blacklisting companies

Put one company per line in `blacklist.txt`. Their jobs are dropped straight
after the search — the description is never fetched and nothing is sent to
Claude, so a blacklisted company costs neither a request nor a filter call. They
do not appear in the results, and the run reports how many were skipped.

Matching ignores case, punctuation and legal suffixes, so a single line reading
`Cummins` blocks "Cummins", "Cummins Inc." and "CUMMINS, INC". Matching is on
whole words, which keeps `Apple` from also blocking "Applebee's" — the tradeoff
is that `Melson Tech` will not block "Melson Technologies", so prefer the
shortest distinctive form of a name. `#` starts a comment.

The file is re-read on every scrape, so save and scrape again — no restart. If
every job found was blacklisted, **Load more** keeps looking further down the
search results.

## When something goes wrong

Request errors are surfaced in the UI rather than hidden in the console:

- **Fatal errors** (the search itself fails) appear in red on the status line.
- **Non-fatal problems** — a retried request, an unreachable job page, a failed
  filter batch — collect into an amber **"N request issues during this run"**
  panel above the results. It streams in live and stays collapsed until you
  click Show. If nothing goes wrong, the panel never appears.
- **Per-job failures** appear on the job itself: a job whose description
  couldn't be fetched shows the reason inline and is flagged as judged on title
  and company alone. A job Claude couldn't classify shows "Not filtered" with
  the underlying error as its reason.

Everything is also logged to the server console.

## Changing what counts as a match

Edit `prompt.md`. Everything below the `---` divider is sent to Claude as the
system prompt. It is re-read on every scrape, so save the file and scrape again —
no restart needed.

## Configuration

| What | Where |
|---|---|
| Model | `MODEL` at the top of `lib/filter.js` (default `claude-sonnet-5`; `claude-haiku-4-5` is faster and cheaper) |
| Jobs per Claude call | `BATCH_SIZE` in `lib/filter.js` |
| Batches filtered at once | `FILTER_CONCURRENCY` env var, default 4 (`FILTER_CONCURRENCY=1` for sequential) |
| Description length sent to Claude | Not limited — full descriptions are sent, so no-sponsorship and citizenship clauses at the end of a posting are always visible |
| Delay between detail fetches | `DETAIL_DELAY_MS` in `lib/linkedin.js` |
| Per-request timeout | `REQUEST_TIMEOUT_MS` in `lib/linkedin.js` |
| Port | `PORT` env var, default 5173 |

## How it works

```
lib/linkedin.js   search + detail fetch, HTML parsing, throttle and retry
lib/blacklist.js  company blacklist parsing and matching
lib/seen.js       24-hour log of job ids already returned
lib/filter.js     batches jobs -> `claude -p` -> match verdicts
server.js         HTTP routes, SSE progress stream
public/index.html the entire frontend
```

Scraping uses LinkedIn's public guest endpoints — the same ones an anonymous
browser hits. No login and no credentials are involved. They are rate limited,
so detail fetches are throttled to roughly one per 1.2 s and back off on HTTP
429.

A 50-job run takes roughly three minutes. Filtering batches run in parallel —
four at a time by default — which measured about 2.8x faster than sequential on
a 32-job run (126s to 45s) with identical verdicts.

## Notes and limits

- **Results are not persisted.** Scraped jobs live in memory and are lost when
  the server stops. The one thing written to disk is `seen-jobs.json`, the
  24-hour log of job ids — that has to outlive a restart to mean anything.
- **A failed detail fetch is not fatal.** The job still gets filtered on its
  title, company and location, and is flagged in the UI as judged on less
  information.
- **If Claude is unavailable**, jobs still list, marked "Not filtered" with the
  underlying error as the reason, rather than the run failing.
- **LinkedIn's markup is not a contract.** If it changes, the parsers in
  `lib/linkedin.js` need updating. Each field is extracted independently, so a
  change breaks one field rather than the whole scrape.
