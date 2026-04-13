# n8n-nodes-docker

`n8n-nodes-docker` 是一个面向 **n8n 自托管实例** 的 Docker community node 包。

当前已经完成：

- 独立 npm 包骨架
- `Docker` 主节点的 Phase 1 MVP
- `Docker API` 凭证的可运行连接模型
- 针对 transport 和日志解析的最小自动化测试
- 从第一期到完全体的分阶段交付文档

这个仓库还**没有**完成完整 Docker 产品矩阵。当前版本已经落地了容器与 daemon metadata 的 MVP，后续镜像、网络、卷、trigger、build、registry 等能力仍按路线图继续推进。

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

当前仓库先落 `Docker` 主节点，完整形态预计包含：

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

当前 Phase 1 已实现前三种；`SSH` 仍在规划中。

## 安全边界

Docker daemon 的写权限基本等价于宿主机高权限控制，所以这个包默认按“高风险基础设施节点”来设计。

建议默认搭配这些约束一起使用：

- 优先走 `Unix Socket` 或 `SSH`
- 如果走远程 TCP，优先要求 TLS
- 在生产环境优先通过 [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) 缩小 API 面
- 将危险操作与只读操作在参数层和执行层都分开

## 开发状态

当前版本：`0.2.0`

当前实现状态：

- 已实现 `container:list`
- 已实现 `container:inspect`
- 已实现 `container:start`
- 已实现 `container:stop`
- 已实现 `container:restart`
- 已实现 `container:remove`
- 已实现 `container:logs`
- 已实现 `system:ping`
- 已实现 `system:info`
- 已实现 `system:version`
- 已支持 `Unix Socket`、`TCP`、`TLS`
- 已实现 `readOnly` / `fullControl` 危险操作门禁
- 已加入最小自动化测试
- `image` / `network` / `volume` / `SSH` / `binary` / `trigger` 仍未实现

## 当前节点范围

当前包只暴露一个 `Docker` 节点，资源范围是：

- `Container`
- `System`

这版是典型的 **programmatic-style node**，不是 declarative-style。原因是 Docker 的 Unix socket 连接、API version 协商、日志 raw-stream 解复用、以及写操作门禁都不适合只靠 declarative routing 来表达。

## 凭证与连接说明

`Docker API` 凭证当前支持：

- `Unix Socket`
- `TCP`
- `TLS`

说明：

- `API Version` 默认为 `auto`，会在首次请求时自动协商
- `Access Mode = Read Only` 时，只允许 `list`、`inspect`、`logs`、`ping`、`info`、`version`
- `Access Mode = Full Control` 才允许 `start`、`stop`、`restart`、`remove`
- 由于 n8n 的静态 credential request 模型不适合 Docker Unix socket，这个版本改用 node-level credential test 来校验 `Unix Socket`、`TCP`、`TLS` 连接，而不是提供一个误导性的“假测试”

## 文档导航

- [架构设计](./docs/architecture.md)
- [阶段路线图](./docs/roadmap.md)
- [能力矩阵](./docs/operations-matrix.md)
- [npm 发布指南](./docs/publishing.md)

## 本地开发

```bash
pnpm install
pnpm lint
pnpm test
```

如需把这个包接到本地 n8n 做联调：

```bash
pnpm dev
```

如果只想单独构建产物：

```bash
pnpm build
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

## 公开发布提示

如果你准备把这个包公开发布到 npm，请先注意两点：

- `n8n-nodes-docker` 这个包名已经被别人占用，建议改成 `@你的-npm-用户名/n8n-nodes-docker`
- 当前仓库还没有配置真实的 GitHub 远端，`package.json` 的仓库地址也仍是占位值

第一次发布前，按 [npm 发布指南](./docs/publishing.md) 走一遍会最稳。
