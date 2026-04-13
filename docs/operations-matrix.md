# 能力矩阵

这张表用来回答一个最实际的问题：每一阶段到底会落哪些能力。

## 节点矩阵

| 节点 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 |
| --- | --- | --- | --- | --- | --- | --- |
| Docker | MVP | AI-usable container 深化 | 完整核心资源 | 流式增强 | 与 Build 联动 | 成熟化 |
| Docker Files | - | 首发（二进制 container 文件） | 扩展到 image save/load | 扩展 | 与 Build 联动 | 成熟化 |
| Docker Trigger | - | - | 规划 | 首发 | 强化 | 成熟化 |
| Docker Build | - | - | 规划 | 规划 | 首发 | 成熟化 |
| Docker Registry | - | - | - | - | 可选 | 可选 |

## 资源矩阵

| 资源 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 |
| --- | --- | --- | --- | --- | --- | --- |
| container | 基础 | 深化 | 完整 | 流式增强 | 与 build 联动 | 成熟化 |
| image | - | - | 首发 | 增强 | import/export | 成熟化 |
| network | - | - | 首发 | 增强 | - | 成熟化 |
| volume | - | - | 首发 | 增强 | - | 成熟化 |
| system | 基础 | 增强 | 深化 | events | build 联动 | 成熟化 |

## 操作矩阵

### Container

| 操作 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 |
| --- | --- | --- | --- | --- | --- | --- |
| list | Yes | Yes | Yes | Yes | Yes | Yes |
| inspect | Yes | Yes | Yes | Yes | Yes | Yes |
| start | Yes | Yes | Yes | Yes | Yes | Yes |
| stop | Yes | Yes | Yes | Yes | Yes | Yes |
| restart | Yes | Yes | Yes | Yes | Yes | Yes |
| remove | Yes | Yes | Yes | Yes | Yes | Yes |
| logs | Yes | Yes | Yes | Stream modes | Yes | Yes |
| create | - | Yes | Yes | Yes | Yes | Yes |
| update | - | Yes | Yes | Yes | Yes | Yes |
| wait | - | Yes | Yes | Yes | Yes | Yes |
| stats | - | Yes | Yes | Yes | Yes | Yes |
| top | - | Yes | Yes | Yes | Yes | Yes |
| exec | - | Yes | Yes | Stream enhancements | Yes | Yes |
| copyTo | - | Yes | Yes | Yes | Yes | Yes |
| copyFrom | - | Yes | Yes | Yes | Yes | Yes |
| export | - | Yes | Yes | Yes | Yes | Yes |

### Image

| 操作 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 |
| --- | --- | --- | --- | --- | --- | --- |
| list | - | - | Yes | Yes | Yes | Yes |
| inspect | - | - | Yes | Yes | Yes | Yes |
| pull | - | - | Yes | Yes | Yes | Yes |
| tag | - | - | Yes | Yes | Yes | Yes |
| remove | - | - | Yes | Yes | Yes | Yes |
| history | - | - | Yes | Yes | Yes | Yes |
| save | - | - | Yes | Yes | Yes | Yes |
| load | - | - | Yes | Yes | Yes | Yes |
| prune | - | - | Yes | Yes | Yes | Yes |
| build | - | - | - | - | Yes | Yes |
| import | - | - | - | - | Yes | Yes |

### Network

| 操作 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 |
| --- | --- | --- | --- | --- | --- | --- |
| list | - | - | Yes | Yes | Yes | Yes |
| inspect | - | - | Yes | Yes | Yes | Yes |
| create | - | - | Yes | Yes | Yes | Yes |
| connect | - | - | Yes | Yes | Yes | Yes |
| disconnect | - | - | Yes | Yes | Yes | Yes |
| delete | - | - | Yes | Yes | Yes | Yes |
| prune | - | - | Yes | Yes | Yes | Yes |

### Volume

| 操作 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 |
| --- | --- | --- | --- | --- | --- | --- |
| list | - | - | Yes | Yes | Yes | Yes |
| inspect | - | - | Yes | Yes | Yes | Yes |
| create | - | - | Yes | Yes | Yes | Yes |
| delete | - | - | Yes | Yes | Yes | Yes |
| prune | - | - | Yes | Yes | Yes | Yes |

### System / Events

| 操作 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 |
| --- | --- | --- | --- | --- | --- | --- |
| ping | Yes | Yes | Yes | Yes | Yes | Yes |
| info | Yes | Yes | Yes | Yes | Yes | Yes |
| version | Yes | Yes | Yes | Yes | Yes | Yes |
| df | - | - | Yes | Yes | Yes | Yes |
| events (action node) | - | - | Yes | Stream improvements | Yes | Yes |
| events (trigger node) | - | - | - | Yes | Yes | Yes |

## 连接模式矩阵

| 连接模式 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 |
| --- | --- | --- | --- | --- | --- | --- |
| Unix Socket | Yes | Yes | Yes | Yes | Yes | Yes |
| TCP | Optional | Yes | Yes | Yes | Yes | Yes |
| TLS | - | Optional | Yes | Yes | Yes | Yes |
| SSH | - | Optional | Optional | Yes | Yes | Yes |

## 建议发版映射

| 版本段 | 对应阶段 | 含义 |
| --- | --- | --- |
| 0.1.x | Scaffold | 包结构、文档、占位节点 |
| 0.2.x | Phase 1 | 可用的 container MVP |
| 0.3.x | Phase 2 | 完整 container deepening |
| 0.4.x | Phase 3 | image/network/volume/system |
| 0.5.x | Phase 4 | Docker Trigger 与高级流处理 |
| 0.6.x | Phase 5 | Build 与 import/export |
| 1.0.0 | Phase 6 | 完整产品形态 |
