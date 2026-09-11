# 讨论记录：外部 API 模式下的"问题呈现"（题量 / 编号 / 措辞）

**日期**：2026-09-11（下午与客户讨论用）
**背景**：阶段一本地联调（连的是**已配置的外部 API 网关**，默认 persona "Interviewer" 的
`interview_brain=external`）时暴露的几处与"问题怎么显示给候选人"相关的现象。逐条列出
**现象 → 归属（我方 / 外部 workflow）→ 待决**，方便直接对着谈。

> 注：本文件入库，遵循仓库的"厂商中立"约束——不写具体网关域名 / 产品名，只以"外部 API / 外部
> workflow"指代。真实 endpoint + key 只存于本地 `.env` / DB，不进公共仓库。

> 一句话前提：外部模式下，**问题文本由外部 workflow 返回，我方原样呈现，不裁剪不改写**（P3/P12 约束 +
> "不篡改外部内容"）。因此凡是问题**内容/措辞/编号**层面的事，主动权在客户的 workflow 侧；凡是**外壳
> UI**（进度条、引导页文案）层面的事，在我方侧。下面按这条线归类。

---

## 议题 1 — 题目数量（question count）

**现象**：外部模式下引导页原本显示 "You'll answer **0** questions"。

**根因**：外部 brain 不暴露固定题量（面试官逐题即兴引导），而引导页文案硬插了题数 `{{total}}`，外部会话
下 `total=0`。

**归属 / 处置**：**我方 UI 问题，已修复**（v0.37.1.4 / PR #83，已并入 main）。外部模式改用不含题数的文案
`orientation.bodyExternal`（中英双语："面试官会逐题引导你完成对话……"），顶部题号进度条在外部模式下也已
隐藏（`!isExternal` 才渲染）。题库模式不受影响。

**与客户确认**：
- 外部这套面试**是否有确定的总题数**？如果有（例如固定 9 题），客户希望候选人看到进度（"第 X / 共 N 题"）
  吗？若要，需要外部 workflow 在返回里带上一个总数字段，我方才能显示——否则我方无从得知题量。
- 若外部就是**开放式、不定题量**，那当前"隐藏题数 + 逐题引导"的呈现即为最终形态，无需再改。

---

## 议题 2 — 题目编号（"Question 5:" 前缀）

**现象**：候选人看到的问题是 `Question 5: How do you oversee regional training compliance?`——文本自带
"Question 5:" 编号。

**证据**（本地最近一次外部会话 `abe5d35a`，`brain_mode=external`，有真实 `conversation_id`）：
`interview_turns` 里 `turn_index=0` 的 interviewer turn，`content` 原样就是
`"Question 5: How do you oversee regional training compliance?"`。注意我方 `turn_index=0` 而文本却是
"Question 5"——说明**这个编号完全是外部 workflow 那侧自己的计数**，与我方题号无关。

**归属 / 处置**：**外部 workflow 侧的输出措辞**。我方不应裁剪/改写外部返回的问题文本。

**与客户确认**：
- 是否希望候选人界面**出现 "Question N:" 这样的编号**？
  - 若**不希望**：需在客户的 workflow 里去掉问题文本的编号前缀（我方不动）。
  - 若**希望**：保持现状即可，但要注意编号是外部自己的计数，可能与实际作答顺序不完全对应（如本例
    turn 0 = "Question 5"），需客户确认这是预期行为还是 workflow 状态串号。
- 编号从 5 起（而非 1）是否正常？—— 提示可能是 workflow 的会话状态/计数没有从头初始化，值得客户排查一下
  他们那侧的 conversation 起始逻辑。

---

## 议题 3 — 题目措辞 / 质量（"题目变好"）

**现象/诉求**：希望问题本身的措辞、专业度、贴合岗位程度更好。

**归属 / 处置**：**外部 workflow 侧的 prompt / 知识内容**。问题的生成逻辑、用词、难度、与岗位 SOP 的贴合
度，全部由客户的 workflow 决定；我方只负责忠实呈现与（内部、不外露的）评分侧。

**与客户确认**：
- 客户对当前问题质量的具体不满是什么（太泛 / 不够专业 / 与岗位无关 / 语言风格）？收集具体样例，反馈给
  workflow 维护方去调 prompt 或知识库。
- 语言：默认 en-US（我方 v0.36.0.0 起的全局默认），外部 workflow 返回的问题语言是否需要与界面语言一致？
  目前问题语言由外部返回内容决定。

**追问行为（decided：方案 A —— 追问归外部 workflow）**：
- 诉求：面试官应"围绕当前主题 + 基于候选人的回答，谨慎追问一两个问题，其他情况一概不说"。
- 归属：**这属于外部 workflow 侧的逻辑，不在我方本地 agent。** 正确链路是：候选人答完 → 我方把回答回传外部
  workflow → workflow 自行决定是否追问 → 返回下一轮的 `speech_text`/`display_text`（可能是追问、也可能是
  下一题），我方原样读。这样追问**会被外部评分、表头/口播同步、状态 blob 一致**。
- 为什么不放在我方本地 agent：本地即兴追问本质上等于让 agent 自己产 turn，会重新引入重复气泡（原 issue3）+
  表头不同步（原 issue4），且这些追问外部 brain 不知情、不评分、状态对不上。agent 模式下有**两条**让 agent
  即兴的路径，都已在我方侧关闭：(1) server-VAD 自动回话 `create_response=False`（v0.37.1.6）；(2) 候选人点
  "我说完了"时 `commitAnswer` 发的裸 `response.create`——external 模式下已跳过（v0.37.1.7，前端 `externalMode`
  开关）。两条都堵上后，external agent 永远只当"嘴"，只读后端注入的 `speech_text`。
- 待客户落实：把"围绕主题 + 基于回答、追问 1–2 次、其他不说"这套策略写进他们的 workflow prompt。

---

## 议题 4 — 推进到下一轮的交互方式（答完 → 调外部 API）

**背景**：外部模式下，"下一题 / 追问"由外部 workflow 决定（见议题 3 方案 A）。链路是**候选人答完 →
我方把回答回传外部 workflow → 返回下一轮**。也就是说：**候选人每答完一轮，就要触发一次外部 API 调用**。
那么"什么时候算答完了"这个**回合边界**该怎么判定，就成了交互设计问题。

**关键点（技术前提）**：外部 API 是**请求/响应式**的，只收**最终文本**——它**听不到**候选人的实时语音。所以
"这一轮答完了"这个边界，**本质上只能由我方（前端 + 语音端点检测）判定**；外部只负责"答完之后说什么"（追问 or
下一题）。换句话说，是否保留"我说完了"按钮，**不影响追问归属**——追问永远在外部；按钮只是**判定回合边界的一种
UI 形式**。

**已定方案（我方，语音模式）——静音自动提交 + 保留按钮**：
- 候选人停止说话后，若**持续静音约 3 秒**（其间只要再次开口就重置计时），我方**自动提交**本轮回答 → 调外部
  API → 进入下一轮，营造"自动对话"的连贯感。
- "**我说完了**"按钮**保留**，作为**立即提交**的手动兜底（想马上进入下一轮就点它，不必等 3 秒）。
- 提交期间麦克风已自动静音（外部这一轮"思考中"），所以自动提交后不会被环境音重复触发。
- 语音端点检测本就会把一次回答拆成多个语音片段（中途停顿），我方**先缓冲拼接**再提交，避免把一句话拆成
  几次调用——这正是"3 秒静音"而非"一停就提交"的原因。
- 文字模式不受影响：仍是点"提交"。

**归属 / 处置**：**我方 UX**（回合边界判定）。追问内容仍归外部 workflow。

**与客户确认**：
- 这个"**每答完一轮就调一次外部 API**"的节奏，外部 workflow 侧是否 OK？是否需要**限流 / 防抖**（例如
  同一状态短时间内重复提交的保护）？
- **3 秒静音**这个宽限阈值是否合适？（太短→候选人中途思考就被提前提交；太长→衔接显得迟钝。）**当前先按 3 秒
  硬编码实现**；是否需要把它**做成可配置项**（按 persona / 岗位 / 甚至候选人语速调），也请下午一并商量——
  若客户确认 3 秒够用就维持常量，避免过度设计。

---

## 归属速查表

| 议题 | 现象 | 归属 | 状态 |
|---|---|---|---|
| 题量显示 | 引导页 "0 questions" | **我方 UI** | ✅ 已修（v0.37.1.4 / #83） |
| 进度条 | "第 X / 共 N" | **我方 UI** | ✅ 外部模式已隐藏 |
| 题目编号 | "Question 5:" 前缀 | **外部 workflow** | ⏳ 待客户确认是否去除 / 排查起始计数 |
| 题目措辞质量 | 问题不够好 | **外部 workflow** | ⏳ 待客户收集样例 + 调 prompt/知识 |
| 重复气泡 | 同一题读两遍 | **我方** | ✅ 已修（v0.37.1.6，external persona `create_response=False`）|
| 表头/口播不同步 | 上下题不一致 + 元指令泄漏 | **我方**（架构 bug）| ✅ 已修（v0.37.1.9，见下方根因说明）|
| 本地即兴追问 | agent 自己引用候选人回答追问 | **我方**（bug）| ✅ 已修（v0.37.1.7，external 模式 `commitAnswer` 不再发裸 `response.create`）|
| 追问行为（想要的） | 围绕主题追问 1–2 次 | **外部 workflow**（方案 A）| ⏳ 待客户写进 workflow prompt |
| 回合边界 / 推进 | 答完自动进入下一轮 | **我方 UX** | ✅ 方案定：静音自动提交（~3s）+ 保留"我说完了"按钮 |

### 根因更正（v0.37.1.9）——"表头/口播不同步"不是 display 投影 bug，是**两个大脑**

> 早前把这条并进 v0.37.1.6 的 `create_response=False` 是**错的归因**（该 fix 只关掉了 model 模式下的
> server-VAD 自动回话，对托管 agent 的自主编排毫无作用），所以问题一直复现。真正根因如下：

默认 `Interviewer` persona 同时有 `interview_brain=external`（外部 workflow 出题）**和**一个残留的托管
Foundry `agent_id`。而语音连接层（`voice_live_proxy.run_proxy` + `voice_broker.create_voice_session`）**只**
按 `bool(persona.agent_id)` 决定连 **agent 模式**还是 **model 模式**。于是 external 会话连成了 agent 模式 →
**挂上了一个托管面试官 agent，成了第二个独立大脑**：

- 表头走的是外部 workflow 的 `display_text`（"Question 2: …"）；
- 口播/转录气泡是数字人**实际说出的音频**，来自那个托管 agent 自己题库里的问题（"Question 4 of 9: …"）。

两个大脑各说各的 → 表头与转录对不上，并顺带产生"Please answer the question:"元指令泄漏、"Could you
clarify…"即兴追问。**这也修正了议题 3 里"两条即兴路径都堵上后 external agent 只当嘴"的旧说法**——只要 agent
还被挂上，它就有自己的大脑；正确做法不是继续堵它的即兴路径，而是**根本不挂 agent**。

**修复（正确不变量）**：`interview_brain == "external"` 时，连接层强制 **model 模式**（忽略 `agent_id`，用
plain `voice_live_default_model`），Azure 侧变成一张纯"嘴"，只读后端注入的 `speech_text`，永不成为第二个大脑。
两条语音路径都改了，两处 P5 `agent_sync_status` gate 对 external 跳过（既然不用 agent，就不该要求它 synced）。
数字人头像不受影响（其配置与 agent/model 选择无关）。

## 讨论要带走的四个问题

1. 外部面试**有没有固定总题数**？要不要给候选人看进度？（决定议题 1 是否收尾）
2. 候选人界面**要不要显示题目编号**？现在从 "Question 5" 起、且与作答顺序不符——是预期还是串号？（议题 2）
3. 对题目**质量**的具体不满 + 样例，反馈给 workflow 侧调优。（议题 3）
4. **每答完一轮就调一次外部 API** 这个节奏 workflow 侧 OK 吗（是否要限流/防抖）？"**静音 3 秒自动提交**"这个
   阈值合适吗、**要不要做成可配置**？（议题 4）

---

## 附：「content」还是「display」——这块的设计与实现

> 起因：讨论中被问到"候选人看到的到底是原始 question content 还是一个单独的 display content？"下面把外部
> 模式下问题文本的产出 / 落库 / 呈现讲清楚，作为归属判断的技术依据。

**一句话结论**：候选人**看到**的是外部 workflow 返回的 `display_text`（展示内容），**听到**的是另一个字段
`speech_text`。两者都由外部返回、我方原样呈现；我方唯一的加工是**剥掉一个内部编号前缀**，不裁剪、不改写题目措辞。

### 外部返回：一个"内容"，两种呈现

外部 workflow 每一轮在 `public_response_json` 里返回一对候选人安全字段
（`backend/app/services/external_interview_client.py`，约 71–77 行）：

| 字段 | 用途 | 谁消费 |
|---|---|---|
| `speech_text` | 数字人 TTS **读出来**的文本 | 语音通道 |
| `display_text` | 候选人**屏幕上看到**的文本 | UI 显示 |

即：这不是"content vs display 二选一"，外部本来就返回**两个并列字段**，一个给耳朵、一个给眼睛，措辞可以不同，
但都由外部那侧决定。此外还返回一个 `final_session_state_json`（不透明状态 blob，携带评分 / rubric）——**永不
回传浏览器、永不进 LLM**（P3/P12），只在后端 round-trip。

### 我方唯一的加工：剥编号前缀，不动措辞

`scrub_display_text()`（`external_interview_client.py` 约 83–95 行）对 `display_text` 做**唯一一处**清洗：只匹配
**开头**的 `<CODE>-Q<digits>` 形状的**内部 id 前缀**（如 `RFCMS-Q03 — …`、`ABC_Q7: …`），去掉它，没有该前缀
则原样返回。`speech_text` 完全不清洗。目的是不让客户内部题号编码泄露到候选人界面——**不碰题目正文措辞**。

> ⚠️ 与上文议题 2 区分：`scrub` 砍的是 `RFCMS-Q03` 这种**内部 id 编码**；而 `Question 5:` 是外部 workflow 自己
> 写进题面的**人类可读编号**，我方不动它（是否去除仍待客户确认）。

### 落库与投影（后端）

1. `_public_snapshot` 把 `speech_text` + `display_text` 一起存进状态快照，供静默恢复重放。
2. 写 `interview_turns` 的 interviewer turn 时，`content` **只存 `display_text`**——绝不写 `speech_text`，
   绝不写状态 blob。
3. `current_question()` 投影给前端的 `prompt` 取值：`display_text or speech_text or ""`——**优先 display_text，
   缺失才回退 speech_text**。

### 前端消费

- **显示**：`currentPrompt = interview.current_question.prompt`（`InterviewPage.tsx`），渲染在题面 `{q.prompt}`。→ 即 `display_text`。
- **语音 TTS**：`speakText = isExternal ? interview.speech_text ?? currentPrompt : currentPrompt`。→ 外部模式读 `speech_text`，题库模式读 prompt 本身。

### 数据流

```
外部 workflow
  └─ public_response_json { speech_text, display_text }
        ├─ speech_text  ──────────────────────────► 前端 speakText ──► 数字人 TTS（耳朵）
        └─ display_text ─(scrub 只剥内部 id 前缀)──► turn.content / current_question.prompt ──► 屏幕（眼睛）
     final_session_state_json ─────────────────────► 后端状态 round-trip（永不出后端 / 永不进 LLM）
```

**归属呼应**：题目"内容 / 措辞 / 编号"的主动权都在客户 workflow 侧（他们决定 `speech_text` 与 `display_text`
各写什么）；我方只做两件事——(1) 忠实呈现，(2) 剥一个内部 id 前缀，并把评分状态 blob 关在后端。
