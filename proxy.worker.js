/**
 * MoonTV 边缘受限代理（可选组件，非开放代理）
 * ============================================================
 * ⚠️ 部署前必读（关系到 Cloudflare 免费额度与服务条款）：
 *
 * 1. 本 Worker 设计为「**同源网关**」，不是开放代理：
 *    - 仅在 `/proxy/` 路径前缀下生效，绝不作为 catch-all 部署；
 *    - 仅接受来自本站（Origin/Referer 命中 SITE_HOST）的请求，第三方无法滥用；
 *    - 仅允许 http/https，且当配置了 WORKER_ALLOW_HOSTS 时目标域名必须命中白名单；
 *    - 响应体设上限（免费额度防护），m3u8 仅在小体积内做广告过滤，超出直接透传。
 * 2. 当前 MoonTV 默认**不集成此 Worker**：m3u8 广告过滤已在浏览器端
 *    （src/lib/m3u8-ad-filter.ts）完成，零 Cloudflare 资源消耗，最稳。
 *    仅当你希望「边缘侧」提前剔除广告分片时才部署本 Worker，并需自行把客户端
 *    m3u8 拉取改为走 `/proxy/<编码后的源地址>`。
 * 3. 免费额度：Worker 免费 10 万请求/天、单请求 CPU 10ms、脚本 1MB。
 *    本脚本极小（无依赖），且命中 CDN 缓存（响应带 s-maxage）的重复请求不计入
 *    Worker 调用，个人/小站完全够用。
 *
 * 部署方式（wrangler）：
 *   [vars]
 *   SITE_HOST = "你的域名.com"
 *   WORKER_ALLOW_HOSTS = "example.com,example.cn"   # 可选，留空则不限制域名
 * 路由仅绑定到 https://<域名>/proxy/*
 * ============================================================
 */

const PATH_PREFIX = '/proxy/';
// 免费额度防护：响应体硬上限，避免被大文件打爆带宽/内存
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// 广告过滤是 CPU 密集操作，免费 Worker 单请求仅 10ms CPU：超出此体积的 m3u8 直接透传
const MAX_M3U8_FILTER_BYTES = 512 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1) 仅处理 /proxy/ 前缀，杜绝 catch-all 开放代理
    if (!url.pathname.startsWith(PATH_PREFIX)) {
      return new Response('Not Found', { status: 404 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 2) 同源网关：拒绝非本站来源，防止被第三方当开放代理滥用（违反 CF 条款）
    const siteHost = (env.SITE_HOST || url.host).replace(/^https?:\/\//, '');
    const origin = request.headers.get('Origin') || request.headers.get('Referer') || '';
    const sameSite =
      origin === `https://${siteHost}` ||
      origin === `http://${siteHost}` ||
      origin.startsWith(`https://${siteHost}/`) ||
      origin.startsWith(`http://${siteHost}/`);
    if (!sameSite) {
      return new Response('Forbidden', { status: 403 });
    }

    // 3) 解析目标地址
    let target;
    try {
      target = new URL(
        decodeURIComponent(url.pathname.slice(PATH_PREFIX.length)) + url.search
      );
    } catch {
      return new Response('Bad target', { status: 400 });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return new Response('Bad scheme', { status: 400 });
    }

    // 4) 可选域名白名单
    const allow = (env.WORKER_ALLOW_HOSTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      allow.length &&
      !allow.some((h) => target.host === h || target.host.endsWith('.' + h))
    ) {
      return new Response('Forbidden host', { status: 403 });
    }

    // 5) 转发（剔除 cf- 系列请求头，避免链路污染）
    const fwdHeaders = filterHeaders(request.headers, (n) => !n.startsWith('cf-'));
    const upstreamResp = await fetch(target.toString(), {
      headers: fwdHeaders,
      method: request.method,
      redirect: 'follow',
    });

    const contentType = upstreamResp.headers.get('Content-Type') || '';
    const lowerPath = target.pathname.toLowerCase();

    // m3u8 / m3u：边缘广告过滤 + 短缓存
    if (
      lowerPath.endsWith('.m3u8') ||
      lowerPath.endsWith('.m3u') ||
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl')
    ) {
      return handleM3u8(upstreamResp, contentType);
    }

    // 其余：按资源类型设置 CDN 缓存头（命中后不计入 Worker 调用）
    const body = await upstreamResp.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      return new Response('Payload too large', { status: 413 });
    }
    const out = new Response(body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: upstreamResp.headers,
    });
    setCacheHeaders(out.headers, contentType);
    out.headers.set('Access-Control-Allow-Origin', '*');
    return out;
  },
};

// ---- m3u8 边缘广告过滤 ----
async function handleM3u8(upstreamResp, contentType) {
  const text = await upstreamResp.text();
  // 主播放列表（多码率）或超大清单：原样透传，避免 CPU 超限（客户端过滤兜底）
  const filtered =
    text.length > MAX_M3U8_FILTER_BYTES || /#EXT-X-STREAM-INF/.test(text)
      ? text
      : filterM3u8Smart(text);

  const headers = new Headers();
  headers.set('Content-Type', 'application/vnd.apple.mpegurl');
  headers.set('Access-Control-Allow-Origin', '*');
  // 清单变化较快，短缓存 + 后台重新验证（命中后不计入 Worker 调用）
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
    if (p.cue && rawStartsWith(p.raw, '#EXT-X-CUE-OUT')) { inCue2 = true; drop.add(i); continue; }
    if (p.cue && rawStartsWith(p.raw, '#EXT-X-CUE-IN')) { inCue2 = false; drop.add(i); continue; }
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
