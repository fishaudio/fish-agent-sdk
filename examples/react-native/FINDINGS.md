# Wire protocol 移动端接入评估

测试时间：2026-11-08。

- 测试对象：用本目录的 demo（Expo SDK 58、React Native 0.88、`@livekit/react-native` 3.1、`livekit-client` 2.20）连线上环境（`api.fish.audio`，LiveKit Cloud 日本节点）。
- 设备：Pixel 8（Android 17）和 iPhone 12（iOS 26.6）。iPhone 通过 Appium/WebDriverAgent 远程操控。
- 网络：办公室 Wi-Fi，到公网的 RTT 约 170–270 ms，时好时坏。这正好顺带测了弱网。

## 结论

协议在移动端能用。只基于 `@fishaudio/agent-protocol` 和 `livekit-client` 写的客户端，在 Android 和 iOS 上都完成了完整通话，包括：

- 开场白和多轮对话
- 双方的实时文字记录
- 文字输入
- client tool，包括需要等用户点按的那种
- 打断、静音
- 挂断
- Wi-Fi 断开后的信令重连（在 Android 上测过）
- 切到后台时保持通话（仅 iOS；Android 的情况见 P1-1）

现有的 Web SDK（`@fishaudio/agent-client`）不改代码也能在 RN 里跑，前提是先调用 `@livekit/react-native` 的 `registerGlobals()`。

问题集中在四个方面，下文逐条列出：
1. 公开 agent 的鉴权。
2. 客户端没法知道媒体通道是否真的打通。
3. 移动端生命周期：后台音频和重连。
4. 很多语义只存在于 Web SDK 的源码里。

优先级：**P0** 指会阻碍正式的移动端 SDK 上线；**P1** 指用户一定会遇到；**P2** 是小问题或文档缺失。

## 问题清单

### P0-1. 公开 agent 在原生 app 上没有有效的鉴权

不带 key 调 `POST /v1/agent/sessions` 时，请求必须带 `Origin` 头，而且要在 agent 的 `allowed_origins` 白名单里（见 `platform-api/apps/agents/sessions/service.py` 的 `_authorize_public`）。

- 原生 app 发请求不带 Origin，会拿到 `403 Origin header is required for public agents`。
- 任何非浏览器客户端都能随便设置这个头。已验证：不带 Origin 返回 403，带 `Origin: https://example.com` 返回 201。demo 的"公开 agent"模式就是这样连上的。

所以这个白名单只能拦住浏览器，拦不住其他任何客户端。移动端 app 要么伪造 Origin，要么必须自己搭后端。

竞品也没有做得更好：
- ElevenLabs 的公开 agent 只凭 `agentId` 就能连，白名单也是按域名的。
- Retell 的 public key 同样按域名校验，而且 Retell 没有 RN SDK。

**建议**：给原生 app 单独提供一条鉴权路径。可选方案：
- 按 bundle ID / package name 做白名单。单独用不算安全，但至少和 Origin 白名单同等，还能按 app 限流。
- 可选接入 App Attest / Play Integrity，提供真正的防护。
- 至少要在文档里写明：公开 agent 任何客户端都能访问，移动端 app 应该由后端签发 token。

### P0-2. 客户端分不清"已连接"和"媒体已打通"

弱网下，信令连接用了 24 秒才建立，但 ICE 一直没打通：

- agent 的音频轨始终没订阅上，开场白完全没听到。
- 客户端显示"通话中"、agent"在听"，持续了 40 秒。
- 之后服务端删除了房间（`ROOM_DELETED`）。
- 客户端没收到 `session.ended`，因为 data channel 走的是同一条已经断掉的 PeerConnection。客户端只能兜底报 `agent_hangup`，这是错的。

协议里没有"双向媒体已经通了"的信号。客户端（包括 Web SDK）以房间连接成功和 `fish.agent.ready` 作为"已连接"的依据，这两者都证明不了媒体是通的。

**建议**：
- 客户端应该在订阅到 agent 的音频轨之后才算"已连接"（demo 日志里的 "agent audio subscribed"）。在那之前显示一个单独的"正在连接语音…"状态，并且单独设一个超时。
- 在传输层还能通信的情况下，runtime 应该带着原因结束这类会话。服务端记录里也要写明原因（例如 `media_timeout`），以便和客户端显示的原因对得上。

### P1-1. Android 切后台后麦克风被静音（iOS 正常）

Android 14 及以上，app 如果没有"麦克风"类型的前台服务，一离开前台录音就会被静音。

- 按 Home 键后不到 1 秒，`dumpsys audio` 显示录音会话变成了 `silenced`。
- 通话没断，agent 还在说话，但它听不到任何声音，双方都不知道。
- 回到前台后录音自动恢复，通话继续。

iOS 只要在 `app.json` 里配置 `UIBackgroundModes: audio` 就没问题：通话中按 Home 键后，橙色麦克风胶囊一直亮着，通话没断，切回来还能继续对话。

LiveKit 的 Expo 插件不会加前台服务，这条技术栈里也没有其他组件会加。ElevenLabs 有一个相关的 issue 没解决（elevenlabs/packages#715）。

**建议**：
- RN SDK 自带一个 Expo config plugin 和原生模块：会话进行期间运行 `microphone` 类型的前台服务，并显示"通话中"常驻通知。需要 `FOREGROUND_SERVICE_MICROPHONE` 权限。
- 可选：增加 `user.away` / `user.back` 客户端消息，让 agent 能暂停，而不是对着空气说话。

### P1-2. Web SDK 的状态机感知不到"仅信令重连"

Wi-Fi 断开 8 秒触发的是信令恢复：
- 触发了 `RoomEvent.SignalReconnecting`，之后是 `Reconnected`。
- 没有触发 `RoomEvent.Reconnecting`。

`packages/client/src/transport/livekit.ts:149` 只监听了 `Reconnecting`，所以那 16–22 秒里状态一直是"已连接"，实际上什么都不通。demo 已经把 `SignalReconnecting` 也当作重连中处理，"重连中…"能正确显示。

**Web SDK 的修法**：把 `RoomEvent.SignalReconnecting` 也映射到 `reconnecting` 状态。

### P1-3. 加入房间慢时开场白会丢

正常加入时，`fish.client.audio_ready` 握手能正确地把开场白压住。在计了时的三次通话里，开场白分别在 `audio_ready` 之后 1.0、3.0、6.1 秒开始。

慢的那次（连接用了 24 秒），agent 在客户端发出 `pending` 之前早就就绪了。开场白在客户端加入约 1 秒后就播出了，那时客户端还没订阅到 agent 的音频轨。看起来 runtime 有上限的等待是从它自己的 pipeline 启动开始算的，而不是从客户端加入开始算。

**建议**：runtime 等待 `pending` / ready 的计时，改为从客户端参与者加入时开始，而不是从 pipeline 就绪时开始。

### P1-4. 完整重连可能因 `DUPLICATE_IDENTITY` 导致通话结束

过程如下：
1. 弱网下发布麦克风超时（`NegotiationError: negotiation timed out`）。
2. LiveKit 发起完整重连。
3. 客户端以 `DUPLICATE_IDENTITY` 被断开，通话结束。

看起来是 session token 里固定的 identity 和之前那个半死的参与者冲突了。需要负责签发 token 的同学看一下：用同一个 token 完整重新加入，本来是否应该能成功。

### P1-5. client tool 的超时时间不在协议里

`client_tool.call` 不带服务端的超时时间。
- 测试用的 tool 配置的是 `timeout_seconds: 30`。
- Web SDK 默认 15 秒（`DEFAULT_CLIENT_TOOL_TIMEOUT_MS`）。所以一个等用户点按的 tool 在 15 秒时报了 `tool_timeout`，而 agent 其实愿意等 30 秒。

**建议**：在 `client_tool.call` 里加上 `timeoutMs`，SDK 默认使用这个值。

### P2-1. `lk.agent.state` 比 `fish.agent.ready` 先到

加入房间时，agent 身上已经带着 `lk.agent.state: "listening"`，而 `fish.agent.ready` 要晚 1.7–3.7 秒才到（三次测量）。

Web SDK 把任何 agent 状态都当作"agent 已在场"（`agentSession.ts` 里 `onAgentState` → `#handleAgentPresent`），于是会在 pipeline 就绪之前就把排队中的 `user.message` 发出去。而 ready 属性存在的意义，恰恰就是防止这件事。

协议注释说只对老版本 runtime 才回退到 `lk.agent.state`，但客户端没法区分"老版本 runtime"和"新版本但还没就绪"。demo 现在最多等 8 秒 `fish.agent.ready`，等不到才回退。

**建议**：Web SDK 也这么改。更好的办法是让 agent 声明自己的协议版本，客户端据此判断该不该等 `fish.agent.ready`。

### P2-2. 固定开场白的文字没有和播放同步

LLM 生成的回复是按播放进度逐段推送的（有一条回复 14 秒内推了 38 段），在 RN 的 `ReadableStream` polyfill 下也正常。

但 `first_message_mode: "fixed"` 的开场白是一段一次性到达的，5 ms 内流就关闭了。文字在开口时就到了，比 agent 说完早大约 3 秒。Web SDK 是根据"agent 文字流是否开着"来判断 `speaking` 的，所以开场白期间状态会瞬间从"说话中"跳回"在听"。

**建议**：让 runtime 像其他轮次一样流式推送固定开场白；或者在协议里把状态定义为 `lk.agent.state`，它在每次测试里都是准确的。

### P2-3. 关键语义只存在于 Web SDK 源码里

只看 `@fishaudio/agent-protocol` 写不出能用的客户端。下面这些都是从 `packages/client/src/transport/livekit.ts` 和 `session/agentSession.ts` 里读出来的：

- `lk.agent.state` 没有导出为常量。
- `pending` 什么时候发：加入后立刻发，在任何 await 之前。ready 值什么时候发：agent 的声音真正开始播放时。完整重连后还要重新发布。
- `lk.transcription` 的细节：
  - `lk.segment_id` 和 `lk.transcription_final` 两个属性
  - 用发送者的 identity 区分角色
  - agent 的文字段在流关闭时才算最终结果
  - 用户的文字段每次更新都会整段重发
- agent 参与者离开就表示通话结束，`ROOM_DELETED` 和 `ROOM_CLOSED` 也一样。它们和 `session.ended` 的优先级规则、以及 10 秒的宽限期，也只写在代码里。
- agent 就绪前发出的消息会被丢掉，客户端必须自己排队。
- agent 加入的超时是 15 秒。
- `client_tool.result` 大约有 60 KB 的上限（受 data channel 包大小限制）。
- `tool_events` 默认是 true；tool 事件里的 `nodeId` 是必填字段，但文档里没写。

**建议**：写一页协议规范（"如何编写一个客户端"），覆盖以上内容，并配一张加入握手的时序图。demo 的 `src/agent/FishCall.ts`（约 450 行）基本就是第三方目前至少要写的代码量。

### P2-4. 其他小问题

- 弱网下，设置 `fish.client.audio_ready` 属性的 `setAttributes` 超时过一次（`Request to update local metadata timed out`）。data channel 上只有 ready 值的副本，`pending` 没有。
- 每次断网，LiveKit 内部都会抛出一个没人处理的 promise 异常（一个裸的 `error` 类型 `Event`）。它不影响功能，但开发版里会弹红屏。SDK 应该把它吞掉。
- 启动耗时（本次网络环境下的实测）：
  - 申请 token：1.0–1.6 秒
  - 房间连接：网好时 3.6–4.3 秒，网差时 10–24 秒（iPhone 那次是 10.4 秒）
  - 收到 agent 的第一个音频轨：网好时约 6 秒
- 在 RN 里，Web SDK 的播放元素和屏幕常亮都会因为 `typeof document` 判断而跳过，所以它永远不会上报 `audio_ready`，开场白要等满 runtime 的等待上限才播。原生 WebRTC 本身会播放声音，所以 RN SDK 的正确做法是在订阅到音频轨时上报 ready，demo 就是这么做的。

## 竞品对比：ElevenLabs 和 Retell

调研时间是 2026-11，资料来源是 npm、GitHub 源码和官方文档，链接列在本节末尾。

**结论：ElevenLabs 有 RN SDK，底层同样是 LiveKit；Retell 目前没有 RN SDK。** 也就是说，我们基于 LiveKit 的协议设计（data channel topic、participant attribute、`lk.transcription`）和 ElevenLabs 线上的方案是同一路线，协议本身适合移动端。

| | ElevenLabs `@elevenlabs/react-native` | Retell | 我们（现状） |
|---|---|---|---|
| RN SDK | 有（v1.2.38，2026-11-04 更新） | 没有（`retell-client-react-native-sdk` 在 npm 上是 404） | 没有，Web SDK 可以直接在 RN 里跑 |
| 传输 | LiveKit WebRTC。RN 上只支持 WebRTC，传 WebSocket 或 signedUrl 会直接报错 | Web 端是 LiveKit；RN 开发者只能自己用后端拿 LiveKit token 再接 `@livekit/react-native` | LiveKit WebRTC |
| 实现方式 | 在 Web SDK 外面包一层：调用 `registerGlobals()` 并替换会话初始化 | — | — |
| Expo | 只支持 dev build；没有自己的 config plugin，权限要自己配 | — | demo 用的是 LiveKit 官方插件，也只支持 dev build |
| API 形态 | `<ConversationProvider>` + 一组 hook（`useConversation`、`useConversationControls`、`useConversationClientTool` 等） | Web 端是 class：`new RetellClient()` → `createWebCall()` | Web SDK 是 class + `useConversation` hook |
| 公开 agent 鉴权 | 只凭 `agentId` 就能连；白名单按域名，没有面向移动端的方案 | public key 按域名校验，可选 reCAPTCHA，没有原生方案 | 只校验 Origin，原生 app 只能伪造（P0-1） |
| 私有 agent | 后端用 API key 换 `conversationToken` | 后端调 `create-web-call` | 后端换 session token |
| 事件 | 连接、断开、状态、模式、消息、错误、音频、VAD 分数、逐字时间戳、流式文字 | 状态、结束、错误；转写需要更高权限的 key | 状态、模式、转写、tool 事件、错误、结束原因 |
| client tool | 有，返回值回传给 agent（需在后台设为 blocking） | 没有 | 有 |
| 其他能力 | `sendContextualUpdate`、`sendUserActivity`、音量、静音、输入输出电平 | 静音；`monitorCall` 可以注入上下文 | 文字消息、打断、activity、静音 |
| 音频会话 | 每次会话写死配置：Android 和 iOS 都强制扬声器 | — | demo 默认扬声器，可以切听筒 |
| 后台 / 来电 / 网络切换 | 没有处理，只靠 LiveKit 默认行为，文档也没写 | — | iOS 后台正常；Android 后台静音（P1-1） |

**ElevenLabs RN SDK 的已知问题**（`elevenlabs/packages` 里的 issue）：
- #881：Android 上强制扬声器，蓝牙和有线耳机用不了。
- #991：iOS 上连续打第二通电话时，麦克风已发布但采集到的是静音。
- #715：没有说明 app 切后台时的行为。
- #641、#766：早期版本在 TrackSubscribed 里用了 DOM API，需要大量浏览器 polyfill。
- #416：RN 上 `onAgentToolResponse` 不触发。
- #605、#658：WebSocket 模式在 RN 上会立刻断开，音量一直是 0。
- #1051：错误和状态混在一起（设计问题，未解决）。
- LiveKit RN 社区反馈：通话中用 expo-audio 播放声音会把 LiveKit 的音频会话搞挂。

**我们可以比两家做得好的地方：**
1. 原生 app 的公开 agent 鉴权（bundle ID 白名单、App Attest / Play Integrity）。两家都只有浏览器域名白名单。
2. 音频路由可配置，不要写死扬声器，让耳机能用（避开 ElevenLabs #881）。
3. 明确的后台和来电行为，Android 前台服务开箱即用（避开 ElevenLabs #715）。
4. 明确的重连事件、"媒体已连接"状态和断开原因（P0-2、P1-2）。
5. 错误和状态分开。
6. 提供 Expo config plugin，一次配好权限、后台音频和前台服务。

**资料来源：**
- https://elevenlabs.io/docs/agents-platform/libraries/react-native
- https://github.com/elevenlabs/packages/blob/main/packages/react-native/src/index.react-native.ts
- https://github.com/elevenlabs/packages/issues
- https://community.livekit.io/t/react-native-voice-session-terminating-in-background/945
- https://github.com/RetellAI/retell-client-js-sdk
- https://docs.retellai.com/deploy/web-call
- https://github.com/orgs/RetellAI/repositories

## RN SDK 在 Web SDK 之外还需要什么

ElevenLabs 的 `@elevenlabs/react-native` 基本就是他们的 Web 客户端，加上 `registerGlobals()` 和 `AudioSession` 配置。用 `@fishaudio/agent-client` 照做，现在就能跑。想做得比它好，还需要：

1. 在 SDK 内部处理 `registerGlobals()` 和 `AudioSession` 的启停，音频输出路由可配置。ElevenLabs 把输出写死成扬声器，导致耳机没法用（elevenlabs/packages#881）。
2. 订阅到 agent 音频轨时上报 `audio_ready`（见 P2-4）。
3. 一个 Expo config plugin，负责：
   - 麦克风权限文案
   - iOS 的 `UIBackgroundModes: audio`
   - Android 的麦克风前台服务（P1-1）
4. 处理 `SignalReconnecting`（P1-2），并提供"媒体已连接"状态（P0-2）。
5. hook 形式的 API，和 `@fishaudio/agent-react` 的 `useConversation` 保持一致。

## 还没测的

以下需要有人拿着手机配合：

- iOS 上的 Wi-Fi 断开重连、锁屏，以及 Web SDK 引擎。iOS 的基本通话、client tool 和切后台已经测过，都正常。
- 两个平台上，通话中来电（音频被打断后能否恢复）。
- Wi-Fi 和蜂窝网络互切（Pixel 没插 SIM 卡），目前只测了断开 Wi-Fi。
- 蓝牙耳机的音频路由。
- 同一网络下和桌面浏览器里的 Web SDK 做延迟对比。
