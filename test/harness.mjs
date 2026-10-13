// Loads segment-retry.user.js into this Node process with a scripted fake
// network, so XHR and fetch retry behaviour can be asserted without a browser.
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../segment-retry.user.js', import.meta.url), 'utf8');
const SPEEDUP = 100; // backoff 500 ms -> 5 ms

if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.lengthComputable = !!init.lengthComputable;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  };
}

// One entry per request the page (or the script) sends:
//   'ok' | 'cut' | 'neterr' | a number (HTTP status with a small body)
export const network = { plan: [], sent: [] };
const FULL = 1000;

function nextOutcome() {
  return network.plan.length ? network.plan.shift() : 'ok';
}

export class FakeXHR extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.status = 0;
    this.statusText = '';
    this.response = null;
    this.responseType = '';
    this.timeout = 0;
    this.withCredentials = false;
    this._headers = {};
    this._resHeaders = {};
    this._timer = null;
  }
  _fire(type, init) {
    const ev = init ? new ProgressEvent(type, init) : new Event(type);
    this['on' + type]?.(ev);
    this.dispatchEvent(ev);
  }
  _state(rs) { this.readyState = rs; this._fire('readystatechange'); }
  open(method, url) { this._method = method; this._url = url; this._state(1); }
  setRequestHeader(k, v) { this._headers[k] = v; }
  overrideMimeType() {}
  getResponseHeader(n) { return this._resHeaders[n.toLowerCase()] ?? null; }
  getAllResponseHeaders() { return ''; }
  send() {
    const outcome = nextOutcome();
    network.sent.push({ method: this._method, url: this._url, headers: { ...this._headers }, responseType: this.responseType, outcome });
    this._fire('loadstart', { loaded: 0, total: 0 });
    this._timer = setTimeout(() => {
      this._timer = null;
      if (outcome === 'neterr' || outcome === 'timeout') {
        this._state(4);
        this._fire(outcome === 'neterr' ? 'error' : 'timeout', { loaded: 0, total: 0 });
        this._fire('loadend', { loaded: 0, total: 0 });
        return;
      }
      const status = typeof outcome === 'number' ? outcome : 200;
      const got = outcome === 'cut' ? 600 : status === 200 ? FULL : 10;
      this.status = status;
      this._resHeaders = { 'content-length': String(status === 200 ? FULL : 10) };
      this._state(2);
      this._state(3);
      this._fire('progress', { lengthComputable: true, loaded: got, total: FULL });
      this.response = this.responseType === 'arraybuffer' ? new ArrayBuffer(got) : 'x'.repeat(got);
      this._state(4);
      this._fire('load', { loaded: got, total: FULL });
      this._fire('loadend', { loaded: got, total: FULL });
    }, 1);
  }
  abort() {
    if (!this._timer) return;
    clearTimeout(this._timer);
    this._timer = null;
    this._state(4);
    this._fire('abort', { loaded: 0, total: 0 });
    this._fire('loadend', { loaded: 0, total: 0 });
    this.readyState = 0;
  }
}

export async function fakeFetch(input, init) {
  const outcome = nextOutcome();
  const url = input instanceof Request ? input.url : String(input);
  network.sent.push({ method: init?.method || 'GET', url, outcome });
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (outcome === 'neterr') throw new TypeError('Failed to fetch');
  const body = new Uint8Array(outcome === 'cut' ? 600 : typeof outcome === 'number' ? 10 : FULL);
  const status = typeof outcome === 'number' ? outcome : 200;
  const headers = {};
  if (outcome === 'big') headers['content-length'] = String(50 * 1024 * 1024);
  else if (outcome !== 'nolength') headers['content-length'] = String(status === 200 ? FULL : 10);
  const res = new Response(status === 204 ? null : body, { status, headers });
  Object.defineProperty(res, 'url', { value: url });
  Object.defineProperty(res, 'redirected', { value: true });
  network.lastResponse = res;
  return res;
}

export const logs = [];

// Installs the fakes as the page's globals, then runs the userscript once.
export function loadScript(href = 'https://test.local/watch', { fetch = fakeFetch } = {}) {
  globalThis.window = globalThis;
  const u = new URL(href);
  globalThis.location = { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname };
  globalThis.XMLHttpRequest = FakeXHR;
  globalThis.fetch = fetch;
  globalThis.MediaSource = class MediaSource { addSourceBuffer(mime) { return { mime }; } };
  const fastSetTimeout = (fn, ms, ...a) => setTimeout(fn, Math.ceil((ms || 0) / SPEEDUP), ...a);
  const realWarn = console.warn;
  const cons = { ...console, warn: (...a) => { if (a[0] === '[segment-retry]') logs.push(a.slice(1).join(' ')); else realWarn(...a); } };
  new Function('setTimeout', 'console', SRC)(fastSetTimeout, cons);
}

export function startStreaming() {
  new MediaSource().addSourceBuffer('video/mp2t; codecs="avc1.42E01E"');
}

export function reset(plan = []) {
  network.plan = [...plan];
  network.sent = [];
  logs.length = 0;
}

// Sends one XHR the way hls.js does and records everything the page observes.
export function pageXhr({ method = 'GET', url = 'https://cdn.test/v/seg1.ts', responseType = 'arraybuffer', headers = {}, abortAfterMs } = {}) {
  const xhr = new XMLHttpRequest();
  const seen = { events: [], states: [], statuses: [], onload: 0, targetOK: [] };
  return new Promise((resolve) => {
    xhr.onreadystatechange = (e) => {
      seen.states.push(xhr.readyState);
      if (xhr.readyState >= 2) seen.statuses.push(xhr.status);
      seen.targetOK.push(e.target === xhr && e.currentTarget === xhr);
    };
    xhr.onload = (e) => { seen.onload++; seen.targetOK.push(e.target === xhr && e.target.response === xhr.response); };
    for (const t of ['loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend']) {
      xhr.addEventListener(t, () => {
        seen.events.push(t);
        if (t === 'loadend') {
          const r = xhr.response;
          resolve({ xhr, seen, status: xhr.status, bytes: r instanceof ArrayBuffer ? r.byteLength : r?.length ?? null });
        }
      });
    }
    xhr.open(method, url, true);
    xhr.responseType = responseType;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.send();
    if (abortAfterMs === 0) xhr.abort(); // in flight, before any response
    else if (abortAfterMs != null) setTimeout(() => xhr.abort(), abortAfterMs);
  });
}
