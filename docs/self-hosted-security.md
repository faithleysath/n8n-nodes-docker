# 自托管安全建议

这个包默认面向 **n8n 自托管实例**。无论使用哪种连接模式，Docker daemon 的写权限都接近宿主机高权限控制，所以建议把它当成基础设施入口来设计和审计。

## 连接模式建议

优先级建议：

1. 同机部署优先 `Unix Socket`
2. 跨机部署优先 `SSH`
3. 明确证书体系时使用 `TLS`
4. 尽量避免裸 `TCP`

`TCP` 如果没有 TLS，等同于把高权限 Docker API 暴露在网络上。

## SSH 模式建议

当前版本的 SSH 连接是：

- 私钥认证
- 远端 Unix socket 转发
- 默认远端 socket 为 `/var/run/docker.sock`

建议：

- 为 n8n 专门创建一个 SSH 用户，不与日常 shell 账户混用
- 私钥只授予 n8n 运行用户可读权限，例如 `chmod 600`
- 优先给这个 SSH 用户只开放 Docker 相关访问，不开放额外 sudo 能力
- 如果远端 Docker socket 不是默认路径，显式配置 `Remote Socket Path`
- 对多台 daemon 分开建 credentials，不要在一个凭证里复用拓扑

## TLS 模式建议

- 只在受控网络中暴露 `2376`
- 使用独立的 CA / client cert / client key
- `Ignore TLS Issues` 只用于临时排错，不要在生产凭证里常开

## Unix Socket 模式建议

- 不要直接把宿主机 Docker socket 暴露给低信任工作流
- 如果需要限制 API 面，优先在宿主机前加 `docker-socket-proxy`
- 把 n8n 的危险写操作工作流与只读观察类工作流分开

## Access Mode 建议

这个包里的 `Access Mode` 不是系统级隔离，只是节点内的执行门禁。

建议：

- 盘点、监控、事件采集、日志抓取使用 `Read Only`
- 构建、部署、清理、文件写入类工作流才使用 `Full Control`
- 不要把 `Full Control` 凭证复用到所有工作流

## 最小权限模板

推荐的生产组合：

- 观测类工作流：`SSH` 或 `Unix Socket` + `Read Only`
- 触发类工作流：单独的 `Docker Trigger` 凭证，优先 `SSH`/`Unix Socket` + `Read Only`
- 交付类工作流：单独的 `SSH` 或 `TLS` 凭证 + `Full Control`
- 构建类工作流：单独的 `Docker Build` 凭证 + `Full Control`
- 宿主机前加 `docker-socket-proxy`，只放开确实需要的 API

## 审计与运维

- 给所有发布类工作流打标签，便于审计哪些工作流持有 `Full Control`
- 定期轮换 SSH 私钥和 TLS client cert
- 对 Docker Trigger 工作流单独监控失败重连和异常关闭
- 把 build/import 这类大流量操作和普通只读查询拆开，避免混跑
