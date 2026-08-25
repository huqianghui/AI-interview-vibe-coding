# 规格文档（中文）— 外部 MCP 面试官集成（分析 + 客户确认前置）

**状态：** 分析阶段。已收到客户第一轮答复（2026-08-25，见 §9）——范围收敛为**逐题、无状态**模型；
但**仍有一处硬矛盾未解决**（§9.2），须在开工前锁定。
**日期：** 2026-08-25（2026-08-25 补入客户第一轮答复）
**说明：** 本文是英文版 [`spec-external-mcp-interviewer-integration.md`](spec-external-mcp-interviewer-integration.md) 的中文对照版，内容对齐。
**关联：** [`../../SPEC.md`](../../SPEC.md) 的 F4/F6/F7/F8、[`spec-mece-classification-scoring.md`](spec-mece-classification-scoring.md)、
[`spec-voice-live-agent-contract.md`](spec-voice-live-agent-contract.md)、
[`spec-voice-transcript-race-explicit-submit.md`](spec-voice-transcript-race-explicit-submit.md)。

> **目的。** 客户希望把他们的 MCP server 接入我们的面试官 agent：由**我们去调用这个 MCP server**，
> 并根据它返回的内容来驱动与候选人的交互（数字人口播 + 屏幕展示）。本文记录：(a) 这份 sample 数据
> 究竟是什么；(b) 数据本身存在的问题；(c) 集成的架构级风险；(d) 在动手实现**之前**必须让客户确认
> 的事项清单。**请勿据此直接实现**——这是带回客户沟通用的"实现前分析"。

---

## 1. 客户给了我们什么

一条 MCP 工具调用的返回 sample（单轮，`event = main_question`）：

```json
{
  "final_session_state_json": "{...字符串编码的完整会话状态，含逐维度打分...}",
  "public_response_json": "{...字符串编码的候选人安全视图：speech_text、display_text...}",
  "speech_word_count": 38
}
```

- **`final_session_state_json`**（字符串编码的 JSON）：**完整的**服务端会话状态——`schema_version:"1.0"`、
  `mode:"mock"`、`order[]`（9 个题号）、`index`、`current_question_id`、`followup_count`、
  `covered_questions[]`，以及 `results[]`；每条 result 携带**六个维度分**
  （`accuracy / completeness / role_boundary / evidence_traceability / risk_escalation / clarity`）、
  `raw_overall`、`overall`、`level`、`critical_flags[]`、`feedback_summary`、`improvement_advice`、
  `citations[]`（SOP **文件名**）。
- **`public_response_json`**（字符串编码的 JSON）：候选人安全视图——`event`、`speech_text`（数字人该说的话）、
  `display_text`（屏幕该展示的内容），以及一个精简的 `session_state`（仅进度，无分数）。sample 中
  `analysis/scores/radar/critical_flags/citations` 全为空（对 `main_question` 这一轮而言是正确的）。
- **`speech_word_count`**：38（给 TTS/数字人层的长度提示）。

### 1.1 这套面试就是我们仓库里的 rf-CSM 题库

sample 里的 `RFCMS-Q0x` 题号、六维评分、`RFCMS-CONFLICT-001`，与本仓库
`EU_avatar_inspector_interview/GCO_Inspection_Training_Bank_rf_CSM.md` 以及我们已上线的
**F4 MECE 六维评分**（`backend/scripts/import_rfcsm_bank.py` 的 `DIMENSIONS`）**逐项对应（1:1）**。
也就是说，**客户的 MCP server 是我们已经在做的同一套面试规格的一个平行实现**——它不是一个新能力，
而是同一件事的"第二个大脑"。**这一点决定了下面所有的架构风险。**

---

## 2. 字段与我们已上线引擎的对应关系

| MCP `final_session_state_json` 字段 | 我们的对应实现 |
|---|---|
| `order[]`、`index`、`current_question_id` | `state_machine.py` 的题序 + `current_question_index`（`models/interview.py`） |
| `followup_count` | `state_machine._follow_ups_asked` |
| `covered_questions[]` | `state_machine.py` 中已答题推导 |
| `results[].dimensions{六维}` | F4 六维 MECE（`import_rfcsm_bank.py:66-103`）——**命名不同，见 §3.8** |
| `results[].raw_overall / overall` | `scoring_engine._weighted_score()` |
| `results[].level` | `scoring_engine.outcome_for_score()`（`:219`）——**大小写不同，见 §3.8** |
| `results[].critical_flags[]` | F4 严重错误封顶（`scoring_engine.cap_outcome()` `:233`） |
| `results[].citations[]`（文件名） | `ChecklistItem.source_document_id` → 可点击的 `ReportView.tsx:SopSourceLink`——**模型不兼容，见 §3.7** |
| `RFCMS-CONFLICT-001`（题库头部） | F4 **advisory** 待定冲突豁免（`ChecklistItem.advisory`） |

**结论：** MCP server 承担的职责，正好就是我们 `state_machine.py` + `scoring_engine.py` 承担的职责。
**同一场面试不可能由两套"逐题状态机"同时驱动。**

---

## 3. 数据本身的问题

### 3.1 双层 JSON 字符串编码
两个 payload 都是**被字符串化的 JSON**，因此每一轮都要做二次 `JSON.parse` / 防御式反序列化。
任何格式漂移都会导致解析失败。好在有 `schema_version:"1.0"`——我们应据此校验，并在不匹配时显式报错。

### 3.2 语音与展示使用了不同的题目标识
- `speech_text` → **"Question 7 of 9: …"**（序号，对候选人友好）。
- `display_text` → **"RFCMS-Q03 — …"**（内部题库 ID）。

两个问题：(a) 同一道题被以两种方式呈现（口播说"第7"、屏幕显示"Q03")，观感割裂；
(b) **`RFCMS-Q03` 是内部 ID，绝不能出现在候选人屏幕上**——这既是 demo 质量的减分项，也是信息泄漏。
集成时必须在到达 `Transcript.tsx` 之前，把 `display_text` 清洗成序号（"第 7 题 / 共 9 题"）。

### 3.3 `results` 条数 ≠ 已覆盖题数
sample：`covered_questions` = 6 题（Q05、Q08、Q02、Q06、Q07、Q09），但 `results` 只有 **1** 条（仅 Q05）。
所以要么服务端是**懒评分 / 只回最新一条**，要么 sample 被截断。**如果我们的 F8 报告直接读 `results`，
就会缺 5 道题的分数。** 需确认 result 是逐轮累积，还是需要专门的"取报告"调用。（见 §7 问题4）

### 3.4 speech_text 里夹带了角色设定开场白
`"I will act as the inspector. Answer as you would during a real inspection, using only facts you
can support. Question 7 of 9: …"`。需确认这段开场白是**只在第一题出现**，还是**每一轮都被前置**
（若每轮都带，数字人会在每道题前把开场白重复念一遍）。（见 §7 问题5）

### 3.5 缺少"提交答案"方向的契约（最大缺口）
sample 只展示了**系统 → 候选人**（抛题）这一个方向，完全没有：
- **提交候选人答案的工具输入 schema**（参数是什么？`answer` 文本？`question_id`？）；
- 我们这边到底如何发起对该 server 的调用。

**没有这半个契约，集成无法开工。**（见 §7 问题1）

### 3.6 无 session 标识 → 有状态还是无状态未知
`final_session_state_json` 里**没有 `session_id` / `thread_id`**。因此我们无法判断该 MCP server 是
**有状态**（服务端按某个 key 保存状态）还是**无状态**（每轮都要我们把完整的上一轮 state 回传）。
这直接决定我们要不要在 `models/interview.py` 里持久化 `final_session_state_json` 并逐轮回传。（见 §7 问题2）

### 3.7 citations 是文件名，不是文档 ID —— 破坏"可点击引用"
MCP 的 citations 形如 `"EMEA GCO - Regional CST Governance Handbook_v1.0_17Jul2025.pdf"`。而我们已上线的
**可点击 SOP 引用**（v0.31.1.0）依赖 `source_document_id`，并经过两道 IDOR 防护
（`state_machine.cited_document_ids` `:429` + `GET /{id}/sop/{document_id}` 端点）。**两个模型不兼容。**
要保持引用可点击，必须：(a) 通过 `sop_ingestion.py` 把 `Data_Sources_AI_Inspector/` 那批文件入库；
(b) 建立**文件名 → SopDocument.id** 的映射。否则引用只能以纯文本展示（点击会 404）。

### 3.8 `level` 标签接近但不完全一致
MCP：`raw_overall:65 → level:"Needs improvement"`。我们的 F4：`Meets Expectations (≥70) /
Needs Improvement (40–69) / Does Not Meet (<40)`。**阈值一致**（65 落在 40–69），但**大小写/拼写不同**
（`"Needs improvement"` vs `"Needs Improvement"`），且 MCP 是纯英文、我们的 UI 是中英双语（zh-CN + en-US）。
需要一层显示映射。六个维度的 key 同理命名不同（MCP `role_boundary/evidence_traceability/risk_escalation`
对我们的 `role/evidence/risk`）。

### 3.9 只观测到一种事件类型
只出现了 `event:"main_question"`。一定还存在 `follow_up`（追问）、评分后的事件、`session_complete`、`error` 等。
**没有这些事件的 sample = 集成盲区。**（见 §7 问题3）

---

## 4. 集成架构：两条路径，以及为何"看似省事"的那条是陷阱

我们后端**已经支持 MCP**，且有两种接法。对**这个特定 server**，两种接法结果相反。

### 路径 1 —— 把 MCP 挂成 Foundry agent 的工具（现有机制）
在 `persona.tools_config` 里加 `type:"mcp"` → 经 `gate_supported_tools()`（`persona_tools.py:60`）→
`_to_mcp_tool()`（`azure_agent_sync.py:250`）同步进 Foundry agent。

**为何这里行不通。** 该工具会在 **Azure Foundry 的 agent runtime 内、由 agent 自主决定何时调用**——
不在我们后端进程里。这对**检索类**工具没问题（我们现在的 `knowledge_base_retrieve` 就是这样）。
但这个 server 是**整台面试的大脑**（它产出题目、口播文本和分数）。挂成 agent 工具，就等于
**由 Foundry agent 来决定什么时候抛题、说什么**——这与我们在 v0.30–v0.31.2.0 一路打下来的东西正面冲突：
- `useInterviewVoice.ts:658 speakQuestion()` 的 cancel-then-speak 假设**题面由后端权威给出**；
- `feat/voice-followup-convergence`（v0.31.2.0）刚刚**约束 agent 不要自己造题**——挂上这个 MCP 等于把出题权又交回给 agent；
- `persona_tools.py:68` 目前**只支持无鉴权的公网 `http(s)` MCP server**（`project_connection_id` 被主动丢弃）——
  如果客户 server 需要鉴权或位于私有边界内，这条路本身就走不通。

### 路径 2 —— 我们后端当 MCP client；MCP server 当大脑（可行路径）
我们后端自己去调用 MCP server，并针对这个 persona **替换 / 包裹** `state_machine.py`：每次候选人作答后
调用该 server，取回 `public_response_json`，把 `speech_text` 灌进现有的 `speakQuestion()` 路径，
渲染清洗过的 `display_text`，并把最终的 `results` 映射进我们的 F8 报告 DTO。
`final_session_state_json` 全程不出后端。

**这是唯一契合该 server 的路径。** 它是一个"谁拥有大脑"的抉择，而不是"加一个工具"的任务。

### 核心决策
**对这场面试而言，要么 MCP server 当大脑（我们的 `state_machine.py` 降级为传输/适配层），
要么保留我们自己的 `state_machine.py`（那就不需要这个 MCP）。两套逐题状态机不能同时运行。**

---

## 5. 风险登记表（落到具体文件）

| 编号 | 风险 | 触发位置 | 严重度 |
|---|---|---|---|
| R1 | **两个大脑 / 真源冲突** | `state_machine.py`（`answer_finalized:115`、`get_current_question:324`、`score_and_finalize:205`）对 MCP 的 `order/index/results` | **严重**——须先定 §4 |
| R2 | **语音权威冲突** | `useInterviewVoice.ts:658`、`voice_live_proxy.py`、`feat/voice-followup-convergence` 的 persona 契约 | **高**——必须把 MCP `speech_text` 走 `speakQuestion`，agent 不得自行造词 |
| R3 | **隐私护城河 / 数据出境** | 若 MCP 端点在客户 Azure 边界之外，候选人答案会离开边界 → 动摇"SOP 私域闭环"卖点 + SPEC P3/P12 | **严重**——须确认部署（§7 问题6） |
| R4 | **评分内幕泄漏边界** | `final_session_state_json` = 完整内部评分 = P3 "no rubric leak" 要挡的东西；只有 `public_response_json` 可到 `InterviewPage.tsx` | **高**——后端强制拆分 |
| R5 | **会话隔离 + 延迟** | 多候选人并发需 session 隔离（依赖 §3.6）；每轮 = 一次 MCP 往返（+ 服务端可能还调 LLM）→ 每轮秒级延迟，与"即时报告"体验冲突 | **中**——需遮蔽/流式 |
| R6 | **引用模型不兼容** | §3.7 —— `ReportView.tsx:SopSourceLink`、`cited_document_ids:429` | **中**——入库 + 文件名→id 映射 |
| R7 | **display_text 题号泄漏** | §3.2 —— `Transcript.tsx` | **中**——清洗为序号 |
| R8 | **报告完整性** | §3.3 —— F8 报告 对 `results[]` | **中**——确认是否累积 |

---

## 6. 不依赖客户、可先离线做的事（不改动已上线代码）

一个**独立的"解析 + 映射适配器"原型**，不触碰 `state_machine.py`：
1. 防御式双层 JSON 解析 + `schema_version` 校验；
2. **public/private 拆分**（在后端就丢弃 `final_session_state_json`，只让 `public_response_json` 过到前端）——R4；
3. `display_text` 清洗为序号——R7；
4. `level` + 六维 + `citations` 映射进我们的 F8 报告 DTO 结构——R6/R8；
5. 针对这份 sample 写一个 golden-file 测试。

它能在不承诺路径 2 的前提下，验证可行性、并把剩余问题问得更精准。

---

## 7. 实施前，必须让客户确认的事项

**阻塞项（不确认无法开工）：**
1. **提交答案的工具契约**——提交候选人答案的 MCP 工具名 + 输入 schema（参数有哪些：session key？`answer` 文本？`question_id`？locale？）。（§3.5）
2. **有状态还是无状态？**——是否有 session/thread id 让我们回传，还是每轮都要把完整 `final_session_state_json` 回传？状态按什么 key 保存？（§3.6）
3. **完整事件枚举 + 每种事件的 sample**——至少要 `follow_up`、评分后事件、`session_complete`、`error`。（§3.9）

**决定架构方向：**
4. **`results[]` 是否逐轮累积**，还是有专门的"最终报告"调用？为什么 sample 里已覆盖 6 题却只有 1 条 result？（§3.3）
5. **"I will act as the inspector…" 这段开场白**是只在第一题出现，还是每轮都带？（§3.4）
6. **MCP server 部署在哪里**——在客户 Azure 边界内，还是外部端点？鉴权模型是什么（公网无鉴权 vs token/托管身份）？
   （R3——同时决定路径 1 在技术上是否可能。）

**确认项（风险较低但仍需确认）：**
7. `mode:"mock"` 是测试夹具吗？**真实**（非 mock）返回的形态长什么样？
8. citation 的**文件名是否为稳定标识**、可映射到已入库的 `SopDocument`，还是会随版本变化？（R6）
9. 语言：server 是纯英文，还是能输出 zh-CN？（影响 §3.8 映射与我们的 locale 双语一致性。）
10. 未来**题库 + 评分标准（rubric）归谁管**——MCP server，还是我们的 DB（`import_rfcsm_bank.py`）？
    若归 server，则该 persona 下我们的 F2/F3/F4 管理界面将变为只读。

---

## 8. 建议

- **不要**把该 server 挂成 Foundry agent 的工具（路径 1）。它是大脑、不是检索工具，会与已上线的语音/追问权威模型打架。
- **应当**把它当作"谁拥有大脑"的抉择来处理（§4）。若决定集成，走路径 2（后端当 MCP client、MCP 当大脑），
  并以 §7 的问题 1/2/3 为前置门槛。
- **并行推进：** 客户回答 §7 的同时，我们先做离线适配器原型（§6）以给映射降风险。在 §4 未定、§7 阻塞项未闭合前，
  不动 `state_machine.py`。

---

## 附：需要和客户确认的事项清单（可直接发给客户的精简版）

> 以下 10 条按优先级排序。**第 1–3 条是阻塞项**——不拿到就无法开始集成开发。

### 一、阻塞项（最优先，不确认无法开工）

1. **【提交答案的接口】** 候选人作答后，我们该调用哪个 MCP 工具来提交答案？它的输入参数有哪些
   （会话标识？答案文本？题号 `question_id`？语言 locale？）？能否给一个提交答案的调用示例（输入 + 返回）？

2. **【会话是否有状态】** 这个 MCP server 是"有状态"还是"无状态"？
   - 如果有状态：会话用什么标识（session_id / thread_id）？我们如何获取并在每轮携带它？
   - 如果无状态：是否每一轮都需要我们把完整的 `final_session_state_json` 原样回传？

3. **【完整的事件类型】** 请提供所有 `event` 类型的完整枚举，以及**每种事件各一个返回 sample**。
   目前我们只见到 `main_question`，至少还需要：追问 `follow_up`、评分完成后的事件、面试结束 `session_complete`、
   错误 `error`。

### 二、决定架构方向

4. **【评分结果如何取】** `results` 里的评分是每轮累积（最终会包含全部 9 题），还是需要专门调一个"取最终报告"的接口？
   为什么示例里已经答了 6 题（`covered_questions`），但 `results` 只有 1 条？

5. **【开场白出现频率】** speech_text 里的"I will act as the inspector…"这段角色说明，是只在**第一题**出现，
   还是**每一题**都会带上？（关系到数字人是否每题都重复念开场白。）

6. **【部署位置与鉴权】** 这个 MCP server 部署在**客户的 Azure 边界内**，还是一个**外部端点**？
   访问它需要鉴权吗（公网无鉴权 / Token / 托管身份）？
   —— 这条同时关系到"数据不出边界"的核心卖点是否成立。

### 三、确认项（风险较低但仍需明确）

7. **【mock 与真实数据】** 示例里的 `mode:"mock"` 是测试用的假数据吗？真实（生产）返回的数据结构是否一致？有无差异？

8. **【引用文件名是否稳定】** citations 里给的是文件名（如 `...Handbook_v1.0_17Jul2025.pdf`）。这些文件名是**稳定不变的标识**，
   可以让我们映射到已入库的原文件（以支持报告里"点击引用打开原文")吗？还是会随文档版本变化？

9. **【语言】** 这个 server 只输出英文，还是也能输出中文（zh-CN）？（我们的界面是中英双语，需要对齐。）

10. **【题库与评分标准归属】** 未来"题目 + 评分标准（rubric)"由谁维护——MCP server 端，还是我们系统的数据库？
    如果由 server 端维护，那么在接入该 server 的场景下，我们后台的题库/清单/评分配置界面将变为只读展示。

---

## 9. 客户第一轮答复（2026-08-25）——答复、范围收敛、以及唯一未解矛盾

客户回答了 §7。其心智模型是**逐题、无状态、单题聚焦**：每一轮就是一道题；候选人只就**这一道题**与数字人对话；
这一轮的对话内容按 rubric 评分；MCP state 中的其余内容一律忽略。

### 9.1 答复与对范围的影响

| §7 | 客户答复（意图） | 影响 |
|---|---|---|
| 问题1 提交接口 | "没有提交答案的接口，就是针对当前题目面试，最后用评分结果 + 大模型评估内容。" | 见 **§9.2——此答复与 sample 矛盾。** |
| 问题2 有/无状态 | "目前当无状态。面试者只就当前题目与数字人交流，最后把当前对话内容作为评判内容。" | **R1（两个大脑）基本消解**——MCP 不再是逐题状态机；**我们的 `state_machine.py` 继续驱动**逐题编排。 |
| 问题3 事件枚举 | "为什么还需要其他？问题1、2 已经能完成了。" | **撤回。** 在逐题模型下正确——`follow_up`/`session_complete`/`error` 编排只有"MCP 当大脑"才需要。 |
| 问题4 结果是否累积 | "只针对当前题目评分，其他结果可忽略。" | 只用**当前题**的分；`order/index/其余 results[]` 忽略。简化 R8。 |
| 问题5 开场白频率 | "每一题都带，因为面试者一次只有一题。" | **确认。** 使 §3.2 **更严重**：`display_text` 里的 `RFCMS-Q0x` 题号会在**每一屏**泄漏，必须清洗为序号（R7）。 |
| 问题6 部署/鉴权 | "部署在客户机房，通过公网访问。今天主要讨论集成。" | 见 **§9.3**——公网端点需鉴权；候选人答案将经公网传至客户机房。 |
| 问题7 mock vs 真实 | "一致。" | ✅ mock 形态 == 真实形态。 |
| 问题8 文件名→文档映射 | "可以。" | ✅ 可点击引用可行（入库 `Data_Sources_AI_Inspector/` + 文件名→`SopDocument.id` 映射，R6）。 |
| 问题9 语言 | "目前只用英语也可以。" | ✅ 免去对 MCP 输出的 zh-CN 映射需求；我们界面框架仍保持双语。 |
| 问题10 题库/rubric 归属 | "admin 可以维护。" | 由 admin（我们的 F2/F3/F4）维护题库/rubric——但见 **§9.4**（9 道题的 `order[]` 归谁？）。 |

### 9.2 唯一未解矛盾——Q05 的分数是谁算的？（开工前必须锁定）

**问题1 说"没有提交答案的接口"。但客户给的 sample 里，`final_session_state_json.results[0]` 已经含有 Q05 的六维分数。**
要产生这些数字，一定有"某个东西看过 Q05 的答案"。两者不可能同时成立。真实流程必为以下二选一：

- **流程 B——我们本地评分。** MCP **只当出题方**。候选人语音作答 → 用**我们已上线的 F4 引擎** + rubric 评分 → F8 报告。
  MCP 的 `results[]` **弃用**。*最简单、最大化复用。* 待厘清的子问题：若 MCP 只提供题面文本，那它相较于
  "权威题库 + 开场白措辞 + 权威 rubric"之外，还提供什么额外价值？
- **流程 A——MCP 评分。** 我们把当前题的**答案/对话文本发给 MCP**，它返回六维分 + citations，我们映射进 F8。
  那么"没有提交接口"其实只是"不是**单独的** endpoint，而是同一个 tool 调用"——**我们仍然需要那个 tool 的输入 schema
  + 一个带答案的调用示例。** sample 里 Q05 已算出的分数，正是这个输入通道存在的直接证据。

**这是目前唯一的阻塞性决策。** 不是最初那 10 个问题，就一个：**分数由谁计算，我们（流程 B）还是 MCP（流程 A）？**
定了它，其余都能推进。

### 9.3 公网端点 → 鉴权与数据流向的说明（今天就该提）

问题6 = "客户机房、公网访问"。一个公网可达、**无鉴权**的评分/rubric 端点意味着任何人都能提交答案、
拿到按 rubric 打分的输出 → **rubric 泄漏**（SPEC P3）。最低要求：token / 鉴权访问。另需向客户明确：
候选人答案会**经公网传输到客户机房**——因是客户自有机房通常可接受，但"数据不出边界"的措辞须据此调整（R3）。

### 9.4 剩余待定项（不阻塞开工，但需定）

- **9 道题的 `order[]` 归谁？** 问题10（admin 维护题库）+ 问题4（忽略 MCP 其余结果）暗示**顺序归我们**（F2）；
  但 sample 里的 `order[]` 由 MCP 管理。请确认：是我们题库驱动排序、MCP 只按题号供题，还是 MCP 拥有一套平行的
  RFCMS 题库（→ **两套题库需对齐**）。
- 在流程 B 下，为 SOW 用一句话重述 MCP 的角色，避免把"集成"讲过头。

### 9.5 修订后的建议

- 架构现为 **MCP 当"出题源"，我们的引擎驱动逐题编排**（路径 2 的一个轻得多的变体）。R1 从"严重"降为"低"。
- **剩余阻塞项：** 恰好一个——§9.2（流程 A vs 流程 B）。若为流程 A，另需拿到该 tool 的输入 schema + 一个带答案的 sample。
- 离线适配器原型（§6）仍值得先做：解析 + public/private 拆分 + `display_text` 清洗 + citation 文件名→id 映射，
  在**两种流程下都需要**。

---

## 10. 第二轮——需进一步向客户确认的问题（可直接发给客户的精简版）

> 第一轮答复已关闭了原 §7 的多数问题。以下是**在此基础上新暴露 / 仍未解决**的问题，按优先级排列。
> **第 1 条是唯一的开工阻塞项。**

### 一、阻塞项（不确认无法开始集成开发）

1. **【当前题的分数由谁计算？】** —— *状态：今天下午（2026-08-25）与客户确认中。*
   您提到"没有提交答案的接口"，但您给的示例数据里，`results` 中**已经带有 Q05 这道题的六维评分**。
   要算出这个分数，一定有环节读到了候选人对 Q05 的回答。这两点无法同时成立，所以请确认实际是以下哪一种：
   - **方案 A：由你们的 MCP 评分。** 我们把候选人对当前题的回答（或对话内容）发给 MCP，MCP 返回六维分 + 引用。
     → 如果是这种，请提供**"提交答案"这个调用的输入参数格式，以及一个带答案的完整调用示例（输入 + 返回）**。
   - **方案 B：由我们本地评分。** MCP 只负责出题（题面 + 开场白），评分完全由我们系统按 rubric + 大模型完成，
     MCP 返回里的分数我们不用。
     → 如果是这种，请确认：这种情况下 MCP 除了"提供题目文本、开场白、以及权威的评分标准（rubric)"之外，
     还承担什么职责？（便于我们准确界定集成范围。）

### 二、需要明确（不阻塞，但要定）

2. **【公网访问的鉴权】**
   MCP 部署在贵司机房、通过公网访问。若这个端点**无需鉴权**，则任何人都能提交答案并拿到按评分标准打分的结果，
   等于评分标准（rubric）对外泄漏。请确认端点是否需要 **Token / 其他鉴权**，以及凭据如何提供给我们。
   （同时说明一下：候选人的回答会经公网传输到贵司机房——因是贵司自有机房通常没问题，我们只是需要在
   "数据边界"的描述上与实际保持一致。）

### 三、已关闭的（无需再问，仅记录）

**第一轮：** 只评当前题 ✅　· 开场白每题都带 ✅　· mock 与真实数据一致 ✅　· 引用文件名可映射到原文件 ✅
· 目前只用英文 ✅　· 题库/评分标准由 admin 维护 ✅　· 无状态、按当前题交互 ✅

**第二轮：** **题目顺序与编号——不重要** ✅（客户："反正都是对题目内容进行面试，顺序/编号无所谓"）。
**由此确定的实现：** 逐题顺序由**我们自己题库的顺序 + 我们自己的序号**驱动，并直接**把 `display_text` 里的
内部题号 `RFCMS-Q0x` 丢弃/清洗掉**——这样 **R7 干净关闭**（不再是纠结点，而就是预期行为）。

---

## 11. 下午沟通 checklist（2026-08-25，开会照着念）

> 顺序很重要：**先问"结果给谁看"（形态一/二），再问"谁算分"**。前者决定我们到底要不要开发、开发多少；
> 后者只在形态二下才有意义。别一上来就要 schema——很多情况根本不需要。

### 第 0 步（内部已定，无需问客户）

- ☑ **不新建 repo。** 两种模式都在同一个 repo 里，通过一条 source 接缝隔离
  （`BankInterviewSource` / `McpInterviewSource`），复用整套语音 + 数字人 + 报告 + 鉴权 + admin + i18n。
- ☑ 题序/编号不重要，用我们自己的顺序 + 序号，清洗掉 `RFCMS-Q0x`。
- ☑ **MCP 的配置界面不用新造。** 现有 `tools_config` + `ToolPicker` 已支持给 persona 挂 MCP 工具
  （`server_url`/`server_label`）——不需要额外的"数据源"下拉。**但"在 agent 的 tools 里挂 MCP"≠"结果能回到我们界面"**：
  agent-tool 是在 Azure agent runtime 里、由大模型自主调用，返回进入的是 **agent 的上下文**——
  它能把 `speech_text` 说出来，但 `display_text` 和分数**回不到我们后端**（困在 agent 上下文里，
  且 `final_session_state_json` 有被 agent 念给候选人的泄漏风险）。所以"挂工具即可"只有在**形态一**下成立（见第 1 步）。

### 第 1 步（必问，最根本的分叉）★★

- ☐ **这场面试的结果/报告，最终在哪里看？**
  - **形态一（我们只是外壳）：** 题目/评分/报告都活在贵司的 MCP server 里（`final_session_state_json` 就是它自己的报告状态），
    贵司从**自己的 server** 取结果。我们只提供数字人 + 语音的对话外壳。
    → **这种情况你说的"agent 挂 MCP 工具、确认挂上了即可"就是最终方案，我方开发量几乎为零。**
  - **形态二（结果由我们呈现）：** `display_text` / 分数 / 引用要显示在**我们**的面试界面和 F8 报告里。
    → 不能靠 agent-tool（见第 0 步），需**后端当 MCP client**，并做映射，转第 2 步。
- ☐ **向客户讲清工作量/安全性的差别（见 §12）：** "挂 MCP 工具"（形态一）开发量几乎为零，但**仅当结果由贵司从自己的 server 取用**才成立；
  要把结果显示在**我们**报告里、或要"绝不泄漏 rubric"的硬保证，就是形态二/方案②——一次真实的中等工作量开发，不是勾个开关。
  "①+hook 截取"这条中间路线只是可能的优化项，取决于 12.3 是否成立，且**并不能关闭泄漏边界**。

### 第 2 步（仅当形态二，必问，决定分叉）★

- ☐ **当前题的分数是谁算的？**
  - "**我们 MCP 算分**" → 走 **方案 A**，转第 3 步。
  - "**你们按 rubric 自己算，MCP 只出题**" → 走 **方案 B**，跳到第 4 步。

> **关于"两边都能算"的澄清**（内部）：目标形态是**（乙）系统同时支持两种评分模式，但每场面试按 persona 二选一、
> 不重复算**——这正是 source 接缝的价值。**不要做（甲）同一场两边各算一遍**（两套分必然不一致、无法向候选人解释、
> 翻倍延迟成本）。**（丙）MCP 挂了回退本地** 是后续优化项，第一版不做。另注意：**只有形态二下，"我们也能算"才有出口**
> （有界面/报告承载结果）；形态一下我们的 F4 引擎对该 persona 实际关闭。

### 第 3 步（仅当方案 A）——要 schema 与示例

- ☐ **提交答案调用的输入 schema**，逐字段确认：
  - ☐ 调用哪个 **MCP tool（工具名）**？
  - ☐ 如何标识"当前是哪道题"——传**题号**，还是回传**题面文本**？
  - ☐ 答案如何传——**纯文本**，还是**整段对话**？
  - ☐ 无状态下，是否要把上一轮的 **`final_session_state_json` 原样回传**？
    （★ 最关键：决定我们要不要在 DB 存这坨 state 并逐轮回灌。）
  - ☐ 是否有 **locale / 语言** 参数？
- ☐ **一个"提交答案 → 拿评分"的完整调用示例**（输入 + 输出各一份）。
  （目前只有"出题"那一次的示例，缺"评分"这一次。）
- ☐ **`error` 与 `session_complete` 事件各一个返回示例**（编排归我们，但要知道 MCP 报错长什么样以做防御）。
- ☐ 确认 **MCP 侧是否也会自己返回追问（follow_up）**——若会，需与我们的语音追问对齐，避免抢主。

### 第 4 步（形态二两方案都问，同一个会一起敲定）

- ☐ **公网端点鉴权**：是否需要 **Token / 其他鉴权**？凭据如何提供给我们？
- ☐ 明确告知：候选人回答会**经公网传输到贵司机房**——因是贵司自有机房通常没问题，
  仅需在"数据边界"表述上与实际一致。

### 会后（我方内部动作）

- ☐ 把形态（一/二）、方案（A/B）与 schema 回填进本文档 §9 / §12。
- ☐ 若形态二：无论 A/B，先开工做**离线适配器原型**（§6）：解析 + public/private 拆分 + `display_text` 清洗
  + citation 文件名→id 映射（两方案都要用，不会白做）。
- ☐ 若形态一：仅需在现有 `ToolPicker` 里给目标 persona 挂上 MCP 工具并做一次连通性验证，几乎无开发。

---

## 12. 三条链路、各自的前提、以及工作量差异（供与客户讨论时记录）

§11 的形态一/形态二分叉，落到实现上其实是**三条**具体链路,而不是两条。中间那条(**hook 截取**)最微妙——
正是它让"挂个工具"听起来好像也能喂给我们的界面。本节把这个区别、决定每条链路是否可行的前提、安全边界差异、
以及工作量都记录下来——**明确用于与客户当面讲清**:客户需要理解"就挂上 MCP 工具"和"把结果显示在我们报告里"
是两个不同的诉求,成本和安全性都天差地别。

### 12.1 "hook"的想法从哪来

我们后端**本来就**在链路里当 relay:每一个 Azure 事件都会流经 `voice_live_proxy._forward_azure_to_client:256`,
之后才转发给浏览器。所以 hook 点**物理上是存在的**——可以在转发**之前**截住某个事件、抽字段、拆 public/private、
再发一个我们自定义的帧。**hook 点不是问题所在,问题是:这条流上到底流过来了什么。**

### 12.2 三条链路对照

| | **① 挂成 Foundry 工具** | **①+hook——在 relay 里截取工具返回** | **② 后端自己当 MCP client** |
|---|---|---|---|
| 谁调用 MCP | 云端大模型,自主决定 | 云端大模型(同①) | **我们后端代码**,按受控顺序 |
| 能拿到结构化 JSON 吗 | 不能——返回只进模型上下文 | **仅当** Azure Voice Live 把工具调用/返回作为事件推上代理 WS 流(**须实测——见 12.3**) | **能,完整拿到**,在进程内 |
| "读哪些字段/不读哪些"靠什么 | persona **prompt** 自然语言(软、可被 prompt injection 绕过) | 我们在 hook 处用代码(硬)**——但仅对展示副本**,见安全边界行 | **我们代码**(硬 split) |
| `final_session_state_json`(rubric/分数)暴露面 | 进**云端模型上下文** → 模型可能被诱导把 rubric 念出来(P3 风险) | **仍进云端模型上下文**(工具返回喂给了模型)→ 同样的 P3 风险;hook 只挡住"转发给浏览器"这条路,挡不住"被念出来"这条路 | **从不进任何 LLM**;在后端丢弃,连到浏览器的机会都没有 |
| 能否结构化展示进 F8 报告 | 基本不能 | **对截取到的那份副本**可以(渲染自定义帧) | **能**——原生映射进报告 DTO |
| 时序可控性(展示 vs 语音对齐) | 无(模型驱动) | 弱(模型决定何时调工具) | **完全可控**(我们按序调用) |
| 工作量 | **≈ 0**——在 `ToolPicker` 挂上,做一次连通性验证 | **低—中**——在 `_forward_azure_to_client` 加一个拦截分支 + public/private 拆分 + 自定义帧 + 一个小前端渲染;**前提是 12.3 为真** | **中**——在 source 接缝后写一个 `McpInterviewSource`(client + 解析 + 硬 split + `display_text` 清洗 + citation 文件名→id 映射 + 报告 DTO 映射);离线适配器原型(§6)是降风险的第一刀 |

### 12.3 决定"①+hook"是否成立的前提

**Azure Voice Live 会不会把 agent 的 MCP 工具调用/返回作为事件推到代理 WS 流上?** 目前这条流上跑的是
realtime 事件(`response.audio.delta`、`response.audio_transcript.delta`、avatar ICE/SDP、`response.done`)——
**不是**那坨原始 `final_session_state_json`。

- 若**会**(Realtime/Voice Live 协议里有 `response.function_call_arguments.*` / MCP 工具事件,portal 的工具调用轨迹暗示如此)
  → ①+hook 中间路线技术上成立:截住工具返回事件、抽出 `final_session_state_json`、后端 split、发自定义帧给 UI。
- 若**不会 / 只吐语音** → hook 只能看到被念出来的话,拿不到原始 JSON → 展示只能走②。

**动作:** 从 `azure-ai-voicelive` SDK 的事件枚举里确认(快、不需要客户)这条连接上有没有 MCP/function-call 事件。
这能把"待实测"直接变成"已知有/没有"。

### 12.4 为什么只要"不泄漏 rubric"是硬要求,②就仍是答案

即便 12.3 为真,①+hook 相比②仍有两个无法消除的硬伤:

1. **rubric 泄漏边界仍是软的。** ① 和 ①+hook 里,`final_session_state_json` 都被喂给了**云端模型**——
   所以模型仍可能被诱导把 rubric/分数说出来。hook 只守住"转发给浏览器"这条路,守不住"被念出来"这条路。
   ② 里这坨 state 从不接触任何 LLM。
2. **agent 得"愿意调"且"用得对"。** 工具的调用时机/用法由模型驱动、不由我们控;展示副本与语音节奏可能对不齐。
   ② 是我们代码的受控顺序调用。

**给客户的结论:** "挂 MCP 工具"(形态一、≈0 开发)**仅当结果由客户从自己的 server 取用、我们不解析不展示任何东西**时才成立。
一旦客户想把面试的分数/引用显示在**我们**报告里,或想要"rubric 绝不泄漏给候选人"的硬保证,那就是形态二/方案②——
一次真实的(中等)开发,不是一个配置开关。①+hook 中间路线只是可能的优化项,且仅当 12.3 成立,且**并不能关闭 rubric 泄漏边界**。
