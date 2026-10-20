/* eslint-disable */

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
    const url = new URL(request.url);

    // 如果访问根目录，返回HTML
    if (url.pathname === '/') {
      return new Response(getRootHtml(), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
        },
      });
    }

    // 从请求路径中提取目标 URL
    let actualUrlStr = decodeURIComponent(url.pathname.replace('/', ''));
    actualUrlStr = ensureProtocol(actualUrlStr, url.protocol);
    actualUrlStr += url.search;

    const targetUrl = new URL(actualUrlStr);
    const lowerPath = targetUrl.pathname.toLowerCase();

    // m3u8 / m3u 走边缘广告过滤 + 缓存（客户端根本不拉广告分片）
    if (lowerPath.endsWith('.m3u8') || lowerPath.endsWith('.m3u')) {
      return handleM3u8(targetUrl, request);
    }

    // 创建新 Headers 对象，排除以 'cf-' 开头的请求头
    const newHeaders = filterHeaders(
      request.headers,
      (name) => !name.startsWith('cf-')
    );

    const modifiedRequest = new Request(actualUrlStr, {
      headers: newHeaders,
      method: request.method,
      body: request.body,
      redirect: 'manual',
    });

    const response = await fetch(modifiedRequest);
    let body = response.body;

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      body = response.body;
      return handleRedirect(response, body);
    } else if (response.headers.get('Content-Type')?.includes('text/html')) {
      body = await handleHtmlContent(
        response,
        url.protocol,
        url.host,
        actualUrlStr
      );
    }

    const modifiedResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    // 按资源类型决定是否边缘缓存（HTML 不缓存，静态资源长缓存）
    setCacheHeaders(modifiedResponse.headers, response.headers.get('Content-Type'));
    setCorsHeaders(modifiedResponse.headers);
    return modifiedResponse;
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// ---- m3u8 边缘广告过滤 ----
async function handleM3u8(targetUrl, request) {
  const newHeaders = filterHeaders(
    request.headers,
    (name) => !name.startsWith('cf-')
  );
  const upstream = await fetch(targetUrl.toString(), {
    headers: newHeaders,
    redirect: 'follow',
  });

  const contentType = upstream.headers.get('Content-Type') || '';
  const text = await upstream.text();

  // 主播放列表（多码率）原样透传
  const filtered =
    /#EXT-X-STREAM-INF/.test(text) ? text : filterM3u8Smart(text);

  const headers = new Headers();
  headers.set('Content-Type', 'application/vnd.apple.mpegurl');
  headers.set('Access-Control-Allow-Origin', '*');
  // 清单变化较快，短缓存 + 后台重新验证
  headers.set(
    'Cache-Control',
    'public, max-age=300, s-maxage=300, stale-while-revalidate=600'
  );
  return new Response(filtered, { status: 200, headers });
}

/**
 * 边缘侧 m3u8 广告过滤（与 src/lib/m3u8-ad-filter.ts 同源逻辑）。
 * 规则：DISCONTINUITY 分组(3-120s 且分片<15) + #EXT-X-CUE-OUT/IN + #EXT-X-GAP
 *      + 异域可疑 TLD 分片 + <0.5s 非媒体追踪分片；20% 保险丝回退原样。
 */
function filterM3u8Smart(content) {
  if (!content) return content;
  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  if (/#EXT-X-STREAM-INF/.test(content)) return content;

  const SUS = new Set([
    'vip', 'bet', 'top', 'xyz', 'click', 'link', 'shop', 'club', 'party',
    'date', 'loan', 'racing', 'download', 'country', 'stream', 'win', 'bid',
    'gq', 'cf', 'ga', 'ml', 'tk', 'pw', 'cc', 'live', 'tv',
  ]);
  const MEDIA = new Set(['ts', 'm4s', 'mp4', 'aac', 'm4a', 'webm', 'key', 'm3u8']);

  const parsed = [];
  let block = 0;
  let pendingDur = undefined;
  let inCue = false;
  const adBlockSet = new Set();

  for (const raw of lines) {
    const t = raw.trim();
    if (t.includes('#EXT-X-DISCONTINUITY')) {
      if (parsed.some((p) => p.block === block)) block++;
      parsed.push({ raw, block, seg: false, dur: undefined, cue: false, gap: false });
      pendingDur = undefined;
      continue;
    }
    if (t.startsWith('#EXT-X-CUE-OUT')) { inCue = true; parsed.push({ raw, block, seg: false, dur: undefined, cue: true, gap: false }); continue; }
    if (t.startsWith('#EXT-X-CUE-IN')) { inCue = false; parsed.push({ raw, block, seg: false, dur: undefined, cue: true, gap: false }); continue; }
    if (t.startsWith('#EXT-X-CUE:')) { parsed.push({ raw, block, seg: false, dur: undefined, cue: true, gap: false }); continue; }
    if (t.startsWith('#EXT-X-GAP')) { parsed.push({ raw, block, seg: false, dur: undefined, cue: false, gap: true }); continue; }

    const ei = t.match(/^#EXTINF:\s*([\d.]+)/);
    if (ei) { pendingDur = Number(ei[1]); parsed.push({ raw, block, seg: false, dur: pendingDur, cue: false, gap: false }); continue; }

    const isSeg = t.length > 0 && !t.startsWith('#');
    let host, ext;
    if (isSeg) {
      try {
        if (/^https?:\/\//i.test(t)) {
          const u = new URL(t);
          host = u.hostname.toLowerCase();
          const last = u.pathname.split('/').pop() || '';
          const d = last.lastIndexOf('.');
          if (d >= 0) ext = last.slice(d + 1).toLowerCase();
        }
      } catch (e) { /* ignore */ }
    }
    parsed.push({ raw, block, seg: isSeg, dur: isSeg ? pendingDur : undefined, host, ext, cue: false, gap: false });
    if (isSeg) pendingDur = undefined;
  }

  const blocks = {};
  for (const p of parsed) {
    if (!p.seg) continue;
    blocks[p.block] = blocks[p.block] || { seg: 0, dur: 0 };
    blocks[p.block].seg++;
    blocks[p.block].dur += p.dur || 0;
  }
  const blockArr = Object.keys(blocks).map((k) => ({ index: +k, ...blocks[k] }));
  const totalSeg = blockArr.reduce((s, b) => s + b.seg, 0);
  const totalDur = blockArr.reduce((s, b) => s + b.dur, 0);

  const drop = new Set();
  const markSeg = (i) => {
    const p = parsed[i];
    if (!p || !p.seg) return;
    drop.add(i);
    const prev = parsed[i - 1];
    if (prev && prev.dur !== undefined) drop.add(i - 1);
  };

  // 1) DISCONTINUITY 分组（单组清单不处理）
  if (blockArr.length > 1) {
    for (const b of blockArr) {
      if (b.seg > 0 && b.seg < 15 && b.dur >= 3 && b.dur <= 120) {
        adBlockSet.add(b.index);
        parsed.forEach((p, i) => { if (p.block === b.index && p.seg) markSeg(i); });
      }
    }
  }

  // 2) + 3) CUE-OUT..CUE-IN / GAP / 清理 CUE 标记
  let inCue2 = false;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.cue && (rawStartsWith(parsed[i].raw, '#EXT-X-CUE-OUT'))) { inCue2 = true; drop.add(i); continue; }
    if (p.cue && (rawStartsWith(parsed[i].raw, '#EXT-X-CUE-IN'))) { inCue2 = false; drop.add(i); continue; }
    if (p.cue) { drop.add(i); if (parsed[i + 1] && parsed[i + 1].seg) markSeg(i + 1); continue; }
    if (p.gap) { drop.add(i); if (parsed[i + 1] && parsed[i + 1].seg) markSeg(i + 1); continue; }
    if (inCue2 && p.seg) markSeg(i);
  }

  // 4) 异域 + 可疑 TLD
  const hostCount = {};
  for (const p of parsed) if (p.seg && p.host) hostCount[p.host] = (hostCount[p.host] || 0) + 1;
  let baseHost = '', bn = 0;
  for (const h in hostCount) if (hostCount[h] > bn) { bn = hostCount[h]; baseHost = h; }
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.seg && p.host && baseHost) {
      const same = p.host === baseHost || p.host.endsWith('.' + baseHost) || baseHost.endsWith('.' + p.host);
      const tld = p.host.split('.').pop().toLowerCase();
      if (!same && SUS.has(tld)) markSeg(i);
    }
  }

  // 5) <0.5s 非媒体追踪分片
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.seg && p.dur !== undefined && p.dur < 0.5 && p.ext && !MEDIA.has(p.ext)) markSeg(i);
  }

  // 保险丝
  let remSeg = 0, remDur = 0;
  for (const i of drop) { const p = parsed[i]; if (p.seg) { remSeg++; remDur += p.dur || 0; } }
  if (drop.size === 0) return content;
  if (totalSeg > 0 && remSeg / totalSeg > 0.2) return content;
  if (totalDur > 0 && remDur / totalDur > 0.2) return content;

  // 仅清理被广告分组命中的块的前导 DISCONTINUITY
  const discByBlock = {};
  parsed.forEach((p, i) => {
    if (p.raw.trim().includes('#EXT-X-DISCONTINUITY')) {
      discByBlock[p.block] = discByBlock[p.block] || [];
      discByBlock[p.block].push(i);
    }
  });
  for (const bi of adBlockSet) {
    if (discByBlock[bi] && discByBlock[bi][0] !== undefined) drop.add(discByBlock[bi][0]);
  }

  const kept = parsed.filter((_, i) => !drop.has(i));
  return kept.map((p) => p.raw).join('\n');
}

function rawStartsWith(raw, prefix) {
  return raw.trim().startsWith(prefix);
}

// ---- 工具函数 ----
function ensureProtocol(url, defaultProtocol) {
  return url.startsWith('http://') || url.startsWith('https://')
    ? url
    : defaultProtocol + '//' + url;
}

function handleRedirect(response, body) {
  const location = new URL(response.headers.get('location'));
  const modifiedLocation = `/${encodeURIComponent(location.toString())}`;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      ...response.headers,
      Location: modifiedLocation,
    },
  });
}

function handleHtmlContent(response, protocol, host, actualUrlStr) {
  return response.text().then((originalText) => {
    const regex = new RegExp('((href|src|action)=["\'])/(?!/)', 'g');
    return replaceRelativePaths(
      originalText,
      protocol,
      host,
      new URL(actualUrlStr).origin
    );
  });
}

function replaceRelativePaths(text, protocol, host, origin) {
  const regex = new RegExp('((href|src|action)=["\'])/(?!/)', 'g');
  return text.replace(regex, `$1${protocol}//${host}/${origin}/`);
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function filterHeaders(headers, filterFunc) {
  return new Headers([...headers].filter(([name]) => filterFunc(name)));
}

// 按资源类型设置边缘缓存：HTML 不缓存，静态资源长缓存
function setCacheHeaders(headers, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/html')) {
    headers.set('Cache-Control', 'no-store');
    return;
  }
  if (
    ct.includes('image/') ||
    ct.includes('font/') ||
    ct.includes('video/') ||
    ct.includes('text/css') ||
    ct.includes('javascript') ||
    ct.includes('application/vnd.apple.mpegurl')
  ) {
    headers.set('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
  } else {
    headers.set('Cache-Control', 'public, max-age=300, s-maxage=300');
  }
}

function setCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  headers.set('Access-Control-Allow-Headers', '*');
}

function getRootHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/css/materialize.min.css" rel="stylesheet">
  <title>Proxy Everything</title>
  <link rel="icon" type="image/png" href="https://img.icons8.com/color/1000/kawaii-bread-1.png">
  <meta name="Description" content="Proxy Everything with CF Workers.">
  <meta property="og:description" content="Proxy Everything with CF Workers.">
  <meta property="og:image" content="https://img.icons8.com/color/1000/kawaii-bread-1.png">
  <meta name="robots" content="index, follow">
  <meta http-equiv="Content-Language" content="zh-CN">
  <meta name="copyright" content="Copyright © ymyuuu">
  <meta name="author" content="ymyuuu">
  <link rel="apple-touch-icon-precomposed" sizes="120x120" href="https://img.icons8.com/color/1000/kawaii-bread-1.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="viewport" content="width=device-width, user-scalable=no, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">
  <style>
      body, html { height: 100%; margin: 0; }
      .background { background-size: cover; background-position: center; height: 100%; display: flex; align-items: center; justify-content: center; }
      .card { background-color: rgba(255,255,255,0.8); transition: background-color 0.3s ease, box-shadow 0.3s ease; }
      .card:hover { background-color: rgba(255,255,255,1); box-shadow: 0px 8px 16px rgba(0,0,0,0.3); }
      .input-field input[type=text] { color: #2c3e50; }
      .input-field input[type=text]:focus+label { color: #2c3e50 !important; }
      .input-field input[type=text]:focus { border-bottom: 1px solid #2c3e50 !important; box-shadow: 0 1px 0 0 #2c3e50 !important; }
  </style>
</head>
<body>
  <div class="background">
      <div class="container">
          <div class="row">
              <div class="col s12 m8 offset-m2 l6 offset-l3">
                  <div class="card">
                      <div class="card-content">
                          <span class="card-title center-align"><i class="material-icons left">link</i>Proxy Everything</span>
                          <form id="urlForm" onsubmit="redirectToProxy(event)">
                              <div class="input-field">
                                  <input type="text" id="targetUrl" placeholder="在此输入目标地址" required>
                                  <label for="targetUrl">目标地址</label>
                              </div>
                              <button type="submit" class="btn waves-effect waves-light teal darken-2 full-width">跳转</button>
                          </form>
                      </div>
                  </div>
              </div>
          </div>
      </div>
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/js/materialize.min.js"></script>
  <script>
      function redirectToProxy(event) {
          event.preventDefault();
          const targetUrl = document.getElementById('targetUrl').value.trim();
          const currentOrigin = window.location.origin;
          window.open(currentOrigin + '/' + encodeURIComponent(targetUrl), '_blank');
      }
  </script>
</body>
</html>`;
}
