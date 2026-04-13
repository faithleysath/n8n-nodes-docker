# 路线图

这份路线图不是只写第一期，而是把 `n8n-nodes-docker` 从初始可用版本一路做到完整产品形态。

## Phase 1: Foundation MVP

### 目标

让这个包从“有仓库”变成“能在 n8n 里真正连通 Docker 并完成最核心的容器运维动作”。

### 范围

- 完成 transport 层
- 打通至少一种稳定连接方式
- 提供最核心容器操作
- 建立测试与错误处理基线

### 建议能力

资源：

- `container`
- `system`

操作：

- `container:list`
- `container:inspect`
- `container:start`
- `container:stop`
- `container:restart`
- `container:remove`
- `container:logs`
- `system:ping`
- `system:info`
- `system:version`

### 连接支持

- 必做：`Unix Socket`
- 可选：`TCP`
- 暂不要求：`TLS`、`SSH`

### 交付物

- `DockerApi.credentials.ts` 真正可用
- `Docker.node.ts` 首个可运行版本
- 单元测试和最小集成测试
- README 更新到“可用 MVP”

### 验收标准

- 本地 n8n 能连接 Docker daemon
- 典型流程可跑通：
  - 查询容器列表
  - 自动重启目标容器
  - 拉取容器日志并转发
- `pnpm build` 和 `pnpm lint` 通过

## Phase 2: Container Deepening

### 目标

把容器能力从“基础运维”升级到“工作流可编排的完整容器操作集”。

### 范围

- 重点补齐 `container` 资源深度能力
- 引入第一次 binary/tar 能力

### 建议能力

- `container:create`
- `container:update`
- `container:wait`
- `container:stats`
- `container:top`
- `container:exec`
- `container:copyTo`
- `container:copyFrom`
- `container:export`

### 重点难点

- `exec` 的 stdout/stderr 处理
- `tty` 与非 `tty` 的差异
- binary 到 tar 的转换
- 容器文件导出时的 tar 返回策略

### 交付物

- exec 参数模型
- binary 文件导入导出能力
- 更好的 continue-on-fail 行为
- 更细的错误映射

### 验收标准

- 能在工作流里对容器执行命令
- 能把 n8n binary 文件导入容器
- 能从容器导出文件给后续节点处理

## Phase 3: Image + Network + Volume + System

### 目标

把 Docker 的核心资源面补齐，形成“不是只管容器”的完整 Docker 管理节点。

### 范围

资源：

- `image`
- `network`
- `volume`
- 补强 `system`

### 建议能力

#### image

- `list`
- `inspect`
- `pull`
- `tag`
- `remove`
- `history`
- `save`
- `load`
- `prune`

#### network

- `list`
- `inspect`
- `create`
- `connect`
- `disconnect`
- `delete`
- `prune`

#### volume

- `list`
- `inspect`
- `create`
- `delete`
- `prune`

#### system

- `df`
- `events` 基础读取模式

### 交付物

- image/network/volume 的 description 与 operation 模块
- 资源级测试夹具
- 面向 n8n 用户的示例工作流

### 验收标准

- 能通过 n8n 完成容器、镜像、网络、数据卷四类资源的常见 CRUD
- 典型运维自动化可表达：
  - 拉镜像 -> 更新容器
  - 创建专用网络 -> 启动容器 -> 连接网络
  - 创建卷 -> 运行作业容器 -> 导出结果

## Phase 4: Trigger + Advanced Streaming

### 目标

让 Docker 从“被动管理对象”变成“主动触发源”。

### 范围

- `Docker Trigger`
- 强化日志与事件流处理
- 优化长连接稳定性

### 建议能力

#### Docker Trigger

- 监听 Docker events
- 支持按类型过滤：
  - container
  - image
  - network
  - volume
  - daemon
- 支持按 action 过滤：
  - start
  - stop
  - die
  - destroy
  - pull
  - create
  - remove

#### 主节点补强

- `logs` 流式/聚合双模式
- `events` 轮询回放模式
- reconnect/backoff

### 交付物

- `DockerTrigger.node.ts`
- event filter 设计
- 去重和断线重连策略

### 验收标准

- 容器启动/退出/重启等事件可以触发工作流
- 日志和事件流在长时间运行时不会轻易失控

## Phase 5: Build, Import/Export, Registry-Oriented Workflows

### 目标

把 Docker 节点从“运维工具”提升到“交付流水线组件”。

### 范围

- `Docker Build` 节点
- 更重的 tar / image import/export 流程
- registry 相关能力的第一版

### 建议能力

#### Docker Build

- `build`
- `build with args`
- `build from binary tar`
- `stream build output`

#### image/import/export

- `save`
- `load`
- `import`
- `export`

#### registry workflows

- registry auth 预留
- 私有镜像拉取/推送规划

### 难点

- BuildKit 日志流
- 大文件传输和内存占用
- 可取消、可超时、可继续失败的执行语义

### 验收标准

- n8n 可作为 Docker 交付流水线的一环
- 可以从 binary context 构建镜像
- 可以把构建输出与后续部署动作串起来

## Phase 6: Full Product Shape

### 目标

把包做成真正意义上的“Docker automation toolkit for n8n”。

### 完整形态建议

- `Docker` 主节点资源面完整
- `Docker Trigger` 稳定可用
- `Docker Build` 适合 CI/CD 场景
- `SSH`、`TLS`、`Unix Socket` 全连接模式稳定
- 针对自托管生产环境的安全建议和模板齐全

### 可选增强

- `Compose-like` higher-level actions
- `Swarm` 能力
- registry 深度能力
- 智能参数预填与 load options
- 容器/镜像/网络/卷自动补全
- 导入官方样例工作流

### 产品化要求

- 文档完备
- 示例工作流完备
- 集成测试覆盖主能力面
- 版本迁移策略明确
- 对外 README、CHANGELOG、发布说明成熟

## 阶段之间的依赖关系

按顺序建议如下：

1. Phase 1 打基础，不跳过
2. Phase 2 补强 container，因为这是最常用资源
3. Phase 3 扩展到 image/network/volume/system
4. Phase 4 再做 Trigger，避免事件流把基础层带歪
5. Phase 5 做 build 和大文件
6. Phase 6 再考虑更高阶产品化能力

## 不建议在第一期就做的内容

这些功能很诱人，但第一期就做容易拖慢整体交付：

- BuildKit 深度支持
- 完整 registry 生命周期
- Swarm
- Compose 抽象层
- 自动补全和 load options
- 跨多 daemon 的高级拓扑管理

## 当前状态

仓库当前处于：

- Phase 0.5

也就是：

- 包骨架已完成
- 方向和分期已落文档
- 节点和凭证骨架已创建
- 正式业务实现尚未开始
