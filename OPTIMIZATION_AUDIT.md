# MoonTV 接口与性能综合评估及优化方案

> 评估对象：`C:\Users\Administrator\Documents\GitHub\MoonTV`（MoonTV，Next.js 14 影视聚合播放器）
> 评估日期：2026-10-20
> 交付形态：**仅分析文档，不改动任何代码**（后续是否落地由决策者决定）
> 部署前提：**Cloudflare Pages + Workers**，目标用户含**中国大陆未备案**访问

---

## 0. 评估范围与方法

| 维度 | 内容 |
| --- | --- |
| 接口普查 | 外部数据源接口、内部 Next.js Route Handlers、全部 npm 依赖 |
| 版本核对 | 逐项确认是否使用「最新官方版本」并标注可升级项 |
| 性能优化 | 接口缓存、图片优化、打包体积、PWA、运行时 |
| 区域加载 | 中国大陆（未备案、Cloudflare）的具体加速措施 |
| 分片广告拦截 | 对比 LibreTV / dongguaTV / SCTE-35 生态，评估当前方案是否仍属最优 |

方法：只读代码审计（`src/app`、`src/lib`）+ npm registry 最新版本核对 + GitHub/技术社区公开方案调研。所有事实均附文件路径与行号，便于直接引用。

---

## 1. 接口普查与「最新官方版本」核对

### 1.1 外部数据源接口

> **重要结论**：外部数据接口大多**不存在「官方版本」概念**，它们是行业事实标准或被逆向的私有端点，升级的不是「版本」而是「健壮性 / 可用性」。

| 数据源 | 协议 / 格式 | 调用位置 | 现状与评估 |
| --- | --- | --- | --- |
| **苹果CMS V10 资源站** | `?ac=videolist&wd=` / `&ids=`（MacCMS V10 标准） | `src/lib/downstream.ts:24-25,106-110,201`；`src/lib/config.ts:27-45` | 行业事实标准，格式稳定。**无「新版本」可升**；风险在各源站可用性/质量参差、部分已失效。建议做源站健康探测 + 自动降级。 |
| **豆瓣 search_subjects** | `movie.douban.com/j/search_subjects`（JSONP 风，未公开） | `src/app/api/douban/route.ts:91`；`src/lib/douban.client.ts:223` | 逆向端点，无官方版本，**高失效风险**（豆瓣已关闭公开 API）。建议增加备用数据源（如 TMDB、 Bangumi）与失败兜底。 |
| **豆瓣 top250** | `movie.douban.com/top250` | `src/app/api/douban/route.ts:129` | 同上，逆向端点，易变。 |
| **豆瓣 rexxar** | `m.douban.com/rexxar/api/v2/subject/recent_hot` | `src/app/api/douban/categories/route.ts:98`；`src/lib/douban.client.ts:96` | 需特殊 `Referer`/`Origin`，**极易被风控**。建议服务端代理 + 缓存 + 失败降级。 |
| **GitHub VERSION.txt 自检** | `ghfast.top/raw.githubusercontent.com` → `raw.githubusercontent.com` | `src/lib/version.ts:16-17,27,33` | 双 URL 兜底，5s 超时。OK；可加本地缓存避免每次启动请求。 |
| **图片代理 / 豆瓣代理** | 用户可配置 `NEXT_PUBLIC_IMAGE_PROXY` / `NEXT_PUBLIC_DOUBAN_PROXY` | `src/lib/utils.ts:8-79`；`src/lib/douban.client.ts:39-40` | 经 `proxy.worker.js` 转发。详见 §3.4。 |

### 1.2 内部 Route Handlers（缓存头 / fetch 策略）

全部 23 个 `route.ts` 顶部均为 `export const runtime = 'edge';`（含 DB 后端路由）。下表为关键事实：

| 路径 | 外部上游 | 响应缓存头 | fetch 超时 / 重试 |
| --- | --- | --- | --- |
| `/api/search` | 苹果CMS（扇出全部源） | `Cache-Control: public, s-maxage=<cacheTime>` + `CDN-*`（`route.ts:17-19`） | 下游 8s（`downstream.ts:29-35`），无重试 |
| `/api/search/one` | 苹果CMS（单源） | 同上（`route.ts:21-23,68-70`） | 下游 8s |
| `/api/search/resources` | 无（读 config） | 同上 | 无 fetch |
| `/api/detail` | 苹果CMS / 特殊源 HTML 抓取 | 同上（`route.ts:16-18`） | 10s（`downstream.ts:203,278`） |
| `/api/douban` | 豆瓣 search_subjects + top250 | 同上（`route.ts:115-117,190-192`） | 10s |
| `/api/douban/categories` | 豆瓣 rexxar | 同上（`route.ts:122-124`） | 10s |
| `/api/image-proxy` | 任意 `?url=`（调用方可控） | `max-age=15720000`（约半年，`route.ts:46-48`） | **无超时**（`route.ts:15` 直接 fetch）⚠️ |
| `/api/cron` | 苹果CMS（经 fetchVideoDetail） | **无缓存头** | 下游 8s/10s |
| `/api/server-config` | 无 | **无缓存头** | 无 fetch |
| `/api/skipconfigs` | DB | **无缓存头** | 无外部 fetch |
| `/api/login` `/register` `/logout` `/change-password` | DB | **无缓存头** | 无 |
| `/api/favorites` `/playrecords` `/searchhistory` | DB | **无缓存头** | 无 |
| `/api/admin/*` | DB | 统一 `no-store` | 无 |

**缓存实现细节**：
- 应用层缓存为**纯内存 `TtlCache`**（`src/lib/search-cache.ts`：基于 `Map`+FIFO，最大 500 条，in-flight 合并防击穿），`resolveSearchCacheTtlMs = clamp(cacheTime/4, [60s,30min])`。**注意：serverless 多实例下各实例隔离，命中率低**（注释已自陈 L9-12）。
- `config.ts` 中 `cache_time` → `SiteInterfaceCacheTime`（默认 7200s）作为 `s-maxage` 消费；DB 配置另有 10s 内存缓存（`config.ts:54-55`）。
- **关键缺失**：`downstream.ts` 的 `fetch` 仅传 `{ headers, signal }`，**无 `cache:'no-store'`、无 `next:{revalidate}`**（全局 0 命中）。缓存完全依赖自研内存 + 响应头。

### 1.3 依赖库版本核对

| 依赖 | 项目声明 | 当前最新（npm registry） | 评估 |
| --- | --- | --- | --- |
| `next` | `^14.2.23` | **16.4.2** | 落后 2 个大版本。14→15→16 需 React 19 + App Router 调整。**建议分阶段：先升到 14.2.x 最新补丁，再评估 15/16**。 |
| `react` / `react-dom` | `^18.2.0` | **19.3.1** | 大版本，与 Next 15/16 绑定升级。 |
| `hls.js` | `^1.6.6` | **1.7.3** | 小版本，向后兼容。**建议直接升**，含播放稳定性/性能修复。 |
| `artplayer` | `^5.2.3` | **5.4.0** | 小版本。**建议升**（含 bug 修复）。 |
| `next-pwa` | `^5.6.0` | 5.6.0（**2022-08 后未更新**） | **事实上已停止维护**（原作者已弃坑）。React18/Next14 下勉强可用，但无后续支持、与 Next15+ 兼容性存疑。**建议迁移到 `@serwist/next`（9.5.13）或 `@ducanh2912/next-pwa`**。 |
| `@serwist/next` | 未引入 | **9.5.13** | next-pwa 的维护中官方推荐替代（基于 Serwist）。 |
| `tailwindcss` | `^3.4.17` | **4.3.3** | 大版本 v4（配置/PostCSS 全变）。可选升级，收益主要是构建速度；破坏性较大，建议独立评估。 |
| `@cloudflare/next-on-pages` | `^1.13.12` | **1.13.16** | 小补丁。**建议升**以修复 CF Pages 构建问题。 |
| `lucide-react` | `^0.438.0` | **1.59.0** | 大版本，图标 API 基本兼容。**建议升**。 |
| `typescript` | `^4.9.5` | **7.0.2** | 大版本。建议升到 5.x/最新，注意类型收窄与配置文件变化。 |
| `zod` | `^3.24.1` | **4.6.7** | 大版本（zod4）。schema API 基本兼容但有破坏性变更，需回归测试。 |
| `@upstash/redis` | `^1.25.0` | **1.39.0** | 小版本。**建议升**。 |
| `next-themes` | `^0.4.6` | **0.4.6** | 已是最新。 |

### 1.4 接口层面结论

1. **内部接口设计合理**：数据类只读接口已带 CDN 缓存头 + Edge Runtime；写接口/用户数据接口无缓存头（正确，避免脏读）。
2. **外部数据源无「版本」可升**，真正风险是豆瓣逆向端点高失效 + 源站可用性。优化方向是**健壮性**（缓存、代理、降级、备用源）。
3. **依赖层面**：`next-pwa` 是明确的「技术债/弃用项」；`hls.js`/`artplayer`/`@cloudflare/next-on-pages` 等小版本建议直接升；`next`/`react`/`tailwind`/`typescript`/`zod` 为大版本升级，建议分阶段评估。

---

## 2. 加载性能优化点

### 2.1 打包体积：播放器静态引入（高优先）

- `src/app/play/page.tsx:5-6` 与 `src/lib/utils.ts:3` **静态** `import Artplayer from 'artplayer'` / `import Hls from 'hls.js'`，全局搜索 `import('hls.js')` / `next/dynamic` / 动态 import → **0 命中**。
- `utils.ts` 被大量页面/组件依赖，导致 **hls.js 极易被纳入主客户端包并被重复打包**；ArtPlayer 也随 play 页进入其路由包。
- **优化**：播放器改为 `next/dynamic` 或 `import()` 动态加载（仅进入播放页时拉取）；`utils.ts` 中的 hls 依赖抽离到播放页专用模块，避免污染公共包。预估可削减首屏 JS 数百 KB。

### 2.2 图片优化（高优先）

- `next.config.js:14` `images.unoptimized: true` + `remotePatterns: **`（http+https 通配）→ 图片**不走 Next 优化、原图直出**。
- 海报图来自第三方（含豆瓣，国内常不稳定/防盗链）。建议：
  - 启用 CF **Image Resizing** 或经已支持的 `image-proxy` 做尺寸压缩（降低海外大图回国带宽）。
  - 给 `image-proxy` 增加 `CDN-Cache-Control` 边缘缓存（当前仅 `max-age=15720000` 无 `CDN-`，未必命中边缘）。
  - 海报使用 `loading="lazy"`、合理 `sizes`，避免首屏一次性拉满。

### 2.3 接口缓存策略（中优先）

- 当前缓存靠「自研内存 `TtlCache` + 响应头」，**serverless 多实例命中率低**（`search-cache.ts` 已自陈）。
- **优化**：补充 `Cache-Control: s-maxage` 已做，但可加 `stale-while-revalidate` 提升命中与回源体验；对豆瓣等不稳定源做**服务端兜底缓存**（失败返回上次成功结果而非直接报错）；`image-proxy` 增加**超时 + 域名白名单**（当前无超时、任意 `?url=` 回源，存在 SSRF/慢源风险）。

### 2.4 PWA：next-pwa 弃用（中优先）

- `next.config.js:67-72` 使用 `next-pwa`（2022 起未维护）。对二次访问/离线有利，但技术债明确。
- **优化**：迁移到 `@serwist/next`（API 相近、维护活跃、支持 Next14/15）。迁移成本低、风险小，且能修掉 next-pwa 与新版构建的潜在冲突。

### 2.5 其他（低–中优先）

- `next.config.js:9` `reactStrictMode:false`：建议开启（开发期双调用已无碍，利于发现副作用问题）。
- 开启 **HTTP/3 (QUIC)** 与 **Brotli** 压缩（CF 默认支持，确认构建产物已 gzip/brotli）。
- `proxy.worker.js:144` 强制 `no-store` + `Access-Control-Allow-Origin: *`：图片经此代理时无缓存且完全开放，**应改为按资源类型缓存 + 收紧 CORS**（见 §3.4）。
- 预连接：`next/font` 自托管字体、对图片/接口域名 `<link rel="preconnect">`。

---

## 3. 面向中国大陆用户（未备案 · Cloudflare）的区域加载优化

### 3.1 现实约束（必须先认清）

- Cloudflare **免费/Pro 无中国大陆节点**；中国大陆访问 CF 常被戏称「减速器」，延迟高、偶发打不开。
- `*.pages.dev` / `*.workers.dev` 自 2022 起常被 **DNS 污染/阻断**（实测解析到 127.0.0.1 或非预期 IP）。**务必绑定自定义域名**绕开。
- **未备案**前提下，**不能**使用阿里云 CDN / 腾讯云 CDN 国内版 / 百度云加速（均强制 ICP）。可行前提：**源站在海外**，由「无需 ICP 的境外/国际版 CDN」或「优选 IP」前置。

### 3.2 前端静态资源加速（推荐组合）

| 措施 | 是否需备案 | 效果 | 说明 |
| --- | --- | --- | --- |
| **绑定自定义域名**（绕开 pages.dev 污染） | 否 | 基础、必做 | 先在 CF Dashboard 关联再配 DNS，否则 522。 |
| **腾讯云 EdgeOne 国际版 前置** | 实名、**不需 ICP**（源站海外） | 延迟 300ms+ → 30-40ms | 作为 CF Pages 的前层 CDN；静态资源强制缓存 TTL 7-30 天；回源 HOST 指向 `xxx.pages.dev`；回源必须 HTTPS。社区实测最稳方案。 |
| **enhanced-FaaS-in-China**（CNAME 优选 IP） | 否 | 免费、按运营商选路 | 每 ~40min 测速，为电信/联通/移动各自选最优 CF IP，改一条 CNAME 即可（2954 Stars）。 |
| **DNSPod 分运营商解析** | 否 | 中等 | 电信/联通/移动各自优选 Cloudflare 任播 IP。 |

> 推荐落地顺序：**自定义域名 → EdgeOne 国际版前置（缓存静态）** 为主，**enhanced-FaaS-in-China / DNSPod 优选 IP** 为辅助兜底。

### 3.3 媒体（m3u8 / .ts 分片）加速

- 视频分片流量大，**不建议全量走 Cloudflare Worker**（CPU 时间/出带宽受限、计费高）。
- **推荐架构**：
  1. **m3u8 清单经 Cloudflare Worker 边缘改写 + 缓存**（清单体积极小、可长缓存、且正是广告过滤的最佳落点，见 §4）。
  2. **被 GFW 阻断的源站**：用香港/新加坡轻量服务器或 Worker 做**分片中继**（仅对国内直连失败的源启用，避免全量代理）。
  3. **可直连的源**：客户端直连，省去中转带宽。
  4. 清单与分片 URL 同源（经 Worker/中继改写），规避跨域与防盗链。

### 3.4 图片与豆瓣代理加速

- `proxy.worker.js` 当前 `no-store` + `CORS *` 且转发任意 URL——既无缓存又开放，国内每次回源慢且易被滥用。
- **优化**：
  - 图片代理增加**边缘缓存**（`Cache-Control: public, s-maxage=86400, stale-while-revalidate`），海报类静态资源命中边缘后国内秒开。
  - 收紧为**域名白名单**（仅允许豆瓣/已知图床域），消除 SSRF/开放代理风险。
  - 豆瓣 API 经服务端代理 + 缓存（参考 `image-proxy` 模式），避免客户端直连被风控。

### 3.5 推荐部署拓扑

```
国内用户
  │
  ├─ 静态前端/JS/CSS/图片 ──► EdgeOne 国际版(边缘缓存) ──► Cloudflare Pages(源站, 自定义域名)
  │
  ├─ m3u8 清单 ──► Cloudflare Worker(边缘改写+广告过滤+缓存)
  │
  └─ .ts 分片 ──► 可直连源: 客户端直连
                 被墙源: HK/SG 中继 或 Worker(按需)
豆瓣/图片 ──► Worker 代理(白名单+缓存)
```

---

## 4. 分片广告拦截专题评估

### 4.1 当前实现（MoonTV）

`src/lib/m3u8-ad-filter.ts`（纯函数 + hls.js Loader 工厂）：
- **客户端**拦截 `manifest`/`level` 请求，仅处理媒体播放列表（主播放列表原样返回）。
- **legacy**：仅删 `#EXT-X-DISCONTINUITY` 标记行。
- **smart（默认）**：以 `#EXT-X-DISCONTINUITY` 切分组，「分片数 < 15 且总时长 3–120s」判为广告组整组移除；带 **20% 保险丝**（待删占比过高则回退 legacy，宁可有广告不可误删正片）。
- 代码注释明确「参考 **dongguaTV**」。另有 `m3u8-ad-filter.test.ts` 单测。

### 4.2 同类开源对比

| 项目 | 位置 | 技术 | 关键规则 |
| --- | --- | --- | --- |
| **dongguaTV** (EdNovas) | **Cloudflare Worker 边缘（server-side）** | m3u8 经 Worker 改写 | ① 以 `#EXT-X-DISCONTINUITY` 分组，3–120s 且 <15 分片=候选广告；② 豁免：单组不处理、正片镜头切分/定长打包不删；③ 额外剔除：<0.5s 非 ts 追踪分片、异域且挂 `.vip/.bet/.top/.xyz` 等可疑后缀分片；④ 20% 保险丝，永不输出 0 分片；⑤ 删时顺带清理 `#EXT-X-CUE`/`DATERA...` 标记。 |
| **LibreTV** | 客户端 hls.js Loader | 识别 `#EXT-X-DISCONTINUITY` 与 `#EXT-X-CUE-OUT` 标记，检测短时长分片，实时处理，strict/loose 两档 | 与 MoonTV 同源思路，但**额外感知 CUE-OUT 标记**，仍是纯客户端。 |
| **SCTE-35 / HLS 标准生态** | 规范层 | `#EXT-X-CUE-OUT`/`#EXT-X-CUE-IN`、`#EXT-X-DATERANGE`（CLASS=`com.apple.hls.interstitial`）、`#EXT-OATCLS-SCTE35`、`#EXT-X-GAP` | 现代 HLS 广告插入的**标准标记**。hls.js 原生支持 `EXT-X-DATERANGE`（interstitial）并忽略非标准 `EXT-X-CUE`。`stormcloud-video-player`、`HLS-SCTE35-monitoring-web` 等展示了基于 SCTE-35 的精准对齐方案。 |

### 4.3 是否仍是最优技术？

- **核心启发式（DISCONTINUITY 分组 + 时长/分片数 + 保险丝）本身并未过时**：它正是 dongguaTV、LibreTV、MoonTV 三者共同采用的社区事实标准，对「无标准标记的野广告」仍是唯一有效手段。**结论：算法思路仍属当前最优可用方案，不算落后。**
- **但 MoonTV 的「架构与覆盖面」相对次优**：
  1. **纯客户端**：广告分片 URL 仍被客户端请求（浪费带宽、需跨域、对防盗链/阻断源失效）；dongguaTV 已在 **Worker 边缘**完成过滤，客户端根本不拉广告。
  2. **未覆盖 dongguaTV 的额外规则**：可疑 TLD/异域分片剔除（`.vip/.bet/.top/.xyz`）、`<0.5s` 追踪分片、`#EXT-X-CUE`/`DATERANGE` 清理、单组豁免。
  3. **未利用标准标记**：对明确发出 `#EXT-X-CUE-OUT/IN`、`#EXT-X-DATERANGE`（SCTE-35）、`#EXT-X-GAP` 的源，未做显式检测（LibreTV 已感知 CUE-OUT）。

### 4.4 推荐最优方案

**分层、可落地的「当前最优」组合**（不脱离现有代码，渐进式）：

1. **把过滤下沉到边缘（最大收益，对齐 dongguaTV）**：新增/复用 Cloudflare Worker，在 m3u8 出口处做清单改写 + 广告剔除 + 分片 URL 同源化。客户端**不再请求广告分片**，同时顺带解决 §3.3 的中国大陆媒体加速。**复用现有 `m3u8-ad-filter.ts` 纯函数**（已是独立模块），Worker 与客户端共享同一套判定逻辑，避免逻辑分叉。
2. **补齐 dongguaTV 级额外规则**：可疑 TLD/异域分片剔除、`<0.5s` 追踪分片、单组清单豁免、`#EXT-X-CUE`/`DATERANGE` 清理。
3. **增加标准标记感知**：显式检测 `#EXT-X-CUE-OUT`/`#EXT-X-CUE-IN`、`#EXT-X-DATERANGE`（SCTE-35）、`#EXT-X-GAP`，优先按标记精准剔除（比纯启发式更准）。
4. **保留客户端 Loader 作为兜底**：未经代理直连的源，沿用当前 smart 模式（并同步补齐上述规则），保证「代理不可用时仍有基础去广告」。
5. **保险丝与可观测**：保留 20% 保险丝；在 UI 展示「已过滤 X 个广告」（现有 `onStats` 回调已支持），并记录误删率以便调参。

> 一句话：**「DISCONTINUITY 启发式」仍是当下最优可用算法；MoonTV 需要升级的是「执行位置（客户端→边缘）+ 规则覆盖度（补 TLD/SCTE-35/GAP）+ 客户端兜底」**，而非替换算法本身。

---

## 5. 综合评估结论

1. **接口**：内部 Route Handlers 设计合理（Edge + CDN 缓存头），无需重构；外部数据源无「版本」可升，瓶颈在豆瓣逆向端点高失效与源站可用性，应转向健壮性（缓存/代理/降级/备用源）。
2. **依赖**：`next-pwa` 已弃用（首要技术债）；`hls.js`/`artplayer`/`@cloudflare/next-on-pages`/`@upstash/redis`/`lucide-react` 等小版本建议直接升；`next`/`react`/`tailwind`/`typescript`/`zod` 大版本升级需分阶段回归。
3. **性能**：最大可量化收益来自**播放器动态加载**（削减首屏数百 KB）+ **图片优化/边缘缓存**；`image-proxy` 需补超时与白名单（安全+性能双赢）。
4. **区域加载（未备案）**：Cloudflare 直连不可行，**「自定义域名 + EdgeOne 国际版前置 + 优选 IP」** 是当前最稳的免备案方案；媒体走「Worker 改写缓存 + 按需中继」。
5. **分片广告拦截**：当前算法思路仍是社区最优，**架构与覆盖度次优**；升级到「边缘过滤 + 补齐 dongguaTV 规则 + SCTE-35/GAP 感知 + 客户端兜底」即为当前最优方案，且与区域加速天然复用同一 Worker。

---

## 6. 优化优先级清单

### A. 接口升级

| 优先级 | 项 | 动作 | 风险 | 收益 |
| --- | --- | --- | --- | --- |
| P1 | next-pwa 迁移 | 换 `@serwist/next` (9.5.13) | 低（API 相近） | 消除弃用债、兼容新版构建 |
| P1 | image-proxy 加固 | 加超时 + 域名白名单 + `CDN-Cache-Control` | 低 | 安全(SSRF/开放代理)+性能 |
| P2 | 小版本依赖升级 | hls.js→1.7.3、artplayer→5.4.0、@cloudflare/next-on-pages→1.13.16、@upstash/redis→1.39.0、lucide-react→1.59.0 | 低–中 | 稳定性/修复 |
| P2 | 豆瓣健壮性 | 服务端代理+缓存+失败兜底+备用数据源(TMDB/Bangumi) | 中 | 可用性大幅提升 |
| P3 | 大版本升级 | next 14→16/React 19、tailwind v4、typescript 7、zod4 | 高 | 长期维护，需分阶段回归 |
| P3 | 源站健康探测 | 自动降级失效 MacCMS 源 | 低 | 搜索成功率 |

### B. 性能提升

| 优先级 | 项 | 动作 | 风险 | 收益 |
| --- | --- | --- | --- | --- |
| P1 | 播放器动态加载 | play 页 `next/dynamic` 加载 ArtPlayer/Hls；`utils.ts` 抽离 hls 依赖 | 低 | 首屏 JS 削减数百 KB |
| P1 | 图片优化 | 关 `images.unoptimized` 或走 CF Image Resizing；`loading=lazy`+`sizes` | 低 | 首屏渲染/带宽 |
| P2 | 接口缓存增强 | 加 `stale-while-revalidate`；豆瓣/源站失败返回上次缓存 | 低 | 命中率与回源体验 |
| P2 | 启用 HTTP/3 + Brotli | CF 侧确认 | 低 | 传输性能 |
| P3 | reactStrictMode=true | 开启 | 低 | 副作用早发现 |

### C. 区域加载（未备案 · Cloudflare）

| 优先级 | 项 | 动作 | 风险 | 收益 |
| --- | --- | --- | --- | --- |
| P0 | 绑定自定义域名 | 绕开 pages.dev 污染（先关联再配 DNS） | 低 | 国内可访问基础 |
| P1 | EdgeOne 国际版前置 | CF Pages 前层 CDN，静态强缓存 7-30 天，回源 HTTPS 到 pages.dev | 中（需实名，不需 ICP） | 延迟 300ms+→30-40ms |
| P1 | 媒体边缘架构 | m3u8 经 Worker 改写+缓存+广告过滤；被墙源 HK/SG 中继，可直连源直连 | 中 | 播放起播快、广告同步去除 |
| P2 | 优选 IP / DNSPod 分运营商 | enhanced-FaaS-in-China 或 DNSPod 智能解析 | 低 | 进一步压低延迟、抗抖动 |
| P2 | 图片/豆瓣代理优化 | 边缘缓存 + 白名单，修 proxy.worker.js `no-store`/`CORS *` | 低 | 海报/豆瓣国内秒开、消除滥用 |

### D. 分片广告拦截（评估结论落地）

| 优先级 | 项 | 动作 | 风险 | 收益 |
| --- | --- | --- | --- | --- |
| P1 | 边缘过滤 | 复用 `m3u8-ad-filter.ts` 纯函数到 Cloudflare Worker，m3u8 出口改写+同源化分片 | 中 | 客户端不拉广告、顺带解决 §3.3 加速 |
| P1 | 补齐规则 | 可疑 TLD/异域分片剔除、`<0.5s` 追踪分片、单组豁免、`#EXT-X-CUE`/`DATERANGE` 清理 | 低 | 误删率↓、覆盖率↑ |
| P2 | 标准标记感知 | 显式 `#EXT-X-CUE-OUT/IN`、`#EXT-X-DATERANGE`(SCTE-35)、`#EXT-X-GAP` 检测 | 低 | 精准去广告（现代源） |
| P2 | 客户端兜底 | 直连源沿用 smart 模式（同步补齐规则），保留 20% 保险丝 + UI 统计 | 低 | 无代理时仍有基础去广告 |

---

> **说明**：本文档为只读评估产物，未修改任何源文件。所有「动作」均为建议，落地前请结合回归测试与备案/合规要求审慎执行。
