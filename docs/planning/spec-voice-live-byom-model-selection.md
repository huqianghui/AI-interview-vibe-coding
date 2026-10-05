# spec: Voice Live 原生模型 vs 自带部署(BYOM)的可选择接入

> 状态:**需求分析 / 设计(未实现)**。2026-10-05 起草。
> 本文只写需求与设计,不含实现代码;评审通过后再按 §10 的影响面落地。
>
> 配套阅读(权威背景,本文不重复展开):
> - [`docs/voice-live-model-support.md`](../voice-live-model-support.md) —— 三条接脑路径、
>   BYOM 的三个 profile、profile 作用层(§3.2.1)、swedencentral 真实探测证据。
> - [`docs/voice-live-control-notes.md`](../voice-live-control-notes.md) §2 —— `model=` 是宿主不是大脑。
> - 记忆 `ai-interview-voice-model-not-chat-model`、`ai-interview-voice-model-per-connection`。

---

## 1. 背景与问题

admin 页面 "Azure AI Foundry connection" 卡片里的 **Model deployment** 下拉、以及 admin/agent
编辑页的 per-persona model 下拉,都是用 `listModelDeployments()` 从**客户自己的 Foundry 资源**真实拉回来的
部署清单(`admin_config.py:202` → `_chat_deployment_options`)。客户在这里挑了一个**自己部署的** model /
deployment,存进库。

但运行时,这个被挑中的名字被原样当作 **原生路径①的 `model=`** 发给 Voice Live
(`voice_live_proxy.py:446` `connect_kwargs["model"] = default_model`)。原生路径只认 Azure 在该 region
**预部署的内置清单**,客户自己起的 deployment 名不在清单里,于是服务回:

```json
{"message": "Model <X> is not supported in this region.",
 "type": "invalid_request_error", "code": "invalid_model", "param": null}
```

**于是出现了"下拉里能选、选了却连不上"的割裂**:UI 展示的是客户的真实部署,连接走的却是系统默认的原生清单。

客户的原始诉求(逐字):

> "现在 admin 页面,现在 Azure AI Foundry connection 里面加载的 model 或者 deployment,包括 admin/agent
> 页面的 model deployment list 也是客户自己配置的 model。但是实际走的系统默认的 model,所以出现了 region
> 不支持的错误。所以能否加区分这个选项,对应的参数也需要修改。能使用的模型也能想要的变化?"

拆成两层:
1. **"加区分这个选项,对应的参数也需要修改"** —— 让用户能声明"这是我自己的 deployment(BYOM)",连接参数随之
   改成 BYOM 形态,**连得上**。
2. **"能使用的模型也能想要的变化"** —— 用户期望自己选的模型真的"用起来"。这一层有一个必须先定的范围判断,见 §4。

---

## 2. 根因(代码实证)

模型解析链(每连接一次,无缓存):

```
persona.model  →  service_config.model_or_deployment(master 行)  →  env VOICE_LIVE_DEFAULT_MODEL
```
`resolve_voice_model(persona_model, master_model, env_model)`(`voice_live_ws.py:41`,调用在 `:164`)。

连接装配(`voice_live_proxy.py:428`):

```python
is_agent = bool((persona.agent_id or "").strip()) and not is_mouth
if is_agent:
    connect_kwargs["agent_name"] = agent_name          # :442  路径③
    ...
else:
    connect_kwargs["model"] = default_model            # :446  路径① —— 问题就在这里
```

`else` 分支**无条件**把解析出来的名字当原生 `model=` 发出去,既不带 `query={"profile": ...}`,也没有
"这是不是客户自带部署"的任何判别。只要 `default_model` 落在客户自己的 deployment 上(无论来自 persona.model
还是 master.model_or_deployment),连接就会被 region 清单拒绝。

**根因一句话**:admin 下拉喂的是真实 Foundry 部署 → 存进 `model_or_deployment` → `resolve_voice_model`
原样取出 → `voice_live_proxy.py:446` 当原生 `model=` 发出 → `invalid_model` / "not supported in this
region"。**本仓库目前完全没有 BYOM 接法**(路径② 未实现)。

---

## 3. 前置:三条接脑路径(摘自 model-support §1,勿重复展开)

| 路径 | 连接参数 | 模型从哪来 |
| --- | --- | --- |
| **① 原生 / 内置** | `model=<name>` | Azure 预部署、全托管(region 清单) |
| **② BYOM(自带模型)** | `model=<你的 deployment> ＋ query={"profile": "byom-..."}` | **你自己**在 Foundry 资源里部署 |
| **③ Agent(自带智能体)** | `agent_name / agent_version / project_name`(不传 `model=`) | 你托管的 Foundry Agent |

三条互斥、恰选其一。**"not supported in this region" 只从路径①抛出**。本功能是:**给路径①补上一个到路径②的
分叉开关**。路径③(数字人 agent)完全不受影响。

---

## 4. 这个功能到底在改什么:一个必须先定的范围判断

> 这是全文最关键的一节。不先定清楚,实现会跑偏。

**在当前架构里,候选人面试的三条默认链路都是 mouth 会话,Voice Live 的 `model=` 只当"连接宿主 / TTS 载体",
并不在 WS 上做推理。**(实证:`is_mouth_persona` `voice_live_proxy.py:149`;model-support §3.3 的运行期调用链表;
`test_voice_live_plan.py`。)

| 面试链路 | WS 模式 | WS 上有大脑推理? | 每句话从哪来 |
| --- | --- | --- | --- |
| external(默认) | MODEL(mouth) | ❌ `create_response=False` | 外部 API 产题 → `pre_generated_assistant_message`,服务端 TTS 逐字念 |
| bank linear(默认) | MODEL(mouth) | ❌ | 题库文本 → `pre_generated_assistant_message` |
| bank judged | MODEL(mouth) | ❌ | 题库文本逐字念;nudge 来自 **WS 之外** 的 judge LLM(`get_llm_adapter`,默认 gpt-5-mini) |
| 编辑器 Playground | AGENT | ✅ agent 推理 | agent 自由对话 |

由此,**客户诉求的两层对应两种范围,体量差一个数量级**:

### 范围 A(v1,推荐先做):连接兼容 —— 让自带部署"连得上"

即使 mouth 会话的 model 不做推理,**连接本身仍会在 `session.update` 阶段被 region 校验拒绝**——所以哪怕只是
想让客户配置的部署"不报错地连上",也必须走 BYOM 路径②把连接参数改对。这正好对应 `voice_live_proxy.py:446`
那一处 `else` 分支的改动,边界清晰、风险小。

- 改动面:一个"模式"开关 + 一个 profile 值 + `run_proxy` 的 `else` 分支补 `query={"profile": ...}`。
- 收益:客户在 admin 选自己的部署后,语音会话能真实连上(不再 region 报错),avatar / VAD / voice / 语言
  等语音层照常(级联模式下 Voice Live 仍保留 STT/TTS/avatar,见 model-support §3.2 / §3.4)。
- 注意:这不改变"mouth 会话逐字念、不推理"的事实。它解决的是**连接层**的 region 兼容。

### 范围 B(v2,更大,本文列为范围外/开放):让自带模型真正当"面试大脑"

如果客户要的是"我选的模型真的来主导面试、来思考发问",那需要在 WS 上开 `create_response=True` + 推理接线,
牵动整个 mouth / judge / external-brain 架构(目前"想"这一步要么在 off-WS 的 `get_llm_adapter`,要么在外部
HTTP 网关)。这是独立的大 epic,**不在 v1 范围**,仅在 §12 作为开放问题记录。

> **本文默认设计范围 = A(连接兼容)。** 它完整回应了"加区分选项 + 改连接参数 + 不再 region 报错"。
> 范围 B 的"让模型真正变成思考大脑"须 owner 单独确认后另开。

---

## 5. 功能目标(v1 = 范围 A)

1. admin 能**显式声明**:当前配置的 model 是**原生内置**(路径①,默认,保持现状)还是**客户自带部署 BYOM**(路径②)。
2. BYOM 时能选 **profile**(三选一,默认 `byom-azure-openai-chat-completion`),连接按 BYOM 形态装配
   (`model=<deployment> + query={"profile": profile}`,必要时 `foundry_resource_override`)。
3. 原生模式零行为变化(向后兼容:历史数据 = native)。
4. 全程不改 mouth 会话的"逐字念、不推理"语义;不触碰路径③(agent)。

---

## 6. 交互设计:checkbox + profile 下拉

落点:admin "Azure AI Foundry connection" 卡片(`AdminPage.tsx:749`),紧挨 **Model deployment** 下拉。

```
Model deployment:  [ my-gpt54-deploy  ▾ ]      ← 现有(listModelDeployments 真实部署)

[ ✓ ] Use my own deployment (BYOM)             ← 新增 checkbox
      勾选 = 客户自带部署(路径②);不勾 = 原生内置(路径①,默认)

   Integration profile:  [ byom-azure-openai-chat-completion ▾ ]   ← 仅勾选时出现
      · byom-azure-openai-chat-completion   (默认,级联;gpt-5.x / grok / 你的 chat 部署)
      · byom-azure-openai-realtime          (直通;自建 gpt-realtime / -mini)
      · byom-foundry-anthropic-messages     (preview,级联;Foundry 上的 Claude)
```

语义:
- **不勾选(默认)= native**:连接走原生 `model=`,与今天完全一致。
- **勾选 = BYOM**:连接走 `model=<deployment> + query={"profile": profile}`。
- profile 下拉**只在勾选时显示**,默认选中 `byom-azure-openai-chat-completion`(SDK CLI `--byom` 默认,客户 ~99% 场景)。
- profile **无法从 deployment / model 名推断**(model-support §3.2.1 追问二),所以必须显式让用户声明——这是
  checkbox+下拉而不是"自动识别"的根本原因;§12 把"自动推断"作为**已否决**选项记录。

---

## 7. profile 的三个值与默认(摘自 model-support §3.2)

| profile | 你的模型接口 | 音频路径 | 例子 |
| --- | --- | --- | --- |
| `byom-azure-openai-chat-completion` **(默认)** | chat-completion 文本模型 | 级联(Voice Live 保留 STT/TTS) | `gpt-5.4`、`grok-4`、你的 chat 部署 |
| `byom-azure-openai-realtime` | realtime 语音原生模型 | 直通(音频基本直进直出你的模型) | 自建 `gpt-realtime`、`gpt-realtime-mini` |
| `byom-foundry-anthropic-messages`(preview) | Foundry 上的 Claude,走 Messages API | 级联 | `claude-sonnet-4.6`、`claude-haiku-4.5` |

profile 作用在"**想**"这一步,声明的是"Voice Live 用哪套上游 API 协议把请求发给你的 deployment";协议一旦定,
直通 vs 级联也随之定(完整分析见 model-support §3.2.1,本文不再重复)。

---

## 8. 连接参数改动(`run_proxy`,`voice_live_proxy.py:446`)

现状 `else` 分支:

```python
else:
    connect_kwargs["model"] = default_model
```

v1 目标:

```python
else:
    connect_kwargs["model"] = default_model          # BYOM 时仍是"你的 deployment 名"
    if byom_profile:                                  # 新增:来自解析的 BYOM profile
        connect_kwargs["query"] = {"profile": byom_profile}
        # 可选(跨资源):connect_kwargs["foundry_resource_override"] = foundry_resource
```

- `run_proxy` 新增参数 `byom_profile: str | None`(并保留给 `foundry_resource_override` 的扩展位)。
  `byom_profile` 为空/None → 原生路径(现状);非空 → BYOM。
- 诊断事件(`:486-488` 的 `"mode"/"model"`)相应补一个 BYOM 标记,便于前端/日志区分 native vs byom。
- 探测脚本 `backend/scripts/voice_live_model_probe.py:199` 已验证这就是 BYOM 的真实 wire 形态
  (`kwargs["query"] = {"profile": byom_profile}`),实现时据此对齐。

---

## 9. 作用域设计:模式/profile 存在哪一层?

模型值今天是**可叠加**的(persona.model → master → env)。新加的"模式 + profile"必须和"模型值"保持在**同一层**才不会
错配(否则会出现 persona.model 是 BYOM 部署、而全局模式写着 native 的矛盾)。三个候选:

| 方案 | 存放位置 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A 全局单档(推荐 v1)** | master `ServiceConfig` 行加 `model_mode` + `byom_profile` | 改动最小、一次迁移、一处 UI;覆盖"我的部署都是同一种 chat-completion"的 99% 场景 | 同一部署内无法 persona-X 走原生、persona-Y 走 BYOM |
| **B 逐层(persona + master)** | persona 和 master 各带 `model_mode`+`byom_profile`,随各自的 model 值生效 | 最灵活,(model, mode, profile) 三元组逐层自洽 | 两处迁移、两处 UI,面大 |
| **C 从名字自动推断 profile** | 不加字段,运行时解析 | 无 UI | **已否决**:profile 不可从名字推断(model-support §3.2.1) |

**推荐 A 作 v1**:全局连接卡片放 checkbox+profile;per-persona 下拉保持原样(只选 deployment 名),模式/profile
由全局继承。若客户明确需要混用(部分 persona 原生、部分 BYOM),再升级到 B。**此为 §12 的待决项之一。**

---

## 10. 影响面逐层(待 §9 作用域拍板后细化;下表以推荐方案 A 为准)

| 层 | 文件:锚点 | 改动 |
| --- | --- | --- |
| 数据模型 | `backend/app/models/service_config.py:30` | master 行加 `model_mode`(String，默认 `native`)+ `byom_profile`(String，默认 空) |
| 迁移 | `backend/alembic/versions/` | 新迁移;`down_revision` = 落地时 `alembic heads` 的当前 head(勿硬编码) |
| 后端 API schema | `backend/app/api/admin_config.py:33` `AiFoundryConfigIn` / `:46` `AiFoundryConfigOut` | 两个 schema 加 `model_mode` + `byom_profile`;`update_ai_foundry_config`(`:97`,写入点 `:108`)落库 |
| WS 解析 | `backend/app/api/voice_live_ws.py:161/164` | 读 master(或 persona)的 mode/profile,解析后随 `run_proxy` 传下 |
| 连接装配 | `backend/app/services/voice_live_proxy.py:401/446/486` | `run_proxy` 加 `byom_profile` 参数;`else` 分支按 §8 补 `query`;诊断事件补 BYOM 标记 |
| 前端类型 | `frontend/src/api/admin.ts:140` `AiFoundryConfig` / `:150` `AiFoundryConfigInput` | 两个 interface 加 `model_mode` + `byom_profile` |
| 前端 UI | `frontend/src/pages/AdminPage.tsx:749`(卡片)、更新点 `:803`/`:891` | 加 checkbox + 条件 profile 下拉,随 `updateAiFoundryConfig` 提交 |
| per-persona(仅方案 B 需要) | `frontend/src/components/agent-editor/ModelSelect.tsx` + persona 模型/迁移 | A 方案不动;B 方案才下沉到 persona |
| 测试 | `backend/tests/`(新纯函数测试,仿 `test_voice_live_plan.py`)+ 真实 BYOM 连接验证 | native 分支回归 + BYOM 装配出 `query={"profile":...}`;真实连接用 `voice_live_model_probe.py --byom-profile/--byom-model` |

---

## 11. BYOM 硬约束 + 待验项

**硬约束(model-support §3.2,文档已明确):**
1. 必须是 **Microsoft Foundry 资源**(普通 Azure Speech 资源不支持 BYOM);默认只能接**同一 Foundry 资源**里的
   部署,跨资源要加 `foundry-resource-override`。
2. Entra 鉴权下,Foundry 资源的 system-assigned managed identity 需有访问对应模型 deployment 的权限
   (长会话靠 MI 续 token)。

**待验项(实现前用真实连接验证,勿凭空断言——记忆 `verify-dont-assert-limits`):**
- [ ] **api-version**:本资源当前 `2026-01-01-preview`,BYOM 是否需要更新的 api-version(文档示例出现过 `2026-04-10`)。
      用 `voice_live_model_probe.py --byom-profile byom-azure-openai-chat-completion --byom-model <真实部署>` 实测。
- [ ] **MI 权限**:确认 Foundry MI 对目标 deployment 有访问权(否则 BYOM 连接会以权限错误失败)。
- [ ] **avatar 在 BYOM 下**:级联模式语音层应照常;realtime 直通模式下 avatar 是否仍能挂,需真实连接确认。
- [ ] **客户实际部署的是哪种 profile**:默认 chat-completion,但须向客户确认其部署形态(§12)。
- [ ] 前置:本仓库当前**没有任何 BYOM deployment**(model-support §4 附注),真实 BYOM 验证需先在 Foundry 资源里真实部署一个。

---

## 12. 开放设计决策(待 owner / 客户拍板)

1. **范围 A vs B(§4)**:v1 只做"连接兼容"(推荐),还是要一并做"自带模型真正当面试大脑"(大 epic)?
2. **作用域 A vs B(§9)**:全局单档(推荐)还是逐层 per-persona?客户是否需要混用原生/BYOM?
3. **客户实际用哪种 deployment**:是 chat-completion(默认)、realtime,还是 Foundry 上的 Claude?直接决定默认 profile 是否要改。
4. **checkbox 落点**:只在全局卡片(方案 A),还是也进 per-persona 编辑器(方案 B)?
5. **是否暴露 `foundry_resource_override`**:v1 是否支持跨资源 BYOM,还是先只支持同资源、把跨资源留到后续。

---

## 13. 范围外(v1 明确不做)

- 让 BYOM 模型在 WS 上真实推理 / 主导面试(范围 B,§4)。
- 路径③(数字人 agent)的任何改动。
- off-WS 的 judge / scoring 用的 chat 模型(`get_llm_adapter`,与 Voice Live `model=` 是**两条独立链**,不在本功能内)。
- 自动从 deployment 名推断 profile(§9 方案 C,已否决)。

---

## 14. 验收标准(真实连接,不 mock)

- 不勾 BYOM:连接与今天逐字一致(native `model=`),三条默认链路回归通过。
- 勾 BYOM + 默认 profile + 一个真实的客户 chat-completion 部署:Voice Live **连接成功**(`session.updated`),
  不再 region 报错;avatar / 语音层照常;探测脚本对同一部署 `--byom-profile`/`--byom-model` 同样 ACCEPTED。
- 后端 `ruff format --check` + `ruff check` 通过;前端 `eslint --max-warnings 0` 通过;新测试本地用真实 provider 跑绿。
