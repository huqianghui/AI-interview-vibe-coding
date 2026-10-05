# 勾选「SOP 覆盖度」到底多评了什么：它评的是题目，不是候选人

> 2026-10-05。起因是一个看报告时的真实疑问：提交页那个 SOP 复选框勾了之后，报告底部多出一块
> "SOP coverage notes"，而评分一个数字都没变——那它到底在评什么？顺着这个问题把代码读了一遍，
> 发现除了"它评的不是候选人"这件事没讲清楚之外，还有两个真实的取数 bug（§5）。
>
> 这篇回答三个问题：
>
> 1. 它和正常打分的区别是什么？（§1）
> 2. checklist 每一条都已经绑定了 SOP 原文，为什么还需要再跑一轮？（§2）
> 3. 它要花多少钱、什么时候根本不花钱？（§3）

---

## 1. 两边评的不是同一件事，连输入都不重叠

|              | 正常打分（始终跑）                                                  | 覆盖审计（勾了才跑）                                      |
| ------------ | ------------------------------------------------------------------- | --------------------------------------------------------- |
| 输入         | 候选人回答 + checklist + 每条 item 的 SOP 片段（单条 ≤600，总 3000） | checklist + SOP 原文段落（总 ≤2400）。**不含候选人回答**  |
| 问的问题     | 这个人的回答，对 checklist 每一条达标了吗                           | checklist 自己，漏掉了 SOP 里要求的哪些点                 |
| 产出         | 4 态判定（met / partially_met / not_met / violated）+ 权重 + 分数    | 一串「SOP 要求、但 rubric 没覆盖」的点 + 原文片段         |
| 对分数的影响 | 它**就是**分数                                                      | **零**                                                    |
| 评的对象     | 候选人                                                              | **题库和评分标准本身**                                    |
| 代码         | `scoring_service.judge_prepared`                                    | `sop_coverage.prepare_coverage` + `audit_prepared`        |

最容易被误会的一行是"不含候选人回答"。审计的 prompt 构造函数签名就是证据：

```python
def _build_coverage_prompt(question_text, rubric_lines, passages) -> str:
```

没有 `answer_text`。所以它**根本不是在评这个人**——勾上它不会让你的回答被更严格地审查。

"零影响"不是声明，是有测试压住的：`test_coverage_check_on_appends_findings_without_changing_scores`
把同一套题跑两遍（关 / 开），逐题断言分数完全相同，总分也相同。

---

## 2. checklist 都绑了 SOP，为什么还要再跑一轮

**因为绑定是单向的，而你想知道的是反方向。**

绑定发生在建 checklist 的时候，它给的是：

```
每条 checklist item  ──→  一句 SOP 原文
                          (source_quote + source_document_id + source_page)
```

- 它保证：**checklist 里有的，都能追溯到 SOP。** —— 这是报告里每条判定旁边 "SOP source" 那一栏的底气。
- 它不保证：**SOP 里要求的，checklist 里都有。**

前者是"你凭什么这么评"，后者是"你有没有漏评"。**绑定只答得了前者。**

而正常打分路径在**设计上不可能**发现漏评：分数被刻意定义成"仅由 checklist 决定"的确定性函数——
这正是可追溯性的代价，也是 `enforce_and_score` 是个纯函数的原因。打分时模型拿到的 SOP 片段是
**按 item 分别给的**、每条最多 `SOURCE_CONTEXT_PER_ITEM_CHARS = 600` 字；它从来没有机会拿着
**整段** SOP 问一句"这里面还有什么没进 checklist"。

覆盖审计就是专门补这一个方向：拿整段 SOP（`COVERAGE_CONTEXT_CHARS = 2400`，比打分时任何单条
item 的 600 字都宽）对着**整份** checklist 比，找反向缺口。

### 一个真实例子

某次 rf-CSM 面试报告里，第 1 题（"Can you describe your role and responsibilities as Clinical
Study Manager on this study?"）的 findings：

- Specify that this SOP applies to BeOne-sponsored interventional clinical studies and the
  personnel and partners participating in the covered activities.
- Explain that outsourced site monitoring may follow a vendor's or CRO's SOPs when the SOW or
  contract provides for it.
- Distinguish activities outside this procedure's scope, including non-interventional studies,
  IIT/ISR and Clinical Pharmacology studies, and Pre-Study Site Selection Visits.

这三条在 SOP 原文里都是实打实的要求，但那一题的 rubric（权重 25 / 20 / 15 …）一条都没考。
**候选人把 rubric 全答满分，也不会被问到这些。**

这是**出题的缺口**，不是候选人的缺口 —— 所以它绝不能动分数，只能作为给题库作者的提示。
报告面板上那句 "For reference only … These do not affect your score" 就是这个意思。

---

## 3. 代价

每道**既有 checklist、又有绑定 SOP 文档**的题，多一次 LLM 调用。

**什么时候一次都不花**（`prepare_coverage` 返回 `None`，连 DB 之外的动作都没有）：

- 这道题没有 checklist；
- checklist 没有 item；
- 没有任何 item 绑定了 `source_document_id`（手写的 rubric）；
- 绑了但取不到正文。

这也是进度条分母的来源：**分母是真实的调用次数，不是题数**。9 道题里只有 4 道可审时，候选人看到的
是 "0 / 4"，不会停在 "3 / 9" 永远走不完。

**执行形状**（v0.45.0.0 之前这一段是完全串行、无超时、无心跳的，见 §5）：

- 先顺序做完所有 DB 读（`prepare_coverage`）—— `AsyncSession` 不能并发使用，所以必须先收口；
- 再把 LLM 调用**全部一起发出**：`scoring_concurrency(N)` 在 `SCORING_CONCURRENCY_DIVISOR`
  默认值 1 下等于 N；
- 单次调用走 `scoring_service.complete_with_retry`，和 judge 共用同一个 90s 预算 + 仅对瞬时错误
  退避重试。**这 90s 是实测过的**（`scripts/live_verify_sop_features.py --runs 6`，真 Azure
  gpt-5-mini，3 条 rubric 引 2 份文档、约 2.4k 字正文，顺序执行）：
  **min 8.5s / median 12.1s / max 17.0s**，90s 是最慢一次的 5.3 倍。它比一次 judge 调用
  （median 18.4s）更快——审计的输出只是一小串缺口，不是带引文的逐条判定集；
- 等待期间每 `SCORING_HEARTBEAT_SECONDS = 20` 秒发一个 `ping`，让连接不会空闲到被 ingress 掐断；
- 每完成一个发 `{"type":"coverage","done":i,"total":m}`，前端据此画第二条进度条。

**失败不会连带报告**：`audit_prepared` 对任何异常都退化成"没有发现"，`state_machine` 外面还有一层
兜底。它是参考信息，绝不能成为候选人丢掉已经挣到的报告的原因。

---

## 4. 怎么看出它跑了

- UI：评分页在"已按 SOP 评完 N / N 个回答"**下面**出现第二行"正在核对 SOP 覆盖情况 —— 已完成 i / m"；
  报告底部出现 "SOP coverage notes" 面板。
- 后端日志：审计 prompt 以 `COVERAGE_PROMPT_MARKER = "auditing SOP coverage"` 开头（mock adapter
  也是靠这个标记返回确定性结果，所以 CI 不碰 Azure）。
- 报告 JSON：`sop_coverage` 字段非空（仅在勾选**且**真的查出东西时才有）。

---

## 5. 两个取数 bug（v0.45.0.0 修）

读代码时发现的，都不是新引入的，都已修 + 有测试压住
（`test_the_audit_reads_every_cited_document_and_pairs_each_page_with_its_own`）。

### (1) 只审第一份被绑定的文档

旧代码 `document_id = next((it.source_document_id for it in items if it.source_document_id), None)`
——只取第一个。

**这条不是假设**：在默认题库上实测，**9 个绑定了来源的 checklist 里有 7 个绑了两份不同文档**。
也就是说大多数题目的审计一直在回答"rubric 覆盖了这份 SOP 吗"，同时**悄悄忽略另一份**；一条只存在于
被忽略那份文档里的要求，永远不可能被报成"未覆盖"。

现在按 rubric 顺序去重收集**全部**被引用的 (document, page)，逐份取正文。

### (2) page 标签可能来自另一条 item

旧代码用两个独立的 `next()` 分别取 `document_id` 和 `page_label`，**两者可能来自不同的 item**。
于是 A 文档会被 B 文档那条 item 的页标签切窄——而 `get_source_context` 是在该文档内部按标签过滤的，
所以读到的是 A 文档里**那条 item 从未引用过**的章节，并且 B 文档根本没被打开。

现在 (document, page) 按 item **成对**采集，页标签只用于定位它自己那份文档。

### 预算怎么切

总预算 `COVERAGE_CONTEXT_CHARS = 2400` 在被引用的文档之间**均分**，但不低于单份下限
`COVERAGE_MIN_PASSAGE_CHARS = 600`（和打分的单条 item 预算一致）。预算不够再多一份时**直接停**，
而不是给模型每份一小条——一小条支撑不起"这条要求 rubric 没覆盖"这种判断。按这两个数，一道题最多审
4 份文档；实测最忙的 checklist 引 2 份。

---

## 5.5 这一轮的真 Azure 验证

`DEFAULT_LLM_PROVIDER=azure python -m scripts.live_verify_sop_features --runs 6`（需要 `.env` +
`az login`）。脚本的 fixture 刻意引用**两份**文档，第二份里的"必须取得交接签名"故意不写进 rubric，
所以只有真的读了第二份文档才可能报出它。

本轮结果：

- `[C]` 带/不带原文注入，分数都是 50.0 —— 引擎不受 prompt 增强影响；
- `[D]` 5 条 findings，全部是真实缺口；
- `[E]` prompt 里 2 个 passage block、两份文档的正文都在；**6/6 次都报出了第二份文档的那条缺口**，
  证明多文档修复在真模型上生效，不只是字符串进了 prompt。

### 顺带踩到的坑：mock 复现不了真模型

同一轮里还抓到一个**单测完全测不出来**的回归。打分 prompt 把 item 编号成 `[1]`、`[2]`，而
真模型回的 `item_id` 形式**在不同调用之间会变**：

```
call 1:  "item_id": "[1]"     ← 照抄 prompt 里的 token，带方括号
call 2:  "item_id": 1         ← 裸 JSON 数字
```

一开始只接受裸数字，于是真模型第一种形式下 **3/3 判定全被丢弃**，两次 attempt 都失败，
`ScoringIncomplete`。单测全绿是因为 mock adapter 的正则 `^\[([^\]]+)\]` 抓的是**方括号内部**，
所以 mock 永远回裸数字——恰好是真模型不一定用的那种。

结论写进了 `_ORDINAL_RE` 的注释：解析要**宽容**（接受 `1` / `[1]` / `(1)` / `#1` / `1.`），
而不是去匹配某一种"标准"写法。以及：**这条路径的改动必须连真 Azure 跑一轮**，mock 绿不算数。

---

## 6. 相关文件

| 文件                                        | 作用                                                  |
| ------------------------------------------- | ----------------------------------------------------- |
| `backend/app/services/sop_coverage.py`      | 审计本体：prompt、取正文、预算、解析                  |
| `backend/app/services/sop_context.py`       | 按 (document, page) 重组 SOP 原文切片                 |
| `backend/app/interview/state_machine.py`    | Phase 3（并发审计 + 进度事件）、Phase 4（按题库序聚合）|
| `backend/app/services/scoring_service.py`   | 正常打分；`complete_with_retry` 是两边共用的 90s 上界  |
| `frontend/src/components/ReviewView.tsx`    | 提交页那个复选框（默认关）                            |
| `frontend/src/components/ReportView.tsx`    | 报告底部 "SOP coverage notes" 面板                    |
| `backend/tests/test_sop_source_features.py` | 特性 C（打分注入原文）+ 特性 D（本审计）的全部测试    |
