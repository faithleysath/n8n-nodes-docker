# 架构设计

## 1. 设计目标

这个包的目标是把 Docker 接入 n8n，但不是把所有逻辑都塞进一个超大文件里，而是按 **适合 n8n 工作流表达** 的方式分层。

设计目标：

- 支持 Docker 常用资源的管理与编排
- 保持节点参数结构可理解，不把 UI 做成“万能 JSON 输入框”
- 能处理 n8n 的 binary data 流程，覆盖文件导入导出
- 能兼容本地 socket、远程 TLS、SSH 等部署方式
- 对危险操作保留明确的安全边界
- 允许分阶段交付，不要求第一期就一口气做完所有资源

## 2. 节点拆分原则

### 2.1 `Docker` 主节点

这是第一优先级节点，负责绝大多数运维动作。

建议放入的资源：

- `container`
- `image`
- `network`
- `volume`
- `system`

适合这个主节点的原因：

- 都属于 Docker Engine API 核心资源
- 都是典型 request/response 型动作
- 很适合 n8n 的 `resource + operation` 交互模型

### 2.2 `Docker Trigger`

职责：

- 订阅或轮询 Docker events
- 根据事件类型触发工作流

为什么单独拆：

- 它的执行模型和普通 action node 不同
- 需要处理长连接、重连、过滤器、事件去重

### 2.3 `Docker Files`

职责：

- `copyTo`
- `copyFrom`
- `export`
- `save`
- `load`
- tar / binary 转换

为什么单独拆：

- 这些操作直接读写 n8n binary data
- 默认输出不是 JSON，而是 tar 或单文件 binary
- 需要把二进制文件能力和 AI tool 可调用面分离

### 2.4 `Docker Build`

职责：

- `build`
- `import`
- tar-based image build / import
- 大 tar 包与 BuildKit 风格输出流

为什么不和主节点一起首发：

- 输入输出是 tar/stream
- 运行时间可能很长
- 进度日志和普通 JSON 返回差异很大
- 需要单独处理超时、取消和流式输出聚合
- `save` / `load` / `export` 仍然更适合保留在 `Docker Files`

## 3. 凭证设计

`DockerApi.credentials.ts` 当前支持：

- `Unix Socket`
- `TCP`
- `TLS`
- `SSH`

字段分层如下：

### 基础字段

- `connectionMode`
- `apiVersion`
- `accessMode`

### Unix Socket

- `socketPath`

### TCP / TLS

- `host`
- `port`

### TLS

- `ca`
- `cert`
- `key`
- `passphrase`
- `ignoreTlsIssues`

### SSH

- `host`
- `username`
- `sshPort`
- `privateKey`
- `remoteSocketPath`
- `passphrase`

当前实现方式是：

- 用 SSH 私钥连接远端主机
- 通过 OpenSSH stream-local forwarding 访问远端 Docker Unix socket
- 在 transport 层统一处理请求、流式输出和连接释放

`accessMode` 不是安全隔离本身，而是这个包里的执行策略输入。真正的边界还是应该落在 Docker daemon 暴露方式和代理层。

## 4. 运行层设计

当前实现采用分层结构，而不是把所有 Docker 调用写在节点类里。

推荐结构：

```text
nodes/Docker/
├── Docker.node.ts
├── Docker.node.json
├── descriptions/
│   ├── container.ts
│   └── system.ts
├── operations/
│   ├── container.ts
│   └── system.ts
├── transport/
│   ├── dockerClient.ts
│   └── dockerLogs.ts
├── utils/
│   ├── execPolicy.ts
│   ├── execution.ts
│   ├── merge.ts
│   └── tar.ts
nodes/DockerFiles/
├── DockerFiles.node.ts
└── DockerFiles.node.json
nodes/DockerBuild/
├── DockerBuild.node.ts
└── DockerBuild.node.json
```

### 节点层

负责：

- 参数描述
- 参数读取
- 调度到具体 operation
- n8n 错误包装

### transport 层

负责：

- 创建 Docker 客户端
- 屏蔽不同连接方式的差异
- 统一 API version 与认证配置

### operation 层

负责：

- 资源级业务逻辑
- 输入参数到 Docker API 的转换
- 输出结果到 n8n item 的转换

### utils 层

负责：

- tar 与 binary 互转
- log / event stream 解析
- build / import JSON-line 输出归一化
- 错误信息标准化

## 5. Transport 选型结论

当前实现结论：

- 已采用自定义 transport，而不是把节点层直接绑定到单一 Docker SDK
- `Unix Socket`、`TCP`、`TLS`、`SSH` 都在 `dockerClient.ts` 里统一收口
- `SSH` 通过 `ssh2` + OpenSSH stream-local forwarding 访问远端 Unix socket

这样做的原因：

- 需要精确控制 Docker raw-stream、JSON-line、archive 和 build/import 流
- 需要把 API version 协商、请求级超时、abort、连接关闭和 trigger 长流 teardown 放在同一层处理
- n8n 节点层更关注参数模型、continue-on-fail 和输出整形，不适合直接承担连接细节

保留 transport 抽象的意义仍然不变：将来即使要引入官方 SDK 或替换底层实现，也不需要重做节点参数和资源/操作边界。

## 6. 二进制与文件设计

Docker 文件导入导出不能只按普通文本字段来做，必须和 n8n binary 体系对齐。

### Copy To Container

输入：

- `binaryPropertyName`
- `targetPath`

内部流程：

1. 从 n8n item 读取 binary
2. 组装成 tar
3. 调用 `PUT /containers/{id}/archive`

### Copy From Container

输入：

- `containerId`
- `sourcePath`

输出：

- 默认输出 tar binary
- 后续可提供“单文件自动解包”选项

## 7. 输出设计

普通操作返回 JSON：

- `list`
- `inspect`
- `info`
- `version`
- `create`
- `remove`

日志和事件建议两种模式：

- `aggregated`
  把结果聚合成一个 item，便于后续统一处理
- `split`
  每条日志/事件一条 item，便于过滤、告警、路由

文件相关操作返回 binary，并单独放入 `Docker Files` 节点。

Build 与 import 相关操作返回 JSON，但输入是 binary tar，且默认走流式聚合模式，因此单独放入 `Docker Build` 节点。

## 8. 安全设计

这类节点不能按普通 SaaS API 节点处理。

建议执行层保留这些 guardrail：

- `readOnly` 凭证默认禁止写操作
- `fullControl` 才允许 `create / delete / exec / pull / tag / copyTo / copyFrom / export / save / load / prune`
- `fullControl` 也必须允许 `build / import`
- `system prune`、`image remove`、`container remove --force` 等危险动作必须单独显式参数开启
- `Docker` 主节点默认启用 AI tool 模式，但只暴露非 binary 的 JSON / 文本操作
- `Docker Files` 节点不启用 AI tool 模式

## 9. 测试策略

### 单元测试

覆盖：

- 参数解析
- 请求构造
- 错误映射
- binary / tar 转换

### 集成测试

当前建议显式区分两类可选集成：

- container lifecycle
- image pull/remove
- image build/import
- exec
- copyTo / copyFrom
- network / volume
- 真实 Docker daemon：`RUN_DOCKER_INTEGRATION=1 node --test tests/docker.integration.test.cjs`
- 本地 SSH helper：`pnpm test:ssh:local`

### 触发器测试

单独覆盖：

- event filter
- reconnect
- duplicate suppression

## 10. 发布策略

建议按“功能可用块”发版，而不是按代码量发版。

推荐节奏：

- `0.1.x` scaffold 和设计落地
- `0.2.x` container MVP
- `0.3.x` 完整 container deepening
- `0.4.x` image + network + volume + system
- `0.5.x` trigger + advanced streaming
- `0.6.x` build / import / advanced workflows
- `1.0.0` full product shape core release
- `1.0.x+` registry / advanced workflows / product hardening

`1.0.0` 之后可以把这个包对外描述为面向自托管 n8n 的 Docker automation toolkit，但 `registry`、Swarm 和 Compose-like 抽象仍不在当前公开能力面内。
