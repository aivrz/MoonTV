import { NextResponse } from 'next/server';

import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { getDetailFromApi } from '@/lib/downstream';
import {
  resolveSearchCacheTtlMs,
  runWithCache,
  videoDetailCache,
} from '@/lib/search-cache';
import { SearchResult } from '@/lib/types';

export const runtime = 'edge';

function buildCacheHeaders(cacheTime: number) {
  return {
    'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
    'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
    'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const sourceCode = searchParams.get('source');

  if (!id || !sourceCode) {
    return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
  }

  if (!/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: '无效的视频ID格式' }, { status: 400 });
  }

  try {
    const apiSites = await getAvailableApiSites();
    const apiSite = apiSites.find((site) => site.key === sourceCode);

    if (!apiSite) {
      return NextResponse.json({ error: '无效的API来源' }, { status: 400 });
    }

    const cacheTime = await getCacheTime();

    // 详情按 source+id 缓存并合并在途请求，播放页重复进入/换源时直接命中
    const result = await runWithCache<SearchResult>(
      videoDetailCache,
      `${sourceCode}::${id}`,
      resolveSearchCacheTtlMs(cacheTime),
      () => getDetailFromApi(apiSite, id)
    );

    return NextResponse.json(result, {
      headers: buildCacheHeaders(cacheTime),
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
