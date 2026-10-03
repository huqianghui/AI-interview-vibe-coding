# 数字人连接限流：配额是多少、怎么看、怎么提、以及为什么"关掉再连"会报错

**触发本文的现场报错**（2026-10-03，生产）：

```
Voice unavailable: Avatar request was rate-limited. Retry after 7.0s. — you can continue by text.
```

`Voice unavailable: ` 和 `— you can continue by text.` 是我们加的，**中间那句是 Azure 原样返回的**。

## 先立一个框架：avatar 不是一个服务，是 Speech 的附属能力

这句话是 owner 提的（2026-10-03），而它不是用词上的讲究——**本文后面五条分散的实测结论，都是它的必然推论**。
数字人没有自己的资源类型、没有"部署"这个东西，它是 Azure AI Speech 的 text-to-speech 之下的一个能力。
于是：

| 实测现象（本文各节） | 由这个框架直接解释 |
|---|---|
| Foundry **Quota 页上没有 avatar 这一行**（第 8 节，owner 截图） | 那个页面列的是**模型部署**。avatar 不是可部署的模型，没有可分配的 RPM 池，所以没有行 |
| **Request quota 按钮用不上**（第 6 节） | 它做的是"把区域配额池分配给某个部署"。没有部署，就没有可分配的对象 |
| `az cognitiveservices account list-usage` **返回空**（第 5 节） | usage 项跟踪的是已部署 / 已计量的能力 |
| 拒绝以 **in-band `error` 从 Voice Live 的 WS 回来**，而不是资源上的 HTTP 4xx（第 5 节） | 它是**会话的一个特性**，不是一个有独立请求路径的 API 端点 |
| 配额**小且固定**（2 次/分钟），与资源规模无关（第 1 节） | 不是按 provision 的容量定的，是服务端对附属能力的固定节流 |

**连第 6 条那个"文档说不可调 vs Q&A 说开票"的矛盾也由此解释**：它不是配额体系里的一等公民，所以既没有
自助页面，支持票也未必有对应的旋钮可调。**规划容量时不要把它当成"可以申请扩容的配额"，要当成服务的固定
行为约束**——这会直接改变结论：横向加资源是确定可行的，等配额不是。

---

本文把四个问题逐一落到"文档原文 + 代码位置 + 实测"三者之一，并明确标注哪些是**实测**、哪些是**文档**、
哪些是**推断**。结论先行：

| # | 结论 | 依据 |
|---|---|---|
| 1 | 文档写 **2 次新建连接 / 分钟**（S0），**实测是 3 次 / 60 秒**；窗口 60 秒已被两次独立的 `Retry after` 收敛证实 | 文档 + 实测 |
| 2 | **我们代码里的窗口是 20 秒，宽松了 3 倍** → 会放行 Azure 必然拒绝的请求 | 代码 + 文档对照 |
| 3 | 限流账本只存在内存里、每次挂载重置 → "Start over"、刷新、新标签页都绕过它 | 代码 |
| 4 | pre-connect 的限流被当成**永久失败**，直接把候选人踢到文字模式 | 代码 |
| 5 | **Azure 侧看不到这个事件**：usage API 无此项、`ClientErrors` 为 0、`Ratelimit` 是限值量规不是计数器 | 实测 |
| 6 | **没有可申请的 quota 对象**：区域 usages API 的 287 项里没有任何 avatar / speech 条目，只有模型部署容量与账户数 | 实测（4 条途径穷尽） |
| 7 | **一次面试只花 1 次**（实测）——爆配额来自测试节奏（Start over / 刷新 / Playground），不是实现 | 实测 |
| 8 | 生产侧硬上限：**同一资源每分钟最多 2 位候选人能开始面试** | 文档 + 第 7 条 |
| 9 | **排除项**：Foundry Quota 页的 3 RPM 就是 `OpenAI.Standard.tts` / `tts-hd`（API 数字完全对上），与本问题无关 | owner 截图 + usages API + 代码 |
| 11 | **关掉数字人则完全不碰这个限制**：31 秒内 5 个纯语音会话，avatar offer 0、限流 0 | 实测 |
| 12 | **纯语音压到约 120 次/分钟仍零失败**（文档称 30），所以密集测试就关数字人 | 实测 |
| 13 | Foundry 那个 3 RPM 属于 **Azure OpenAI** 的 tts-hd（宿主资源 kind=OpenAI），不是 Speech 的 TTS；两个「3」是巧合 | 实测 |
| 10 | **框架**：avatar 不是一个服务、而是 Speech 的附属能力——第 1、5、6、8 条都是它的推论，所以不要把它当成「可申请扩容的配额」 | owner 指出 |

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

## 6. SKU 是什么、该申请什么 quota —— 答案是：**没有可申请的 quota 对象**（已穷尽验证）

owner 的要求很明确："一定要搞清楚，对应的 sku 是啥，要去申请什么的 quota。" 下面是钉死的结果。

### 资源身份（应用实际连的那个）

```
name      ai-foundary-hu-sweden-central2
type      Microsoft.CognitiveServices/accounts
kind      AIServices
sku       S0
location  swedencentral
endpoint  https://ai-foundary-hu-sweden-central2.cognitiveservices.azure.com/
```

### Azure 对这个订阅 + 区域跟踪的全部配额：287 项，没有一项是 avatar

区域级 usages API（`Microsoft.CognitiveServices/locations/swedencentral/usages`）返回 287 项：

| 前缀 | 项数 | 是什么 |
|---|---:|---|
| `OpenAI.*` | 179 | Azure OpenAI 模型部署容量 |
| `AIServices.*` | 107 | 106 项模型部署容量 + `AIServices.S0.AccountCount` |
| `AccountCount` | 1 | 账户数量 |

按 `avatar` / `conn` / `realtime` / `live` / `session` 穷举筛，命中的**全部是 Azure OpenAI 的模型名**
（`gpt-realtime`、`gpt-live-1` 等）。**没有任何 avatar 条目，也没有任何 speech 能力的配额项。**

而 owner 在 Foundry Quota 页看到的那个 3，正是这里的两项，数字完全对上：

```
OpenAI.Standard.tts      current=0  limit=3  unit=Count     ← 截图里的 "0 of 3 RPM"
OpenAI.Standard.tts-hd   current=3  limit=3  unit=Count     ← 截图里的 "3/3 RPM"
```

（注意 `current` 是**已分配给部署的份额**，不是请求数——这就是为什么它显示 3/3 而 "Weekly rate
limiting" 同时是 0%。）

### 结论：没有 quota 名字可以填

"avatar 新建连接数/分钟"**不是一个配额对象**，所以：

| 问题 | 答案 |
|---|---|
| 对应 SKU | `Microsoft.CognitiveServices/accounts` · kind `AIServices` · **S0** · swedencentral |
| 该申请哪个 quota | **没有。** Azure 的配额体系里不存在这一项 |
| 为什么 Request quota 按钮没用 | 它分配的是**模型部署**的容量池；avatar 没有部署、没有池 |
| 它是什么 | **服务端对一个附属能力的固定行为节流**，不是可分配的配额 |

这与第 5 节的四条否定结果完全一致，而且现在是**四条独立途径都查过**：资源 usage API、Azure Monitor
指标、`Microsoft.Quota` 提供程序（对 CognitiveServices 作用域直接 BadRequest）、区域级 usages API。

**所以开支持票只能是"请求提高一个服务端限制"，而不是"申请某个配额"**，而且没有证据表明存在对应的旋钮。
规划时按**固定约束**对待，不要按"可扩容配额"对待。

### 不要把那个 3 RPM 和 avatar 的 3 混为一谈（本文最容易读错的地方）

两个数字都是 3，**但毫无关系**，而且是本文写作过程中真实造成过误解的一处：

| 哪个 3 | 单位 | 是什么 | 在哪看得到 |
|---|---|---|---|
| `OpenAI.Standard.tts-hd limit=3` | **Count** | **Azure OpenAI** 的 TTS 模型部署**容量分配**（已分配 3/3） | Foundry Quota 页、usages API |
| 实测"3 次被接受、第 4 次被拒 / 60 秒" | **连接/60 秒** | **avatar 的新建连接速率** | **哪里都看不到**，只能实测 |

而且那个 `tts-hd` 确实属于 **Azure OpenAI，不是 Speech 的 TTS**，三条独立证据：

1. 配额命名空间是 `OpenAI.*`，和 `OpenAI.GlobalStandard.gpt-4o` 同一族；
2. 宿主资源 `openAI-hu-SwendenCentral` 的 **kind 是 `OpenAI`**；
3. 应用实际用的 `ai-foundary-hu-sweden-central2`（kind `AIServices`）上**没有任何 tts 部署**。

**Speech 自己的神经音色（`en-US-AvaNeural` 这类，我们用的就是这个）在那 287 项配额里一条都没有**——
与"Speech 的能力不是配额对象"完全一致。

### 纯语音的上限：压到 120 次/分钟仍未触及（实测）

既然关掉数字人能绕开 avatar 限制，那纯语音自己的上限在哪？直连后端 WS（不经浏览器，否则建连耗时会把
速率拖低）压测：

| 轮次 | 发起方式 | 实际速率 | 结果 |
|---|---|---|---|
| 串行（等每条建成） | 35 条 / 136 秒 | 约 15 次/分钟 | 35 条全建成，**0 错误** |
| 并发（不等建成） | 40 条 / 20 秒 | **约 120 次/分钟** | 40 条全建成，**0 错误** |

**120 次/分钟是文档所称 Voice Live「30 新建连接/分钟」的 4 倍，仍然零失败。** 所以在测试强度下纯语音
不构成约束。（第一轮串行的 15 次/分钟**没有达到上限**，单独列出来是因为只看那一轮会得出"测到 35 条没问题"
这种偏弱的结论。）

### 可靠的杠杆（都已实测）

1. **密集测试时关掉数字人** —— 实测 31 秒内连开 5 个纯语音会话，**avatar offer 0 次、限流 0 次**，
   5 个都正常出声。纯语音不走 avatar 配额；它名义上受 Voice Live 自己的「30 新建连接/分钟」管，
   但**实测压到约 120 次/分钟仍零失败**（见下一节），所以在测试强度下它根本不是约束——
   不要把那个 30 当成要规避的上限，实测没碰到。
2. **横向加资源** —— 限制按资源算，每个资源各有自己的额度（实测 3 次 / 60 秒）。
3. **少建会话** —— 复用，别反复 Start over / 刷新。

## 7. 一次面试到底花几次？（实测：1 次）——所以"一个人测试也爆满"不是实现的问题

owner 的疑问是合理的："我就是一个人测试，这个额度都会爆满。" 所以先排除"我们在乱建连接"：
数一次「开始面试 → 语音作答」里 `session.avatar.connect` 发了几次。

```
   886ms  WS 打开
  6031ms  >>> session.avatar.connect     ← 唯一的一次
  6328ms  收到 session.avatar.connecting
  7829ms  收到 session.avatar.switch_to_speaking
 共花掉 1 次
```

**happy path 不重复建连。** 各个动作的实际花费：

| 动作 | 花费 | 依据 |
|---|---|---|
| 加载 `/admin/agent` 看中间那张图 | **0** | 那是静态 CDN 缩略图；Playground 只在点 **Voice** 时才 `voice.connect()`（`PlaygroundPanel.tsx` 的 `toggleVoice`） |
| 点 Playground 的 **Voice** | 1 | 同一条 `useAvatarStream` 路径 |
| 开始面试 + 语音作答 | **1**（实测） | 上面 |
| **Start over** | 再 1 | 重建会话 |
| 刷新 / 新标签页 | 再 1 | 且绕过内存账本（第 3 条） |
| 媒体模式切换（关画面 / 开画面） | 再 1 | Azure 不支持会话中途重协商，切换 = 重建会话 |
| **关闭会话** | **不退还** | 限的是"每分钟**新建**数" |

**结论：配额是按生产形态定的，不是按开发形态。** 真实候选人开一次、保持最多 30 分钟，2 次/分钟很宽裕；
而开发时"开面试看一眼 → Start over → 再看 → 同时开 Playground 对比"一分钟内凑三次毫不费力——
这正是 2026-10-03 那次报错的现场动作（`Retry after 7.0s` ⇒ 最老那次连接在 53 秒前）。

### 但有一条生产侧的硬上限要记住

**同一个资源上每分钟最多只有 2 个候选人能"开始"面试。** 一批人同时开始（例如约在 9:00）会撞墙。
这不是测试期的噪音，是容量上限，解法只有多资源或服务端排队。

### 测试期的可持续节奏

- 只看画面就**别按 Start over**，复用当前会话。
- 需要重开时**间隔约 30 秒**（60 秒窗口 2 个名额 ⇒ 约 30 秒/次是可持续速率）。
- **别在面试开着时点 Playground 的 Voice**。
- 密集测试：**再开一个 Speech/AI 资源**各有各的 2 次/分钟（配额按资源，文档确认）。
  "按会话选资源"**未验证**，属设计选项。

## 8. 排除项：Foundry Quota 页上的 TTS 3 RPM 与本问题无关（owner 截图 + 代码核对）

owner 在 Foundry 的 **Manage → Quota** 页按 `tts` 过滤，看到两行（Sweden Central，Standard）：

| 模型 | 共享配额池 | 已分配 | 有部署 | Weekly rate limiting |
|---|---|---|---|---|
| `tts-hd` | 3 RPM | 3/3（100%） | 1 个（在 `openAI-hu-SwedenCentral`） | **0%，"No errors in last 7 days"** |
| `tts` | 3 RPM | **0 of 3（0%）** | 无 | — |

**这两个都不是我们的 TTS。** 四条证据：

1. **它自己的面板说 7 天零错误。** 一场面试要朗读 9 道题；若真走 3 RPM 的部署，早该持续报错。
2. **代码零引用**：`tts-hd` / `tts-1` / OpenAI TTS / `audio/speech` 在前后端都搜不到。
3. **会话里音色写死为 Speech 的**：`voice.type = "azure-standard"`，名字 `en-US-AvaNeural` /
   `zh-CN-XiaoxiaoNeural`。`azure-standard` 是 Voice Live 里"Azure Speech 标准音色"那个枚举值，
   与 Azure OpenAI 的 TTS 模型是两套东西。
4. **资源不同**：该部署在 `openAI-hu-SwedenCentral`；应用指向 `ai-foundary-hu-sweden-central2`，而后者
   的部署清单里**没有任何 TTS 部署**（全是 LLM / embedding / image，已用 `az` 列过）。

**前瞻（这条配额现在无害，但它是"别动 `voice.type`"的具体理由）：** Voice Live 的 `voice.type` 可切成
`openai`。一旦切过去就会落到这个 3 RPM 上——9 次朗读对 3 RPM，每道题都要排队。

### 同一张截图坐实了第 6 条

该 Quota 页列的是**模型部署**（TPM / RPM），右上角有 **Request quota** 按钮——而**数字人的"2 次新建
连接/分钟"根本不在这个页面上**。所以第 6 条里那个"文档说不可调 vs Q&A 说开票"的矛盾，现在有了更直接的
解释：**它不在自助配额页里**，这也正是 Q&A 那位提问者说"在后台找不到开票入口"的原因。

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
