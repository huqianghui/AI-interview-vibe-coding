# 弱网下保住面试：数字人媒体层自适应 + 麦克风上行降采样

> **状态：已批准并实现（v0.40.0.0）。** 这份是实现前的计划原件（plan mode 产出），保留作为决策轨迹。
> 实现期间又撞到两条计划里没有的 Azure 硬约束 —— avatar 每会话只能协商一次、avatar 创建有速率限制 ——
> 它们把"切画面"从"活会话内重协商"改成了"重建整条会话 + 不对称冷却"。
> **最终实现与实测结果见 [`../avatar-weaknet-probe.md`](../avatar-weaknet-probe.md) §5**，
> 采样率原理见 [`../voice-live-control-notes.md`](../voice-live-control-notes.md) §4。

## Context

2026-09-30 的弱网实测（`docs/avatar-weaknet-probe.md`、`docs/voice-live-control-notes.md` §4）把"网络差时数字人卡"定位成三件具体的事：

1. **Azure 已经在自适应码率**（lisa 2382 → 718 kbps，贴着接收端带宽估计走），不需要也不应该再实现一遍。
2. **真正的失效不是画质，是声音。** 画面和声音共用一条 RTP 传输；3% 丢包下 1080p 一帧都解不出来（`framesPerSecond` 变 null、`framesDecoded` 停增）却仍吃约 1 Mbps，把同一条连接上的音频挤到 **31% 靠丢包隐藏算法合成**。候选人听不清题目，面试作废。
3. **关画面留声音在同一条连接内就能做到**（offer 保留 `m=video` 但标 `a=inactive`；删掉 m-line 会被 Azure 拒绝）。实测音频补偿 31% → **2.5%**、音频丢包 505 → 66、RTT 876 → 534 ms（视频流自伤 340 ms 排队延迟）。对照组复现两次。

另外麦克风上行实测 540–680 kbps，窄上行办公网下会把 `session.avatar.connect` 的 SDP 挤在几百个音频帧后面发不出去（自伤型故障）；而我们走级联模型（`gpt-5-mini` = 音频先过 Azure 语音转文字，识别器本身是 16 kHz 管线），24 kHz 多传的频段 Azure 自己丢掉。

**目标**：网络变差自动牺牲画面保住声音、恢复后自动切回（带防抖）、给候选人手动开关；同时砍掉三分之一上行。

**实测否决、明确不做**：不给用户"网络档位"；不自己实现码率自适应；不用 SDP `b=AS`（Azure 忽略）；不用 `freezeCount` 当健康指标（1080p 解不出帧时它反而更"好看"）；上行不改 WebRTC（官方 WebRTC 模式不支持 avatar）。

**范围外**：UDP 被完全封锁时画面和声音全无（Azure 只下发 UDP TURN 候选），留作后续"重建不带 `avatar` 的会话、音频走 WS"的独立改动。

---

## 关键发现：降级不需要改后端

画面开关只取决于**浏览器 offer 里 video transceiver 的 direction**。后端会话照常带 `avatar` 块，Azure 只是因为我们声明 video 为 `inactive` 而不推视频。所以第 1–4 节全在前端，后端唯一改动是第 5 节的采样率。

`useAvatarStream.ts` 已有的自愈机器就是所需的全部机制：`attemptRecovery`（292–351）关旧 PC、用 `iceServersRef`/`sendOfferRef` 存的东西重建、重跑 `runHandshake`，而 `runHandshake` 必然重发 `session.avatar.connect`（280），**不需要新的 `session.updated`**。`wirePc`（155–222）已用 `pc === pcRef.current` 守卫、`genRef` 已处理代际失效。原始参考实现本就有 getStats 遥测，移植时被主动删掉（见 `useAvatarStream.ts:11-13` 注释），这次是按需加回。

---

## 1. 新模块 `frontend/src/hooks/avatarHealth.ts`（纯函数，可脱离浏览器单测）

- `readHealth(prev, report)` → `{ snapshot, health }`：
  - **`concealmentRatio`** = Δ`concealedSamples` / Δ`totalSamplesReceived`（inbound-rtp audio）。用比值而非"每秒补偿数 ÷ 48000"，因为静音期 DTX 下两者同时停增，不会误报。
  - **`videoDecoding`** = Δ`framesDecoded` > 0；**`videoBytesFlowing`** = Δ`bytesReceived`(video) > 下限。
  - `rttMs`（candidate-pair，仅日志）。
- `decideMediaMode(history, mode, state)` → `"downgrade" | "restore" | null`。

**降级触发（两个，第一个免阈值）**
- **纯浪费**：连续 2 窗（2 s/窗，约 4 s）`videoBytesFlowing && !videoDecoding`。实测最干净的信号，不依赖任何标定值，作主触发。
- **音频受损**：连续 2 窗 `concealmentRatio > CONCEAL_BAD`（暂定 0.15，待标定）。

**恢复触发（自动切回，必须防抖）**
- 连续 `healthyHoldMs` 音频健康（`concealmentRatio < CONCEAL_GOOD`，暂定 0.03），且距上次降级 ≥ `MIN_AFTER_DOWNGRADE_MS`（20 s）。
- **递增惩罚**：`healthyHoldMs` 初始 30 s；若一次恢复在 `PROBATION_MS`（60 s）内又被降级则翻倍（30→60→120 s）；累计 `MAX_RESTORE_ATTEMPTS`（2）次失败后本场永久纯音频。最坏情况是两次几秒黑屏，而非反复闪屏。

阈值集中为一个导出常量对象，标定后一处改动。

## 2. `useAvatarStream.ts`：采样器 + 画面开关

- **`runHandshake` 加参数 `wantVideo: boolean`** → 229 行 `wantVideo ? {direction:"recvonly"} : {direction:"inactive"}`。
- **采样器**：PC 到 `connected` 后每 2 s `pc.getStats()` → `readHealth`/`decideMediaMode`。新定时器 ref 必须纳入 `clearTimers`（78–87），并受 `genRef` 守卫。
- **`switchMediaMode(next)`**：走与 `attemptRecovery` 相同的重建路径，但**不消耗** `recoveryAttemptsRef` 预算（主动切换≠故障恢复）。
- **纯音频的 settled 路径**：目前 `recoveryAttemptsRef`/`recoveringRef` 只在首帧画出时归零（`reflectDimensions` 115–127）；纯音频永无首帧，需以 `ontrack kind=audio` + ICE `connected` 作等价归零点。
- **返回值新增**（`isConnected` 语义保持"视频正帧在画"，`AvatarView` 继续用它）：
  - `isMediaReady: boolean`（有视频帧 **或** 纯音频已就绪）→ 给首读门
  - `mediaMode: "video" | "audio-only"`
  - `videoPreference: "auto" | "on" | "off"` + `setVideoPreference(p)`
- **偏好语义**：`auto` 默认（自动降级+自动恢复）；`off` 钉死纯音频、关自动化；`on` 钉死视频、抑制自动降级但保留醒目告警（用户明确覆盖，尊重但要诚实）。
- **两个必须遵守的既有约束**：
  - 新增字段全部是**基础类型**，不返回 `health` 对象（诊断走 `console`）。本 hook 的返回值每次 render 都是新对象字面量，consumer effect 依赖对象会每帧重跑 —— `useInterviewVoice.ts:1407-1423` 记录的拆连接事故正是如此。
  - `switchMediaMode` 与 `attemptRecovery` 一样完全内部化，不碰 `useInterviewVoice` 的 `avatarStartedRef` 一次性守卫。

## 3. `useInterviewVoice.ts`：首读门改判据

首读门是 `firstReadGateRef {text,timer}` + `FIRST_READ_AVATAR_GATE_MS = 6000`（173 行）+ 依赖 `[avatarStream.isConnected]` 的 effect（1436–1445），条件在 1309–1313。纯音频永远没有首帧 → 每次都等满 6 s 才读题（实测日志 `avatar-ready gate elapsed`）。

- 把 `avatarConnectedRef` 的镜像源与该 effect 的依赖从 `isConnected` 换成 **`isMediaReady`**（仍是基础类型，无对象依赖风险）。
- 透传 `mediaMode` / `videoPreference` / `setVideoPreference` 到返回值（1447–1460）。

## 4. UI：诚实的三态 + 手动开关

- **`AvatarView.tsx`**：加可选 prop `mediaMode`（默认 `"video"`，Playground 无需改）。复用已有 `connectingHint` 药丸（263–266）的样式做纯音频提示"网络较弱，已切换为语音模式"——注意该药丸目前只在 `showPortrait` 分支渲染，需让它在纯音频态也出现。根节点加 `data-media-mode` 供 E2E 断言。
- **`InterviewPage.tsx`**：在已有 `styles.voiceControls` 行（1154–1167）加"关闭/开启数字人画面"按钮调 `setVideoPreference`。
- **绝不复用 `voiceUnavailable`**：它的 `onError` 路径会 `setChannel("text")`（495–504），把候选人踢去文字；媒体降级是更轻的状态，必须独立。
- **i18n**：`frontend/src/i18n.ts` 的 `voice.*` 加 en/zh（参考 69–70 与 273–274 行的既有对）。
- **关掉 4 秒空窗**：实测"视频码率归零"到"ICE 报 disconnected"约 4 s，界面仍显示已连接。采样器一发现 `videoBytesFlowing === false` 且 ICE 仍 connected 就立刻反映，不等 ICE 事件。

## 5. 麦克风上行 24 kHz → 16 kHz（唯一的后端改动）

- **前端** `useVoiceAudio.ts`：麦克风侧 47 行 `getUserMedia` 约束、51 行采集 `AudioContext` 改 16000（后者才是真正起作用的，`createMediaStreamSource` 会重采样进 context 速率）。**播放侧 101、119 行的 24000 不能动**（Azure 下发 PCM 的速率）。worklet 与速率无关。
- **后端** `voice_live_proxy.py`：`input_audio_sampling_rate` 是 `RequestSession` 的**顶层**字段（SDK `_models.py:3720`，pcm16 允许 8000/16000/24000），插在 `session_kwargs` 里 `input_audio_echo_cancellation`（323 行）之后，与其它 `input_audio_*` 同块，且在 `has_avatar` 守卫（325）之外。
- **注意**：`settings = get_settings()` 目前在 `if has_avatar:` 块内（326 行），非 avatar 路径读不到 —— 需上提到 289 行之前。
- **新设置** `backend/app/config.py`：`voice_live_input_sampling_rate: int = 16000`，按该块惯例写多行注释（映射到哪个 wire 字段、Azure 默认、实测日期、含义）。顺手把漏掉的 `VOICE_LIVE_AVATAR_VIDEO_BITRATE` 一起补进 `backend/.env.example`。
- **防漂移护栏**：`proxy.connected` 负载（480–497）新增该速率，**读回自 built session**（`session["input_audio_sampling_rate"]`），照 `turn_detection` 在 494 行的既有写法，而不是像 487 行的 `avatar_enabled` 那样重新推导。前端与自己的采集常量比对，不一致则 `console.error` + 一条非致命提示。只改一边会让 Azure 按错速率解释字节流（变调变速、转写全废），这道护栏让漂移在第一次连接就暴露。
- 该参数**会话中途不可改**（官方明确），只能建连时决定。
- `backend/scripts/voice_turn_latency.py:55` 的 `SAMPLE_RATE = 24000` 自建会话，需同步以免探针与生产不一致。

## 6. 保留 `VOICE_LIVE_AVATAR_VIDEO_BITRATE`

保留（默认不设 = Azure 默认）：它是唯一被 Azure 尊重的服务端码率杠杆（实测 lisa 1548→460、amira 645→276 kbps），也是验证"压到 500 kbps 能否让 1080p 重新解出帧"这个廉价假设所必需。文档标清它是逃生阀而非主机制。

---

## 待办

| # | 改动 | 文件 |
|---|---|---|
| 1 | 健康度采样 + 迟滞判决（纯函数） | 新建 `frontend/src/hooks/avatarHealth.ts` |
| 2 | `wantVideo`、getStats 采样器、`switchMediaMode`、纯音频 settled、新增返回字段 | `frontend/src/hooks/useAvatarStream.ts` |
| 3 | 首读门改 `isMediaReady`、透传新字段 | `frontend/src/hooks/useInterviewVoice.ts` |
| 4 | `mediaMode` prop + 纯音频药丸 + `data-media-mode` | `frontend/src/components/AvatarView.tsx` |
| 5 | 手动开关按钮 | `frontend/src/pages/InterviewPage.tsx` |
| 6 | en/zh 文案 | `frontend/src/i18n.ts` |
| 7 | 麦克风侧 16 kHz | `frontend/src/hooks/useVoiceAudio.ts` |
| 8 | 顶层 `input_audio_sampling_rate` + 上提 `get_settings()` + `proxy.connected` 回读 | `backend/app/services/voice_live_proxy.py` |
| 9 | 新设置 + 补 `.env.example` | `backend/app/config.py`、`backend/.env.example` |
| 10 | 探针补采 `totalSamplesReceived`/`framesDecoded` 以标定阈值 | `frontend/e2e/avatar-weaknet-probe.spec.ts` |
| 11 | 回填最终实现与标定后阈值 | `docs/avatar-weaknet-probe.md` §5 |

---

## 验证

**单元（CI 可跑，不碰 Azure）**
- `avatarHealth.ts`：用假 `RTCStatsReport`（Map-like + `forEach`）构造序列，断言四类场景 —— 字节流动但不解码→降级；补偿超阈值→降级；健康窗未满→不恢复；反复失败→递增惩罚并最终永久纯音频。
- `useAvatarStream.test.tsx`：扩展现有 `FakePC`（23–64）—— 加可控 `getStats()`、把 `addTransceiver()` 从空实现改为记录入参、加 `ontrack` 驱动（现有测试从不触发 `ontrack`，纯音频 settled 路径需要它）。断言：纯音频重建时 video transceiver 方向为 `inactive`；该次重建不消耗 `MAX_RECOVERY_ATTEMPTS`；现有四例自愈测试继续通过。
- `useInterviewVoice.test.tsx`：该文件把 `useAvatarStream` 整体 mock 掉，用 `get isConnected()` 读可变的 `avatarState`（22–35 行）。照同一模式加 `isMediaReady`，断言纯音频态首读不再等满 6 s。
- 后端 `test_voice_live_proxy.py`：无测试枚举 session 键集，新增顶层字段不会破坏现有 20 例；补一例断言 `input_audio_sampling_rate` 存在且等于设置值，另一例断言非 avatar persona 路径也带该字段（这是 `get_settings()` 上提的回归点）。注意 `test_voice_live_metadata.py` 用**精确字典相等**断言 `build_avatar_config`，本方案不改它的输出形状。

**本地真 Azure（仓库规则：本地必须打真实 provider，CI 永不碰 Azure）**
- 手动开关无需限速：UI 上点开关，或 `AVATARS=lisa-audio` 走 `frontend/e2e/scripts/weaknet-phase2.sh`，断言视频 0 kbps、音频正常读题、药丸出现、首读不再白等 6 s。
- 自动降级需限速（sudo）：`sudo PROFILES="office-bad" AVATARS="lisa" frontend/e2e/scripts/weaknet-phase2.sh`，断言约 4 s 内自动切纯音频、音频补偿回落到个位数百分比。
- **16 kHz 转写 A/B（本 PR 的合并门槛）**：`live.config.ts` 已支持 `FAKE_AUDIO` 用 WAV 当假麦克风，同一段录音在 24 kHz 与 16 kHz 会话各跑一遍 diff 转写。若准确率有可见下降，把设置默认改回 `None` 并还原前端常量（两行），第 7–9 项拆出本 PR 单独处理。

**回归**：`npm run test` + `npx tsc --noEmit`；后端 `pytest` + `ruff format` 与 `ruff check` **分开跑**（CI 分开检查）。

## 风险

- **闪屏**：自动恢复是明确需求，风险由递增惩罚 + 最多两次尝试兜住；若标定后仍闪，把默认改成"本场不再切回"只是改一个常量。
- **阈值未标定**：`CONCEAL_BAD/GOOD` 是暂定值，探针没采 `totalSamplesReceived`。主触发免阈值，即使标定不准仍能工作。
- **16 kHz 漂移**：前后端必须同改，已用 `proxy.connected` 运行时比对兜底。
- **既有小缺陷（不在本次范围）**：`disconnect()` 不清理 `attachStream` 里的 `setInterval` 轮询器（只靠自身 `settled` 标志或 15 s 超时停）。新增的采样定时器不要重复这个模式。
