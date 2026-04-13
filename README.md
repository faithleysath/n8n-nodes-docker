# n8n-nodes-docker

`n8n-nodes-docker` 是一个面向 **n8n 自托管实例** 的 Docker community node 包规划仓库。

这个仓库现在已经完成了：

- 独立 npm 包骨架
- `Docker` 主节点的初始结构
- `Docker API` 凭证骨架
- 从第一期到完全体的分阶段交付文档

这个仓库现在还**没有**完成 Docker Engine API 的正式实现。当前节点的执行逻辑会明确提示“这是 scaffold”。这样做是为了先把包结构、路线、边界和交付节奏定稳，再逐期实现功能，避免一开始就把节点做成难维护的大泥球。

## 目标

这个包的目标不是只做几个容器启停按钮，而是把 Docker 能力系统化接入 n8n，包括：

- 镜像管理
- 容器生命周期管理
- 容器内命令执行
- 容器文件导入导出
- 网络与数据卷管理
- Docker daemon / system 能力
- Docker 事件触发
- 后期的构建、导入导出、注册表与更高级能力

## 规划中的节点族

当前仓库先落 `Docker` 主节点骨架，完整形态预计包含：

- `Docker`
  负责容器、镜像、网络、卷、system 等资源的 CRUD 与运维操作
- `Docker Trigger`
  监听或轮询 Docker events，把 daemon 事件转成工作流触发源
- `Docker Build`
  单独承接 build context、BuildKit、镜像导入导出、长时间运行任务
- `Docker Registry`
  后续如果需要，再把 registry auth、manifest、tag 生命周期独立出来

## 连接方式规划

`Docker API` 凭证已经预留了这些连接模式：

- `Unix Socket`
- `TCP`
- `TLS`
- `SSH`

这四种模式足够覆盖绝大多数自托管场景。

## 安全边界

Docker daemon 的写权限基本等价于宿主机高权限控制，所以这个包默认按“高风险基础设施节点”来设计。

建议默认搭配这些约束一起使用：

- 优先走 `Unix Socket` 或 `SSH`
- 如果走远程 TCP，优先要求 TLS
- 在生产环境优先通过 [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) 缩小 API 面
- 当前骨架为了兼容 n8n community node 工具链类型约束，保留了 `usableAsTool: true`；在真正实现危险操作前，建议重新评估 AI tool 暴露策略
- 将危险操作与只读操作在参数层和执行层都分开

## 开发状态

当前版本：`0.1.0`

当前实现状态：

- 包结构已就位
- 节点名、图标、元数据已改成 Docker 方向
- 凭证字段已按最终架构预留
- 路线文档已覆盖 Phase 1 到完全体
- 业务实现尚未开始

## 文档导航

- [架构设计](./docs/architecture.md)
- [阶段路线图](./docs/roadmap.md)
- [能力矩阵](./docs/operations-matrix.md)

## 本地开发

```bash
pnpm install
pnpm build
pnpm lint
```

如需把这个包接到本地 n8n 做联调：

```bash
pnpm dev
```

## 仓库结构

```text
n8n-nodes-docker/
├── credentials/
│   └── DockerApi.credentials.ts
├── docs/
│   ├── architecture.md
│   ├── operations-matrix.md
│   └── roadmap.md
├── nodes/
│   └── Docker/
│       ├── Docker.node.ts
│       ├── Docker.node.json
│       ├── docker.svg
│       └── docker.dark.svg
└── package.json
```

## 发布前需要你确认的内容

这个 scaffold 里有两个占位字段，后续准备发到 GitHub/npm 之前需要替换：

- `package.json > homepage`
- `package.json > repository.url`

当前我先用了 `https://github.com/your-org/n8n-nodes-docker` 作为明确占位值，避免误指向一个不存在但看起来像真的地址。
