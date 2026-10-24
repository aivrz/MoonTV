/// <reference lib="webworker" />
import { defaultCache } from '@serwist/next/worker';
import { CacheFirst, ExpirationPlugin, NetworkOnly, Serwist, StaleWhileRevalidate } from 'serwist';
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const runtimeCaching: RuntimeCaching[] = [
  {
    // 跨源 fetch（destination 为空，即 JS fetch() 发出的 API 请求，如豆瓣/图片代理 JSON）
    // 一律直接走网络、不缓存不拦截。置于最前以覆盖 defaultCache 里的跨源兜底路由：
    // Safari 的 SW 处理此类跨源请求会 respondWith no-response，导致「获取豆瓣分类数据失败」，
    // 且此类 API 响应本就不该被 SW 缓存（ 配置/数据需即时生效）。
    matcher: ({ request, sameOrigin }) => !sameOrigin && request.destination === '',
    handler: new NetworkOnly(),
  },
  ...defaultCache,
  {
    // 谷歌字体：后台预加载 + 陈旧时重新校验
    matcher: /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/i,
    handler: new StaleWhileRevalidate({
      cacheName: 'google-fonts',
      plugins: [new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 7 * 24 * 60 * 60 })],
    }),
  },
  {
    // 静态图片：缓存优先，长期留存
    matcher: /\.(?:png|jpe?g|svg|webp|gif|ico|avif|webm)$/i,
    handler: new CacheFirst({
      cacheName: 'images',
      plugins: [new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 30 * 24 * 60 * 60 })],
    }),
  },
  {
    // 第三方图片代理（image-proxy）缓存
    matcher: /\/api\/image-proxy\?/,
    handler: new StaleWhileRevalidate({
      cacheName: 'image-proxy',
      plugins: [new ExpirationPlugin({ maxEntries: 256, maxAgeSeconds: 7 * 24 * 60 * 60 })],
    }),
  },
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching,
});

serwist.addEventListeners();
