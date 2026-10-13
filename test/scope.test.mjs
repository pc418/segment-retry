import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, FakeXHR, fakeFetch } from './harness.mjs';

// Runs the script as a page on `href` and reports whether it touched anything.
function patched(href) {
  loadScript(href);
  const nativeAdd = globalThis.MediaSource.prototype.addSourceBuffer;
  return {
    xhr: globalThis.XMLHttpRequest !== FakeXHR,
    fetch: globalThis.fetch !== fakeFetch,
    mse: nativeAdd.toString().includes('streaming'),
  };
}
const NONE = { xhr: false, fetch: false, mse: false };
const ALL = { xhr: true, fetch: true, mse: true };

// PIN: owner 2026-10-13 — the script never runs on the big platforms (they
// have their own players); each frame is judged by its own URL.
// docs/261013-fix-perf-big_sites-scope.md
test('big platforms and their embeds are left untouched', () => {
  for (const href of [
    'https://www.youtube.com/watch?v=abc', 'https://youtube.com/', 'https://m.youtube.com/',
    'https://www.youtube-nocookie.com/embed/abc', 'https://x.com/a/status/1', 'https://twitter.com/',
    'https://platform.twitter.com/embed/Tweet.html', 'https://www.netflix.com/watch/1',
    'https://www.twitch.tv/x', 'https://player.vimeo.com/video/1', 'https://www.bilibili.com/video/BV1',
    'https://www.reddit.com/r/videos', 'https://WWW.YOUTUBE.COM/', 'https://www.youtube.com./',
  ]) assert.deepEqual(patched(href), NONE, href);
});

test('lookalike hosts and small video sites still get retries', () => {
  for (const href of [
    'https://notyoutube.com/', 'https://youtube.com.example.net/', 'https://x.company.com/',
    'https://small-video.example/play/1', 'http://192.168.1.5:8080/live.html',
  ]) assert.deepEqual(patched(href), ALL, href);
});

test('non-http documents (about:blank, data:, blob:) are left untouched', () => {
  for (const href of ['about:blank', 'data:text/html,hi', 'blob:https://small-video.example/1'])
    assert.deepEqual(patched(href), NONE, href);
});

test('before any video, fetch hands back the native call result unchanged', () => {
  const calls = [];
  const sentinel = Promise.resolve('native');
  loadScript('https://small-video.example/', { fetch: function (...a) { calls.push({ self: this, a }); return sentinel; } });
  const init = { method: 'GET' };
  const self = {};
  assert.equal(globalThis.fetch.call(self, 'https://cdn.test/v/seg1.ts', init), sentinel);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].self, self);
  assert.deepEqual(calls[0].a, ['https://cdn.test/v/seg1.ts', init]);
});
