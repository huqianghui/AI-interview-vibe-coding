# Voice Live 的"模型支持"与"自带模型"并不矛盾：两条不同的接入路径

> 2026-10-05。起因是一个反复出现的困惑：Voice Live 一边报错 **"Model X is not supported in
> this region"**，一边又在文档里宣传 **"Bring Your Own Model（自带模型）"**。这看起来自相矛盾——
> 既然能自带模型，为什么又说某个模型在某个 region 不支持？
>
> 结论先行：**这两句话描述的是两条不同的接入路径，不是同一件事。**
>
> - "not supported in this region" 来自 **原生/内置模型路径**（`?model=<name>`）：这类模型由
>   Azure 预部署、全托管，列表是 **按 region 开通的**，你点不到的就报这个错。
> - "Bring Your Own Model" 是 **BYOM 路径**（`?profile=<byom-...>&model=<你的 deployment>`）：
>   模型是 **你自己在 Foundry 资源里部署的**，接入时不走那张 region 预部署清单。
>
> 本文用三步给出证据：**查文档 → 写测试脚本 → 跑真实连接得结论**。脚本在
> `backend/scripts/voice_live_model_probe.py`，证据数据在本文 §4。
>
> 配套阅读：[`docs/voice-live-control-notes.md`](./voice-live-control-notes.md) §2 已经讲过
> "`model=` 是宿主不是大脑、你自己的 deployment 名不算数"——本文是它的 BYOM 补篇。

---

## 1. 一个 Voice Live 会话的"大脑"有三种接法

Voice Live 是一条单 WebSocket 的语音到语音流水线（听 / 想 / 说 / avatar / 记忆）。其中"想"
这一步——给会话挂上一个"大脑"——有且只有三种方式，**它们是三个不同的连接参数，不能混用**：

| 路径 | 连接参数 | 模型从哪来 | 谁管容量/部署 |
| --- | --- | --- | --- |
| **① 原生 / 内置** | `model=<name>` | Azure 预部署、全托管 | Azure（无需你部署、无需容量规划、无需 PTU） |
| **② BYOM（自带模型）** | `model=<你的 deployment> ＋ query={"profile": "byom-..."}` | **你自己**在 Foundry 资源里部署 | 你（部署、配额、内容过滤都归你） |
| **③ Agent（自带智能体）** | `agent_name / agent_version / project_name` | 你托管的 Foundry Agent | 你 |

SDK（`azure-ai-voicelive`）把这三条路径表达得很干净，`connect()` 的签名里同时有 `model`、
`query`、`foundry_resource_override`、`agent_name/agent_version/project_name`。本仓库的
`backend/app/services/voice_live_proxy.py` 走的是 ① 和 ③：agent 模式填
`agent_name/agent_version/project_name`，否则填 `model=default_model`。

> **"not supported in this region" 这句错误，只会从路径 ① 抛出。** 它的含义不是"这个模型不存在"，
> 而是"这个模型没有在当前 region 预部署到内置清单里"。想用它，就改走路径 ②（BYOM）自己部署。

---

## 2. 子问题一：内置（原生预部署）模型支持哪些？

来自 Microsoft Learn [Voice Live overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live)
的"Supported models and regions"清单（2026-10-05 抓取）。文中原话：

> *All natively supported models are fully managed, so you don't need to deploy models, worry
> about capacity planning, or provision throughput.*

原生预部署清单：

```
gpt-realtime-2.1   gpt-realtime-2.1-datazone   gpt-realtime-2.1-mini
gpt-realtime-1.5   gpt-realtime-1.5-datazone
gpt-realtime       gpt-realtime-datazone       gpt-realtime-mini
gpt-4o   gpt-4o-mini
gpt-4.1  gpt-4.1-mini  gpt-4.1-nano
gpt-5.6-terra  gpt-5.6-luna
gpt-5.4  gpt-5.2  gpt-5.1  gpt-5  gpt-5-mini  gpt-5-nano
phi4-mm-realtime
azure-realtime  azure-realtime-native
```

**关键：这张清单是全局"支持"清单，不等于某个 region 当下真的开通了。** 文档紧跟一条 Note：

> *Models `gpt-5.5`, `gpt-5.4-mini` and `gpt-5.4-nano` are supported and tested with Voice Live
> but **aren't pre-deployed**. To use them, deploy them in your Foundry resource and connect via
> Bring Your Own Model (BYOM).*

也就是说，官方自己点名了三个"**支持但未预部署**"的模型——它们恰恰是要走 BYOM 的。这正是"又支持
又说不支持"困惑的来源：**同一个模型，在原生路径下报 region 不支持，在 BYOM 路径下却是官方推荐接法。**

---

## 3. 子问题二：用自己创建的 deployment 会怎样？以及 Agent 怎么接？

两种结果，取决于你走哪条路径：

### 3.1 把自己的 deployment 名塞进 `model=`（原生路径）→ 失败

内置路径的 `model=` 只认那张 region 预部署清单上的名字。你自己起的 deployment 名（哪怕底层就是
`gpt-4o`）不在清单里，于是服务回 `invalid_model` + "not supported in this region"。这与
[`voice-live-control-notes.md`](./voice-live-control-notes.md) §2、记忆
`ai-interview-voice-model-not-chat-model` 的结论一致。

### 3.2 走 BYOM（`profile` + 你的 deployment 名）→ 成功

来自 Microsoft Learn
[Bring Your Own Model (BYOM) with Voice Live API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-bring-your-own-model)。
BYOM 适用于：**微调模型、任何未被 Voice Live 预部署的 Foundry 模型（Anthropic Claude、Grok、
Fireworks 自定义权重、model router）、PTU 预留吞吐部署、自定义内容安全**。

**`profile` 到底是什么？** 它不是"配置档案"，而是官方说的 **BYOM 集成模式（BYOM integration
mode）**——告诉 Voice Live "用哪一套上游 API 协议去驱动你那个自带模型"。你的 deployment 对外暴露的
接口类型不同（realtime WebSocket / chat-completion / Anthropic Messages），Voice Live 必须知道该用
哪套协议去调它。更关键的是：**这个选择直接决定音频走"直通"还是"级联"**（Microsoft Community Hub
原话：*"The BYOM connection profile determines whether Voice Live sends the turn to a speech-native
realtime deployment or uses a cascade through a chat or partner model."*）。

| profile | 你的模型是哪类接口 | 音频路径 | 用途 / 例子 |
| --- | --- | --- | --- |
| `byom-azure-openai-realtime` | realtime 语音原生模型 | **Speech-native 直通**：音频基本直接进出你的模型，延迟最低；Voice Live 主要做转接 + avatar/语音增强 | 自建 `gpt-realtime`、`gpt-realtime-mini` |
| `byom-azure-openai-chat-completion` | chat-completion 文本模型（也涵盖其他 Foundry 模型） | **Cascaded 级联**：听（STT）和说（TTS）仍由 Voice Live 做，只有"想"换成你的模型 | `gpt-5.4`、`grok-4`、你的 chat deployment |
| `byom-foundry-anthropic-messages`（preview） | Foundry 上的 Claude，走 Messages API | **Cascaded 级联**（同上，协议换成 Anthropic Messages） | `claude-sonnet-4.6`、`claude-haiku-4.5` |

> **直通 vs 级联，是 BYOM 这代最该记住的区别。** realtime 那条：你的模型自己就是"耳朵+脑子+嘴"的语音
> 原生模型，Voice Live 基本只做转接 + avatar/语音增强。另两条是级联：Voice Live 保留"耳朵（STT）+ 嘴
> （TTS）+ avatar"，你的模型只接管"脑子（想）"这一步——所以文本大模型（Claude / Grok / gpt-5.x /
> 你自己微调的）都能当大脑接进来，代价是多一层 STT/TTS 拼接的延迟。

连接形态（SDK 原样）：

```python
# ② BYOM：model= 变成"你的 deployment 名"，profile 作为 query 参数带上
async with connect(
    endpoint=endpoint,
    credential=credential,
    model="your-claude-deployment-name",      # 你在 Foundry 里起的名字
    query={"profile": "byom-foundry-anthropic-messages"},
) as connection:
    ...
```

对应的 WebSocket query string：

```
?api-version=2026-04-10&profile=byom-foundry-anthropic-messages&model=<your-deployment>
```

两条硬约束（文档明确）：

1. **必须是 Microsoft Foundry 资源**。默认只能接 **同一个 Foundry 资源** 里部署的模型；要跨资源，
   加 `foundry-resource-override`（例如 Foundry endpoint 是
   `https://my-foundry-resource.services.ai.azure.com`，就传 `my-foundry-resource`）。普通的
   Azure Speech 资源不支持 BYOM。
2. **Entra ID 鉴权下的权限**。在 `byom-azure-openai-chat-completion` /
   `byom-foundry-anthropic-messages` 模式下，Foundry 资源的 system-assigned managed identity
   需要有访问对应模型 deployment 的权限（长会话里 token 会过期，靠 MI 续）。

### 3.2.1 profile 到底在配哪一层？三个最常被追问的点

> 2026-10-05 补记。下面三问是把 §3.2 的 `profile` 彻底讲透——它作用在哪一层、为什么不能
> 从 deployment/model 名推断、以及"能不能用一个 Responses API 统一掉"。

**追问一：profile 作用在"听 / 想 / 说"的哪一层？**

作用在**"想"这一步**，而且它配的不是"想得好不好"，是 **Voice Live 用哪一套上游 API 协议，把这一步的
请求发给你的 deployment**。它不直接去配"听（STT）"或"说（TTS）"。但协议一旦选定，听/说走**直通还是
级联**也随之确定（见 §3.2 表）：realtime 协议 → 音频直通你的模型；chat-completion / anthropic 协议
→ Voice Live 保留 STT/TTS，只把"想"以**文本**形式交出去。一句话：**profile = 想这一步的协议；协议
定了，音频路径也就定了。**

**追问二：deployment 名和 model 不就能知道协议吗，为什么还要显式传 profile？**

不能，四个原因：

1. **deployment 名是你自己起的任意字符串**（如 `my-model-1`），字符串本身不带协议/类型信息。要推断，
   Voice Live 得反过来查 Foundry 管理 API 去解析它背后是什么模型、什么能力——多一层跨服务调用、权限、
   延迟。
2. **即便解析出背后的模型，realtime vs chat 仍有歧义**：走直通（realtime）还是级联（chat）是你**主动
   选**的架构决定，不是模型的固有属性，名字层面决定不了。
3. **跨厂商协议是硬差异**：Claude 走 Anthropic Messages，不是 OpenAI 的任何 API，名字无法替 Voice Live
   选对 client 栈。
4. 所以 Microsoft 的设计是**让调用方显式声明集成模式**，而不是去猜。文档原话：*"The BYOM connection
   profile determines whether Voice Live sends the turn to a speech-native realtime deployment or uses a
   cascade through a chat or partner model."*

**追问三：不能用一个 Responses API 把这三条统一掉吗？**

结论先行：**不能统一全部，但 OpenAI 文本那一条确实在往 Responses 收敛。**

Chat Completions / Responses API / Anthropic Messages 本来就是**三个不同团队设计的三份不同 wire
contract**（2026 业界多篇对比逐字确认）：

| | Chat Completions | Responses API | Messages API |
| --- | --- | --- | --- |
| 厂商 | OpenAI | OpenAI | **Anthropic** |
| endpoint | `POST /v1/chat/completions` | `POST /v1/responses` | `POST /v1/messages` |
| 设计目标 | 无状态文本 | agent 化 + 内建工具 + 状态管理 | Claude 原生（扩展思考 / prompt 缓存）|

单一 Responses API 顶不下全部三条，有**两个彼此独立**的原因：

1. **音频传输层不同**：realtime"直通"要的是一条 **双向流式音频 WebSocket**（即 Realtime API，
   voice-to-voice sub-300ms、带打断）。Responses API 是 request/response——即便用 SSE 流式，也只是
   "流式返回一个 response"，**不是双向音频会话**，拿不到 speech-native 直通。所以 realtime 这条是被
   **传输物理**隔开的，不是 API 设计偏好的问题。
2. **厂商边界**：Responses 是 OpenAI 家的契约，**寻址不到 Anthropic Claude**；Claude 在 Foundry 上走
   Anthropic Messages API。佐证：连 OpenAI 兼容 SDK 去调 Claude，都会把 **audio input 直接丢弃**——两套
   API 根本对不上。

**能收敛的部分**：`byom-azure-openai-chat-completion` 这一条是 OpenAI 文本家族，而 Responses API 正是
Chat Completions 的后继演进，未来这条 profile 有可能迁到 Responses 之上。但它**仍吞不下** realtime
（传输不同）和 anthropic（厂商不同）。所以 **`profile` 这个开关短期不会消失**：它选的正是这三条物理上
不同的集成模式。

> 旁注：OpenAI 另推的 "Open Responses" 想做跨模型统一，但那是**开源模型生态**（Hugging Face / Ollama /
> vLLM 等）的方向，不是 Azure Foundry BYOM 当前的接法；Foundry 上的 Claude 依旧是 Anthropic Messages。


### 3.3 Agent 模式（路径③）：参数、流程，以及它和 BYOM 的区别

> 顺着上面的问题——"realtime BYOM 是'你的模型自己当耳朵+脑子+嘴'，那 agent 配 realtime 又是什么
> 流程？"——先厘清一个概念差：**agent 不是一个模型，而是一个编排层**（自带指令、工具 tools、知识库
> KB/RAG，背后再挂一个模型）。所以 agent 模式和 BYOM-realtime 的"近乎直通"不是一回事。

**连接参数**（`connect()` 不传 `model=`，改传 agent 三件套；本仓库 `voice_live_proxy.py:448-451`）：

| 参数（SDK kwarg）| 必填 | 含义 |
| --- | --- | --- |
| `agent_name` | ✅ | Foundry agent 名（本仓库把 `agent_id` 按 `"name:version"` 拆，前半段作 name）|
| `project_name` | ✅ | 承载该 agent 的 Foundry **project** 名（= project endpoint 最后一段）|
| `agent_version` | 可选 | agent 版本（取自 `persona.agent_version`）|
| `foundry_resource_override` | 可选 | 跨资源时，承载 agent 的 Foundry 资源名 |
| `conversation_id` | 可选 | 复用/重连到已有会话 |
| `client_id` / `description` | 可选 | 关联 client id / 覆盖 agent 工具描述 |

> 命名有漂移：WS query 在 api-version `2026-04-10` 写作 `agent-name` / `agent-project-name`，社区
> 早期示例又有 `agent_id` / `project_id`——**以 SDK kwarg 为准**（`agent_name`/`agent_version`/
> `project_name`），SDK 按目标 api-version 映射。session.update 里引用 agent 的对象 `type` 固定为
> `"foundry_agent"`。

```python
# ③ Agent：不传 model=，大脑+编排都在 agent 侧
async with connect(
    endpoint=endpoint, credential=credential, api_version=api_version,
    agent_name="my-interviewer-agent",
    agent_version="3",                       # 可选
    project_name="my-foundry-project",
    foundry_resource_override="my-foundry",  # 仅跨资源时
    connection_options={"vendor_options": {"ssl": ssl_ctx}},
) as conn:
    ...
```

**"agent 配 realtime"的流程**——注意 **agent 路径上没有 `profile` 这回事**（profile 是 BYOM 专属）。
agent 的"大脑"（底层模型 / 指令 / 工具 / KB）是**在 Foundry 侧的 agent 上配好的**，不在 Voice Live
的 connect 参数里选：

- **架构上 agent 模式本质是级联**（对应 Microsoft 的 "Voice Live + prompt agent" 模式）：
  说话 → Voice Live 做 **STT（耳朵）** → agent 跑 **模型 + 工具 + KB 检索（脑子+编排，内部可能多步）**
  → 文本 → Voice Live 做 **TTS（嘴）+ avatar visemes** → 候选人听到。Voice Live 保留整条语音层。
- **"realtime" 在 agent 语境下**指：agent 背后挂的那个模型 deployment 要是**支持 realtime 语音交互
  的模型**（如 `gpt-realtime`），否则连接可能静默关闭（社区 Q&A 实测）。但这块是**在 agent 上配**的，
  connect 只负责"指到哪个 agent"。
- 所以 BYOM-realtime 的"音频近乎直通模型"特性，agent 模式**拿不到**：agent 要做 tool-calling + RAG，
  天然要走 STT→文本→编排→文本→TTS 这一圈。

**本仓库实证（2026-10-05，本地 DB）：两种模式都在用。**

| persona | agent_id | 跑哪条路径 | 为什么 |
| --- | --- | --- | --- |
| `Interviewer`（数字人 amira，已 synced v233）| 有 | **③ Agent** | 有 agent_id 且不是 mouth → `is_agent=True` |
| `E2E Live External …`（外部大脑）| 有（也 synced）| **① Model** | 是 MOUTH persona → 即使带 agent_id 也强制 model |
| 全新未同步 persona | 无 | **① Model** | 没 agent_id → `model=default_model` |

> MOUTH persona（外部 persona + linear-turns 题库）即使同步出了 agent_id 也强制走 model 模式：挂一个
> 会自己即兴发问的 agent 会变成"第二个大脑"，让逐字朗读跑偏（`voice_live_proxy.py` v0.37.1.9 /
> v0.38.3.1 注释）。

**再往下一层：运行期的真实调用链。** 上表讲"哪个 persona 走哪条连接路径"；下表讲一次候选人面试里，
WebSocket 上**到底有没有"大脑"在推理、每句话是谁产出的**——这才是"model / agent 实际被不被调用"的答案
（全部对应 `voice_live_proxy.py` 的 `is_mouth_persona` / `linear_turns_for_persona`，以及 `api/interview.py`
的 judge 路由）：

| 面试链路 | WS 模式 | WS 上有大脑在推理？ | 每句话从哪来 | 用到 Foundry agent？ |
| --- | --- | --- | --- | --- |
| external（默认）| MODEL（mouth）| ❌ `create_response=False` | 外部 API 产题 → `pre_generated_assistant_message`（服务端 TTS 逐字念，无模型推理）| ❌ 即使同步了也强制摘掉 |
| bank linear（默认）| MODEL（mouth）| ❌ | 题库文本 → `pre_generated_assistant_message` | ❌ |
| bank judged | MODEL（mouth）| ❌ | 题库文本逐字念；候选人停顿时的 nudge 来自 **WS 之外** 的 judge LLM（`POST /{id}/judge` → `get_llm_adapter`，与 scoring 共用一条链，默认 gpt-5-mini），文本回传后仍交给 mouth 逐字念 | ❌ |
| 编辑器 Playground（pin `persona_id` 且 agent 已 synced）| **AGENT** | ✅ agent 推理 | agent 自由对话（用来测 agent 指令）| ✅ **唯一真正挂 agent 的地方** |

> **三个最反直觉、也最容易记错的点：**
> 1. **候选人面试里 Voice Live 几乎永远是"一张嘴"。** `is_agent = bool(agent_id) and not is_mouth`
>    （`voice_live_proxy.py:435`），而三条默认链路 `is_mouth` 恒为真，所以 agent 被**显式摘掉**——即使
>    persona 同步出了 agent_id 也不接。换句话说："一直用到 agent"是反的：默认根本不接 agent。
> 2. **judged 用的那个"model"既不是 Voice Live 的 `model=`，也不是 agent**，而是第三条独立链：
>    off-WebSocket 的 chat-completion judge（和打分 scoring 共用 `get_llm_adapter`）。judge
>    "从不写一个 interviewer 回合"，只回 `wait | nudge`；nudge 文本再回交给 mouth 逐字念。
> 3. **`bank_turn_mode="model"` 这条路径已经不存在了。** `BANK_TURN_MODES = ("linear", "judged")`
>    （`persona.py:143`），`"model"` 值在 **v0.39.0.0 退役**，迁移把库里的 `"model"` 改写成 `linear`，
>    且 `persona.linear_turns_for()` 直接 `return True`。所以**没有任何候选人面试业务会在语音 WS 上挂
>    agent**。agent 唯一的用武之地是**编辑器 Playground**：WS query 带 pinned `persona_id` →
>    `playground=True`（`voice_live_ws.py:187`）→ 对一个 synced 的 bank persona 保留模型回合，用来跟
>    agent 自由对话、测它的指令；候选人面试页不 pin persona_id，所以永远是 mouth。

### 3.4 admin 里配的 agent / model / prompt / avatar / VAD，分别落在哪一层？

最容易混淆的点：**这些参数不是平级的"一堆 session config"，它们分属三层，生效时机也不同**（全部来自
代码实证 `build_avatar_session` 与连接装配）：

| admin 字段 | 层 | 怎么用、何时生效 | 哪种模式 |
| --- | --- | --- | --- |
| **agent**（`agent_id`/`agent_version`）| 连接选择 | 由"同步到 Foundry"动作生成（**不是手填**），决定走 agent 还是 model | — |
| **model** | 大脑 | 仅 model 模式作 `model=`；**agent 模式根本不传**（大脑是 agent 自带的）| 仅 ① |
| **prompt**（`prompt_fragment`）| 大脑的指令 | **从不作为 `session.instructions` 传**（Azure 拒绝覆盖 instructions）。agent 模式：同步时写进 Foundry agent（在 Azure 侧，不随连接传）；mouth/model 模式：作为**会话系统消息**在 `session.update` 后注入 | 两种，但走法不同 |
| **avatar**（character/style/bg）| 语音层 | 每次连接经 `session.update` 的 `avatar` 装配 | ① ③ 都生效 |
| **VAD**（turn_detection/eou）| 语音层 | 每次连接经 `session.update` 的 `turn_detection` 装配 | ① ③ 都生效 |
| **voice**（音色/temperature/rate/language）| 语音层 | 每次连接经 `session.update` 的 `voice` / 转写 / 采样率装配 | ① ③ 都生效 |

> 一句话：**avatar / VAD / voice / 语言 是"语音层"配置，确实每次连接当 session config 用，两种模式
> 都吃**；而 **model 和 prompt 是"大脑层"**——model 只在 model 模式当连接参数，prompt 从不走
> `session.instructions`（agent 模式它住在 Foundry agent 里，model 模式它当会话系统消息注入）。
> 代码佐证：`build_avatar_session` 的 `session_kwargs` 里根本没有 `instructions` 这个键。

---

## 4. 证据：真实连接探测（swedencentral，2026-10-05）

脚本 `backend/scripts/voice_live_model_probe.py` 直接连真实 Azure Voice Live（遵循本仓库"永远用
真实连接、不做 mock"的规矩，记忆 `ai-interview-always-real-connection`），逐个候选模型在
**原生 MODEL 模式** 下建连、发一个最小 `session.update`，按服务器第一条事件分类：

- `session.updated` → **ACCEPTED**
- `error` 含 "not supported in this region" → **REJECTED_REGION**

凭证走和线上一致的 overlay 链路：DB master 行（解密 key）→ settings，env 兜底。

运行（在 `backend/` 下）：

```bash
.venv/bin/python scripts/voice_live_model_probe.py --timeout 15 --out /tmp/voice-live-model-probe.json
```

### 4.1 结果

- **endpoint**：`<your-resource>.services.ai.azure.com`（region = **swedencentral**）
- **api-version**：`2026-01-01-preview`　**鉴权**：Microsoft Entra

**ACCEPTED（20 个原生模型）：**

```
gpt-realtime-2.1  gpt-realtime-2.1-mini  gpt-realtime-1.5  gpt-realtime  gpt-realtime-mini
gpt-4o  gpt-4o-mini  gpt-4.1  gpt-4.1-mini  gpt-4.1-nano
gpt-5.6-terra  gpt-5.6-luna  gpt-5.4  gpt-5.2  gpt-5.1  gpt-5  gpt-5-mini  gpt-5-nano
phi4-mm-realtime  azure-realtime
```

**REJECTED_REGION（3 个）：** `gpt-5.5`、`gpt-5.4-mini`、`gpt-5.4-nano`

服务器原始报文（逐字）：

```json
{"message": "Model gpt-5.4-mini is not supported in this region.",
 "type": "invalid_request_error", "code": "invalid_model", "param": null}
```

### 4.1b gpt-5.6 一代确认 + gpt-6 / gpt-6.1 一代（专项复测）

针对"`gpt-5.6-terra` / `gpt-5.6-luna` 都能用了吗？gpt-6 / gpt-6.1 系列呢？"单独跑了一次原生探测
（同资源 swedencentral、api-version `2026-01-01-preview`、Entra、DB-master）：

- **gpt-5.6 一代：两个都 ACCEPTED** —— `gpt-5.6-terra`、`gpt-5.6-luna`。
- **gpt-6 一代：全部 REJECTED_REGION（12/12）** —— `gpt-6`、`gpt-6-mini`、`gpt-6-nano`、`gpt-6-luna`、
  `gpt-6-sol`、`gpt-6-terra`、`gpt-6-astra`、`gpt-6.1`、`gpt-6.1-mini`、`gpt-6.1-nano`、
  `gpt-6.1-luna`、`gpt-6.1-terra`，报的都是同一个 `invalid_model` + "not supported in this region"。

> **`invalid_model` 这个 code 是有歧义的**：它既可能是"模型名存在、只是当前 region 没预部署"，也可能
> 是"压根没这个模型名"。原生探测无法区分这两者——所以 gpt-6/6.1 全拒，**不代表这些名字一定存在**，
> 只能确定"在本 region 的原生清单里都点不到"。要真用，走路径 ②（BYOM，自己在 Foundry 部署）或等
> region rollout；能不能部署还得看该模型在 Foundry 里是否真的放出来了。

### 4.2 这组数据为什么是决定性的

**被原生路径拒绝的那三个模型（`gpt-5.5`、`gpt-5.4-mini`、`gpt-5.4-nano`），正好就是 Microsoft
文档点名"支持但未预部署、请走 BYOM"的那三个。** 一字不差。这把"测量到的行为"和"文档写的行为"扣在
了一起：

> 同一个 `gpt-5.4-mini`——原生路径回你 "not supported in this region"，文档却告诉你"它受支持，
> 用 BYOM 部署接入"。**不是矛盾，是两扇门。**

### 4.3 清单是会动的（docs 领先于 rollout）

对比本资源 2026-09-23 的历史探测（记忆 `ai-interview-voice-model-not-chat-model`）：那次
`gpt-5.6-luna` 还是 **REJECTED**，本次（2026-10-05）已 **ACCEPTED**。说明：

- region 预部署清单 **随时间推进**，文档常常领先于某个 region 的实际 rollout；
- 所以"某模型能不能用"**不能只查文档**，要对目标资源 **实测**——这正是这个探测脚本存在的理由。

---

## 5. 一句话决策树

```
想给 Voice Live 换"大脑"？
├─ 模型在该 region 的原生预部署清单里（§2 的 20 个之一）
│    → 直接 model=<name>，Azure 全托管，零部署成本。             ← 路径 ①
├─ 模型"受支持但未预部署"（gpt-5.5 / gpt-5.4-mini / gpt-5.4-nano），
│  或是 Claude / Grok / 微调 / PTU / 自定义内容安全
│    → 在自己的 Foundry 资源里部署，profile=byom-...，            ← 路径 ②（BYOM）
│      model=<你的 deployment>，必要时加 foundry-resource-override。
└─ 想让一个已托管的 Foundry Agent 来驱动
     → agent_name / agent_version / project_name。                ← 路径 ③
```

**本项目现状**：外部/MODEL 模式走路径 ①，默认 `gpt-5-mini`（§4 实测 ACCEPTED）；数字人 agent 走
路径 ③。尚未使用 BYOM——若将来要接 Claude 之类非预部署模型，按 §3.2 走路径 ②。

---

## 附：复现与注意事项

- 脚本：`backend/scripts/voice_live_model_probe.py`。支持 `--models a,b,c` 自定清单、
  `--byom-profile/--byom-model` 测 BYOM、`--out` 落 JSON。
- BYOM 实测需要你 **先在 Foundry 资源里真实部署** 一个模型，再把 deployment 名传给 `--byom-model`；
  本仓库当前没有 BYOM deployment，故 §4 只覆盖原生路径的 20 vs 3。
- 本文刻意不写出真实资源名/密钥（记忆 `ai-interview-live-azure-testing`）；endpoint 以
  `<your-resource>` 占位，region 与 api-version 为真实值。
- 探测清单随 Azure rollout 变化，`gpt-5.6-*` 一代尤其易变——**以对目标资源的实测为准**。
