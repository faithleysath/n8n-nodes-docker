## 1.0.1 - 2026-04-14

- Added Linux container text helper operations on the main `Docker` node: `container:listFiles`, `readTextFile`, `searchText`, `writeTextFile`, and `replaceExactText`
- Fixed `container:searchText` so `Limit` is enforced in the helper layer instead of only trimming parsed results after a full scan
- Fixed `container:listFiles` hidden-path handling so an explicitly selected hidden `Working Path` still traverses visible descendants while continuing to filter hidden children when `Include Hidden = false`
- Fixed `container:readTextFile` and `replaceExactText` to reject invalid UTF-8 text instead of silently lossy-decoding file contents
- Added regression and integration coverage for helper-side search limits, hidden working roots, CRLF-preserving text replacement, and invalid UTF-8 error handling
- Updated README, architecture docs, and operations matrix to document the new helper operations and their Linux-only execution boundaries

## 1.0.0 - 2026-04-14

- Added SSH transport support for Docker-over-remote-Unix-socket workflows with key-based authentication, SSH port and remote socket path settings, private key validation, and shared credential testing across all four nodes
- Added explicit Docker client shutdown handling so action nodes, build/import workflows, and Docker Trigger close SSH-backed streams and sessions cleanly during normal completion, cancellation, and manual shutdown
- Fixed SSH connection startup cancellation so closing a node or aborting a request no longer waits for the SSH ready timeout before unwinding
- Added Phase 6 regression coverage for SSH transport defaults and overrides, SSH validation errors, SSH connection retries, SSH-backed long-lived stream teardown, and node-level client cleanup
- Added self-hosted security guidance plus example workflows for SSH inventory checks, build-and-deploy pipelines, and trigger-driven log capture
- Updated README, roadmap, architecture docs, security/publishing docs, operations matrix, and package metadata for the `1.0.0` Phase 6 core release surface

## 0.6.2 - 2026-04-14

- Fixed long-lived Docker event and log streams so they no longer inherit the default request idle timeout, leaving trigger reconnects and follow durations under node-level control
- Fixed Docker event cursor deduplication for mixed `time` and `timeNano` payloads by comparing a unified cursor value and clearing stale nanosecond state after newer seconds-only events
- Fixed TCP connection validation so stale TLS certificate fields no longer block plain TCP credentials, while TLS still requires client certificate and private key pairs
- Added regression coverage for disabled stream idle timeouts, mixed-precision event replay deduplication, and TCP/TLS credential validation boundaries

## 0.6.1 - 2026-04-14

- Fixed TCP/TLS connection handling so only omitted ports fall back to Docker defaults, and transient validation or API negotiation failures can retry cleanly
- Fixed Docker event cursor deduplication to compare `timeNano`/`time` before recent keys, preventing duplicate replays while keeping cursor state bounded after high-volume same-second events
- Fixed `Docker Files` `copyFrom` single-file extraction to fall back to tar output when the archive contains multiple entries or non-file entries
- Fixed `Docker Trigger` manual shutdown and stream abort handling so pending manual executions reject cleanly and unexpected `ECONNRESET` stream failures surface instead of being swallowed
- Added regression coverage for connection retries, stream abort behavior, trigger shutdown, tar extraction fallbacks, and event replay deduplication

## 0.6.0 - 2026-04-13

- Added a dedicated `Docker Build` node for tar-based `build` and `import` workflows with aggregate or split streamed output modes
- Extended the custom Docker transport with streamed `POST /build` and `POST /images/create?fromSrc=-` support, request-level timeout overrides, and registry auth/config header helpers
- Added shared build/import JSON-line normalization utilities that extract BuildKit aux metadata, preserve raw lines, and keep continue-on-fail behavior consistent
- Added Phase 5 unit and optional integration coverage for build/import transport, node execution, timeout handling, metadata exposure, and real-daemon streaming behavior
- Updated package metadata, README, architecture docs, roadmap, and operations matrix for the `0.6.x` Phase 5 release surface

## 0.5.0 - 2026-04-13

- Added a dedicated `Docker Trigger` node with Docker event filters, stored cursor replay, duplicate suppression, manual trigger support, and reconnect backoff
- Extended the main `Docker` node with `container:logs` snapshot/follow modes plus aggregate/split output, and `system:events` bounded/resume-from-cursor read modes
- Added streaming transport helpers for Docker events and logs, plus incremental JSON-line decoding for long-lived event streams
- Expanded automated coverage across trigger behavior, cursor updates, reconnect handling, split log/event outputs, and optional Phase 4 integration scenarios
- Updated package metadata, README, architecture docs, roadmap, and operations matrix for the `0.5.x` Phase 4 release surface

## 0.4.1 - 2026-04-13

- Completed the Phase 3 Docker resource surface on the main `Docker` node with `image`, `network`, `volume`, and expanded `system` operations
- Added `image:list`, `inspect`, `pull`, `tag`, `remove`, `history`, and `prune`, plus bounded `system:df` and `system:events` reads
- Added `network:list`, `inspect`, `create`, `connect`, `disconnect`, `delete`, and `prune`, plus `volume:list`, `inspect`, `create`, `delete`, and `prune`
- Extended `Docker Files` with binary image archive workflows: `image:save` and `image:load`
- Extended the custom Docker transport with repeated query parameter support, JSON-line parsing, and Phase 3 image/network/volume/system endpoints
- Added named volume mounts to `container:create`, expanded automated tests for Phase 3 behavior, and updated README, architecture docs, roadmap, and operations matrix

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
