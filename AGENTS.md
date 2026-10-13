# segment-retry — agent guide

Single-file userscript (`segment-retry.user.js`) that retries failed or
truncated video segment downloads so web players (hls.js, video.js VHS,
dash.js, shaka) don't gap-skip or stall. Public repo; published on GitHub and
Greasy Fork (Greasy Fork syncs from the raw GitHub URL).

## Layout

- `segment-retry.user.js` — the whole product. Header metadata is read by
  Tampermonkey/Violentmonkey and Greasy Fork; bump `@version` on every release
  (installed copies only update when it increases).
- `test/harness.mjs` — loads the script into Node with a scripted fake XHR and
  fetch network (`network.plan`: `'ok' | 'cut' | 'neterr' | <status>`), backoff
  sped up 100x via an injected `setTimeout`.
- `test/xhr.test.mjs`, `test/fetch.test.mjs`, `test/scope.test.mjs` — behaviour
  tests. `npm test`.
- `docs/` — dated engineering records (`yymmdd-type-name.md`).

## Invariants

1. Idle until streaming: before a page creates a MediaSource SourceBuffer, the
   `XMLHttpRequest` constructor returns the browser's own instance and `fetch`
   passes straight through. Do not add work to the pre-detection path.
2. The page must see one request: exactly one `readystatechange` to DONE, one
   terminal event (`load`/`error`/`timeout`/`abort`), one `loadend`. Retries are
   invisible except for time and progress events.
3. Retry only idempotent media GETs: responseType `arraybuffer`/`blob` or a
   segment-looking URL. Never POST, never sync XHR.
4. Retry on status 0, 408, 429, 5xx, or a 2xx body shorter than Content-Length.
   Never on other 4xx. After `MAX_TRIES` the last real outcome is passed through.
5. `instanceof XMLHttpRequest` stays true for both wrapped and plain instances.
6. No network calls of its own, no storage, `@grant none`.
7. Never runs on the big platforms (YouTube, X/Twitter, Netflix, Twitch, …):
   `SKIP_ROOTS` at the top of the IIFE returns before any global is touched,
   mirrored by `@exclude` apex + subdomain pairs in the header. Keep the two
   lists in sync. Each frame is judged by its own URL; non-http(s) frames are
   skipped.
8. Until a video streams, `fetch` is a plain pass-through that returns the
   native call's promise itself (no async wrapper).

## Verification

- `npm test` (Node 20+, no dependencies).
- Browser check: inject a fault (every Nth `.ts` XHR redirected to an
  unreachable URL), step playback through the video while paused, and compare
  `video.buffered` ranges with and without the script. Method and numbers:
  `docs/260926-feat-segment-retry.md`.
