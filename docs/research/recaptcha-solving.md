# reCAPTCHA 自动求解方案调研

> 调研日期：2026-02（以文中标注的来源页面发布内容为准）
>
> 场景：CEF/Chromium 152 指纹浏览器，全新会话（无可信 cookie）+ 数据中心 IP 访问
> `google.com/search` 被重定向到 `google.com/sorry/index`，页面加载
> reCAPTCHA（anchor URL 为 `/recaptcha/enterprise/anchor?k=6LdLLIMbAAAAAIl-…`，
> sitekey 前缀 `6LdLLIMb`，即 Google 自家 /sorry 页所用 key）。
> 目标：评估「自动通过该挑战」的可行方案，供产品决策。

---

## 0. TL;DR

- `google.com/sorry` 上的 reCAPTCHA 是各家打码服务的**显式支持场景**：
  2captcha、CapSolver、Anti-Captcha、CapMonster Cloud、NextCaptcha 都有专门的
  Enterprise 任务类型，且在文档中点名 "Google Search / google.com/sorry"。
- 关键工程约束：**对 Google 自家服务，解题端必须使用与浏览器会话相同的
  出口 IP（代理透传模式）+ 一致 UA + google.com cookies + 页面上的
  一次性 `data-s` 参数**。proxyless 模式拿到的 token 大概率被拒。
- 价格区间：Enterprise token 约 **$0.6 – $5 / 1000 次**（2captcha $1–2.99、
  CapSolver/CapMonster $1.0、NextCaptcha $0.6–1.0、Anti-Captcha $5）。
- 自托管音频路线（Whisper 转录）在 DC IP 上基本不可行——Google 会对被标记
  IP 关闭音频挑战入口或无限追加挑战；IP 信誉是硬门槛，与求解技术无关。
- 最优策略是**不打码**：住宅/移动代理换 IP + 会话信任老化；打码作为兜底。

---

## 1. 商业打码服务

通用集成模式：把 `websiteURL` + `websiteKey`（sitekey，取自 anchor 的 `k=`
参数或 `data-sitekey`）+ 可选 `data-s`/`enterprisePayload`、UA、cookies、
代理凭证 POST 到服务商 `createTask` API → 轮询取回 `gRecaptchaResponse`
token → 注入页面 `g-recaptcha-response` 字段或回调。所有家都兼容
Anti-Captcha 风格的 task-type API（`RecaptchaV2EnterpriseTask` 带代理 /
`...Proxyless` 不带代理）。

### 1.1 2captcha

| 项 | 内容 |
|---|---|
| 类型 | 人工+AI 混合打码平台，API / 浏览器扩展 / 各语言 SDK |
| Enterprise 支持 | **Y**。独立任务类型 `RecaptchaV2EnterpriseTaskProxyless` / `RecaptchaV2EnterpriseTask`（带代理），或老接口 `in.php` 加 `enterprise=1` |
| 集成方式 | createTask/getTaskResult API；注入 `g-recaptcha-response`；支持 `data-s`（`data-s`/`enterprisePayload`）、`cookies`、`userAgent`、`apiDomain`、代理参数 |
| 价格 | reCAPTCHA Enterprise：**$1 – $2.99 / 1000**（动态定价）；普通 v2 同档 |
| 成功率/速度 | 官方页宣称按量动态；NopeCHA 对比表给出 ~26s/token（第三方口径，仅供参考） |
| /sorry 专项 | **有官方文档**：`data-s` 为一次性值，每次挑战需重新提取；建议走代理 + cookies + UA（见 §4.2） |
| 来源 | https://2captcha.com/api-docs/recaptcha-v2-enterprise · https://2captcha.com/pricing · https://2captcha.com/blog/google-search-recaptcha · https://2captcha.com/h/how-to-scrape-data-from-google-search |

文档原话（重要）："`RecaptchaV2EnterpriseTask` — used for cases when **IP
matching is required on Google service like Google Search, YouTube, etc.** Bad
proxies will drastically decrease the success rate."（API 文档）

### 1.2 CapSolver

| 项 | 内容 |
|---|---|
| 类型 | AI 打码平台（API + 浏览器扩展 + SDK） |
| Enterprise 支持 | **Y**。`ReCaptchaV2EnterpriseTask`（需自带代理）/ `ReCaptchaV2EnterpriseTaskProxyLess`；另有 `ReCaptchaV3EnterPrise` |
| 集成方式 | createTask API；支持 `enterprisePayload`（s 值）、`pageAction`、`isInvisible`、`apiDomain`、`proxy` |
| 价格 | ReCaptchaV2Enterprise **$1.00 / 1000 token**；v3 Enterprise $3.00/1000；普通 v2 $0.80/1000 |
| 成功率/速度 | 官方博客自称 "highly reliable"；无公开 SLA 数字 |
| 来源 | https://docs.capsolver.com/en/pricing/ · https://docs.capsolver.com/en/guide/captcha/ReCaptchaV2/ · https://www.capsolver.com/blog/reCAPTCHA/recaptcha-enterprise-solver |

### 1.3 Anti-Captcha

| 项 | 内容 |
|---|---|
| 类型 | 人工打码平台（2007 年起），API + 官方 npm/python/java SDK |
| Enterprise 支持 | **Y**。`RecaptchaV2EnterpriseTask`（带代理）/ `RecaptchaV2EnterpriseTaskProxyless`；任务分给 "workers with the best reCaptcha V3 score" |
| 集成方式 | createTask API；`enterprisePayload.s`、UA、cookies、代理参数；返回 worker UA/cookies 供回写 |
| 价格 | reCAPTCHA Enterprise v2/v3：**$5 / 1000**（全场最贵档；普通 v2 $0.95–2） |
| 成功率/速度 | 标称解题速度 ~5s 起 |
| /sorry 专项 | 文档明确："Use this type of task [带代理] to solve reCaptchas **in Google services**. In all other cases, use RecaptchaV2TaskProxyless." |
| 来源 | https://anti-captcha.com/apidoc/task-types/RecaptchaV2EnterpriseTask · https://anti-captcha.com/mainpage · https://anti-captcha.com/apidoc/task-types/RecaptchaV2Task |

### 1.4 CapMonster Cloud

| 项 | 内容 |
|---|---|
| 类型 | AI 打码云（ZennoLab），API + 浏览器扩展 + JS SDK |
| Enterprise 支持 | **Y**。`RecaptchaV2EnterpriseRequest`，支持 `enterprisePayload.s` 与可选代理参数 |
| 集成方式 | createTask API / `@zennolab_com/capmonstercloud-client` SDK / 扩展 |
| 价格 | v2 Enterprise **$1.00 / 1000 token**（宣称 97% 成功率）；v3 Enterprise $1.50（98%）；特定难站（Spotify、Yahoo 等）单独 $4.00 档；代理费含在价格内 |
| 成功率/速度 | 标称 97%–99%，NopeCHA 对比表给出 ~11s（第三方口径） |
| 来源 | https://capmonster.cloud/en/recaptcha/ · https://capmonster.cloud/en/recaptcha-enterprise/ |

### 1.5 NextCaptcha

| 项 | 内容 |
|---|---|
| 类型 | AI 打码平台，Anti-Captcha 兼容 API |
| Enterprise 支持 | **Y**。`RecaptchaV2EnterpriseTaskProxyless`（另有带代理变体）；支持 `enterprisePayload`、`pageAction`、`apiDomain` |
| 集成方式 | `https://api.nextcaptcha.com/createTask` + getTaskResult |
| 价格 | ReCaptchaV2 Enterprise **$0.6 – $1.0 / 1000**（分档），普通 v2 $0.5 |
| 成功率/速度 | 宣称 99%、<10s（厂商口径） |
| 来源 | https://nextcaptcha.com/price · https://nextcaptcha.com/apidocs/recaptcha-v2-enterprise-proxyless |

### 1.6 YesCaptcha

| 项 | 内容 |
|---|---|
| 类型 | 打码平台（主要面向中文用户），Anti-Captcha 兼容 API |
| Enterprise 支持 | **Y（但有保留）**。`RecaptchaV2EnterpriseTaskProxyless`（20 POINTS/次，1000 POINTS = ¥1，约合 **¥20 ≈ $2.8 / 1000**） |
| 集成方式 | createTask/getTaskResult |
| 注意 | 官方 wiki 原话："It may be difficult to pass the enterprise v2 verification through this API at the moment. If you are having trouble passing the verification, I suggest exploring other methods" —— 自家文档承认当前 Enterprise v2 通过率可能不佳 |
| 来源 | https://yescaptcha.atlassian.net/wiki/spaces/YESCAPTCHA/pages/64192968 · https://yescaptcha.atlassian.net/wiki/spaces/YESCAPTCHA/pages/64192755 |

### 1.7 NopeCHA

| 项 | 内容 |
|---|---|
| 类型 | AI 识别服务：浏览器扩展（本地识别点击）+ Token API + Python/Node 库 |
| Enterprise 支持 | **不确定**。支持列表只列 reCAPTCHA v2/v3（识别 1 credit；v2/v3 token 20 credits），未单列 Enterprise。扩展路线在渲染出的挑战上操作，理论上不区分 key 类型，但未经证实 |
| 集成方式 | Chrome/Firefox 扩展（CEF 不兼容 Chrome 扩展体系，此路线对我们基本不可用）；或 Token API 注入 |
| 价格 | 免费 100 次/天（**非住宅 IP 不可用免费额度**）；订阅 $4.99/月（2k 次/天）至 $99.99/月（200k 次/天）；官方口径识别 90,000 次/$1、token 4,500/$1 |
| 速度 | 识别 ~1.5s；token ~60s |
| 来源 | https://nopecha.com/pricing · https://developers.nopecha.com/ |

### 1.8 EndCaptcha

| 项 | 内容 |
|---|---|
| 类型 | 人工打码（SLA 赔付制），DBC/DeCaptcher 兼容 API |
| Enterprise 支持 | **不确定/倾向 N**。API 页只列 reCAPTCHA v2/v3，无 Enterprise 任务类型；credit 包制（$11.99/3000 起，≈$4/1000） |
| 集成方式 | API tunneler / hosts 重定向（DBC 协议）——与现代 task API 不同代 |
| 价格 | $11.99 – $479 包档；标称 7–8s 人工解题、>95% 正确率 |
| 来源 | https://endcaptcha.com/ · https://endcaptcha.com/api |

### 1.9 其它同族服务（备查）

uCaptcha、CaptchaAI、CaptchaSonic 等均为同一套 task-type API 变体
（`ReCaptchaV2Token`/`...ProxyLess`），文档一致建议「目标站做 IP 绑定时传
自有代理」。来源：https://ucaptcha.net/docs/getting-started/proxy-configuration/
· https://blog.captchaai.com/proxy-authentication-methods-captchaai ·
https://captchasonic.com/en/docs/guides/advanced

---

## 2. 自托管 / 开源求解器

两条技术路线：**音频挑战转录**（点耳机图标 → 下载 mp3 → STT → 填答案）与
**图像挑战识别**（YOLO/CLIP 点选 tile）。共同前提：需要一个能通过 Google
前端检测的真实浏览器 + 没被拉黑的 IP。对我们的 CEF 场景，前者意味着指纹
本身没问题，后者是硬伤。

### 2.1 音频转录路线

| 项目 | 活跃度 | 原理 | 备注 |
|---|---|---|---|
| ecthros/uncaptcha2 | 2019 停更 | 屏幕点击器 + 免费 STT，~90% 准确率 | 学术 PoC 鼻祖（WOOT'17 论文 unCaptcha，85% 准确率/5.42s）；现仅历史价值 |
| sexfrance/RecaptchaV2-Solver | 2024-11 创建，~42★ | Python + patchright（反检测 Playwright）+ 语音识别，8–12s/次；同步/异步/HTTP API 三模式 | 目前较完整的工程化实现 |
| saifyxpro/recaptcha-v2-audio-solver | 近期 | faster-whisper 本地转录 + undetected-chromedriver | 无外部 API key |
| k19-sudo/recaptcha-v2-resolver-free | 近期 | TS + Playwright + @xenova/transformers(Whisper) | README 明确警告：**同一 IP 请求过多时 Google 会直接关闭音频挑战**（"Your computer or network may be sending automated queries"），IP 轮换是关键 |
| yfe404/recaptcha-audio-solver | PoC | Playwright + Whisper | 自述"heavy use may trigger rate limiting" |
| ibedevesh/capsolver | 近期 | 本地 Whisper | 声称 near-100%（可信 IP 前提下） |
| mihneamanolache/recaptcha-solver (RektCaptcha) | npm 包 | Vosk STT + Puppeteer/Playwright | 支持 ES/CJS |
| drogjh/python-recaptchav2solver | 维护中 | Selenium + Google Speech Recognition | pip 包 |
| danielgatis/playwright-recaptcha-solver | 近期 | Playwright + wit.ai | 返回 g-recaptcha-response |

来源：https://github.com/ecthros/uncaptcha2 ·
https://uncaptcha.cs.umd.edu/papers/uncaptcha_woot17.pdf ·
https://github.com/sexfrance/RecaptchaV2-Solver ·
https://github.com/saifyxpro/recaptcha-v2-audio-solver ·
https://github.com/k19-sudo/recaptcha-v2-resolver-free ·
https://github.com/yfe404/recaptcha-audio-solver ·
https://github.com/ibedevesh/capsolver ·
https://github.com/mihneamanolache/recaptcha-solver ·
https://github.com/drogjh/python-recaptchav2solver ·
https://github.com/danielgatis/playwright-recaptcha-solver

**对 Enterprise 是否适用**：适用性上「理论通用」——这些工具操作的是渲染后
的挑战 UI，不区分 api.js / enterprise.js。但实际约束在 **IP/会话信誉**：
在被 Google 标记的 DC IP 上，常见结果是音频挑战入口被禁、无限 "multiple
correct solutions required"、或直接硬拒。音频路线在我们场景下大概率
成功率极低，除非先解决 IP 信誉。

### 2.2 图像识别路线（YOLO/CLIP）

| 项目 | 活跃度 | 原理 | 备注 |
|---|---|---|---|
| Vinyzu/recognizer | 活跃 | YOLOv8-seg + CLIP ViT-B/16 + CLIP-Seg，Playwright 同步/异步 agent | README 明确：必须配 Patchright/Botright 等反检测引擎，否则识别对了也过不了 |
| DannyLuna17/VisionAIRecaptchaSolver | 活跃（前作 RecaptchaV2-IA-Solver 已归档） | 57k 数据集 YOLO 分类+检测模型，支持 3x3/3x3 动态/4x4；本地 HTTPS 复制 widget 域 | 同步/异步 API + CLI + 代理支持 |
| yaroslavorl/ReCaptchaV2-DeepLearning-Solver | 维护中 | YOLO 分割（mask∩cell 判定），支持动态挑战 | 可自定义节奏模拟人工 |
| jk20202/rcap | 较小 | Selenium + YOLO | pip 包 |

来源：https://github.com/Vinyzu/recognizer ·
https://github.com/DannyLuna17/VisionAIRecaptchaSolver ·
https://github.com/yaroslavorl/ReCaptchaV2-DeepLearning-Solver ·
https://github.com/jk20202/rcap

图像路线的难点不在模型精度，而在**挑战轮次与风险评分**：低信誉会话会被
要求连解多轮且判定更苛刻；Google 也会故意给模糊 tile。该路线与音频路线
一样绕不开 IP 信誉问题。

### 2.3 v3/行为评分路线（旁证）

AmitHaina/Recaptcha-Solver-V3：不开挑战、跑真 Chromium + 指纹轮换 +
拟人行为刷 v3 分数（https://github.com/AmitHaina/Recaptcha-Solver-V3）。
对我们有参考价值——印证"真实指纹 + 行为预热"换信任的思路，但 /sorry 页
是 checkbox/挑战式而非纯评分，不直接适用。

### 2.4 名称澄清

- **hektCaptcha**（Wikidepia/hektCaptcha-extension，已归档）是 **hCaptcha**
  求解器，与 reCAPTCHA 无关，勿混淆。
- 其它常被一起提到的扩展类：rektCaptcha 为 hCaptcha/reCAPTCHA 识别扩展。

---

## 3. 行为规避路线（不打码）

### 3.1 Google 官方对 /sorry 的设计

- 「unusual traffic」帮助页：网络（含 VPN）疑似发送自动流量时触发
  reCAPTCHA；解出后提示消失、可继续使用；反复出现则指向共享网络滥用、
  可疑 IP、目标站被攻击。
  https://support.google.com/websearch/answer/86640 ·
  https://developers.google.com/recaptcha/docs/faq
- 即 /sorry 本质是 **IP/网络信誉 + 会话信任** 的挑战，不是每次请求独立
  校验——解出一次会为该 IP/会话换取一段时间的信任。

### 3.2 会话信任老化（我们已实测）

- 实测结论与第三方资料一致：2captcha 2025 教程明确 "**Cookies from the
  google.com domain are critically important. Without them, the success
  rate drops significantly.**" 并建议手动过一次挑战后导出 `NID`/`ANID`
  cookie 供后续使用。
  https://2captcha.com/h/how-to-scrape-data-from-google-search
- CaptchaAI 列出的触发信号：单 IP 查询速率、**DC/被标记代理 IP**、
  **无 Google 会话 cookie**、行为模式雷同、JS 指纹缺失——与我们
  "老 cookie 会话通过、新会话被拦、首页预热无效" 的观察吻合。
  https://blog.captchaai.com/search-results-captcha-handling
- 推论：单纯访问首页预热无效，是因为信任信号主要来自 **历史 cookie
  （NID/ANID/SID 系）+ IP 信誉**，而不是当次会话的浏览行为时长。

### 3.3 住宅代理换 IP

- 2captcha 教程：打 google 系列验证码 "Use residential or mobile
  proxies…Make sure the IP is not blacklisted"；无代理会 "quickly detects
  automation and blocks access"。
- RTILA 社区："If you are still getting the google.com/sorry page, it
  usually means your IP is completely burned…ensure your proxy provider
  is passing clean residential IPs."
  https://rtila.net/t/solving-recaptcha-v2-enterprise-token-rejected-or-stuck-on-google-com-sorry/98
- NopeCHA 免费档直接排除非住宅 IP（https://developers.nopecha.com/）。
- 即：**住宅/移动代理既是避免触发 /sorry 的手段，也是打码解题端
  （带代理任务）和被拦会话恢复信任的共同前提**。

---

## 4. 关键约束事实核查

### 4.1 Enterprise 与普通 v2 的 sitekey/接口是否通用

- **key 层面可互通**：Google 官方 `MigrateKey` API 可把经典 reCAPTCHA key
  迁移为 Enterprise key，迁移后 "can be used from either product"（两侧
  均可用，siteverify 调用按 CreateAssessment 计费）。
  https://cloud.google.com/recaptcha/docs/reference/rpc/google.cloud.recaptchaenterprise.v1
- **前端差异**：经典版加载 `api.js` + `grecaptcha.*`；Enterprise 加载
  `enterprise.js` + `grecaptcha.enterprise.*`；Enterprise render 可带额外
  `s` 等参数（`enterprisePayload`）。后端差异：siteverify vs
  `projects.assessments.create`（assessment 可携带 `user_ip_address`、
  `user_agent`——即站点**可以**做 IP/UA 一致性校验，取决于站点实现）。
  https://cloud.google.com/recaptcha/docs/api-ref-checkbox-keys ·
  https://cloud.google.com/recaptcha/docs/create-assessment-website
- 对求解方的实际意义：sitekey 照传即可，但必须选对任务类型
  （`enterprise=1` / `RecaptchaV2EnterpriseTask`），并把 anchor 里的
  `s`/`data-s` 一并提交。/sorry 页 key `6LdLLIMb` 实测可走 Enterprise
  任务类型求解（2captcha 有专门教程）。

### 4.2 token 是否绑定 IP/UA（"解题 IP 要与使用 IP 一致"吗）

- **普通站点**：v2 token 一般**不绑定** IP——2captcha 官方博客（2020）原话：
  "A solution will work from your IP address with your UserAgent and
  cookies, while it was solved with worker's IP address…"；CaptchaAI 同样称
  多数 v2 实现不做 IP 绑定。
  https://2captcha.com/blog/google-search-recaptcha ·
  https://blog.captchaai.com/proxy-authentication-methods-captchaai
- **Google 自家服务（=我们的场景）例外**：各家文档一致要求对
  Google Search/YouTube 使用**带代理任务**，让 worker 经你的代理出口解题：
  - 2captcha："`RecaptchaV2EnterpriseTask` — used for cases when IP
    matching is required on Google service like Google Search, YouTube"
    https://2captcha.com/api-docs/recaptcha-v2-enterprise
  - Anti-Captcha：带代理任务 "to solve reCaptchas in Google services"
    https://anti-captcha.com/apidoc/task-types/RecaptchaV2Task
  - 2025 教程进一步收紧：cookies（NID/ANID）、真实 UA、住宅代理、
    一次性 `data-s` 四项皆备成功率才高。
    https://2captcha.com/h/how-to-scrape-data-from-google-search
- **`data-s` 一次性**：/sorry 页 HTML 内嵌 `data-s`，每个值只允许加载
  一次验证码。若先在浏览器里渲染了 widget 再把同一 data-s 发给服务商，
  token 会失效——需从页面源码提取后**避免重复渲染/重复消费**，每次挑战
  取新值。https://2captcha.com/blog/google-search-recaptcha

### 4.3 数据中心 IP 对成功率的影响

- DC IP 既是**触发原因**也是**成功率杀手**：2captcha 明示 "Bad proxies
  will drastically decrease the success rate and increase the solving
  time"；厂商普遍要求住宅/移动代理；NopeCHA 免费档排除非住宅 IP。
- 即使 token 注入成功，DC IP 上的会话信任分仍低，可能很快再被拦——
  打码解决"这一次"，不解决"一直被拦"。

### 4.4 对 CEF 集成的工程含义

- Chrome 扩展类方案（NopeCHA 扩展、CapMonster 扩展、hektCaptcha）依赖
  扩展体系，CEF 不易支持 → 优先 **API + JS 注入** 路线：
  拦截 /sorry 响应 → 解析 sitekey + `data-s` → 带本机代理/UA/cookies
  调 createTask → 注入 `g-recaptcha-response` → 触发表单提交。
- 自托管音频路线理论上也可在 CEF 内完成（JS 点击音频图标、fetch mp3、
  本地 Whisper、填 input），但受 §4.3 约束，DC IP 下收益存疑。

---

## 5. 合规风险（一句话）

自动求解 reCAPTCHA 以访问 Google 服务违反 Google ToS 中"不得以自动化手段
违规访问服务内容/scraping"的条款（https://policies.google.com/terms），
属合同层面禁止行为，可能导致 IP/账号被封；商业打码服务本身处于灰色地带，
使用风险自担（本笔记不提供法律意见）。

---

## 6. 对本项目的建议排序

按「投入产出 + 与我们实测数据的契合度」排序：

1. **住宅/移动代理轮换（治本，优先级最高）**
   /sorry 的触发主因是 DC IP 信誉。接入住宅代理池做首访出口，配合会话
   cookie 持久化，可让多数会话根本不触发挑战。这也同时满足 §4.2 打码
   所需的"同 IP 代理"前提。
2. **会话信任资产化**：为每个浏览器 profile 持久化 google.com cookies
   （NID/ANID 等），首次人工/打码过一次 /sorry 后复用该会话——与我们
   "老会话能过"的实测一致，成本为零。
3. **商业打码兜底（首选 2captcha，备选 CapSolver/CapMonster Cloud）**：
   - 2captcha `RecaptchaV2EnterpriseTask`（带代理版）：对 /sorry 有官方
     专项文档、参数最全（data-s/cookies/UA/代理），$1–2.99/1000；
   - CapSolver `ReCaptchaV2EnterpriseTask` $1.0/1000、CapMonster
     $1.0/1000（标称 97%）做 A/B 比价与成功率对比；
   - 集成要点：用**与浏览器会话相同的代理出口**下发任务，提交
     UA + google.com cookies + 当次 `data-s`；注入 token 后在该会话内
     完成跳转。proxyless token 在 Google 场景基本无效。
4. **自托管音频求解（Whisper）**：零边际成本、可完全嵌入 CEF，但受
   IP 信誉硬约束；仅在已有住宅代理的前提下值得做 POC，作为打码的
   降级/免费备份（参考 sexfrance/RecaptchaV2-Solver、
   k19-sudo/recaptcha-v2-resolver-free 的实现与警告）。
5. **不推荐**：图像识别自研（维护成本高且同样绕不开信誉问题）；
   NopeCHA/扩展类（Enterprise 支持不明 + CEF 不支持扩展）；
   YesCaptcha（官方自述 Enterprise v2 通过率低）；
   EndCaptcha（无 Enterprise 支持、协议老旧、单价高）；
   Anti-Captcha Enterprise（$5/1000，性价比最低，仅在其它家失效时兜底）。
