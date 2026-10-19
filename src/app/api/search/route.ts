import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import {
  resolveSearchCacheTtlMs,
  runWithCache,
  searchResultCache,
} from '@/lib/search-cache';
import { SearchResult } from '@/lib/types';
import { yellowWords } from '@/lib/yellow';

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
  const query = searchParams.get('q');

  if (!query) {
    const cacheTime = await getCacheTime();
    return NextResponse.json(
      { results: [] },
      {
        headers: buildCacheHeaders(cacheTime),
      }
    );
  }

  try {
    const config = await getConfig();
    const apiSites = config.SourceConfig.filter((site) => !site.disabled);
    const cacheTime = await getCacheTime();
    const ttlMs = resolveSearchCacheTtlMs(cacheTime);

    // 缓存 key 带上源列表指纹：管理员调整资源站后旧缓存自动穿透失效
    const cacheKey = `${query}::${apiSites.map((site) => site.api).join('|')}`;

    // 先查缓存；未命中时合并同一关键词的并发请求，只扇出一次上游
    const flattenedResults = await runWithCache<SearchResult[]>(
      searchResultCache,
      cacheKey,
      ttlMs,
      async () => {
        const searchPromises = apiSites.map((site) =>
          searchFromApi(site, query)
        );
        const results = await Promise.all(searchPromises);
        let flattened = results.flat();
        if (!config.SiteConfig.DisableYellowFilter) {
          flattened = flattened.filter((result) => {
            const typeName = result.type_name || '';
            return !yellowWords.some((word: string) =>
              typeName.includes(word)
            );
          });
        }
        return flattened;
      }
    );

    return NextResponse.json(
      { results: flattenedResults },
      {
        headers: buildCacheHeaders(cacheTime),
      }
    );
  } catch (error) {
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
