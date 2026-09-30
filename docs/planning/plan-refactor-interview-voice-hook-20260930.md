# 拆分 `useInterviewVoice`（1608 行单函数）

> **状态：计划，未开工。** 排在 `fix/avatar-recovery-rate-limit` 与后端 CAS 之后，因为它要动的正是那两批改过的文件。
> 来源：v0.40.0.0 可维护性评审（`TODOS.md`，P3）。

## 为什么值得做，以及为什么它不紧急

这个 hook 现在在一个函数体里同时承担：WebSocket 生命周期、麦克风采样率校验、首读门控、回合状态、
以及媒体模式的整会话重建。`handleMessage` 单独一个 switch 就是 482 行（523–1005）。

它不紧急，因为它能正常工作。它值得做，因为 v0.40.0.0 里那个**确定性丢草稿的 bug 就出在这里**：
`restartForMediaMode` 小心保住了候选人正在说的答案，三行之后 `connect()` 又把它擦掉了。那不是粗心，
而是"保住草稿"的语义散落在两个相距 700 行的函数里，谁都看不见对方。把它收进一个有自己测试的单元，
是对那一类 bug 的结构性回答，不是审美问题。

## 明确不做

- **不重写 `handleMessage` 的 switch。** 它长，但它是一条按 Azure 事件类型分发的平铺表，可读性尚可，
  而每个 case 都摸好几个 ref——现在动它风险远大于收益。
- **不追求"行数达标"。** 目标是让一组语义有边界、有测试，不是把 1608 行摊到五个文件里看起来短一点。
- **不改任何对外行为。** 这是纯重构：前端 338 个测试必须一个不改地继续通过（新增测试可以加）。

## 第一步（本次范围）：抽出"答案草稿与提交"

这是唯一一个边界干净、且恰好覆盖出过事的那段语义的簇。

**它拥有的状态**（目前散在 314–360 行）：`pendingCommitRef`、`userSegmentsSinceCommitRef`、
`silenceAutoCommitTimerRef`、`judgeTimerRef`、`userLiveTranscriptRef`、`assistantLiveTranscriptRef`。

**它拥有的行为**：`clearSilenceAutoCommit`、`clearJudgeTimer`、`settlePendingCommit`、`peekDraft`、
`commitAnswer`，以及 `resetTurnState` 里**属于草稿的那一半**——包含 `keepDraft` 语义：
不保留时清空 segments；保留时先把"永远不会再收到 `.completed`"的那些 partial 折进草稿，
再清 partial 累加器。

**新模块** `frontend/src/hooks/useAnswerDraft.ts`，契约大致是：

| 成员 | 作用 |
|---|---|
| `peek()` | 目前的草稿文本 |
| `pushSegment(text)` | 一段已完成的用户转写 |
| `notePartial(itemId, text)` / `clearPartial(itemId)` | 流式片段 |
| `reset({ keepDraft })` | 回合重置，`keepDraft` 的折叠逻辑在这里 |
| `commit()` | 现在的 `commitAnswer`，需要注入 `send`（依赖因此变显式，这正是目的） |
| `settlePending()` | 结算一个等不到转写的 commit |
| `armSilenceAutoCommit` / `clearSilenceAutoCommit` / `armJudge` / `clearJudge` | 两个定时器 |

`resetTurnState` 保留在原 hook 里，改为调用 `draft.reset(opts)` 再做朗读侧的那一半。

**预期**：从 1608 行搬走约 200 行，并且 `keepDraft` 这个语义第一次有了自己的测试边界。

## 之后（不在本次）

第二步是"朗读与首读确认"簇（`speakWatchRef`、`firstReadGateRef`、`readDirectiveRef`、
`resumeSpeakTextRef`、`avatarReadyRef`、`emitSpeak`/`speakAside`/`speakQuestion`，约 300 行）。
它更大、且和 Azure 的 response 生命周期纠缠更深，值得单独一个 PR。

麦克风采样率校验也可以抽成纯函数，但它只有约 15 行消息拼装，收益小，顺手做即可，不单列一步。

## 验证

- `npm run test`：现有 338 个测试**不修改**地通过。任何需要改现有测试的地方，都说明行为变了，要停下来。
- `npm run lint` 与 `npx tsc --noEmit`（前端三道门分开跑，lint 会抓到重构后残留的失效依赖数组——
  v0.40.0.0 就是被它抓到的）。
- 新增 `useAnswerDraft.test.ts`：至少覆盖 `keepDraft` 的两个方向、partial 折叠、以及
  `settlePending` 让悬挂的 `commit()` 不再永久等待。
- 真 Azure 冒烟：`bank-linear-restart-live` 走一遍完整回合，确认提交与推进没有回归。

## 风险

改的是全应用最敏感的文件，且没有任何用户可见收益——这就是它排在最后的原因。
缓解方式是一次只搬一簇、每簇跑满三道门，以及"现有测试不许改"这条硬线：
它把"重构"和"顺手改行为"这两件事强行分开。
