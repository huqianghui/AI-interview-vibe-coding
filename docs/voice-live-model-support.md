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


### 3.5 judge 已经用了一个模型，为什么不把它接到 `create_response`？

> 2026-10-05 补记。顺着 §3.3 的"judge 是第三条独立链"再追一问：既然 judged 模式里**确实调了一个
> 真模型**（`LLMAdapter`，默认 gpt-5-mini，和打分共用 `get_llm_adapter`），为什么不干脆把它当成
> Voice Live `create_response` 的那个大脑，而要留在 WebSocket 之外？因为 **judge 和 `create_response`
> 干的是两个不同的活，本产品是刻意把"判断"和"开口"拆开的。**

**先厘清一个常见误解：judge 用到的那个"model"，不是 Voice Live 的 `model=`。** 面试会话仍是 mouth
（`create_response=False`，§3.3），WS 上的 `model=` 只是不推理的宿主；judge 是 **WS 之外**一条独立的
chat-completion 调用（`POST /{id}/judge` → `app.interview.judge.run_judge`）。所以"judge 用了模型"和
"把模型接进 `create_response`"从来不是同一个开关。

**judge 的模型产出的是"判决"，不是"台词"：**

- 输出只有一个 verdict —— **`wait | nudge`，NOTHING ELSE**（`api/interview.py:140`）。`follow_up` /
  `redirect` 已于 2026-09-28 退役，模型若仍吐一个按 `wait` 处理。
- 它是 **"a pacing aid, not a prober"**（`interview/judge.py` 开头）：**从不写一个 interviewer 回合、
  从不追问、从不 redirect**（`api/interview.py:145` 原话 "the judge never writes a turn"）。
- 候选人的话对它是 **DATA（delimited），不是指令**；任何失败（超时 / 坏 JSON / 不合法 verdict）
  → **`wait`（沉默）**，绝不模板兜底。
- 即使判成 nudge，**那句 nudge 文本仍交回给"嘴"用 `pre_generated_assistant_message` 逐字念**
  （见 `voice-live-control-notes.md` 的链路图："题目和 nudge 都是" pre_generated TTS）。模型**从没拿到
  麦克风**。

**`create_response=True` 产出的是"台词"，而且它是个管不住的单开关：**

| | judge 的模型 | `create_response` 的模型 |
| --- | --- | --- |
| 回答什么 | "候选人说完了吗 / 要不要催" | "面试官这一轮说什么" |
| 产出形态 | 结构化判决 `wait \| nudge` | 自由语音 turn |
| 能否"只判决、绝不编题" | 能（结构化契约 + 超时 + leak_guard + prefetch） | **不能**（单布尔，一开全开） |
| 题目来源 | 题库逐字（嘴念） | **模型自己编** |
| 在哪 | WS 之外，和打分共用 `get_llm_adapter` | WS 上 |

挡着你把 judge 塞进 `create_response` 的，是三道各自独立的墙：

1. **一个是裁判，一个是嘴——题从哪来变了。** 面试官要说的**题目永远来自题库逐字**（SOP 引用、与打分
   rubric 对齐、可审计）。一旦 `create_response=True`，模型开始**自己编题**，这正是题库设计明令禁止
   的，也是 mouth 存在的全部理由（"Thank you." 漂移、卡片与口播不一致，记忆
   `ai-interview-external-filler-root-cause`）。
2. **`create_response` 是一个布尔，"只判决、绝不即兴"表达不出来。** `voice_live_proxy.py:273` 的历史
   注释写死：`create_response` 是**单个布尔**，"acknowledge turn"与"follow-up turn"**是同一个 turn**，
   "acknowledge but never follow up" **unreachable**。打开它就同时拿到"确认 + 追问 + 即兴"，**没法只
   要 nudge**。off-WS 的 judge 能表达这个窄合同，**正因为它返回结构化判决、不是自由语音**——这也正是
   当初把它挪到 WS 之外的原因（2026-09-24：WS 上的模型每次停顿都说 "Thank you."，于是 v0.39.0.0 退役
   了 in-interview 的模型回合）。
3. **judge 需要的那套，一条 WS 语音 turn 全给不了。** ordered 契约 + 逐项引用检查 + `leak_guard` +
   JSON 解析 + 10s 超时 + 失败转 `wait` + prefetch/apply —— WS 的语音 turn 是自由音频，你拿不到结构化
   判决、跑不了引用检查、也绑不住它。

> **一句话：judge "用了模型" 和 `create_response` "用模型" 不是同一个杠杆，不能互相替换。** judge 用
> 模型来**判决**并返回一个决定，然后把开口权交回给**那张逐字念题的嘴**；`create_response` 是让模型
> **自己当面试官开口**。本产品刻意把"判断"（模型，WS 外，结构化）与"开口"（TTS，逐字，可审计）拆开
> —— **把 judge 接到 `create_response` = 让模型自己编面试 = 就是范围 B，要动架构**，并撞上题库逐字 /
> 打分对齐 / 单布尔管不住这三道墙。所以这不是"能复用却没复用"，而是这两个活天生要分开。

### 3.6 这些模型分别是"配置的"还是"写死的"？四条解析链

> 2026-10-05 补记。接着问："judge 用的 model 是 admin 配的还是写死的？打分呢？agent 里面呢？"
> 结论：**全部来自配置，写死的只有兜底默认值 `gpt-5-mini`**。但它们是**四条不同的解析链**，
> 生效时机也不同——而且 admin 里那**一个** model 字段同时喂了其中三条，这正是客户 region 报错的根因。

| 用到模型的地方 | 解析链（左优先）| 何时生效 | 代码 |
| --- | --- | --- | --- |
| **judge**（judged 模式的 wait/nudge）| master `model_or_deployment` → env `FOUNDRY_AGENT_MODEL` → `gpt-5-mini` | adapter **注册时**钉死；admin 保存后 `refresh_azure_adapters()` 重建，**不用重启** | `judge.py:376` → `registry.py:103/83` → `config_overlay.py:49` |
| **评估 / 打分**（含 checklist 起草、SOP 覆盖）| **同上，同一条链、同一个 adapter 实例** | 同上 | `scoring_service.py:299`、`checklist_service.py:123`、`sop_coverage.py:111` |
| **Foundry agent 的底层模型** | `persona.model` → 上面那条链 | **"同步到 Foundry"时**写进 agent，**不在连接时传** | `azure_agent_sync.py:127` |
| **Voice Live `model=`**（路径①）| `persona.model` → master `model_or_deployment` → env `VOICE_LIVE_DEFAULT_MODEL` | **每次建连**时读 DB，改了下一场面试即生效 | `voice_live_ws.py:41-52`、`:158-166` |

三个最容易误会的点：

1. **"写死"只剩兜底。** `config.py:86` 的 `foundry_agent_model: str = "gpt-5-mini"`、`config.py:104`
   的 `voice_live_default_model: str = "gpt-5-mini"`、`azure_agent_sync.py:44` 的 `_MODEL_ENV_DEFAULT`
   都只是**配置缺失时的兜底**，admin 一填就被盖掉。
2. **`get_llm_adapter(name)` 的 `name` 是 provider（`azure` / `mock`），不是模型名。** 模型在注册时就
   固定在 adapter 实例上，调用方选不了。推论：**judge 和打分今天必然是同一个模型**，想让它们用不同模型
   需要新开关（目前没有）。另外 judge / 打分**都不读 `persona.model`**——per-persona model 只影响
   agent 同步和 Voice Live 连接。
3. **admin 那一个 model 字段，一条链喂三处用途。** 它同时是 ① judge/打分的 chat 模型、② agent 同步时的
   底层模型、③ Voice Live 的 `model=`。前两个接受**你自己的 deployment 名**，第三个只认**本 region 的
   原生预部署清单**（§2 / §3.1）——所以把一个自有 deployment 名填进这个字段，chat 侧正常、语音侧立刻
   报 "not supported in this region"。**这就是 BYOM 方案要把这两种语义拆开的根因**（见
   `docs/planning/spec-voice-live-byom-model-selection.md`）。

**推论（也是本文最该带走的一句）：自有 deployment 不是"没用"，它在这四处里有三处是唯一正确的填法。**

| 用到模型的地方 | 吃不吃"你自己的 deployment 名" | 为什么 |
| --- | --- | --- |
| judge | ✅ 吃，而且这就是正确的东西 | 走 Foundry Responses API，Azure 侧的 `model=` **本来就是 deployment 名** |
| 评估 / 打分 | ✅ 同上（同一个 adapter 实例）| 同上 |
| Foundry agent 的底层模型 | ✅ 吃 | agent 建在你的 Foundry project 里，它的模型只能是你的 deployment |
| Voice Live `model=`（路径①）| ❌ **唯一不吃** | 只认本 region 的**原生预部署清单**（§2 / §3.1），自有名字 → `invalid_model` |

所以毛病不在"自有 deployment 不该用"，而在 **admin 只有一个 `model_or_deployment` 字段，却同时承载了
两种互不兼容的语义**：填上你的 deployment，前三处全对、第四处立刻报 "not supported in this region"。
要让第四处也吃自有 deployment，**只有 BYOM 一条路**（`profile=byom-...` + 你的 deployment，§3.2）。

> **已在 v0.43.0.0 拆开（2026-10-05）。** admin 现在是两个设置：
> **推理模型**（`model_or_deployment` → judge / 打分 / agent，仍列你的 deployment，行为不变）与
> **语音会话模型**（`voice_model` + `voice_model_mode` native|byom + `voice_byom_profile`）。
> `model_or_deployment` **不再喂 Voice Live**，`persona.model` 也不再进语音链（那是第二个漏非法值的
> 口子）——根因就此切断。原生模式的下拉只列**对本资源实测 ACCEPTED** 的模型（§4.4 的探测，缓存 6h），
> 保存前还会对改动过的语音模型做一次实测复校，被明确拒绝就是 422、不落库。
> 为什么拆而不是"统一成一个值"：语音腿是**嘴、不推理**（§3.3 / §3.5），为了口径一致把它也拖进 BYOM
> 要付出 Foundry 资源 + MI 权限 + 级联延迟的真实代价，却换不到任何功能收益——§4.4 的 D 条实测
> （不存在的部署名也能建连）正说明那条腿根本不会去调你的模型。

> 旁注：`config_overlay.py` **故意不**覆盖 `settings.voice_live_default_model`（注释里写明覆盖它会让
> 每个语音会话在 admin 保存的瞬间就挂掉）；但 `voice_live_ws.py` 在**每次连接时直接读 master row**，
> 所以 master 的 model 仍会进 Voice Live——绕过 settings，不绕过问题。
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

### 4.4 BYOM 实测（2026-10-05，同资源 swedencentral）

> 本节更正了本文早先的一句**未经验证**的话（旧 §4 附注写"本仓库当前没有 BYOM deployment，故只覆盖
> 原生路径"）。实际去查之后：该 Foundry 资源里有 **14 个真实部署**，BYOM 完全可以实测，而且**现在就
> 测完了**。下面每一行都是真实建连的结果，不是推断。

资源里的真实部署（`/api/projects/{project}/deployments` 实际返回，14 个）：

```
gpt-4o  gpt-4o-mini  gpt-4o-mini-2  gpt-4.1-mini
gpt-5  gpt-5-mini  gpt-5.4  gpt-5.4-mini
gpt-5.6-terra  gpt-5.6-luna  gpt-5.6-sol
gpt-6-luna  gpt-6-sol  gpt-6-astra
```

**注意这张表和 §4.1 的 ACCEPTED 名单不是同一张表** —— `gpt-5.4-mini`、`gpt-6-*`、`gpt-5.6-sol` 都是
**真实部署但原生被拒**。这就是 §3.6 "两种语义" 的直接证据。

| # | 探测 | api-version | 结果 | 含义 |
| --- | --- | --- | --- | --- |
| A | `gpt-5.4-mini` **原生** | 2026-01-01-preview | ❌ `REJECTED_REGION`（3.44s） | 它是真部署，但不在本 region 原生清单 |
| B | `gpt-5.4-mini` **BYOM** `byom-azure-openai-chat-completion` | 同上 | ✅ **ACCEPTED** | **同名同资源，原生被拒、BYOM 能连** |
| C | `gpt-6-luna` **BYOM** 同 profile | 同上 | ✅ ACCEPTED | gpt-6 一代原生 12/12 全拒（§4.1b），BYOM 可用 |
| D | `no-such-deployment-xyz` **BYOM** 同 profile | 同上 | ⚠️ **ACCEPTED** | **建连阶段不校验 deployment 名** |
| E | `gpt-5-mini` + profile `byom-not-a-real-profile` | 同上 | ❌ 明确报错 | profile **会**在建连时校验 |
| F | `gpt-5-mini` + profile `byom-azure-openai-realtime`（chat 部署配 realtime 协议） | 同上 | ❌ 明确报错 | **协议不匹配会**在建连时被抓 |

E / F 的服务器原始报文（逐字）：

```json
{"message": "Profile byom-not-a-real-profile is not supported.",
 "type": "invalid_request_error", "code": "invalid_profile", "param": null, "event_id": null}

{"message": "Connection error to BYOM Realtime service: status 400, message: Invalid response status",
 "type": "invalid_request_error", "code": "byom_realtime_connection_error", "param": null, "event_id": null}
```

**由这六条实测得到的四个结论：**

1. **BYOM 在本资源上用当前的 `2026-01-01-preview` 就能工作** —— 不需要文档示例里出现过的 `2026-04-10`。
   原先"BYOM 可能需要更新 api-version"这个待验项，**已证伪**。
2. **Entra 下 Foundry MI 的权限已经通** —— B/C 两条都是 `auth=entra` 建连成功。另一个待验项**已解**。
3. **"region not supported" 在 BYOM 路径上压根不会发生** —— 那是原生路径独有的错误（`invalid_model`）。
   所以「让自带部署连得上」这件事，BYOM 是确定可行的解法，不是猜测。
4. **BYOM 的 deployment 名在建连时不被校验（D）。** 推论很重要：
   - 保存时的实测校验对 BYOM **证明不了"这个部署存在"**，只能抓住 **profile 选错（E）** 和
     **协议不匹配（F）**；而"部署名合法"由部署下拉框本身保证（它列的是 deployments API 的真实返回）。
   - 更深一层：候选人面试里 Voice Live 是 **mouth**（`create_response=False`，§3.3），**从不请求"想"
     这一步**，所以 BYOM 级联里你那个模型**根本不会被调用**。D 这条实测正好印证了这点 —— 连一个不存在
     的部署名都能把会话建起来。所以**在候选人面试上给语音腿开 BYOM，不会改变任何面试行为**，它改变的
     只是会话宿主/计费口径。这也正是「推理模型」与「语音会话模型」应当拆成两个配置的实测依据。

---

### 4.5 三个 profile 的真实验证状态 + 一个"清单被过滤过"的坑

> 2026-10-05 续测。§4.4 只验了 chat-completion 一个 profile。这里补上 realtime，并记下一个让
> realtime 这条路**在界面上走不通**的坑。

**先说那个坑，因为它比结论更容易再犯一次。** 判断"资源里有没有 realtime 部署"时，用的是
`/admin/config/ai-foundry/model-deployments` 的返回——但那个接口里的过滤器**只保留
`capabilities.chat_completion == "true"` 的部署**（它的注释原文就写着 *"not embeddings, image, or
realtime deployments"*）。于是：

- 真实 API 返回 **18** 个部署，过滤后只剩 **14** 个；
- `gpt-realtime-1.5` / `gpt-realtime-2.1` **确实存在**，但永远不出现在那个清单里；
- 而 BYOM 的语音模型下拉当初复用了这个 chat-only 清单 → **`byom-azure-openai-realtime` 在 UI 上没有
  任何可选值，这条已验证可用的路径从界面走不通。**

**能力标记的实测普查**（全资源 18 个部署，`capabilities` 里只出现过三个 key）：

| 部署类型 | `capabilities` 实际内容 |
| --- | --- |
| chat（14 个）| `{"chat_completion": "true", "completion": "false"}` |
| realtime（2 个）| `{"chat_completion": "false", "completion": "false"}` |
| embedding | `{"embeddings": "true"}` |
| image（`gpt-image-2-1`）| **`{}`（空对象）** |

**没有任何"realtime"正向标记**，所以只能反向识别。而且"不是 chat"还不够——按"不是 chat 且不是
embedding"筛，`gpt-image-2-1` 也会被捞进来（**这是跑真实接口才发现的，单元测试没抓到**）。真正可用的
区分是：**声明了 `chat_completion` 且其值为 `"false"`** —— realtime 有这个 key，image 的
`capabilities` 是空的。

**三个 profile 的验证状态（全部真实建连）：**

| profile | 用的部署 | 结果 |
| --- | --- | --- |
| `byom-azure-openai-chat-completion` | `gpt-5.4-mini`、`gpt-6-luna` | ✅ ACCEPTED（§4.4） |
| `byom-azure-openai-realtime` | **`gpt-realtime-1.5`**、**`gpt-realtime-2.1`** | ✅ **ACCEPTED** |
| `byom-azure-openai-realtime`（错配）| `gpt-5-mini`（chat 部署） | ❌ `byom_realtime_connection_error` |
| `byom-foundry-anthropic-messages` | — | ⚠️ **无法验证**：本租户不能部署 Claude |

**对 anthropic 那一格刻意不发明过滤条件。** 既然无法测量 Claude 部署长什么样，猜一个过滤条件若猜错，
下拉就会是空的——正是上面 realtime 那个 bug 的翻版。所以该 profile 列**全部部署**（`kind=all`）：清单
过宽是可恢复的（Azure 在建连时会拒掉错配，§4.4 的 E/F 两条已实测），**过窄则让功能彻底不可达**。

**接口形态**：`GET /admin/config/ai-foundry/model-deployments?kind=chat|realtime|all`，默认 `chat`
（推理模型下拉与人物编辑器保持原行为）；未知值回退到 `chat`，不 422——一个会报错的下拉比一个显示安全
默认值的下拉更糟。

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
路径 ③。路径 ② 尚未在产品里启用，但**已在本资源上实测可用**（§4.4）——正在把「推理模型」与
「语音会话模型」拆成两个配置，语音侧带 native / BYOM 模式开关。

---

## 附：复现与注意事项

- 脚本：`backend/scripts/voice_live_model_probe.py`。支持 `--models a,b,c` 自定清单、
  `--byom-profile/--byom-model` 测 BYOM、`--out` 落 JSON。
- BYOM 实测需要一个真实部署的模型名传给 `--byom-model`。**本资源有 14 个真实部署，BYOM 已于
  2026-10-05 实测完成——见 §4.4。**（本文早先写过"本仓库当前没有 BYOM deployment"，那是一句**未经验证**
  的话，已更正：去查之后资源里有 14 个部署。）
- 本文刻意不写出真实资源名/密钥（记忆 `ai-interview-live-azure-testing`）；endpoint 以
  `<your-resource>` 占位，region 与 api-version 为真实值。
- 探测清单随 Azure rollout 变化，`gpt-5.6-*` 一代尤其易变——**以对目标资源的实测为准**。
