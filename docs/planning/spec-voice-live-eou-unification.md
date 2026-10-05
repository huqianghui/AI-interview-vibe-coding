# 按管线选择 Voice Live 的 end-of-utterance 检测，并让 realtime 管线可用

> 2026-10-05。需求来自 owner 的两句话：**"统一删掉，就保留支持音频和文本两种都支持的"** 和
> **"那些一次性探针脚本纳入仓库"**。
>
> **落地口径在实现过程中由 owner 收窄了一次（本文已按最终口径改写）。** 先按"统一到音频型、删掉文本
> 分支"实现并跑绿，随后 owner 定下：**"确保如果用户选择了 chat 模型，还是原来的配置。只是 realtime
> 的时候，改成现在的方式来处理。"** 所以最终形态是**按管线分流**，不是全量替换 —— 理由见 §3。
> §7 原先的阻塞项已解除。
>
> 事实依据全部在 [`../voice-live-model-support.md`](../voice-live-model-support.md) §4.7–§4.9，
> 本文不重复推导，只引用结论。

---

## 1. 背景：为什么会有两套

Voice Live 的 EoU 有两个实现，**不是风格差异，而是决定会话能不能建起来**：

| SDK 类型 | `model` 字面量 | 依据 | 哪些管线接受 |
| --- | --- | --- | --- |
| `AzureSemanticDetectionMultilingual`（**今天线上用的**）| `semantic_detection_v1_multilingual` | **文本**（读识别出的文字）| **仅级联** |
| `SmartEndOfTurnDetection` | `smart_end_of_turn_detection` | **音频**（直接看输入音频流）| **级联 + realtime，实测四种组合全通** |

直通/语音到语音管线没有 Voice Live 的语音识别器，所以文本型被直接拒：

```
"Text-based end-of-utterance detection requires a local speech recognizer and is only
 supported on cascaded pipelines."
param: session.turn_detection.end_of_utterance_detection
```

这一条是 `byom-azure-openai-realtime` 以及**任何原生 realtime 模型**在本产品上连不上的唯一原因
（model-support §4.7）。

---

## 1.5 owner 定的四条（2026-10-05，原话转述）

1. **EoU 统一的单元测试要更新。**
2. **用户选 chat 模型（如 `gpt-5-mini`）→ 保持现在这一套级联做法。**
3. **用户选 realtime 模型 → 用实测那套：不需要 STT，也不用 TTS，直接用 realtime 和用户交流、收声音、驱动数字人。**
4. **judge 和 score 仍然用 chat 模型，不变。**

第 1 / 2 / 4 条与现状一致或已实现。**第 3 条按字面实现会打断面试的两个核心能力**，下面是实测依据；
在 owner 回答 §2.5 的两个问题之前，第 3 条不实现。

### 第 3 条的后果一：不用 TTS = 失去逐字念题

题目必须逐字念，是因为模型中介的朗读会漂移 —— 这不是顾虑，是实测，而且 **realtime 比 chat 模型更差**
（同一道题，各 3 次，比对实际说出的文本）：

| 投递方式 | `gpt-realtime-2.1` | `gpt-5-mini` |
| --- | --- | --- |
| `pre_generated_assistant_message`（**绕过模型**，服务端 TTS）| **3/3** | **3/3** |
| assistant item（模型念）| **0/3** —— 它去**回答问题**了：*"I'm missing a bit of context here—are you asking about a specific company's SOP…"* | 0/3 |
| `response.instructions` 明确要求逐字念 | **1/3** | **3/3** |

> 注意 `pre_generated` 那一行**不说明 realtime 会念** —— 它绕过了模型推理，两个模型都 3/3 是必然的。
> 真正衡量"realtime 会不会飘"的是后两行：**0/3 和 1/3**。

历史上同类漂移造成过真实事故：2026-09-28 模型把 Q4 改写、把 Q7 整个编造，而卡片上显示的是题库原文
（记忆 `ai-interview-external-filler-root-cause`）。题库逐字朗读同时承载 **SOP 引用**与**打分 rubric 对齐**，
失去它等于失去可审计性。

### 第 3 条的后果二：不用 STT = 没有候选人答案文本

`judge` 与 `score`（第 4 条要求保持 chat 模型）吃的是**文本**：候选人的作答转写。这份转写来自会话里的
`input_audio_transcription`（`azure-speech`），也就是"STT"。**关掉它，judge 和打分就没有输入**，报告里
也没有候选人原话可展示。

> 两条合起来：第 3 条字面实现之后，realtime 模式会变成**一场自由对话** —— 题目由模型即兴、没有逐字
> 引用、没有作答转写、没法打分。那是另一个产品形态，不是现有面试流程的一个开关。

### 已验证可行、且不破坏上述两项的那条路

实测（model-support §4.7 / §4.9）：**realtime 当 Speech-LLM + 保留 Azure TTS 与输入转写**是可行的 ——
也就是产品组架构图的第 ③ 行「混合式」：

| 组合 | 结果 |
| --- | --- |
| realtime + avatar + Azure 音色 + 音频型 EoU | ✅ `avatar ice=1`、`voice=azure-standard` |
| realtime 会话上的逐字念题 | ✅ 188000 字节、**逐字一致**、比级联快 0.4s |
| realtime + `azure-speech` 输入转写 | ✅（配音频型 EoU）|

**这条路把 realtime 的好处（它当耳朵和脑子、延迟更低）拿到手，同时逐字念题和作答转写都保住。**

---

## 2.5 两个前提问题 —— 已由 owner 决定：**两项都保留**（2026-10-05）

1. **realtime 模式下的题目**：接受**模型即兴发问**（放弃逐字引用与 SOP 可审计性），还是仍然用 **Azure TTS
   逐字念**（即「混合式」）？实测：模型念的逐字命中率 1/3，chat 模型 3/3。
   → **决定：保留 Azure TTS 逐字念**（`pre_generated_assistant_message`）。
2. **realtime 模式下的作答转写**：接受**没有候选人文本**（judge / 打分 / 报告失去输入），还是**保留输入
   转写**？
   → **决定：保留 `azure-speech` 输入转写。**

> 两项都"保留"，所以**不需要新产品模式**：realtime 走的就是产品组图里的「混合式」—— realtime 当
> Speech-LLM（听 + 想），**嘴仍然是 Azure TTS**，口型因此照旧由 TTS 驱动。现有代码加上按管线选 EoU
> 就已经支持，题目来源 / 打分输入 / 报告形态全部不变。

---

## 2. 需求

1. **R1 一条判断入口**：检测器的选择只能有**一处**决定（`uses_realtime_pipeline`），不允许调用方各自
   拼条件。两个检测器都保留 —— 它们不是"做同一件事的两份实现"，而是**两条管线各自唯一可用的那一个**
   （文本型在 realtime 上被 Azure 直接拒），所以留着不违反 owner 那句"没用的代码没被重构掉"。
2. **R2 realtime 管线可用**：选 realtime 模型（原生或 BYOM）时语音会话能正常建立并跑完一场面试。
3. **R3 行为不回退**：统一之后，级联（今天线上的那条）的作答分段与判定时机**不得变差**。
4. **R4 评估不动**：judge / 打分 / agent 继续用 **text（chat）部署**。owner 确认："评估和 judge 还是基于
   text"。实测支持这一点：realtime 部署在 7 个 HTTP 文本面 + Responses 的 WS 模式上**全部被拒**
   （model-support §4.9）。**本需求不涉及推理腿的任何改动。**
5. **R5 数字人不受影响**：avatar + Azure TTS + 逐字念题在 realtime 下已实测可行
   （`avatar ice=1`、`voice=azure-standard`、逐字念题 188000 字节逐字一致且更快 0.4s）。

---

## 3. 设计：**按管线分流，没有运维旋钮**

检测器由**语音模型推导**，不是由人去配：

| 语音模型（admin 里选的那个） | 管线 | EoU 检测器 | `timeout_ms` |
| --- | --- | --- | --- |
| chat 模型（`gpt-5-mini` 等，今天线上） | 级联 | `semantic_detection_v1_multilingual` | **1500（原值不动）** |
| realtime 原生（实测 6 个） | 语音到语音 | `smart_end_of_turn_detection` | **1000** |
| BYOM `byom-azure-openai-realtime` | 语音到语音 | `smart_end_of_turn_detection` | **1000** |
| BYOM 其它 profile | 级联 | `semantic_detection_v1_multilingual` | 1500 |

| 动作 | 细节 |
| --- | --- |
| 加 | `voice_live_probe.uses_realtime_pipeline(model, byom_profile)` —— **唯一**的判断入口。原生按**实测集合**查名字；BYOM 只看 profile（实测：自有 `gpt-realtime-2.1` 挂在 chat-completion profile 下，文本型 EoU **照样 ACCEPTED**，所以名字不作数）|
| 加 | `MOUTH_EOU_AUDIO_TIMEOUT_MS = 1000`，与保留原值的 `MOUTH_EOU_TIMEOUT_MS = 1500` 并存 |
| 穿线 | `realtime_pipeline` 从 `voice_live_ws` / `admin_config` 一路传到 `build_turn_detection`，并出现在 `proxy.connected` 诊断帧里（线上可直接看出走的是哪条）|
| 不加 | **没有 `voice_pipeline` 配置列、没有 UI 开关** —— 管线由模型唯一决定，让运维去选只会配错 |
| 不改 | `MOUTH_VAD_SILENCE_MS=800`、`remove_filler_words`、`azure_semantic_vad_multilingual` 外层、`voice`（Azure TTS）、`input_audio_transcription`（`azure-speech`）、avatar、逐字念题 |
| 不改 | 推理腿（R4）；`persona.eou_detection` 关掉时**两条管线都**退回普通 `azure_semantic_vad` |

> **为什么不统一到音频型（owner 2026-10-05 收窄）**：音频型在级联上也 ACCEPTED，§4 的 A/B 也只证明了
> **两者等价**（英文 7.68s vs 7.57s、中文 8.96s vs 8.98s）—— 等价不是"更好"。统一就意味着把**今天唯一
> 在线上跑的那条路**换掉，去换一个零功能收益。所以新路线的风险只落在新路线上：**chat 保持原样，
> realtime 吃新的。**
>
> 这不会复活"只会配错的旋钮"：没有任何人工开关，`uses_realtime_pipeline` 一处决定，错配的两个方向
> 也都是良性的 —— 把级联误判成 realtime 只是换个等价检测器，把 realtime 误判成级联则在 `session.update`
> 当场被 Azure 拒掉（不会静默劣化）。

---

## 4. 实测依据（`scripts/voice_live_eou_ab.py`，真实 Azure）

同一段 WAV、20ms 帧实时推送、尾部 3s 静音、模型 `gpt-5-mini`（级联是两种变体都合法的唯一管线）。

**英文，1.2s 中间停顿，每种 2 次 —— 持平：**

| 变体 | 分段 | stops | 末次 stop 中位 |
| --- | --- | --- | --- |
| `text@1500`（今天线上）| 2, 2 | 2.83/7.51、2.93/7.63 | **7.57s** |
| `audio@1000` | 2, 2 | 3.09/7.65、3.15/7.71 | **7.68s（+0.11）** |

四次运行转写文本**逐字相同**。

**英文，2.5s 长停顿：** 两者都 2 段，末次 stop 8.91s vs 9.14s，文本一致。

**`timeout_ms` 的敏感性（1 次）：** `audio@1500` 比文本型晚 0.45–0.6s；**`audio@700` 行为变质** ——
不再在停顿处切，合成一段并推迟到 9.08s。所以 1000 不是"越小越好"的中间值，而是实测出来的点。

**文本型声称的优势没有出现**：`build_turn_detection` 原注释说文本型给"更干净、更少碎片的分段"，但在带
停顿的输入上两者**切得一模一样**。

---

## 5. 测试计划

### 5.1 纳入仓库的探针（owner 要求，可重跑复验）

| 脚本 | 回答什么 |
| --- | --- |
| **`scripts/voice_live_eou_ab.py`**（已写）| 两种 EoU 在同一段真实音频上的分段 / 时序 / 转写对比；`--variants text:1500,audio:1000 --reps N --locale zh-CN` |
| **`scripts/voice_live_session_probe.py`**（本次新增）| 某个 (模型, BYOM profile, EoU 变体, avatar, voice) 组合**会不会被接受**，以及被拒时 Azure 的原话 —— §4.7 那几张矩阵就是它产出的 |
| `scripts/voice_live_model_probe.py`（已在库）| 某 region 原生清单 / BYOM 连通性 |

WAV 的造法写进脚本 docstring（macOS `say` + `afconvert`，24kHz 单声道 16-bit），**不依赖云端**，任何人可复现。

> 装置上的坑也写进脚本注释：音频放完后**必须继续发静音帧**，否则 VAD 永不报 `speech_stopped`
> （第一次测就栽在这里，两边都只有 `speech_started`）。

### 5.2 单元测试（azure-free）

- `build_turn_detection`：**级联** → `semantic_detection_v1_multilingual` @1500（锁死"chat 不变"）；
  **realtime** → `smart_end_of_turn_detection` @1000。
- `eou_detection=False` 在**两条管线上都**退回普通 `azure_semantic_vad`（管线只选检测器，不会把关掉的
  检测重新打开）；agent 会话不变。
- 两个常量都锁死，注释写明各自的来历（1500 = 一直在跑的值，1000 = A/B 实测点）。
- `uses_realtime_pipeline`：6 个原生 realtime → True；chat 模型 → False；**`phi4-mm-realtime` → False**
  （实测反例，防止有人改成按名字匹配）；BYOM realtime profile → True；**BYOM chat profile + 名字叫
  `gpt-realtime` 的部署 → False**（实测：那条路文本型 EoU 照样 ACCEPTED）。
- 回归：`audio_eou` 这个旧参数名不再存在（管线信息只以 `realtime_pipeline` 一个名字流动）。

### 5.3 真实连接验收

1. `voice_live_session_probe.py`：原生 realtime / 原生 chat / BYOM realtime / BYOM chat **四种全部 ACCEPTED**。
2. `voice_live_eou_ab.py --reps 2`：级联下与 `text@1500` 的持平复现一次（R3）。
3. 逐字念题在 realtime 会话上仍逐字一致（已实测，统一后复测一次）。
4. 浏览器 E2E：`byom-voice-live.spec.ts` 的 realtime 用例从"**保存被 422**"改成"**保存成功 + 真跑一场面试**"
   —— 这正是统一之后该变的断言。
5. `voice-live-azure.spec.ts`（级联）重跑，确认无回归。

---

## 6. 迁移与回滚

- 删 `voice_pipeline` 需要一条 **down 迁移**（它刚加、尚未合入主干，若已合入则补 drop column）。
- 回滚路径：把 `MOUTH_EOU_TIMEOUT_MS` 和检测器类型两处改回去即可；没有数据格式变更，**无需数据迁移**。

---

## 7. 中文：先不可结论，换素材后确认持平（阻塞项已解除）

**第一轮用 macOS `say -v Tingting` 的素材，两边都不干净：**

| 变体 | rep | 分段 | 观察 |
| --- | --- | --- | --- |
| `text@1500` | 1, 2 | **0 段** | `speech_stopped` 正常在 4.6–4.7s 触发，但**之后没有任何转写** |
| `audio@1000` | 1 | 2 段 | seg0 是**空串**，seg1 是整句**合并** |
| `audio@1000` | 2 | 2 段 | 正确切分 |

当时的判断是"**不可结论**"——两边都不稳，且音频型两次重复自己都不一致。已排除会话配置：
`locale=zh-CN → input_audio_transcription{model: azure-speech, language: zh-CN}`、voice 也正确切到
`zh-CN-XiaoxiaoNeural`。

**第二轮改用 Azure 自己的 TTS 合成中文素材**（走 `pre_generated_assistant_message` 把
`zh-CN-XiaoxiaoNeural` 的 PCM 录下来拼成 1.2s 停顿的 WAV —— 和线上说话的引擎同一个），结果干净：

| 变体 | 分段（2 次）| 末次 stop 中位 |
| --- | --- | --- |
| `text@1500` | 2, 2 | 8.98s |
| **`audio@1000`** | 2, 2 | **8.96s（−0.02）** |

**所以第一轮的失败是素材问题，不是 EoU 的差异。** macOS `say` 的中文合成音显然不适合做转写素材；换成
产品实际使用的 TTS 之后，中文**同样持平，而且比英文更紧**（英文差 0.11s，中文差 0.02s）。

> 一个会被误读的细节：这一轮 `transcript text identical = False`，但原因只是 ASR 的**同音词抖动**
> （`附合` / `复合`，两者都不是原文的"复核"）—— **分段点与第二段逐字在四次运行里完全相同**。
> 把它读成"两种 EoU 行为不同"是错的。

**阻塞项解除**：英文（1.2s 停顿 ×2、2.5s 长停顿）与中文（1.2s 停顿 ×2）均确认持平，§3 的删除可以执行。

> 留给未来的两条**仍未验证**项，不随本次解决：
> 1. `audio@700` 那次"更短超时反而合成一段并推迟到 9.08s"的机理没查清 —— 不要把这个 knob 往下调。
> 2. 都是合成语音；真人录音（口音、语速、背景噪声）未覆盖。
