# 变更记录

## 2026-08-10 — 项目内 Release 签名与手机覆盖安装

- 将 `C:\Users\Zhou\Desktop\keystore\xuying-release.keystore` 复制到项目内 `android/xuying-release.keystore`，源文件与项目副本 SHA-256 一致；沿用项目已有且被忽略的 `android/keystore.properties`，仅把 `storeFile` 改为 `../xuying-release.keystore`，构建不再依赖项目外路径。
- `android/xuying-release.keystore` 由仓库根目录的 `*.keystore` 规则忽略，`android/keystore.properties` 由 `android/.gitignore` 忽略；密码和密钥均未进入版本控制或命令输出。
- 运行 `npm run android:sync` 完成 production 构建与 Capacitor Android 资源同步，随后运行 `android/gradlew assembleRelease`，生成签名 APK：`android/app/build/outputs/apk/release/app-release.apk`，SHA-256 为 `0D47C1E9BC10EAD65806622504E52C483B02C37774BCD8BAA3F7E6417658498C`。
- 新 APK 包名为 `com.illustratedstory.app`，`versionCode=1`、`versionName=1.0`；其签名证书 SHA-256 与手机现装版本一致。执行 `adb install -r` 返回 `Success`，覆盖安装并保留应用数据。
- 安装后确认 `lastUpdateTime=2026-08-10 10:19:18`，应用进程已启动，`com.illustratedstory.app/.MainActivity` 为手机当前前台 Activity。

## 2026-08-10 — 图片鉴权保存、写作结果恢复与上下文显示修复

- 修复定妆照/插画的 URL 保存链路：移除 Android `Filesystem.downloadFile` 裸 GET。图片接口返回 URL 时改由统一网络传输层读取；与模型服务同源的 URL 携带原 Provider Bearer，跨域 CDN/签名 URL 不发送 API Key，避免凭据泄露。Web 匿名 URL 保持直接展示，不因 CORS 强制读取响应体。
- 仅对明确支持的 `dall-e-2` / `dall-e-3` 请求 `b64_json`；`gpt-image-*` 和未知兼容模型不附加可能被拒绝的 `response_format`，仍可使用默认 base64 或鉴权 URL 回退，且不会通过重发生成请求来兼容。
- Android 图片落盘改为 4 字节对齐的 base64 分块写入临时文件，并通过 `stat` 与头尾局部读取校验完整性；同名旧图片采用可回滚替换，保存失败时只恢复本轮开始后生成的文件，不会把旧定妆照误判为本轮成功结果。
- 写作结构化 JSON 尾部损坏时，仅恢复并保存已经闭合的 `prose.paragraphs`；实时流式显示仍可展示正在生成的末段，完整 JSON 继续保留章节摘要、场景笔记和视觉计划，协议元数据不会被误当正文。
- 空输入时继续计算并显示当前作品的基础上下文用量；弹层 Presence 在 `open=true` 的当前渲染帧立即呈现，消除从设置进入模型服务时二级页面晚一帧出现造成的闪屏。
- 验证：相关 Vitest 6 个文件 / 40 项通过；`npm run build` 通过；Impeccable detector 返回 `[]`；桌面与 390×844 移动视口浏览器回归通过，清空输入后上下文用量仍显示。全量 `npm test` 为 146 项通过、4 项 5 秒超时，其中 3 项单文件复跑通过；未触及的 HEIC 解码失败提示用例单独运行仍超时，作为独立既有问题保留。

## 2026-08-10 — 移除仓库内的本地代理配置

- 从版本控制中移除 `AGENTS.md` 与 `.codex/` 下的代理配置；这些文件当前本地也不再保留。
- `.gitignore` 增加 `AGENTS.md` 和 `.codex/`，并保留已有的 `.agents/` 忽略规则，避免本地代理配置再次误提交到远端仓库。

## 2026-08-08 — README 更新与签名 Release 实机安装

- README 补齐段落检索、真实 token 预算、渐进压缩、摘要版本、稳定伏笔 ID、正文反馈和流式正文投影等当前能力，并增加测试、Release 构建与覆盖安装说明。
- 使用 JDK 21 与 Android SDK 36 完成 Capacitor 同步、Debug/Release Gradle 构建；Release APK 使用外部 keystore 签名，签名配置位于 Git 忽略文件中，未提交密码或密钥。
- 安装前拉取手机现有 APK 并比较证书 SHA-256，新旧签名一致；`adb install -r` 覆盖安装成功并保留应用数据，随后通过 launcher intent 启动，未观察到 AndroidRuntime/WebView 崩溃日志。

## 2026-08-08 — 流式 JSON 显示与重复正文修复

- 流式输出继续保留完整原始响应供最终 JSON 解析，但 UI 改为只投影 `prose.paragraphs`，不再显示 `scene_notes`、`chapter_summary` 等协议字段；模型返回普通文本时保留兼容回退。
- 写作结果成功落库后先清除临时流式正文，再刷新 workspace，避免已保存正文与临时流同时出现造成重复观感。
- 系统写作协议补充续写防重复约束：最近正文只作定位锚点，默认从最后动作之后推进，不复述已有段落。
- 新增流式投影回归测试，覆盖 JSON 前缀、分段正文、转义字符、协议字段隔离和普通文本回退。
- 验证：`npm test -- --run`、`npm run build`。

## 2026-08-08 — 通用代理协作与成本控制规则

- 重写 `AGENTS.md` 为跨技术栈的风险/耦合度驱动规则：低风险工作可由总控直接处理，中高风险按责任域委派；同一责任域合并实现、测试和交接，避免微任务反复切换代理。
- 增加安全并行、单一文件所有权、验证分层、一次性日志负责人、基础设施失败最多原样重试一次及代理不可用时的降级路径；全量测试/构建集中到高风险边界和最终集成。
- `.codex/config.toml` 保留已支持的 `max_threads = 3`、`max_depth = 1`，仅补充通用调度语义；`luna_worker.toml` 保留 `high` 质量基线并明确禁止默认升至 `max`，收紧阅读范围、验证次数、重试和交接格式。

## 2026-08-08 — 反馈数据层与 Dexie v6

- 新增 Dexie v6 `feedback` 表，使用项目/消息索引与唯一 `targetKey`，记录消息级或消息段落级 verdict、原因、自定义说明、时间和段落 fingerprint；保留 v1-v5 schema。
- `upsertFeedback`、`toggleFeedback`、`removeFeedback`、`listMessageFeedback`、`listRecentProjectFeedback` 均在事务内校验项目、章节、正文消息、段落归属和指纹；相同 verdict 再次点击撤销，反向 verdict 原地切换，拒绝漂移绑定。
- 项目删除事务级联清理反馈；新增迁移、CRUD、拒绝路径、排序和级联删除测试。验证：反馈数据层定向 16 项通过，最终全量 15 个测试文件 / 97 项通过，`npm run build` 通过。

## 2026-08-08 — 正文点赞/点踩反馈 UI

- prose 消息新增消息级点赞/点踩按钮，点击后打开可关闭的反馈面板；面板支持整条正文或指定段落范围，段落按序号和首句预览选择。
- 点踩支持原因与自定义说明，点赞同样支持可选说明；提交复用 `toggleFeedback`，相同 verdict 再次提交撤销，切换 verdict 更新记录，并刷新按钮/面板状态。
- 段落锚点优先读取 `paragraphs` 表中与当前消息、章节、文本和指纹一致的记录，缺失时使用稳定消息段落 ID 与指纹；数据库提交仍会校验锚点漂移并显示错误。
- 新增移动端可滚动面板、键盘友好文本域、aria-label/title 和深浅色主题样式。
- 验证：`npm test -- --run`（15 个测试文件 / 94 个测试通过）、`npm run build` 通过。
- 补充 `src/App.test.tsx` prose UI 集成测试：按钮打开/关闭、段落选择、点踩原因与自定义说明、稳定 paragraphId/fingerprint 传入，以及同 verdict 撤销/切换 verdict。
- 补充测试 mock 的 `listMessageFeedback`、`toggleFeedback` 与段落查询依赖；验证后全量为 15 个测试文件 / 97 个测试通过。

## 2026-08-08 — 写作上下文注入近期偏好反馈

- `prepareWritingTurnContext` 与场景、检索段落并行读取当前作品最近 8 条反馈，并通过 `listProjectParagraphs` 验证段落锚点；反馈读取失败时按非核心可选资料安全降为空，避免阻塞写作请求。
- 写作资料 JSON 新增“近期偏好反馈” section，预算计划继续使用既有 `feedback` key；预览和真实发送共用同一 `prepareWritingTurnContext` 渲染路径。
- 消息级反馈在同消息存在段落反馈时明确限定为其他未单独标注段落的一般偏好；段落级反馈明确覆盖消息级规则。点踩优先于点赞排序与保留，点赞写为“保持此风格”，点踩写为“避免/调整”，自定义说明置于原因之前。
- 每条反馈仅发送章节序号/标题、消息或段落定位、截短首句预览、短指纹、结论指令和短 reason/customNote；预览始终至少截去一个字符，并阻止说明字段复制完整目标原文。
- 四档压缩策略加入反馈裁剪：normal 8 条、organizing 6 条、compressed 4 条、critical 最多 2 条且仅保留点踩；反馈 section 为可裁剪资料，critical 锁定的核心规则、当前工作区和核心记忆（含开放伏笔 ID）优先保留。
- 新增 `src/providers/__tests__/feedbackContext.test.ts`，覆盖空反馈、消息/段落覆盖、点踩优先、critical 裁剪、请求不含完整目标段落及预览/发送 token 一致性。
- 验证：`npm test`（15 个测试文件 / 94 个测试通过）、`npm run build` 通过。

## 2026-08-08 — 章节摘要版本历史与恢复界面

- 设置抽屉的“上下文与记忆”区域新增“摘要版本历史”入口，进入独立对话框查看各章节的摘要版本、来源、时间、摘要预览与来源段落数量；版本列表不提供编辑或删除操作。
- `SummaryHistoryDialog` 按版本倒序显示，并以当前 `Chapter.summary` 的摘要文本匹配“当前使用”版本；若多个版本文本相同，优先标记最新版本。读取中的 loading、无章节/无历史空状态、数据库读取错误及重试均在对话框内处理。
- 恢复操作必须确认，明确说明会生成新的 `restore` 版本且不会删除历史。App 在数据库恢复成功后立即复用 `refreshWorkspace` 重载当前项目，并提示后续写作会使用恢复后的摘要；刷新失败会回传可恢复错误，对话框不会关闭。
- 新增组件、设置入口和 App 集成测试，覆盖章节切换、倒序/当前标记、loading/empty/error、确认恢复、成功后刷新版本和 workspace、失败保留对话框。
- 样式沿用现有抽屉/对话框体系，版本项以分隔列表呈现而非卡片墙；深浅色主题、移动端底部对话框滚动和窄屏全宽恢复按钮均已覆盖。
- 验证：`npm test`（14 个测试文件 / 87 个测试通过）、`npm run build` 通过；Impeccable detector（`src/App.tsx`、`src/components/SettingsDrawer.tsx`、`src/components/SummaryHistoryDialog.tsx`、`src/styles.css`）返回 `[]`。

## 2026-08-08 — 渐进式写作上下文整理

- 写作上下文从单次按预算裁剪升级为四档稳定策略：`normal`、`organizing`、`compressed`、`critical`。档位依据未裁剪的常规上下文真实 token 需求相对 `contextContentBudgetTokens` 的压力比决定，集中阈值为 `0.70`、`0.90`、`1.15`；零内容预算时使用可序列化的高有限压力值进入 `critical`。
- `prepareWritingTurnContext` 现先用当前 tokenizer 构建未裁剪常规候选材料并测量 demand，再按档位选择/重建上下文，最后执行原有真实 token 硬校验；预览与发送仍调用同一条准备路径。未增加模型调用、网络请求、`summaryVersions` 写入或自动摘要，压缩材料仅使用已有章节摘要、核心记忆和当前工作区。
- `ContextBudgetPlan` 新增可序列化的 `compressionStage`、`contextDemandTokens`、`contextRetainedTokens` 与 `contextPressureRatio`。`normal` 保留原有丰富资料；后续档位逐步收紧设定范例、当前正文尾部、时间线、章节提要数量、检索 topK 与近期对话；`critical` 锁定核心规则、当前章节状态和含稳定 ID 的开放伏笔。
- 段落检索改为原子记录：段落 ID、位置和原文只会整条保留，预算不足时整条省略，绝不发送半条锚点。
- `ContextUsage` 明细新增低调的常规状态，以及整理中、已压缩、紧凑上下文三档递进提示；紧凑档说明保留范围并给出缩短输入、降低最大输出或更换更大窗口模型的恢复建议。简洁条仍显示 `estimatedInputTokens / inputLimitTokens`。
- 覆盖四档阈值边界、预览/发送计划一致性、低优先级 token 单调收紧、critical 核心事实与整条检索锚点，以及四档用量 UI 文案/样式。Impeccable detector（`ContextUsage.tsx`、`styles.css`）返回 `[]`。

## 2026-08-08 — 写作上下文用量预览

- 新增 `previewWritingTurnBudget`：与 `generateWritingTurn` 共用 `prepareWritingTurnContext`，统一执行当前项目场景读取、段落 Retriever、上下文裁剪、最终序列化及 `ContextBudgetPlan` 构造；预览不发送模型请求，避免出现“预览一套、发送另一套”的预算偏差。
- 新增 `ContextUsage` / `ContextUsageDetails`：输入区上方常驻“上下文 · 约 N / M”细条，点击打开可访问的明细对话框；展示系统提示、项目/工作区、核心记忆、时间线/检索、近期消息、反馈预留和用户消息的 token 与占比，并显示输出预留、安全余量、剩余 token、窗口占比和计数来源。
- App 对当前 workspace、草稿和文本 Provider 使用 240ms debounce 预览，并在输入变化时取消过期响应；loading、empty、over-limit、fallback 与 error 均不会阻塞发送。输入框获得焦点时通过 `data-composer-focused` 压缩隐藏浮层，且条本身采用绝对定位，不挤压键盘态输入区域。
- 设置抽屉新增“查看本轮上下文用量”入口，复用 App 持有的同一份 `ContextBudgetPlan` 和 ContextUsage 对话框，不复制预算渲染逻辑。
- 明细对话框使用 `role="dialog"`、标题关联、Lucide 关闭图标、Escape 与关闭按钮、焦点转移和移动端滚动；新增组件测试覆盖简洁条、明细分项、状态与键盘关闭。
- 验证：`npm test`（11 个测试文件 / 71 个测试通过，含 `WritingInstructionsDialog` 长文本确认路径）、`npm run build` 通过；Impeccable mechanical detector（指定 4 个 UI 文件）返回 `[]`。
- 审查修正：简洁条改为 `estimatedInputTokens / inputLimitTokens`，即当前消息与注入内容估算相对已扣输出预留和安全余量后的输入可用窗口；比例条统一使用 `--context-usage-section-scale`，测试同时锁定运行时自定义属性和 CSS `scaleX` 契约。

## 2026-08-08 — 段落级 Retriever 与 Bigram BM25

- 新增可插拔 `Retriever` 接口和稳定的 `RetrievedParagraph` 结果结构（paragraphId、项目/章节/消息定位、段落序号、指纹、原文、得分）；写作请求可通过可选依赖注入未来的语义实现，默认使用零依赖 `BigramBm25Retriever`。
- BM25 主体使用中文重叠字符 bigram、英文/数字整词、TF、DF/IDF 与文档长度归一；并为单个中文字符提供受控 unigram fallback。结果采用输入顺序作为同分稳定排序，支持 topK 与完整段落字符预算，指纹漂移记录不会计分或注入。
- 新增数据库最小查询 `listRetrievableProjectParagraphs`：仅接收当前 `Chapter.content` hash/段落 ID/原文一致的章节版本，保留消息段落；按同一 chapterId + 指纹/归一原文去重并优先当前章节副本，不跨章节合并，旧章节版本仍保留。
- 写作上下文改为按用户请求及当前章节/场景实体检索段落原文，注入段落 ID、章节标题/序号、段落序号和原文；不再从 `StoredScene.excerpt` 作为检索原文。检索段落归入 `timelineRetrievedContext`，二次预算裁剪不足以保留完整锚点时整条省略，避免注入残缺 ID。
- 新增 Retriever BM25、数据库过滤/去重、写作请求锚点与预算分项集成测试；定向验证：`npm test -- src/providers/__tests__/retriever.test.ts src/data/retrieval.test.ts`（8 passed）；`npm run build` 通过。全量 `npm test` 的既有长期设定/UI 测试仍有 5 秒超时，检索定向测试未复现该问题。

## 2026-08-08 — 统一段落库

- 新增 Dexie v3 的 `paragraphs` 表，记录消息/章节段落的稳定 ID、项目/章节/消息定位、索引、原文、指纹与创建时间；保留 `ConversationMessage.paragraphs`，因此既有 UI 渲染无需改动。
- 指纹使用 `hashText(normalizeText(text))`：归一化空白、全半角/常见中文标点、引号和破折号等等价形式，并保持 FNV-1a 哈希跨会话确定性。
- 迁移从 v2 的权威记录直接回填：仅从 prose `Message.paragraphs`（需具备自身 `chapterId`）和 `Chapter.content` 生成记录，不进行跨记录文本匹配；异常的无章节旧 prose 会安全跳过而不臆造关联。
- 章节段落 ID 含整章 `contentHash`，内容相同为幂等 upsert，内容变化新增版本，旧版本不删除。未来增加章节手动保存入口时，应在同一 Dexie 事务中调用 `upsertChapterParagraphs(chapter)`。
- `completeWritingTurn` 已在包含 `messages` 与 `paragraphs` 的同一 Dexie 事务内写 prose 消息和消息段落；项目删除也在事务中级联删除段落。
- 新增数据库单元测试，覆盖 v2 回填、消息事务原子性、章节版本化/幂等、指纹归一化和项目删除级联。
- 验证前通过 `npm ci` 按现有锁文件还原本地依赖；未修改 package 清单或锁文件。
- 验证：`npm test -- src/data/storyDatabase.test.ts`（6 passed）、`npm test`（5 files / 44 passed）、`npm run build`（通过）。

## 2026-08-08 — 伏笔稳定 ID 与兼容迁移

- 场景持久化模型改为结构化 `Foreshadowing { id, text, aliases? }`：`SceneNotes.foreshadowingPlanted` 保存新建记录，`resolvedForeshadowingIds` 只保存已经验证的稳定 ID。模型解析期另用 `WritingSceneNotes` 明确区分 `newForeshadowingTexts` 与 `resolvedForeshadowingIds`，避免字符串既被当作文本又被当作 ID。
- 新伏笔由应用在写作结果落库时用 `foreshadowing-${crypto.randomUUID()}` 分配 ID；写作提示和核心记忆会向模型展示未回收项的 `[id] text`，并明确要求只返回已展示的 ID 核销。
- 核销主路径只接受当前开放记录中的精确稳定 ID；重复 ID 会去重，伪造/不存在 ID 会安全忽略，不会影响其他记录。同名伏笔因 ID 独立而可分别核销。
- 为兼容旧模型响应和旧数据，保留一个受限的文本兼容路径：仅在归一化后与唯一一个开放伏笔的 `text` 或显式 `aliases` 完全相等时绑定；不使用 `includes`、相似度或语义匹配。无法唯一判断的旧核销文本持久化到 `legacyUnmatchedResolvedForeshadowingTexts`，不会被猜测性关联。
- Dexie 新增 version(4)，完整保留 v1-v3 schema；按每个项目的场景顺序把旧 `cluesPlanted: string[]` 升级为确定性 `foreshadowing-legacy-${sceneId}-${index}` ID。旧 `cluesResolved` 只在上述唯一完全相等条件下转换为 ID，其他原文保留。段落表及其 v3 迁移语义未改动。
- 新增 provider/database 测试，覆盖新建 ID、改写措辞但携带正确 ID、伪造 ID、重复核销、同文不同 ID、旧模型文本兼容、模糊文本拒绝和 v3→v4 数据迁移。
- 验证：`npm test -- src/data/storyDatabase.test.ts src/providers/__tests__/foreshadowing.test.ts src/providers/__tests__/structure.test.ts`（3 files / 29 passed）、`npm test`（6 files / 49 passed）、`npm run build`（通过）。

## 2026-08-08 — 写作上下文真实 Token 预算

- 新增 `js-tiktoken@^1.0.21`，使用其 browser-safe ESM `lite` + `ranks/o200k_base` 入口；不依赖网络、embedding、Node API 或 WASM，`npm run build` 已确认 Vite/Capacitor WebView 可打包。
- 新增可插拔的 `TokenEstimator { estimate(text: string): number }` 及 provider/model resolver。当前所有 `openai-compatible` 供应商（包括 deepseek、qwen、glm、kimi/moonshot）统一使用 `o200k_base`；未来可通过 registry 注册非兼容供应商适配器。
- tokenizer 初始化或编码失败时，显式切换到 `chars / 1.2` fallback，并将 `source: chars-per-token` 与 `isFallback: true` 写入预算计划，不会静默伪装为真实计数。
- 新增纯函数 `buildContextBudgetPlan`：输出窗口、预计输入、输出预留、安全余量、已使用/剩余、超限状态、窗口占比、0.85 收窄和序列化守卫，以及 system prompt、project/workspace、core memory、timeline/retrieved context、recent messages、反馈预留、user message 的 token 和占比。
- 写作请求现在用同一计划先分配可用上下文、再以实际序列化的系统上下文进行 token 硬校验；沿用原输出预留、10%安全余量、0.85 收窄和原 512 字符序列化守卫（一次性显式换算为 427 token）。长期设定分块请求也改为同一 estimator 计算，不再在正常路径使用字符估算。
- 新增 estimator 与预算计划测试，覆盖中文、英文、混合标点、空文本、初始化/运行时 fallback、各预算分项、序列化和超限状态。
- 验证：`npm ls js-tiktoken --depth=0`（`js-tiktoken@1.0.21`）、`npm test -- src/providers/__tests__/tokenEstimator.test.ts src/providers/__tests__/contextBudgetPlan.test.ts src/providers/__tests__/budget.test.ts src/providers/__tests__/structure.test.ts`（4 files / 37 passed）、`npm test`（8 files / 59 passed）、`npm run build`（通过）。

## 2026-08-08 — 设定分块真实 Token 计数性能优化

- `splitStructureSource` 不再对每个候选端点反复执行完整二分 token 化。每段先使用 1024 字符的本地真实 token 探针按比例定位，再最多进行两次真实 token 修正；只有文本 token 密度极端不均时才进入精确二分 fallback。
- 段落优先边界和最终 trim 后仍会用真实 estimator 核对；若边界合并改变 token 数，才做一次局部精确修正，因此正常路径不会回退到 `chars / 1.2`。
- 未改变“预计调用超过 10 次先确认”的 UI 语义或测试超时。复现的单独组件测试中，该用例优化前约 6.95 秒并触发 5 秒超时，优化后测试体约 1.23 秒并通过。
- 验证：`npm test -- src/components/WritingInstructionsDialog.test.tsx --reporter=verbose`（3 passed，第三项 1.23s）、`npm test -- src/providers/__tests__/tokenEstimator.test.ts src/providers/__tests__/contextBudgetPlan.test.ts src/providers/__tests__/structure.test.ts src/providers/__tests__/retriever.test.ts src/data/retrieval.test.ts`（5 files / 36 passed）、`npm test`（10 files / 67 passed）、`npm run build`（通过）。

## 2026-08-08 — 章节摘要不可变版本库与安全恢复

- 新增 `SummaryVersion` 领域记录与 Dexie v5 `summaryVersions` 表；版本按 `(projectId, chapterId, version)` 唯一，记录摘要、源章节内容 hash、统一段落库稳定 ID、创建原因和可选恢复来源。v1–v4 的 schema（含 `paragraphs`）原样保留。
- v4→v5 迁移会为每个非空 `Chapter.summary` 创建第 1 个 `migration` 版本，并保留原章节数据。段落锚点只接受 ID、项目、章节、索引、原文和指纹均与当前 `Chapter.content` 精确一致的 chapter 段落；无可验证段落时安全存为空数组，绝不按文本模糊绑定。
- `completeWritingTurn` 现在在原有写作事务内先持久化当前章节段落，再为非空模型 `chapterSummary` 追加 `generation` 版本。只有最新版本的摘要文本和源内容 hash 均相同才幂等跳过；内容或摘要变化会使用下一个单调递增版本号。摘要版本写失败会使章节、prose 消息和段落写入一并回滚。
- 新增 `listChapterSummaryVersions(projectId, chapterId)` 与 `restoreChapterSummaryVersion(projectId, chapterId, versionId)`。恢复在一个事务内验证章节和版本的项目/章节归属，拒绝跨项目或跨章节 ID；它更新 `Chapter.summary` 并总是创建新的 `restore` 版本、以 `restoredFromId` 指向旧版本，不修改历史版本。恢复记录保留被恢复版本的源内容出处，仅保留仍能验证为该出处/项目/章节的段落 ID。
- 项目删除现已在同一事务级联删除 `summaryVersions`。当前没有独立章节删除入口；未来若添加，必须同时按 `projectId + chapterId` 删除对应摘要版本和段落版本。
- 验证：`npm test -- src/data/storyDatabase.test.ts`（12 passed）、`npm test`（11 files / 75 passed）、`npm run build`（通过）。

## 2026-08-09 — 上下文入口与设置二级页交互重构

- 上下文用量入口从输入区上方的常驻横条移入输入卡片底部工具栏，使用紧凑 token 数值和仪表图标表达状态；输入卡片同时收纳角色、参考图、自动配图与发送动作，建立与本轮发送一致的操作层级。
- 从输入栏打开上下文用量时，改为锚定在入口上方的非模态浮层，支持点击外部、关闭按钮和 `Escape` 收起；从设置打开时复用同一份预算明细，但改为带遮罩的底部上推面板。
- 长期创作设定、摘要版本历史、文本/图片模型服务不再先关闭设置页。设置抽屉保留在下层并进入暂停状态，二级页面在移动端从底部滑入；关闭后直接回到原设置位置，且 `Escape` 不会同时关闭上下两层。
- 补充上下文紧凑入口与设置暂停态测试；在 390×844 与 1000×800 视口检查默认输入栏、上下文浮层、设置页及四类二级面板的边界、层级和滚动。
- 验证：`npm test`（16 files / 101 passed）、`npm run build`（通过；仅保留既有大 chunk 提示）、Impeccable detector（`App.tsx`、`ContextUsage.tsx`、`SettingsDrawer.tsx`、`styles.css`）返回 `[]`。

## 2026-08-09 — 真机网络与参考图链路修复

- `BrowserFetchTransport` 在 Capacitor 原生平台改用 `CapacitorHttp`，普通 JSON/模型列表请求绕过 WebView CORS；multipart `FormData` 会转换为原生 `formData` entries 和 base64 文件。真机写作因原生 HTTP 不提供 SSE 增量回调，自动将 `stream: true` 改为一次性 `stream: false`，完成后仍通过同一 UI 回调展示；Web 端继续使用 fetch SSE。
- 参考图生图继续走标准 `/images/edits`，但失败信息明确说明需要 OpenAI 兼容 multipart edits 端点并保留原始错误，避免中转站只支持 generations 时出现笼统提示。
- 参考图导入支持 HEIC/HEIF；若设备能解码则在导入阶段经 canvas 转为 PNG，无法解码时提示先转换为 JPG/PNG/WebP，不再把 HEIC 原样提交给图片模型。
- 参考图对话框在已有角色时新增“新建角色”选项，可继续创建并绑定第二个及后续角色；补充角色选择、HEIC 成功/失败与导入回调测试。
- 未收录的 Grok 模型启发式上下文窗口按 256K 处理；在线模型表改为 jsDelivr 优先、GitHub Raw 回退，并仅在有效响应或 304 后记录检查时间。
- 场景 `order` 改为项目内已有最大值加一，避免同毫秒写作轮次乱序。流式 JSON 截断或解析失败时，`App` 将已投影正文交给 `failWritingTurn`，以失败状态草稿消息保存且不写入章节/场景/段落正式记录。
- 验证：定向测试 5 个文件 / 41 项通过；`npm run build` 通过（保留既有大 chunk 警告）；`npx vitest run --testTimeout=15000` 通过（19 个文件 / 118 项）；默认 `npm test` 仍有既有 `feedbackContext.test.ts` 单项 5 秒超时，放宽测试时限后通过；Impeccable detector（参考图对话框及样式）返回 `[]`。

## 2026-08-09 — Android Release 覆盖安装

- 运行 `npm run android:sync`，重新构建前端并同步 Capacitor Android 资源；构建仅保留既有大 chunk 警告。
- 使用 `android/keystore.properties` 指向的 release 签名配置运行 `gradlew assembleRelease`，生成 `android/app/build/outputs/apk/release/app-release.apk`。
- 安装前通过 Android SDK `apksigner` 比较新 APK 与手机现装 `com.illustratedstory.app` 的 SHA-256 签名证书，结果一致；随后执行 `adb install -r` 覆盖安装并返回 `Success`，未卸载应用、未清空应用数据。

## 2026-08-09 — 当前工作区变更同步

- 将当前分支 `codex/context-management-upgrade` 的全部已修改和新增文件统一提交并推送到 `origin`，范围包含上下文入口与设置交互、真机网络与参考图链路、测试、协作配置和变更日志。
- release keystore、`android/keystore.properties`、构建产物和签名校验副本保持忽略状态，不进入版本库。

## 2026-08-09 — 移动端作品与设置交互修正

- 手机窄屏下“我的作品”抽屉改为全宽，重命名时不再因原先的 `88vw` 宽度在软键盘上方留下右侧空隙；空作品列表新增明确的空状态。
- 设置中的“本轮上下文用量”底部面板在手机端去除左右边距，并将最大高度与章节摘要等设置二级页统一为 `94svh`，保持同一层级的全宽视觉行为。
- 参考图导入后进入角色资产页时记录来源；关闭角色资产会返回新的参考图添加界面，直接从主界面进入角色资产时仍返回主界面。
- 新作品默认插画画风从“写实电影感”改为“自由发挥”。
- 数据库初始化不再自动创建“未命名作品”，删除最后一部作品后也不再补建；应用会进入可新建作品的空库界面，并自动打开空作品列表。
- 补充 App 与数据库回归测试，覆盖首次安装空库、删除最后作品、参考图返回路径和新作品默认画风。
- 验证：`npx vitest run src/App.test.tsx src/data/storyDatabase.test.ts --testTimeout=15000`（2 个文件 / 27 项通过）、`npm run build` 通过、Impeccable detector 返回 `[]`；390×844 浏览器视口确认作品抽屉与上下文底部面板均横向全屏，新作品设置显示“自由发挥”，控制台无错误。
- 全量测试共 123 项，其中 122 项通过；既有 `ReferenceImageDialog.test.tsx` 的“设备不能解码 HEIC”用例在 15 秒与单独 30 秒运行时均超时，本批改动未触及其实现。

## 2026-08-09 — 移动端修正版 Release 覆盖安装与同步

- 运行 `npm run android:sync`，完成前端 production 构建并同步 Capacitor Android 资源；仅保留既有大 chunk 提示。
- 使用 `android/keystore.properties` 配置及 `C:\Users\Zhou\Desktop\keystore\xuying-release.keystore` 执行 `gradlew assembleRelease`，生成签名 APK：`android/app/build/outputs/apk/release/app-release.apk`。
- 通过 Android SDK `apksigner` 比较新 APK 与手机现装 `com.illustratedstory.app` 的 SHA-256 签名证书，结果一致；随后执行 `adb install -r` 覆盖安装并返回 `Success`，保留现有应用数据。
- 安装后确认设备上的 `versionCode=1`、`versionName=1.0`，`lastUpdateTime` 已更新为本次安装时间。
- 将本批移动端 UI、交互、默认值、空作品库、测试及变更日志提交并推送到 `origin/codex/context-management-upgrade`。

## 2026-08-09 — 设置内打开模型服务的黑屏闪烁修复

- 模型服务从设置抽屉内打开时改用透明的嵌套交互层，不再把设置页已有的 `0.74` 黑色遮罩再叠加一次；下层设置仍保持暂停和轻度变暗，点击二级页外部关闭及返回设置位置的行为不变。
- 从主界面因模型未配置等场景直接打开模型服务时，继续保留原有全屏遮罩，避免改变独立弹层的层级表现。
- 新增模型服务弹层层级测试，分别覆盖设置内嵌套打开和独立打开两种状态。
- 验证：`npm test -- src/components/ProviderSettingsDialog.test.tsx src/components/SettingsDrawer.test.tsx`（2 个文件 / 4 项通过）、`npm run build` 通过（仅保留既有大 chunk 提示）、Impeccable detector 返回 `[]`；390×844 与 1000×800 视口确认嵌套背景为透明且无遮罩动画，移动端底部面板和桌面弹层布局正常。
- 将本次黑屏闪烁修复、回归测试和变更日志提交并推送到 `origin/codex/context-management-upgrade`；未包含工作区中既有的 `.codex/agents/luna_worker.toml` 改动。

## 2026-08-09 — Android 文本请求可选流式传输

- Android 文本模型设置新增“流式输出”开关，默认关闭且仅在原生 Android 环境显示；关闭时写作请求继续使用 `CapacitorHttp`，避免中转站缺少 CORS 响应头导致请求失败。
- 开启后仅对话/写作请求改用 WebView `fetch` 解析 SSE，以恢复实时正文；模型列表、生图和参考图上传仍强制走原生 HTTP，不受此开关影响。
- WebView 流式连接失败时给出中转站 CORS 兼容性提示，并要求用户关闭开关后手动重试；不会自动改用原生 HTTP 重发，避免重复生成和重复计费。Web 环境继续沿用原有流式请求且不显示 Android 专用开关。
- 新增设置保存与 Web 隐藏、Android SSE 选择、失败不重发以及写作传输模式测试。
- 验证：定向测试 3 个文件 / 23 项通过；`npm run build` 通过（仅保留既有大 chunk 提示）；Impeccable detector 返回 `[]`。全量测试 130 项中 128 项通过，既有 HEIC 解码失败用例和高压力反馈用例在并行运行时超时；高压力反馈用例单独复测通过，HEIC 解码失败用例单独放宽至 30 秒仍超时，本轮未修改其实现。

## 2026-08-09 — Android 可选流式版本发布安装

- 将 Android 可选流式传输、设置开关、测试和变更日志提交为 `d135b26`，并推送到 `origin/codex/context-management-upgrade`；工作区中既有的 `.codex/agents/luna_worker.toml` 改动未包含在提交中。
- 运行 `npm run android:sync` 完成 production 构建和 Capacitor Android 资源同步；随后使用 `android/keystore.properties` 的 release 签名配置执行 `gradlew assembleRelease`，生成 `android/app/build/outputs/apk/release/app-release.apk`。
- 新 APK 与手机现装 `com.illustratedstory.app` 的 SHA-256 签名证书一致；通过 `adb install -r` 覆盖安装并返回 `Success`，保留现有应用数据。安装后确认 `versionCode=1`、`versionName=1.0`。

## 2026-08-10 — Android 生图完整性误判修复

- 查明 Android 生图保存报“图片文件不完整”的根因：`CapacitorHttp` 对 `arraybuffer` 使用 Android `Base64.DEFAULT` 返回，内容会每 76 个字符带 CR/LF。此前传输层仅把无空白字符串识别为 base64，因而将带换行的完整 base64 再次 `btoa`，把 ASCII base64 文本误写入图片文件。
- 图片二进制响应、data URL 解析和持久化写入现在都会移除 base64 空白并规范化 URL-safe 字符与 padding；分块写入仍保持 4 字节对齐，文件头尾完整性校验未放宽，截断 PNG 仍会拒绝保存。
- 新增 Android CR/LF `arraybuffer` 响应、带换行图片 data URL 分块写入和截断 PNG 拒绝测试；同源 Bearer 与跨域匿名 URL 的既有安全边界未改变，未恢复无鉴权 `Filesystem.downloadFile`。
- 验证：`npx vitest run src/providers/browserTransport.test.ts src/providers/imageAssetStore.test.ts src/providers/images.test.ts`（3 个文件 / 27 项通过），`npm run build` 通过；仍需真机用受保护同源图片 URL 复验一次。

## 2026-08-10 — 模型服务二级页首帧闪屏修复

- 修复从设置页进入模型服务时 Android WebView 短暂露出底层界面的问题：二级页在 `open=true` 的当前渲染帧立即挂载，嵌套模型页改为始终可见的短距离入场动画，不再从屏幕外或透明状态开始。
- 父设置页挂起时由 `filter: brightness()` 改为稳定的半透明伪元素遮罩，避免 Android WebView 对整层重新栅格化；非嵌套弹层、关闭动画、焦点和 Escape 行为保持不变。
- 新增父设置页与模型二级页首帧交接、嵌套/非嵌套样式契约及 Presence 同帧挂载测试；完成发行版覆盖安装后继续用真机逐帧复验。
- 运行受影响范围的 8 个测试文件共 50 项，全部通过；`npm run android:sync`、`gradlew assembleRelease` 和 Impeccable detector 均通过。新 APK SHA-256 为 `8AE858889BEEB237CD3C70E0AD1A13115168088028F539584795AC1CE314FD1A`。
- `adb install -r` 返回 `Success`，覆盖安装后 `firstInstallTime` 保持不变、`lastUpdateTime=2026-08-10 10:35:59`，说明应用数据已保留。真机按约 45ms 间隔抓取设置到模型接口的切换帧，点击后的下一帧直接呈现模型接口页，未出现主页或空白层；原生日志未见 WebView、Filesystem 或崩溃异常。
- 用户在发行版手机上完成实际生图保存与模型服务页面切换验收，确认问题均未再复现。

## 2026-08-10 — App 与写作模块第一批职责拆分

- 将时间线消息、插画卡片及正文反馈读取/提交从 `App.tsx` 提取到 `src/components/TimelineMessage.tsx`；保留原有 DOM、CSS class、可访问性文案和交互回调，`App.tsx` 继续负责顶层页面编排与跨功能流程。
- 将原约 2015 行的 `src/providers/writing.ts` 改为 26 行显式兼容入口，原有导出名称和 `providers/writing` 导入路径不变；内部按职责拆分为 `budget`、`chapterIntent`、`context`、`instructions`、`orchestration`、`prompt`、`result` 七个模块。
- 写作模块依赖保持单向：基础提示词与结果解析由预算/设定模块复用，上下文模块依赖预算与设定选择，请求编排位于最外层；内部 helper 未通过兼容入口意外公开，未新增依赖或改变请求体、错误文案、token 预算和上下文裁剪行为。
- 验证：`npx vitest run src/App.test.tsx src/providers/__tests__ --testTimeout=15000`（10 个文件 / 80 项通过）；`npm run build` 通过，仅保留既有大 chunk 提示；`git diff --check` 通过。
- 全量 `npx vitest run --testTimeout=30000` 共 154 项，其中 153 项通过；唯一失败仍为既有 `ReferenceImageDialog.test.tsx` 的“设备不能解码 HEIC”用例 30 秒超时，本次拆分未触及其实现。

## 2026-08-10 — App 第二批职责拆分

- 将图片查看器从 `App.tsx` 提取为 `src/components/IllustrationLightbox.tsx`，保留原有缩放、双击、拖动、双指捏合、工具栏显隐、Escape、保存、关闭动画及 DOM/class/ARIA 契约；新增直接测试覆盖缩放复位、三种关闭入口、关闭动画和保存成功/失败提示。
- 新增 `src/hooks/useAppBootstrap.ts`，集中管理项目列表、当前工作区、启动状态、项目打开/刷新，以及数据库初始化、模型限制刷新、中断图片恢复、旧图片完整性审计和 active project 恢复；弹层、写作与图片队列状态仍留在各自边界，没有形成新的万能 Hook。
- 为启动 Hook 增加直接测试，覆盖 active project 恢复、空库回调、数据库初始化失败和中断插画恢复成功；`App.tsx` 由第一批后的 1330 行进一步降至 919 行。
- 验证：`npx vitest run src/App.test.tsx src/components/IllustrationLightbox.test.tsx src/hooks/useAppBootstrap.test.tsx src/providers/__tests__ --testTimeout=15000`（12 个文件 / 89 项通过）、`npm run build` 通过、`git diff --check` 通过；仅保留既有大 chunk 提示。
- 全量 `npx vitest run --testTimeout=30000` 共 163 项，其中 162 项通过；唯一失败仍为既有 HEIC 无法解码用例 30 秒超时。图片查看器的双指捏合与拖动按原逻辑迁移并通过类型检查，仍需后续真机触屏回归。

## 2026-08-10 — HEIC 解码永久等待修复

- 查明反复出现的 HEIC 测试超时并非转换耗时，而是 `createImageBitmap` 失败后进入 `<img>` 兜底解码；JSDOM 不会真正解码图片，也不会自动触发 `load/error`，导致 Promise 永久等待。
- `<img>` 兜底解码增加 10 秒上限，成功、失败或超时后都会清理定时器和事件处理器；对用户仍统一显示既有的“请先转换为 JPG、PNG 或 WebP”提示，保留部分 WebView 可通过 `<img>` 解码 HEIC 的兼容机会。
- 测试明确模拟兜底解码器触发 `error`，并新增“解码器完全无响应”场景，通过假定时钟验证不会永久等待。
- 验证：`npx vitest run src/components/ReferenceImageDialog.test.tsx --testTimeout=15000`（5 项通过）、`npx vitest run --testTimeout=30000`（24 个文件 / 164 项全部通过）、`npm run build` 通过；仅保留既有大 chunk 提示。

## 2026-08-10 — HEIC 修正版 Android Release 覆盖安装

- 运行 `npm run android:sync` 完成前端构建并同步 Capacitor Android 资源；随后在 `android` 目录运行 `gradlew.bat assembleRelease`，构建成功生成 `android/app/build/outputs/apk/release/app-release.apk`。
- 安装前从手机现装包提取 APK，与新 APK 使用 `apksigner` 比较 SHA-256 签名证书，均为 `7afd7b46942d7d792ad2b47fc5fc62474b3423015b78b73a8c25fa0472318da1`。
- 对设备 `3B6F66E910B5BALR` 执行 `adb install -r` 覆盖安装并返回 `Success`；`firstInstallTime=2026-08-07 19:46:10` 保持不变，`lastUpdateTime=2026-08-10 12:49:56` 已更新，应用数据未清空。
- 安装后启动 `com.illustratedstory.app`，进程正常运行，最近 200 行日志未发现 `FATAL EXCEPTION` 或 `AndroidRuntime` 崩溃。
