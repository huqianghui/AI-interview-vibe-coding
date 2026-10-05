# 精确控制 Azure Voice Live：让数字人"照稿朗读"，把智能留给后端

> 2026-09-28。起因是一场真实面试里的现场 bug：题目卡片显示 "Question 7 of 9 — How do you
> oversee safety reporting across EMEA?"，数字人却问出 "What methods do you use to gather feedback
> from local teams?"（题库里根本没有这句）。排查、修复（v0.39.2.3–v0.39.3.2，PR #123–#126）之后，
> 把 Voice Live API 的控制方式梳理成这篇笔记，回答三个问题：
>
> 1. 怎么让 Voice Live 直接 TTS，而不是让模型"回复"？
> 2. 直接 TTS 之后已经不走 LLM 了，为什么建连还必须配模型？能不配吗？
> 3. 既要精确控制读题，又要保留一部分 LLM 生成（judge、Playground），代码和 prompt 怎么分工？
>    附带一个常见混淆：prompt 管的"语气"只是**文字**；语速、表现力、发音是**语音层**，走
>    `session.voice`，不是 SSML（§1.5）。
> 4. （2026-09-30 补）"听"的那一层：输入采样率为什么默认 24 kHz 而不是 Azure 语音服务的 16 kHz，
>    能不能降、降了影响什么（§4）；以及 avatar 协商的两条硬约束：一次性协商、创建速率限制（§4.6）。
>
> 代码指向：`frontend/src/hooks/useInterviewVoice.ts`（前端协议层）、
> `backend/app/services/voice_live_proxy.py`（会话构建 + 中继）、`backend/app/interview/judge.py`。

---

## 0. 先搞清 Voice Live 里"一句话是怎么被说出来的"

Voice Live 一个会话 = 一条 WebSocket，上面跑着五件事：

| 环节 | 谁在做 | 我们能控制的开关 |
|---|---|---|
| 听（VAD + STT） | Azure `turn_detection` + `input_audio_transcription` | VAD 类型、`create_response`、EOU 检测、`input_audio_sampling_rate`（§4） |
| 想（决定说什么） | 会话绑定的 **模型**（`model=` 或 Foundry agent） | `response.create` 发不发、带什么 |
| 说（TTS） | Azure 语音（`voice`） | 文本从哪来 |
| 脸（avatar） | Azure avatar 管线（WebRTC 视频） | `avatar` 配置 |
| 记（对话历史） | 会话里的 conversation items | `conversation.item.create/delete` |

关键认识：**每一次 `response.create` 都是一次"想"**。默认情况下（`create_response=true`）候选人一停
顿，Azure 就自动替你发一次；即便关掉自动回复，你手动发的 `response.create` 仍然是一次模型推理——
模型看着整段对话历史，决定说什么，然后 TTS。

我们的面试是"题库驱动"的：问哪题由后端定，数字人只是嘴。所以"想"这一步在读题环节是多余的，也
正是它出的错。

---

## 1. 怎么直接 TTS，不让模型"回复"

### 1.1 我们走过的三种读法

| 版本 | 读题方式 | 结果 |
|---|---|---|
| 最早 | `conversation.item.create(role=assistant, text=题目)` + 裸 `response.create` | gpt-4o 把 assistant item 当"我已经说过了"，回一句 "Understood." 或**自己编一道题** |
| v0.37.x–v0.39.2.2 | `response.create { response: { instructions: 阅读契约 + "say ONLY this, verbatim: 题目" } }` | gpt-4o 上可靠；prod 切 gpt-5-mini 后，第 4/7 题起对话历史像一场面试，模型按惯性"出下一题" |
| **v0.39.2.3 起** | `response.create { response: { pre_generated_assistant_message: {...} } }` | 服务端直接 TTS 给定文本，**不经过模型**，不可能改写 |

前两种都是**prompt 约束**——你在求模型照读；第三种是**机制约束**——文本根本不进模型。

### 1.2 `pre_generated_assistant_message` 的用法

```json
{
  "type": "response.create",
  "response": {
    "pre_generated_assistant_message": {
      "type": "message",
      "role": "assistant",
      "content": [{ "type": "text", "text": "How do you oversee safety reporting across EMEA?" }]
    }
  }
}
```

官方文档原话："generates an audio response for the predefined text, **bypassing model inference for
text generation**. The message is added to the conversation context history."
在我们用的 `2026-01-01-preview` 版本里就有（`2026-04-10` GA、`2026-06-01-preview` 同样有）。

实测（真 Azure，照片数字人 amira + gpt-5-mini）要点：

- 事件流和普通 response 一样：`response.created → response.audio_transcript.delta/done →
  response.audio.delta（avatar 模式下音频走 WebRTC，WS 上没有）→ response.done`。所以现有的
  "Interviewer 气泡"和"按 response id 确认送达"逻辑一行没改。
- `response.done.usage`：`input_tokens: 0`，只有 output 音频 token（TTS 本身）。候选人说话的
  音频仍计 input audio token。也就是说读题环节的模型输入成本归零；会话/音频计费照常，以定价页为准。
- 首字延迟：读题请求发出 → `response.created` 约 0.26–0.35 s（探针 `backend/scripts/voice_turn_latency.py`
  的 `read.gen_created`）。
- 与 `role: user` 的 item 不同，它**不会**触发模型回答；与 `role: assistant` 的 item + 裸
  `response.create` 不同，它**不会**被模型"接话"。
- 文本会进入对话历史（"added to the conversation context history"），所以后面如果还有真正的模型
  回合，模型知道数字人已经说过这句。

### 1.3 光有 TTS 读法还不够：把其它"会说话的口子"也堵上

数字人能开口的路径不止一条，每一条都要用**协议级**开关控制，而不是靠 prompt：

| 口子 | 关法 | 代码位置 |
|---|---|---|
| 候选人停顿后 Azure 自动回复 | `turn_detection.create_response: false` | `voice_live_proxy.build_turn_detection` |
| 前端"我答完了"后的裸 `response.create` | linear 模式下不发（`linearTurns` 选项） | `useInterviewVoice.commitAnswer` |
| Foundry agent 自己的指令（"候选人答完要致谢"） | linear/judged 会话**不挂 agent**，走 MODEL 模式 | `voice_live_proxy.is_mouth_persona` |
| 读题本身 | `pre_generated_assistant_message` | `useInterviewVoice.emitSpeak` |

第三条值得展开：agent 模式下 Azure **拒绝** `response.create` 里覆盖 `instructions`（live 报错
"Overriding instructions in response.create is not supported"），而 agent 自己的指令会赢过任何
assistant item——2026-09-24 实测第 2 题的读题被 agent 变成了一句 "Thank you."。所以凡是"嘴"型会话
（external、linear、judged）一律 MODEL 模式建连，agent 只留给编辑器 Playground。

### 1.4 读法可靠了，还要"知道它读对了没有"

之前的送达确认只按 response id（注释原话 "immune to paraphrasing"）——这恰恰让改写/编造无声无
息。现在：

- 读题 response 的 `audio_transcript.done` 到达时，`speechMatchesText(转写, 题目)`（忽略大小写、
  标点、空白）不一致就 `console.warn("[voice] question read deviated…")`。TTS 读法下这永远不该触
  发，触发即回归。
- live spec `bank-linear-restart-live.spec.ts` 抓页面发出的每个 `response.create`，断言
  `pre_generated_assistant_message.content[0].text === 卡片题目`，且 Azure 转写 == 卡片题目。

### 1.5 "怎么发声"是另一层：语速、表现力、发音靠 `session.voice`，不靠 prompt，也不是 SSML

容易混的一点：prompt 只能影响**模型生成出来的字**。在 mouth 模式下读题连字都不是模型生成的，所以
prompt 对读题的"语气"毫无作用；judge 的 nudge 和 Playground 是仅剩的、prompt 能影响措辞的地方。
语音层——语速、情绪起伏、某个缩写怎么念——由会话的 `voice` 对象控制（`session.update`）：

```json
{
  "voice": {
    "type": "azure-standard",
    "name": "en-US-Ava:DragonHDLatestNeural",
    "temperature": 0.8,
    "rate": "1.1",
    "custom_lexicon_url": "https://…/lexicon.xml"
  }
}
```

| 参数 | 作用 | 备注（`azure-ai-voicelive 1.3.0b1` / API 参考核对） |
|---|---|---|
| `name` | 选声音（600+ 神经语音，HD 语音更有表现力） | 我们按 locale 从 persona `voice_map` 取 |
| `temperature` 0–1 | **表现力 / 情绪起伏**：高 = 更有戏剧性，低 = 平稳中性 | HD 语音生效；FAQ 里的 "voice temperature" |
| `rate` `"0.5"`–`"1.5"` | 语速 | 字符串 |
| `style` | 说话风格（支持 style 的语音） | SDK 有字段；未在本项目暴露 |
| `prosody`（pitch / rate / volume） | SSML 式韵律值：`x-low…x-high`、`+10%`、`+50Hz`、`-2st`、`-6dB` | 见 `2026-04-10` 及之后的 API 参考；prod 的 `2026-01-01-preview` 上未验证 |
| `custom_lexicon_url` | 发音词典（格式同 SSML lexicon）——"TMF"、"EMEA"、"SOP" 这类怎么念 | 对专业术语很有用 |
| `custom_text_normalization_url` | 数字 / 日期等的读法规则 | |

两个限制要记住：

1. **这些是会话级参数，不是逐句 SSML。** `pre_generated_assistant_message.text` 是纯文本，文档没有声
   明支持内联 `<speak>` / `<prosody>` 标记。想"这题读慢一点"，路径是在两次读题之间发 `session.update`
   改 `voice`，而不是往文本里塞标签——会话中途改 voice 是否有切换延迟，需要 live 验证再依赖。
2. **情绪不能像 SSML `express-as` 那样逐句指定**，只能靠 `temperature`（整体表现力）+ `style`（整体
   风格）+ 选一个本身有情绪特征的声音。

**本项目里的一个 bug（2026-09-30 发现，v0.39.3.3 修）**：persona 上早就有 `voice_temperature`
（默认 0.8）和 `playback_speed`（默认 1.0），编辑器里能调，但它们只被老的 `/calls` 元数据构建器
（`voice_live_metadata.py`）用到；生产实际走的 WS 代理 `voice_live_proxy.build_avatar_session` 只传了
`name` + `type`——调了没效果。修法是把两者接进 `AzureStandardVoice(temperature=…, rate=str(…))`，
live spec 断言 `session.updated` 回显的 `voice.temperature` / `voice.rate` 等于 persona 的值（实测
回显 `temperature: 0.8, rate: "1.0"`）。
接上之后出现一个**新的**风险（对抗评审抓到）：以前值不生效，所以编辑器把温度放到 0–2、语速放到
0.5–2 也无害；现在值直达 Azure，超出范围会让 `session.update` 被拒、整条语音通道报 "Voice
unavailable"。所以同一个 PR 里：管理 API 加了 `Field(ge/le)` 边界（温度 0–1、语速 0.5–1.5）、编辑器
输入框收到同样范围、会话构建器再做一次 clamp（保护边界生效前存下的旧值）。
教训和读题那件事同源：**以为在控制，其实那条路径根本没接上；只有抓 WS 帧断言，才知道生效没有。
而一条路径真接上之后，原本"无害"的输入范围就要重新审一遍。**

---

## 2. 不走 LLM 了，为什么建连还必须配模型？能不配吗？

### 2.1 为什么必须配

Voice Live 的会话身份就是"一个模型 + 一组语音能力"。建连 URL 必须带 `model=<区域原生模型>`
或 `agent_name=…`，没有"纯 TTS 会话"这种类型：VAD、STT、TTS、avatar 都是**挂在这个模型会话上**的
配套能力，而不是独立服务。所以即使我们一次 `response.create` 都不让模型"想"，会话也要有个模型
坐在那里——它是会话的宿主，不是我们在用的功能。

顺带一提，`model=` 只接受该区域原生的 Voice Live 模型（swedencentral 上 gpt-5-mini / gpt-4o /
gpt-4.1-mini 等），自己部署的 deployment 名不算——这是另一坑（memory
`ai-interview-voice-model-not-chat-model`）。

### 2.2 那这个模型现在还干什么

在 linear / judged / external 会话里：**一句话都不生成**。剩下三件事：

1. 当宿主：承载 VAD/STT/TTS/avatar。
2. 当保险丝：我们仍把 reader prompt（阅读契约）作为 system item 注入。万一哪条代码路径误发了一
   个裸 `response.create`，它会按"只读稿、不追问"行事，而不是自由发挥。
3. 真正用到它的只剩编辑器 **Playground**（agent 模式，自由对话测 instructions）。

### 2.3 想彻底不配模型？可以，但换产品

如果你的场景连"保险丝"都不要、也不用 Voice Live 的 VAD/STT：Azure **Speech 服务的实时 TTS
avatar**（Speech SDK avatar synthesis，WebRTC）是纯 TTS + 数字人，不涉及任何 LLM。代价是：

- 听（STT + VAD）要自己另接 Speech 的识别服务，轮次管理自己写；
- 一条连接变多条，延迟与状态同步都要自己处理；
- 我们已经踩平的 Voice Live 坑（首读被 avatar 握手切掉、cancel-then-speak、重连状态）要在新
  管线上重来一遍。

对我们这种"题库驱动 + 需要听候选人 + 偶尔要 judge 出声"的场景，留在 Voice Live、把模型当宿主
是更省的选择：读题走 TTS，模型输入成本归零，架构不变。


### 2.4 `is_mouth_persona` 和 `linear_turns_for_persona` 是不是一回事？要不要传模型？

这是最常被问的一组问题，拆成三句回答：

**一、今天两个函数的返回值完全相同——因为一个就是调用另一个。** 看代码
（`voice_live_proxy.py:133` 与 `:149`）：

```python
def linear_turns_for_persona(persona, *, playground=False) -> bool:
    is_external = (getattr(persona, "interview_brain", "bank") or "bank") == "external"
    if is_external:
        return True            # 外部大脑永远逐字念
    return not playground      # 题库：面试页 True，Playground False

def is_mouth_persona(persona, *, playground=False) -> bool:
    return linear_turns_for_persona(persona, playground=playground)   # 字面委托
```

所以此刻 `is_mouth_persona(p) == linear_turns_for_persona(p)`，恒等。但——

**二、它们是两个概念，喂给两个不同的决策，只是今天恰好同真同假。** 保留两个名字不是冗余，是把
"这一步该不该发生"分开表达，将来某个概念要独立演化时不必动另一个：

| 判定 | 回答的问题 | 驱动哪个开关 | 代码位置 |
| --- | --- | --- | --- |
| `linear_turns_for_persona` | 这个会话里 Voice Live 的模型要不要**自己生成一个回合**？ | `create_response`（mouth ⇒ `False`，模型一句不说） | `:210` / `:215` |
| `is_mouth_persona` | 这个会话要不要**摘掉 Foundry agent、以 MODEL 模式建连**？ | `is_agent`（mouth ⇒ 剥掉 agent） | `:428` |

即 `is_agent = bool(agent_id) and not is_mouth`（`:428`）——是"嘴"就把 agent 显式摘掉，哪怕
persona 同步出了 `agent_id`。两条链路：一条管"模型准不准张嘴"，一条管"连法挂不挂 agent"。

**三、要不要传模型？——live Voice Live API 永远要恰好一条"大脑接法"，所以"嘴"也仍然传
`model=`。** 一个会话必须且只能走 §1 开头那三条接法之一：① `model=<原生名>`、② BYOM
（`model=<你的 deployment>` + `profile`）、③ agent 三件套。没有"一条都不选"的会话。本仓库只用 ①
和 ③：是 agent 就填 agent 三件套且**不传** `model=`；否则填 `connect_kwargs["model"] =
default_model`（`:446`）。

> **关键：mouth 会话走的是 ①，照样传 `model=default_model`——但这个模型是"宿主"不是"大脑"。**
> 它承载 VAD/STT/TTS/avatar（§2.1、§2.2），`create_response=False` 让它一句不生成（§2.2 第 2 点
> 的"保险丝"）。所以"不走 LLM 为什么还要传模型"和"是嘴为什么还要传模型"是同一个答案：传的是语音
> 流水线的宿主，不是在用它推理。真正的"大脑"在别处——外部 API 产题、题库静态文本、或 off-WebSocket
> 的 judge LLM（§3.2），都不经过这个 `model=`。
>
> 唯一真正把模型/agent 当大脑用的会话是编辑器 **Playground**（`playground=True`）：对一个 synced
> 的 bank persona，`linear_turns_for_persona` 和 `is_mouth_persona` 都翻成 `False`，于是 agent
> 不再被摘、`create_response` 打开，模型才"想"。详见 §3.2 与 [`voice-live-model-support.md`](./voice-live-model-support.md) §3.3 的运行期调用链表。
---

## 3. 既要"精确读题"，又要"保留部分 LLM 生成"：代码和 prompt 怎么分工

### 3.1 原则：**能用机制的绝不用 prompt；prompt 只管语气**

| 要保证的事 | 用什么保证 | 为什么不用 prompt |
|---|---|---|
| 题目原文一字不差 | `pre_generated_assistant_message` | 实测 prompt "verbatim" 在 gpt-5-mini 上会漂 |
| 候选人停顿时数字人不插话 | `create_response=false` | 单个布尔，比"请勿打断"可靠 100% |
| 不追问、不纠偏 | 后端 judge 的 verdict 集合就是 `(wait, nudge)`；`follow_up`/`redirect` 直接不认 | 模型再"想"追问也发不出来 |
| nudge 不是变相提问 | 服务端 `probe_guard`：含 `?/？` 或疑问词开头 ⇒ 静音 | prompt 里"不要问问题"是软约束 |
| 不泄露评分要点 | judge 的 prompt **不放 rubric**；再加 `leak_guard` 兜底 | 模型看不见的东西无从泄露 |
| 什么时候该说 | 后端状态机 + 页面时序（停顿计时、提交） | 时序不该交给模型判断 |
| **说什么字**（用词、耐心、是否致谢） | prompt——persona 的 `prompt_fragment` / reader prompt / judge 契约 | 这才是 prompt 擅长的；**只影响模型生成的文本** |
| **怎么发声**（语速、表现力/情绪、发音） | `session.voice`：`name`、`temperature`、`rate`、`style`、`custom_lexicon_url`（见 §1.5） | prompt 碰不到语音层；这是会话参数，不是 SSML |

### 3.2 我们现在的三种"嘴"

```
                      决定说什么                 怎么说出来
linear bank    ───►  后端题库指针          ───►  pre_generated TTS
judged bank    ───►  题库指针 + 后端 judge  ───►  pre_generated TTS（题目和 nudge 都是）
external       ───►  外部 workflow（Dify）  ───►  pre_generated TTS
Playground     ───►  Voice Live 里的 agent  ───►  模型自己的 response（这里才让它"想"）
```

judged 模式是"保留部分 LLM"的典型：LLM 在**后端**（gpt-5-mini chat 调用，reasoning off），拿
到的是候选人的草稿转写，只回答一个问题——"这句话是不是说完了"。它产出的 nudge 文本再作为普通
文本走 `pre_generated` TTS。**Voice Live 里的模型仍然一句不生成**。这样 LLM 的自由度被限制在一个
可以单元测试、可以 eval、可以加守卫的 JSON 输出里，而不是直接对着候选人开口。

### 3.3 judge 的 prompt 怎么写才和代码配合

- **有序检查再给结论**。reasoning-off 的小模型直接问"要不要说话"会把停顿当作"还在说"。让它先
  引用"最后几个词"（`closing_words`），再判 `ends_complete`，最后才 `verdict`——顺序本身就是约束。
- **允许的 verdict 由代码给**：prompt 里写 "Allowed verdicts right now: wait, nudge."，parse 时
  不在集合内的一律 `wait` + error 事件。prompt 和代码说的是同一份 `VERDICTS`。
- **不给它不需要的信息**：nudge 不需要 rubric，就不放。少一段上下文 = 少一种泄露 + 少一份 token。
- **输出形状再过一遍代码**：长度上限、`leak_guard`、`probe_guard`，任何一条不过 ⇒ 静音。原则是
  "宁可不说，不可说错"。
- **persona 的 prompt 放在前面、契约放在最后并声明覆盖**（"it overrides anything above"）——管理员
  可以改语气，改不动规则。

### 3.4 前端协议层要防的几个坑（都踩过）

1. **cancel-then-speak**：`create_response=true` 时 Azure 自动回复常在飞行中，直接发读题会撞
   `conversation_already_has_active_response`。现在 linear 下没有自动回复，但机制保留：有活动
   response 就先 `response.cancel`，等 `response.done` 再读。
2. **phantom active response**：发 `response.create` 前乐观地标 `activeResponseRef=true`，如果
   Azure 拒绝（非撞车错误）、看门狗放弃、或 WS 掉线，这个标记要**主动清掉**，否则后面每题都"取消
   并排队"等一个永远不来的 `response.done`——整场静音（v0.39.2.3 / v0.39.3.1 修）。
3. **首读被 avatar 握手切掉**：avatar 的音频走 WebRTC，视频帧没画出来前读题开头会被吃掉。首读
   要等 avatar 就绪（有上限），重连后同样要重新 gate。
4. **重连要重置轮次状态**：不只是 avatar 的守卫，读题看门狗、未确认的读题（stash 后在新会话重
   读）、judge/自动提交计时器、麦克风（`cleanupMic` 再重新 `initMic`，否则每次重连泄漏一个
   MediaStream）。
5. **按 id 确认送达 ≠ 确认内容**：加转写比对。

### 3.5 一个决策清单

新加一句"数字人要说的话"时，问自己：

1. 这句话的**内容**是谁定的？后端/外部系统 ⇒ `pre_generated`；必须由模型现场生成 ⇒ 才用
   `response.create` 让它"想"，并且优先在**后端** LLM 里生成成文本再 TTS。
2. 触发**时机**是谁定的？页面/状态机 ⇒ 用事件与计时器，不要依赖 `create_response=true`。
3. 有没有**不该说**的情况？写成代码守卫（集合、正则、长度），prompt 只是第一道网。
4. 怎么**证明**它说对了？live spec 抓 WS 帧断言发出的文本 == 期望，转写 == 期望。
5. 要调的是**字**还是**声**？字 ⇒ prompt / 后端文本；声（语速、表现力、发音）⇒ `session.voice`
   参数，并断言 `session.updated` 回显了你设的值——管理端的旋钮不等于生效。

---

## 4. 听的那一层：输入采样率为什么默认 24 kHz，能不能降到 16 kHz

> 2026-09-30 补记。起因是弱网实测（`docs/avatar-weaknet-probe.md`）发现麦克风上行实测 540 到 680 kbps，
> 在窄上行的办公网里会把自己的信令挤死。查"能不能降采样率"时撞上一个看起来矛盾的事实：
> **Azure 语音服务的默认采样率是 16 kHz，而 Voice Live 的输入默认是 24 kHz。**

### 4.1 这个数值是什么意思

采样率 = 每秒对麦克风波形测量多少次。24 kHz 就是每秒 24000 次。它的意义由奈奎斯特定理决定：
**能记录的最高声音频率 = 采样率的一半。**

| 采样率 | 可记录最高频率 | 典型场景 |
|---|---|---|
| 8 kHz | 4 kHz | 传统电话，听起来发闷 |
| 16 kHz | 8 kHz | 语音识别行业标准；Azure 语音转文字 / 合成的默认值 |
| 24 kHz | 12 kHz | 我们现在的上行；也是 Azure 合成语音的输出率 |
| 44.1 kHz | 22 kHz | CD 音乐 |

24 降到 16，扔掉的只有 8 到 12 kHz 这一段。人说话的元音和音高在 1 kHz 以下，区分 s / f / sh / th
这些辅音的关键信息在 8 kHz 以内；8 kHz 以上基本只剩"空气感"和亮度，对音乐有用，对认字没用。

### 4.2 为什么 Voice Live 默认 24 kHz —— 这是协议继承，不是语音工程选择

`pcm16` 这个格式在 Realtime 协议里**定义上就是 24 kHz**：

- Azure .NET SDK：`InputAudioFormat.Pcm16` = "16-bit PCM audio format at **default sampling rate (24kHz)**"，
  `OutputAudioFormat.Pcm16` 同样。
- OpenAI 自己的文档把 `{"type":"audio/pcm","rate":24000}` 标为 default。
- GPT-Live 文档：音频输入和输出都是 24000 Hz 的无头单声道 PCM。

而 Voice Live 文档开篇就写"除特别说明外，Voice Live 使用与 Azure OpenAI Realtime API 相同的事件"。
它是这套协议的超集，默认值只能跟着协议走。会话回显里 `input_audio_format` 和 `output_audio_format`
是同一个 `pcm16` 枚举，把输入单独改成 16 kHz 会破坏对称，也会让从 Realtime 迁过来的客户端全部失效。

**对原生多模态模型，24 kHz 是对的。** Realtime 这一支（`gpt-realtime`、`gpt-4o-realtime`、`gpt-live`）
音频直接作为 token 进模型、直接作为 token 出模型，中间没有 STT 也没有 TTS：模型本身在 24 kHz 上训练；
输出方向确实需要 24 kHz（合成语音的自然度靠 12 kHz 以内的高频，16 kHz 输出明显发闷，微软技术答复里
有原话）；一套格式服务两个方向最简单。

### 4.3 但我们这套配置不属于那一支

| | 原生多模态（`gpt-realtime`） | 级联（我们，`gpt-5-mini`） |
|---|---|---|
| 输入路径 | 音频直接进模型 | 音频先过 **Azure 语音转文字** |
| 输出路径 | 模型直接生成音频 | 文本再过 Azure 语音合成 |
| 输入的原生采样率 | 24 kHz | **16 kHz** |

Voice Live 官方对 `gpt-5-mini` 的描述是 "audio input through Azure speech to text"，how-to 里也明确
"使用非多模态模型时 Azure 语音转文字自动生效"。所以我们的 24 kHz 上行走到 Azure 就被降到 16 kHz
送进识别器 —— **多传的那一段 Azure 自己丢掉了。**

反过来看，`input_audio_sampling_rate` 这个参数**存在**且**只接受 16000 和 24000**，本身就说明 Azure
清楚级联用户不需要 24 kHz，给了退出开关。默认值照顾协议兼容，开关留给知道自己在做什么的人。

### 4.4 降到 16 kHz 省多少、影响什么

| 采样率 | 原始 | 加 base64 | 实测含 JSON 封装 |
|---|---|---|---|
| 24 kHz | 384 kbps | 512 kbps | 540 到 680 kbps |
| 16 kHz | 256 kbps | 341 kbps | 约 360 到 450 kbps |

**不受影响的**：转写准确率（Azure 识别器本来就是 16 kHz 管线）；VAD 与断句；服务端降噪和回声消除
（16 kHz 是这些模块的标准工作率）；面试官的声音（下行另一条路，数字人模式下是 WebRTC 的 Opus 48 kHz）。

**本仓库没有任何其它功能消费候选人的原始音频**：打分走转写文本（`scoring_engine`），"我答完了"这类
口令是字符串匹配（`verbal_cue`），音频不落盘，没有发音评测，没有语调或情绪分析。所以唯一需要关心的
质量指标就是转写准确率。

顺带一个小好处：浏览器麦克风原生多为 48 kHz，直接重采样到 16 kHz 比先到 24 kHz 再由 Azure 降到
16 kHz 少一次重采样。

### 4.5 两边必须同时改（已实现 v0.40.0.0）

- 前端麦克风侧：`frontend/src/hooks/useVoiceAudio.ts` 导出的 `MIC_SAMPLE_RATE`（`getUserMedia` 约束和
  采集用 `AudioContext` 都用它）。真正起作用的是 `AudioContext` 那个 —— `getUserMedia` 的采样率约束
  是建议性的，`createMediaStreamSource` 会把音频重采样进 context 的速率。
- 后端会话侧：`Settings.voice_live_input_sampling_rate`（默认 16000）进入 `build_avatar_session` 的
  **顶层** `input_audio_sampling_rate`。注意 `get_settings()` 原来在 `if has_avatar:` 块内，这个字段对
  无 avatar 的 persona 也适用，所以调用被上提了（有回归测试守着）。
- **只改一边会让 Azure 按错误速率解释字节流**，声音变调变速，转写直接废掉，而且没有任何报错。
  因此后端把生效速率放进 `proxy.connected`（从**已构建的 session 读回**，不重新推导），前端与自己的
  `MIC_SAMPLE_RATE` 比对，不一致就 `console.error`。漂移在第一次连接就会暴露。
- **播放侧的 `PLAYBACK_SAMPLE_RATE = 24000` 不能动**，那是 Azure 下发 PCM 的速率，与麦克风无关。
- 这个参数和 avatar 码率一样，**会话中途不能改**，官方文档明确说明。
- 探针脚本 `backend/scripts/voice_turn_latency.py` 自建会话，已同步声明 16000；它的 WAV 断言也跟着
  改成 16 kHz，所以旧的 24 kHz 素材会被明确拒绝而不是静默出错。

**前提提醒**：如果将来把语音模型换成 `gpt-realtime` 这类原生音频模型，本节结论要重新评估 ——
那时输入降到 16 kHz 可能真的掉准确率。

**实测验证**：`frontend/e2e/scripts/mic-rate-ab.sh` + `frontend/e2e/mic-rate-transcript-ab.spec.ts`
用 macOS `say` 合成一句富含 s/sh/f/th 的句子（16 kHz 丢掉的正是这些辅音所在频段之上的部分），
经假麦克风送进真 Azure，分别在 16 kHz 与 24 kHz 会话下各跑一遍，比对与参考文本的词错误率。
**结果：16 kHz 与 24 kHz 的词错误率都是 0.0%，整句逐字一致** —— 降采样不付出识别代价。
完整数据见 `docs/avatar-weaknet-probe.md` §5.4。

### 4.6 顺带查实的两条 avatar 硬约束（实现期间踩到，2026-09-30）

这两条不属于采样率，但同属"Voice Live 到底能控制什么"，放在这里免得再踩：

1. **`session.avatar.connect` 每个会话只接受一次，且没有断开/重协商事件。** 客户端事件全集是
   `session.update`、`session.avatar.connect`、`input_audio_buffer.*`、`conversation.item.*`、
   `response.create/cancel` —— 没有任何 `session.avatar.disconnect`。在连接健康时再发一次 offer，
   Azure 回 `error: "WebRTC connection is in connected state"`。
   **推论**：想改 avatar 的任何协商参数（画面开关、编码方向），必须**重建整条 Voice Live 会话**。
   只有在旧连接已经坏掉（ICE failed/disconnected）时，重发 offer 才会被接受 —— 这正是现有媒体层
   自愈能工作的原因。
2. **Azure 对 avatar 会话创建有速率限制。** 约 20 秒内第三次请求被拒：
   `error: "Avatar request was rate-limited. Retry after 43.0s."`
   **推论**：任何"自动切换画面"的策略都必须自带冷却，否则一次抖动就会把候选人的语音会话打死
   （被拒的请求会走到重连耗尽，页面最终显示"语音不可用"并切文字）。当前实现的做法是不对称的：
   **关画面从不延迟**（它是救场的动作），**开画面有 60 秒冷却**，且手动按钮在冷却期内禁用。

---

## 附：这次事故的时间线（供复盘）

- 2026-09-14：external 模式发现 assistant item 读法在 gpt-4o 上产生 "Understood." / 编题；改为
  `response.instructions` 读法，gpt-4o 实测可靠。
- 2026-09-23：prod 语音模型切到 gpt-5-mini（region-native 限制），读法未重验。
- 2026-09-24：linear bank 也改为 MODEL 模式 + 同一读法（agent 指令劫持读题）。
- 2026-09-28：真实面试 Q4 被改写、Q7 被编造；根因 = 读题仍是模型推理 + 按 id 确认看不见偏差。
  修复 `pre_generated_assistant_message` + 转写比对 + live 断言（#123）；同日 judge 收敛为
  nudge-only + `probe_guard`（#124）；重连状态重置 + 麦克风释放（#125）；延迟探针改为按真实
  链路计时（#126）。

## 5. 传的那一层：三条音频通路，哪条能走 WebRTC，哪条不能（2026-10-01 实测）

> 起因是一个看起来简单的问题：纯音频能不能走 WebRTC。架构图把 SDK / WebSocket / WebRTC / SIP 并列为接口，
> 所以答案应该是"能"。实测确认能，但过程中有两条通路被混为一谈，而它们的行为完全相反。

### 5.1 三条通路，不是一条的开关

| 通路 | 端点 | 上行（麦克风） | 下行（回复） | 数字人 |
|---|---|---|---|---|
| **A. 我们在用的** | `/voice-live/realtime` + `session.avatar.connect` | WebSocket，base64 PCM | **WebRTC RTP**（数字人音视频同流） | 支持 |
| **B. 完全不配形象** | `/voice-live/realtime` | WebSocket，base64 PCM | **WebSocket**，`response.audio.delta` | 无 |
| **C. 原生 WebRTC** | `/voice-live/realtime/calls` | **WebRTC RTP** | **WebRTC RTP** | **不支持** |

关键是 A 和 C 不是同一条路的开关，而是两个入口。实测佐证：

- **B 根本不创建 WebRTC**：清空 persona 的形象后跑完整面试，浏览器构造 `RTCPeerConnection` **0 次**，
  `session.avatar.connect` 发送 0 次，WS 上收到 10 帧 `response.audio.delta`。所以"不开数字人"不会自动变成
  WebRTC——WebRTC 在这条链路里是**由数字人握手创建的**，不是由语音会话创建的。
- **A 可以只走音频**：在会话建立之前把画面钉成关，第一次 `session.avatar.connect` 就是纯音频的。实测
  PeerConnection 1 个、RTP 音频 5704 字节、RTP 视频 **0** 字节，逐轮约 1 秒。但它**仍然分配一个 avatar**，
  只是不推视频。
- **C 真的双向走 RTP**（见 5.2）。

### 5.2 原生 WebRTC（`/calls`）的实测矩阵

照官方文档的 standalone 示例实现（`frontend/e2e/native-webrtc-voice-live.spec.ts`），我们自己的区域资源，
无数字人，带假麦克风由服务端 VAD 驱动轮次：

| 模型 | voice 类型 | 结果 |
|---|---|---|
| `azure-realtime` | `azure-realtime-native`（ava） | **通**，下行 1212 B |
| `gpt-realtime` | `azure-standard`（en-US-AvaNeural） | **通**，下行 2802 B |
| `gpt-5-mini` | `azure-standard` | **通**，下行 2262 B |
| `gpt-realtime` | `azure-realtime-native` | 不通，Azure 报 `invalid_voice_type` |
| `azure-realtime` | `azure-standard` | 不通，Azure 报 `invalid_voice_type` |

建连开销：offer → SDP answer 511～1519 ms，answer → PC 连上稳定约 0.8 s。data channel 上回来的事件齐全：
`input_audio_buffer.speech_stopped`、`committed`、`conversation.item.created`、`response.created`、
`response.output_item.added`、`response.audio_transcript.delta`、`output_audio_buffer.started`。

**voice 类型与模型的配对是硬约束**，Azure 会直接告诉你允许哪些：

- `azure-realtime` → 只允许 `azure-realtime-native`
- `gpt-realtime` → 允许 `openai`、`azure-standard`、`azure-platform`、`azure-custom`、`custom`、
  `azure-personal`、`avatar-voice-sync`，**不允许** `azure-realtime-native`

### 5.3 数字人在场时，上行能不能也走 WebRTC？不能，而且是静默失败

通路 A 的 WebRTC 连接上，音频 transceiver 现在是 `recvonly`。把它改成 `sendrecv` 并挂上麦克风轨、
**同时关掉 WS 上行**，做对照实验：

| | 对照组（现状） | 实验组（麦克风走 RTP） |
|---|---|---|
| PC 上音频发送端 | 0 | 1 |
| 出向 RTP 音频 | 0 字节 | **156473 字节 / 2300 包** |
| 下行 RTP（数字人） | 53847 字节 | 63075 字节 |
| WS 上 `input_audio_buffer.append` | 5932 帧 | **0 帧** |
| 用户转写 | 正常 | **没有** |
| 错误 | 无 | **无** |

Azure **接受**了 `sendrecv` 的 offer，连接正常，数字人照样说话，我们真的发出去 156 KB 的 RTP 音频，
而**转写一个字都没有、也没有任何错误**。原因不是"不支持"这么笼统：数字人那条连接是**下行通道**
（TTS Avatar 的媒体投递），不是会话的输入路径，灌进去的音频不会被送进识别器。

所以"要数字人就得把上行留在 WebSocket"这个结论成立。它不是文档的转述，是两边都测过的。

> 限制：只测了最自然的实现（`addTrack` → 音频 `sendrecv`）。是否存在某个 session 字段能让 avatar 会话
> 从 RTP 收输入，没有穷举。

### 5.4 方法学：协商成功不等于会话可用

这一条值得单独记，因为今天同一形状踩了两次：

1. **voice 类型配错**：`rtc.call.error` 在控制 WS 上回来了，但 SDP answer 照样返回、PeerConnection 照样
   连上、我们的音频照样发出去，只是永远不会有回复。
2. **往数字人连接灌麦克风**：连错误都没有，156 KB 发出去，静默丢弃。

两次都容易把"协商通了"读成"链路通了"。**判据必须是业务信号**——转写出现、`response.created` 到达、
下行 RTP 字节增长——而不是 `connectionState === "connected"`。

还有一条与此同形的坑：**判断"有没有声音"不能用累积计数器**。`totalSamplesReceived` 在静音期照涨；
`totalAudioEnergy` 的"有增长"在冷会话可用、温会话失效（上一句话垫高了累积值）。可用的是瞬时
`audioLevel` 跨底噪：静音期 0.0000～0.0010，声音一到跳到 0.09～0.47。

### 5.5 这些探针在哪

| 探针 | 测什么 |
|---|---|
| `frontend/e2e/native-webrtc-voice-live.spec.ts` | 通路 C，照官方示例；带模型/voice 矩阵开关 |
| `frontend/e2e/audio-only-webrtc-live.spec.ts` | 通路 A 的纯音频形态，从第一次握手就不要画面 |
| `frontend/e2e/avatar-speak-start-live.spec.ts` | 通路 A：Azure 确认读题 → 真正听见（amira 806 ms、lisa 988 ms） |
| `frontend/e2e/turn-latency-live.spec.ts` + `scripts/turn-latency.sh` | 通路 A 的逐轮延迟，带画面 vs 关画面 |

一句话总结：**Voice Live 里的模型是会话的宿主，不是面试官的脑子。脑子在后端，嘴用 TTS，
说什么字由 prompt 管、怎么发声由 `session.voice` 管——而且每一条"以为在控制"的路径，都要抓 WS 帧
证明它真的接上了。**
