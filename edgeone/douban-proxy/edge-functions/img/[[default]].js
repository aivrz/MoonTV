/**
 * EdgeOne Makers 边缘函数：图片代理（海报等静态图）
 *
 * 路由：
 *   /img/<URL编码后的图片地址>
 *   /img/?url=<URL编码后的图片地址>
 * 客户端（MoonTV src/lib/utils.ts processImageUrl）调用格式：
 *   `${图片代理地址}${encodeURIComponent(图片URL)}`
 * 因此 MoonTV 后台「图片代理」应填： https://你的域名/img/
 *
 * 防滥用（重要）：
 *  - 仅允许透传 image/* 响应，非图片一律 403，避免被当作通用抓取 / 开放代理；
 *  - 仅允许 http/https 协议；
 *  - ALLOW_HOST_SUFFIXES 环境变量（可选，逗号分隔）：若设置则仅允许这些域名后缀；
 *  - SITE_HOST 环境变量（可选）：仅接受带本站 Origin/Referer 的请求（注意 plain
 *    <img referrerPolicy="no-referrer"> 不发送标识头，此时交由上面的类型/白名单兜底）；
 *  - 响应体上限 MAX_BYTES，超出 413。
 * 建议至少配置 ALLOW_HOST_SUFFIXES 或 SITE_HOST 其一。
 */

const MAX_BYTES = 10 * 1024 * 1024;

function getEnv(context, key) {
  if (context && context.env && context.env[key] != null) return context.env[key];
  if (typeof process !== 'undefined' && process.env && process.env[key] != null)
    return process.env[key];
  return '';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function hostAllowed(context, target) {
  const allow = getEnv(context, 'ALLOW_HOST_SUFFIXES')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allow.length) return true; // 未配置则放行所有主机（仍受 image/* 限制兜底）
  return allow.some((h) => target.host === h || target.host.endsWith('.' + h));
}

function sameSiteAllowed(context, request) {
  const siteHost = getEnv(context, 'SITE_HOST').replace(/^https?:\/\//, '').trim();
  if (!siteHost) return true; // 未配置则放行
  const origin =
    request.headers.get('Origin') || request.headers.get('Referer') || '';
  if (!origin) return true; // 无标识头（如 no-referrer 的 <img>）交由类型/白名单兜底
  return (
    origin === `https://${siteHost}` ||
    origin === `http://${siteHost}` ||
    origin.startsWith(`https://${siteHost}/`) ||
    origin.startsWith(`http://${siteHost}/`)
  );
}

/** 解析目标图片 URL：剥离本函数 /img/ 前缀，支持路径式与 ?url= 式 */
function extractTarget(requestUrl) {
  const u = new URL(requestUrl);
  const byQuery = u.searchParams.get('url');
  if (byQuery) return decodeURIComponent(byQuery);

  let rawPath = u.pathname.replace(/^\/+/, '');
  rawPath = rawPath.replace(/^img\//, ''); // 去掉路由前缀
  if (rawPath) {
    try {
      return decodeURIComponent(rawPath);
    } catch {
      return rawPath;
    }
  }
  return null;
}

async function handle(context) {
  const request = context.request;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  if (!sameSiteAllowed(context, request)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  const targetRaw = extractTarget(request.url);
  if (!targetRaw) {
    return new Response(JSON.stringify({ error: 'Missing target URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  let target;
  try {
    target = new URL(targetRaw);
  } catch {
    return new Response(JSON.stringify({ error: 'Bad target' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return new Response(JSON.stringify({ error: 'Bad scheme' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
  if (!hostAllowed(context, target)) {
    return new Response(JSON.stringify({ error: 'Target host not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  // 向上游发起请求：伪装成普通浏览器，并以目标自身域名作 Referer 利于通过防盗链
  const upstream = await fetch(targetRaw, {
    method: request.method,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: `${target.protocol}//${target.host}/`,
      Accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
    },
  });

  const ct = upstream.headers.get('content-type') || '';
  // 非图片响应一律拒绝（HEAD 可能无 content-type，放行由其本身决定）
  if (request.method !== 'HEAD' && !/^image\//i.test(ct)) {
    return new Response(
      JSON.stringify({ error: 'Only image responses are allowed' }),
      { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );
  }

  const cl = parseInt(upstream.headers.get('content-length') || '0', 10);
  if (cl > MAX_BYTES) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  // 图片基本静态：长缓存 + 后台重新验证，命中边缘后不回源
  const headers = {
    'Content-Type': ct || 'application/octet-stream',
    'Cache-Control':
      'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
    ...corsHeaders(),
  };
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function onRequest(context) {
  try {
    return await handle(context);
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'Image proxy failed',
        details: String((err && err.message) || err),
      }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );
  }
}

export default onRequest;
