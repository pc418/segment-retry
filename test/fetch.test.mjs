import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, startStreaming, reset, network, logs } from './harness.mjs';

loadScript();

test('before any video: fetch is passed straight through', async () => {
  reset(['cut']);
  const r = await fetch('https://cdn.test/v/seg1.ts');
  assert.equal(network.sent.length, 1);
  assert.equal((await r.arrayBuffer()).byteLength, 600);
});

test('cut-off, network error and 503 are retried until the full body arrives', async () => {
  startStreaming();
  reset(['cut', 'neterr', 503, 'ok']);
  const r = await fetch('https://cdn.test/v/seg2.m4s');
  assert.equal(network.sent.length, 4);
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 1000);
  assert.match(logs.join('\n'), /recovered after 3 retries/);
});

test('the rebuilt Response keeps url, redirected, type and headers', async () => {
  reset(['cut', 'ok']);
  const r = await fetch('https://cdn.test/v/seg3.ts');
  assert.notEqual(r, network.lastResponse, 'rebuilt after checking the body');
  assert.equal(r.url, 'https://cdn.test/v/seg3.ts');
  assert.equal(r.redirected, true);
  assert.equal(r.type, network.lastResponse.type);
  assert.equal(r.headers.get('content-length'), '1000');
  const c = r.clone();
  assert.equal(c.url, 'https://cdn.test/v/seg3.ts', 'clone keeps url');
  assert.equal(c.redirected, true, 'clone keeps redirected');
  assert.equal((await c.arrayBuffer()).byteLength, 1000);
});

test('large or unknown-length bodies stream through as the native Response', async () => {
  reset(['big']);
  let r = await fetch('https://cdn.test/movie.mp4');
  assert.equal(r, network.lastResponse, 'same object, not buffered');

  reset(['nolength']);
  r = await fetch('https://cdn.test/v/seg9.ts');
  assert.equal(r, network.lastResponse);
});

test('404 is returned as-is', async () => {
  reset([404]);
  const r = await fetch('https://cdn.test/v/seg4.ts');
  assert.equal(network.sent.length, 1);
  assert.equal(r.status, 404);
});

test('non-segment URLs and POST are untouched', async () => {
  reset(['neterr']);
  await assert.rejects(fetch('https://api.test/data.json'), TypeError);
  assert.equal(network.sent.length, 1);

  reset(['neterr']);
  await assert.rejects(fetch('https://cdn.test/v/seg5.ts', { method: 'POST' }), TypeError);
  assert.equal(network.sent.length, 1);
});

test('gives up after 6 attempts with the original error', async () => {
  reset(Array(10).fill('neterr'));
  await assert.rejects(fetch('https://cdn.test/v/seg6.ts'), TypeError);
  assert.equal(network.sent.length, 6);
});

test('abort during the backoff wait rejects with AbortError and stops', async () => {
  reset(['neterr', 'ok']);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 2);
  await assert.rejects(fetch('https://cdn.test/v/seg7.ts', { signal: ac.signal }), { name: 'AbortError' });
  assert.equal(network.sent.length, 1);
});
