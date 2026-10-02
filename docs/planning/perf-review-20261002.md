# 性能与架构 review：让候选人体感更丝滑（2026-10-02）

> **状态：草稿，尚未实测。** 这份文档的结论来自**代码阅读 + 算术推导**，锚点是项目自己已经测过的数字
> （`docs/avatar-latency-ice-gathering.md`、`docs/avatar-weaknet-probe.md`、obsidian 的 Voice Live
> 系列 00–12）。**本轮没有跑任何新的测量**，所以每一条都写了"怎么验证"。先评审方向，再按顺序动手，
> 每条上线前后各测一次。

## 0. 这份文档是什么 / 不是什么

**是**：对现有实现的一次性能审查，覆盖网络、声音、视频、文字与流式呈现五个面，按
（影响 × 置信度）÷ 成本 排序。

**不是**：对 Azure 侧旋钮的重新探索。Voice Live 系列 00 §四「已定决策与不做项速查」里的每一条都成立，
本文一条都不翻（清单见 §9）。本文的核心判断是：

> **Azure 侧的杠杆已经摸干净了；剩下的性能问题几乎全在"我们自己这一跳"。**
> 浏览器 ↔ 后端这一段协议是我们自己定的，而它目前仍是整条链路上最浪费的一段。

## 1. 结论先行

| # | 条目 | 面 | 预期收益 | 成本 | 风险 |
|---|---|---|---|---|---|
| P0-1 | 上行分帧：8 ms×125 → 40 ms×25，并在我们这跳改二进制 | 网络 | 上行 **397 → 258 kbps（−35%）**；帧数 **−80%** | 中 | 低 |
| P0-2 | 播放端加抖动缓冲（纯音频 / 无形象路径） | 声音 | 消除弱网爆音与截词 | 小 | 低 |
| P1-1 | 音频编解码移出主线程（worklet + transferable） | 声音/视频 | 释放主线程，画面不再一卡一卡 | 小 | 低 |
| P1-2 | 转写 delta 不再触发全页重渲染 | 文字 | 说话期间重渲染 10–20 次/秒 → 近 0 | 小 | 低 |
| P1-3 | 评分并行化 | 流式 | 结尾 **30–50 s → 10–15 s** | 中 | 低 |
| P1-4 | 默认形象改照片数字人 | 视频/网络 | 每轮快 **180 ms**，带宽 **4–5 倍** | **零代码** | 无 |
| **P1-5** | **开启 gzip（已实测确认线上未压缩，本轮已改）** | 网络 | 首屏 **975 → 279 KB** | **三行配置** | 无 |
| P2-1 | 语音 WS 绕过 nginx 直连后端 | 网络 | 少一次 TLS + 一次 ingress + 0.5 vCPU 中转 | 小 | 低 |
| P2-2 | 关掉 permessage-deflate | 网络 | 每秒 125 次无效压缩的 CPU | **一行** | 无 |
| P2-3 | 后端中继去掉双重序列化 | 网络 | 降级模式下的热路径 CPU | 小 | 低 |
| P2-4 | 下一题预取 / 乐观朗读 | 网络 | 每轮省一次生产 RTT | 中 | **中，有条件** |
| P3-1 | 代码分割（admin 路由 `React.lazy`） | 网络 | 首屏更早 → 预热更早 → 冷启动更短 | 小 | 低 |
| P3-2 | `gop_size` 实验 | 视频 | 首帧更快 / 丢包恢复更快（待验） | 小 | 需限速实测 |
| P3-3 | 上行背压（`bufferedAmount`） | 网络 | 窄上行下声音不再越来越晚 | 小 | 低 |

## 2. 名词先对齐：这里有三个不同的"帧"

今天这三者被 1:1:1 绑死，所以"125"这个数字同时出现在三处：

| | 今天 | 谁规定的 |
|---|---|---|
| 音频帧（render quantum） | 128 样本 = 8 ms @16 kHz | Web Audio 规范，固定，改不了 |
| WebSocket 消息 | 125 个 / 秒 | **我们的代码**，可改 |
| Azure `input_audio_buffer.append` 事件 | 125 个 / 秒 | **我们的代码**，可改 |

P0-1 就是把后两个从第一个上解绑。

### 2.1 上行是流式的，而且必须是 —— P0-1 改的是颗粒度，不是模型

这一节是 review 过程中发现文档缺的一块：原文假定读者知道上行是持续流式的。先对齐，否则 P0-1 很容易被
误读成"攒到候选人说完再一起发"。

`useInterviewVoice.ts:624` 的 `audio.startRecording(...)` 在 **`session.updated` 事件里**调用 ——
会话一建立就持续上行，与候选人是否说话、是否点按钮**无关**（只有静音会在发送侧跳过，`:625`）。

容易被当成一件事的，其实是三条通道、三个时机：

| 东西 | 通道 | 时机 |
|---|---|---|
| **音频字节** | WS `input_audio_buffer.append` | **会话建立起一直在发**，每 8 ms 一包 |
| **边听边出的转写** | WS `...transcription.delta` / `.completed` | Azure 边收边回，气泡逐字长出 |
| **"这一轮说完了"** | **我们不发 commit**；Azure 服务端 VAD 自行判定 `speech_stopped` | 停嘴 800 ms 后 |
| **"把答案交给后端评分"** | HTTP `POST /interview/{id}/answer` | **等点击"我答完了"** |

**等"说完"的只有最后一行，而且它送的是转写文本，不是音频。** 音频早就到齐了。

音频必须流式的三条硬理由：

1. **VAD 在 Azure 服务端。** `turn_detection`（`azure_semantic_vad_multilingual`，800 ms 静音窗 + EOU）
   是 Azure 在跑。攒到点击才发，Azure 永远不会发出 `speech_started` / `speech_stopped` —— 于是**静音自动
   提交、judged 模式的 judge 窗口、打断数字人（barge-in）三个功能同时消失**，它们都建立在服务端实时判停上。
2. **转写是流式的。** `useInterviewVoice.ts:651` 靠 `transcription.delta` 让候选人气泡边说边长。
3. **延迟会灾难性反转。** 30 秒回答 = 30 × 32 kB = **960 kB**；在 500 kbps 窄上行上约 **15 秒**，而且
   **全部落在点击之后**，是纯关键路径。今天这段是 0，因为字节早已送完。

所以把它看成一个旋钮而不是开关：

```
8 ms/包（今天）  ──→  40 ms/包（P0-1 建议）  ──────────→  等说完一次发（灾难）
125 包/秒              25 包/秒                           1 包/轮
397 kbps               258 kbps                           峰值 15 秒阻塞
```

P0-1 **仍然是流式**，只是"攒 5 个 render quantum 再发一次"。延迟代价 ≤ 32 ms，而 Azure 判停窗口是
800 ms —— 差两个数量级，VAD 感知不到。**往旋钮方向走一格，不走到底；走到底正是上面那个灾难形态。**

## 3. P0-1 上行分帧：当前最大的一块浪费

### 3.1 代码事实

- `frontend/public/audio-processor.js:24` — 每个 render quantum（恒定 128 样本）就 `postMessage`
  一次，且 **没有 transfer list**，所以每帧结构化克隆复制一次 Float32Array。
- `frontend/src/hooks/useVoiceAudio.ts:103` — 每帧立刻 base64。
- `frontend/src/hooks/useInterviewVoice.ts:395` — 每帧一次 `ws.send(JSON.stringify(...))`。

中间**没有任何聚合**。

### 3.2 算术（16 kHz PCM16 单声道，payload + WS 帧头，不含 TLS）

| 组成 | 今天 8 ms×125 | 40 ms×25，仍 base64+JSON | 40 ms×25 + 二进制 |
|---|---:|---:|---:|
| 音频本身 | 256 kbps | 256 kbps | 256 kbps |
| base64 膨胀（+1/3） | 88 | 86 | **0** |
| JSON 信封（45 B/消息） | 45 | 9 | **0** |
| WS 帧头（8 B/消息） | 8 | 1.6 | 1.6 |
| **合计** | **397 kbps** | **352 kbps** | **258 kbps** |

PCM16@16k 的理论地板是 256 kbps。397 落在项目实测的 360–450 kbps 区间内，算术自洽。

**结论：16 kHz 之后，上行仍有 35% 是纯协议开销。** 而系列 12「结论五：麦克风上行会把自己挤死」里
uplink-starved 档两轮**均失败**，省下的这 139 kbps 正是决定 `session.avatar.connect` 能否挤出去的量级。

### 3.3 改法（三步，可独立上线）

1. **worklet 内聚合**到 320 / 640 样本（20 / 40 ms）再 post。纯前端，不动任何协议，先吃掉帧数 5 倍。
2. **worklet 内做 Float32 → Int16**，`postMessage(buf, [buf])` 转移所有权，去掉每帧一次的克隆复制。
3. **浏览器 → 后端改发 binary frame（裸 PCM）**；`voice_live_proxy._forward_client_to_azure` 收到
   bytes 时自己 base64 + 封 `input_audio_buffer.append` 再给 Azure。**Azure 那一跳格式一字不改**
   （系列 01 §4.5.1 的"只收 base64、不能发二进制"约束针对的是 Azure 那一跳，不是我们这一跳）。

### 3.4 代价与验证

- **延迟代价**：最多 +32 ms 上行缓冲。相对 800 ms 的 VAD 静音窗与 1069 ms 的轮次延迟可忽略。
- **质量代价**：预期为零。`input_audio_buffer.append` 是往缓冲区追加，粒度 40 ms 远小于 800 ms 静音窗，
  不影响 VAD / EOU 判停。
- **验证**：复用 24→16 kHz 那套 WAV 假麦克风 A/B，同一段录音两档各跑一遍 diff 转写文本（要求词错误率
  仍为 0.0%）；同时抓 devtools 的 WS 字节速率确认 397 → 258。

## 4. P0-2 播放端没有抖动缓冲 —— 而它正是弱网兜底的那条路

### 4.1 代码事实

`frontend/src/hooks/useVoiceAudio.ts:159-162`：

```js
nextPlayTimeRef.current = Math.max(nextPlayTimeRef.current, ctx.currentTime);
src.start(nextPlayTimeRef.current);
nextPlayTimeRef.current += buffer.duration;
```

**提前量是 0。** 第一块排在 `ctx.currentTime`（必然已迟到一个量子）；之后任何一次抖动让
`nextPlayTime` 落到 `currentTime` 之前，就被硬拉回当前时刻 —— 结果是**切掉一段 + 一次爆音**，
而且提前量再也拿不回来。

### 4.2 为什么平时看不见，但必须修

avatar 模式下回复音频走 WebRTC 音轨（系列 12 §四），这条路不走。它只在：

1. **通路 B**：persona 无形象 → 音频以 PCM 走 WS；
2. **`docs/avatar-weaknet-probe.md` §5.6 仍未解决**的兜底：UDP 全封 → 重建不带 `avatar` 的会话、
   音频改走 WS PCM。

也就是说：**这是我们准备用来兜最坏网络的那条路，而它目前没有任何抗抖动能力。** 修它同时是把 §5.6
那条兜底变成"真的可用"的前提。

### 4.3 改法

- 目标提前量 100–150 ms；underrun 时按提前量**重新续排**而不是对齐 `currentTime`；
- 接缝处 2–3 ms 淡入淡出替代硬切；
- 想一次做干净：播放改 **AudioWorklet 环形缓冲**（顺带完成 P1-1 的一半）。
- 另：`stopAudio()` 直接 `close()` 整个 AudioContext，重建要重新过自动播放策略。改成保留 context、
  记录已排期的 source 并 `.stop()` 它们。

**验证**：现有 `avatar-audio-only-live.spec.ts` 加 OS 限速，统计 underrun 次数 + 录音做听感对照。

## 5. P1 组

### 5.1 P1-1 主线程：每秒 3.2 万次字符串追加，压在画视频的那条线程上

`useVoiceAudio.ts:50` 的 `encodePcmToBase64` 用 `binary += String.fromCharCode(bytes[i])` 逐字节拼 ——
每帧 256 次，**每秒 3.2 万次字符串追加**。`playAudio` 同样在主线程 `atob` + 两个循环 + 每个 delta
新建 AudioBuffer / BufferSource。

这条线程同时在：解码并绘制 avatar `<video>`、跑 React 渲染。候选人机器一弱，表现就是**画面一卡一卡** ——
而我们会去查 WebRTC 统计，那里是干净的。**这是一类会把人引向错误方向的症状。**

**改法**：编码进 worklet（配合 P0-1 顺手完成）；播放改 worklet 环形缓冲（配合 P0-2）。

### 5.2 P1-2 每个转写 delta 触发一次全页重渲染

- `frontend/src/pages/InterviewPage.tsx:402` — 每个 delta `setSegments` 生成**新数组**。
- 全仓 **零个 `React.memo`**（已 grep 确认）。

于是 `AvatarView`、`QuestionProgress`、整棵 Fluent 树在每个 delta 重渲染一次，说话期间约 10–20 次/秒。

更尖的一处：`frontend/src/components/Transcript.tsx:65` 的 effect 依赖 `[segments]`，每个 delta 调一次
`scrollIntoView` —— 每次一次强制 layout；而且它滚的是**最近的可滚动祖先**，在 v0.40.9.0 刚修好的窄屏
堆叠布局里很可能是整页，会跟候选人自己的滚动打架。

**改法**

1. `memo` 住 `Transcript` / `AvatarView` / `QuestionProgress`；
2. **把未 final 的 partial 段从顶层 state 里拿出来**（单独 state，或 ref + rAF 合并刷新），只有 final
   段进 `segments` —— 舞台就不会跟着一个字一个字重渲染；
3. 滚动改 `el.scrollTop = el.scrollHeight`，放进 rAF，且只在用户本来就贴底时滚。

**可选（产品取舍，待定）**：mouth 模式下读的文本**是我们自己发出去的**，不必靠 Azure 的
`response.audio_transcript.delta` 一个字一个字长出来 —— 可以在 `response.created` 时一次性落定气泡，
省掉几十次重渲染。代价是失去"卡拉OK"式跟读感。**此条需 owner 决定，不默认执行。**

### 5.3 P1-3 评分是串行的 —— 结尾那 30–50 秒

`backend/app/interview/state_machine.py:434` 的 `for done, (question_id, answer_text) in enumerate(answers)`
里逐题 `await` LLM。10 题 × 3–5 s = **30–50 秒**，而且落在候选人情绪上的收尾时刻。

NDJSON 进度流（`interview.py:764` `report_stream`）已经做了，很好 —— 但它把等待**说清楚**了，没有把它
**变短**。

**改法**：`asyncio.Semaphore(4)` 并发评分；结果按题序存进定长 list（聚合必须保持题序确定性，不能用
append 顺序）；进度语义从「开始第 i 题」改成「已完成 i/n」—— 更诚实也更简单。预期 **30–50 s → 10–15 s**。

**注意**：judge 模型的并发 / 限流要先确认；单题失败需能降级到长度 stub（这条兜底现在就有）。

### 5.4 P1-4 默认形象改照片数字人 —— 零代码，项目自己的数据已经证明

系列 12 §3.6 + 系列 03 §6.1 的实测，三项全胜：

| | lisa（1080p video avatar） | amira（512² photo avatar） |
|---|---|---|
| 读题期码率 | 1.1–1.4 Mbps | 约 650 kbps（全程） |
| **静音期码率** | **2.5–3.5 Mbps** | 约 650 kbps |
| 确认读题 → 真正可听 | 988 ms | **806 ms** |

面试绝大部分时间处于静音期，而 1080p 在静音期**最贵**（码率倒挂，系列 12 §3.6）。照片数字人：
**每轮快 180 ms、带宽少 4–5 倍、没有倒挂。**

这是部署建议，不改代码。唯一需要权衡的是 §5.4.6 记过的"照片数字人基线补偿率 8–19.3% 高于 1080p 的
0.3–0.5%" —— 但那条正是"不按形象配阈值表"决策的来源，不影响形象选择本身。

### 5.5 P1-5 线上 JS 完全没有压缩 —— 已实测确认，本轮已修

**这一条从"值得验一下"变成"已实测确认"**，而且比原估计糟。对线上 public 部署实测（2026-10-02）：

```
GET /assets/index-CbbXnBcD.js
无 Accept-Encoding : 974978 字节
带 Accept-Encoding: gzip : content-length 974978，响应里没有 content-encoding 头
带 Accept-Encoding: br   : content-length 974978
```

两个请求字节数**一字不差**，响应里**根本没有 `content-encoding`**。所以不是"可能没开"，是确认没开。

**根因**：`frontend/nginx.conf` 原本没有任何 `gzip` 指令，而 nginx 自己的默认 `gzip_types` 只有
`text/html` —— 唯一真正要紧的那个约 950 KB 的 bundle 恰好不在里面，被原样发出。

**代价**：每个首次访问白下载 **697 KB**。这个数字不是估的 —— Vite 自己在构建输出里就印了两边：
`dist/assets/index-*.js  975.24 kB │ gzip: 278.51 kB`。也就是说打包器一直在告诉我们压缩能省多少，
只是没人把它和"nginx 到底压没压"这件事对上。而且它落在最糟的位置：语音会话是
**页面加载即预热**的（`docs/avatar-latency-ice-gathering.md` §5.2），bundle 在路上多花的每一秒，就是
WS 握手没开始的一秒、候选人冷启动变长的一秒。

**已改**（本轮）：`frontend/nginx.conf` 的 `server{}` 里加 `gzip on` + 显式 `gzip_types` +
`gzip_vary on`（`/assets/` 带 `immutable` 一年缓存，没有 `Vary` 的话共享缓存可能把 gzip 响应发给不支持
的客户端）+ `gzip_comp_level 5`（资源内容哈希、每个版本只取一次，拿几毫秒 CPU 换明显更小的包是划算的）。

**没有用 `gzip_static`**（构建期预压缩，严格更优）：本机 docker 不可用，无法确认
`ngx_http_gzip_static_module` 是否编进 `nginx:1.27-alpine`，而未知指令会让 nginx **拒绝启动** ——
部署挂掉比实时压缩糟得多。留作后续可验证时的改进项。

**上线后验证**：
```bash
curl -H 'Accept-Encoding: gzip' -D - -o /dev/null https://<frontend>/assets/index-*.js | grep -i content
```
期望看到 `content-encoding: gzip` 且 `content-length` 降到约 279 KB（Vite 构建输出里的 278.51 kB）。

### 5.6 候选人自己的话没有流式显示 —— 已实测定因：Azure 不发 delta（2026-10-02）

**现象**（owner 观察）：候选人说话时页面上没有逐字出现的文字，要说完一整句才一次性蹦出来。

**代码确实实现了它。** `useInterviewVoice.ts:651` 的 `conversation.item.input_audio_transcription.delta`
分支注释写的就是「说了多少就展示多少」：按 `item_id` 累积 partial，以 `isFinal=false` 和稳定的
`user-<itemId>` 发出去，面板原地长大同一个气泡；`.completed` 再用同一个 id 顶掉它。隔离得很干净 ——
partial 只写 `partialsRef`，提交路径只吃 `.completed`，所以**部分结果永远不会进评分**（唯一例外是重连时
`reset({keepDraft:true})` 故意把"`.completed` 再也不会来"的 utterance 从最后 partial 折进去）。

**已实测定因（2026-10-02，真 Azure，一次性探针跑完即删）。** 曾有两个假设：
(a) Azure 不发；(b) Azure 发了而我们自己丢了（`:651` 要求 `item_id` 和 `delta` 同时存在，缺 `item_id`
的帧会被静默丢弃）。抓 `/api/voice-live/ws` 全量帧，结果：

```
input_audio_transcription.delta  frames: 0
input_audio_transcription.*      frames total: 1

{"type":"conversation.item.input_audio_transcription.completed",
 "transcript":"In the medical monitor and assess whether subject safety or data integrity was affected.",
 "language":"en-US"}
```

**(a) 成立，(b) 排除。** 我们这套配置（`input_audio_transcription.model = "azure-speech"`）下 Azure
一帧 delta 都不发，整句一次性到达；handler 没有丢任何东西，因为根本没有帧可丢。前端那条通路是正确的，
只是没有数据喂它。

**同一次探针测出的第二件事（没预料到）**：`response.audio_transcript.delta` 的计数也是 **1**。面试官那
一侧的文字同样一次性到达 —— 因为 mouth 模式用 `pre_generated_assistant_message`（服务端直接 TTS 我们给
的原文，无模型推理），没有东西可以逐字流。**所以现在两边都不是流式的**，而 §5.2 里"mouth 模式可以不靠
Azure 的 transcript delta 一次性落定气泡"那条优化也因此失去意义 —— 它本来就是一次性的。

下面两条是当初让 (a) 可疑的线索，现在只作为记录（**它们当时不是证据**）：

1. `input_audio_transcription.delta` 在**整个仓库里从未被任何 live spec、后端测试或文档断言过** —— 这条
   路径是照协议假设写的，从来没有对真 Azure 验证过。
2. 代码注释自己留了后门：「Items that never streamed a delta (delta events off or absent, **e.g. plain
   azure-speech configs**)」—— 而我们的生产配置恰好是它点名的那种：
   `AudioInputTranscriptionOptions(model="azure-speech", language=...)`。

**文档查证结果（2026-10-02）**

- Voice Live 参考文档（2025-10-01 / 2026-04-10 / 2026-06-01-preview 三个版本）**都定义了**这个事件，
  服务端事件表标注 "Streaming input audio transcription"，说明它"在转写进行中"提供"partial"结果。
  所以协议层面它存在。
- 但微软 Q&A 有一条说 **Azure OpenAI Realtime** 端点上该 delta「not yet supported」、「intentionally
  disabled on Azure's managed infrastructure」。**那是另一个产品面，不是 Voice Live** —— 架构相近所以
  可疑，不能当结论。
- **关键**：Voice Live 的输入转写模型可选，可选集取决于 chat 模型。我们用 `gpt-5-mini`（文本/级联），
  可选 `azure-speech`（现状）或 **`mai-transcribe` / `mai-transcribe-2`**（preview，文档明确说可作为
  `azure-speech` 的替代用于"任何文本类 chat 模型或 agent"）。`gpt-4o-transcribe` 系列要求 chat 模型是
  `gpt-realtime`/`gpt-realtime-mini`，`whisper-1` 本身是批式 —— 两者都不在我们的路上。

**所以换流式转写不一定要动 chat 模型**，但 `mai-transcribe` 会不会发 delta，文档没说。

**还剩一半没测**：`mai-transcribe` 会不会发 delta。它要改后端 `build_avatar_session` 的
`input_audio_transcription.model` 并重启，而这个字段喂的是**打分的输入**，所以顺序必须是：先测 delta
到不到；到了再做一次 WAV A/B 比对词错误率（与 24→16 kHz 那次同一做法）；两关都过才换。`voice-live-azure.spec.ts` 已经在代理帧上做断言，加一个
计数即可。**判据必须是真帧，不是文档** —— 同 §5.3 那个「156 KB 发出去、转写一个字都没有、连错误都没有」
的坑是同一类。

**预期要先校准**：级联 ASR 的 partial 是**短语级且会被改写**的，不是打字机。想要真逐字得走原生音频模型。

**不动 Azure 的半步**（可独立做，零风险）：
- `input_audio_buffer.speech_started` / `speech_stopped` 现在就在收（`:640`/`:648`）—— 可以立刻做
  "正在听…" + 电平动画，解决"不知道有没有被收到"，但不解决"看见自己说的字"。
- `isFinal` 已在 `TranscriptSegment` 类型里，而 `Transcript.tsx` **完全没用它** —— 补一个"这段还在改"的
  淡化/游标样式是几行的事，并且是 delta 真的到来之后它才有意义的前置条件。

## 6. P2 组

### 6.1 P2-1 语音 WS 绕过 nginx

今天的路径：

```
浏览器 → 前端 CAE ingress → nginx（0.5 vCPU）→ 后端 CAE ingress → 后端 → Azure
```

而后端 ingress 本来就是 `external: true`（`infra/azure/modules/container-apps.bicep:144`），
前端容器只有 **0.5 vCPU**（`:332`）。125 帧/秒经过一个 0.5 vCPU 容器中转，多一次 TLS、多一次 ingress。

WS 不吃 CORS，token 本来就在 query param 里（`useInterviewVoice.ts:245`），所以把 WS 指向后端 FQDN 即可。
需要给前端注入后端 origin（`VITE_BACKEND_WS_ORIGIN`，或运行时 `/config.json`）。

注意：后端 ingress 已有 `stickySessions: sticky`（`:150`），这正是直连需要的那个属性。

### 6.2 P2-2 关掉 permessage-deflate（一行）

uvicorn 0.30.6 的 `ws_per_message_deflate` **默认 True**（已验签名）。而系列 01 §4.5.1 自己写了
「permessage-deflate 对音频几乎无效」。所以它现在是**纯 CPU 消耗**，每秒 125 次往返。

`backend/entrypoint.sh:62` 加 `--no-ws-per-message-deflate`（上线前确认该版本 CLI 旗标拼写）。
改成二进制后更没有理由留着。

### 6.3 P2-3 后端中继的双重序列化

- 上行：`voice_live_proxy.py` 的 `_forward_client_to_azure` 做 `json.loads`，然后 `conn.send(parsed)`
  由 SDK 再 `json.dumps` 一遍。**上行帧我们根本不需要看内容**，确认 SDK 有无 raw send 通道；没有就自己
  拼字节。
- 下行：`_forward_azure_to_client` 逐事件 `event.as_dict()` + `json.dumps` 重建。avatar 模式下量很小，
  但在**音频走 WS 的降级模式**下这就是热路径。

### 6.4 已否：外部 brain 投机执行（owner，2026-10-02）

曾考虑在 EOU（而不是等"我答完了"）就用当前草稿投机发起外部网关那一轮，以藏掉系列 03 §六 第 4 条实测的
**中位 3.90 s**（占外部模式每轮 70%）。技术上我们这侧是安全的：`external_runner.py:373` 的
`_run_turn_with_retry` 入参是 `(conversation_id, session_state_json, user_input)`，是纯函数 —— 这正是
bounded retry 被判定为安全的同一个理由。

**owner 决定：不在考虑范围内，放弃。** 不再评估，也不要在后续 review 里重新提出。

外部网关那一段的治本路线保持系列 03 §六 第 4 条已定的方向：客户最终把网关与服务器放进同一私网，预期压到
约 1 秒。过渡语同样不做（系列 00 §四）。

### 6.5 P2-4 下一题预取 / 乐观朗读（有条件推荐）

`InterviewPage.tsx:744-750`：`await commitAnswer()` → `await submitAnswer()` → `setInterview` → effect
→ `speakQuestion`。POST **串在关键路径上**，还多一个 React tick。

项目实测的 1069 ms 里这一段约 8 ms —— 因为那是**本机后端**。生产上这是一次真实 RTT（还要走 nginx 那一跳）。

自 v0.39.3.0 judge 改成 nudge-only、不写 interviewer turn、header 不动之后，**bank 模式下一题是完全确定
的**，而 `GET /interview/questions` 已能一次拿到有序题库。所以可以：提交瞬间就朗读 N+1，POST 并行飞，
不一致才 `response.cancel`。

**但本文把它放在 P2 并附条件**：这个仓库的 bug 史（读两遍 / 读三遍 / 读错题）**全部长在朗读路径上**。所以

1. **先量生产 RTT**。低于约 80 ms 不值得动；高于 200 ms 再做。
2. 必须挂在现有 `useQuestionReadWatch` 的确认机制上，不另起一套。
3. 最后一题（应完成而非朗读）、409 CAS 冲突 两条分支必须单独测。

## 7. P3 组

- **P3-1 代码分割**：`frontend/dist/assets/index-*.js` 是 **975 KB 单 chunk**（Vite 构建时就会就此告警，
  建议 `dynamic import()` 或 `manualChunks`），无代码分割 —— 候选人要
  下载整个 AdminPage + AgentEditorPage。`React.lazy` 拆掉 admin 路由。预热是**页面加载即开始**的
  （系列 03 §5.2），JS 到得早 = WS 开得早 = 冷启动短。压缩那一半已经单独成节并修掉了，见 §5.5；
  这里剩下的是"候选人根本不需要 admin 代码"这件事，和压缩是两个独立的乘数。
- **P3-2 `gop_size`**：默认 10、范围 1–2000，而 `build_avatar_session` 现在根本没传
  （`video_params` 只有 codec / bitrate / background）。系列 12 §6.1 已把它列为**待验**，并指出它和
  bitrate 是服务端**唯二**能改变"丢包后能不能活"的旋钮。改小 → 关键帧更密 → 首帧更快、丢包恢复更快，
  代价码率涨。**建议与"压到 500 kbps"那个假设一起在限速下测，不要单独上线。**
- **P3-3 上行背压**：全仓 **0 处** `bufferedAmount` 检查（已 grep）。窄上行下 125 帧/秒会在浏览器发送
  缓冲里堆积，表现是候选人的声音**越来越晚**到 Azure（队头阻塞），而不是丢掉旧音频。配合 P0-1 做：
  `bufferedAmount` 超阈值时丢弃最旧的帧并打日志 —— 语音场景里新鲜度比完整性重要。

## 8. 架构上限：一条必须说出来的话

`minReplicas: 1 / maxReplicas: 1`（前后端都是，`container-apps.bicep:286`、`:338`），后端单 uvicorn
进程、无 `--workers`（`entrypoint.sh:62`）。

中继是**纯 Python 的逐帧工作**。在 GIL 下，每会话 125 上行 + N 下行帧/秒 就是并发天花板。而扩不出去的
真正原因不是配置，是**临时 SQLite**（每副本自己的 DB + 每副本自己的 boot seed）—— 这是当初有意的取舍，
但它的后果是：

> **每一点逐帧 CPU 的节省，同时就是容量的节省。**

P0-1 把帧数降 5 倍，等于并发上限提约 5 倍 —— 这是它除带宽之外的第二份收益。真要上并发，才需要谈把会话
状态挪出 SQLite，那是另一个量级的决定，不在本文范围。

## 9. 不翻的已定决策（继承系列 00 §四）

不做过渡语；不自建码率自适应；不用 SDP `b=AS`；不用 `freezeCount` 当健康指标；不给用户网络档位；
上行不改 WebRTC（avatar 不支持，且系列 §5.3 实测是**静默失败**）；不换 H.264；读题用 `pre_generated`；
自建 TURN 仅限三种情况。

**一处需要区分而非推翻**：系列 01 §4.5.1「`input_audio_buffer.append` 只收 base64，不能发二进制帧」
—— 这是**Azure 那一跳**的约束，成立。**浏览器 → 我们后端这一跳不受它约束**，而这一跳目前也在付 base64
的 33%。这是 P0-1 第 3 步的全部依据。

## 10. 建议落地顺序

0. ~~**P1-5 开 gzip**~~ —— **本轮已做**（三行配置，见 §5.5）。线上实测确认未压缩，不是推测。
1. **P0-1 第 1、2 步**（worklet 聚合 + transferable）—— 纯前端、不动协议、风险最低，立刻拿到帧数 5 倍
   和主线程。
2. **P1-3 评分并行** —— 独立、体感最大、完全不碰语音链路。
3. **P0-1 第 3 步 + P2-2 deflate** —— 一起上；二进制一到，deflate 就彻底没理由留着。
4. **P0-2 抖动缓冲 + P1-1 播放 worklet** —— 一次做完，顺带把 §5.6 那条兜底变成真的可用。
5. **P1-2 渲染**。
6. **P1-4 形象默认**（随时，零代码）。
7. **P2-1 WS 直连**、**P2-3 去双重序列化**。
8. **P2-4 乐观朗读** —— 先量生产 RTT 再决定。
9. **P3 组**。

## 11. 待验清单（本文产生的新待验项）

1. 40 ms 聚合后转写词错误率是否仍为 0.0%（WAV 假麦克风 A/B）。
2. 二进制上行后实测字节速率是否落到约 258 kbps。
3. uplink-starved 档（系列 12 §3.8 那两轮均失败的档）在省出 139 kbps 后能否建连成功 —— **这是 P0-1
   最有价值的一次验证**。
4. 生产环境 `POST /answer` 的真实 RTT 中位数（决定 P2-5 做不做）。
5. 评分并行后端到端耗时，以及 judge 模型在并发 4 下是否触发限流。
6. ~~SPA 资源是否真的被 gzip/brotli 压缩。~~ **已验（2026-10-02）：确认完全未压缩**，根因是
   nginx 默认 `gzip_types` 只含 `text/html`；本轮已改，见 §5.5。上线后按该节的 curl 复验。
7. `gop_size` 调小后的首帧延迟与丢包恢复（与"压到 500 kbps"合并测）。
8. ~~**`input_audio_transcription.delta` 在真 Azure 上到底来不来**~~ —— **`azure-speech` 已测：0 帧**
   （见 §5.6）。剩下 `mai-transcribe` 一半未测，且换它必须附带一次词错误率 A/B，因为转写是打分的输入。
9. `scene` 参数族（photo 头像专有：`zoom`/`position`/`rotation`/**`amplitude`**）—— Azure 暴露了、
   `build_avatar_config` 一个都没传、从未测过。`amplitude` 是动作幅度，是目前唯一可能的"表现力"旋钮。
   与 `gop_size` 同类：先测再说。

## 12. 相关文档

- `docs/avatar-latency-ice-gathering.md` —— 出场延迟八段分解、逐轮延迟实测。
- `docs/avatar-weaknet-probe.md` —— 弱网实测、已实现方案、§5.5 明确不做的、§5.6 仍未解决。
- `docs/voice-live-control-notes.md` —— 读题机制、三条音频通路、输入采样率。
- obsidian `Azure/VoiceLive/` 系列 00–12 —— 系列 00 是主题地图与已定决策速查，先读它。
