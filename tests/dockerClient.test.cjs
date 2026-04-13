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
const {
	parseDockerLogStream,
	parseDockerRawStream,
} = require('../dist/nodes/Docker/transport/dockerLogs.js');

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
	assert.equal(parsed.streamText.stdout, 'hello from stdout\n');
	assert.equal(parsed.streamText.stderr, 'oops from stderr\n');
	assert.deepEqual(parsed.entries, [
		{ stream: 'stdout', message: 'hello from stdout' },
		{ stream: 'stderr', message: 'oops from stderr' },
	]);
});

test('parseDockerRawStream falls back to plain stdout text for tty-style output', () => {
	const parsed = parseDockerRawStream(Buffer.from('plain tty output'));

	assert.equal(parsed.multiplexed, false);
	assert.equal(parsed.streamText.stdout, 'plain tty output');
	assert.equal(parsed.streamText.stderr, '');
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

test('DockerApiClient supports Phase 2 container and archive endpoints', async () => {
	const requests = [];
	const archiveStat = {
		linkTarget: '',
		mode: 420,
		mtime: '2026-04-13T00:00:00Z',
		name: 'report.txt',
		size: 5,
	};
	const archiveStatHeader = Buffer.from(JSON.stringify(archiveStat)).toString('base64');
	const execOutput = Buffer.concat([
		createRawStreamFrame(1, 'stdout line\n'),
		createRawStreamFrame(2, 'stderr line\n'),
	]);
	const server = http.createServer((request, response) => {
		const chunks = [];

		request.on('data', (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});

		request.on('end', () => {
			const body = Buffer.concat(chunks);
			requests.push({
				body,
				headers: request.headers,
				method: request.method,
				url: request.url,
			});

			if (request.method === 'POST' && request.url === '/v1.51/containers/create?name=demo') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ Id: 'container-created', Warnings: ['platform warning'] }));
				return;
			}

			if (request.method === 'POST' && request.url === '/v1.51/containers/demo/update') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ Warnings: [] }));
				return;
			}

			if (request.method === 'GET' && request.url === '/v1.51/containers/demo/top?ps_args=aux') {
				response.setHeader('content-type', 'application/json');
				response.end(
					JSON.stringify({
						Processes: [['1', 'sleep 10']],
						Titles: ['PID', 'CMD'],
					}),
				);
				return;
			}

			if (
				request.method === 'GET' &&
				request.url === '/v1.51/containers/demo/stats?one-shot=1&stream=0'
			) {
				response.setHeader('content-type', 'application/json');
				response.end(
					JSON.stringify({
						cpu_stats: {
							cpu_usage: {
								total_usage: 400,
							},
							online_cpus: 2,
							system_cpu_usage: 1000,
						},
						memory_stats: {
							limit: 4096,
							stats: { cache: 128 },
							usage: 1024,
						},
						precpu_stats: {
							cpu_usage: {
								total_usage: 100,
							},
							system_cpu_usage: 400,
						},
					}),
				);
				return;
			}

			if (
				request.method === 'POST' &&
				request.url === '/v1.51/containers/demo/wait?condition=removed'
			) {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ StatusCode: 0 }));
				return;
			}

			if (request.method === 'POST' && request.url === '/v1.51/containers/demo/exec') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ Id: 'exec-1' }));
				return;
			}

			if (request.method === 'POST' && request.url === '/v1.51/exec/exec-1/start') {
				response.setHeader('content-type', 'application/vnd.docker.raw-stream');
				response.end(execOutput);
				return;
			}

			if (request.method === 'GET' && request.url === '/v1.51/exec/exec-1/json') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ ExitCode: 0, ID: 'exec-1', Running: false }));
				return;
			}

			if (request.method === 'HEAD' && request.url === '/v1.51/containers/demo/archive?path=%2Ftmp') {
				response.setHeader('x-docker-container-path-stat', archiveStatHeader);
				response.end();
				return;
			}

			if (request.method === 'GET' && request.url === '/v1.51/containers/demo/archive?path=%2Ftmp') {
				response.setHeader('content-type', 'application/x-tar');
				response.end(Buffer.from('archive-binary'));
				return;
			}

			if (
				request.method === 'PUT' &&
				request.url ===
					'/v1.51/containers/demo/archive?copyUIDGID=1&noOverwriteDirNonDir=1&path=%2Ftmp'
			) {
				response.statusCode = 200;
				response.end();
				return;
			}

			if (request.method === 'GET' && request.url === '/v1.51/containers/demo/export') {
				response.setHeader('content-type', 'application/octet-stream');
				response.end(Buffer.from('export-binary'));
				return;
			}

			response.statusCode = 404;
			response.end(JSON.stringify({ message: 'not found' }));
		});
	});

	try {
		await listen(server, undefined, '127.0.0.1');

		const address = server.address();
		assert.notEqual(address, null);
		assert.equal(typeof address, 'object');

		const client = new DockerApiClient({
			apiVersion: '1.51',
			connectionMode: 'tcp',
			host: '127.0.0.1',
			port: address.port,
		});

		const created = await client.createContainer({
			body: { Image: 'alpine' },
			name: 'demo',
		});
		const updated = await client.updateContainer('demo', { CpuShares: 512 });
		const top = await client.topContainer('demo', { psArgs: 'aux' });
		const stats = await client.getContainerStats('demo', { oneShot: true });
		const waited = await client.waitForContainer('demo', { condition: 'removed' });
		const execCreated = await client.createContainerExec('demo', {
			AttachStderr: true,
			AttachStdout: true,
			Cmd: ['sh', '-c', 'echo hello'],
		});
		const execStarted = await client.startContainerExec('exec-1', { Detach: false, Tty: false });
		const execInspected = await client.inspectContainerExec('exec-1');
		const archiveInfo = await client.getContainerArchiveInfo('demo', { path: '/tmp' });
		const archive = await client.getContainerArchive('demo', { path: '/tmp' });
		const copied = await client.putContainerArchive('demo', {
			body: Buffer.from('archive-upload'),
			copyUidGid: true,
			noOverwriteDirNonDir: true,
			path: '/tmp',
		});
		const exported = await client.exportContainer('demo');

		assert.deepEqual(created, { Id: 'container-created', Warnings: ['platform warning'] });
		assert.deepEqual(updated, { Warnings: [] });
		assert.deepEqual(top, { Processes: [['1', 'sleep 10']], Titles: ['PID', 'CMD'] });
		assert.equal(stats.cpu_stats.online_cpus, 2);
		assert.equal(waited.StatusCode, 0);
		assert.deepEqual(execCreated, { Id: 'exec-1' });
		assert.equal(execStarted.body.toString('utf8').includes('stdout line'), true);
		assert.deepEqual(execInspected, { ExitCode: 0, ID: 'exec-1', Running: false });
		assert.equal(
			archiveInfo.headers['x-docker-container-path-stat'],
			archiveStatHeader,
		);
		assert.equal(archive.body.toString('utf8'), 'archive-binary');
		assert.deepEqual(copied, { changed: true, statusCode: 200 });
		assert.equal(exported.body.toString('utf8'), 'export-binary');

		const createRequest = requests.find(({ method, url }) => method === 'POST' && url === '/v1.51/containers/create?name=demo');
		assert.deepEqual(JSON.parse(createRequest.body.toString('utf8')), { Image: 'alpine' });

		const updateRequest = requests.find(({ method, url }) => method === 'POST' && url === '/v1.51/containers/demo/update');
		assert.deepEqual(JSON.parse(updateRequest.body.toString('utf8')), { CpuShares: 512 });

		const putArchiveRequest = requests.find(({ method, url }) =>
			method === 'PUT' &&
			url === '/v1.51/containers/demo/archive?copyUIDGID=1&noOverwriteDirNonDir=1&path=%2Ftmp',
		);
		assert.equal(putArchiveRequest.headers['content-type'], 'application/x-tar');
		assert.equal(putArchiveRequest.body.toString('utf8'), 'archive-upload');
	} finally {
		server.closeAllConnections();
		server.close();
	}
});
