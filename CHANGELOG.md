## 0.2.0 - 2026-04-13

- Implemented the Phase 1 Docker MVP for the `Docker` node
- Added working container operations: `list`, `inspect`, `logs`, `start`, `stop`, `restart`, and `remove`
- Added working system operations: `ping`, `info`, and `version`
- Added a custom Docker transport layer for Unix socket, TCP, and TLS connections with API version negotiation
- Added access mode guardrails so write operations require `Full Control`
- Added automated tests for transport behavior and Docker log stream parsing
- Updated README and CI to reflect the Phase 1 workflow and pnpm-based setup
