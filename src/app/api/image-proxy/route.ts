import { NextResponse } from 'next/server';

export const runtime = 'edge';

// 可选：仅允许访问指定域名（逗号分隔）。留空则允许所有 http(s)，但仍做 SSRF 防护。
const ALLOW_HOSTS = (process.env.IMAGE_PROXY_ALLOW_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// 常见的云元数据/内网主机，直接拒绝
const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.googleapis.com',
  '169.254.169.254',
]);

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  // 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16,
  // 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedTarget(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  // IP 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isPrivateIpv4(host)) return true;
  if (host === '[::1]' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')) {
    return true; // IPv6 loopback/unique-local
  }
  return false;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(imageUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid image URL' }, { status: 400 });
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return NextResponse.json({ error: 'Unsupported protocol' }, { status: 400 });
  }

  if (isBlockedTarget(target.hostname)) {
    return NextResponse.json({ error: 'Target not allowed' }, { status: 403 });
  }

  if (ALLOW_HOSTS.length > 0 && !ALLOW_HOSTS.includes(target.hostname.toLowerCase())) {
    return NextResponse.json({ error: 'Host not in allowlist' }, { status: 403 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const imageResponse = await fetch(target.toString(), {
      signal: controller.signal,
      headers: {
        Referer: 'https://movie.douban.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    });

    if (!imageResponse.ok) {
      return NextResponse.json(
        { error: imageResponse.statusText },
        { status: imageResponse.status }
      );
    }

    const contentType = imageResponse.headers.get('content-type');

    if (!imageResponse.body) {
      return NextResponse.json(
        { error: 'Image response has no body' },
        { status: 500 }
      );
    }

    const headers = new Headers();
    if (contentType) {
      headers.set('Content-Type', contentType);
    }
    // 边缘缓存：半年，且允许后台重新验证
    headers.set(
      'Cache-Control',
      'public, max-age=15720000, s-maxage=15720000, stale-while-revalidate=604800'
    );
    headers.set(
      'CDN-Cache-Control',
      'public, s-maxage=15720000, stale-while-revalidate=604800'
    );
    headers.set(
      'Vercel-CDN-Cache-Control',
      'public, s-maxage=15720000, stale-while-revalidate=604800'
    );

    return new Response(imageResponse.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    return NextResponse.json(
      { error: aborted ? 'Image fetch timeout' : 'Error fetching image' },
      { status: aborted ? 504 : 500 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
