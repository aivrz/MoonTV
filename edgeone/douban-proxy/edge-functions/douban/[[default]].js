/**
 * EdgeOne Makers 边缘函数：豆瓣数据 API 代理
 *
 * 路由：
 *   /douban/<URL编码后的豆瓣地址>
 *   /douban/?url=<URL编码后的豆瓣地址>
 * 客户端（MoonTV src/lib/douban.client.ts / utils.ts processDoubanUrl）调用格式：
 *   `${豆瓣代理地址}${encodeURIComponent(豆瓣URL)}`
 * 因此 MoonTV 后台「豆瓣代理」应填： https://你的域名/douban/
 *
 * 部署（EdgeOne Makers 控制台）：
 *   1. 创建项目 → 连接本仓库 → 根目录 edgeone/douban-proxy
 *   2. 框架预设选 Other，构建命令/安装命令均留空，输出目录 .
 *   3. 加速区域：备案域名可选「含中国大陆」，否则选「不含中国大陆」
 *   4. 部署后绑定域名，后台「豆瓣代理」填 https://域名/douban/
 *
 * 安全：仅允许转发 douban.com / doubanio.com，防止被滥用为开放代理。
 */

const ALLOWED_HOST_SUFFIXES = ['douban.com', 'doubanio.com'];

const UPSTREAM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  Referer: 'https://movie.douban.com/',
  Accept: 'application/json, text/plain, */*',
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function isAllowedTarget(target) {
  try {
    const u = new URL(target);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return ALLOWED_HOST_SUFFIXES.some(
      (s) => u.hostname === s || u.hostname.endsWith('.' + s)
    );
  } catch {
    return false;
  }
}

/** 解析目标豆瓣 URL：剥离本函数 /douban/ 前缀，支持路径式与 ?url= 式 */
function extractTarget(requestUrl) {
  const u = new URL(requestUrl);

  const byQuery = u.searchParams.get('url');
  if (byQuery) return decodeURIComponent(byQuery);

  let rawPath = u.pathname.replace(/^\/+/, '');
  rawPath = rawPath.replace(/^douban\//, ''); // 去掉路由前缀
  if (rawPath) {
    try {
      return decodeURIComponent(rawPath);
    } catch {
      return rawPath;
    }
  }
  return null;
}

async function handle(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  const target = extractTarget(request.url);
  if (!target) {
    return new Response(
      JSON.stringify({
        error: 'Missing target URL',
        usage:
          '/douban/https%3A%2F%2Fm.douban.com%2F...  或  /douban/?url=<encoded>',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );
  }
  if (!isAllowedTarget(target)) {
    return new Response(JSON.stringify({ error: 'Target host not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  const upstream = await fetch(target, {
    method: request.method,
    headers: UPSTREAM_HEADERS,
  });

  // 边缘缓存 5 分钟，命中后不回源豆瓣，降低被风控概率
  const headers = {
    'Content-Type':
      upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control':
      'public, max-age=60, s-maxage=300, stale-while-revalidate=86400',
    ...corsHeaders(),
  };
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function onRequest(context) {
  try {
    return await handle(context.request);
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'Douban proxy failed',
        details: String((err && err.message) || err),
      }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );
  }
}

// 双导出：兼容 EdgeOne Pages（命名导出 onRequest）与 EdgeOne Makers（默认导出）
export default onRequest;
