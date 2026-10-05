# 候选人转写能不能"流式"显示：文档说法 vs 实测结果

> 2026-10-04。起因是一条长期 TODO：**候选人自己说的话不在页面上逐字流式显示**，只有一句话
> 讲完、整段落地后才一次性出现。昨天的结论是"做不到"，今天查文档又像是"能做到"——这种
> "昨天说不行、今天说可以"的矛盾只能靠**测量**来终结，不能靠断言。
>
> 这篇文档把三种组合逐格记录下来：**文档是怎么说的**（claim），对上**实际跑真机测出来的
> 是什么**（measured）。所有测量都走真实 Azure 资源（Entra 鉴权、swedencentral），用的是同
> 一个 24 kHz 的语音 WAV。没有 mock。
>
> 相关：`docs/voice-live-control-notes.md`（Voice Live 控制总笔记，"听"的那一层见其 §0/§4）。

---

## 0. 一句话结论（能记住这一句就够了）

**同一条 Voice Live 连接，只有一个字段 `input_audio_transcription.model` 能换。换哪个值都
不会让候选人转写变成流式——Voice Live（Azure 托管实时管线）对输入转写只回最终整段
（`.completed`），不吐增量 `.delta`。** 想要逐字流式，只有另开一条 Azure Speech 服务的
连接（Speech SDK 的 `recognizing` 事件），那是**另一套链路**，不是改一个字段的事。

所以：**那个"改一个字段 `model` 就能流式"的生产修复，不成立**，不要做。本文第 4 节说明
为什么。

---

## 1. 背景：页面需要的是哪个事件

Voice Live 的输入转写（我们听候选人）在一条 WebSocket 上回这几类事件，后缀决定语义：

| 事件后缀 | 含义 | 页面流式显示需要的 |
|---|---|---|
| `conversation.item.input_audio_transcription.delta` | **增量**（边说边吐的部分结果） | ✅ 就是这个 |
| `…input_audio_transcription.intermediate` | MAI 专有的中间结果（部分） | ✅ 也可以 |
| `…input_audio_transcription.completed` | **最终**（整段，一次性） | ❌ 只有它 = 不流式 |
| `…input_audio_transcription.failed` | 模型拒绝 / 出错 | — |

页面只有拿到 `.delta`（或 `.intermediate`）才能逐字长出来。只拿到 `.completed`，就只能等
整段落地再一次性显示——这正是当前现象。

**Voice Live 接受的转写模型（权威清单，实测确认）**：`azure-speech`、`azure-mrs`、
`mai-transcribe-1.5`、`mai-transcribe-2`、`mai-transcribe-medical`、
`mai-transcribe-2-streaming`、`mai-transcribe`。`whisper-1` 被拒。

---

## 2. 文档 vs 实测：逐格对比

三种组合，每一格都是"文档怎么说" vs "真机测出来是什么"。

### 组合 A — Azure Speech 服务 + Speech SDK（独立链路，不是 Voice Live）

| | 内容 |
|---|---|
| **文档说法** | Speech SDK 的 `SpeechRecognizer` 持续识别时会不断触发 `recognizing` 事件，给出"实时的部分假设结果"（partial / hypothesis），最终结果走 `recognized`。文档明确承诺流式。 |
| **实测结果** | ✅ **会流式**。`Recognizing(partial)=17`，`Recognized(final)=1`，**首个部分结果在 4.8s** 到达，之后逐词增长（`'i'` → `'i always'` → `'i always double check the runbook before every deployment and i verify…'`），12.7s 落最终，收尾是良性的 `CancellationReason.EndOfStream`。 |
| **结论** | 文档与实测一致。但这是 **Speech 服务自己的 WebSocket**，不是 Voice Live 的转写通道。 |

> ⚠️ 鉴权坑（实测踩到）：这台 Foundry 资源**禁用了密钥**（key-disabled，纯 Entra）。
> Speech SDK 用 `SpeechConfig(subscription=key, region=…)` 会 401
> `WebSocket upgrade failed: Authentication error (401)`。正确姿势是 AAD token：
> `DefaultAzureCredential().get_token("https://cognitiveservices.azure.com/.default")`，
> 把 auth 串拼成 `aad#{resourceId}#{token}`，再 `SpeechConfig(auth_token=auth, region="swedencentral")`。
> 24 kHz 用显式 `AudioStreamFormat(samples_per_second, bits_per_sample, channels)` 原生喂入。

### 组合 B — `azure-speech` + Voice Live（当前生产用的就是这个）

| | 内容 |
|---|---|
| **文档说法** | Voice Live 参考文档把 `conversation.item.input_audio_transcription.delta` 描述为"Streaming input audio transcription"／"随着结果产生给出部分转写结果"。文档**声称**支持流式增量。 |
| **实测结果** | ❌ **只有最终整段**。`completed=1`，`delta=0`。全程没有任何 `.delta`。 |
| **结论** | 文档声称流式，实测不流式。**文档与实测相矛盾**——这就是"昨天查文档像能、实跑不能"的来源。 |

### 组合 C — `mai-transcribe-2-streaming` + Voice Live（名字里带 streaming，最像能流式）

| | 内容 |
|---|---|
| **文档说法** | MAI-Transcribe-2-Streaming 的 **Realtime API** 文档描述它回 `.delta`（新落定的转写）+ `.intermediate`（MAI 专有的部分/中间结果）。看名字和这页文档，最该流式。 |
| **实测结果** | ❌ **仍然只有最终整段**。`completed=1`，`delta=0`，`intermediate=0`。即便在 commit 之前把接收窗口拉到 26s 盯着看，也没有任何部分结果到达。可观测行为和 `azure-speech` 完全一样。 |
| **结论** | 名字带 streaming 不代表在 Voice Live 上流式。文档描述的是 **Realtime `/realtime` 端点**（Azure OpenAI 资源）的行为，不是 Voice Live 这条级联转写通道。 |

### 附带 — `mai-transcribe-2` + Voice Live

实测 `completed=1`、`delta=0`，同样只有最终整段。记录在此以示"换非 streaming 的 MAI 也
一样不流式"。

---

## 3. 为什么文档和实测对不上（已查证的根因）

把"文档声称"这一列查到源头后，矛盾可以解释清楚：

1. **Voice Live 参考文档**确实把 `.delta` 列为"Streaming input audio transcription"——所以
   光读 Voice Live 文档会以为支持。
2. **MAI-Transcribe-2-Streaming 文档**描述的 `.delta`+`.intermediate` 流式，是挂在
   **Realtime API（`/realtime`，Azure OpenAI 资源）**上的，不是 Voice Live 的 `connect()`
   级联转写通道。两者是不同的产品面。
3. 一条 **Microsoft Q&A** 线程把话挑明：Azure 当前的 Realtime / 托管实时基础设施**只吐最终
   转写结果**，部分（delta）转写在 Azure 托管侧**是被有意禁用的**。

第 3 点正好解释第 2 节 B/C 两格的实测：无论把 `model` 换成 `azure-speech` 还是
`mai-transcribe-2-streaming`，Azure 托管侧都只回 `.completed`，`.delta` 一律为 0。

---

## 4. 对生产的影响：那个"改一个字段"的修复不成立

曾设想的生产修复是：在 `backend/app/services/voice_live_proxy.py` 的
`build_avatar_session(...)` 里，把 `input_audio_transcription` 的 `model` 从
`azure-speech` 换成某个 streaming 模型，前端再处理 `.intermediate` / `isFinal`。

**实测否决了这个方案**：Voice Live 上换哪个转写模型都不吐 `.delta`/`.intermediate`，所以
这个单字段改动拿不到流式转写——**不要做**，做了也没效果。

如果将来真的要在页面上逐字流式显示候选人的话，可行路径只有一条：**在 Voice Live 之外另起
一条 Azure Speech 服务连接**（组合 A，吃 `recognizing` 事件），把候选人音频同时喂给它、
用它的部分结果驱动页面显示。那是**新增一条链路**（额外连接、额外鉴权、音频分流、与现有
VAD/commit 时序对齐、以及上线前的 WAV WER A/B），不是改一个字段，属于单独的工程项，不在
本次结论内。

---

## 5. 复现：干净的 Voice Live 探针配置（给以后验证用）

关键坑：对 `mai-transcribe-2-streaming` 用 `server_vad` + 手动 commit 会报
`input_audio_buffer_commit_empty`（"buffer too small"）。干净的文件探针路径是
**关掉 VAD + 显式 commit**：

```python
# 会话：不生成回复、关 VAD，自己把音频喂完再显式 commit
session = {
    "type": "session.update",
    "session": {
        "modalities": ["text", "audio"],
        "input_audio_format": "pcm16",
        "input_audio_sampling_rate": rate,          # WAV 原生 24000
        "turn_detection": None,                      # 关 VAD，走文件探针
        "input_audio_transcription": {"model": MODEL},
    },
}
# 20ms 一帧上行：int(rate*0.02)*2 字节 @ 24000Hz
#   {"type":"input_audio_buffer.append","audio": base64(frame)}
# 全部喂完后：
#   {"type":"input_audio_buffer.commit"}
# 然后 recv 循环，按后缀统计 delta / intermediate / completed / failed
```

连接路径与生产一致：Entra 优先的 `_resolve_voice_live_credential`、certifi SSL
（`connection_options={"vendor_options":{"ssl": ssl_ctx}}`）、model-mode host
（`model=gpt-5-mini`）、`to_cognitive_services_endpoint` 解析端点。

测量用的音频：24 kHz 单声道 16-bit、约 10s（含尾部静音）的英文语音，转写内容为
"I always double-check the runbook before every deployment, and I verify the rollback plan…"。

---

## 6. 结果汇总表

| 组合 | 链路 | 文档声称 | 实测 | 流式？ |
|---|---|---|---|---|
| A. Speech 服务 + Speech SDK | 独立 Speech WebSocket | `recognizing` 实时部分结果 | partial=17，首个 4.8s，逐词增长 | ✅ 流式 |
| B. `azure-speech` + Voice Live | Voice Live 转写通道（**当前生产**） | `.delta` = 流式部分结果 | `completed=1, delta=0` | ❌ 只最终 |
| C. `mai-transcribe-2-streaming` + Voice Live | Voice Live 转写通道 | `.delta`+`.intermediate`（Realtime 文档） | `completed=1, delta=0, intermediate=0` | ❌ 只最终 |
| （附）`mai-transcribe-2` + Voice Live | Voice Live 转写通道 | — | `completed=1, delta=0` | ❌ 只最终 |

**最终结论**：Voice Live 上换转写模型拿不到流式候选人转写（文档声称 vs 实测相矛盾，根因是
Azure 托管实时侧有意禁用 delta）；单字段 `input_audio_transcription.model` 的生产修复**不
被证据支持**。真要流式只能另起 Speech 服务链路，属单独工程。
