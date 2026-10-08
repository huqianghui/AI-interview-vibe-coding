# WebRTC 与 WebSocket：ICE / STUN / TURN、Opus，以及 Voice Live 语音和数字人的传输选择

> 2026-10-08 整理。起因是一连串问题："ICE、STUN、TURN、relay 是数字人引入的吗？纯语音还有吗？
> 语音也能走 WebRTC，那还有吗？没有 STUN/TURN 为什么还要 ICE？Opus 为什么只有 WebRTC 能用？"
> 本文把答案按"从现象到原理"的顺序整理，作为后续写文章的素材。
>
> 标注约定：**【文档】** = 已在 Microsoft Learn 查证；**【代码】** = 对照本仓库代码确认；
> **【推断】** = 我的推理，文档没有说明，引用前需要实测或另行查证。
>
> 相关文档：[`avatar-latency-ice-gathering.md`](avatar-latency-ice-gathering.md)（ICE 收集导致的数字人出场延迟）、
> [`avatar-weaknet-probe.md`](avatar-weaknet-probe.md)（弱网实测）、
> [`voice-live-control-notes.md`](voice-live-control-notes.md)（Voice Live 控制方式）。

---

## 1. 结论先行

1. **ICE、STUN、TURN、relay 属于 WebRTC，不属于"数字人"。** 在 Voice Live 里，只有数字人默认用了
   WebRTC，所以看起来像是数字人带进来的。
2. **纯语音走 WebSocket 时，这些全都没有。** 只需要 443 端口的 WSS 能通。
3. **语音改走 WebRTC，ICE 一定会有**，STUN/TURN 则取决于服务端是否下发。连的是有公网地址的媒体服务器时，
   往往不配 STUN/TURN 也能通，但这样就**没有 relay 保底**，出站 UDP 被封时会建连失败。
4. **WebRTC 和 WebSocket 的区别远不止 TCP 换成 UDP**：编码（Opus 对比 PCM）、丢包处理、抖动缓冲、
   拥塞控制、发送节奏、媒体是否经过后端，全都不一样。
5. **Opus 不是 WebRTC 专属**，只是 Voice Live 的 WebSocket 接口不接受 Opus。

---

## 2. Voice Live 的两条传输路径

### 2.1 纯语音：WebSocket

音频是 PCM 帧，在 WebSocket 上双向传输。WebSocket 本身就是 TCP + TLS，和普通 HTTPS 一样，
能穿过代理和防火墙，所以：

- 不需要 ICE，不收集候选
- 不需要 STUN、TURN，没有 relay
- 不需要 SDP offer/answer

**【代码】** 本项目：浏览器 → 后端 `/voice-live/ws` 代理 → Azure Voice Live（WebSocket）。纯语音模式下
整条链路里没有 WebRTC。

### 2.2 数字人：WebRTC

数字人的画面是一路实时视频，Azure 用 WebRTC 推给浏览器。建连过程：

1. 会话配置了 avatar 以后，Azure 在 `session.updated` 的 `session.avatar.ice_servers` 里返回
   STUN/TURN 地址和临时凭据 **【文档】**
2. 浏览器用这些地址创建 `RTCPeerConnection`，生成 SDP offer
3. offer 用 base64 编码，放进 `session.avatar.connect` 事件的 `client_sdp` 字段，通过同一条 WebSocket
   发给 Azure；Azure 返回 answer **【文档】**。这就是"一次性信令"
4. ICE 优先尝试直连，失败再退到 relay

**【代码】** 只有 `frontend/src/hooks/useAvatarStream.ts` 的 `createPeerConnection` 会
`new RTCPeerConnection(...)`；麦克风 `getUserMedia` 在 `frontend/src/hooks/useVoiceAudio.ts`，
所有语音面试都会调用它。

**一个例外【文档】**：avatar 有一个 `output_protocol` 字段，可选 `webrtc`（默认）或 `websocket`。
选 `websocket` 时，数字人的视频也走 WS，整条链路里就没有 ICE 了。

### 2.3 语音也可以走 WebRTC

- **【文档】** Azure OpenAI Realtime 官方支持 WebRTC 接入，建议客户端应用使用（标称延迟约 100ms，WebSocket 约 200ms）。
  官方示例直接写 `new RTCPeerConnection()`，**没有配置 iceServers**。
- **【文档】** Voice Live 的 how-to 页面也写了"客户端应用多数情况下用 WebRTC 做实时音频"；SDK 里出现了
  `rtc.call.sdp.create` / `rtc.call.sdp.created` 事件，可以在 WS 上发 SDP offer，建立 WebRTC 语音通道。
- **未查证**：Voice Live 走语音 WebRTC 时会不会下发 TURN，文档没写，需要实测（看 SDP answer
  里的候选，或在 `chrome://webrtc-internals` 里看有没有 `relay` 候选）。

### 2.4 四种组合对比

| 传输方式 | ICE | STUN | TURN / relay | 防火墙要求 |
|---|---|---|---|---|
| 语音 · WebSocket（本项目现在） | 无 | 无 | 无 | 只要 443 WSS 通 |
| 语音 · WebRTC（OpenAI Realtime 示例） | 有 | 通常不配 | 通常没有，无保底 | 需要出站 UDP |
| 数字人 · WebRTC（Voice Live 默认） | 有 | 有 | 有，下发 TURN | UDP，或 TURN 走 TCP/TLS |
| 数字人 · WebSocket（`output_protocol: websocket`） | 无 | 无 | 无 | 只要 443 WSS 通 |

---

## 3. ICE 的三类候选：host、srflx、relay

### 3.1 候选是什么

候选是一个传输地址：`IP + 端口 + 协议（UDP/TCP）`，写在 SDP 里告诉对端
"**往这里发，我能收到**"。注意，它是**接收地址**，不是源地址。

| 类型 | 告诉对端的地址 | 对端的包怎么到达我 | 优先级 |
|---|---|---|---|
| host | 本机网卡地址，如 `192.168.1.5:54321` | 直接到达（同一局域网，或本机有公网 IP） | 最高 |
| srflx（server reflexive） | 问 STUN 服务器得到的 NAT 外映射地址，如 `203.0.113.7:61000` | 先到 NAT，再按映射转进来 | 中 |
| relay | TURN 服务器上分配的中转地址 | 先到 TURN 服务器，再转给我 | 最低 |

每个候选背后都有一个真正收发数据的 socket（base）：

- host 和 srflx 的 base 是**同一个本地 socket**。srflx 只是这个 socket 经过 NAT 后在外面"看起来"的地址。
- relay 的 base 在 TURN 服务器上。我发的数据要先封装好交给 TURN，由它代为发出。

### 3.2 第四种：prflx（peer reflexive）

srflx 是 **STUN 服务器**看到的我的地址。遇到对称 NAT 时，我发往对端的包会被分配一个**不同的**外网端口，
STUN 服务器看到的地址对对端来说是错的。

ICE 的处理方式：对端收到我的检测包后，把它**实际看到的源地址**记为一个新候选，即 prflx。
这也是连 Azure 时不配 STUN 服务器也能通的原因。

### 3.3 STUN 和 TURN：不是二选一，而是同时收集

ICE 开始时**同时**收集三类候选，配成对后**并行**检测，最后选出能通的里面优先级最高的那一对。

- "直连优先、relay 保底"的意思是：relay 在**选择**上排最后，但在**时间**上并不是"STUN 失败了才去试 TURN"。
  relay 候选早就准备好了，直连不通时不会多等一轮。
- TURN 是 STUN 协议的扩展。向 TURN 申请中转地址的应答里本身就带着我的公网映射地址，所以配了 TURN，
  通常也顺便拿到了 srflx。
- **relay 和 TURN 的关系**：TURN 是协议，也是那台服务器；relay 是 TURN 分配出来的候选类型，也指
  "媒体经服务器中转"这种连接方式。

### 3.4 分别在什么情况下起作用

**STUN（直连）够用**：大多数家用路由器的 NAT 给同一个内网端口分配固定的外网映射（锥形 NAT），
对端照着映射地址发包就能进来。

**必须靠 TURN**：

- **对称 NAT**：发往不同目的地址时，每次分配不同的外网端口，从 STUN 问到的地址对端用不了。
- **出站 UDP 被封**：企业网、部分 VPN、酒店网络常见。TURN 可以走 TCP，或走 TLS 443，伪装成 HTTPS。
- **只允许通过 HTTP 代理出网**的严格环境。

| | STUN | TURN |
|---|---|---|
| 服务器负担 | 只回答一个很小的请求，之后不再参与 | 全程转发所有媒体 |
| 延迟 | 直连，最低 | 多绕一跳 |
| 成本 | 几乎为零 | 带宽成本高，所以需要凭据 |

**连 Azure 时的特殊之处【推断】**：Azure 媒体服务器有公网地址，客户端即使在对称 NAT 后面，主动发包过去，
服务端也能通过 prflx 学到客户端地址并回包。所以 STUN 服务器不那么必要，真正离不开 TURN 的主要是
"出站 UDP 被封"这一种情况。这也是 Voice Live 给数字人下发 TURN 的价值：企业网里画面也能靠 TCP/TLS 中转出来。

**【文档】** Azure 语音服务的数字人文档给出的 ICE 地址形如 `turn:relay.communication.microsoft.com:3478`。

---

## 4. 两端对称：local candidate 与 remote candidate

### 4.1 完整过程

```
     我（浏览器）                                对端（Azure）
1. 收集自己的候选                            1. 收集自己的候选
   host / srflx / relay                         host / srflx / relay
        │                                            │
        └──────── 2. 通过信令交换（SDP） ─────────────┘
              我的候选 → 对端的 remote candidates
              对端的候选 → 我的 remote candidates
        │                                            │
3. 双方都把 local × remote 两两配成候选对（candidate pair）
4. 双方都对候选对发 STUN 检测
5. controlling 一方选定最终那一对（nominate）
```

一条路径 = 我的某个候选 + 对端的某个候选。对端的候选同样带 `typ host` / `typ srflx` / `typ relay`：

```
a=candidate:1 1 udp 2130706431 20.50.x.x 3478 typ host
a=candidate:2 1 udp 16777215 20.60.x.x 49152 typ relay raddr ... rport ...
```

| 我这边 | 对端 | 含义 |
|---|---|---|
| host | host | 同一局域网，或双方都有公网 IP |
| srflx / prflx | host | 我在 NAT 后，对端有公网地址（连 Azure 最常见） |
| srflx | srflx | 双方都在 NAT 后，打洞成功 |
| relay | host | 我这边封了 UDP，只能走 TURN |
| relay | relay | 双方都走中转 |

### 4.2 controlling 与 controlled

ICE 规定一方是 controlling，另一方是 controlled。双方都做检测，但只有 controlling 方有权选定最终那一对，
通常是发起 offer 的一方。

**【推断】** 媒体服务器常见做法是 **ICE-lite**：只公布公网地址上的 host 候选，不主动发检测，只回应。
这时客户端是唯一的 controlling 方。Azure 是否这样实现，需要抓一次 SDP answer 确认（answer 里有
`a=ice-lite` 就是）。

### 4.3 候选对的优先级由两端一起决定（RFC 8445）

```
pair priority = 2^32 × min(G, D) + 2 × max(G, D) + (G > D ? 1 : 0)
```

G 是 controlling 方候选的优先级，D 是 controlled 方的。主导项是 `min`：一对的排名主要看两端中较差的那个。
只要一端是 relay，这一对就排在后面。这就是"直连优先、relay 保底"在数学上的体现。

---

## 5. 没有 STUN、TURN 服务器，为什么还要 ICE

关键："没有 STUN 服务器"不等于"没有 STUN 协议"。ICE 除了收集候选，还要做五件事，有没有服务器都要做：

1. **选路**：一台电脑通常有多个出口（Wi-Fi、有线、VPN、IPv4、IPv6），每个都是一个 host 候选，
   要逐一检测，选能通且最好的。
2. **连通性检测，并学到 NAT 外的地址**：浏览器向对端候选直接发 STUN Binding Request（用 STUN 协议，
   但不经过 STUN 服务器）。对端从包里学到我的映射地址（prflx）并回包。
3. **安全（对端同意）**：浏览器绝不向没回应过 ICE 检测的地址发媒体（RFC 7675 consent freshness，
   大约每 5 秒复核一次）。否则网页 JS 就能让浏览器向任意 IP 发 UDP 洪泛。ICE 的 ufrag/pwd 对检测包做认证，
   后续 DTLS 握手也和它绑定。
4. **保活**：UDP 没有连接，NAT 映射会过期，ICE 定期发包保持映射。
5. **切换网络**：Wi-Fi 切到 4G 时用 ICE restart 换路，不必重建整个会话。

总结：STUN/TURN 服务器是用来**多找候选**的；ICE 是**验证并维持路径**的机制，无论如何都要有。

---

## 6. WebRTC 和 WebSocket 的区别：不只是 TCP 换成 UDP

UDP 只是最底层。WebRTC 在上面叠了一整套为实时媒体设计的协议和处理，WebSocket 只是一条通用的可靠字节管道。

| 方面 | WebSocket（本项目现在） | WebRTC |
|---|---|---|
| 丢包怎么处理 | TCP 重传，后面的包全部排队等（队头阻塞） | 丢了就跳过，由丢包隐藏补上 |
| 编码 | PCM16 裸音频 | Opus，约 32 kbps，带 FEC、DTX |
| 抖动缓冲和播放 | 自己写（AudioWorklet 播放队列） | 浏览器内置 |
| 拥塞控制 | 只有 TCP 自己那套，不感知媒体 | RTCP 反馈 + 带宽估计，自动调码率 |
| 加密 | TLS | DTLS-SRTP |
| 发送节奏 | 服务端能推多快推多快 | 按实时速度 |
| 事件通道 | 和音频同一条 WS | 另开 DataChannel 或 sideband WS |
| 网络要求 | 443 TCP | 出站 UDP（或 TURN） |

和本项目直接相关的三点：

1. **弱网表现差别最大。** 之前的弱网实测（[`avatar-weaknet-probe.md`](avatar-weaknet-probe.md)）：
   卡顿时长约等于丢包数 × 300ms RTT，正是 TCP 重传造成的队头阻塞。WebRTC 不等重传，
   丢包表现为音质轻微下降而不是卡住。
2. **打断（barge-in）会重新生效。** 实测 Azure 在 WS 上不到 1 秒就把一整段回复的音频推完，并且比播放结束
   早约 4 秒标记完成，所以 `interrupt_response` 不起作用。WebRTC 按实时速度推，服务端知道播到哪儿，
   打断和截断才有意义。
3. **架构会变，这一条最需要权衡。** WebRTC 时媒体是浏览器和 Azure **直连**，不经过后端。现在的
   `/voice-live/ws` 代理承担了隐藏密钥、鉴权、记录转写、注入预生成 TTS 等职责。改成 WebRTC 后，
   后端只剩签发临时 token 和信令，控制要靠 sideband WS（**【文档】** Azure Realtime 的 SDP 应答带
   `Location` 头，可以用来再连一条控制 WS），上述功能都要重新设计。

---

## 7. Opus 编码

### 7.1 基本情况

- IETF 标准 RFC 6716（2012 年），开源，免专利费
- WebRTC 强制要求支持（RFC 7874）
- 由 Skype 的 **SILK**（语音）和 Xiph 的 **CELT**（音乐、低延迟）融合而来

### 7.2 三种模式

| 模式 | 原理 | 适用 |
|---|---|---|
| SILK | 线性预测，模拟声道 | 低码率语音 |
| CELT | MDCT 变换编码 | 音乐、高码率、超低延迟 |
| Hybrid | 低频 SILK + 高频 CELT | 中码率高质量语音 |

编码器按码率和内容自动切换，无需重新协商。

### 7.3 关键参数

- 码率 6 到 510 kbps；语音 16 到 32 kbps 就很清晰
- 音频带宽从窄带（4 kHz）到全频带（20 kHz）；RTP 时钟固定 48 kHz
- 帧长 2.5 到 60 ms，WebRTC 默认 20 ms
- 算法延迟默认约 26.5 ms，低延迟模式约 5 ms

### 7.4 为实时传输准备的特性

- **带内 FEC**：每个包夹带上一帧的低码率副本，丢一个包能从下一个包大致恢复
- **DTX**：静音时几乎不发包
- **PLC**：丢包时根据前文推测补一段，听感不硬断
- **可变码率**：配合 WebRTC 带宽估计实时调整
- **Opus 1.5**（2024 年）：基于神经网络的深度 PLC，以及 DRED（深度冗余，可夹带长达约 1 秒的冗余）

### 7.5 和本项目 PCM16 对比

| | PCM16（本项目 WS 路径） | Opus（WebRTC） |
|---|---|---|
| 上行（16 kHz） | 256 kbps | 约 24 到 32 kbps |
| 下行（24 kHz） | 384 kbps | 约 24 到 32 kbps |
| 丢包 | TCP 重传，会卡住 | FEC + PLC，听感不断 |

带宽差 10 倍以上。WebRTC 路径上 Opus 只用于浏览器到 Azure 这一段，Azure 解码成 PCM 再交给模型，
模型"听到"的内容和走 WS 时一样。

### 7.6 为什么看起来"只有 WebRTC 能用 Opus"

Opus 是编码格式，和传输协议无关：`.opus` / `.ogg` / `.webm` 文件、`MediaRecorder` 录音、
各类 IM 的语音消息、YouTube 音轨都用它；浏览器 WebCodecs 的 `AudioEncoder` / `AudioDecoder`
也能直接编解码 Opus，编出来的帧完全可以走 WebSocket。

真正的限制在 **Voice Live 的 WebSocket 接口【文档】**（API 参考 2025-10-01 到 2026-06-01-preview 一致）：

| 方向 | 允许的格式 |
|---|---|
| 输入 `input_audio_format` | `pcm16`、`g711_ulaw`、`g711_alaw` |
| 输出 `output_audio_format` | `pcm16`、`pcm16_8000hz`、`pcm16_16000hz`、`g711_ulaw`、`g711_alaw` |

为什么这样设计 **【推断】**：

- WS 接口主要面向服务端对服务端和电话场景，后端手里本来就是 PCM，G.711 是电话网标准。
- Opus 的大部分优势（FEC、PLC）是为会丢包的网络设计的，TCP 已经把丢包变成了重传，这些用不上，只剩省带宽。
- Opus 是一个个独立的包，在字节流上要额外约定帧边界（Ogg 封装或长度前缀），PCM 随便切。

### 7.7 对本项目的可选方案

链路是"浏览器 ↔ 后端 ↔ Azure"，紧张的是第一段（候选人网络），第二段在数据中心内，带宽便宜：

```
浏览器 ──Opus(WS)──▶ 后端 解码成 PCM ──pcm16(WS)──▶ Azure
浏览器 ◀──Opus(WS)── 后端 编码成 Opus ◀──pcm16(WS)── Azure
```

- 收益：候选人一侧带宽降到约十分之一。实测 permessage-deflate 对 PCM 只能压到 95%，基本无效。
- 代价：后端每路会话做 Opus 编解码（libopus 或 PyAV）；每帧增加约 20ms 打包延迟；
  WebCodecs 在 Safari 上的兼容性需要实测；**不解决 TCP 队头阻塞**，只是减轻。
- 另一个现成选项 `g711_ulaw/alaw`：64 kbps，Azure 原生支持，但是 8 kHz 窄带（电话音质），
  会影响识别准确率，面试场景不推荐。

**方向选择**：只想省带宽 → 浏览器到后端这一段换 Opus，架构基本不动；还想消除卡顿 → 必须换 WebRTC
（只有 UDP 能避开队头阻塞），代价是媒体不再经过后端。

---

## 8. 用 chrome://webrtc-internals 验证

### 8.1 一份空 dump 说明什么

```json
"getUserMedia": [],
"PeerConnections": {}
```

两个都为空，意思是导出时这个浏览器 profile 里既没有 WebRTC 连接，也没打开过麦克风，即当时没有面试在进行。
对照代码：纯语音面试会有 `getUserMedia` 记录但 `PeerConnections` 为空（符合"纯语音没有 WebRTC"）；
只有数字人面试两者都有。

常见原因：

1. 导出时面试已结束，或面试页被刷新、关闭过
2. 面试在别的 profile 里进行（无痕窗口、另一个 Chrome 用户、Edge）
3. 人设没开数字人
4. 数字人退回光球（弱网自动降级，或撞上数字人创建速率限制，实测约 3 次/分钟），PeerConnection 很快关闭

### 8.2 正确的抓取步骤

1. **先**打开 `chrome://webrtc-internals` 并保持打开
2. 在**同一个 Chrome 窗口**（非无痕）另一个标签页，用开了数字人的人设开始面试
3. 等数字人画面出现、开始说话，不要关闭或刷新面试页
4. 回到 internals，展开面试页对应的条目：
   - **Stats Tables** 里找 `candidate-pair`，看 `nominated: true` 的那条
   - 顺着 `localCandidateId` / `remoteCandidateId` 找到 `local-candidate` / `remote-candidate`，
     看 `candidateType`（host / srflx / prflx / relay）。只要有一端是 `relay`，媒体就经过了 TURN
   - **Event log** 的 `setRemoteDescription` 里是 Azure 返回的 SDP answer，`a=candidate:` 行是对端候选，
     有 `a=ice-lite` 说明对端是 ICE-lite
5. 再点 "Create dump" 导出

也可以用 `pc.getStats()` 拿到同样的三类记录。

---

## 9. 待实测清单（写文章前补齐）

- [ ] 数字人连接最终选中的候选对类型（local / remote 各是什么）
- [ ] Azure 的 SDP answer 是否 `a=ice-lite`，给了哪些类型的候选
- [ ] 封掉出站 UDP 后，数字人是否能经 TURN（TCP/TLS）恢复画面
- [ ] Voice Live 语音 WebRTC（`rtc.call.sdp.create`）路径是否下发 TURN

## 参考

- Voice Live API 参考（`ice_servers`、`output_protocol`、`session.avatar.connect`、音频格式）：
  https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-04-10
- How to use the Voice Live API：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to
- Azure OpenAI Realtime via WebRTC：https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc
- Realtime API 连接方式对比：https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio
- TTS avatar 实时合成（ICE relay token）：
  https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech-avatar/real-time-synthesis-avatar
- RFC 8445（ICE）、RFC 7675（consent freshness）、RFC 8656（TURN）、RFC 8489（STUN）、
  RFC 6716（Opus）、RFC 7874（WebRTC 音频编码要求）
