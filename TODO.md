# Codex / OpenAI Responses 修复清单

## 范围与验证约束

- 仅修复 `Codex -> POST /v1/responses -> OpenAI 系列模型`。
- 覆盖原生 `/responses` 透传和 `/chat/completions` fallback；不修改 Anthropic `/v1/messages` 或 Responses-to-Anthropic bridge。
- 默认服务只允许本机访问，远程 host、Docker 端口发布和反向代理暴露不在支持范围内。
- 所有本地运行验证使用端口 `4142`；不得停止、重启或占用当前 `4141` 服务。
- 修复完成后运行逐项回归、完整测试、类型检查、构建和 lint，并再次确认 `4141` 的监听进程未变化。

## P0 — 本机监听与 `/token` 浏览器边界

- [x] 默认显式绑定 `127.0.0.1`，不再监听所有网络接口。
- [x] `/token` 不继承全局 CORS；拒绝携带浏览器 `Origin` 的请求。
- [x] `/token` 只接受 loopback `Host`，并返回 `Cache-Control: no-store`。
- [x] 保持无 `Origin` 的本机 CLI 访问能力。
- [x] 增加默认监听地址、跨域拒绝、Host 校验和 no-store 回归测试。
- [x] 文档说明 Docker 发布、局域网访问和反向代理暴露将按预期失效。

默认方案：固定 `hostname: "127.0.0.1"`；将 `/token` 放在独立的本机管理边界内，浏览器跨源请求返回 `403`，本机非浏览器客户端继续可用。

## P1 — Synthetic Responses SSE 状态机与终态

- [x] 仅改动 `/v1/responses -> /chat/completions` 合成流；原生 `/responses` 正常事件继续透传。
- [x] `response.created`、`response.in_progress` 和新增 output item 使用正确的 `in_progress` 状态。
- [x] 每个合成事件带单调递增的 `sequence_number`。
- [x] message 与每个 function call 拥有稳定的 `item_id` 和 `output_index`。
- [x] 所有 content-part、text 和 function-argument 事件携带对应 `item_id`。
- [x] 支持 tool `id`、`name`、`arguments` 分散在多个 Chat SSE frame 到达。
- [x] 按实际打开顺序分配 output index，支持 tool-first、text-first、交错文本和多个 tool call。
- [x] terminal Response 的 `output` 由同一累计状态生成，不再为空。
- [x] `stop` 和完整 `tool_calls` 映射为 `completed`。
- [x] `length` 映射为 `incomplete`，reason 为 `max_output_tokens`。
- [x] `content_filter` 映射为 `incomplete`，reason 为 `content_filter`。
- [x] 已创建 Response 后的协议/传输失败映射为一次 `response.failed`；创建前失败使用 `error`。
- [x] 非流式 Responses 使用同一 finish-reason 语义。
- [x] 兼容真实 Copilot Chat SSE 省略 `object` 和非终态 `finish_reason` 的帧格式。
- [x] 增加官方 Responses event contract fixtures，覆盖正常文本、tool-first、多 tool、split metadata、length、content filter 和失败。

默认方案：建立单一显式流状态机，由统一 emitter 分配 sequence number、维护 item identity、累计完整 output，并保证每个流最多一个 terminal event。

## P1 — Responses-to-Chat 条件能力矩阵

- [x] 只在 fallback `/chat/completions` 前执行能力检查；原生 `/responses` 不受影响。
- [x] 一对一映射 `parallel_tool_calls`、function `strict` 和受支持的 `reasoning.effort`。
- [x] 允许默认/no-op 值：`store: false|null`、`truncation: disabled|null`、plain-text `text.format`。
- [x] 保留并重新附加 `metadata`，不因其不影响生成而拒绝请求。
- [x] 非空 `previous_response_id`、`conversation`、`store: true`、`truncation: auto` 返回确定性 `400 unsupported_feature`。
- [x] `input_file`、MCP、computer、file-search、namespace 及其他无法表达的工具返回确定性 `400 unsupported_feature`。
- [x] Structured Output 仅在目标 Chat 模型和 payload 均可表达时映射，否则返回 `400`。
- [x] Codex replay artifacts（如 reasoning、agent_message、additional_tools、encrypted content）采用明确兼容规则，不做全局一刀切拒绝。
- [x] 未知且非空、可能改变生成语义的 fallback 字段失败关闭；null/default/no-op 值可兼容放行。
- [x] 错误响应包含稳定的 `type`、`code`、`param` 和需要原生 Responses 支持的说明。
- [x] 增加 map/allow/reject/replay 四类回归测试，确保不再静默返回语义错误的 HTTP 200。

默认方案：在 translation 之前建立条件支持矩阵——能映射则映射，明确默认值则放行，无法无损表达的请求返回可诊断 400，Codex 历史重放项使用单独兼容策略。

## P1 — 请求取消、异常 SSE 与资源清理

- [x] 将 `c.req.raw.signal` 通过 `createResponses` / `createChatCompletions` 传入 `copilotFetch` 和 SSE reader。
- [x] 客户端取消后立即 abort 该次上游请求，不继续写 terminal event。
- [x] 客户端 signal 不得取消进程级共享 token refresh；refresh 后再次检查请求是否已取消。
- [x] 增加保守、可配置的 connect/header timeout；收到响应头后停止该 timer。
- [x] first-event、idle 和 total timeout 提供配置能力，但默认关闭或保持非常宽松；idle 观察所有原始 SSE 活动而非仅文本 token。
- [x] fallback Chat：有效 `finish_reason` 是合法终态；`[DONE]`/EOF 前没有 finish reason 则视为 truncated。
- [x] native Responses：`completed`/`incomplete`/`failed`/官方 `error` 是合法终态；`[DONE]`/EOF 前没有终态则视为 truncated。
- [x] 对每个 SSE data frame 做 JSON 和最小 shape 校验。
- [x] created 前解析失败发送 `error`；created 后解析失败发送一次 `response.failed`。
- [x] 所有成功、失败、超时和取消路径使用 `try/finally` 释放 reader、timer 并完成 trace 清理。
- [x] 不对已经开始生成的请求自动重试，避免重复输出或工具调用。
- [x] 增加取消、malformed JSON、上游 error、缺失 terminal、缺失 `[DONE]` 和 exactly-one-terminal 回归测试。

默认方案：取消传播、异常/截断终态和 finally 清理本次必须完成；只默认启用保守的 header deadline，首事件/idle/总时长限制先作为可配置能力。

## 完成门槛

- [x] 所有新增回归测试先失败、修复后通过。
- [x] `4142` 上逐项 HTTP 验证上述四组行为。
- [x] `bun test` 全量通过（316 pass / 0 fail）。
- [x] `bun run typecheck` 通过。
- [x] `bun run build` 通过。
- [x] 本次 21 个 TypeScript 改动文件 lint 通过；全库 lint 仍被既有 CRLF 基线阻塞（9672 个 `Delete ␍`，无其他 lint 错误）。
- [x] `4141` 仍由修复前记录的同一 PID 监听，未被停止或重启。
- [x] 使用 `wenbo97 <179686042+wenbo97@users.noreply.github.com>` 提交并推送到当前远端。
