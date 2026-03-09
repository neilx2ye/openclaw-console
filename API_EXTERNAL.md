# OpenClaw Console 对外 API 文档（同机服务）

本文档基于当前项目 `server.js` 实现（默认端口 `8200`），用于同一台服务器上的其他服务调用。

## 1. 接入信息

- 服务启动: `node server.js`
- 端口: `PORT` 环境变量，默认 `8200`
- 监听地址: 代码未指定 host（`app.listen(PORT)`），同机服务建议通过 `127.0.0.1` 调用
- Base URL（同机建议）: `http://127.0.0.1:8200`
- 数据格式: `application/json`
- 鉴权: 所有接口都经过 Basic Auth 中间件
  - 用户名: `admin`
  - 密码: `QJn81u581sX1jecx`
- CORS: 已开启 `*`，允许 `GET, POST, PUT, PATCH, DELETE, OPTIONS`

示例：

```bash
curl -u admin:QJn81u581sX1jecx http://127.0.0.1:8200/api/status
```

## 2. 通用返回约定

- 成功: HTTP `200`，返回 JSON（少量接口返回 SSE 流）
- 失败: 常见为 `400/401/404/409/500`，错误结构通常为：

```json
{ "error": "错误描述" }
```

## 3. 主要数据结构

### 3.1 Task

```json
{
  "id": "task-1700000000000",
  "title": "任务标题",
  "description": "任务描述",
  "priority": "🔴 高 | 🟡 中 | 🟢 低",
  "status": "pending|queued|dispatching|running|done|failed|...",
  "agentType": "main|local|gateway",
  "agentRef": "main 或子agent id",
  "agentId": "main 或兼容字段",
  "model": "minimax-cn/MiniMax-M2.5",
  "createdAt": 1700000000000,
  "updatedAt": 1700000000000,
  "startedAt": 1700000001000,
  "completedAt": 1700000010000,
  "sessionKey": "agent:...",
  "runId": "....",
  "output": "执行输出",
  "logs": [{ "time": 1700000000000, "msg": "..." }]
}
```

### 3.2 ExecutionQueueItem

```json
{
  "id": "eq_1700000000000_ab12cd34",
  "sourceType": "manual|task|...",
  "sourceId": "task-xxx",
  "title": "队列任务标题",
  "description": "描述",
  "priority": "🔴 高 | 🟡 中 | 🟢 低",
  "agentType": "main|local|gateway",
  "agentRef": "main 或子agent id",
  "model": "minimax-cn/MiniMax-M2.5",
  "status": "queued|dispatching|running|done|failed|canceled",
  "createdAt": 1700000000000,
  "queuedAt": 1700000000000,
  "dispatchAt": 1700000002000,
  "startedAt": 1700000003000,
  "completedAt": 1700000010000,
  "updatedAt": 1700000010000,
  "sessionKey": "agent:...",
  "runId": "...",
  "result": "结果文本",
  "error": "错误信息",
  "logs": [{ "time": 1700000000000, "msg": "..." }]
}
```

### 3.3 SessionItem（`GET /api/sessions`）

```json
{
  "sessionKey": "agent:...",
  "label": "会话标签",
  "kind": "main|local|gateway|...",
  "status": "running|stopped",
  "model": "模型ID",
  "modelProvider": "供应商",
  "updatedAt": 1700000000000,
  "age": 1234,
  "lastMessagePreview": "最后消息摘要"
}
```

## 4. API 目录

## 4.1 实时与系统状态

### GET /api/events

- 用途: SSE 实时事件流
- 响应类型: `text/event-stream`
- 事件类型:
  - `connected`
  - `gateway_status`
  - `sessions_update`
  - `tasks_update`
  - `queue_update`
  - `dashboard_update`
  - `heartbeat`

### GET /api/status

- 用途: 获取 Gateway 连通状态
- 响应关键字段:
  - `status`: `connected|disconnected`
  - `gateway`: `running|stopped`
  - `gatewayPort`
  - `timestamp`
  - `realtimeClients`

### POST /api/gateway/connect

- 用途: 尝试连接/拉起 Gateway
- 响应关键字段:
  - `connected`
  - `alreadyRunning`（可能出现）
  - `gatewayPort`
  - `status`
  - `attempts`

### GET /api/dashboard

- 用途: 获取仪表盘快照
- 响应关键字段:
  - `status`
  - `gateway`
  - `gatewayPort`
  - `activeSessions`
  - `recentSessions`
  - `taskStats`
  - `queueStats`
  - `timestamp`

## 4.2 任务管理（tasks）

### GET /api/tasks

- 用途: 获取任务列表
- 响应: `{ "tasks": Task[] }`

### POST /api/tasks

- 用途: 创建任务
- 必填:
  - `title`
- 可选:
  - `description`
  - `priority`
  - `status`
  - `agentType` (`main|local|gateway`)
  - `agentRef` 或 `agentId`
  - `model`
- 成功响应: `{ "success": true, "task": Task }`
- 常见错误:
  - `400` 标题不能为空

### PATCH /api/tasks/:id

- 用途: 更新任务
- 可更新字段:
  - `title`
  - `description`
  - `priority`
  - `status`
  - `logs`
  - `model`
  - `output`
  - `agentType` / `agentRef` / `agentId`
- 成功响应: `{ "success": true, "task": Task }`
- 常见错误:
  - `404` 任务不存在

### DELETE /api/tasks/:id

- 用途: 删除任务，并移除关联执行队列项
- 成功响应: `{ "success": true, "removedQueueCount": number }`
- 常见错误:
  - `404` 任务不存在

### POST /api/tasks/:id/execute

- 用途: 将任务放入执行队列并触发处理
- 成功响应:
  - `success`
  - `task`
  - `queueItem`（ExecutionQueueItem）
  - `message`
- 常见错误:
  - `404` 任务不存在
  - `409` 任务已在执行队列中

## 4.3 会话管理（sessions）

### GET /api/sessions

- 用途: 列出会话
- Query:
  - `limit`（默认 `250`，范围 `1-500`）
- 响应:
  - `sessions: SessionItem[]`
  - `total`
  - `timestamp`
  - `rpc`

### GET /api/sessions/:key/history

- 用途: 获取会话历史
- Path:
  - `key`（需 URL 编码）
- Query:
  - `limit`（默认 `120`，范围 `1-1000`）
- 响应:
  - `key`
  - `usedMethod`
  - `messages`（格式：`{id, role, text, timestamp}`）

### POST /api/sessions/send

- 用途: 向会话发送消息
- 必填:
  - `sessionKey`（或 `key`）
  - `message`
- 可选:
  - `thinking`
  - `deliver`
  - `timeoutMs`
- 成功响应:
  - `success`
  - `usedMethod`
  - `result`
- 常见错误:
  - `400` `sessionKey` 或 `message` 为空

### POST /api/sessions/spawn

- 用途: 创建/触发新会话
- 必填:
  - `task`
- 可选:
  - `agentId`
  - `label`
  - `model`
  - `timeout`
- 成功响应:
  - `success`
  - `usedMethod`
  - `sessionKey`
  - `runId`
  - `result`

### POST /api/sessions/kill

- 用途: 结束会话（Body 传 session key）
- 必填:
  - `sessionKey`（或 `key`）
- 可选:
  - `deleteTranscript`
- 成功响应:
  - `success`
  - `usedMethod`
  - `result`

### POST /api/sessions/:key/kill

- 用途: 结束指定会话（Path 传 session key）
- Path:
  - `key`（需 URL 编码）
- 可选:
  - `deleteTranscript`
- 成功响应:
  - `success`
  - `usedMethod`
  - `result`

### PATCH /api/sessions/:key

- 用途: 更新会话元信息
- Path:
  - `key`（需 URL 编码）
- 可选:
  - `label`
  - `model`
  - `thinkingLevel`
- 成功响应:
  - `success`
  - `usedMethod: "sessions.patch"`
  - `result`

## 4.4 Agent 与子 Agent

### GET /api/agents

- 用途: 获取 agent 列表（优先走 gateway，失败则回退 main）
- 响应: `{ "agents": [{ "id", "name", "desc" }] }`

### GET /api/subagents/local

- 用途: 获取本地子 agent 列表
- 响应:
  - `subagents`
  - `total`

### POST /api/subagents/local

- 用途: 创建本地子 agent
- 必填:
  - `name`
- 可选:
  - `id`
  - `identity`
  - `personality`
  - `memoryLong`
  - `defaultModel` 或 `model`
  - `sessionKey`
- 成功响应: `{ "success": true, "subagent": {...} }`
- 常见错误:
  - `400` `name` 为空
  - `409` id 冲突

### PATCH /api/subagents/local/:id

- 用途: 更新本地子 agent
- 可选:
  - `name`
  - `identity`
  - `personality`
  - `memoryLong`
  - `defaultModel`
  - `sessionKey`
- 成功响应: `{ "success": true, "subagent": {...} }`
- 常见错误:
  - `404` 子agent不存在

### DELETE /api/subagents/local/:id

- 用途: 删除本地子 agent
- 成功响应: `{ "success": true, "removed": {...} }`
- 常见错误:
  - `404` 子agent不存在

### POST /api/subagents/local/:id/chat

- 用途: 向本地子 agent 发送消息（通过 spawn）
- 必填:
  - `message`
- 可选:
  - `model`
  - `timeout`（秒）
- 成功响应:
  - `success`
  - `subagent`
  - `usedMethod`
  - `sessionKey`
  - `runId`
  - `result`
- 常见错误:
  - `400` `message` 为空
  - `404` 子agent不存在

### GET /api/subagents/gateway

- 用途: 获取 gateway 子 agent 列表（含 meta 融合信息）
- 响应:
  - `subagents`
  - `total`

### POST /api/subagents/gateway

- 用途: 创建 gateway 子 agent
- 必填:
  - `agentId` 或 `id` 或 `name`（三者至少一个）
- 可选:
  - `workspace`
  - `model`
  - `identity`
  - `emoji`
  - `theme`
  - `personality`
  - `memoryLong`
- 成功响应:
  - `success`
  - `agentId`
  - `workspace`
  - `meta`
  - `raw`

### PATCH /api/subagents/gateway/:id

- 用途: 更新 gateway 子 agent 配置及 meta
- 可选:
  - `identity` 或 `name`
  - `emoji`
  - `theme`
  - `personality`
  - `memoryLong`
  - `defaultModel` 或 `model`
  - `sessionKey`
- 成功响应: `{ "success": true, "meta": {...} }`
- 常见错误:
  - `400` id 为空

### DELETE /api/subagents/gateway/:id

- 用途: 删除 gateway 子 agent
- 成功响应: `{ "success": true, "id": "..." }`
- 常见错误:
  - `400` id 为空 / 主Agent不可删除

### POST /api/subagents/gateway/:id/chat

- 用途: 向 gateway 子 agent 发送消息（通过 send）
- 必填:
  - `message`
- 可选:
  - `model`
  - `timeoutMs`
- 成功响应:
  - `success`
  - `usedMethod`
  - `sessionKey`
  - `runId`
  - `result`
- 常见错误:
  - `400` `message` 为空

## 4.5 定时任务（schedules）

### GET /api/schedules

- 用途: 获取 cron 状态与任务列表
- 响应:
  - `status`（`enabled/jobs/storePath/nextWakeAtMs/error`）
  - `jobs`
  - `jobsError`
  - `total`
  - `timestamp`

### POST /api/schedules

- 用途: 新增定时任务
- 必填:
  - `name`
  - `message`
  - `cron` / `at` / `every`（至少一项）
- 可选:
  - `agentId`（默认 `main`）
  - `description`
  - `model`
  - `tz`
  - `disabled`（`true` 时创建后禁用）
- 成功响应:
  - `success`
  - `result`
- 常见错误:
  - `400` 参数缺失

### PATCH /api/schedules/:id

- 用途: 更新任务，或启用/禁用
- 方式一（快捷动作）:
  - `action: "enable"` 或 `action: "disable"`
- 方式二（编辑字段）:
  - `name`
  - `description`
  - `agentId`
  - `message`
  - `model`
  - `cron`
  - `at`
  - `every`
  - `tz`
  - `enabled`
- 成功响应:
  - `success`
  - `id`
  - `action` 或 `result`

### DELETE /api/schedules/:id

- 用途: 删除定时任务
- 成功响应: `{ "success": true, "id": "..." }`

### POST /api/schedules/:id/run

- 用途: 立即执行一次定时任务
- 成功响应:
  - `success`
  - `id`
  - `result`

### GET /api/schedules/:id/runs

- 用途: 获取执行记录
- Query:
  - `limit`（默认 `20`，范围 `1-500`）
- 成功响应:
  - `id`
  - `limit`
  - `runs`
  - `raw`

## 4.6 技能（skills）

### GET /api/skills

- 用途: 获取技能列表
- 响应:
  - `skills`
  - `total`
  - `workspaceDir`
  - `managedSkillsDir`
  - `timestamp`

### GET /api/skills/:name

- 用途: 获取技能详情和 `SKILL.md` 内容
- Path:
  - `name`（会做安全校验和 URL 解码）
- 成功响应:
  - `skill`
  - `content`
  - `contentBytes`
  - `timestamp`
- 常见错误:
  - `400` 名称不合法
  - `404` 文件不存在

### PATCH /api/skills/:name

- 用途: 更新技能主文件 `SKILL.md`
- 必填:
  - `content`（最大 3MB）
- 成功响应:
  - `success`
  - `name`
  - `filePath`
  - `bytes`
  - `updatedAt`
  - `timestamp`
- 常见错误:
  - `400` 名称不合法 / content 缺失或超限

## 4.7 模型与 RPC

### GET /api/models

- 用途: 获取可用模型列表（网关 + 配置合并，失败时返回内置默认）
- 响应:
  - `models: [{ id, name, provider }]`

### GET /api/rpc/methods

- 用途: 获取 RPC alias 对照表
- 响应:
  - `aliases`
  - `timestamp`

## 4.8 执行队列（execution-queue）

### GET /api/execution-queue

- 用途: 查询执行队列
- Query:
  - `all=1` 或 `activeOnly=0` 时返回全部
  - 默认仅返回活跃状态（`queued|dispatching|running`）
- 成功响应:
  - `tasks: ExecutionQueueItem[]`
  - `total`
  - `active`

### POST /api/execution-queue

- 用途: 创建队列任务并触发处理
- 必填:
  - `title`
- 可选:
  - `sourceType`
  - `sourceId`
  - `description`
  - `priority`
  - `agentType`
  - `agentRef` 或 `agentId`
  - `model`
- 成功响应: `{ "success": true, "queueItem": ExecutionQueueItem }`
- 常见错误:
  - `400` 标题不能为空

### POST /api/execution-queue/:id/cancel

- 用途: 取消活跃队列任务
- 成功响应: `{ "success": true, "task": ExecutionQueueItem }`
- 常见错误:
  - `404` 队列任务不存在

### DELETE /api/execution-queue/:id

- 用途: 删除队列任务
- 成功响应: `{ "success": true, "removed": ExecutionQueueItem }`
- 常见错误:
  - `404` 队列任务不存在

## 4.9 兼容旧队列接口（/api/queue）

### GET /api/queue

- 用途: 兼容读取队列（逻辑同 `/api/execution-queue`）
- Query:
  - `all=1` 或 `activeOnly=0`
- 响应: `{ "tasks": ExecutionQueueItem[] }`

### POST /api/queue

- 用途: 兼容创建队列任务
- 参数与 `/api/execution-queue` POST 基本一致
- 成功响应: `{ "success": true, "queueItem": ExecutionQueueItem }`

### DELETE /api/queue/:id

- 用途: 兼容删除队列任务（不存在也返回 success）
- 成功响应: `{ "success": true }`

### POST /api/queue/process

- 用途: 手动触发队列处理
- 成功响应: `{ "success": true }`

## 5. 最小对接示例

### 5.1 查询状态

```bash
curl -u admin:QJn81u581sX1jecx \
  http://127.0.0.1:8200/api/status
```

### 5.2 创建并执行任务

```bash
curl -u admin:QJn81u581sX1jecx \
  -H 'Content-Type: application/json' \
  -d '{"title":"daily-report","description":"生成日报","priority":"🔴 高"}' \
  http://127.0.0.1:8200/api/tasks

curl -u admin:QJn81u581sX1jecx \
  -X POST http://127.0.0.1:8200/api/tasks/task-1700000000000/execute
```

### 5.3 读取执行队列（全部）

```bash
curl -u admin:QJn81u581sX1jecx \
  'http://127.0.0.1:8200/api/execution-queue?all=1'
```

