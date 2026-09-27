# Video Segment Retry

A userscript that stops web video players from skipping ahead or freezing
when a small piece of the video fails to download.

## The problem it fixes

On some video sites you may notice that:

- the video jumps forward a few seconds by itself, or
- the video freezes and buffers forever at one spot.

Why this happens: web video players do not download a video as one big file.
They download it in small pieces called **segments**, usually 2 to 15 seconds
each. Sometimes a piece arrives cut short, or its download fails on the way.
The player then either skips over the missing piece, or stops and waits.

Which one you see depends on the player. Many sites use a player library
called hls.js. Older versions of hls.js, and live streams on current versions,
skip the missing piece. Current versions (1.6.11 and later) playing ordinary
on-demand videos stall or show an error instead.

hls.js does retry some failed downloads, but not when the connection simply
dropped. A dropped connection shows up as "HTTP status 0", and hls.js only
retries that when the browser says it is offline. Sources, for the curious:
the `retryForHttpStatus` function in
[error-helper.ts](https://github.com/video-dev/hls.js/blob/master/src/utils/error-helper.ts)
and [hls.js pull request #7476](https://github.com/video-dev/hls.js/pull/7476).

## What the script does

When a video piece:

- fails to download,
- arrives shorter than the server said it would be, or
- gets a temporary server error (any 5xx, 408 "timed out", or 429 "too many requests"),

the script quietly downloads that piece again. It tries up to 5 more times,
waiting 0.5, 1, 2, 4 and then 8 seconds between tries. The player never sees
the failure. To the player it looks like one download that took a bit longer.

Errors that retrying cannot fix are passed to the player unchanged, for
example 404 ("not found") and 403 ("forbidden", often an expired link).

## It does nothing on ordinary pages

The script is loaded on every site, but on ordinary pages it does nothing at
all. It switches on only after the page starts streaming video. (Technically:
when the page creates a MediaSource "SourceBuffer", which every HLS or DASH
web player does.)

Even then, it only touches plain downloads (GET requests) of video, audio and
subtitle pieces:

- addresses ending in `.ts` `.m4s` `.mp4` `.m4v` `.m4a` `.aac` `.mp3` `.cmfv`
  `.cmfa` `.webm` `.vtt`, or
- downloads the player asks for as raw binary data. This catches sites that
  disguise video pieces as pictures (`.jpg`, `.png`).

Everything else, including POST requests (a page sending data to a site), is
never touched.

## Works with

Any web player built on **hls.js, video.js, dash.js or shaka-player**, on any
site. This includes players inside embedded frames (a video from one site
shown inside another site's page).

It does **not** help with:

- the browser's own built-in player, such as Safari playing HLS by itself,
  or a plain `.mp4` file opened directly;
- DRM problems (protected videos that refuse to play);
- expired video links (403 errors).

## Install

1. Install a userscript manager:
   [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open
   <https://github.com/pc418/segment-retry/raw/main/segment-retry.user.js>
   and click **Install**.
   Or install from [Greasy Fork](https://greasyfork.org/scripts/597607-video-segment-retry-stop-hls-dash-skips-and-stalls).
3. Reload any video page that was already open.

## How to tell it is working

Open the browser console: press **F12** (or **Cmd+Option+J** on a Mac), then
choose the **Console** tab. Type `segment-retry` into the console's filter
box. The script's lines are shown as warnings (usually yellow), so make sure
warnings are not hidden.

When a video starts, you should see:

```
[segment-retry] streaming video detected (video/mp2t; ...); segment retries on in example.com
```

That line means the script is active on this page. When a piece fails and is
downloaded again, you will see lines like:

```
[segment-retry] network error; retry 1/5 in 500 ms: https://...
[segment-retry] cut off (600 of 1000 bytes); retry 1/5 in 500 ms: https://...
[segment-retry] HTTP 503; retry 1/5 in 500 ms: https://...
[segment-retry] recovered after 1 retry: https://...
```

No retry lines simply means nothing failed. That is normal.

## Turning it off

You can switch the script off whenever you like, for example when you are not
watching videos. Open the Tampermonkey or Violentmonkey dashboard and flip the
switch next to "Video Segment Retry", then reload the page. This is fine to
do, but not necessary: on pages without streaming video the script is idle.

## Privacy

- The script makes no network requests of its own.
- It collects no data and sends nothing anywhere.
- It stores no settings.
- It asks for no special permissions (`@grant none`).

## Limits

- If the server keeps failing, the download still fails after the 5 retries
  (about 15 seconds of waiting in total). The player then behaves exactly as
  it would without the script.
- A cut-short piece can only be spotted when the server says how big the piece
  should be (the "Content-Length" header) and does not compress it on the way.
- Each try gets the same time limit the page itself set for one download. If a
  try runs past that limit, the timeout is handed to the player unchanged.
- For players that download with `fetch`, only pieces up to 32 MB whose size
  the server states are checked for being cut short. Bigger downloads (such as
  a whole video file) pass through untouched, so they never use extra memory.
- Testing so far: one hls.js site in a real browser, with download failures
  injected on purpose. Without the script, 13 injected failures left 10 holes
  in the video. With the script, 10 injected failures were all recovered, with
  no holes. There are also 17 automated tests. It has not yet been tested in a
  browser on sites using dash.js or shaka-player.

## Reporting problems

Please open an issue at <https://github.com/pc418/segment-retry/issues> and
include:

- the player type, if you know it (hls.js, video.js, dash.js, shaka-player);
- your browser and its version;
- the `[segment-retry]` lines from the console.

## 中文说明

**解决什么问题：** 在某些视频网站上，视频会自己往前跳几秒，或者卡在某个位置一直缓冲。
原因是网页播放器把视频分成很多小片段（每段通常 2–15 秒）下载，某一段下载失败或被截断时，播放器就会跳过它或卡住。

**脚本做什么：** 视频片段下载失败、内容不完整，或服务器临时出错（5xx、408、429）时，脚本会自动重新下载这一段，最多再试 5 次（间隔 0.5、1、2、4、8 秒）。404、403 等错误原样交给播放器。
适用于基于 hls.js、video.js、dash.js、shaka-player 的网页播放器，包括嵌入框架里的播放器。

**安装：** 先安装 Tampermonkey 或 Violentmonkey，然后打开
<https://github.com/pc418/segment-retry/raw/main/segment-retry.user.js>（或 [Greasy Fork](https://greasyfork.org/scripts/597607-video-segment-retry-stop-hls-dash-skips-and-stalls)）点击“安装”，再刷新视频页面。

**如何确认在工作：** 按 F12（Mac 上按 Cmd+Option+J）打开控制台，在过滤框输入 `segment-retry`。
看到 `streaming video detected` 说明脚本已启用；`retry 1/5` 表示正在重试，`recovered after` 表示已恢复。

**普通网页上不做任何事：** 只有页面开始播放流媒体视频后才会启用。不联网、不收集数据、不保存设置。
不看视频时也可以在 Tampermonkey 管理面板里把它关掉，但没有必要。

## For developers

Run `npm test` (Node 20 or later, no dependencies). It runs 17 tests against a
fake XHR/fetch network. How it works:

- Wraps `XMLHttpRequest` and `fetch` at `document-start`, in every frame.
- Hands out the browser's own XHR (and passes `fetch` straight through) until
  the frame calls `addSourceBuffer` on a `MediaSource`.
- After that, segment XHRs get a wrapper that forwards events live but holds
  the final `readystatechange`/`load`/`error`/`loadend` until the download is
  known complete; segment `fetch` responses are buffered and checked.
- A failed or cut-off segment is re-sent on a fresh XHR with the same method,
  URL, headers, `responseType`, `timeout` and `withCredentials`.
- `xhr instanceof XMLHttpRequest` stays true for both wrapped and plain XHRs.

Note: the `fetch` path matches segments by URL extension only; the "binary
data" match applies to XHR. Synchronous XHRs are never retried.

## License

MIT
