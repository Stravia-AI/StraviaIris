# omp (oh-my-pi) 针对 Google 搜索 reCAPTCHA 的措施与方案

调研对象：[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)（CLI 名为 `omp`），
基于 commit `62a4aa9`（main，2026-09 拉取）。所有结论来自其源码与自带文档，
本地副本位于 `%TEMP%\oh-my-pi`。

## 总体思路

**不做 reCAPTCHA 解题**。策略是四层纵深：① 尽量避免直连 Google（provider 链兜底）→
② 用浏览器指纹 headers 的普通 fetch 先试 → ③ 被拦就升级到 stealth headless Chromium →
④ 仍被拦则探测挑战页并报 429，交给下一个 provider。reCAPTCHA 对 omp 而言是
"检测并绕过"，不是"识别并求解"。

调用链：`google.ts` → `browserFetch()`（`browser-page.ts`）→
`fetchHtmlPage()`（带浏览器指纹 headers）→ 失败/被拦 →
`browseHtmlPage()`（`acquireBrowser` 拿共享 headless Chromium +
`applyStealthPatches`）。

## 1. Provider 链：结构性绕开

`web_search` 工具有 24 个 provider 的自动 fallback 链
（`packages/tui/src/tools/web-search.ts` 的 `SEARCH_PROVIDER_OPTIONS`），
**Google 排在第 22 位**，是最后几个 credential-free 抓取器之一：

```
parallel → perplexity → gemini → anthropic → codex → xai → zai → exa →
tinyfish → jina → kagi → tavily → firecrawl → brave → kimi → synthetic →
ollama → searxng → startpage → duckduckgo → ecosia → google → mojeek → public
```

- Google 抛 `SearchProviderError(429)` 后，`executeSearch()` 顺序推进到
  mojeek / public（`src/web/search/index.ts`）。
- `public` provider 并行 fan-out 到 5 个免凭证引擎
  （startpage、google、duckduckgo、ecosia、mojeek）并去重合并，
  单个引擎被封不影响整体（`providers/public.ts`，软超时 5s / 硬上限 30s）。
- 不打 google.com 也能拿 Google 结果的旁路：Gemini grounding（官方 API）、
  Startpage（Google 代理）、Ecosia（Google 后端）、SearXNG（自建元搜索）。

## 2. fetch 层：浏览器指纹 headers

`providers/browser-headers.ts`：

- 用 `HeaderGenerator`（header-generator 库）按"近 3 个版本、桌面端、
  Win/macOS/Linux、en-US/en、HTTP/2"生成**内部一致**的浏览器导航请求头：
  UA + 匹配的 `Sec-CH-UA*` client hints + `Sec-Fetch-*` + Accept 系列，
  每次请求随机化。
- 非随机模式回退到固定的 macOS Chrome 149 头集合。
- Google 请求额外带 `Referer: https://www.google.com/` +
  `Sec-Fetch-Site: same-origin`，伪装成站内导航（`browser-page.ts` `fetchHtmlPage`）。

SERP URL 参数选择降低 JS/ consent 摩擦（`google.ts` `buildSearchUrl`）：

- `udm=14`（纯网页结果，轻量 SERP）、`hl=en&gl=us`、`pws=0`（去个性化）、
  `num`、`tbs=qdr:*`（recency）。
- `formatScraperQuery()` 规范化并降级对抓取不友好的搜索算符。

## 3. 挑战检测：`blockReason()`

`google.ts` 把 Google 拦截分为两类：

| 类型 | 判定 | 含义 |
| --- | --- | --- |
| `traffic` | status 403/429、最终 URL 含 `/sorry/`、body 命中 `unusual traffic` / `detected unusual traffic` / `g-recaptcha` | Google 的 reCAPTCHA 墙 |
| `javascript` | body 含 `/httpservice/retry/enablejs` 且没有 `<h3>` 结果 | enablejs JS 挑战 |

两者都会让 `shouldFallback` 触发浏览器升级；浏览器渲染后仍被拦则
抛 `SearchProviderError("google", …, 429)`，错误文案明确建议
"try another web search provider or retry later"。

## 4. stealth headless 浏览器（核心反检测层）

### 4.1 进程与 profile

- `acquireBrowser({ kind: "headless" })` 走项目级共享 Chromium
  （`omp.browser.headless` broker daemon，`shared-daemon.ts`）。
- **持久化 userDataDir**（broker runtime 目录下 `*.profile`），跨启动/跨会话复用
  —— cookie 信誉可以累积，相当于"养号"（`shared-daemon.ts:74-83`）。
- 先导航 `GOOGLE_HOME_URL` 种 cookie，再导航 SERP URL，等 `a h3`
  选择器最多 10s（`browser-page.ts` `browseHtmlPage`）。
- 代理支持：`PUPPETEER_PROXY` → `--proxy-server`（可做出口 IP 轮换），
  `PUPPETEER_PROXY_BYPASS_LOOPBACK`、`PUPPETEER_PROXY_IGNORE_CERT_ERRORS`
  （`launch.ts` `buildHeadlessLaunchArgs`）。

### 4.2 启动参数去自动化特征（`launch.ts`）

- 自带 `--disable-blink-features=AutomationControlled`。
- `ignoreDefaultArgs` 精确剔除 9 个 puppeteer 默认自动化标记参数：
  `--enable-automation`、`--disable-extensions`、`--disable-default-apps`、
  `--disable-component-extensions-with-background-pages`、`--disable-popup-blocking`、
  `--disable-client-side-phishing-detection`、`--allow-pre-commit-input`、
  `--disable-ipc-flooding-protection`、`--metrics-recording-only`
  （Edge 例外保留 `--enable-automation`，否则 CDP 起来前进程会退）。

### 4.3 puppeteer-core 深度补丁（`patches/puppeteer-core@25.3.0.patch`）

- **不发送 `Runtime.enable`** —— 注释称其为"单一最容易被探测的自动化特征
  （Brotector/CreepJS/Cloudflare 都在探测）"。执行上下文改为按需拉取：
  `Runtime.evaluate globalThis`（idOnly 序列化）+ `Page.createIsolatedWorld`，
  子 frame 通过 `DOM.resolveNode` 从 objectId 反解 context id。
- 去掉 `//# sourceURL=__puppeteer_evaluation_script__` 标记
  （会从 error stack / debugger 脚本列表泄露自动化）。
- 丢弃 puppeteer 默认 `--disable-features` 列表（Translate、MediaRouter、
  AcceptCHFrame、OptimizationHints 等）——这些非标 flag 本身就是指纹。
- 新增 `//!world=main` 指令支持 main-world evaluate。

### 4.4 UA / Client Hints 覆盖（`launch.ts` `resolveUserAgentOverride`）

- `Network.setUserAgentOverride` + `Emulation.setUserAgentOverride` 双管齐下；
  通过 `Target.setAutoAttach` 自动覆盖后续新 target（page/webview/background_page）。
- `HeadlessChrome/` → `Chrome/`；Linux UA 改写为 `Windows NT 10.0; Win64; x64`。
- Sec-CH-UA brand 列表按主版本号轮换 GREASE "Not A Brand" 排列，
  fullVersionList / platform / platformVersion / architecture / bitness / mobile
  全套元数据保持一致。

### 4.5 14 段 document-start 注入脚本（`tools/puppeteer/0x_*.txt`）

统一包裹在一个 IIFE 里：先用同源 iframe 取**未被污染的原始 native 函数**缓存
（document-start 时无 documentElement 则退回 window），再用一个
`Function.prototype.toString` Proxy + WeakMap 让所有补丁函数打印
`function xxx() { [native code] }`，并补 `Object.getOwnPropertyDescriptor`。

| 文件 | 覆盖点 |
| --- | --- |
| 00 tampering | toString 注册表 + getOwnPropertyDescriptor 伪装 |
| 01 activity | `document.hidden/visibilityState/webkitHidden/hasFocus` → 前台可见 |
| 02 hairline | modernizr `#modernizr` div `offsetHeight` 0→1（headless 特征） |
| 03 botd | 删除 `navigator.webdriver`；重建 `window.chrome.{app,csi,loadTimes,runtime}`（含真实 TypeError 签名）；`Notification.permission`/`permissions.query`；清 `cdc_*` 属性 |
| 04 iframe | `iframe.contentWindow` proxy（frameElement、丢弃帧、数字索引、length=0） |
| 05 webgl | `UNMASKED_VENDOR/RENDERER` 按平台给 ANGLE 字符串；SwiftShader/llvmpipe/软件渲染检测→回退 profile；`getShaderPrecisionFormat` float 精度归一化 |
| 06 screen | `outerHeight = innerHeight + 88`（浏览器 UI 高度）；screen/avail/colorDepth 一致化；devicePixelRatio、visualViewport |
| 07 fonts | `queryLocalFonts` → 55 个常见字体；`fillText` 加 ±0.02px 噪声 |
| 08 audio | `baseLatency/outputLatency/sampleRate` 伪装；`OfflineAudioContext.startRendering` 注噪 |
| 09 locale | `navigator.language/languages` → `en-US, en` |
| 10 plugins | PluginArray/MimeTypeArray mock（Chrome PDF Viewer、Chrome PDF Plugin、Native Client） |
| 11 hardware | `navigator.hardwareConcurrency` → 8 |
| 12 codecs | `canPlayType` 对 `avc1.42E01E`/`x-m4a`/`aac` 返回 probably/maybe |
| 13 worker | `Worker`/`SharedWorker` 构造器 proxy，经 blob URL 往 worker 里注入 navigator UA/platform 伪装 prelude |

## 5. 同类抓取 provider 的配套手段（间接绕 Google CAPTCHA）

- **Startpage**（`startpage.ts`）：先 GET 首页，从 `/sp/search` 表单里提取
  `sc` 反机器人 token 和全部隐藏 input，再 POST 搜索 —— 复刻真实浏览器的
  表单握手；检测 `/en/errors/`、`/sp/captcha`、Gatsby captcha chunk 标记 → 429。
- **Mojeek**（`mojeek.ts`）：ALTCHA 验证墙**自动求解**——点击
  `altcha-widget` 复选框，等 PoW 验证后跳转回结果页（45s 上限，2 次尝试，
  间隔 1s）。这是唯一一处"解题"，但对象是 ALTCHA 而非 reCAPTCHA。
- **Ecosia**（`ecosia.ts`）：检测 Cloudflare 拦截（`_cf_chl_opt`、
  "Ecosia Firewall"、403/429）→ 429。
- **DuckDuckGo**（`duckduckgo.ts`）：检测 `anomaly-modal`/`anomaly.js` → 429。

## 6. 没做的事

- 没有 reCAPTCHA 求解器（无 2captcha/CapSolver/图片或语音解题）。
- Google 搜索路径不用用户真实 Chrome（`browser` 工具另有 Browser Relay
  MV3 扩展可接管用户浏览器，但 web_search 的 Google fallback 固定走
  headless daemon）。
- Google 单 provider 内不重试：浏览器尝试 1 次失败即交给链上下一个
  （对比 mojeek 为 2 次）。

## 对 StraviaIris 的可借鉴点

omp 全部反检测都在 **JS 注入 + CDP + 请求头** 层面（运行时可关可换），
而 Iris 走的是引擎补丁层。omp 方案里与引擎无关、可直接吸收的有：

1. 持久化共享 profile + 先访首页种 cookie 的"暖号"流程。
2. fetch-first / browser-escalate 两级管道和挑战页分类检测
   （`/sorry/`、`unusual traffic`、`g-recaptcha`、enablejs shell）。
3. 不发 `Runtime.enable`、去 `__puppeteer_evaluation_script__` sourceURL —
   CDP 侧最低暴露面，Iris 若在 C++ 层做可以更彻底。
4. 14 段 stealth 脚本覆盖面清单（webdriver/chrome.runtime/WebGL/屏幕/
   字体/音频/插件/worker）—— 与 Iris 现有 patch 覆盖面可对表。
5. `udm=14`、`pws=0` 等低摩擦 SERP 参数。
6. 多引擎 fallback 链 + `public` 并行聚合的结构性容灾，比单点过验证码可靠。

## 主要源码位置

- `packages/coding-agent/src/web/search/providers/google.ts`
- `packages/coding-agent/src/web/search/providers/browser-page.ts`
- `packages/coding-agent/src/web/search/providers/browser-headers.ts`
- `packages/coding-agent/src/web/search/providers/{startpage,mojeek,ecosia,duckduckgo,public}.ts`
- `packages/coding-agent/src/web/search/{index,provider,types}.ts`
- `packages/coding-agent/src/tools/browser/{launch,registry,shared-daemon}.ts`
- `packages/coding-agent/src/tools/puppeteer/00..13_stealth_*.txt`
- `patches/puppeteer-core@25.3.0.patch`
- `docs/tools/web_search.md`、`docs/tools/browser.md`
