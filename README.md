# 叙影（图文小说）

一个面向 Android 手机的 AI 图文小说创作应用雏形。用户可以在同一条创作时间线中与写作模型协作，并把正文、章节、角色定妆照和剧情插画保存为独立作品资产。

项目不依赖业务后端。文本模型和图片模型均由用户在应用内配置，可分别接入不同的 OpenAI 兼容服务。

> 当前处于早期 MVP 阶段，主要面向个人使用和功能验证。

## 已实现功能

- 一个作品对应一个创作会话，正文、章节、角色和插画按作品隔离。
- 支持创建、切换和删除作品，本地内容在应用重启后保留。
- 支持按作品保存长期创作设定，并处理本轮要求与长期设定的优先级。
- 使用稳定段落 ID 与本地 Bigram BM25 检索历史正文，可按章节和段落定位相关原文；检索接口为未来语义检索实现预留扩展点。
- OpenAI 兼容文本模型使用 `o200k_base` tokenizer 估算上下文，并在输入区显示预计 token、可用窗口、分项用量和压缩状态。
- 上下文接近窗口时会按常规、整理、压缩和紧凑四档逐步收敛；章节摘要保留不可变版本历史并支持恢复。
- 伏笔使用应用生成的稳定 ID 记录和核销，避免模型改写措辞后错误匹配。
- 文本模型与图片模型可分别配置多家供应商、API 地址、API Key 和模型。
- 支持获取、搜索并选择 OpenAI 兼容接口返回的模型列表。
- 支持模型自主分章，也支持用户明确要求新开章节。
- 支持作品氛围、插画画风以及浅色/深色应用外观。
- 写作模型可返回结构化视觉计划，并据此建立角色资产和待生成插画。
- 支持角色定妆照、用户参考图、外貌确认以及自由填写反馈后生成优化版本。
- 剧情插画可携带一张或多张角色参考图，并区分“统一为作品画风”和“保留参考图画风”。
- 图片任务串行执行，不自动重试可能产生费用的请求。
- Android 图片会保存到应用私有目录，并具备超时、遗留任务恢复和文件完整性检查。
- 已生成插画支持点击进入全屏预览。
- 生成正文支持消息级点赞/点踩，并可在反馈面板中选择具体段落、原因和补充说明；近期偏好会以紧凑指令参与后续写作。
- 流式写作只展示正文段落，不暴露模型内部 JSON 协议字段；完成落库时避免临时流与最终正文重复显示。

## 技术栈

- React 19
- TypeScript
- Vite
- Dexie / IndexedDB
- Capacitor 8
- Capacitor Filesystem
- Android KeyStore 安全存储插件

## 本地运行

### 环境要求

- Node.js 20 或更高版本
- npm

### 启动 Web 开发环境

```bash
npm install
npm run dev
```

Web 版本主要用于界面和基础逻辑调试。出于安全考虑，Web 预览中的 API Key 只保存在当前页面内存中，刷新页面后需要重新填写。

### 生产构建

```bash
npm run build
```

### 测试

```bash
npm test
```

提交或发布前应至少通过全量测试、生产构建，以及受影响平台的实际构建。

## Android 构建

除 Node.js 外，还需要：

- JDK 21
- Android SDK Platform 36
- Android Build Tools 36

Windows PowerShell 可以先设置本机工具链路径（不要把真实本机路径提交到仓库）：

```powershell
$env:JAVA_HOME = 'C:\path\to\jdk-21'
$env:ANDROID_SDK_ROOT = 'C:\path\to\Android\Sdk'
$env:ANDROID_HOME = $env:ANDROID_SDK_ROOT
```

同步 Web 资源和 Capacitor 插件：

```bash
npm run android:sync
```

Windows 构建 Debug APK：

```powershell
cd android
.\gradlew.bat assembleDebug
```

macOS 或 Linux：

```bash
cd android
./gradlew assembleDebug
```

构建完成后，APK 位于：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

配置 `android/keystore.properties` 后可构建签名 Release APK：

```powershell
cd android
.\gradlew.bat assembleRelease
```

Release APK 位于：

```text
android/app/build/outputs/apk/release/app-release.apk
```

连接已开启 USB 调试的设备后，确认设备在线并覆盖安装 Debug 包：

```powershell
adb devices
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

`-r` 会覆盖现有安装并尽量保留本地作品和应用数据；如需清空数据，应明确执行 `adb shell pm clear com.illustratedstory.app`。当前 Android application ID 为 `com.illustratedstory.app`。

## 模型接口要求

当前版本按 OpenAI 兼容协议调用服务，主要使用以下端点：

- `GET /models`
- `POST /chat/completions`
- `POST /images/generations`
- `POST /images/edits`

不同供应商对图片尺寸、多参考图、返回 URL 或 Base64 的支持可能不同，需要以具体服务能力为准。

## 数据与 API Key

- 项目不包含任何内置 API Key。
- Android 端使用基于 Android KeyStore 的安全存储保存用户填写的 Key。
- 作品正文和结构化资产保存在本机 IndexedDB。
- 图片保存在应用私有文件目录。
- 应用会直接连接用户配置的模型服务，不经过项目作者的服务器。
- 清除应用数据或卸载应用会移除本地作品、图片和已保存的 Key。

## 当前限制

- 目前优先支持 Android，尚未针对 iOS 发布流程做适配。
- 没有云同步、账号系统或多设备协作。
- 不同 OpenAI 兼容供应商的图片接口细节可能存在差异。
- 仍需要继续进行更多真实设备、长篇作品和异常网络场景测试。

## 开发原则

- 一个会话就是一部作品。
- 用户明确控制可能产生费用的重试操作。
- 角色外貌、作品画风和剧情视觉计划分开保存。
- 不把 API Key、构建产物或本机路径提交到公开仓库。
