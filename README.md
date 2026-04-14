# n8n-nodes-docker

`n8n-nodes-docker` 是一个面向 **n8n 自托管实例** 的 Docker community node 包。

当前版本：`1.0.0`

这个版本对应路线图中的 **Phase 6 核心版**：

- `Docker` 主节点覆盖 `container`、`image`、`network`、`volume`、`system`
- `Docker Files` 覆盖容器文件导入导出和 `image save/load`
- `Docker Trigger` 覆盖 Docker event 触发、游标回放、去重和重连
- `Docker Build` 覆盖 tar-based `build` 与 `import`
- `Unix Socket`、`TCP`、`TLS`、`SSH` 四种连接模式可用
- 已有自动化测试覆盖 transport、节点执行、长流、tar/build 工具、SSH 生命周期，以及可选的真实 Docker daemon / 本地 SSH 集成路径

这个包的定位是 **Docker automation toolkit for n8n**，重点是把 Docker 的常用资源管理、文件流、事件流和构建链路系统化接到工作流里。`registry`、`Swarm`、`Compose-like` 抽象和智能补全仍留在后续版本，不属于 `1.0.0` 的公开能力面。

## 节点族

- `Docker`
  负责容器、镜像、网络、卷和 daemon metadata 的 JSON / 文本型操作，
  也承接 Linux 容器内的文本文件 helper 操作。
  这是唯一保留为 AI-usable 的节点。
- `Docker Files`
  负责 `copyTo`、`copyFrom`、`export`、`image save`、`image load`。
  这个节点专门隔离 binary / tar 工作流。
- `Docker Trigger`
  负责 Docker event 监听、回放、去重和重连。
- `Docker Build`
  负责 tar-based image build / import，以及长时间运行的流式构建输出。

## 当前能力面

已实现的资源与操作：

- `container`: `list`, `inspect`, `create`, `update`, `start`, `stop`, `restart`, `remove`, `logs`, `stats`, `top`, `wait`, `exec`, `readTextFile`, `listFiles`, `searchText`, `writeTextFile`, `replaceExactText`
- `image`: `list`, `inspect`, `pull`, `tag`, `remove`, `history`, `prune`, `save`, `load`, `build`, `import`
- `network`: `list`, `inspect`, `create`, `connect`, `disconnect`, `delete`, `prune`
- `volume`: `list`, `inspect`, `create`, `delete`, `prune`
- `system`: `ping`, `info`, `version`, `df`, `events`

流式与长任务增强：

- `container:logs` 支持 `snapshot` / `followForDuration`
- `container:readTextFile` / `listFiles` / `searchText` / `writeTextFile` / `replaceExactText`
  提供 Linux-only 的 container 文本文件 helper 能力
- `system:events` 支持 `bounded` / `resumeFromCursor`
- `Docker Trigger` 支持 replay、dedupe、reconnect
- `Docker Build` 支持 streamed build/import output、超时、取消和 continue-on-fail

这些 convenience operation 的边界是：

- 只承诺 **Linux 容器** 语义
- `listFiles`、`searchText`、`writeTextFile(createParentDirectories=true)` 依赖容器内存在 `/bin/sh`
- `listFiles` 依赖常见用户态工具如 `find`、`sort`、`sed`
- `searchText` 优先使用 `rg`，缺失时回退到 `grep`，两条路径都按容器文件系统真实内容搜索，不遵守 ignore 规则；`Limit` 会在 helper 层生效，而不是只裁剪最终返回 items
- `listFiles` / `searchText` 的 `Working Path` 不存在时，会返回节点级错误而不是 OCI `cwd` 细节
- `listFiles` 在显式指定隐藏目录作为 `Working Path` 时，仍会把它当作遍历根；`Include Hidden = false` 只过滤该根下的隐藏后代
- `readTextFile` / `replaceExactText` 只接受有效 UTF-8 文本，遇到非法 UTF-8 会返回节点级错误
- `replaceExactText` 会保留目标文件原有的统一换行风格，不会把 CRLF 文件整体改写成 LF

## 文本文件 helper 迁移说明

如果你之前在本机 n8n 里用 workflow 形式维护这些 tool：

- `tool_read_container_file`
- `tool_list_container_files`
- `tool_search_container_text`
- `tool_apply_container_patch`

现在建议直接迁移到 `Docker` 主节点的公开 operation：

- `tool_read_container_file` -> `container:readTextFile`
- `tool_list_container_files` -> `container:listFiles`
- `tool_search_container_text` -> `container:searchText`
- `tool_apply_container_patch` -> `container:writeTextFile` / `container:replaceExactText`

注意：

- 新 operation 的返回结构按节点风格重做，不再兼容旧 workflow 的 `ok/errorCode/message` 契约
- `tool_apply_container_patch` 的 mode-based 接口已拆成两个 operation
- 旧 workflow 更像上层 tool 封装；节点内置后，建议直接在工作流里调用社区节点原生操作

## 连接方式

`Docker API` 凭证当前支持：

- `Unix Socket`
- `TCP`
- `TLS`
- `SSH`

SSH 模式当前约束：

- 只支持 **私钥认证**
- 目标是远端 **Unix socket**，默认路径 `/var/run/docker.sock`
- 支持自定义 `SSH Port` 和 `Remote Socket Path`
- `passphrase` 字段会同时用于 TLS key 和加密 SSH 私钥

## 安全边界

Docker daemon 的写权限基本等价于宿主机高权限控制，所以这个包默认按“高风险基础设施节点”来设计。

建议默认约束：

- 本地优先用 `Unix Socket`
- 远程优先用 `SSH` 或 `TLS`
- 如果必须暴露远程 TCP，优先要求 TLS
- 生产环境优先通过 [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) 缩小 API 面
- 只读场景优先使用 `Access Mode = Read Only`

更完整的生产建议见 [自托管安全建议](./docs/self-hosted-security.md)。

## 示例工作流

仓库内置了 3 个样例工作流：

- [SSH 健康检查与资产盘点](./examples/workflows/docker-ssh-health-check-and-inventory.json)
- [Build 并部署容器](./examples/workflows/docker-build-and-deploy.json)
- [事件触发后抓取日志](./examples/workflows/docker-trigger-log-capture.json)

导入前通常需要你自己替换：

- 社区节点 credential 名称
- `Read Binary File` 的本地路径
- 目标镜像名、容器名、网络和 volume 参数

## 凭证与执行策略

`Docker API` 凭证默认行为：

- `API Version = auto` 时会自动协商 Docker Engine API version
- `Access Mode = Read Only` 仅允许只读资源操作和事件/日志读取
- `Access Mode = Full Control` 才允许 create/update/remove/pull/tag/build/import/file copy，以及 `writeTextFile` / `replaceExactText` 这类写操作
- 由于 n8n 的静态 credential test 不适合 Unix socket 和 SSH stream-local forwarding，这个包统一使用 **node-level credential test**

## 文档导航

- [架构设计](./docs/architecture.md)
- [阶段路线图](./docs/roadmap.md)
- [能力矩阵](./docs/operations-matrix.md)
- [自托管安全建议](./docs/self-hosted-security.md)
- [npm 发布指南](./docs/publishing.md)

## 本地开发

安装依赖并跑基础检查：

```bash
pnpm install
pnpm lint
pnpm test
```

如果你要补跑真实 Docker daemon 集成：

```bash
RUN_DOCKER_INTEGRATION=1 node --test tests/docker.integration.test.cjs
```

如需把这个包接到本地 n8n 做联调：

```bash
pnpm dev
```

只构建产物：

```bash
pnpm build
```

如果你想在本机临时拉起一个 SSH 测试目标并跑可选的 SSH 集成测试：

```bash
pnpm test:ssh:local
```

这个脚本会：

- 用当前用户启动一个只监听 `127.0.0.1` 的临时 `sshd`
- 生成一次性密钥
- 把本机 Docker Unix socket 通过 SSH stream-local forwarding 暴露给测试
- 只覆盖 SSH 集成分支，不会顺带启用普通 Docker 集成分支

如果你已经有现成的 SSH Docker 测试目标，也可以直接手动设置环境变量：

```bash
RUN_DOCKER_SSH_INTEGRATION=1 \
DOCKER_SSH_HOST=127.0.0.1 \
DOCKER_SSH_PORT=2222 \
DOCKER_SSH_USERNAME=docker \
DOCKER_SSH_PRIVATE_KEY_PATH=/path/to/id_rsa \
DOCKER_SSH_REMOTE_SOCKET_PATH=/var/run/docker.sock \
pnpm test
```

上面这条命令会执行基础测试套件并启用 SSH 集成分支；如果你希望 `tests/docker.integration.test.cjs` 里的普通 Docker 集成和 SSH 集成都不出现 skip，可以直接同时带上两个开关：

```bash
RUN_DOCKER_INTEGRATION=1 \
RUN_DOCKER_SSH_INTEGRATION=1 \
DOCKER_SSH_HOST=127.0.0.1 \
DOCKER_SSH_PORT=2222 \
DOCKER_SSH_USERNAME=docker \
DOCKER_SSH_PRIVATE_KEY_PATH=/path/to/id_rsa \
DOCKER_SSH_REMOTE_SOCKET_PATH=/var/run/docker.sock \
node --test tests/docker.integration.test.cjs
```

默认测试不会要求本机存在 SSH Docker 测试目标。`pnpm test:ssh:local` 依赖本机存在 `sshd`、`ssh`、`ssh-keygen` 和可用的 Docker daemon，并要求 `DOCKER_SSH_USERNAME` 与当前本机用户一致。

## 仓库结构

```text
n8n-nodes-docker/
├── credentials/
│   └── DockerApi.credentials.ts
├── docs/
│   ├── architecture.md
│   ├── operations-matrix.md
│   ├── publishing.md
│   ├── roadmap.md
│   └── self-hosted-security.md
├── examples/
│   └── workflows/
├── nodes/
│   ├── Docker/
│   ├── DockerBuild/
│   ├── DockerFiles/
│   └── DockerTrigger/
├── tests/
└── package.json
```

## 发布提示

- npm 包名当前为 `@faithleysath/n8n-nodes-docker`
- 发布前确认 `package.json > homepage` 和 `package.json > repository.url`
- 如果要在本机手动校验 npm 身份或执行手工发布，再运行 `npm login` / `npm whoami`
