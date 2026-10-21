/**
 * EdgeOne 边缘函数：豆瓣数据 API 代理
 *
 * 用途：解决 Cloudflare Pages 服务端直连 m.douban.com 被豆瓣拦截（403）的问题。
 * 客户端（MoonTV src/lib/douban.client.ts / utils.ts processDoubanUrl）的调用格式为：
 *   `${豆瓣代理地址}${encodeURIComponent(豆瓣URL)}`
 * 即：路径为一段 URL 编码后的豆瓣地址，例如
 *   https://你的代理域名/https%3A%2F%2Fm.douban.com%2Frexxar%2Fapi%2Fv2%2F...
 *
 * 部署（EdgeOne Pages 控制台）：
 *   1. 创建项目 → 连接本仓库 → 根目录选择 edgeone/douban-proxy
 *   2. 构建命令留空，输出目录填 .（或 ./）
 *   3. 部署后在「域名管理」绑定你的未备案域名（使用海外可用区加速）
 *   4. MoonTV 管理后台「豆瓣代理」填：https://你的代理域名/
 *
 * 注意：此函数只允许转发豆瓣域名，防止被滥用为开放代理。
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

/** 从请求中解析目标豆瓣 URL：支持路径前缀式与 ?url= 查询参数式 */
function extractTarget(requestUrl) {
  const u = new URL(requestUrl);

  // 形如 /?url=https%3A%2F%2Fm.douban.com%2F...
  const byQuery = u.searchParams.get('url');
  if (byQuery) return decodeURIComponent(byQuery);

  // 形如 /https%3A%2F%2Fm.douban.com%2F...
  const rawPath = u.pathname.replace(/^\/+/, '');
  if (rawPath) {
    try {
      return decodeURIComponent(rawPath);
    } catch {
      return rawPath; // 已是未编码形式
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
        usage: '/https%3A%2F%2Fm.douban.com%2F...  或  /?url=<encoded douban url>',
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
    // 边缘函数自身 10s 超时由平台控制，这里不额外 abort
  });

  // 边缘缓存 5 分钟，命中后不回源豆瓣，降低被风控概率
  const headers = {
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400',
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
      JSON.stringify({ error: 'Douban proxy failed', details: String((err && err.message) || err) }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );
  }
}

// 双导出：兼容 EdgeOne Pages（命名导出 onRequest）与 EdgeOne Makers（默认导出）
export default onRequest;
