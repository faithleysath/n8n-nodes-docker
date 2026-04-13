# n8n-nodes-docker

`n8n-nodes-docker` 是一个面向 **n8n 自托管实例** 的 Docker community node 包。

当前已经完成：

- 独立 npm 包骨架
- `Docker` 主节点的 Phase 2 非二进制容器能力
- `Docker Files` 节点的二进制 / tar 文件能力
- `Docker API` 凭证的可运行连接模型
- 针对 transport、exec policy、tar 工具和节点边界的自动化测试
- 从第一期到完全体的分阶段交付文档

这个仓库还**没有**完成完整 Docker 产品矩阵。当前版本已经落地了容器深度能力、daemon metadata，以及独立的文件导入导出节点，后续镜像、网络、卷、trigger、build、registry 等能力仍按路线图继续推进。

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

当前仓库已经落下两个节点，完整形态预计包含：

- `Docker`
  负责容器、镜像、网络、卷、system 等资源的 CRUD 与运维操作
- `Docker Files`
  负责容器文件导入导出、tar/binary 转换，以及需要 binary 输出的文件系统动作
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

当前 Phase 2 已实现前三种；`SSH` 仍在规划中。

## 安全边界

Docker daemon 的写权限基本等价于宿主机高权限控制，所以这个包默认按“高风险基础设施节点”来设计。

建议默认搭配这些约束一起使用：

- 优先走 `Unix Socket` 或 `SSH`
- 如果走远程 TCP，优先要求 TLS
- 在生产环境优先通过 [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) 缩小 API 面
- 将危险操作与只读操作在参数层和执行层都分开

## 开发状态

当前版本：`0.3.1`

当前实现状态：

- 已实现 `container:list`
- 已实现 `container:create`
- 已实现 `container:exec`
- 已实现 `container:inspect`
- 已实现 `container:start`
- 已实现 `container:stop`
- 已实现 `container:restart`
- 已实现 `container:remove`
- 已实现 `container:logs`
- 已实现 `container:stats`
- 已实现 `container:top`
- 已实现 `container:update`
- 已实现 `container:wait`
- 已实现 `system:ping`
- 已实现 `system:info`
- 已实现 `system:version`
- 已实现 `Docker Files:copyTo`
- 已实现 `Docker Files:copyFrom`
- 已实现 `Docker Files:export`
- 已支持 `Unix Socket`、`TCP`、`TLS`
- 已实现 `readOnly` / `fullControl` 危险操作门禁
- 已加入 transport、exec policy、tar 工具、节点元数据与可选集成测试
- `image` / `network` / `volume` / `SSH` / `trigger` 仍未实现

## 当前节点范围

当前包暴露两个节点：

- `Docker`
  资源范围是 `Container` 和 `System`
  这是 AI 可调用节点，专门保留给 JSON / 文本型输入输出
- `Docker Files`
  负责 `copyTo`、`copyFrom`、`export`
  这个节点不作为 AI 工具，用来隔离 binary 与 tar 工作流

这版是典型的 **programmatic-style node**，不是 declarative-style。原因是 Docker 的 Unix socket 连接、API version 协商、exec / logs raw-stream 解复用、archive/tar 处理、以及写操作门禁都不适合只靠 declarative routing 来表达。

## 凭证与连接说明

`Docker API` 凭证当前支持：

- `Unix Socket`
- `TCP`
- `TLS`

说明：

- `API Version` 默认为 `auto`，会在首次请求时自动协商
- `Access Mode = Read Only` 时，只允许 `list`、`inspect`、`logs`、`top`、`stats`、`wait`、`ping`、`info`、`version`
- `Access Mode = Full Control` 才允许 `create`、`update`、`exec`、`start`、`stop`、`restart`、`remove`，以及 `Docker Files` 的 `copyTo` / `copyFrom` / `export`
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
│   ├── Docker/
│   │   ├── Docker.node.ts
│   │   ├── descriptions/
│   │   ├── operations/
│   │   ├── transport/
│   │   ├── utils/
│   │   ├── docker.svg
│   │   └── docker.dark.svg
│   └── DockerFiles/
│       ├── DockerFiles.node.ts
│       └── DockerFiles.node.json
└── package.json
```

## 发布前需要你确认的内容

这个 scaffold 里有两个占位字段，后续准备发到 GitHub/npm 之前需要替换：

- `package.json > homepage`
- `package.json > repository.url`

当前我先用了 `https://github.com/your-org/n8n-nodes-docker` 作为明确占位值，避免误指向一个不存在但看起来像真的地址。

## 公开发布提示

如果你准备把这个包公开发布到 npm，请先注意：

- 当前公开包名使用 `@faithleysath/n8n-nodes-docker`
- 发布前仍需要先在这台机器上完成 `npm login`

第一次发布前，按 [npm 发布指南](./docs/publishing.md) 走一遍会最稳。
