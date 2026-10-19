/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/lib/db';
import { fetchVideoDetail } from '@/lib/fetchVideoDetail';
import { SearchResult } from '@/lib/types';

export const runtime = 'edge';

// 并发处理上限：刷新播放记录/收藏时同时请求多个上游详情
const REFRESH_CONCURRENCY = 5;

export async function GET(request: NextRequest) {
  console.log(request.url);
  try {
    console.log('Cron job triggered:', new Date().toISOString());

    // serverless 环境下必须 await，否则函数返回后后台任务会被销毁
    await refreshRecordAndFavorites();

    return NextResponse.json({
      success: true,
      message: 'Cron job executed successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cron job failed:', error);

    return NextResponse.json(
      {
        success: false,
        message: 'Cron job failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

/**
 * 以固定并发数执行任务列表，返回与入参等长的结果数组。
 * 单个任务失败不影响其他任务（由任务内部自行 try/catch）。
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, tasks.length)) },
    async () => {
      while (cursor < tasks.length) {
        const current = cursor++;
        results[current] = await tasks[current]();
      }
    }
  );
  await Promise.all(workers);
  return results;
}

async function refreshRecordAndFavorites() {
  if (
    (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage'
  ) {
    console.log('跳过刷新：当前使用 localstorage 存储模式');
    return;
  }

  try {
    const users = await db.getAllUsers();
    if (process.env.USERNAME && !users.includes(process.env.USERNAME)) {
      users.push(process.env.USERNAME);
    }
    // 函数级缓存：key 为 `${source}+${id}`，值为 Promise<VideoDetail | null>
    const detailCache = new Map<string, Promise<SearchResult | null>>();

    // 获取详情 Promise（带缓存和错误处理）
    const getDetail = async (
      source: string,
      id: string,
      fallbackTitle: string
    ): Promise<SearchResult | null> => {
      const key = `${source}+${id}`;
      let promise = detailCache.get(key);
      if (!promise) {
        promise = fetchVideoDetail({
          source,
          id,
          fallbackTitle: fallbackTitle.trim(),
        })
          .then((detail) => {
            // 成功时才缓存结果
            const successPromise = Promise.resolve(detail);
            detailCache.set(key, successPromise);
            return detail;
          })
          .catch((err) => {
            console.error(`获取视频详情失败 (${source}+${id}):`, err);
            return null;
          });
      }
      return promise;
    };

    for (const user of users) {
      console.log(`开始处理用户: ${user}`);

      // 播放记录
      try {
        const playRecords = await db.getAllPlayRecords(user);
        const totalRecords = Object.keys(playRecords).length;

        const tasks = Object.entries(playRecords).map(
          ([key, record]) => async () => {
            try {
              const [source, id] = key.split('+');
              if (!source || !id) {
                console.warn(`跳过无效的播放记录键: ${key}`);
                return false;
              }

              const detail = await getDetail(source, id, record.title);
              if (!detail) {
                console.warn(`跳过无法获取详情的播放记录: ${key}`);
                return false;
              }

              const episodeCount = detail.episodes?.length || 0;
              if (episodeCount > 0 && episodeCount !== record.total_episodes) {
                await db.savePlayRecord(user, source, id, {
                  title: detail.title || record.title,
                  source_name: record.source_name,
                  cover: detail.poster || record.cover,
                  index: record.index,
                  total_episodes: episodeCount,
                  play_time: record.play_time,
                  year: detail.year || record.year,
                  total_time: record.total_time,
                  save_time: record.save_time,
                  search_title: record.search_title,
                });
                console.log(
                  `更新播放记录: ${record.title} (${record.total_episodes} -> ${episodeCount})`
                );
              }

              return true;
            } catch (err) {
              console.error(`处理播放记录失败 (${key}):`, err);
              // 继续处理下一个记录
              return false;
            }
          }
        );

        const done = await runWithConcurrency(tasks, REFRESH_CONCURRENCY);
        console.log(
          `播放记录处理完成: ${done.filter(Boolean).length}/${totalRecords}`
        );
      } catch (err) {
        console.error(`获取用户播放记录失败 (${user}):`, err);
      }

      // 收藏
      try {
        const favorites = await db.getAllFavorites(user);
        const totalFavorites = Object.keys(favorites).length;

        const tasks = Object.entries(favorites).map(
          ([key, fav]) => async () => {
            try {
              const [source, id] = key.split('+');
              if (!source || !id) {
                console.warn(`跳过无效的收藏键: ${key}`);
                return false;
              }

              const favDetail = await getDetail(source, id, fav.title);
              if (!favDetail) {
                console.warn(`跳过无法获取详情的收藏: ${key}`);
                return false;
              }

              const favEpisodeCount = favDetail.episodes?.length || 0;
              if (favEpisodeCount > 0 && favEpisodeCount !== fav.total_episodes) {
                await db.saveFavorite(user, source, id, {
                  title: favDetail.title || fav.title,
                  source_name: fav.source_name,
                  cover: favDetail.poster || fav.cover,
                  year: favDetail.year || fav.year,
                  total_episodes: favEpisodeCount,
                  save_time: fav.save_time,
                  search_title: fav.search_title,
                });
                console.log(
                  `更新收藏: ${fav.title} (${fav.total_episodes} -> ${favEpisodeCount})`
                );
              }

              return true;
            } catch (err) {
              console.error(`处理收藏失败 (${key}):`, err);
              // 继续处理下一个收藏
              return false;
            }
          }
        );

        const done = await runWithConcurrency(tasks, REFRESH_CONCURRENCY);
        console.log(
          `收藏处理完成: ${done.filter(Boolean).length}/${totalFavorites}`
        );
      } catch (err) {
        console.error(`获取用户收藏失败 (${user}):`, err);
      }
    }

    console.log('刷新播放记录/收藏任务完成');
  } catch (err) {
    console.error('刷新播放记录/收藏任务启动失败', err);
  }
}
