# ADR 0003：思考等级（reasoning_effort）跨模型适配层

- 状态：提议（v2，已吸收 2026-08-21 评审修订）
- 日期：2026-08-21

## 背景

当前 `buildChatCompletionPayload`（src/providers/chatCompatibility.ts）只在
`reasoningEffortParameter !== 'unsupported'` 且用户显式选择 `low | medium | high` 时，
把 `reasoning_effort` 透传到请求体顶层。该字段是 OpenAI 系协议字段，实际覆盖面很窄：

- **原生生效**：OpenAI 官方 o1/o3/o4/gpt-5 系，以及已跟进该字段的 DeepSeek V4、GLM-5.2+、Grok、GPT-OSS。
- **静默失效**：Qwen、GLM-4.x、Kimi、豆包等 OpenAI 兼容端点普遍忽略未知字段（Kimi 官方文档明示 ignore but succeed）。
- **报错风险**：少数严格校验端点对非法取值返回 400。

各厂商"思考等级"原生表达不统一：`enable_thinking`（Qwen3/DeepSeek V3.x）、`thinking: {type}`（GLM-4.x/Kimi/豆包/DeepSeek V4）、
`thinking_budget`（token 预算）、`reasoning_effort`（等级）。需要一层"统一等级 → 各家原生参数"的适配。

## 调研结论（2026-08 事实核查）

1. **DeepSeek 官方**：`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 退役，仅剩 `deepseek-v4-pro` / `deepseek-v4-flash`；思考模式 = `thinking.type` 开关 + `reasoning_effort`（high/max）。
2. **models.dev 自带能力描述**：每条模型含 `reasoning: boolean` 与 `reasoning_options`（`toggle` / `effort{values}` / `budget_tokens`），与 OpenCode variants 同源。
   **但它是能力描述，不是请求协议**——不提供字段名与 JSON 结构。
3. **智能网关已在做翻译**：OpenRouter（`reasoning.effort` 统一 + 非 none 值自动 remap）、New API/one-api 智能渠道（Claude 渠道 low→1280/medium→2048/high→4096）、OrcaRouter/aiproxy/千帆同思路。客户端自行翻译成 `enable_thinking` 发给这类网关会被忽略，反而破坏网关翻译——**中转场景必须保持透传**。
4. **透传型中转（one-api 默认）**：未配模型重定向时原样转发 body；配了重定向只保留认识的字段。

## 评审修订记录（2026-08-21）

v1 经评审发现 7 个问题，本版全部吸收：

| # | 级别 | 问题 | 修订 |
|---|---|---|---|
| 1 | P1 | 模型表按模型名"第一条命中"，无法按 provider 消歧（glm-5.2 同时存在于 zhipuai 与 alibaba，effort 值域不同） | 思考参数查询必须使用 `(providerId, modelId)` 联合键；providerId 由端点注册表确定；跨 provider 回退仅用于窗口大小，绝不用于思考参数 |
| 2 | P1 | `reasoning_options` 是能力描述不是请求协议，v1 把 toggle/budget_tokens 直接解释成 enable_thinking/thinking.type/thinking_budget 属过度推断 | 拆分两个职责：`ModelReasoningCapabilities`（能力，数据驱动）+ `EndpointReasoningAdapter`（线路编码，人工维护） |
| 3 | P1 | ADR 白名单含硅基流动/豆包，但生成脚本白名单无 siliconflow、models.dev 无火山方舟 provider | 端点注册表与生成白名单对齐；无元数据的端点显式标注能力来源；表缺失禁止交给跨厂商模型名启发式 |
| 4 | P1 | 白名单缺智谱国内官方域名（open.bigmodel.cn），漏配会判为中转继续无效透传 | 注册表覆盖官方区域域名，用 `new URL(baseUrl).hostname` 精确匹配；测试覆盖端口/大小写/尾部路径/伪装域名 |
| 5 | P1 | 测试计划与端点原则矛盾：budget.test.ts 的 baseUrl 是 example/v1（非官方），却期待官方翻译输出 | 测试分两类端点：非官方 → passthrough 期待 `reasoning_effort`；官方翻译必须把 baseUrl 改为 api.deepseek.com/v1 |
| 6 | P2 | 缓存键仍为 v1，旧缓存会覆盖新内置表，用户最长 7 天无新字段 | 顶层 `schemaVersion: 2` + 缓存键升级 v2，不做字段可选迁移 |
| 7 | P2 | budget_tokens 可能带 min/max，固定 2048/8192/16384 未按模型上限 clamp；effort 可能含 none/minimal/xhigh/max | 保留 budget 上下界并 clamp；定义等级顺序、过滤未知值；返回 `effectiveEffort` 供 UI |

## 目标与不变量

**目标**：让"思考等级"在官方直连端点正确生效（含正确字段与合法值域），对中转服务零回归。

**不变量**：
- 用户选择 `auto` → 永不发送任何思考参数（现状不变）。
- 用户手动设置 `reasoningEffortParameter: supported | unsupported` → 优先级最高，语义不变。
- **非官方端点一律保持现有 passthrough**（只透传 `reasoning_effort`），翻译权交给网关。
- **思考参数查询不做跨 provider 回退**：无法由端点确定 provider 时，宁可保守不发，不猜。
- 单一权威仍在 `buildChatCompletionPayload`，调用点零改动。

## 决策

### 1. 职责拆分：能力描述 vs 线路编码

```ts
// 能力（数据驱动，来自 models.dev，零手工标注）——只描述"能做什么"
interface ModelReasoningCapabilities {
  reasoning: boolean                      // 是否支持推理
  options: ReasoningOption[]              // 控制维度：toggle / effort{values} / budget_tokens
  effortValues?: string[]                 // effort 合法值域
  budgetRange?: { min?: number; max?: number }  // budget 上下界（若 models.dev 提供）
}

// 线路编码（人工维护，官方端点注册表）——只描述"怎么发"
interface EndpointReasoningAdapter {
  hostname: string            // 官方端点 hostname（精确匹配）
  providerId: string          // models.dev providerId（联合键查询用）
  encode(effort): Record<string, unknown>   // 该端点的 payload 编码器
}
```

数据驱动边界明确：**是否支持推理、控制维度、effort 值域、budget 上下界**来自 models.dev；
**字段名与 JSON 结构**（enable_thinking / thinking.type / thinking_budget / reasoning_effort）由 adapter 人工维护。

### 2. 数据层：模型表扩展 + schemaVersion

`src/data/model-limits.min.json` 条目扩展，顶层加 `schemaVersion`：

```ts
interface LimitEntry {
  m: string   // modelId
  c: number   // context
  o?: number  // max output
  p?: string  // providerId
  rg?: 0 | 1
  ro?: ReasoningOption[]   // 原样拷贝；budget_tokens 若带 min/max 一并保留
}
```

- 顶层 `schemaVersion: 2`，缓存键升级为 `...model-limits.cache.v2`（不做字段可选迁移，旧缓存直接作废重建）。
- 旧表无新字段 → 能力解析为 undefined → 走同厂商启发式或保守不发；旧代码读新表忽略未知字段，双向兼容。

### 3. 联合键消歧查询

- **思考参数查询**：`lookupReasoningCapabilities(providerId, modelId)`，先按 `p` 过滤再匹配 `m`；
  `providerId` 未知或表中无该 provider → **不跨 provider 回退**，返回 undefined。
- **context 窗口查询**：保持现状宽松匹配（跨 provider 回退仅限此用途）。

### 4. 端点注册表（EndpointReasoningAdapter 清单）

| hostname（精确匹配） | providerId | 编码器 |
|---|---|---|
| api.openai.com | openai | passthrough：`reasoning_effort` |
| api.deepseek.com | deepseek | thinking-type：`thinking:{type:'enabled'}` + `reasoning_effort`（clamp 到 effortValues） |
| dashscope.aliyuncs.com | alibaba | toggle：`enable_thinking: true`；budget 模型附带 `thinking_budget` |
| open.bigmodel.cn | zhipuai | toggle：`thinking:{type:'enabled'}`；GLM-5.2+ 附带 `reasoning_effort` |
| api.z.ai | zhipuai | 同上（国际域） |
| api.moonshot.cn / api.moonshot.ai | moonshotai | toggle：`thinking:{type:'enabled'}` |
| ark.cn-beijing.volces.com | （无 models.dev provider） | 标注 `capabilitiesSource: 'heuristic-only'`，字段 `thinking:{type:'enabled'}` |
| api.siliconflow.cn | siliconflow | toggle：`enable_thinking: true` |

- **对齐原则**：注册表内每个端点必须有 models.dev providerId，且该 provider 必须在生成脚本
  `PROVIDER_WHITELIST` 中（本轮需补 `siliconflow`）；无元数据的端点（火山方舟）显式标注
  `capabilitiesSource: 'heuristic-only'`，能力按同厂商规则，**禁止跨厂商模型名启发式**。
- hostname 匹配用 `new URL(baseUrl).hostname`（小写化），不匹配端口/路径/大小写；测试含
  `api.deepseek.com.example.org` 伪装域名用例。

### 5. 解析顺序

```
manual（reasoningEffortParameter: supported→passthrough / unsupported→none）
> 非官方端点 → 保持现有 passthrough（透传 reasoning_effort）
> 官方端点 adapter → 查 (providerId, modelId) 能力
> 同 provider 启发式（模型名规则限定在已确定的 providerId 家族内）
> none（保守不发）
```

### 6. 值域处理

- 等级顺序：`none < minimal < low < medium < high < xhigh < max`；用户等级不在模型 `effortValues` 时
  **过滤 + clamp**——取"大于等于用户等级的最小合法值，无则取最大值"（如 DeepSeek V4 值域
  `[low, high, max]`，用户 medium → high）。向上 clamp 符合质量优先意图。
- 返回值带 `effectiveEffort`（clamp 后的实际值），供未来 UI 展示"实际生效等级与成本影响"。
- budget：先取产品默认预算（low→2048 / medium→8192 / high→16384），再 clamp 到 `budgetRange`。

### 7. 启发式兜底

仅限"端点已确定 providerId 但表缺失/离线"时，按**该厂商**家族关键词补能力
（如 siliconflow 上 `deepseek-v4` → 按 siliconflow 编码器 = enable_thinking）。
模型名启发式永远不跨厂商猜测。

### 8. UI 与语义

- 交互不改（三档 + auto；custom 预设的 `reasoningEffortParameter` 下拉保留为手动覆盖）。
- **纯 toggle 模型的语义明示为"开启思考"**：low/medium/high 最终发送相同 payload，
  不向用户声称三级控制生效；UI 提示"该模型仅支持开/关思考，等级不生效"。
- 二期可选：展示 `effectiveEffort`、对 New API 系中转提示模型名后缀（如 `o3-mini-high`）。

## 测试计划

**分类原则**：测试必须显式区分端点类型，与解析顺序一致。

- 非官方端点（baseUrl = https://example/v1）+ 任意模型 → 只发 `reasoning_effort`（passthrough）。
- 官方端点（baseUrl = https://api.deepseek.com/v1）+ `deepseek-v4-flash` → `thinking:{type:'enabled'}` + `reasoning_effort`（clamp）。
- 官方端点 + `o3` → `reasoning_effort`（passthrough 编码器）。
- 官方端点 + `qwen3.5-plus`（dashscope）→ `enable_thinking: true` + `thinking_budget`（clamp 到 budgetRange）。
- 联合键：zhipuai/glm-5.2 与 alibaba/glm-5.2 各自值域正确；providerId 未知 → 不返回。
- 解析顺序全链路：manual > 非官方 passthrough > adapter > 同 provider 启发式 > none。
- 伪装域名：`api.deepseek.com.example.org` 判为非官方 → passthrough。
- 缓存：schemaVersion 2 生效、旧 v1 缓存被忽略。
- `auto` 永不发送；`none` 形态全字段缺席。

**现有用例更新**：`budget.test.ts` 默认 `deepseek-chat`（退役 ID）→ `deepseek-v4-flash`；
因 baseUrl 是非官方的 example/v1，期望仍为 `reasoning_effort='high'`（passthrough）；
官方翻译行为由新增的官方端点用例覆盖。

## 分步实施顺序

1. `modelLimits.ts`：`schemaVersion: 2` + 缓存键 v2 + `lookupReasoningCapabilities(providerId, modelId)` 联合键 + 类型。
2. `endpointReasoningAdapters.ts`（新）：端点注册表 + hostname 精确匹配 + 编码器 + 单测（含伪装域名）。
3. `chatCompatibility.ts`：接入 `resolveReasoningShape`（按解析顺序）+ clamp + `effectiveEffort` + 单测。
4. 更新受影响现有测试期望（budget.test.ts 模型 ID；新增官方端点用例）。
5. `scripts/build-model-limits.mjs`：补 `siliconflow` 白名单、拷 rg/ro/p、schemaVersion 2、重新生成表。
6. 手工验证清单：deepseek-v4-flash（官方）/ qwen3（dashscope）/ glm-4.6（open.bigmodel.cn）各一请求；
   OpenRouter / one-api 中转各一请求（确认仍透传 reasoning_effort）。

## 取舍

- 联合键 + 端点注册表引入"端点必须先识别"的前置依赖：未知端点不映射（passthrough，无害），
  已知端点映射准确；成本是注册表需随官方域名演进维护（低频）。
- 线路编码人工维护（P1-2 的代价）：换来字段名/结构的确定性，避免把能力描述当协议用的隐性错误。
- 客户端仍只处理 OpenAI 兼容扩展字段，不做 Claude/Gemini 原生协议（protocol 仅 openai-compatible）。

## 备选方案

1. **v1 手工家族规则表**（已否决）：维护成本高、厂商演进滞后。
2. **全量映射不区分端点**（已否决）：破坏智能网关翻译，对中转用户回归。
3. **单独生成 model-reasoning.min.json**：职责更干净、缓存迁移独立，但多一套下载与缓存流程；
   当前规模下联合键方案更划算。若未来模型表膨胀或思考参数演进频繁，可迁移到该方案。
4. **引入 Vercel AI SDK 做 provider 抽象**（已否决）：重依赖、与自建 payload/原生传输冲突、包体积增加。
