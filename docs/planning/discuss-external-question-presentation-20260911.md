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

---

## 归属速查表

| 议题 | 现象 | 归属 | 状态 |
|---|---|---|---|
| 题量显示 | 引导页 "0 questions" | **我方 UI** | ✅ 已修（v0.37.1.4 / #83） |
| 进度条 | "第 X / 共 N" | **我方 UI** | ✅ 外部模式已隐藏 |
| 题目编号 | "Question 5:" 前缀 | **外部 workflow** | ⏳ 待客户确认是否去除 / 排查起始计数 |
| 题目措辞质量 | 问题不够好 | **外部 workflow** | ⏳ 待客户收集样例 + 调 prompt/知识 |

## 讨论要带走的三个问题

1. 外部面试**有没有固定总题数**？要不要给候选人看进度？（决定议题 1 是否收尾）
2. 候选人界面**要不要显示题目编号**？现在从 "Question 5" 起、且与作答顺序不符——是预期还是串号？（议题 2）
3. 对题目**质量**的具体不满 + 样例，反馈给 workflow 侧调优。（议题 3）

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
