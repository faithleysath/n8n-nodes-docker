## 0.3.1 - 2026-04-13

- Expanded the `Docker` node to Phase 2 non-binary container operations: `create`, `update`, `wait`, `stats`, `top`, and `exec`
- Kept the main `Docker` node AI-usable while adding exec allow/deny list guardrails and richer continue-on-fail output
- Added a separate `Docker Files` node for binary and tar workflows: `copyTo`, `copyFrom`, and `export`
- Extended the custom Docker transport layer with `PUT`, `HEAD`, archive metadata handling, exec lifecycle requests, and additional container endpoints
- Added tar/binary utility helpers, new unit tests, and optional Docker integration tests for Phase 2 workflows
- Updated README, architecture docs, roadmap, and operations matrix to reflect the new node split and Phase 2 capabilities

## 0.2.0 - 2026-04-13

- Implemented the Phase 1 Docker MVP for the `Docker` node
- Added working container operations: `list`, `inspect`, `logs`, `start`, `stop`, `restart`, and `remove`
- Added working system operations: `ping`, `info`, and `version`
- Added a custom Docker transport layer for Unix socket, TCP, and TLS connections with API version negotiation
- Added access mode guardrails so write operations require `Full Control`
- Added automated tests for transport behavior and Docker log stream parsing
- Updated README and CI to reflect the Phase 1 workflow and pnpm-based setup
