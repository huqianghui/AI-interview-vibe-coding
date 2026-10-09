# Planning trail

The planning documents behind this project, promoted from local gstack artifacts
(`~/.gstack/projects/…`) into the repo so the full trail travels with the project and is
reviewable in version control.

These are **historical planning artifacts**, captured in build order. The authoritative,
living specification is [`../../SPEC.md`](../../SPEC.md) at the repo root — start there.

## The trail (chronological, 2026-08-07)

1. **[design-office-hours.md](design-office-hours.md)** — the initial design / brainstorm doc
   (from a `/office-hours` session). Product framing, the winning-demo definition, who's in the
   room, early scoping. This is the "why" before the "what".

2. **[spec-draft-preautoplan.md](spec-draft-preautoplan.md)** — the first technical spec draft
   (from `/spec`). Features F1-F9, quality bar, tech stack, dependency graph. Ends at
   "§10 Open items for /autoplan review" — i.e. **before** the review gate.

3. **[autoplan-review.md](autoplan-review.md)** — the `/autoplan` review restore point: the
   CEO / engineering / design review findings and owner decisions that ran against the draft.

4. **[`SPEC.md`](../../SPEC.md) (repo root, authoritative)** — the finalized spec. It is the
   superset of the draft above: it folds the autoplan output into **§11 Review patches (P1-P16)**
   and **§12 Owner decisions**. When the draft and this disagree, `SPEC.md` wins.

## Spec lineage in one line

`design-office-hours` → `spec-draft-preautoplan` → (`/autoplan` review) → **`SPEC.md`** (committed, authoritative).

## Post-spec feature specs

- [`spec-sop-libraries.md`](spec-sop-libraries.md) — SOP 文档库：每个文档属于一个文档库，上传前选定；题库绑定一个
  文档库，生成 / 重新定位 / 手动引用都只在该库里进行；没绑定的题库用通用提示词评估；去掉 AI 主题判断。
- [`spec-sop-section-grounding.md`](spec-sop-section-grounding.md) — 评分标准引用真实的 SOP 章节原文（完整章节，
  不截断）+ 每份 SOP 的要点摘要；替换 AI 生成评分标准时的 mock 检索。
- [`spec-bank-versioning.md`](spec-bank-versioning.md) — 题库版本：一套题目 + 一套评分标准作为一个整体冻结，
  任何修改都生成新版本；取代 spec-rubric-versioning（v0.52.0.0 只冻结了评分标准）。
- [`spec-rubric-versioning.md`](spec-rubric-versioning.md) — immutable rubric versions: chosen at
  user assignment (default latest), pinned on the interview at start, read by scoring, the coverage
  audit and the SOP-citation guard; also fixes the editor dropping SOP links and advisory flags.
- [`spec-real-azure-integration.md`](spec-real-azure-integration.md) — Phase 1 real-Azure integration
  via the `/admin` DB config page (model + Foundry IQ knowledge-base dropdowns from the Foundry API,
  real agent + LLM + retrieval, P1 security fix). Filed as epic #18 with children #19 / #20 / #21.

- [`spec-voice-live-agent-contract.md`](spec-voice-live-agent-contract.md) — the exact, live-verified
  Azure Voice Live **agent-mode** contract that makes `/interview` "语音作答" connect the interviewer's
  Foundry prompt agent over WebRTC (Lisa digital-human appears + the agent speaks). Captures the
  signaling URL shape (hyphenated `agent-name`/`agent-project-name` keys — the core fix), Entra auth
  scope, agent metadata single-key rule, runtime `session.update` trimming, plus an error→cause table
  and a copy-paste regression checklist. Shipped v0.23.1.0. **Read this first if voice regresses.**

- [`spec-per-persona-knowledge.md`](spec-per-persona-knowledge.md) — per-persona Foundry IQ knowledge:
  configure each interviewer persona's own knowledge bases in the `/admin/agent` Knowledge section
  (connection → KB connect dialog), bound to that persona's Foundry agent as authenticated MCPTools
  on sync. Retires the single global KB → agent binding (F1 SOP scoring retrieval unchanged). Ported
  in shape from AI-Coach's per-HCP KB feature. Shipped v0.24.0.0.

- [`design-B-checklist-mandatory-20260818.md`](design-B-checklist-mandatory-20260818.md) — every
  question always has a non-empty, human-editable **scoring checklist** (F3b). Root fix for reports
  showing "占位评分 / coverage 0%": checklist is auto AI-generated **from the question text itself**
  (SOP-optional) at question-create time, with a system-level non-empty fallback; the already-built
  `editChecklistItems` PUT is wired into AdminPage as an editable form (kind/text/weight/add/delete/
  save, re-normalized to 100); empty → one-click regenerate; entry-point discoverability fixed. Zero
  Azure (mock provider testable), P3 candidate boundary untouched. Out of scope (separate backlog):
  admin three-tab layout, SOP-upload frontend UI (backend `POST /admin/sop/documents` exists but has
  no frontend). Approved 2026-08-18 via `/office-hours`.

- [`spec-voice-transcript-race-explicit-submit.md`](spec-voice-transcript-race-explicit-submit.md) —
  fixes the on-device report defects ("未作答" blank + off-by-one order) rooted in one frontend race:
  a voice answer was submitted before its async STT transcript landed. `commitAnswer()` now returns a
  `Promise` resolving this turn's transcript (fail-closed on timeout/teardown). Adds a pre-scoring
  **review** phase (`GET /{id}/review` + `ReviewView`) so the last answer no longer auto-scores —
  scoring starts only on an explicit **提交并评测** click — plus three-layer empty-answer rejection
  (also fixes a verbal-cue-strips-to-empty bug). Backend unchanged in shape (pairs by `question_id`).
  Approved via plan mode; shipped v0.30.0.0.

- [`spec-mece-classification-scoring.md`](spec-mece-classification-scoring.md) — extends F4/F8 from
  an A–F letter grade to a client-facing **classification rating** (*Meets Expectations / Needs
  Improvement / Does Not Meet*) driven by six weighted MECE dimensions, with **critical-error
  capping** and a **pending-conflict disclosure exemption**; adds per-question weighting (weighted
  interview mean, fixing the prior simple-average gap) and a **deploy-time importer** that F1-ingests
  a real inspection-interview document set and authors each rubric programmatically with true SOP
  source binding — all into the gitignored DB, with no client content in any committed file.
  Approved via plan mode; shipped v0.31.0.0.

- [`plan-weaknet-media-resilience-20260930.md`](plan-weaknet-media-resilience-20260930.md) — weak-network
  media resilience: on a lossy link the digital human's video and the interviewer's VOICE share one RTP
  transport, so the picture starves the voice (measured: 31% of speech synthesised by packet-loss
  concealment at 3% loss, candidate cannot hear the question). Plan: sample `getStats()` and **give up
  the picture to keep the voice**, with hysteresis, a manual override, and a 24→16 kHz mic-uplink cut;
  explicitly rejects bitrate tuning (Azure already adapts and ignores mid-session changes) and
  `freezeCount` as a health metric (it reads *better* when 1080p decodes nothing). Approved via plan
  mode; shipped v0.40.0.0. Two Azure constraints found during implementation changed the transition
  mechanism — see the status banner in the doc, and
  [`../avatar-weaknet-probe.md`](../avatar-weaknet-probe.md) §5 for what actually shipped.

- [`plan-refactor-interview-voice-hook-20260930.md`](plan-refactor-interview-voice-hook-20260930.md) —
  **planned, not started.** `useInterviewVoice` has accreted to 1608 lines in one function body (WS
  lifecycle, mic-rate validation, first-read gating, turn state and the media-mode session rebuild),
  with a 482-line `handleMessage` switch. The case for splitting it is not line count: v0.40.0.0's
  deterministic draft-loss bug happened precisely because "keep the candidate's answer" lived in two
  functions 700 lines apart that could not see each other. Step one extracts the **answer draft and
  commit** cluster (the `keepDraft` semantics included) into `useAnswerDraft.ts`; the read/speak
  cluster is a separate later PR. Explicitly NOT rewriting the `handleMessage` switch, and the hard
  line is that the existing 338 frontend tests must pass **unmodified** — a test that needs changing
  means behaviour changed, which is not a refactor.

- [`spec-external-mcp-interviewer-integration.md`](spec-external-mcp-interviewer-integration.md) —
  **analysis / NOT approved, blocked on client answers.** A client-provided MCP result sample
  (`final_session_state_json` / `public_response_json` / `speech_word_count`) turns out to be a
  **parallel implementation of the same rf-CSM interview** our F4/F6 already ship — so integrating
  it is a "who owns the brain" decision, not an "add a tool" task. Documents the field-level
  correspondence to our engine, the data problems (double-JSON encoding, `RFCMS-Q0x` id leak in
  `display_text`, results≠covered mismatch, missing answer-submission contract + session id,
  file-name-not-document-id citations that break clickable SOP links), and why attaching it as a
  Foundry-agent tool (Path 1) is a trap vs. backend-as-MCP-client (Path 2). Ends with the blocking
  questions to bring back to the client. Pre-implementation gate. Chinese counterpart:
  [`spec-external-mcp-interviewer-integration.zh-CN.md`](spec-external-mcp-interviewer-integration.zh-CN.md)
  (content-aligned, plus a client-ready 10-question confirmation checklist in §附).

- [`design-external-interview-brain-integration.md`](design-external-interview-brain-integration.md) —
  **APPROVED 2026-09-04 (Phase 2), realizes + amends the analysis spec above.** The client shipped
  their own interview brain behind a public gateway (`.../difyAgent/runWorkflow/streaming`,
  SSE + hex-encoded `inputs`), live-tested E2E on 2026-09-04. This `/office-hours` design integrates
  it as a **second, per-persona interview mode** beside the untouched built-in bank (Approach B: a
  parallel `external_runner` + `external_interview_client`, never a Foundry-agent tool). Key
  amendment to §14.4: the delivered API is **stateless** (proven by a reset control experiment), so
  we persist and round-trip the opaque `session_state_json` blob ourselves — backend-only, never to
  the browser (rubric-leak boundary). Carries the Codex hardening list: commit-before-speech, a
  submit-time CAS turn reservation (409s a second distinct answer before it can call the brain),
  pending-answer dedup, silent replay-on-resume, `external_phase` recovery sub-state (stays
  `in_progress` so existing resume works), and a fake-server chaos suite. **Vendor-neutral by owner
  directive** — code/config/UI say "external interview API/server", never the product name. v1 does
  no local scoring (results stay client-side); ships the connection config as the seeded default
  with a masked/click-to-reveal key. Converged after 2 adversarial review rounds (8/10). The four
  once-open client questions were **resolved internally** (owner, 2026-09-04): prod key entered by
  admin (test key never promoted); bounded auto-retry on the idempotent assumption (stateless API +
  retry-from-committed-state can't fork); generous default timeout tuned from first live run; only
  next-question/`session_complete`/`error` consumed. No client message owed. **Passed
  `/plan-eng-review` and LOCKED 2026-09-04** (grounded in the real repo; see the `## GSTACK REVIEW
  REPORT` appended to the design doc): full scope confirmed; owner accepted the ephemeral-SQLite
  durability boundary (crash-recovery holds within one container lifetime only) and kept
  click-to-reveal as a bounded exception (external key only, admin-JWT + plaintext-never-logged;
  audit/rate-limit are net-new SHOULDs). Impl notes folded: async httpx + add `httpx-sse`, hand-rolled
  atomic-UPDATE CAS (`version_id_col` withdrawn) + aiosqlite `busy_timeout`. Next: build Slice 1.

- [`plan-external-reader-prompt-20260911.md`](plan-external-reader-prompt-20260911.md) —
  **LOCKED 2026-09-11 (`/plan-eng-review`), extends the external-brain design above.** Gives the
  interviewer persona **two independent, separately-stored, separately-editable** prompt config
  items: the existing `prompt_fragment` (bank-mode → Foundry agent `instructions`) and a NEW
  `external_reader_prompt` (external-mode → shapes how the pure "mouth" reads the injected
  `speech_text`). Owner's decisive constraint: once both exist they are **two independent nullable
  columns**, not one field the `interview_brain` toggle swaps — switching brain back and forth
  never destroys the other's content. Delivery = a connect-time **system conversation item**
  (`build_reader_prompt_item`, parallel to `build_language_pin_item`) injected in
  `voice_live_proxy.run_proxy` after the language pin when `is_external`, since external = MODEL
  mode with no agent (v0.37.1.9) and Azure rejects `instructions` overrides in `response.create`.
  Six locked decisions: NULL = "use generated default" (`default_external_reader_prompt(name)`,
  always injected); **proxy-only** (WebRTC broker/admin-Playground permanently out of scope —
  owner's post-ship ruling 2026-09-11: the Playground broker is a connectivity smoke check only,
  not a functional test point, so it needs no reader-prompt/language-pin injection and no follow-up
  is owed); `reconcile_persona`
  never touches the new column; additive/dormant column, no backfill; editor shows only the active
  mode's field. New migration `f6a7b8c9d0e1` (`down_revision = "e5f6a7b8c9d0"`, confirmed head).
  Five implementation threads (model+migration / service CRUD / connect-time injection / frontend
  editor / tests). **SHIPPED v0.37.2.0** — all five threads landed; migration `f6a7b8c9d0e1` at head.

- [`spec-azure-cicd-deploy.md`](spec-azure-cicd-deploy.md) — the CI/CD + Azure deployment plan
  (Container Apps, **Sweden Central**, co-located with the reused Foundry resource). Mirrors the
  sibling AI-Coach infra but simpler: **managed-identity** auth throughout, **ephemeral SQLite**
  reseeded every boot (no DB PaaS), and **boot-time self-seeding** in `backend/entrypoint.sh`
  (`alembic upgrade head` → optional private-blob client-bundle fetch+import → `uvicorn`) — which
  replaces the reference's separate bootstrap Job (a Job's disk can't seed the app replica's
  per-replica SQLite). The gitignored client importer + source docs never enter the public repo or
  the CI image; they arrive through a private `client-bundle` blob pulled at boot. Bicep drops all
  AI-resource creation (Foundry reused, granted to the backend MI by
  `infra/azure/scripts/grant-foundry-rbac.sh`). Single `public` env. Approved via plan mode;
  shipped v0.33.0.0.

- [`spec-default-persona-boot-seed.md`](spec-default-persona-boot-seed.md) — boot-time seed of the
  enabled default interviewer persona so the digital human works out of the box on the **ephemeral
  SQLite** public demo (reseeded every boot, so an editor-created persona would vanish → voice
  `VoiceUnavailable` + empty editor). Seeds with a **fixed persona id** = the operator's local id so
  the boot sync is a create-or-update against the *same* `interviewer-<id>` Foundry agent (no orphan
  per reboot); `model=None` defers to the deployment's `FOUNDRY_AGENT_MODEL`. Best-effort lifespan
  seed (never blocks boot) + background Foundry sync (voice P5 gate needs `synced`; failure → text
  degrade); the editor auto-selects the default on entry. Generic contract only — no client content.
  Approved by the owner; shipped v0.34.0.0.

- [`plan-client-delivery-package.md`](plan-client-delivery-package.md) — the **client hand-off**
  plan + as-built record (2026-09-01). Packages the tested build (`v0.36.0.4`) so a client deploys
  it in **their own Azure tenant with their own AAD**, no source code and no GitHub: trimmed bicep
  (`delivery/infra/`, GitHub OIDC gated off by a new `enableGithubOidc` param that defaults **true**
  in the main repo so the live CI path is unchanged), prebuilt linux/amd64 image tars exported via
  **skopeo** (no docker), a one-click `deploy-client.sh` (login → infra → skopeo push → deploy →
  Foundry RBAC → health), and a Chinese `.docx` operator manual. Reproduces **all 5 question banks**
  (3 generic baked into the image; 2 rf-CSM shipped out-of-band as **plain JSON** uploaded to a
  public **Azure Files share** — RBAC + account-key, **no VNet** — mounted read-only and auto-imported
  on boot by `seed_client_banks()`; never committed). *(Simplified 2026-09-01 from the earlier
  VNet + private-blob bundle channel per owner request.)* Security boundary enforced by
  `delivery/.gitignore` + a `git add -n` dry-run. Delivered as a standalone zip, **not committed**;
  not deployed to a client tenant as of promotion.

- [`spec-voice-live-byom-model-selection.md`](spec-voice-live-byom-model-selection.md) — **design only, not yet implemented** (2026-10-05). The admin "Azure AI Foundry connection" dropdown lists the customer's **own** Foundry deployments, but the live Voice Live connection sends the chosen name as a native `model=` (path ①), so a self-deployed model throws "not supported in this region". Proposes a native-vs-**BYOM** switch: a checkbox (checked = my own deployment) + an integration-profile dropdown (3 values, default `byom-azure-openai-chat-completion`) that makes `run_proxy` connect with `model=<deployment> + query={"profile": …}` (path ②). Scopes v1 to **connection compatibility** (the `model=` is a TTS host in every default mouth link, not a WS brain) and defers "make the BYOM model actually think" to a separate epic. Carries the full impact map, BYOM hard constraints + api-version/MI verify items, and the open scope decisions. Builds on [`../voice-live-model-support.md`](../voice-live-model-support.md).


## What was intentionally NOT promoted

The gstack project dir also holds machine-local, per-developer working state that does **not**
belong in the repo: review logs (`*-reviews.jsonl`), the session `timeline.jsonl`, `brain-cache/`,
and OS cruft (`.DS_Store`). Those stay in `~/.gstack/` by design.

## Implementation status

For "what's actually built vs. the spec", see [`../IMPLEMENTATION-STATUS.md`](../IMPLEMENTATION-STATUS.md)
and `CHANGELOG.md`.

- [`spec-candidate-login.md`](spec-candidate-login.md) — candidate login for `/interview` + admin-managed
  interview accounts (`user1/2/3`, HMAC-derived passwords viewable by admin, Users tab). Filed as #102.

- [`spec-judged-turn-mode.md`](spec-judged-turn-mode.md) — **judged turn mode** (issue #114, 2026-09-24,
  spec + eng review 2026-09-24): a backend LLM judge decides `wait|nudge` during the candidate's
  pauses ("I'm done" always advances, no judge at commit) for question-bank interviews, replacing
  the retired Foundry-agent voice turn (`bank_turn_mode` becomes `linear|judged`, existing `model`
  rows → `linear`). Adds `judge_events`, admin knobs for judge silence/cap, EOU multilingual VAD for
  mouth sessions. Shipped v0.39.0.0–v0.39.1.0 (PRs #117–#119) with `follow_up`/`redirect` verdicts
  and an admin `max_follow_ups` input; **v0.39.3.0 (owner directive 2026-09-28) retired
  `follow_up`/`redirect` — the judge is nudge-only**, and `max_follow_ups` is kept but inert. Owner
  decisions: no template fallback on judge failure, submit never blocked, no judge auto-advance in
  v1. Follows v0.38.2.0/v0.38.3.1 (PRs #111, #113).

- [`perf-review-20261002.md`](perf-review-20261002.md) — **草稿，未实测**：一次覆盖网络 / 声音 / 视频 /
  文字 / 流式的性能与架构 review，结论来自代码阅读 + 算术，锚点是项目自己已测的数字
  (`../avatar-latency-ice-gathering.md`、`../avatar-weaknet-probe.md`、obsidian Voice Live 系列 00–12)。
  核心判断：**Azure 侧的旋钮已摸干净，剩下的问题几乎全在"我们自己这一跳"**。最大一条是上行分帧——
  AudioWorklet 的 128 样本回调被 1:1 绑死成 125 个 WS 消息/秒，使上行 **397 kbps 里有 35% 不是音频**
  (base64 88 + JSON 信封 45 + 帧头 8)；聚合到 40 ms 并在"我们这一跳"改二进制 (Azure 那跳仍是 base64
  JSON，系列 01 §4.5.1 的约束只约束那一跳) 可降到 **258 kbps**，同时帧数 −80%，直接针对系列 12
  「结论五：麦克风上行会把自己挤死」那两轮均失败的档。其余按影响排序：纯音频播放路径无抖动缓冲
  (正是 §5.6 UDP 全封兜底要走的那条路)、音频编解码压在画视频的主线程上、转写 delta 触发全页重渲染
  (全仓零 `React.memo`)、评分串行 30–50 s 可并行到 10–15 s、默认形象改照片数字人 (零代码，每轮快
  180 ms、带宽少 4–5 倍)、语音 WS 绕过 0.5 vCPU 的 nginx 中转、`permessage-deflate` 默认开着做无效压缩。
  **不翻**系列 00 §四任何一条已定决策 (过渡语、码率自适应、`b=AS`、`freezeCount`、网络档位、上行走
  WebRTC、换编码)。§2.1 单独澄清"上行是流式的、而且必须是" —— P0-1 调的是颗粒度不是模型，攒到候选人
  说完再发会同时废掉静音自动提交 / judge 窗口 / barge-in (三者都建立在 Azure 服务端实时判停上)，并把
  整段上传挪进关键路径。一条附条件：下一题乐观朗读 (先量生产 RTT；朗读路径是本仓库 bug 史的集中地)。
  一条**已否** (owner 2026-10-02)：外部 brain 的 EOU 投机执行，不在考虑范围内，§6.4 记录在案以免重提。
  **一条已在本 PR 修掉**：线上 JS 实测**完全没有压缩** (975 KB，gzip/br 请求字节数一字不差、无
  `content-encoding`)，根因是 nginx 默认 `gzip_types` 只含 `text/html`；`frontend/nginx.conf` 已加
  `gzip on` + 显式类型 + `gzip_vary`，首屏 975.24 kB → 278.51 kB（Vite 构建输出自带这两个数），而预热是页面加载即开始的，所以这直接缩短
  候选人冷启动。末尾是 7 项待验清单（第 6 项已由实测关闭）。

- [`design-ui-refresh-foundry-purple.md`](design-ui-refresh-foundry-purple.md) — 候选人界面视觉改版的
  **已批准设计方向**（`/design-shotgun`，2026-10-03，**尚未实现**）。起因是 owner 判断界面"不专业、不
  fashion"；诊断发现**一半不是审美问题而是布局 bug**：非直播态锁死 760px 而直播态是 1400px（同一路由两
  套宽度）、`LoginCard` 的 420px 居中容器**嵌在** 760px 页面列里导致标题和卡片左边缘参差、
  Restart/Sign out 在裸 `div` 里无 gap、orientation 主按钮被 Fluent `Card` 的 `align-items: stretch`
  **意外拉成通栏**、页头是只装了语言下拉的内联 flex。四个方向（深色影视 / 高级白 / 工程精密 / 人文暖色）
  出图比对后 owner 否掉两个深色方向，并要求用应用自己的官方数字人照片替换 CSS 剪影。配色单独做了
  **Azure 蓝 vs Foundry 紫** 的 A/B——前置风险是 Azure Blue `#0078D4` 与现在显廉价的 Fluent 默认蓝
  `#0F6CBD` 同色相，换色号可能回到原地——最终选定 **Warm Editorial / Foundry Purple**（三个紫值都已在
  `avatarCharacters.ts:58` 的 Fluent 调色板里，说的是 *Azure AI* 而非泛泛的 Azure）。文档含完整 token
  集、布局规则（单一内容宽度、64/36 非对称舞台、直播屏严格占满一屏且只有转录内部滚动）、两个实测到的
  布局陷阱（padded flex item 的 `height:100%` 吃掉 24px 底距；默认 `auto` grid 行按内容撑高导致溢出
  23px，须用 `minmax(0,1fr)`）、以及 8 步落地计划。
- **[spec-voice-live-eou-unification.md](spec-voice-live-eou-unification.md)** — 统一 Voice Live 的
  end-of-utterance 检测（文本型 → 音频型）以打开 realtime 管线：需求、设计、实测依据、测试计划，以及
  一条尚未解决的阻塞项（中文 A/B 不可结论）。实现前文档，不是完成报告。
- **[spec-user-assignment-and-history.md](spec-user-assignment-and-history.md)** — per-user
  interviewer + question-bank assignment and interview history (issue #187, 2026-10-07). Pins
  `persona_id`/`bank_id` on each interview first (fixes architecture-review deferred item 1), then
  one assigned persona + bank per logged-in user (unassigned / anonymous fall back to the default),
  then history: the candidate sees their own on the start page, the admin sees every user's
  (all statuses incl. in-progress and abandoned) inside the Users tab, with report, PDF and
  transcript download.
