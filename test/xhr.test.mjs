import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeXHR, loadScript, startStreaming, reset, pageXhr, network, logs } from './harness.mjs';

loadScript();

test('before any video: XMLHttpRequest is the browser original, untouched', async () => {
  reset(['cut']);
  const xhr = new XMLHttpRequest();
  assert.ok(Object.getPrototypeOf(xhr) === FakeXHR.prototype, 'plain native instance');
  assert.ok(xhr instanceof XMLHttpRequest);
  const r = await pageXhr();
  assert.equal(network.sent.length, 1, 'no retry before streaming');
  assert.equal(r.bytes, 600, 'short body handed through as-is');
});

test('detector: a SourceBuffer turns retries on, instanceof still holds', () => {
  startStreaming();
  const xhr = new XMLHttpRequest();
  assert.notEqual(Object.getPrototypeOf(xhr), FakeXHR.prototype, 'wrapped instance');
  assert.ok(xhr instanceof XMLHttpRequest);
  assert.equal(XMLHttpRequest.DONE, 4);
  assert.equal(xhr.DONE, 4);
  assert.match(logs.join('\n'), /streaming video detected/);
});

test('network error then success: page sees one clean successful request', async () => {
  reset(['neterr', 'ok']);
  const r = await pageXhr({ headers: { Range: 'bytes=0-999' } });
  assert.equal(network.sent.length, 2);
  assert.equal(r.status, 200);
  assert.equal(r.bytes, 1000);
  assert.deepEqual(r.seen.events.filter((e) => e !== 'progress'), ['loadstart', 'load', 'loadend']);
  assert.equal(r.seen.onload, 1, 'onload handler called once');
  assert.deepEqual(r.seen.states, [1, 2, 3, 4], 'readyState climbs once, DONE once');
  assert.deepEqual(network.sent[1].headers, { Range: 'bytes=0-999' }, 'headers re-applied on retry');
  assert.equal(network.sent[1].responseType, 'arraybuffer', 'responseType re-applied on retry');
  assert.match(logs.join('\n'), /network error; retry 1\/5/);
  assert.match(logs.join('\n'), /recovered after 1 retry/);
});

test('cut-off body (shorter than Content-Length) is fetched again', async () => {
  reset(['cut', 'cut', 'ok']);
  const r = await pageXhr();
  assert.equal(network.sent.length, 3);
  assert.equal(r.bytes, 1000);
  assert.deepEqual(r.seen.states.filter((s) => s === 4), [4]);
  assert.match(logs.join('\n'), /cut off \(600 of 1000 bytes\)/);
});

test('5xx is retried; 404 is not', async () => {
  reset([503, 'ok']);
  let r = await pageXhr();
  assert.equal(network.sent.length, 2);
  assert.equal(r.status, 200);

  reset([404]);
  r = await pageXhr();
  assert.equal(network.sent.length, 1);
  assert.equal(r.status, 404);
  assert.deepEqual(r.seen.events.filter((e) => e !== 'progress'), ['loadstart', 'load', 'loadend']);
});

test('gives up after 6 attempts and passes the last failure through', async () => {
  reset(Array(10).fill('neterr'));
  let r = await pageXhr();
  assert.equal(network.sent.length, 6);
  assert.deepEqual(r.seen.events, ['loadstart', 'error', 'loadend']);

  reset(Array(10).fill(503));
  r = await pageXhr();
  assert.equal(network.sent.length, 6);
  assert.equal(r.status, 503);
});

test('abort during the backoff wait ends the request without another send', async () => {
  reset(['neterr', 'ok']);
  // failure lands at ~1 ms, the retry would be sent at ~6 ms; abort at 3 ms
  const r = await pageXhr({ abortAfterMs: 3 });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(network.sent.length, 1);
  assert.deepEqual(r.seen.events, ['loadstart', 'abort', 'loadend']);
});

test('abort while a request is in flight is forwarded, not retried', async () => {
  reset(['ok']);
  const r = await pageXhr({ abortAfterMs: 0 });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(network.sent.length, 1);
  assert.ok(r.seen.events.includes('abort'));
  assert.ok(!r.seen.events.includes('load'));
});

test('POST and non-segment requests are never retried', async () => {
  reset(['neterr']);
  let r = await pageXhr({ method: 'POST' });
  assert.equal(network.sent.length, 1);
  assert.deepEqual(r.seen.events, ['loadstart', 'error', 'loadend']);

  reset(['neterr']);
  r = await pageXhr({ url: 'https://api.test/progress.json', responseType: 'json' });
  assert.equal(network.sent.length, 1);
  assert.ok(r.seen.events.includes('error'));
});

test('segments disguised as images are retried when fetched as arraybuffer', async () => {
  reset(['neterr', 'ok']);
  const r = await pageXhr({ url: 'https://img.test/frame00042.jpg', responseType: 'arraybuffer' });
  assert.equal(network.sent.length, 2);
  assert.equal(r.bytes, 1000);
});
