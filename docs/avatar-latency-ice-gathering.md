# 数字人出场延迟：根因分析、修复与实测数据

> 版本脉络：ICE 门控修复 v0.37.4.2（PR #95）；配套的 orientation 预热 v0.37.4.0（PR #93）、
> 人物形象秒出（截帧占位）v0.37.4.3。本文所有时间均为真实环境实测（本地前后端 + 真实 Azure
> Sweden Central Voice Live + 外部面试网关），非估算。

## 1. 现象

进入面试页面后，数字人（人物形象）要十几秒才出现；在此之前页面只显示占位的音频光球。
最坏情况（不停留、直接点过说明页）实测：**从点「开始面试」到数字人出画面共 ~16 秒**。

## 2. 什么情况下会出现这个问题

数字人的视频是一条独立的 WebRTC 连接（浏览器 ↔ Azure 数字人 TURN relay）。建立连接前，
浏览器要做 **ICE candidate 收集**——枚举本机每个网络接口的候选地址，写进 SDP offer。

原实现发出 offer 前等待以下三个信号之一：

1. `onicecandidate` 收到 **null candidate**（收集结束的标准信号）；
2. `icegatheringstatechange` 变为 **`complete`**；
3. **8 秒兜底超时**。

问题在于:在**多网络接口环境**下（VPN 虚拟网卡、mDNS 混淆地址、IPv6/公司代理等——开发者
和企业办公电脑的常态），前两个信号经常**永远不触发**：某个接口的收集一直悬着，浏览器就
一直不报 `complete`。于是**每一次**连接都硬等满 8 秒兜底超时才发 offer。

> 判断自己是否命中此问题：浏览器控制台里 `[avatar-stream] setLocalDescription done; gathering
> ICE for offer` 与 `offer ready` 两条日志之间相隔恰好 ≈8 秒（正好等于兜底值），即是。

## 3. 怎么理解这个修复

关键洞察：**Azure 数字人只走它下发的 TURN relay**（`session.updated` 里 `ice_servers: 1`，
一个带凭据的 relay）。也就是说，SDP 里只要有**一个 relay 类型的 candidate**，连接就能建立——
根本不需要等所有网卡的候选收集完。

修复（`frontend/src/hooks/useAvatarStream.ts`）：

- 收到**第一个 relay（或 srflx）candidate** 后，开一个 **300ms 收敛窗**（让同批候选一并写入
  SDP），然后立即发 offer；
- `typ host` 候选**不**触发快路径（局域网地址到不了 Azure 的 relay，发了也没用）；
- 原有三个信号（null candidate / `complete` / 8s 兜底）全部保留，作为不同网络环境下的兜底。

一句话：把「等收集全部完成」改成「等到**够用的那一个**就走」，语义上安全，因为最终连接
本来就只用 relay 候选。

## 4. 实测数据（修复前后，同一环境）

测量方法：给页面 console 注入时间戳记录器，最坏情况操作（页面加载后立即点「开始面试」，
说明页出现后立即点「I'm ready」，不留任何阅读时间）。

### 修复前（v0.37.4.1）

| 阶段 | 耗时 | 说明 |
|---|---:|---|
| 点「开始面试」→ 面试创建完成、开始连语音 | 2.76s | 含外部面试网关（BeiGene）一次往返 |
| WS proxy → Azure Voice Live 会话建立（`proxy.connected`） | 2.52s | 后端 → Sweden Central 的网络往返 |
| `session.updated`（拿到数字人配置 + ICE server） | 0.30s | |
| **ICE 收集 → offer 发出** | **7.99s** | **卡满 8s 兜底超时（本文主角）** |
| offer → SDP answer → ICE 连通 → 视频首帧 | 2.40s | Azure 侧建流 |
| **合计：点「开始」→ 数字人出画面** | **15.98s** | |

附带一个体验缺陷：为了「先见人再开口」设的 6 秒等待门在 ICE 停滞下必然超时——
`avatar-ready gate elapsed; reading first question anyway`——结果是**先闻其声、后见其人**。

### 修复后（v0.37.4.2）

| 阶段 | 耗时 | 说明 |
|---|---:|---|
| 点「开始面试」→ 面试创建完成、开始连语音 | 4.00s | 外部网关往返（该次偏慢，波动区间 ~2.5-4s） |
| WS proxy → Azure 会话建立 | 2.67s | 同上，网络固有 |
| `session.updated` | 0.30s | |
| **ICE 收集 → offer 发出** | **0.38s** | **8.0s → 0.38s，省 ~7.6s** |
| offer → answer → ICE 连通 → 视频首帧 | 3.88s | Azure 侧建流（含 1080p 首帧） |
| **合计：点「开始」→ 数字人出画面** | **11.25s** | 点「I'm ready」→ 出画面 7.2s |

修复后日志出现 `avatar ready → releasing held first question read`——数字人**先出现、
后开口**，等待门恢复了设计意图。

### 真实用户的体感时间线（配合 v0.37.4.0 的说明页预热）

上表是「秒点通过」的最坏情况。v0.37.4.0 起，语音+数字人连接在**说明页出现的瞬间**就开始
预热（此时机 = 能拿到面试会话的最早时刻），候选人阅读说明的时间与连接过程重叠：

- 说明页阅读 **≥7 秒**（正常速度）：点「I'm ready」时数字人**已就绪，零等待**；
- 阅读 3-4 秒就点：还需等 ~3-4 秒（此时显示人物静态形象占位，见下）；
- 预热期间麦克风自动静音、不读题，进入答题阶段才解除并朗读第一题。

### 剩余 ~11 秒（最坏情况）还能不能压？

剩余构成全部是**网络/服务固有往返**，客户端无法消除：

| 构成 | 量级 | 性质 |
|---|---:|---|
| 外部面试网关取第一题 | ~2.5-4s | 第三方服务 RTT |
| 后端 → Azure Voice Live 会话建立 | ~2.5s | 跨区域 RTT（Sweden Central） |
| Azure 数字人建流到首帧（1080p） | ~3.9s | Azure 侧固有 |

所以进一步的优化走**感知层**：v0.37.4.3 起，上一次会话会自动截取一帧人物画面缓存在浏览器
（localStorage），下次进入时**人物形象立即显示**（略调暗 + 「连接中」提示），直播流一到
无缝淡入替换。首次访问以外，「人物出现」的体感时间 ≈ 0。

## 5. 后续如何避免类似问题

1. **不要死等 WebRTC gathering `complete`。** 多网卡/VPN 环境下它可能永远不来。正确姿势是
   「够用即走」：目标是 relay-only 服务时，等到第一个 relay candidate（+ 短收敛窗）即可，
   `complete` 与超时只做兜底。这是 WebRTC 集成的通用经验，不限于本项目。
2. **给每一段等待打上时间戳日志。** 本次能 10 分钟定位，靠的是握手代码原本就逐步打日志
   （`gathering ICE for offer` → `offer ready`），两条日志一减就看到 8 秒。新增等待逻辑时，
   入口/出口各打一条。
3. **优化前先实测分解，不要猜。** 「数字人慢」的候选嫌疑有五六个（token 获取、后端、Azure、
   ICE、首帧）；console 注入计时器一跑，8/16 秒落在谁身上一目了然。修完再跑同一脚本对比，
   数字就是证据。
4. **固有 RTT 消不掉，就用「重叠」和「占位」。** 连接成本挪到用户阅读说明的时间里
  （预热）、人物形象用上一次的截帧秒出（占位）——用户感知的等待可以远小于技术上的等待。
5. **凡是「兜底超时」被打满的路径都值得报警。** 兜底是给罕见情况的；如果它每次都被打满，
   说明主信号失效了——本例即是。日志里给兜底触发加显式标记（`gate elapsed` 这类字样），
   巡检时 grep 即可发现。

## 6. 相关代码位置

- ICE 门控（本次修复）：`frontend/src/hooks/useAvatarStream.ts`（`runHandshake` 内
  `offerReadyPromise`；常量 `ICE_SETTLE_AFTER_CANDIDATE_MS = 300`）
- 说明页预热 + 读题阶段门 + 预热期静音：`frontend/src/pages/InterviewPage.tsx`（v0.37.4.0）
- 人物形象截帧占位：`frontend/src/components/AvatarView.tsx`（v0.37.4.3）
- 后端凭据预热（启动即预取 Entra token，首个连接不付 3-5s 凭据链成本）：
  `backend/app/main.py` `_prewarm_azure_credential`
- 生产静态资源缓存（immutable 哈希资源 + no-cache 入口页）：`frontend/nginx.conf`（v0.37.4.2）
