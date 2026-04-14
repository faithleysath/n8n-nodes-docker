#!/usr/bin/env bash

set -euo pipefail

require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing required command: $1" >&2
		exit 1
	fi
}

pick_listen_port() {
	node <<'NODE'
const net = require('node:net');

const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
	const address = server.address();

	if (address == null || typeof address === 'string') {
		process.exitCode = 1;
		server.close();
		return;
	}

	console.log(address.port);
	server.close();
});
NODE
}

resolve_socket_path() {
	local socket_path="$1"

	node -e "const fs = require('node:fs'); try { console.log(fs.realpathSync(process.argv[1])); } catch { console.log(process.argv[1]); }" "$socket_path"
}

require_command docker
require_command node
require_command ssh
require_command ssh-keygen
require_command sshd

DOCKER_BIN="$(command -v docker)"
NODE_BIN="$(command -v node)"
SSH_BIN="$(command -v ssh)"
SSH_KEYGEN_BIN="$(command -v ssh-keygen)"
SSHD_BIN="$(command -v sshd)"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURRENT_USER="$(id -un)"
DOCKER_SOCKET_PATH="${DOCKER_SOCKET_PATH:-/var/run/docker.sock}"
DOCKER_SSH_REMOTE_SOCKET_PATH="${DOCKER_SSH_REMOTE_SOCKET_PATH:-$(resolve_socket_path "$DOCKER_SOCKET_PATH")}"
TMPDIR_TEST="$(mktemp -d)"
SSHD_PORT="$(pick_listen_port)"
SSHD_PID=""

if [ "${DOCKER_SSH_USERNAME:-$CURRENT_USER}" != "$CURRENT_USER" ]; then
	echo "DOCKER_SSH_USERNAME must match the current user when using the local SSH integration helper." >&2
	exit 1
fi

cleanup() {
	if [ -n "$SSHD_PID" ]; then
		kill "$SSHD_PID" >/dev/null 2>&1 || true
		wait "$SSHD_PID" >/dev/null 2>&1 || true
	fi

	rm -rf "$TMPDIR_TEST"
}

trap cleanup EXIT

"$DOCKER_BIN" version >/dev/null

"$SSH_KEYGEN_BIN" -t ed25519 -N '' -f "$TMPDIR_TEST/id_ed25519" >/dev/null
"$SSH_KEYGEN_BIN" -t ed25519 -N '' -f "$TMPDIR_TEST/ssh_host_ed25519_key" >/dev/null
cp "$TMPDIR_TEST/id_ed25519.pub" "$TMPDIR_TEST/authorized_keys"
chmod 600 "$TMPDIR_TEST/authorized_keys"

cat >"$TMPDIR_TEST/sshd_config" <<EOF
Port $SSHD_PORT
ListenAddress 127.0.0.1
HostKey $TMPDIR_TEST/ssh_host_ed25519_key
AuthorizedKeysFile $TMPDIR_TEST/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers $CURRENT_USER
AllowStreamLocalForwarding yes
AllowTcpForwarding yes
StrictModes no
LogLevel ERROR
EOF

echo "Starting temporary sshd on 127.0.0.1:$SSHD_PORT"
echo "Using Docker socket path: $DOCKER_SSH_REMOTE_SOCKET_PATH"

"$SSHD_BIN" -D -f "$TMPDIR_TEST/sshd_config" -E "$TMPDIR_TEST/sshd.log" &
SSHD_PID="$!"

READY=0
for _ in $(seq 1 20); do
	if "$SSH_BIN" \
		-o StrictHostKeyChecking=no \
		-o UserKnownHostsFile=/dev/null \
		-o BatchMode=yes \
		-o ConnectTimeout=2 \
		-i "$TMPDIR_TEST/id_ed25519" \
		-p "$SSHD_PORT" \
		"$CURRENT_USER@127.0.0.1" \
		true >/dev/null 2>&1; then
		READY=1
		break
	fi

	sleep 1
done

if [ "$READY" -ne 1 ]; then
	echo "Temporary sshd failed to become ready." >&2
	cat "$TMPDIR_TEST/sshd.log" >&2 || true
	exit 1
fi

cd "$PROJECT_ROOT"

RUN_DOCKER_SSH_INTEGRATION=1 \
DOCKER_SSH_HOST=127.0.0.1 \
DOCKER_SSH_PORT="$SSHD_PORT" \
DOCKER_SSH_USERNAME="$CURRENT_USER" \
DOCKER_SSH_PRIVATE_KEY_PATH="$TMPDIR_TEST/id_ed25519" \
DOCKER_SSH_REMOTE_SOCKET_PATH="$DOCKER_SSH_REMOTE_SOCKET_PATH" \
"$NODE_BIN" --test tests/docker.integration.test.cjs
