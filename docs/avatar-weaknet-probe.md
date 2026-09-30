# 数字人弱网表现：实测方法、第一批数据与部署建议

> 状态：**调查完成，方案已实现（v0.40.0.0）**。第 1–4 节是实测数据，**第 5 节是落地的实现**，
> 包括实现期间才撞到的两条 Azure 硬约束（avatar 一次性协商、avatar 创建速率限制），它们把"切画面"
> 从廉价操作变成了昂贵操作。本文回答的问题：Azure 数字人流是否自适应码率、卡顿的机制是什么、
> 部署到客户办公网时该定什么规则。

## 1. 结论先行

1. **Azure 数字人发送端协商了 REMB 带宽反馈（`goog-remb` + `abs-send-time`），没有 transport-cc。**
   也就是说它具备按接收端估计降码率的能力，但是否真的降要靠限速实测（第二阶段）。
2. **接收端在 SDP 里声明的带宽上限（`b=AS` / `b=TIAS`）被 Azure 忽略。** 加了 `b=AS:500`，1080p
   视频数字人仍以 1.9 Mbps 发送。客户端没有带宽杠杆。
3. **服务端 `session.avatar.video.bitrate` 被 Azure 尊重。** 设 500 kbps，1080p 视频数字人从 1.5 Mbps
   降到 460 kbps；设 300 kbps，照片数字人从 645 kbps 降到 276 kbps。这是唯一可用的码率杠杆，
   已加为后端可选环境变量 `VOICE_LIVE_AVATAR_VIDEO_BITRATE`（默认不设 = Azure 默认）。
4. **"好网络"上数字人就已经在卡，机制是丢包 + 高 RTT 下的 NACK 重传。** 本机到 Azure 媒体服务器
   RTT 约 300 ms，直连（srflx→srflx，没走 TURN）。每丢一个视频包，重传要等一个 RTT 以上，
   解码器就冻结 0.3 s 左右。45 s 窗口里视频冻结 9 s（20%），音频有 0.8 s 被丢包隐藏算法补出来。
   **冻结次数与丢包数近似 1:1，所以降码率（少发包）在同等丢包率下直接减少冻结。**
5. **麦克风上行不是小数目：实测 540 到 680 kbps。** PCM16 24 kHz 加 base64 加 JSON 封装。办公网
   共享上行时，它可能比数字人下行先出问题。第二阶段要单独跑一档"上行受限"。
6. **照片数字人的码率优势比预期小：** 默认下只比视频数字人低约 2.4 倍（645 vs 1548 kbps），不是
   一个数量级。真正拉开差距靠的是 `video.bitrate` 上限，而不是换角色。

## 2. 测量方法

- 脚本：`frontend/e2e/avatar-weaknet-probe.spec.ts`（opt-in，真 Azure，不进 CI）。
- 原理：在页面注入脚本收集 `RTCPeerConnection` 实例与 SDP，每秒调用 `getStats()` 采
  inbound-rtp video/audio、selected candidate-pair，并包裹 `WebSocket.send` 统计麦克风上行字节。
- 输出：`frontend/e2e/output/weaknet-<PROFILE>-<时间戳>.json`（gitignored）+ 控制台逐秒表。
- 环境变量：`PROFILE` 标签、`PROBE_MS` 采样窗口、`BAS_KBPS` 注入 `b=AS` 上限。

```bash
# 后端 :8000（真 .env）、前端 :5173 已在运行
cd frontend
export E2E_API=http://127.0.0.1:8000/api E2E_ADMIN_USERNAME=... E2E_ADMIN_PASSWORD=...
LIVE_VOICE=1 PROFILE=baseline PROBE_MS=45000 \
  npx playwright test avatar-weaknet-probe --config=e2e/live.config.ts
```

**限速必须在 OS 层做。** Chrome DevTools 的网络限速只作用于 HTTP/WebSocket，不影响 WebRTC 的 UDP
媒体流。`frontend/e2e/scripts/netshape.sh` 封装了 macOS 自带的 dnctl/pfctl（需要 sudo），对非
loopback 流量限带宽、丢包、时延。

## 3. 第一批数据（无限速，本机开发网，每档 45 s，2026-09-30）

| 档位 | 角色 | 视频 kbps 均值(min/max) | 帧 | 视频丢包 | 冻结次数 / 秒 | NACK | 音频丢包 | 音频补偿采样 | RTT ms | 上行 kbps |
|---|---|---|---|---|---|---|---|---|---|---|
| 默认 | amira 照片 | 645 (389/839) | 512×512 @25 | 64 | 34 / 9.1 | 346 | 49 | 39 k | 315 | 676 |
| 默认 | lisa 视频 | 1548 (887/4164) | 1920×1080 @21 | 32 | 8 / 9.4 | 147 | 55 | 59 k | 296 | 535 |
| 客户端 `b=AS:500` | lisa 视频 | 1920 (764/3644) | 1920×1080 @25 | 1 | 59 / 15.2 | 522 | 45 | 33 k | 293 | 664 |
| 服务端 bitrate=500k | lisa 视频 | 460 (92/1481) | 1920×1080 @25 | 1 | 82 / 23.7 | 498 | 141 | 99 k | 291 | 623 |
| 服务端 bitrate=300k | amira 照片 | 276 (152/370) | 512×512 @25 | 4 | 2 / 0.6 | 8 | 8 | 13 k | 281 | 542 |
| 假网络字段试验（无效） | lisa 视频 | 2062 (947/3234) | 1920×1080 @25 | 1 | 76 / 18.9 | 546 | 57 | 38 k | 318 | 718 |
| 会话中 session.update 400k（被忽略） | lisa 视频 | 前 1184 / 后 2785 | 1920×1080 @25 | — | 72 / 19.3 | 557 | — | — | — | — |

读法说明：

- 音频丢包与视频码率无关，可以当作"这一轮网络有多差"的对照列。bitrate=500k 那一轮音频丢包是别的
  轮次的 3 倍，所以它的冻结数不能和基线比；bitrate=300k 那一轮网络最好，冻结数也最少。要下结论必须
  在限速下重复跑，不能靠开发网的随机波动。
- 冻结（freeze）是 WebRTC 统计里"帧间隔超过均值 3 倍或均值 + 150 ms"的次数。25 fps 下，一个包重传
  一个 RTT（300 ms）就是一次冻结。
- 协商到的编码：视频 H264（照片数字人还多给了 VP8 选项），音频 Opus 48k 立体声；说话时音频约
  130 kbps，静音期 DTX 到 1 到 2 kbps。
- ICE 路径全程 srflx→srflx，说明本机能直连 Azure 媒体服务器、没走 TURN。客户办公网若强制走
  TURN over TCP（443），时延和丢包恢复会更差，这也是第二阶段要覆盖的一档。

## 3.5 第一阶段补充：程序自适应的四个前提逐项验证（2026-09-30 下午，lisa 1080p）

目标是回答"程序能不能自己随网络调整"，先把每个前提单独验掉，再讨论方案。

| 前提 | 验证方法 | 结果 |
|---|---|---|
| Azure 会不会随接收端反馈自动降码率 | 需要真实限速；先试 Chromium 内置假网络字段试验（两种格式：`WebRTC-FakeNetworkReceiveConfig/link_capacity_kbps:500/` 与 `WebRTCFakeNetworkReceiveCapacityKbps/500/`） | **两种格式都没生效**（视频仍 1.9 到 2.1 Mbps），这版 Playwright Chromium 不含该管道。此项仍待 OS 级限速（sudo） |
| 会话中能否改码率 | 探针在连接后 12 s 经语音 WS 发 `session.update`，携带完整 `session.avatar` 对象、`video.bitrate=400000` | **Azure 接受消息、回 `session.updated`，但回显 bitrate 仍为 2000000，码率不变**。会话中改不了，只能重建会话 |
| 前端能否承受会话中多出来的 `session.updated` | 同上一轮观察 | 前端记录"session.updated received; avatar block present"但一次性握手守卫拦住了重握手，不会重连或黑屏，安全 |
| 办公网只放 TCP 时能不能连 | Chromium `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` | **60 s 内 avatar 连接从未到 connected**。Azure 下发的 ICE 只有 `turn:relay.communication.microsoft.com:3478`（UDP），没有 `?transport=tcp` 候选，客户端也无法自行加 TURN/TCP（凭据是 Azure 的） |

顺带从 `session.updated` 回显里拿到的事实：

- Azure 端 avatar 默认 `video.bitrate=2000000`、`gop_size=10`（25 fps 下每 0.4 s 一个关键帧，解释了 3 Mbps 级别的突发）、`output_protocol=webrtc`。
- **说话与静音的码率倒挂：** lisa 三轮都出现同一形态，读题期间约 1.1 到 1.4 Mbps，`switch_to_idle` 之后跳到 2.5 到 3.5 Mbps。数字人"听候选人说话"的静音阶段是最贵的阶段，面试大部分时间正是这个阶段。照片数字人没有这个现象（全程约 650 kbps）。
- 麦克风上行在数字人读题期间约 400 kbps，读完进入候选人回答阶段后升到 1.1 Mbps 再回落到 600 到 700 kbps。

对"程序自适应"的直接含义：

1. 自适应只能在**会话建立时**选码率，会话中不能调。所以自适应的落点是"面试开始前的探测 + 起始档位"，加上"网络恶化到一定程度时主动以低码率重建 avatar 连接"（复用现有 ICE 自愈重握手，代价几秒黑屏）。
2. 重建时能不能只重建 avatar 的 WebRTC 而不断语音 WS，取决于 `session.update` 是否允许在重建 `session.avatar.connect` 前换码率。上面那一轮已表明 `session.update` 改码率被忽略，因此重建 avatar 连接大概率也带不动新码率，很可能要整条 Voice Live 会话重连。这一点要在限速阶段验证。
3. UDP 被封的办公网当前直接没有数字人。这不是码率问题，是可达性问题，部署手册必须写进"UDP 3478 必须放行"，或者产品上提供"仅语音"降级。

## 3.6 通道结构澄清 + "关画面保声音"的两条路（2026-09-30 晚）

**通道结构。** 开启数字人时有两条独立通道：Voice Live WebSocket（麦克风上行、转写、VAD、题目控制，TCP 443）
和 avatar 的 WebRTC 连接（数字人**画面 + 说话声音**两条 RTP 轨道，服务端唇形对齐，UDP 3478 TURN）。
Azure 在 avatar 模式下**不**在 WS 上发 `response.audio.delta`，因此 3.5 节"UDP 被封"那一轮的准确描述是：
候选人能被听到和转写，面试官**既无画面也无声音**。3.5 节的"语音本身正常"指的只是 WS 一侧。

**路 A：同一条 avatar 连接里只收音频。** 浏览器 offer 里保留 `m=video` 但方向 `inactive`，音频 `recvonly`：

| 变体 | Azure 反应 | 结果 |
|---|---|---|
| 去掉 `m=video`（只有 audio） | `error`: "Avatar connection failed: WebRTC SDP negotiation failed: peer connect created failure: None is not in list" | **拒绝**。且前端把这个 error 当成需要重连 WS，连开了 3 条 PC，都失败 |
| 保留 `m=video` 但 `a=inactive` | 正常回 SDP answer，ICE connected，`ontrack kind=audio`，`switch_to_speaking` 后音频 60 到 80 kbps，读题完成；视频 0 kbps | **成功**。同一会话内即可"关画面保声音"，无需重建 |

路 A 的两个产品侧注意点（不改代码，先记录）：前端"首读等 avatar 就绪"的门是等**首帧视频**，纯音频时会等满超时（约 6 s）
才读题，需要改成"等音轨或首帧任一"；ICE 一样要求 UDP 可达，路 A 解决的是带宽，不是 UDP 封锁。

**路 B：重建会话，不带 `avatar`。** Azure 改为在 WS 上下发 PCM 音频，前端已有播放路径（无 character 的 persona 即此模式）。
代价是一次重连和几秒中断，但它是 UDP 被封时唯一能出声的路。

## 3.7 第二阶段部分数据（负责人本机 sudo 限速，2026-09-30 06:46–06:52，40 s/轮）

跑到 office-tight-lisa 时与探针的纯音频实验撞车中断（两者共用默认 persona），后三档待重跑。已有 5 轮：

| 档位（下/上 kbps，丢包，单向时延） | 角色 | 视频 kbps 均/小/大 | 视频丢包 | 冻结次/秒 | NACK 相关 | 音频丢包 | RTT ms | bwe 均/小 | 上行 |
|---|---|---|---|---|---|---|---|---|---|
| baseline（无限速） | amira | 505 / 357 / 626 | 0 | 0 / 0 | — | 0 | 285 | 798 / 538 | 596 |
| baseline（无限速） | lisa | 2382 / 1596 / 3374 | 4 | 71 / 18.8 | 高 | 134 | 291 | 2714 / 1752 | 836 |
| office-ok（4000/2000，0.5%，50） | amira | 782 / 292 / 1300 | 81 | 50 / 19.1 | — | 56 | 432 | 701 / 222 | 823 |
| office-ok（4000/2000，0.5%，50） | lisa | 1416 / 717 / 1818 | 34 | 61 / 24.6 | — | 67 | 441 | 1987 / 1609 | 507 |
| office-tight（1500/800，1%，80）可能被污染 | amira | 583 / 0 / 1320 | 0 | 0 / 0 | — | 0 | 631 | 915 / 581 | 611；ICE 中途 closed |

初步读法（待后三档确认）：

- **lisa 在 office-ok 下码率从基线 2.4 Mbps 降到 1.4 Mbps，且始终低于 `bwe`。** 这是 Azure 发送端对丢包/时延做了下调的迹象（REMB
  或基于 RR 丢包率），但 0.5% 丢包就把 1080p 拉到 1.4 M，代价是冻结更多（24.6 s / 40 s）。
- **amira 在 office-ok 下码率反而上升到 782 kbps**（重传字节），说明照片数字人的 650 kbps 是它的下限档，不再往下调。
- **冻结的真实驱动是重传事件数（NACK），不是最终丢包数。** lisa 多轮 `packetsLost` 只有 1 到 4 但冻结 60 到 80 次：丢的包都
  被 NACK 补回了（所以不计入 packetsLost），但每次补回等一个 RTT 就是一次冻结。3 节"冻结≈丢包"对 amira 成立，对 lisa 应改读为"冻结≈NACK 次数 / 若干"。
- office-tight 的 RTT 到 631 ms 后 avatar 连接在采样中途 closed，说明 1% 丢包 + 80 ms 单向时延已经触发 ICE 断开与自愈重握手。

**第二次运行（office-tight / office-bad / uplink-starved，六轮全失败）的原因与修正。** 页面显示
"Voice connection timeout (30s)"，后端日志是 8 次 aiohttp `ConnectionTimeoutError` 连 `wss://…/voice-live/realtime`：
限速范围包含了**后端→Azure 的 TCP**，1% 丢包 + 80 ms 单向时延让 TLS 握手过不去，会话根本没建。这在生产上不成立：
后端跑在 Azure 内，客户办公网只承载"浏览器→后端 WS"和"浏览器→Azure WebRTC"两条流。修正：`netshape.sh` 增加
scope 参数，视频档位只限 **UDP**（正是 avatar 媒体），uplink-starved 档限全部但丢包为 0（TLS 能握手，麦克风
600 kbps 挤不进 300 kbps 的上行）。第一次运行的 office-tight-amira 之所以连上了，只是 TLS 握手在丢包下碰运气成功。

## 3.8 第二阶段完整数据（UDP-only 限速，2026-09-30 07:47–07:50，40 s/轮）

限速只作用于 UDP（= avatar 媒体流），与客户办公网看到的一致。"死亡 t" = 视频码率归零的秒数；
"补偿占比" = 流死亡**之前**每秒被丢包隐藏算法合成的音频比例（48 kHz 基准），也就是面试官声音有多少是"编"出来的。

| 档位（UDP 下/上 kbps，丢包，单向时延） | 角色 | 视频 kbps | 解码 fps | bwe | RTT ms | 死亡 t | 死前音频补偿 | 冻结 s / 存活 s |
|---|---|---|---|---|---|---|---|---|
| baseline 无限速 | amira 512² | 505 | 24 | 797 | 284 | 存活 | 0.0% | 0.0 / 38 |
| baseline 无限速 | lisa 1080p | 2382 | 24 | 2714 | 291 | 存活 | 4.9% | 18.5 / 38 |
| office-ok 4000/2000, 0.5%, 50 | amira | 782 | 25 | 701 | 432 | 存活 | 2.1% | 19.1 / 39 |
| office-ok 4000/2000, 0.5%, 50 | lisa | 1415 | 26 | 1986 | 440 | 存活 | 2.5% | 24.6 / 38 |
| office-tight 1500/800, 1%, 80 | amira | 849 | 24 | 1206 | 473 | 存活 | 10.5% | 28.7 / 39 |
| office-tight 1500/800, 1%, 80 | lisa | 1053 | **0** | 1111 | 609 | 42 s | 10.7% | — |
| office-bad 800/400, 3%, 120 | amira | 827 | 24 | 504 | 644 | 42 s | 4.5% | 20.3 / 30 |
| office-bad 800/400, 3%, 120 | lisa | 718 | **0** | 597 | 876 | 44 s | **31.3%** | — |

### 结论一：Azure 确实会自适应降码率，方向正确、幅度也够

lisa 的视频码率随网络单调下降：2382 → 1415 → 1053 → 718 kbps，全程贴着 `availableIncomingBitrate`
（接收端 REMB 估计）走。amira 到 500 到 850 kbps 就不再往下，那是照片数字人的下限档。
**所以"让程序按带宽调码率"这件事 Azure 已经做了，我们不需要再实现一遍。**

### 结论二：但自适应救不了 1080p —— 丢包 1% 时它一帧都解不出来

office-tight 和 office-bad 两轮 lisa 的 `framesPerSecond` 从第二个采样点起就是 null、`totalDecodeTime`
和 `jitterBufferDelay` 全程不再增长：**约 1 Mbps 的视频字节一直在到，但解码器 30 多秒里没有成功解出一帧。**
画面停在首帧或黑屏，带宽照吃。同一档位下 amira 稳定 18 到 37 fps。

机制是**抖动缓冲预算 < RTT**：抖动缓冲目标 369 ms，而 RTT 609 ms。1080p 一帧要 5 个以上 RTP 包，
丢一个就要 NACK 重传，重传回来已经过了播放时刻 → 整帧丢弃 → 因为 H.264 的 P 帧依赖前帧，
后续整个 GOP 全部不可解。照片数字人一帧只占 1 到 2 个包，多数帧一次到齐，不依赖重传，所以照常播。
（`pliCount` 全程 0，说明接收端只靠 NACK 修复，没有请求关键帧重传，这条在 Azure 侧是否可配值得再查。）

**"冻结次数"这个指标在 1080p 上会骗人**：解不出帧就不会产生 freeze 事件，所以 lisa 的 freezeCount = 0
看起来比 amira 的 90 次"好"，实际是完全不动。判断视频健康要看 `framesPerSecond` 是否为 null。

### 结论三：胖视频流会饿死同一条连接上的音频 —— 这是最要命的一条

面试官的声音和画面共用一条 RTP 传输。office-bad 档 lisa 死前有 **31.3% 的音频是丢包隐藏算法合成的**，
同档 amira 只有 4.5%。也就是说：网络差的时候，1080p 数字人不仅自己不动，还把面试官的声音一起搞坏到
听不清。候选人听不清题目，面试直接作废。流死亡之后补偿率升到 100%（完全静音）。

### 结论四：媒体死亡后我们的自愈生效，但有 3 秒空窗

office-bad-amira 在 t=42 视频归零，t=46 ICE 报 disconnected，t=49 触发 `recovery attempt 1/3`，
t=50 重建 PeerConnection。宽限窗口按设计工作。但"码率归零"到"ICE 报错"之间有 4 秒，
这段时间界面仍显示数字人已连接，用户看到的是画面卡住且没有任何提示。

### 结论五：麦克风上行会把自己挤死（uplink-starved 档，两轮均失败）

上行限到 300 kbps（无丢包）后：后端连 Azure 的 `wss://…/voice-live/realtime` 超时 8 次，
能建起会话的那一轮里 ICE 收集从平时的 1 秒拖到 4.3 秒，`session.avatar.connect` 发出后
SDP 应答等不到，最终"Voice unavailable: Voice connection timeout (30s)"。

原因不是网络"慢"，是**我们自己的麦克风流把上行占满了**：PCM16 24 kHz + base64 需要约 600 kbps，
而管道只有 300 kbps。`session.avatar.connect` 携带数 KB 的 SDP，排在几百个麦克风音频帧后面发不出去。
**这是自伤型故障，不是环境限制** —— 降采样率到 16 kHz（约 400 kbps）或改走 WebRTC 上行（Opus 约 32 kbps）
能直接消除。测试脚本里该档限全部流量且丢包设 0，是为了让 TLS 握手能成功、只暴露带宽问题。

## 3.9 决定性测试：关画面留声音（office-bad 档，2026-09-30 08:40，对照组已复现）

同一档位（UDP 800/400 kbps、3% 丢包、120 ms 单向时延）四轮对比。"音频死亡" = 丢包隐藏算法合成比例
达到 100%（完全静音）的时刻；"死前补偿占比" = 在那之前面试官的声音有多少是编出来的。

| 变体 | 视频 kbps | 死前音频补偿 | 音频丢包 | RTT ms | 音频死亡 t | ICE |
|---|---|---|---|---|---|---|
| lisa 完整视频（第 1 轮） | 608 | 31.3% | 505 | 876 | 44 s | 中途 disconnected |
| lisa 完整视频（第 2 轮，复现） | 599 | **30.7%** | 525 | 871 | 48 s | 全程 connected |
| **lisa 纯音频**（video 轨 `inactive`） | 0 | **2.5%** | **66** | **534** | 49 s | **全程 connected** |
| amira 纯音频 | 0 | 4.8% | 72 | 532 | 42 s | 中途 disconnected，恢复已触发 |
| amira 完整视频（3.8 节） | 658 | 4.5% | 67 | 644 | 42 s | 中途 disconnected，恢复已触发 |

### 结论：关掉画面让语音质量提升一个数量级

- **音频补偿从 31% 降到 2.5%**，约 12 倍。音频丢包从 505 到 525 个降到 66 个。31% 意味着三分之一的
  语音是算法编出来的，候选人听到的是断续含混的题目；2.5% 属于偶尔一个字发毛，完全可听。
- **RTT 从 876 ms 降到 534 ms。** 这 340 ms 是我们自己的视频流在管道里排队造成的自伤延迟，
  它同时拖慢轮次交接（候选人要多等三分之一秒才听到下一题）。
- 对照组两轮分别 31.3% 和 30.7%，**这个结论是复现的，不是单次噪声。**

### 但纯音频不等于不死

三轮纯音频/低码率里，lisa 纯音频全程 ICE connected 最健康，amira 纯音频仍在 46 s 掉线并触发恢复。
3% 丢包下单次 40 秒窗口方差很大，可信的说法是：**纯音频把"听不清"变成"听得清"，但没有让连接不死。**
所以自适应方案里，纯音频降级和媒体层自愈两件事都要有，不能只做一件。

### 一个便宜的待验假设

1080p 在 1% 丢包下解不出帧的直接原因是"一帧跨 5 个以上包"。如果把 lisa 的 `video.bitrate` 压到
500 kbps（已有后端环境变量 `VOICE_LIVE_AVATAR_VIDEO_BITRATE`），一帧约 2 到 3 个包，
**可能恢复可解码性**（画面变糊但动起来）。这一档还没在限速下测过，一条命令即可：

```bash
# 后端带 VOICE_LIVE_AVATAR_VIDEO_BITRATE=500000 重启后
sudo PROFILES="office-tight office-bad" AVATARS="lisa" frontend/e2e/scripts/weaknet-phase2.sh
```

## 4. 第二阶段：限速档位（已跑完，见 3.7 / 3.8）

```bash
# 一键：sudo frontend/e2e/scripts/weaknet-phase2.sh   （档位表见脚本 profile_spec）
sudo frontend/e2e/scripts/netshape.sh on 4000 2000 0.5 50 udp   # office-ok（只限 UDP = avatar 媒体）
sudo frontend/e2e/scripts/netshape.sh on 1500 800  1   80 udp   # office-tight（VPN、共享上行）
sudo frontend/e2e/scripts/netshape.sh on 800  400  3   120 udp  # office-bad（拥塞、热点）
sudo frontend/e2e/scripts/netshape.sh on 4000 300  0   20 all   # uplink-starved：麦克风 WS 上行 vs 300 kbps，丢包 0
sudo frontend/e2e/scripts/netshape.sh off
```

每档跑 lisa 默认、lisa+bitrate 上限、amira 默认、amira+bitrate 上限四种，看三件事：

1. 限带宽后视频 kbps 是否自动跟着 `bwe`（availableIncomingBitrate）下降。下降 = REMB 自适应有效，
   上限只是保险；不下降 = 必须靠 `VOICE_LIVE_AVATAR_VIDEO_BITRATE` 硬限。
2. 冻结秒数占窗口的比例，以及 ICE 是否掉到 disconnected 触发我们的重握手（数秒黑屏）。
3. uplink-starved 档下 `up=` 列是否掉、转写是否变慢或出现"没听到你的回答"。

## 5. 已实现的方案（v0.40.0.0）

### 5.1 实现期间又撞到的两条 Azure 硬约束

第 3 节的方案假设"关画面"可以在活会话里重新协商一次 offer 就完成（§3.6 验证过 `a=inactive` 可行）。
写完真机一测，发现那次验证是在**建连时**就用 inactive，不是会话中途重协商。两条新约束：

1. **`session.avatar.connect` 每个会话只接受一次，没有断开或重协商事件。** 连接健康时再发 offer，
   Azure 回 `error: "WebRTC connection is in connected state"`。
   → 切换画面必须**重建整条 Voice Live 会话**（约 5 秒）。只有旧连接已坏时重发 offer 才被接受，
   这正是既有媒体层自愈能工作的原因。
2. **Azure 对 avatar 会话创建有速率限制。** 约 20 秒内第三次请求被拒：
   `"Avatar request was rate-limited. Retry after 43.0s."`
   → 自动切换必须自带冷却，否则被拒的请求会走完重连预算，页面最终显示"语音不可用"并切文字 ——
   一次网络抖动反而把面试打死。

这两条把"切画面"从廉价操作变成了昂贵操作，也决定了下面时序参数的取值。

### 5.2 落地的六件事

**一、健康度判决做成纯函数**（`frontend/src/hooks/avatarHealth.ts`，17 个单测）

- **主触发免阈值**：连续 2 个 2 秒窗口"视频字节在流但 `framesDecoded` 不增长"。这就是 3.8 节实测到的
  1080p 失效形态，不依赖任何标定值。
- **次触发**：`concealedSamples / totalSamplesReceived` 超过 0.15。用比值而非"每秒补偿数 ÷ 48000"，
  因为静音期 DTX 下两个计数器同时停增，按秒归一化会把安静读成 100% 损坏。
- **刻意不用 `freezeCount`**：3.8 节证明它在 1080p 上会骗人（解不出帧就不产生 freeze 事件，读数反而更好）。

**二、媒体层采样与切换**（`useAvatarStream.ts`）

每 2 秒 `getStats()`；判决要降级时**立刻关掉 PC**（这正是目的：视频是在饿死音频），然后通过
`onModeSwitchRequest` 请求上层重建会话。`runHandshake` 新增 `wantVideo` 参数控制 video m-line 方向。
纯音频永远没有首帧，所以以"音轨到达 + ICE connected"作为等价的 settled 点归零自愈预算。

**三、会话重建**（`useInterviewVoice.restartForMediaMode`）

有意重建，**不消耗 WS 重连预算**（走 `connect(..., false)`），`keepDraft` 保住候选人已说的话，
`resetTurnState` 把当前题目存起来由新会话重读。踩到一个坑：关 WS 前必须先摘掉 `onclose` 等处理器，
否则 `connect()` 已把 `intentionalCloseRef` 置回 false，旧 socket 的 onclose 会再触发一次连接 ——
实测表现为每次切换两条 "opening WS proxy"、两个 avatar 会话，直接撞上速率限制。

**四、不对称的冷却**

| 动作 | 冷却 | 理由 |
|---|---|---|
| 关画面 | **无** | 它是救场动作，任何延迟都是在让候选人继续听不清 |
| 开画面 | 60 秒 | 避开 43 秒的 retry-after；手动按钮在冷却期内禁用，而不是点了没反应 |
| 自动恢复 | 健康保持 45 秒 **且** 距降级 ≥ 60 秒 | 恢复失败则健康门翻倍（45→90→180 秒），累计 2 次失败后本场永久纯音频 |

最坏情况是两次约 5 秒的重建，而不是反复闪屏。若要彻底关掉自动恢复，把 `MAX_RESTORE_ATTEMPTS` 改成 0 即可。

**五、诚实的界面**

`AvatarView` 新增 `mediaMode` prop 与 `data-media-mode`，纯音频时显示"网络较弱 —— 已切换为语音模式"
（复用既有 connectingHint 药丸样式，稳定的琥珀点而非脉动绿点）。**刻意不复用 `voiceUnavailable`** ——
它的 `onError` 路径会 `setChannel("text")` 把候选人踢去文字频道，而媒体降级是更轻的状态。
另外 3.8 节结论四那个 4 秒空窗也补上了：采样器一发现视频字节归零就翻掉"已连接"，不等 ICE 报错。

**六、首读门改判据**

原来等首帧视频，纯音频下必然等满 6 秒才读题。改为等 `isMediaReady`（有帧 **或** 纯音频音轨就绪）。

### 5.3 麦克风上行 24 → 16 kHz

`Settings.voice_live_input_sampling_rate`（默认 16000）声明为会话顶层 `input_audio_sampling_rate`，
前端 `MIC_SAMPLE_RATE` 同步。为防漂移，后端把生效速率放进 `proxy.connected`（从已构建的 session 读回），
前端比对不一致就报错 —— 只改一边会让 Azure 按错速率解码，转写全废且没有任何报错。
详细原理见 `docs/voice-live-control-notes.md` §4。

### 5.4 实测验证

| 验证项 | 方式 | 结果 |
|---|---|---|
| 纯音频降级机制（真 Azure） | `frontend/e2e/avatar-audio-only-live.spec.ts` | **通过**：视频字节 17874 → 0，音频持续增长（66 → 1212），冷却后画面恢复 |
| **自动降级触发（真 Azure + sudo 限速）** | `frontend/e2e/avatar-auto-downgrade-live.spec.ts`，`SPEC=avatar-auto-downgrade-live … weaknet-phase2.sh` | **通过**（详见 5.4.1） |
| 判决逻辑 | `avatarHealth.test.ts` 17 例 | 通过 |
| 媒体层契约 | `useAvatarStream.test.ts` 13 例（含 offer 方向为 inactive、自愈预算不被切换消耗、偏好钉死） | 通过 |
| 首读门 | `useInterviewVoice.test.tsx` 新增纯音频一例 | 通过 |
| 16 kHz 转写 A/B（真 Azure） | `frontend/e2e/scripts/mic-rate-ab.sh` | **通过**：16 kHz 与 24 kHz 的词错误率**都是 0.0%**，整句逐字正确 |

**假麦克风素材的正确做法（对所有 `FAKE_AUDIO` live spec 都适用，两个坑都实测踩过）**

| 症状 | 原因 | 做法 |
|---|---|---|
| 一条转写都没有（`micFrames=14293, speechStarted=1, speechStopped=0`） | 循环播放的 WAV 没有静音间隔，Azure 的 VAD 永远到不了 end-of-utterance，于是从不产出最终转写 | 句子后面必须跟**静音** |
| 只转写到句子尾巴（实测只得到 "Specify these first, with thorough research."） | 假麦克风从页面加载就开始播，而 Voice Live 会话要 5 秒后才建好，单次播放的前半句喂给了一个没人在录的麦克风 | 必须**重复播放**，不要用 `%noloop` |

仓库里既有的另一种解法同样有效、且更早就存在：`bank-linear-restart-live.spec.ts` 用
`wav%noloop` 配**前置 45 秒静音** —— 前置静音等会话建好，`%noloop` 后的静音让 VAD 收尾。
两条路解决的是同一对约束，按素材方便选。本 A/B 用的是**「句子 + 3 秒静音」并循环**：每一遍结尾的静音让 VAD 收尾，重复则保证至少有一遍完整落在
会话建好之后。判分时只取与参考文本最匹配的那个窗口，重复不会抬高错误率。
文件本身的采样率与被测的 `input_audio_sampling_rate` 无关（前者只喂假设备，浏览器会重采样），
48 kHz 单声道 16-bit 即可。另外：spec 里包装 `window.WebSocket` 时必须把 `OPEN` 等静态常量一起复制，
否则应用的 `readyState === WebSocket.OPEN` 判断恒假，**连麦克风帧都发不出去**（第一次失败就是这个）。
`mic-rate-transcript-ab.spec.ts` 的失败信息会直接把这三个计数报出来并指明是哪一种。

**A/B 结果（2026-09-30，真 Azure，同一段合成语音）**

| 采集采样率 | 词错误率 | 转写（截取完整的那一遍） |
|---|---|---|
| **16000 Hz**（我们采用） | **0.0%** | "She sells sixth-floor thermostats, and the finance staff should specify these first, with thorough research." |
| 24000 Hz（Voice Live 继承的默认） | 0.0% | 同上，逐字一致 |

参考句刻意堆满 s / sh / f / th 这些摩擦音与齿音，正是 16 kHz 丢掉的 8–12 kHz 频段最可能影响的地方；
两者逐字一致，说明降采样在这条级联链路上**不付出识别代价**，与 §4.3 的推理吻合。

#### 5.4.1 自动降级真机验证结果（office-bad 档，2026-09-30）

不碰任何界面，41 秒内自动完成降级：

```
video painted before the downgrade: false
audio bytes after the switch: 2899 → 4581 over 8s
[avatar-stream] media health poor (conceal=35.0% decoding=false rtt=933ms) → dropping the picture to save the voice
[avatar-stream] media mode → audio-only (health-downgrade); rebuilding the Voice Live session
[voice] rebuilding the session for media mode audio-only
1 passed (41.2s)
```

三点值得记下来：

1. **两个触发条件同时成立** —— `decoding=false`（免阈值的主触发）与 `conceal=35.0%`（超过
   `CONCEAL_BAD` 0.15）。也就是说在真实劣化链路上，不依赖阈值的那条判据独立就足够，阈值那条只是加固。
2. **35% 的音频补偿率与 3.8 节探针实测的 31% 几乎吻合** —— 两次独立测量、不同代码路径，互为印证。
   RTT 933 ms 同样贴近当时的 876 ms。
3. **`video painted before the downgrade: false`** —— 1080p 数字人在这条链路上**一帧都没画出来**就被
   放弃了，正是 3.8 节结论二的形态第三次复现。换句话说这条链路上的画面从头到尾只是在吃带宽。

阈值由此得到一次实测标定：健康档（基线、office-ok）从未误触发，劣化档 35% 远超 0.15 即刻触发。
`CONCEAL_GOOD`（恢复门槛 0.03）仍未被真机检验过，因为本轮没有让链路恢复；它只影响"多快把画面拿回来"，
不影响保住声音。

**仍未真机检验的一项**：`CONCEAL_GOOD`（0.03，恢复门槛）—— 本轮没有让链路从劣化恢复，所以只验证了
"何时放弃画面"，没验证"何时拿回画面"。它不影响保住声音这个目标；要验证就在 spec 运行中途
`sudo frontend/e2e/scripts/netshape.sh off`，然后等 60 秒冷却加 45 秒健康窗。

### 5.5 明确不做的

- 不给用户"网络档位"选择（负责人 2026-09-30 已否）。上面全是自动的，外加一个手动开关。
- 不自己实现码率自适应 —— Azure 已经在做，重复实现只会互相打架。
- 不用 SDP `b=AS` 压码率 —— Azure 忽略（第 3 节实测）。
- 不用 `freezeCount` 当健康指标 —— 1080p 上完全失效。
- 上行不改 WebRTC —— 官方 WebRTC 模式明确不支持 avatar。
- `VOICE_LIVE_AVATAR_VIDEO_BITRATE` **保留但默认不设**：它是唯一被 Azure 尊重的服务端码率杠杆，
  留作逃生阀，不是主机制。

### 5.6 仍未解决

UDP 被完全封锁时画面和声音全无（Azure 只下发 UDP TURN 候选）。兜底是重建一个不带 `avatar` 的会话、
让音频以 PCM 走 WebSocket（前端已有该播放路径，无 character 的 persona 即此模式）。本次未做。

## 6. 相关代码位置

**实现**
- 健康度判决（纯函数，全部策略）：`frontend/src/hooks/avatarHealth.ts` + `avatarHealth.test.ts`
- 媒体层采样、画面开关、ICE 自愈：`frontend/src/hooks/useAvatarStream.ts` + `useAvatarStream.test.tsx`
- 会话重建与首读门：`frontend/src/hooks/useInterviewVoice.ts`（`restartForMediaMode`、`avatarReadyRef`）
- 界面三态与手动开关：`frontend/src/components/AvatarView.tsx`、`frontend/src/pages/InterviewPage.tsx`
- 麦克风采样率：`frontend/src/hooks/useVoiceAudio.ts` 的 `MIC_SAMPLE_RATE`
- 会话字段与防漂移回显：`backend/app/services/voice_live_proxy.py` 的 `build_avatar_session` 与
  `proxy.connected`；设置在 `backend/app/config.py`（`voice_live_input_sampling_rate`、
  `voice_live_avatar_video_bitrate`）

**测量与验证工具**
- 弱网探针：`frontend/e2e/avatar-weaknet-probe.spec.ts`
- OS 级限速：`frontend/e2e/scripts/netshape.sh`；总控：`frontend/e2e/scripts/weaknet-phase2.sh`
- 纯音频降级真机验证：`frontend/e2e/avatar-audio-only-live.spec.ts`
- 采样率转写 A/B：`frontend/e2e/mic-rate-transcript-ab.spec.ts` + `frontend/e2e/scripts/mic-rate-ab.sh`
