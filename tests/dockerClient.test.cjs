const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { once } = require('node:events');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
	DockerApiClient,
	encodeDockerRegistryAuth,
	encodeDockerRegistryConfig,
	normalizeDockerApiVersion,
} = require('../dist/nodes/Docker/transport/dockerClient.js');
const {
	isDockerConnectionConfigurationError,
} = require('../dist/nodes/Docker/utils/credentialTest.js');
const {
	DockerJsonLinesDecoder,
	parseDockerJsonLines,
} = require('../dist/nodes/Docker/transport/dockerJsonLines.js');
const {
	collectDockerStreamResponse,
	waitForAbortableDelay,
} = require('../dist/nodes/Docker/transport/dockerStreams.js');
const {
	parseDockerLogStream,
	parseDockerRawStream,
} = require('../dist/nodes/Docker/transport/dockerLogs.js');
const {
	computeDockerReconnectDelayMs,
	getDockerEventKey,
} = require('../dist/nodes/Docker/utils/dockerEvents.js');

const TEST_SSH_PRIVATE_KEY = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: {
		format: 'pem',
		type: 'pkcs1',
	},
	publicKeyEncoding: {
		format: 'pem',
		type: 'spki',
	},
}).privateKey;

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

class FakeSshClient extends (require('node:events').EventEmitter) {
	constructor(options = {}) {
		super();
		this.options = options;
		this.connectConfigs = [];
		this.destroyCalls = 0;
		this.endCalls = 0;
		this.forwardedSocketPaths = [];
		this.noDelayCalls = [];
	}

	connect(config) {
		this.connectConfigs.push(config);
		if (this.options.onConnect !== undefined) {
			this.options.onConnect(this, config);
		} else {
			process.nextTick(() => this.emit('ready'));
		}

		return this;
	}

	openssh_forwardOutStreamLocal(socketPath, callback) {
		this.forwardedSocketPaths.push(socketPath);

		if (this.options.onForwardOut !== undefined) {
			this.options.onForwardOut(this, socketPath, callback);
			return this;
		}

		process.nextTick(() => {
			callback(new Error('No SSH forward handler configured.'), undefined);
		});
		return this;
	}

	setNoDelay(noDelay = true) {
		this.noDelayCalls.push(noDelay);
		return this;
	}

	end() {
		this.endCalls += 1;
		if (this.options.onEnd !== undefined) {
			this.options.onEnd(this);
		} else {
			process.nextTick(() => this.emit('close'));
		}

		return this;
	}

	destroy() {
		this.destroyCalls += 1;
		if (this.options.onDestroy !== undefined) {
			this.options.onDestroy(this);
		} else {
			process.nextTick(() => this.emit('close'));
		}

		return this;
	}
}

function stripHttpSocketMethods(socket) {
	socket.setKeepAlive = undefined;
	socket.setNoDelay = undefined;
	socket.setTimeout = undefined;
	socket.ref = undefined;
	socket.unref = undefined;
	return socket;
}

function connectSocketToServer(port, callback, options = {}) {
	const socket = net.connect(port, '127.0.0.1');
	let settled = false;

	const settle = (error, stream) => {
		if (settled) {
			return;
		}

		settled = true;
		socket.off('error', onError);
		callback(error, stream);
	};

	const onError = (error) => {
		settle(error);
	};

	socket.once('connect', () => {
		settle(undefined, options.stripHttpMethods ? stripHttpSocketMethods(socket) : socket);
	});
	socket.once('error', onError);
}

function createForwardOutHandler(port, options = {}) {
	return (_client, _socketPath, callback) => {
		connectSocketToServer(port, callback, options);
	};
}

test('normalizeDockerApiVersion accepts auto and strips v prefix', () => {
	assert.equal(normalizeDockerApiVersion(undefined), 'auto');
	assert.equal(normalizeDockerApiVersion('auto'), 'auto');
	assert.equal(normalizeDockerApiVersion('v1.51'), '1.51');
	assert.equal(normalizeDockerApiVersion('1.24'), '1.24');
	assert.throws(() => normalizeDockerApiVersion('latest'), /Invalid Docker API version/);
});

test('registry auth helpers encode auth payloads as base64url JSON strings', () => {
	const encodedAuth = encodeDockerRegistryAuth({
		password: 'secret',
		serveraddress: 'registry.example.com',
		username: 'janedoe',
	});
	const encodedConfig = encodeDockerRegistryConfig({
		'registry.example.com': {
			password: 'secret',
			serveraddress: 'registry.example.com',
			username: 'janedoe',
		},
	});

	assert.deepEqual(JSON.parse(Buffer.from(encodedAuth, 'base64url').toString('utf8')), {
		password: 'secret',
		serveraddress: 'registry.example.com',
		username: 'janedoe',
	});
	assert.deepEqual(JSON.parse(Buffer.from(encodedConfig, 'base64url').toString('utf8')), {
		'registry.example.com': {
			password: 'secret',
			serveraddress: 'registry.example.com',
			username: 'janedoe',
		},
	});
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

test('parseDockerJsonLines parses JSON line streams and preserves raw lines', () => {
	const parsed = parseDockerJsonLines(
		Buffer.from(
			[
				JSON.stringify({ status: 'Pulling fs layer' }),
				JSON.stringify({ Type: 'container', Action: 'start' }),
				'not-json',
				'',
			].join('\n'),
		),
		'application/json',
	);

	assert.equal(parsed.contentType, 'application/json');
	assert.deepEqual(parsed.entries, [
		{ status: 'Pulling fs layer' },
		{ Action: 'start', Type: 'container' },
	]);
	assert.deepEqual(parsed.unparsedLines, ['not-json']);
	assert.deepEqual(parsed.rawLines, [
		'{"status":"Pulling fs layer"}',
		'{"Type":"container","Action":"start"}',
		'not-json',
	]);
});

test('DockerJsonLinesDecoder preserves JSON objects across chunk boundaries', () => {
	const decoder = new DockerJsonLinesDecoder();
	const firstMessages = decoder.write(
		Buffer.from('{"Type":"container","Action":"start","time":1}\n{"Type":"cont'),
	);
	const secondMessages = decoder.write(Buffer.from('ainer","Action":"stop","time":2}\nnot-json'));
	const flushedMessages = decoder.flush();

	assert.deepEqual(
		[...firstMessages, ...secondMessages, ...flushedMessages].map((message) => message.rawLine),
		[
			'{"Type":"container","Action":"start","time":1}',
			'{"Type":"container","Action":"stop","time":2}',
			'not-json',
		],
	);
	assert.deepEqual(
		[...firstMessages, ...secondMessages, ...flushedMessages]
			.filter((message) => message.entry !== undefined)
			.map((message) => message.entry.Action),
		['start', 'stop'],
	);
});

test('docker event helpers compute dedupe keys and reconnect delays deterministically', () => {
	assert.equal(
		getDockerEventKey({
			Action: 'start',
			Actor: { ID: 'container-1' },
			Type: 'container',
			id: 'container-1',
			timeNano: 1712982000000000000,
		}),
		'1712982000000000000|container|start|container-1|container-1|',
	);
	assert.equal(computeDockerReconnectDelayMs(0, () => 0.5), 1125);
	assert.equal(computeDockerReconnectDelayMs(5, () => 0), 30000);
});

test('waitForAbortableDelay resolves immediately when the signal is aborted', async () => {
	const controller = new AbortController();

	controller.abort();

	const startedAt = Date.now();
	await waitForAbortableDelay(1_000, controller.signal);

	assert.equal(Date.now() - startedAt < 100, true);
});

test('collectDockerStreamResponse rejects unexpected ECONNRESET errors', async () => {
	const stream = new PassThrough();
	const response = {
		close() {
			stream.destroy();
		},
		headers: {},
		statusCode: 200,
		stream,
	};
	const collected = collectDockerStreamResponse(response);
	const resetError = new Error('socket hang up');

	resetError.code = 'ECONNRESET';

	stream.write('partial');
	stream.destroy(resetError);

	await assert.rejects(collected, (error) => {
		assert.equal(error, resetError);
		assert.equal(error.code, 'ECONNRESET');
		return true;
	});
});

test('collectDockerStreamResponse resolves buffered data when the local abort signal closes the stream', async () => {
	const stream = new PassThrough();
	const abortController = new AbortController();
	const response = {
		close() {
			stream.end();
		},
		headers: {},
		statusCode: 200,
		stream,
	};
	const collected = collectDockerStreamResponse(response, abortController.signal);

	stream.write('partial');
	abortController.abort();

	const buffer = await collected;

	assert.equal(buffer.toString('utf8'), 'partial');
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

test('DockerApiClient validates explicit ports, defaults omitted ports, and ignores TLS leftovers for TCP', async () => {
	const tcpClient = new DockerApiClient({
		apiVersion: '1.51',
		connectionMode: 'tcp',
		host: '127.0.0.1',
	});
	const tlsClient = new DockerApiClient({
		apiVersion: '1.51',
		connectionMode: 'tls',
		host: '127.0.0.1',
	});
	const negativePortClient = new DockerApiClient({
		apiVersion: '1.51',
		connectionMode: 'tcp',
		host: '127.0.0.1',
		port: -1,
	});
	const fractionalPortClient = new DockerApiClient({
		apiVersion: '1.51',
		connectionMode: 'tls',
		host: '127.0.0.1',
		port: 123.4,
	});
	const tcpClientWithStaleTlsFields = new DockerApiClient({
		apiVersion: '1.51',
		cert: 'stale-client-cert',
		connectionMode: 'tcp',
		host: '127.0.0.1',
	});
	const tlsClientWithMissingKey = new DockerApiClient({
		apiVersion: '1.51',
		cert: 'client-cert',
		connectionMode: 'tls',
		host: '127.0.0.1',
	});

	assert.equal(tcpClient.buildRequestOptions('GET', '/v1.51/info', { path: '/info' }).port, 2375);
	assert.equal(tlsClient.buildRequestOptions('GET', '/v1.51/info', { path: '/info' }).port, 2376);
	await assert.rejects(
		negativePortClient.validateConnectionSettings(),
		/Port must be a positive integer/,
	);
	await assert.rejects(
		fractionalPortClient.validateConnectionSettings(),
		/Port must be a positive integer/,
	);
	await tcpClientWithStaleTlsFields.validateConnectionSettings();
	await assert.rejects(
		tlsClientWithMissingKey.validateConnectionSettings(),
		/TLS client certificate and client private key must be provided together/,
	);
});

test('DockerApiClient validates SSH credentials and classifies SSH config errors', async () => {
	const missingUsernameClient = new DockerApiClient({
		apiVersion: '1.51',
		connectionMode: 'ssh',
		host: '127.0.0.1',
		privateKey: TEST_SSH_PRIVATE_KEY,
	});
	const missingPrivateKeyClient = new DockerApiClient({
		apiVersion: '1.51',
		connectionMode: 'ssh',
		host: '127.0.0.1',
		username: 'docker',
	});
	const invalidPortClient = new DockerApiClient({
		apiVersion: '1.51',
		connectionMode: 'ssh',
		host: '127.0.0.1',
		privateKey: TEST_SSH_PRIVATE_KEY,
		sshPort: 0,
		username: 'docker',
	});
	const invalidPrivateKeyClient = new DockerApiClient({
		apiVersion: '1.51',
		connectionMode: 'ssh',
		host: '127.0.0.1',
		privateKey: 'not-a-private-key',
		username: 'docker',
	});

	await assert.rejects(
		missingUsernameClient.validateConnectionSettings(),
		/Username is required for SSH mode/,
	);
	await assert.rejects(
		missingPrivateKeyClient.validateConnectionSettings(),
		/Private Key is required for SSH mode/,
	);
	await assert.rejects(
		invalidPortClient.validateConnectionSettings(),
		/SSH Port must be a positive integer/,
	);
	await assert.rejects(
		invalidPrivateKeyClient.validateConnectionSettings(),
		/Private Key is not a valid SSH private key/,
	);
	assert.equal(
		isDockerConnectionConfigurationError(
			new Error('Private Key is not a valid SSH private key: malformed key'),
		),
		true,
	);
	assert.equal(isDockerConnectionConfigurationError(new Error('socket hang up')), false);
});

test('DockerApiClient retries API negotiation after an initial failure', async () => {
	const client = new DockerApiClient({
		apiVersion: 'auto',
		connectionMode: 'tcp',
		host: '127.0.0.1',
	});
	let callCount = 0;

	client.getVersion = async () => {
		callCount += 1;

		if (callCount === 1) {
			throw new Error('transient negotiation failure');
		}

		return { ApiVersion: '1.51' };
	};

	await assert.rejects(client.resolveApiVersion(), /transient negotiation failure/);
	assert.equal(await client.resolveApiVersion(), '1.51');
	assert.equal(callCount, 2);
});

test('DockerApiClient supports SSH stream-local requests with default SSH settings', async () => {
	const requests = [];
	const sshClients = [];
	const server = http.createServer((request, response) => {
		requests.push(request.url);
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({ ServerVersion: 'ssh-daemon' }));
	});

	try {
		await listen(server, undefined, '127.0.0.1');

		const address = server.address();
		assert.notEqual(address, null);
		assert.equal(typeof address, 'object');

		const client = new DockerApiClient(
			{
				apiVersion: '1.51',
				connectionMode: 'ssh',
				host: '127.0.0.1',
				privateKey: TEST_SSH_PRIVATE_KEY,
				username: 'docker',
			},
			{
				createSshClient: () => {
					const sshClient = new FakeSshClient({
						onForwardOut: createForwardOutHandler(address.port),
					});
					sshClients.push(sshClient);
					return sshClient;
				},
			},
		);
		const info = await client.getInfo();

		await client.close();

		assert.deepEqual(info, { ServerVersion: 'ssh-daemon' });
		assert.deepEqual(requests, ['/v1.51/info']);
		assert.equal(sshClients.length, 1);
		assert.equal(sshClients[0].connectConfigs[0].port, 22);
		assert.equal(sshClients[0].connectConfigs[0].username, 'docker');
		assert.deepEqual(sshClients[0].forwardedSocketPaths, ['/var/run/docker.sock']);
		assert.deepEqual(sshClients[0].noDelayCalls, [true]);
		assert.equal(sshClients[0].endCalls, 1);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('DockerApiClient supports custom SSH ports and remote socket paths', async () => {
	const sshClients = [];
	const server = http.createServer((request, response) => {
		assert.equal(request.url, '/v1.51/info');
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({ ServerVersion: 'custom-ssh-daemon' }));
	});

	try {
		await listen(server, undefined, '127.0.0.1');

		const address = server.address();
		assert.notEqual(address, null);
		assert.equal(typeof address, 'object');

		const client = new DockerApiClient(
			{
				apiVersion: '1.51',
				connectionMode: 'ssh',
				host: '127.0.0.1',
				privateKey: TEST_SSH_PRIVATE_KEY,
				remoteSocketPath: '/run/docker.sock',
				sshPort: 2222,
				username: 'docker',
			},
			{
				createSshClient: () => {
					const sshClient = new FakeSshClient({
						onForwardOut: createForwardOutHandler(address.port),
					});
					sshClients.push(sshClient);
					return sshClient;
				},
			},
		);

		await client.getInfo();
		await client.close();

		assert.equal(sshClients[0].connectConfigs[0].port, 2222);
		assert.deepEqual(sshClients[0].forwardedSocketPaths, ['/run/docker.sock']);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('DockerApiClient decorates SSH channels that do not implement net.Socket timeout helpers', async () => {
	const server = http.createServer((request, response) => {
		assert.equal(request.url, '/v1.51/info');
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({ ServerVersion: 'ssh-compat-daemon' }));
	});

	try {
		await listen(server, undefined, '127.0.0.1');

		const address = server.address();
		assert.notEqual(address, null);
		assert.equal(typeof address, 'object');

		const client = new DockerApiClient(
			{
				apiVersion: '1.51',
				connectionMode: 'ssh',
				host: '127.0.0.1',
				privateKey: TEST_SSH_PRIVATE_KEY,
				username: 'docker',
			},
			{
				createSshClient: () =>
					new FakeSshClient({
						onForwardOut: createForwardOutHandler(address.port, {
							stripHttpMethods: true,
						}),
					}),
			},
		);

		assert.deepEqual(await client.getInfo(), { ServerVersion: 'ssh-compat-daemon' });
		await client.close();
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('DockerApiClient retries connection validation after an initial failure', async () => {
	const socketDir = mkdtempSync(join(tmpdir(), 'docker-client-validate-'));
	const socketPath = join(socketDir, 'docker.sock');
	const client = new DockerApiClient({
		apiVersion: '1.51',
		connectionMode: 'unixSocket',
		socketPath,
	});

	try {
		await assert.rejects(
			client.validateConnectionSettings(),
			(error) => error?.code === 'ENOENT',
		);

		writeFileSync(socketPath, 'placeholder');

		await client.validateConnectionSettings();
	} finally {
		rmSync(socketDir, { force: true, recursive: true });
	}
});

test('DockerApiClient retries SSH connection establishment after an initial failure', async () => {
	let factoryCalls = 0;
	const server = http.createServer((request, response) => {
		assert.equal(request.url, '/v1.51/info');
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({ ServerVersion: 'ssh-retry-daemon' }));
	});

	try {
		await listen(server, undefined, '127.0.0.1');

		const address = server.address();
		assert.notEqual(address, null);
		assert.equal(typeof address, 'object');

		const client = new DockerApiClient(
			{
				apiVersion: '1.51',
				connectionMode: 'ssh',
				host: '127.0.0.1',
				privateKey: TEST_SSH_PRIVATE_KEY,
				username: 'docker',
			},
			{
				createSshClient: () => {
					factoryCalls += 1;

					if (factoryCalls === 1) {
						return new FakeSshClient({
							onConnect: (sshClient) => {
								process.nextTick(() => {
									sshClient.emit('error', new Error('initial ssh failure'));
								});
							},
						});
					}

					return new FakeSshClient({
						onForwardOut: createForwardOutHandler(address.port),
					});
				},
			},
		);

		await assert.rejects(client.getInfo(), /initial ssh failure/);
		assert.deepEqual(await client.getInfo(), { ServerVersion: 'ssh-retry-daemon' });
		assert.equal(factoryCalls, 2);
		await client.close();
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('DockerApiClient close aborts an in-progress SSH handshake before readyTimeout elapses', async () => {
	let resolveConnectStarted;
	const connectStarted = new Promise((resolve) => {
		resolveConnectStarted = resolve;
	});
	const sshClients = [];
	const client = new DockerApiClient(
		{
			apiVersion: '1.51',
			connectionMode: 'ssh',
			host: '127.0.0.1',
			privateKey: TEST_SSH_PRIVATE_KEY,
			username: 'docker',
		},
		{
			createSshClient: () => {
				const sshClient = new FakeSshClient({
					onConnect: () => {
						resolveConnectStarted();
					},
				});
				sshClients.push(sshClient);
				return sshClient;
			},
			timeoutMs: 5_000,
		},
	);
	const infoPromise = client.getInfo();

	await connectStarted;

	const closeStartedAt = Date.now();
	await client.close();
	const closeElapsedMs = Date.now() - closeStartedAt;

	await assert.rejects(infoPromise, (error) => {
		return (
			error instanceof Error &&
			/SSH connection closed before it became ready|The operation was aborted|socket hang up/.test(
				error.message,
			)
		);
	});
	assert.equal(closeElapsedMs < 1_000, true);
	assert.equal(sshClients[0].destroyCalls, 1);
	assert.equal(sshClients[0].endCalls, 0);
});

test('DockerApiClient aborts an in-progress SSH handshake before readyTimeout elapses', async () => {
	let resolveConnectStarted;
	const connectStarted = new Promise((resolve) => {
		resolveConnectStarted = resolve;
	});
	const abortController = new AbortController();
	const sshClients = [];
	const client = new DockerApiClient(
		{
			apiVersion: '1.51',
			connectionMode: 'ssh',
			host: '127.0.0.1',
			privateKey: TEST_SSH_PRIVATE_KEY,
			username: 'docker',
		},
		{
			createSshClient: () => {
				const sshClient = new FakeSshClient({
					onConnect: () => {
						resolveConnectStarted();
					},
				});
				sshClients.push(sshClient);
				return sshClient;
			},
			timeoutMs: 5_000,
		},
	);
	const infoPromise = client.getInfo(abortController.signal);

	await connectStarted;

	const abortStartedAt = Date.now();
	abortController.abort();

	await assert.rejects(infoPromise, /The operation was aborted/);
	assert.equal(Date.now() - abortStartedAt < 1_000, true);
	assert.equal(sshClients[0].destroyCalls, 1);
	assert.equal(sshClients[0].endCalls, 0);

	await client.close();
});

test('DockerApiClient streams build and import endpoints with expected query strings and headers', async () => {
	const requests = [];
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');
		const chunks = [];

		request.on('data', (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});

		request.on('end', () => {
			requests.push({
				body: Buffer.concat(chunks),
				headers: request.headers,
				method: request.method,
				url,
			});

			if (request.method === 'POST' && url.pathname === '/v1.51/build') {
				response.setHeader('content-type', 'application/json');
				response.end(
					[
						JSON.stringify({ stream: '#1 [internal] load build definition from Dockerfile' }),
						JSON.stringify({ aux: { ID: 'sha256:build-image' } }),
						'',
					].join('\n'),
				);
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1.51/images/create') {
				response.setHeader('content-type', 'application/json');
				response.end(
					[
						JSON.stringify({ status: 'Importing image' }),
						JSON.stringify({ stream: 'Loaded image: demo/imported:stable' }),
						'',
					].join('\n'),
				);
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
		const buildResponse = await client.buildImage({
			body: Buffer.from('build-context'),
			buildArgs: { NODE_ENV: 'production' },
			dockerfile: 'docker/Dockerfile',
			forceRm: true,
			labels: { 'org.opencontainers.image.source': 'n8n' },
			networkMode: 'host',
			noCache: true,
			platform: 'linux/amd64',
			pull: true,
			quiet: true,
			registryConfig: {
				'registry.example.com': {
					password: 'secret',
					serveraddress: 'registry.example.com',
					username: 'janedoe',
				},
			},
			rm: false,
			tags: ['demo:latest', 'demo:1.0.0'],
			target: 'runtime',
			timeoutMs: 0,
			version: '2',
		});
		const buildBuffer = await collectDockerStreamResponse(buildResponse);
		const importResponse = await client.importImage({
			body: Buffer.from('image-archive'),
			changes: ['ENV DEBUG=true', 'CMD ["node"]'],
			message: 'imported from tar',
			platform: 'linux/amd64',
			repo: 'demo/imported',
			tag: 'stable',
			timeoutMs: 0,
		});
		const importBuffer = await collectDockerStreamResponse(importResponse);

		assert.equal(buildBuffer.toString('utf8').includes('sha256:build-image'), true);
		assert.equal(importBuffer.toString('utf8').includes('Loaded image: demo/imported:stable'), true);

		const buildRequest = requests.find(({ method, url }) =>
			method === 'POST' && url.pathname === '/v1.51/build',
		);
		assert.equal(buildRequest.headers['content-type'], 'application/x-tar');
		assert.equal(buildRequest.body.toString('utf8'), 'build-context');
		assert.deepEqual(buildRequest.url.searchParams.getAll('t'), ['demo:latest', 'demo:1.0.0']);
		assert.equal(buildRequest.url.searchParams.get('dockerfile'), 'docker/Dockerfile');
		assert.equal(buildRequest.url.searchParams.get('pull'), '1');
		assert.equal(buildRequest.url.searchParams.get('nocache'), '1');
		assert.equal(buildRequest.url.searchParams.get('q'), '1');
		assert.equal(buildRequest.url.searchParams.get('rm'), '0');
		assert.equal(buildRequest.url.searchParams.get('forcerm'), '1');
		assert.equal(buildRequest.url.searchParams.get('platform'), 'linux/amd64');
		assert.equal(buildRequest.url.searchParams.get('target'), 'runtime');
		assert.equal(buildRequest.url.searchParams.get('version'), '2');
		assert.deepEqual(
			JSON.parse(buildRequest.url.searchParams.get('buildargs')),
			{ NODE_ENV: 'production' },
		);
		assert.deepEqual(
			JSON.parse(buildRequest.url.searchParams.get('labels')),
			{ 'org.opencontainers.image.source': 'n8n' },
		);
		assert.deepEqual(
			JSON.parse(Buffer.from(buildRequest.headers['x-registry-config'], 'base64url').toString('utf8')),
			{
				'registry.example.com': {
					password: 'secret',
					serveraddress: 'registry.example.com',
					username: 'janedoe',
				},
			},
		);

		const importRequest = requests.find(({ method, url }) =>
			method === 'POST' && url.pathname === '/v1.51/images/create',
		);
		assert.equal(importRequest.headers['content-type'], 'application/octet-stream');
		assert.equal(importRequest.body.toString('utf8'), 'image-archive');
		assert.equal(importRequest.url.searchParams.get('fromSrc'), '-');
		assert.equal(importRequest.url.searchParams.get('repo'), 'demo/imported');
		assert.equal(importRequest.url.searchParams.get('tag'), 'stable');
		assert.equal(importRequest.url.searchParams.get('message'), 'imported from tar');
		assert.equal(importRequest.url.searchParams.get('platform'), 'linux/amd64');
		assert.deepEqual(importRequest.url.searchParams.getAll('changes'), [
			'ENV DEBUG=true',
			'CMD ["node"]',
		]);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('DockerApiClient allows request-level timeout overrides for build streams', async () => {
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');

		if (request.method === 'POST' && url.pathname === '/v1.51/build') {
			setTimeout(() => {
				response.setHeader('content-type', 'application/json');
				response.end(`${JSON.stringify({ stream: 'build complete' })}\n`);
			}, 10);
			return;
		}

		response.statusCode = 404;
		response.end(JSON.stringify({ message: 'not found' }));
	});

	try {
		await listen(server, undefined, '127.0.0.1');

		const address = server.address();
		assert.notEqual(address, null);
		assert.equal(typeof address, 'object');

		const client = new DockerApiClient(
			{
				apiVersion: '1.51',
				connectionMode: 'tcp',
				host: '127.0.0.1',
				port: address.port,
			},
			{ timeoutMs: 1 },
		);
		const response = await client.buildImage({
			body: Buffer.from('build-context'),
			timeoutMs: 50,
			version: '2',
		});
		const buffer = await collectDockerStreamResponse(response);

		assert.equal(buffer.toString('utf8').includes('build complete'), true);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('DockerApiClient disables default idle timeouts for event and log streams', async () => {
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');

		if (request.method === 'GET' && url.pathname === '/v1.51/events') {
			setTimeout(() => {
				response.setHeader('content-type', 'application/json');
				response.end(
					[
						JSON.stringify({ Action: 'start', Type: 'container' }),
						JSON.stringify({ Action: 'stop', Type: 'container' }),
						'',
					].join('\n'),
				);
			}, 10);
			return;
		}

		if (request.method === 'GET' && url.pathname === '/v1.51/containers/demo/logs') {
			setTimeout(() => {
				response.setHeader('content-type', 'application/vnd.docker.raw-stream');
				response.end(
					Buffer.concat([
						createRawStreamFrame(1, 'stdout line\n'),
						createRawStreamFrame(2, 'stderr line\n'),
					]),
				);
			}, 10);
			return;
		}

		response.statusCode = 404;
		response.end(JSON.stringify({ message: 'not found' }));
	});

	try {
		await listen(server, undefined, '127.0.0.1');

		const address = server.address();
		assert.notEqual(address, null);
		assert.equal(typeof address, 'object');

		const client = new DockerApiClient(
			{
				apiVersion: '1.51',
				connectionMode: 'tcp',
				host: '127.0.0.1',
				port: address.port,
			},
			{ timeoutMs: 1 },
		);
		const eventsResponse = await client.streamEvents({
			since: '1712982000',
		});
		const logsResponse = await client.streamContainerLogs('demo', {
			follow: true,
			stderr: true,
			stdout: true,
			tail: 'all',
			timestamps: false,
		});
		const eventsBuffer = await collectDockerStreamResponse(eventsResponse);
		const logsBuffer = await collectDockerStreamResponse(logsResponse);
		const events = parseDockerJsonLines(eventsBuffer, eventsResponse.headers['content-type']);
		const logs = parseDockerRawStream(logsBuffer, logsResponse.headers['content-type']);

		assert.deepEqual(events.entries.map((event) => event.Action), ['start', 'stop']);
		assert.deepEqual(logs.entries, [
			{ message: 'stdout line', stream: 'stdout' },
			{ message: 'stderr line', stream: 'stderr' },
		]);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('DockerApiClient close tears down active SSH event streams', async () => {
	const sshClients = [];
	const server = http.createServer((request, response) => {
		assert.equal(request.url, '/v1.51/events?since=1');
		response.setHeader('content-type', 'application/json');
		response.write(`${JSON.stringify({ Action: 'start', Type: 'container', time: 1 })}\n`);
	});

	try {
		await listen(server, undefined, '127.0.0.1');

		const address = server.address();
		assert.notEqual(address, null);
		assert.equal(typeof address, 'object');

		const client = new DockerApiClient(
			{
				apiVersion: '1.51',
				connectionMode: 'ssh',
				host: '127.0.0.1',
				privateKey: TEST_SSH_PRIVATE_KEY,
				username: 'docker',
			},
			{
				createSshClient: () => {
					const sshClient = new FakeSshClient({
						onForwardOut: createForwardOutHandler(address.port),
					});
					sshClients.push(sshClient);
					return sshClient;
				},
			},
		);
		const streamResponse = await client.streamEvents({ since: '1' });
		let closeError;

		await once(streamResponse.stream, 'data');
		streamResponse.stream.once('error', (error) => {
			closeError = error;
		});
		const streamClosed = once(streamResponse.stream, 'close');

		await client.close();
		await streamClosed;

		assert.equal(sshClients[0].endCalls, 1);
		assert.equal(closeError?.message.includes('aborted') ?? true, true);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('DockerApiClient streams events and logs without buffering the response upfront', async () => {
	const server = http.createServer((request, response) => {
		if (request.method === 'GET' && request.url === '/v1.51/events?since=1712982000') {
			response.setHeader('content-type', 'application/json');
			response.write(`${JSON.stringify({ Action: 'start', Type: 'container' })}\n`);
			response.end(`${JSON.stringify({ Action: 'stop', Type: 'container' })}\n`);
			return;
		}

		if (
			request.method === 'GET' &&
			request.url === '/v1.51/containers/demo/logs?follow=1&stderr=1&stdout=1&tail=all&timestamps=0'
		) {
			response.setHeader('content-type', 'application/vnd.docker.raw-stream');
			response.end(
				Buffer.concat([
					createRawStreamFrame(1, 'stdout line\n'),
					createRawStreamFrame(2, 'stderr line\n'),
				]),
			);
			return;
		}

		response.statusCode = 404;
		response.end(JSON.stringify({ message: 'not found' }));
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
		const eventsResponse = await client.streamEvents({
			since: '1712982000',
		});
		const logsResponse = await client.streamContainerLogs('demo', {
			follow: true,
			stderr: true,
			stdout: true,
			tail: 'all',
			timestamps: false,
		});
		const eventsBuffer = await collectDockerStreamResponse(eventsResponse);
		const logsBuffer = await collectDockerStreamResponse(logsResponse);
		const events = parseDockerJsonLines(eventsBuffer, eventsResponse.headers['content-type']);
		const logs = parseDockerRawStream(logsBuffer, logsResponse.headers['content-type']);

		assert.deepEqual(events.entries.map((event) => event.Action), ['start', 'stop']);
		assert.deepEqual(logs.entries, [
			{ message: 'stdout line', stream: 'stdout' },
			{ message: 'stderr line', stream: 'stderr' },
		]);
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

test('DockerApiClient supports Phase 3 image, network, volume, and system endpoints', async () => {
	const requests = [];
	const server = http.createServer((request, response) => {
		const chunks = [];

		request.on('data', (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});

		request.on('end', () => {
			const body = Buffer.concat(chunks);
			const url = new URL(request.url, 'http://docker.test');
			requests.push({
				body,
				headers: request.headers,
				method: request.method,
				url,
			});

			if (request.method === 'GET' && url.pathname === '/v1.51/system/df') {
				response.setHeader('content-type', 'application/json');
				response.end(
					JSON.stringify({
						BuildCache: [],
						Containers: [],
						Images: [],
						LayersSize: 1234,
						Volumes: [],
					}),
				);
				return;
			}

			if (request.method === 'GET' && url.pathname === '/v1.51/events') {
				response.setHeader('content-type', 'application/json');
				response.end(
					[
						JSON.stringify({ Action: 'start', Type: 'container', id: 'container-1' }),
						JSON.stringify({ Action: 'pull', Type: 'image', id: 'image-1' }),
						'',
					].join('\n'),
				);
				return;
			}

			if (request.method === 'GET' && url.pathname === '/v1.51/images/json') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify([{ Id: 'image-1', RepoTags: ['alpine:3.20'] }]));
				return;
			}

			if (request.method === 'GET' && url.pathname === '/v1.51/images/alpine%3A3.20/json') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ Id: 'image-1', RepoTags: ['alpine:3.20'] }));
				return;
			}

			if (request.method === 'GET' && url.pathname === '/v1.51/images/alpine%3A3.20/history') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify([{ Id: 'layer-1' }]));
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1.51/images/create') {
				response.setHeader('content-type', 'application/json');
				response.end(`${JSON.stringify({ status: 'Pulling from library/alpine' })}\n`);
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1.51/images/alpine%3A3.20/tag') {
				response.statusCode = 201;
				response.end();
				return;
			}

			if (request.method === 'DELETE' && url.pathname === '/v1.51/images/alpine%3A3.20') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify([{ Deleted: 'image-1' }]));
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1.51/images/prune') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ ImagesDeleted: [{ Deleted: 'dangling' }], SpaceReclaimed: 2048 }));
				return;
			}

			if (request.method === 'GET' && url.pathname === '/v1.51/images/get') {
				response.setHeader('content-type', 'application/x-tar');
				response.end(Buffer.from('saved-images'));
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1.51/images/load') {
				response.setHeader('content-type', 'application/json');
				response.end(`${JSON.stringify({ stream: 'Loaded image: alpine:3.20' })}\n`);
				return;
			}

			if (request.method === 'GET' && url.pathname === '/v1.51/networks') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify([{ Id: 'network-1', Name: 'workflow-net' }]));
				return;
			}

			if (request.method === 'GET' && url.pathname === '/v1.51/networks/workflow-net') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ Id: 'network-1', Name: 'workflow-net' }));
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1.51/networks/create') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ Id: 'network-1', Warning: '' }));
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1.51/networks/workflow-net/connect') {
				response.statusCode = 200;
				response.end();
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1.51/networks/workflow-net/disconnect') {
				response.statusCode = 200;
				response.end();
				return;
			}

			if (request.method === 'DELETE' && url.pathname === '/v1.51/networks/workflow-net') {
				response.statusCode = 204;
				response.end();
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1.51/networks/prune') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ NetworksDeleted: ['network-1'] }));
				return;
			}

			if (request.method === 'GET' && url.pathname === '/v1.51/volumes') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ Volumes: [{ Name: 'workflow-data' }], Warnings: [] }));
				return;
			}

			if (request.method === 'GET' && url.pathname === '/v1.51/volumes/workflow-data') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ Driver: 'local', Name: 'workflow-data' }));
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1.51/volumes/create') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ Driver: 'local', Name: 'workflow-data' }));
				return;
			}

			if (request.method === 'DELETE' && url.pathname === '/v1.51/volumes/workflow-data') {
				response.statusCode = 204;
				response.end();
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1.51/volumes/prune') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ SpaceReclaimed: 1024, VolumesDeleted: ['workflow-data'] }));
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

		const df = await client.getSystemDataUsage();
		const events = await client.getEvents({
			filters: JSON.stringify({ type: ['container'], event: ['start'] }),
			since: '1712981700',
			until: '1712982000',
		});
		const images = await client.listImages({ all: true });
		const image = await client.inspectImage('alpine:3.20');
		const history = await client.getImageHistory('alpine:3.20', {});
		const pulled = await client.pullImage({ fromImage: 'alpine:3.20' });
		const tagged = await client.tagImage('alpine:3.20', { repo: 'myorg/alpine', tag: 'stable' });
		const removed = await client.removeImage('alpine:3.20', { force: true, noPrune: true });
		const prunedImages = await client.pruneImages({
			filters: JSON.stringify({ dangling: ['true'] }),
		});
		const saved = await client.saveImages({ names: ['alpine:3.20', 'busybox:latest'] });
		const loaded = await client.loadImages({
			body: Buffer.from('image-tarball'),
			quiet: true,
		});
		const networks = await client.listNetworks();
		const network = await client.inspectNetwork('workflow-net');
		const createdNetwork = await client.createNetwork({ Name: 'workflow-net' });
		const connected = await client.connectNetwork('workflow-net', { Container: 'container-1' });
		const disconnected = await client.disconnectNetwork('workflow-net', {
			Container: 'container-1',
			Force: true,
		});
		const deletedNetwork = await client.deleteNetwork('workflow-net');
		const prunedNetworks = await client.pruneNetworks({});
		const volumes = await client.listVolumes({});
		const volume = await client.inspectVolume('workflow-data');
		const createdVolume = await client.createVolume({ Name: 'workflow-data' });
		const deletedVolume = await client.deleteVolume('workflow-data', { force: true });
		const prunedVolumes = await client.pruneVolumes({
			filters: JSON.stringify({ all: ['true'] }),
		});

		assert.equal(df.LayersSize, 1234);
		assert.equal(events.body.toString('utf8').includes('"Action":"start"'), true);
		assert.deepEqual(images, [{ Id: 'image-1', RepoTags: ['alpine:3.20'] }]);
		assert.deepEqual(image, { Id: 'image-1', RepoTags: ['alpine:3.20'] });
		assert.deepEqual(history, [{ Id: 'layer-1' }]);
		assert.equal(pulled.body.toString('utf8').includes('Pulling from library/alpine'), true);
		assert.deepEqual(tagged, { changed: true, statusCode: 201 });
		assert.deepEqual(removed, [{ Deleted: 'image-1' }]);
		assert.deepEqual(prunedImages, {
			ImagesDeleted: [{ Deleted: 'dangling' }],
			SpaceReclaimed: 2048,
		});
		assert.equal(saved.body.toString('utf8'), 'saved-images');
		assert.equal(loaded.body.toString('utf8').includes('Loaded image'), true);
		assert.deepEqual(networks, [{ Id: 'network-1', Name: 'workflow-net' }]);
		assert.deepEqual(network, { Id: 'network-1', Name: 'workflow-net' });
		assert.deepEqual(createdNetwork, { Id: 'network-1', Warning: '' });
		assert.deepEqual(connected, { changed: true, statusCode: 200 });
		assert.deepEqual(disconnected, { changed: true, statusCode: 200 });
		assert.deepEqual(deletedNetwork, { changed: true, statusCode: 204 });
		assert.deepEqual(prunedNetworks, { NetworksDeleted: ['network-1'] });
		assert.deepEqual(volumes, { Volumes: [{ Name: 'workflow-data' }], Warnings: [] });
		assert.deepEqual(volume, { Driver: 'local', Name: 'workflow-data' });
		assert.deepEqual(createdVolume, { Driver: 'local', Name: 'workflow-data' });
		assert.deepEqual(deletedVolume, { changed: true, statusCode: 204 });
		assert.deepEqual(prunedVolumes, {
			SpaceReclaimed: 1024,
			VolumesDeleted: ['workflow-data'],
		});

		const eventsRequest = requests.find(({ method, url }) =>
			method === 'GET' && url.pathname === '/v1.51/events',
		);
		assert.equal(eventsRequest.url.searchParams.get('since'), '1712981700');
		assert.equal(eventsRequest.url.searchParams.get('until'), '1712982000');
		assert.equal(
			eventsRequest.url.searchParams.get('filters'),
			JSON.stringify({ type: ['container'], event: ['start'] }),
		);

		const saveRequest = requests.find(({ method, url }) =>
			method === 'GET' && url.pathname === '/v1.51/images/get',
		);
		assert.deepEqual(saveRequest.url.searchParams.getAll('names'), ['alpine:3.20', 'busybox:latest']);

		const loadRequest = requests.find(({ method, url }) =>
			method === 'POST' && url.pathname === '/v1.51/images/load',
		);
		assert.equal(loadRequest.headers['content-type'], 'application/x-tar');
		assert.equal(loadRequest.body.toString('utf8'), 'image-tarball');

		const createNetworkRequest = requests.find(({ method, url }) =>
			method === 'POST' && url.pathname === '/v1.51/networks/create',
		);
		assert.deepEqual(JSON.parse(createNetworkRequest.body.toString('utf8')), { Name: 'workflow-net' });

		const createVolumeRequest = requests.find(({ method, url }) =>
			method === 'POST' && url.pathname === '/v1.51/volumes/create',
		);
		assert.deepEqual(JSON.parse(createVolumeRequest.body.toString('utf8')), { Name: 'workflow-data' });
	} finally {
		server.closeAllConnections();
		server.close();
	}
});
