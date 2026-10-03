# 数字人连接限流：配额是多少、怎么看、怎么提、以及为什么"关掉再连"会报错

**触发本文的现场报错**（2026-10-03，生产）：

```
Voice unavailable: Avatar request was rate-limited. Retry after 7.0s. — you can continue by text.
```

`Voice unavailable: ` 和 `— you can continue by text.` 是我们加的，**中间那句是 Azure 原样返回的**。

本文把四个问题逐一落到"文档原文 + 代码位置 + 实测"三者之一，并明确标注哪些是**实测**、哪些是**文档**、
哪些是**推断**。结论先行：

| # | 结论 | 依据 |
|---|---|---|
| 1 | 配额是 **2 次新建连接 / 分钟**（S0），Voice Live 的数字人走 Speech 的 avatar 配额 | 文档 |
| 2 | **我们代码里的窗口是 20 秒，宽松了 3 倍** → 会放行 Azure 必然拒绝的请求 | 代码 + 文档对照 |
| 3 | 限流账本只存在内存里、每次挂载重置 → "Start over"、刷新、新标签页都绕过它 | 代码 |
| 4 | pre-connect 的限流被当成**永久失败**，直接把候选人踢到文字模式 | 代码 |
| 5 | **Azure 侧看不到这个事件**：usage API 无此项、`ClientErrors` 为 0、`Ratelimit` 是限值量规不是计数器 | 实测 |
| 6 | 提配额只能开支持票，没有自助配额页 | 文档 + MS Q&A |

---

## 1. 配额到底是多少

[Quotas and limits for Azure Speech](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)
的 **Real-time text-to-speech avatar** 一节（S0）：

| 配额项 | Free (F0) | Standard (S0) |
|---|---|---|
| **New connections per minute** | 不可用 | **2** |
| Maximum connection duration with speaking | 不可用 | 30 分钟 |
| Maximum connection duration with idle state | 不可用 | 5 分钟 |

同一页里有一句关键的归属说明：

> Avatars used in Voice Live follow the quotas and limits described in **Real-time text-to-speech
> avatar** later in this article.

**所以不要去看 Voice Live 自己那张表**（那张写的是 30 连接/分钟、单会话 ≤60 分钟、120k tokens/分钟）——
数字人受的是 **Speech 的 avatar 配额，2 次/分钟**。这是本文最容易搞错的一点：同一个资源上两套配额，
数字人走更严的那套。

### 两次独立观测都能被"2 次 / 60 秒"解释

`Retry after` 的数值不是固定退避，而是**窗口里最老那次连接还有多久滚出 60 秒窗口**：

| 观测 | 报的 Retry after | 反推"最老一次连接在多久前" |
|---|---|---|
| 2026-09-30（自愈路径，第三次请求） | 43.0s | 60 − 43 = **17 秒前** |
| 2026-10-03（生产，关掉再重连） | 7.0s | 60 − 7 = **53 秒前** |

两个都落在 60 秒窗口内，自洽。

> **更正一条旧结论。** 代码注释里写过"第三次请求在**约 20 秒**内被拒"，并据此把窗口设成 20 秒。
> 那是**错误的反推**：观测只说明三次请求挨得很近，**推不出窗口长度**。文档的 60 秒才是窗口，
> 20 秒这个数从来没有证据支持。

---

## 2. 我们的账本宽松了 3 倍（真 bug）

`frontend/src/hooks/useAvatarStream.ts`：

```ts
const AVATAR_REQUEST_WINDOW_MS = 20_000;   // ← 应为 60_000
const AVATAR_REQUESTS_PER_WINDOW = 2;
```

2 次 / 20 秒 = **6 次/分钟**，而 Azure 给 **2 次/分钟**。

这直接解释了现场那句报错的机制：

```
候选人关闭会话 → 等了一会儿（> 20 秒，< 60 秒）→ 重新连接
  我们的账本：20 秒窗口已过 → 放行
  Azure 的窗口：60 秒没过，这是本分钟内第 3 次 → 拒绝，并告知还要等 7 秒
```

**账本放行了一个必然被拒的请求**，而被拒的代价不是"等一下"，是下面第 4 条——候选人被踢到文字模式。

花同一份配额的路径有三条，Azure 看来完全一样（代码注释已记录）：自愈重新握手、主动切换媒体模式、
全新会话。

---

## 3. 账本只活在内存里，跨不过刷新

`avatarRequestsRef` 是 `useAvatarStream` 内的 `useRef`，**每次组件挂载都是空的**。而 Azure 的配额是
**资源级**的、跨页面跨标签页跨用户。所以下面这些都会绕过我们自己的保护：

- 候选人点 **Start over**（重建会话）
- 刷新页面 / 关标签页再打开
- 同一个 Speech 资源上**第二位候选人**同时开始面试
- 管理员在 `/admin/agent` 的 Playground 里试数字人，同时有候选人在面试

最后两条值得单独强调：**2 次/分钟是资源级的**，所以这个限制在多人同时用的时候一定会撞上，不是只有
"手快"才会遇到。

---

## 4. pre-connect 限流被当成永久失败（真 bug）

`frontend/src/hooks/useInterviewVoice.ts` 的 `case "error"`，pre-connect 分支：

```ts
// Pre-connect fatal (never went live): mark it so onclose does NOT reconnect. Retrying an
// invalid_model / unsupported-region rejection is futile ...
policy.latchFatal();
setConn("error");
optionsRef.current.onError?.(error);
```

注释的理由对 `invalid_model`、不支持的区域是对的——**那些重试确实徒劳**。但限流是相反的情形：
**Azure 明确告诉你等多久就能成功**。把它和永久性错误归成一类，结果是候选人等 7 秒就能看到数字人，
却被直接降级成文字面试。

---

## 5. 怎么查看（实测：Azure 侧看不到）

三条路都试过了，结论是**这个事件在 Azure 侧不可观测**：

| 途径 | 结果 | 实测命令 |
|---|---|---|
| 资源的 usage/quota API | **空**，没有 avatar 相关项 | `az cognitiveservices account list-usage -g <rg> -n <acct>` |
| Azure Monitor `ClientErrors` | **0** | `az monitor metrics list --metrics ClientErrors` |
| Azure Monitor `Ratelimit` | 是**限值量规**不是计数器（3000006 / 6 次调用 ≈ 每次 500001） | 同上，`--metrics Ratelimit` |

原因：**数字人连接被拒是从 Voice Live 的 WebSocket 里以 in-band `error` 事件回来的，不是资源上的
HTTP 4xx**，所以不计入 `ClientErrors`，也不进配额指标。

**于是唯一的观测点是我们自己的应用。** 现在能看到的是页面上那句 verbatim 的 Azure 原文；代码里没有
专门的限流日志。这是下一步该补的（见"待办"）。

---

## 6. 怎么提高

没有自助配额页。按文档与
[MS Q&A 上的同一问题](https://learn.microsoft.com/en-us/answers/questions/2258596/increase-the-limit-of-concurrent-users-in-speech-s)：

1. Azure Portal → 该 **Speech / AI Services 资源**
2. **Support + troubleshooting** → **New support request**
3. 说明当前用量与期望的并发/新建连接配额

Q&A 里另一位用户确认了同一个数字：*"I am in the S0 plan of PAYG where the quota limit for Azure AI
Speech Services AI Avatar is **2 connections per minute**"*。

**在配额提上来之前**，产品侧能做的只有少花配额：复用会话（别反复重建）、把账本改对（第 2 条）、
并在撞上时按 Azure 给的秒数等待重试而不是降级（第 4 条）。

---

## 顺带确认的两个硬时限

同一张表里还有两个值，和本项目的长面试直接相关，之前没有记录在任何地方：

- **说话状态下单次连接最长 30 分钟**
- **空闲状态下最长 5 分钟**

[实时合成文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech-avatar/real-time-synthesis-avatar)
原文："The real-time API disconnects after 5 minutes of idle or after 30 minutes of connection."

**5 分钟空闲断开**是个现实风险：候选人在某道题上思考超过 5 分钟（简历类、情景类题目完全可能），
数字人连接会被 Azure 主动断开。断开后重连又要花一次 2 次/分钟的配额。这一条**尚未实测**，
列为待验。

---

## 待办（按价值排序）

1. **把窗口改成 60 秒**（第 2 条）—— 一行，有文档依据。
2. **限流不再判死**：解析 `Retry after Ns`，等满再重试一次，而不是降级到文字（第 4 条）。
3. **补一条限流专用日志**，因为 Azure 侧观测不到（第 5 条）。
4. **账本跨刷新持久化**（第 3 条）—— 需要设计决策：`sessionStorage` 只能护住同一标签页，
   护不住"两位候选人同时开始"，那种情况只有提配额或排队能解。
5. **实测 5 分钟空闲断开**，以及断开后我们的自动重连是否会立刻撞上配额。
