# React Native SDK

[English](react-native.md) | 中文

`@fishaudio/agent-react-native` 让 React Native App 可以和 Fish Audio 的语音 agent 通话。通话本身用的是和 [Web SDK](README.md) 同一套代码，所以连接、文字记录、客户端工具、结束原因的行为都一样。在此之上，这个包处理了手机特有的事情：

- Android 的麦克风权限；
- 系统音频会话和输出路由（扬声器、听筒、耳机）；
- 后台通话：Android 前台服务，iOS 后台音频；
- 一个 Expo 配置插件，自动写入原生设置。

Expo 项目和纯 React Native 项目都能用，不强制依赖 Expo。

> 本页其他链接指向的页面目前只有英文版。

## 前提条件

- **需要原生构建。** WebRTC 是原生模块。Expo 项目用 `npx expo run:ios` / `run:android` 或 EAS Build 构建，不能用 Expo Go 运行（`expo-dev-client` 可装可不装）。纯 React Native 项目照常构建，见[纯 React Native](#纯-react-native)。
- **真机。** 涉及麦克风的功能都要在真机上测。
- **你自己的后端**，用来创建 session token（见 [Session token](#session-token)）。不要把 API key 打包进 App。
- **已测试的版本：** Expo SDK 58 和纯 React Native 0.88，`@livekit/react-native` 3.1，`@livekit/react-native-webrtc` 150.1，`livekit-client` 2.20–2.23，系统为 iOS 26 和 Android 17。其他版本也许能用，但没有测过。

## 安装（Expo）

```sh
npx expo install @fishaudio/agent-react-native @livekit/react-native @livekit/react-native-webrtc \
  @livekit/react-native-expo-plugin @config-plugins/react-native-webrtc livekit-client
```

`npx expo install` 会自动把三个配置插件加进 `app.json`。如果用的是 npm 或 yarn，需要手动加：

```json
{
  "expo": {
    "plugins": [
      "@livekit/react-native-expo-plugin",
      "@config-plugins/react-native-webrtc",
      ["@fishaudio/agent-react-native", { "microphonePermission": "用语音和客服对话" }]
    ]
  }
}
```

然后构建原生 App：`npx expo run:ios --device` 或 `npx expo run:android --device`。每次新增带原生代码的包、或者修改插件配置后，都要重新构建，只刷新 JavaScript 不会生效。

插件选项：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `microphonePermission` | `"Allow $(PRODUCT_NAME) to use the microphone for voice calls."` | iOS 麦克风权限弹窗里的说明文字。设为 `false` 则不改动 `NSMicrophoneUsageDescription`。 |
| `backgroundAudio` | `true` | 添加 iOS 的 `audio` 后台模式，App 切到后台或锁屏时通话继续。 |

Android 不需要任何配置：构建时，包里的 manifest 会自动加入麦克风、音频、前台服务相关的权限以及服务本身。

## 纯 React Native

不用 Expo 时，安装时不需要配置插件，原生设置自己加：

```sh
npm install @fishaudio/agent-react-native @livekit/react-native @livekit/react-native-webrtc livekit-client
```

- **LiveKit 原生初始化：** 按 [LiveKit React Native 安装说明](https://github.com/livekit/client-sdk-react-native#installation)操作，它代替了 Expo 项目里 LiveKit 和 WebRTC 的两个配置插件。要点：
  - Android `MainApplication.kt`：在 `onCreate` 里调用 `LiveKitReactNative.setup(this, AudioType.CommunicationAudioType())`。
  - iOS `AppDelegate.swift`：`import livekit_react_native`，然后在 `didFinishLaunchingWithOptions` 里调用 `LivekitReactNative.setup()`。
  - iOS `Podfile`：LiveKit 的 WebRTC pod 发布在 LiveKit 自己的源里，要在 Podfile 顶部加上下面两个源，再运行 `cd ios && pod install --repo-update`。不加的话，`pod install` 会报 `None of your spec sources contain a spec satisfying the dependency: LiveKitWebRTC`。

    ```ruby
    source 'https://github.com/livekit/podspecs.git'
    source 'https://cdn.cocoapods.org/'
    ```

- **iOS `Info.plist`：** 加上麦克风说明文字，以及 `audio` 后台模式（让通话在后台继续）：

  ```xml
  <key>NSMicrophoneUsageDescription</key>
  <string>用语音和客服对话</string>
  <key>UIBackgroundModes</key>
  <array>
    <string>audio</string>
  </array>
  ```

- **Android：** 不用加任何东西。自动链接会注册包里的原生模块，包的 manifest 会带上权限和前台服务。

然后用 `npx react-native run-ios` / `run-android` 构建。入口文件写法和下面"不用 expo-router"的写法相同，只是把 `registerRootComponent` 换成 `AppRegistry.registerComponent`。

## 设置入口文件

`setupFishAgent()` 负责安装 SDK 运行所需的 WebRTC 全局对象，在入口文件最顶部调用一次即可。即使忘了调用，`startSession` 也会自动补上，不会导致通话失败；但仍建议放在入口文件里，因为别的代码可能在第一次通话前就用到 WebRTC。

**使用 expo-router**（`create-expo-app` 默认模板）时，新建一个 `index.ts`：

```ts
// index.ts
import { setupFishAgent } from "@fishaudio/agent-react-native";
setupFishAgent();

import "expo-router/entry";
```

并把 `package.json` 里的 `main` 指向它：`"main": "index.ts"`。

**不用 expo-router** 时，在现有入口文件顶部调用：

```ts
// index.ts
import { setupFishAgent } from "@fishaudio/agent-react-native";
setupFishAgent();

import { registerRootComponent } from "expo";
import App from "./App";
registerRootComponent(App);
```

## Session token

用户发起通话时，App 向你的后端请求 session token。后端带上 API key 调用 `POST /v1/agent/sessions`，把返回结果原样交给 App。[Authentication](authentication.md) 里有 Node 和 Python 的后端示例。网页和手机用的是同一个接口。

在手机上有两点和浏览器不同：

- **`localhost` 指的是手机自己，不是你的电脑。** 开发时请用电脑的局域网地址；Android 也可以用 `adb reverse tcp:3001 tcp:3001` 转发端口。
- **iOS 会拦截明文 `http://`**（开发构建除外）。token 接口请用 HTTPS。

公开 agent（不需要 key 的会话）是为网站设计的：服务端会把浏览器的 `Origin` 请求头和白名单比对，而原生 App 不会发送这个头。App 请使用自己的后端。

## 快速开始

```tsx
import { useAgentMessages, useConversation } from "@fishaudio/agent-react-native";
import { Button, FlatList, Text, View } from "react-native";

export default function SupportCall() {
  const conversation = useConversation(
    { clientTools: { show_order: async ({ orderId }) => ({ shown: true }) } },
    { callNotification: { title: "正在和客服通话" } },
  );
  const messages = useAgentMessages(conversation.session);

  const start = async () => {
    const sessionToken = await fetch("https://api.example.com/agent-session", { method: "POST" })
      .then((r) => r.json());
    await conversation.startSession({ sessionToken });
  };

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text>{conversation.status} · {conversation.mode}</Text>
      <Button title="通话" onPress={() => void start()} />
      <Button title="挂断" onPress={() => void conversation.endSession()} />
      <FlatList
        data={messages}
        keyExtractor={(m) => m.key}
        renderItem={({ item }) => <Text>{item.role}: {item.text}</Text>}
      />
    </View>
  );
}
```

在 Android 上，`startSession` 第一次调用时会弹出麦克风权限请求（iOS 在开始收音时由系统自动弹出），所以请在按钮点击时调用它。

## `useConversation(defaults?, options?)`

参数、返回值和生命周期都和 [React SDK 的 hook](react/useConversation.md) 相同，另外增加了：

| 新增 | 类型 | 说明 |
|---|---|---|
| `startSession` | `(overrides?) => Promise<string>` | 连接之前还会：请求 Android 麦克风权限（用户拒绝时以 `mic_permission_denied` 失败）、设置音频会话和输出路由、在 Android 上启动通话的前台服务。 |
| `endSession` | `() => Promise<void>` | 还会释放音频会话、停止前台服务。agent 挂断或连接断开时也会自动释放。 |
| `audioOutput` | `"auto" \| "speaker" \| "earpiece"` | 你选择的路由（不是当前实际播放的设备，见[限制](#限制)）。 |
| `setAudioOutput` | `(route) => Promise<void>` | 切换路由，通话前或通话中都可以。 |

路由：

- `auto`（默认）：连接了蓝牙或有线耳机就用耳机，否则用扬声器。
- `speaker`：始终用扬声器，即使连着耳机。
- `earpiece`：听筒，适合贴耳通话。

第二个参数 `MobileConversationOptions`：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `audioOutput` | `"auto"` | 初始路由。 |
| `callNotification` | `{ title: "Call in progress" }` | Android：通话期间显示的常驻通知，格式为 `{ title, text }`。设为 `false` 会关闭前台服务，App 在后台时麦克风会被系统静音。 |

其余内容（`status`、`mode`、`micMuted` / `setMicMuted`、`sendUserMessage`、`interrupt`、`session`、客户端工具、回调、错误）见 [React SDK](react/useConversation.md)、[Events](events.md)、[Client tools](client-tools.md) 和 [Errors](errors.md)。`useAgentMessages` 和 `AgentSessionProvider` 从 React SDK 原样导出，用法相同。

## 后台通话

- **iOS：** 开启 `audio` 后台模式后（插件默认开启），App 切到后台或锁屏时通话继续，用户可以接着说话，也能听到 agent。
- **Android：** 通话期间 SDK 会运行一个麦克风类型的前台服务，并显示常驻通知。从 Android 14 开始，App 一离开前台，系统就会静音它的麦克风（agent 那边照常说话），除非有这样的服务在运行。在 Android 13 及以上，即使用户关闭了通知权限，服务照样运行，只是通知不显示。

## 限制

- **拿不到音量。** React Native 没有 Web Audio API，所以 `useAudioLevels` 和 `session.getInputVolume()` / `getOutputVolume()` 一直是 0，也没有导出 `AgentAudioVisualizer`。可以用 `mode` 来驱动"正在说话"的动画。
- **`audioOutput` 是你选择的路由**，不代表当前设备。在 `auto` 模式下插上耳机，声音会切到耳机，但 `audioOutput` 仍然是 `auto`，也没有路由变化事件。
- **`mode` 和中文回复。** `speaking` 状态跟随 agent 的文字记录，而中文回复的文字目前是一次性整段到达，不随播放进度推进。所以中文对话里 `speaking` 只会短暂出现。
- **尚未测试：** 来电打断通话、蓝牙耳机、Wi-Fi 和蜂窝网络切换、iOS 断网后重连。

## 常见问题

| 现象 | 原因和解决办法 |
|---|---|
| 在 Expo Go 里运行时报缺少原生模块 | Expo Go 加载不了 WebRTC。用 `npx expo run:ios` / `run:android` 构建 App。 |
| 警告 `Native module missing: background calls will lose the microphone` | 安装包之后没有重新构建 App。重新构建原生 App（`npx expo run:android` 或 `npx react-native run-android`）。 |
| `startSession` 以 `connection_failed`（"Could not establish the realtime session"）失败 | 检查 token 接口返回的是否是 `POST /v1/agent/sessions` 的结果、token 是否拿到后马上使用（token 有效期很短）、设备是否联网。如果你在第一次通话前直接调用了 LiveKit 或 WebRTC 的 API，请先在入口文件调用 `setupFishAgent()`。 |
| 改了插件配置没生效（没有麦克风说明、没有后台音频） | 原生设置只在重新构建时更新：重新运行 `npx expo prebuild`（或 `run:ios` / `run:android`）。纯 React Native 项目请检查 `Info.plist` 后重新构建。 |
| iOS `pod install` 报找不到 `LiveKitWebRTC` | Podfile 顶部没加 LiveKit 的源，见[纯 React Native](#纯-react-native)。 |
| 手机上请求 token 接口失败 | `localhost` 指向的是手机。改用电脑的局域网地址或 `adb reverse`；iOS 上请用 HTTPS。 |
| Android：App 在后台时 agent 听不到用户说话 | `callNotification` 设成了 `false`，或者装包后没有重新构建，导致没有前台服务。 |
| 首次启动时弹出本地网络或附近设备的权限请求 | 调试构建会在局域网里寻找开发服务器，和通话无关。 |
| 国行 iPhone 首次联网时弹出"允许使用无线数据" | 系统对所有新 App 都会询问，选"WLAN 与蜂窝网络"即可。 |
| 挂断后出现 `ping timeout triggered` 或 `not found in senderGetStats()` 警告 | LiveKit 断开时的无害日志。想减少 LiveKit 的日志：`import { setLogLevel } from "livekit-client"; setLogLevel("warn");` |
| monorepo 里装完后出现奇怪的问题 | 确认只装了一份 `@livekit/react-native` 和 `livekit-client`（`npm ls @livekit/react-native livekit-client`）。 |
