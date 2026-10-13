// ==UserScript==
// @name         Video Segment Retry — stop HLS/DASH skips and stalls
// @name:zh-CN   视频分片重试 — 防止 HLS/DASH 跳秒和卡顿
// @namespace    https://github.com/pc418/segment-retry
// @version      1.0.1
// @description  Retries video segment downloads that fail or arrive cut short, so the player doesn't jump over (or freeze at) the missing seconds. Works under any web player (hls.js, video.js, dash.js, shaka). Idle until a page starts streaming video; never runs on the big platforms (YouTube, X, Netflix, Twitch, …), which have their own players.
// @description:zh-CN 视频分片下载失败或被截断时自动重试，避免播放器跳过（或卡在）缺失的几秒。适用于 hls.js、video.js、dash.js、shaka 等任意网页播放器；页面开始播放流媒体前不做任何事；不在 YouTube、X、Netflix、Twitch 等大平台运行。
// @author       pc418
// @license      MIT
// @homepageURL  https://github.com/pc418/segment-retry
// @supportURL   https://github.com/pc418/segment-retry/issues
// @match        *://*/*
// @exclude      *://youtube.com/*
// @exclude      *://*.youtube.com/*
// @exclude      *://youtube-nocookie.com/*
// @exclude      *://*.youtube-nocookie.com/*
// @exclude      *://youtu.be/*
// @exclude      *://*.youtu.be/*
// @exclude      *://x.com/*
// @exclude      *://*.x.com/*
// @exclude      *://twitter.com/*
// @exclude      *://*.twitter.com/*
// @exclude      *://twimg.com/*
// @exclude      *://*.twimg.com/*
// @exclude      *://netflix.com/*
// @exclude      *://*.netflix.com/*
// @exclude      *://twitch.tv/*
// @exclude      *://*.twitch.tv/*
// @exclude      *://tiktok.com/*
// @exclude      *://*.tiktok.com/*
// @exclude      *://facebook.com/*
// @exclude      *://*.facebook.com/*
// @exclude      *://instagram.com/*
// @exclude      *://*.instagram.com/*
// @exclude      *://bilibili.com/*
// @exclude      *://*.bilibili.com/*
// @exclude      *://bilibili.tv/*
// @exclude      *://*.bilibili.tv/*
// @exclude      *://vimeo.com/*
// @exclude      *://*.vimeo.com/*
// @exclude      *://dailymotion.com/*
// @exclude      *://*.dailymotion.com/*
// @exclude      *://primevideo.com/*
// @exclude      *://*.primevideo.com/*
// @exclude      *://disneyplus.com/*
// @exclude      *://*.disneyplus.com/*
// @exclude      *://hulu.com/*
// @exclude      *://*.hulu.com/*
// @exclude      *://max.com/*
// @exclude      *://*.max.com/*
// @exclude      *://hbomax.com/*
// @exclude      *://*.hbomax.com/*
// @exclude      *://kick.com/*
// @exclude      *://*.kick.com/*
// @exclude      *://reddit.com/*
// @exclude      *://*.reddit.com/*
// @exclude      *://redditmedia.com/*
// @exclude      *://*.redditmedia.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // Big platforms run their own players and CDNs: leave them alone. Each
  // frame is judged by its own URL, so a YouTube embed is skipped while the
  // small site around it is not. Mirrors the @exclude lines above for
  // managers that ignore them.
  const SKIP_ROOTS = [
    'youtube.com',
    'youtube-nocookie.com',
    'youtu.be',
    'x.com',
    'twitter.com',
    'twimg.com',
    'netflix.com',
    'twitch.tv',
    'tiktok.com',
    'facebook.com',
    'instagram.com',
    'bilibili.com',
    'bilibili.tv',
    'vimeo.com',
    'dailymotion.com',
    'primevideo.com',
    'disneyplus.com',
    'hulu.com',
    'max.com',
    'hbomax.com',
    'kick.com',
    'reddit.com',
    'redditmedia.com',
  ];
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  const host = location.hostname.toLowerCase().replace(/\.$/, '');
  if (SKIP_ROOTS.some((d) => host === d || host.endsWith('.' + d))) return;

  const MAX_TRIES = 6;       // attempts per segment, first one included
  const BASE_DELAY_MS = 500; // backoff: 0.5 s, 1 s, 2 s, 4 s, 8 s
  const MAX_FETCH_BUFFER = 32 * 1024 * 1024; // larger fetch bodies stream through unchecked
  // Media-segment URLs. XHRs with responseType arraybuffer/blob count too, which
  // catches players that disguise segments as .jpg/.png/.html.
  const SEGMENT_URL = /\.(ts|m4s|mp4|m4v|m4a|aac|mp3|cmfv|cmfa|webm|vtt)(?:[?#]|$)/i;

  const log = (...a) => console.warn('[segment-retry]', ...a);
  const delayFor = (attempt) => BASE_DELAY_MS * 2 ** (attempt - 1);

  // ------------------------------------------------------ video detector ----
  // Streaming players (hls.js, video.js, dash.js, shaka) all feed <video>
  // through Media Source Extensions. Until this frame creates a SourceBuffer,
  // XMLHttpRequest and fetch behave exactly like the browser's own.
  let streaming = false;
  for (const name of ['MediaSource', 'ManagedMediaSource', 'WebKitMediaSource']) {
    const proto = window[name]?.prototype;
    const add = proto?.addSourceBuffer;
    if (!add) continue;
    proto.addSourceBuffer = function (mime) {
      if (!streaming) {
        streaming = true;
        log(`streaming video detected (${mime}); segment retries on in ${location.host}`);
      }
      return add.apply(this, arguments);
    };
  }

  function retryableStatus(s) {
    return s === 0 || s === 408 || s === 429 || s >= 500;
  }

  // A 2xx body shorter than its Content-Length was cut off in transit.
  function shortBody(got, header) {
    if (got == null) return null;
    const len = parseInt(header('content-length'), 10);
    if (!(len > got)) return null;
    if (header('content-encoding')) return null; // Content-Length counts compressed bytes
    return `cut off (${got} of ${len} bytes)`;
  }

  function isSegmentRequest(method, url, responseType) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return false;
    if (/^(blob|data):/i.test(url)) return false;
    return responseType === 'arraybuffer' || responseType === 'blob' || SEGMENT_URL.test(url);
  }

  // ---------------------------------------------------------------- XHR ----
  const NativeXHR = window.XMLHttpRequest;
  const EVENTS = ['readystatechange', 'loadstart', 'progress', 'abort', 'error', 'timeout', 'load', 'loadend'];
  const PROPS = ['responseType', 'timeout', 'withCredentials'];

  // Looks like an XHR to the page. Events from the real request are forwarded
  // as they happen, except the final ones: those are held until we know the
  // download is complete, and a failed or cut-off segment is fetched again on
  // a fresh XHR first. The page sees one request that just took longer.
  class RetryXHR extends EventTarget {
    constructor() {
      if (!streaming) return new NativeXHR(); // no video yet: plain browser XHR
      super();
      this._handlers = {};
      this._props = {};
      this._headers = [];
      this._mime = null;
      this._rs = 0;
      this._x = this._wire(new NativeXHR());
      this._shown = null; // the attempt whose status and headers the page may read
    }

    _wire(x) {
      for (const t of EVENTS) x.addEventListener(t, (e) => { if (x === this._x) this._onInner(t, e, x); });
      return x;
    }

    _emit(type, src) {
      const ev = src && 'loaded' in src
        ? new ProgressEvent(type, { lengthComputable: src.lengthComputable, loaded: src.loaded, total: src.total })
        : new Event(type);
      this.dispatchEvent(ev);
    }

    // An attempt whose status already means it will be retried stays hidden:
    // no HEADERS_RECEIVED/LOADING, no progress, its status never readable.
    _doomed(x) {
      return retryableStatus(x.status) && this._tries < this._maxTries && !this._aborted;
    }

    _onInner(type, e, x) {
      if (type === 'readystatechange') {
        // DONE is held until load/error/timeout/abort decides whether to retry.
        if (x.readyState >= 2) {
          if (this._doomed(x)) return;
          this._shown = x;
        }
        if (x.readyState < 4 && x.readyState > this._rs) { this._rs = x.readyState; this._emit(type); }
        return;
      }
      if (type === 'loadstart') { if (!this._started) { this._started = true; this._emit(type, e); } return; }
      if (type === 'progress') { if (!this._doomed(x)) this._emit(type, e); return; }
      if (type === 'loadend') return; // emitted by _finish

      let reason = null;
      if (type === 'error') reason = 'network error';
      if (type === 'load') {
        if (retryableStatus(x.status)) reason = 'HTTP ' + x.status;
        else if (x.status >= 200 && x.status < 300) {
          const r = x.response;
          const got = r instanceof ArrayBuffer ? r.byteLength : r instanceof Blob ? r.size : null;
          reason = shortBody(got, (n) => x.getResponseHeader(n));
        }
      }
      if (reason && !this._aborted && this._tries < this._maxTries) this._retry(reason);
      else this._finish(type, e);
    }

    _retry(reason) {
      const attempt = this._tries++;
      const wait = delayFor(attempt);
      log(`${reason}; retry ${attempt}/${this._maxTries - 1} in ${wait} ms:`, this._url);
      this._timer = setTimeout(() => {
        this._timer = 0;
        if (this._aborted) return;
        const x = this._wire(new NativeXHR());
        this._x = x;
        x.open(...this._openArgs);
        for (const p of PROPS) if (p in this._props) x[p] = this._props[p];
        if (this._mime) x.overrideMimeType(this._mime);
        for (const [k, v] of this._headers) x.setRequestHeader(k, v);
        x.send(this._body);
      }, wait);
    }

    _finish(type, e) {
      if (this._tries > 1 && type === 'load') log(`recovered after ${this._tries - 1} retr${this._tries > 2 ? 'ies' : 'y'}:`, this._url);
      this._shown = this._x;
      this._rs = 4;
      this._emit('readystatechange');
      this._emit(type, e);
      this._emit('loadend', e);
      if (type === 'abort' && this._rs === 4) this._rs = 0; // aborted requests end UNSENT, unless reopened
    }

    open(method, url, async) {
      if (this._timer) { clearTimeout(this._timer); this._timer = 0; }
      this._openArgs = Array.from(arguments);
      this._method = method;
      this._url = String(url);
      this._async = async !== false;
      this._headers = [];
      this._rs = 0;
      this._started = false;
      this._aborted = false;
      this._x.open(...this._openArgs);
      this._shown = null;
    }

    send(body) {
      this._body = body;
      this._tries = 1;
      this._maxTries = this._async && isSegmentRequest(this._method, this._url, this._props.responseType) ? MAX_TRIES : 1;
      this._x.send(body);
    }

    abort() {
      this._aborted = true;
      if (this._timer) { // between attempts: nothing in flight to abort
        clearTimeout(this._timer);
        this._timer = 0;
        // report an empty aborted request, not the discarded failed attempt
        this._x = this._wire(new NativeXHR());
        if ('responseType' in this._props) this._x.responseType = this._props.responseType;
        this._finish('abort', null);
        return;
      }
      this._x.abort();
    }

    setRequestHeader(k, v) { this._headers.push([k, v]); this._x.setRequestHeader(k, v); }
    overrideMimeType(m) { this._mime = m; this._x.overrideMimeType(m); }
    getResponseHeader(n) { return this._shown ? this._shown.getResponseHeader(n) : null; }
    getAllResponseHeaders() { return this._shown ? this._shown.getAllResponseHeaders() : ''; }

    get readyState() { return this._rs; }
    get status() { return this._shown ? this._shown.status : 0; }
    get statusText() { return this._shown ? this._shown.statusText : ''; }
    get response() { return this._x.response; }
    get responseText() { return this._x.responseText; }
    get responseXML() { return this._x.responseXML; }
    get responseURL() { return this._shown ? this._shown.responseURL : ''; }
    get upload() { return this._x.upload; }
  }

  for (const p of PROPS) {
    Object.defineProperty(RetryXHR.prototype, p, {
      get() { return this._x[p]; },
      set(v) { this._x[p] = v; this._props[p] = v; },
    });
  }
  // on-handlers are real listeners, added where the page first sets them (as
  // native event handlers are), so they run in order with event.target set.
  for (const t of EVENTS) {
    Object.defineProperty(RetryXHR.prototype, 'on' + t, {
      get() { return this._handlers[t]?.fn ?? null; },
      set(fn) {
        const slot = this._handlers[t];
        if (typeof fn !== 'function') {
          if (slot) { this.removeEventListener(t, slot.listener); delete this._handlers[t]; }
          return;
        }
        if (slot) { slot.fn = fn; return; }
        const entry = { fn, listener: (e) => entry.fn.call(this, e) };
        this._handlers[t] = entry;
        this.addEventListener(t, entry.listener);
      },
    });
  }
  // `xhr instanceof XMLHttpRequest` stays true for the plain ones too.
  Object.defineProperty(RetryXHR, Symbol.hasInstance, {
    value: (o) => o instanceof NativeXHR || RetryXHR.prototype.isPrototypeOf(o),
  });
  ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach((k, i) => {
    RetryXHR[k] = i;
    RetryXHR.prototype[k] = i;
  });

  window.XMLHttpRequest = RetryXHR;

  // -------------------------------------------------------------- fetch ----
  const nativeFetch = window.fetch;

  // A rebuilt Response carries the original's url/redirected/type, clones too.
  function withMeta(out, res) {
    for (const k of ['url', 'redirected', 'type']) Object.defineProperty(out, k, { value: res[k] });
    Object.defineProperty(out, 'clone', { value: () => withMeta(Response.prototype.clone.call(out), res) });
    return out;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
    });
  }

  // Plain (not async) so that, until a video streams, fetch costs one check.
  window.fetch = function (input, init) {
    if (!streaming) return nativeFetch.apply(this, arguments);
    const isReq = input instanceof Request;
    const url = isReq ? input.url : String(input);
    const method = init?.method || (isReq ? input.method : 'GET');
    if (!(String(method).toUpperCase() === 'GET' && !/^(blob|data):/i.test(url) && SEGMENT_URL.test(url))) {
      return nativeFetch.apply(this, arguments);
    }
    return retryFetch.call(this, input, init, isReq, url);
  };

  async function retryFetch(input, init, isReq, url) {
    const signal = init?.signal || (isReq ? input.signal : undefined);

    for (let attempt = 1; ; attempt++) {
      const last = attempt >= MAX_TRIES;
      let reason;
      try {
        const res = await nativeFetch.call(this, isReq ? input.clone() : input, init);
        const recovered = () => { if (attempt > 1) log(`recovered after ${attempt - 1} retr${attempt > 2 ? 'ies' : 'y'}:`, url); };
        const len = parseInt(res.headers.get('content-length'), 10);
        if (retryableStatus(res.status) && !last) {
          reason = 'HTTP ' + res.status;
          res.body?.cancel().catch(() => {});
        } else if (res.status !== 200 && res.status !== 206) {
          return res;
        } else if (!(len > 0 && len <= MAX_FETCH_BUFFER) || res.headers.get('content-encoding')) {
          // Only a segment-sized body of known length can be checked. Whole
          // files and unknown lengths stream through as the native Response.
          recovered();
          return res;
        } else {
          // Buffer the segment so a cut-off body is caught here.
          const buf = await res.arrayBuffer();
          reason = shortBody(buf.byteLength, (n) => res.headers.get(n));
          if (!reason || last) {
            if (!reason) recovered();
            return withMeta(new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers }), res);
          }
        }
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError' || last) throw err;
        reason = 'network error';
      }
      const wait = delayFor(attempt);
      log(`${reason}; retry ${attempt}/${MAX_TRIES - 1} in ${wait} ms:`, url);
      await sleep(wait, signal);
    }
  }
})();
