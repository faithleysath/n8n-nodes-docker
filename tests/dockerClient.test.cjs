const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
	DockerApiClient,
	normalizeDockerApiVersion,
} = require('../dist/nodes/Docker/transport/dockerClient.js');
const { parseDockerLogStream } = require('../dist/nodes/Docker/transport/dockerLogs.js');

function createRawStreamFrame(streamType, payload) {
	const payloadBuffer = Buffer.from(payload, 'utf8');
	const header = Buffer.alloc(8);

	header[0] = streamType;
	header.writeUInt32BE(payloadBuffer.length, 4);

	return Buffer.concat([header, payloadBuffer]);
}

async function listen(server, socketPath, host) {
	server.listen(socketPath ?? 0, host);
	await once(server, 'listening');
}

test('normalizeDockerApiVersion accepts auto and strips v prefix', () => {
	assert.equal(normalizeDockerApiVersion(undefined), 'auto');
	assert.equal(normalizeDockerApiVersion('auto'), 'auto');
	assert.equal(normalizeDockerApiVersion('v1.51'), '1.51');
	assert.equal(normalizeDockerApiVersion('1.24'), '1.24');
	assert.throws(() => normalizeDockerApiVersion('latest'), /Invalid Docker API version/);
});

test('parseDockerLogStream decodes Docker raw-stream frames', () => {
	const rawBuffer = Buffer.concat([
		createRawStreamFrame(1, 'hello from stdout\n'),
		createRawStreamFrame(2, 'oops from stderr\n'),
	]);

	const parsed = parseDockerLogStream(rawBuffer, 'application/vnd.docker.raw-stream');

	assert.equal(parsed.multiplexed, true);
	assert.equal(parsed.text, 'hello from stdout\noops from stderr\n');
	assert.deepEqual(parsed.entries, [
		{ stream: 'stdout', message: 'hello from stdout' },
		{ stream: 'stderr', message: 'oops from stderr' },
	]);
});

test('DockerApiClient negotiates API version over a Unix socket', async () => {
	const requests = [];
	const socketDir = mkdtempSync(join(tmpdir(), 'docker-client-socket-'));
	const socketPath = join(socketDir, 'docker.sock');
	const server = http.createServer((request, response) => {
		requests.push(request.url);

		if (request.url === '/_ping') {
			response.setHeader('api-version', '1.51');
			response.end('OK');
			return;
		}

		if (request.url === '/version') {
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ ApiVersion: '1.51' }));
			return;
		}

		if (request.url === '/v1.51/containers/json?all=1') {
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify([{ Id: 'container-1', State: 'running' }]));
			return;
		}

		response.statusCode = 404;
		response.end(JSON.stringify({ message: 'not found' }));
	});

	try {
		await listen(server, socketPath);

		const client = new DockerApiClient({
			apiVersion: 'auto',
			connectionMode: 'unixSocket',
			socketPath,
		});
		const ping = await client.ping();
		const containers = await client.listContainers({ all: true });

		assert.equal(ping.ok, true);
		assert.deepEqual(containers, [{ Id: 'container-1', State: 'running' }]);
		assert.deepEqual(requests, ['/_ping', '/version', '/v1.51/containers/json?all=1']);
	} finally {
		server.closeAllConnections();
		server.close();
		rmSync(socketDir, { force: true, recursive: true });
	}
});

test('DockerApiClient respects explicit API versions for TCP connections', async () => {
	const server = http.createServer((request, response) => {
		assert.equal(request.url, '/v1.41/info');
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({ ServerVersion: 'test-daemon' }));
	});

	try {
		await listen(server, undefined, '127.0.0.1');

		const address = server.address();
		assert.notEqual(address, null);
		assert.equal(typeof address, 'object');

		const client = new DockerApiClient({
			apiVersion: '1.41',
			connectionMode: 'tcp',
			host: '127.0.0.1',
			port: address.port,
		});
		const info = await client.getInfo();

		assert.deepEqual(info, { ServerVersion: 'test-daemon' });
	} finally {
		server.closeAllConnections();
		server.close();
	}
});
