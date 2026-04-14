const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { pack } = require('tar-stream');

const { Docker } = require('../dist/nodes/Docker/Docker.node.js');
const { DockerBuild } = require('../dist/nodes/DockerBuild/DockerBuild.node.js');
const { DockerFiles } = require('../dist/nodes/DockerFiles/DockerFiles.node.js');
const { DockerTrigger } = require('../dist/nodes/DockerTrigger/DockerTrigger.node.js');
const {
	DockerApiClient,
	DockerRequestError,
} = require('../dist/nodes/Docker/transport/dockerClient.js');
const {
	getDockerEventKey,
} = require('../dist/nodes/Docker/utils/dockerEvents.js');
const {
	createSingleFileTarArchive,
	extractSingleFileFromTarBuffer,
} = require('../dist/nodes/Docker/utils/tar.js');

function createRawStreamFrame(streamType, payload) {
	const payloadBuffer = Buffer.from(payload, 'utf8');
	const header = Buffer.alloc(8);

	header[0] = streamType;
	header.writeUInt32BE(payloadBuffer.length, 4);

	return Buffer.concat([header, payloadBuffer]);
}

async function createTarArchive(entries) {
	const archive = pack();
	const chunks = [];

	archive.on('data', (chunk) => {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	});

	const completed = new Promise((resolve, reject) => {
		archive.on('end', () => resolve(Buffer.concat(chunks)));
		archive.on('error', reject);
	});

	for (const entry of entries) {
		await new Promise((resolve, reject) => {
			archive.entry(
				{
					mode: entry.mode ?? 0o644,
					name: entry.name,
					size: entry.content?.length ?? 0,
					type: entry.type ?? 'file',
				},
				entry.content ?? Buffer.alloc(0),
				(error) => {
					if (error != null) {
						reject(error);
						return;
					}

					resolve();
				},
			);
		});
	}

	archive.finalize();

	return await completed;
}

async function listen(server, host = '127.0.0.1') {
	server.listen(0, host);
	await once(server, 'listening');
}

async function waitForCondition(predicate, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	throw new Error('Timed out waiting for condition.');
}

function createNodeMetadata(name, type) {
	return {
		id: '1',
		name,
		parameters: {},
		position: [0, 0],
		type,
		typeVersion: 1,
	};
}

function createExecuteContext({
	continueOnFail = false,
	credentials = {
		accessMode: 'fullControl',
		apiVersion: '1.51',
		connectionMode: 'unixSocket',
		socketPath: '/var/run/docker.sock',
	},
	executionCancelSignal,
	inputItems = [{ json: {} }],
	node,
	parameters,
	workflowStaticData = {},
} = {}) {
	return {
		continueOnFail() {
			return continueOnFail;
		},
		async getCredentials() {
			return credentials;
		},
		getExecutionCancelSignal() {
			return executionCancelSignal;
		},
		getInputData() {
			return inputItems;
		},
		getNode() {
			return node;
		},
		getNodeParameter(name, itemIndex, defaultValue) {
			const itemParameters = Array.isArray(parameters) ? parameters[itemIndex] : parameters;

			if (itemParameters !== undefined && Object.hasOwn(itemParameters, name)) {
				return itemParameters[name];
			}

			return defaultValue;
		},
		getWorkflowStaticData() {
			return workflowStaticData;
		},
		helpers: {
			assertBinaryData(_itemIndex, binaryData) {
				return binaryData;
			},
			async getBinaryDataBuffer(_itemIndex, binaryData) {
				return Buffer.from(binaryData.data, 'base64');
			},
			async prepareBinaryData(buffer, fileName, mimeType) {
				return {
					data: Buffer.from(buffer).toString('base64'),
					fileName,
					mimeType,
				};
			},
		},
	};
}

function createDockerStreamResponse(body, headers = { 'content-type': 'application/json' }) {
	const stream = new PassThrough();

	if (body !== undefined) {
		stream.end(body);
	}

	return {
		close() {
			stream.destroy();
		},
		headers,
		statusCode: 200,
		stream,
	};
}

function createTriggerContext({
	credentials = {
		accessMode: 'readOnly',
		apiVersion: '1.51',
		connectionMode: 'unixSocket',
		socketPath: '/var/run/docker.sock',
	},
	mode = 'trigger',
	node,
	parameters = {},
	workflowStaticData = {},
} = {}) {
	const emitted = [];
	const emittedErrors = [];

	return {
		context: {
			async getCredentials() {
				return credentials;
			},
			emit(data) {
				emitted.push(data);
			},
			emitError(error) {
				emittedErrors.push(error);
			},
			getActivationMode() {
				return mode;
			},
			getMode() {
				return mode;
			},
			getNode() {
				return node;
			},
			getNodeParameter(name, defaultValue) {
				if (Object.hasOwn(parameters, name)) {
					return parameters[name];
				}

				return defaultValue;
			},
			getWorkflowStaticData() {
				return workflowStaticData;
			},
		},
		emitted,
		emittedErrors,
		workflowStaticData,
	};
}

async function withPatchedDockerClient(patches, run) {
	const prototype = DockerApiClient.prototype;
	const originals = new Map();

	for (const [key, patch] of Object.entries(patches)) {
		originals.set(key, Object.getOwnPropertyDescriptor(prototype, key));

		if (
			patch !== null &&
			typeof patch === 'object' &&
			('get' in patch || 'set' in patch || 'value' in patch)
		) {
			Object.defineProperty(prototype, key, {
				configurable: true,
				enumerable: false,
				...patch,
			});
			continue;
		}

		Object.defineProperty(prototype, key, {
			configurable: true,
			enumerable: false,
			value: patch,
			writable: true,
		});
	}

	try {
		return await run();
	} finally {
		for (const [key, descriptor] of originals.entries()) {
			if (descriptor === undefined) {
				delete prototype[key];
				continue;
			}

			Object.defineProperty(prototype, key, descriptor);
		}
	}
}

test('Docker nodes close DockerApiClient instances after execution and trigger shutdown', async () => {
	const dockerNode = new Docker();
	const dockerFilesNode = new DockerFiles();
	const dockerBuildNode = new DockerBuild();
	const dockerTriggerNode = new DockerTrigger();
	const buildContextBuffer = Buffer.from('build-context');
	const buildBinaryData = {
		data: buildContextBuffer.toString('base64'),
		fileName: 'context.tar',
		mimeType: 'application/x-tar',
	};
	let closeCalls = 0;

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async buildImage() {
				return createDockerStreamResponse(
					Buffer.from(`${JSON.stringify({ stream: 'build complete' })}\n`),
				);
			},
			async close() {
				closeCalls += 1;
			},
			async exportContainer() {
				return {
					body: Buffer.from('tar-export'),
					headers: {
						'content-type': 'application/x-tar',
					},
					statusCode: 200,
				};
			},
			async getInfo() {
				return { ServerVersion: 'demo' };
			},
			async streamEvents() {
				return createDockerStreamResponse(undefined);
			},
		},
		async () => {
			await dockerNode.execute.call(
				createExecuteContext({
					node: createNodeMetadata('Docker', 'docker'),
					parameters: {
						operation: 'info',
						resource: 'system',
					},
				}),
			);

			await dockerFilesNode.execute.call(
				createExecuteContext({
					node: createNodeMetadata('Docker Files', 'dockerFiles'),
					parameters: {
						containerId: 'demo',
						operation: 'export',
						outputBinaryPropertyName: 'data',
						resource: 'container',
					},
				}),
			);

			await dockerBuildNode.execute.call(
				createExecuteContext({
					inputItems: [{ json: {}, binary: { data: buildBinaryData } }],
					node: createNodeMetadata('Docker Build', 'dockerBuild'),
					parameters: {
						binaryPropertyName: 'data',
						buildAlwaysRemoveIntermediateContainers: false,
						buildArgs: { values: [] },
						buildLabels: { values: [] },
						buildNetworkMode: '',
						buildNoCache: false,
						buildPull: false,
						buildQuiet: false,
						buildRemoveIntermediateContainers: true,
						buildTags: { values: [] },
						builderVersion: '2',
						dockerfilePath: 'Dockerfile',
						operation: 'build',
						outputMode: 'aggregate',
						platform: '',
						targetStage: '',
						timeoutSeconds: 30,
					},
				}),
			);

			const { context } = createTriggerContext({
				node: createNodeMetadata('Docker Trigger', 'dockerTrigger'),
				parameters: {
					actions: [],
					resourceTypes: [],
				},
			});
			const triggerResponse = await dockerTriggerNode.trigger.call(context);

			await triggerResponse.closeFunction();
		},
	);

	assert.equal(closeCalls, 4);
});

test('Docker exec executes commands and maps raw-stream output at the node boundary', async () => {
	const dockerNode = new Docker();
	const captured = {};
	const rawOutput = Buffer.concat([
		createRawStreamFrame(1, 'stdout line\n'),
		createRawStreamFrame(2, 'stderr line\n'),
	]);

	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			execAllowList: {
				values: [{ value: 'sh' }],
			},
			execAttachStderr: true,
			execAttachStdout: true,
			execCommandArgs: {
				values: [{ value: '/bin/sh' }, { value: '-c' }, { value: 'printf test' }],
			},
			execDenyList: {
				values: [],
			},
			execEnv: {
				values: [{ name: 'FOO', value: 'bar' }],
			},
			execPrivileged: false,
			execTty: false,
			execUser: '1000:1000',
			execWorkingDir: '/tmp',
			operation: 'exec',
			resource: 'container',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async createContainerExec(containerId, body) {
				captured.createContainerExec = { body, containerId };
				return { Id: 'exec-123' };
			},
			async inspectContainerExec(execId) {
				captured.inspectContainerExec = { execId };
				return { ExitCode: 0, ID: execId, Running: false };
			},
			async startContainerExec(execId, body) {
				captured.startContainerExec = { body, execId };
				return {
					body: rawOutput,
					headers: {
						'content-type': 'application/vnd.docker.raw-stream',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'exec');
			assert.equal(items[0].json.containerId, 'demo');
			assert.equal(items[0].json.execId, 'exec-123');
			assert.equal(items[0].json.exitCode, 0);
			assert.equal(items[0].json.stdout, 'stdout line\n');
			assert.equal(items[0].json.stderr, 'stderr line\n');
			assert.equal(items[0].json.combinedOutput, 'stdout line\nstderr line\n');
			assert.equal(items[0].json.multiplexed, true);
			assert.deepEqual(items[0].json.entries, [
				{ message: 'stdout line', stream: 'stdout' },
				{ message: 'stderr line', stream: 'stderr' },
			]);
			assert.deepEqual(captured.createContainerExec, {
				body: {
					AttachStderr: true,
					AttachStdout: true,
					Cmd: ['/bin/sh', '-c', 'printf test'],
					Env: ['FOO=bar'],
					Privileged: false,
					Tty: false,
					User: '1000:1000',
					WorkingDir: '/tmp',
				},
				containerId: 'demo',
			});
			assert.deepEqual(captured.startContainerExec, {
				body: {
					Detach: false,
					Tty: false,
				},
				execId: 'exec-123',
			});
			assert.deepEqual(captured.inspectContainerExec, { execId: 'exec-123' });
		},
	);
});

test('Docker readTextFile reads a text file and returns the requested line window', async () => {
	const dockerNode = new Docker();
	const archiveBody = await createSingleFileTarArchive(
		'report.txt',
		Buffer.from('alpha\r\nbeta\r\ngamma\r\n', 'utf8'),
	);
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			endLine: '3',
			filePath: 'reports/report.txt',
			operation: 'readTextFile',
			resource: 'container',
			startLine: '2',
			workingPath: '/workspace',
		},
	});

	await withPatchedDockerClient(
		{
			async getContainerArchive(containerId, options) {
				assert.equal(containerId, 'demo');
				assert.deepEqual(options, { path: '/workspace/reports/report.txt' });

				return {
					body: archiveBody,
					headers: {
						'content-type': 'application/x-tar',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);

			assert.deepEqual(items.map((item) => item.json), [
				{
					containerId: 'demo',
					content: 'beta\ngamma',
					fileByteCount: Buffer.byteLength('alpha\r\nbeta\r\ngamma\r\n', 'utf8'),
					hasMoreAfter: false,
					hasMoreBefore: true,
					lineEnd: 3,
					lineStart: 2,
					operation: 'readTextFile',
					requestedEndLine: 3,
					requestedPath: 'reports/report.txt',
					requestedStartLine: 2,
					resolvedPath: '/workspace/reports/report.txt',
					returnedLineCount: 2,
					totalLineCount: 3,
				},
			]);
		},
	);
});

test('Docker readTextFile rejects invalid line windows before making Docker requests', async () => {
	const dockerNode = new Docker();
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			endLine: '2',
			filePath: 'report.txt',
			operation: 'readTextFile',
			resource: 'container',
			startLine: '3',
			workingPath: '/workspace',
		},
	});

	await assert.rejects(async () => await dockerNode.execute.call(context), (error) => {
		assert.equal(error.name, 'NodeOperationError');
		assert.equal(error.message.includes('Start Line must be less than or equal to End Line.'), true);
		return true;
	});
});

test('Docker readTextFile surfaces invalid UTF-8 content as a node error', async () => {
	const dockerNode = new Docker();
	const archiveBody = await createSingleFileTarArchive(
		'report.txt',
		Buffer.from([0x66, 0x6f, 0x80, 0x6f]),
	);
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			filePath: 'reports/report.txt',
			operation: 'readTextFile',
			resource: 'container',
			workingPath: '/workspace',
		},
	});

	await withPatchedDockerClient(
		{
			async getContainerArchive() {
				return {
					body: archiveBody,
					headers: {
						'content-type': 'application/x-tar',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			await assert.rejects(async () => await dockerNode.execute.call(context), (error) => {
				assert.equal(error.name, 'NodeOperationError');
				assert.equal(
					error.message.includes('is not valid UTF-8 text and cannot be returned as text.'),
					true,
				);
				return true;
			});
		},
	);
});

test('Docker listFiles executes the fixed helper command and maps file entries to items', async () => {
	const dockerNode = new Docker();
	const captured = {};
	const rawOutput = Buffer.concat([
		createRawStreamFrame(1, 'directory\tsrc\n'),
		createRawStreamFrame(1, 'file\tsrc/app.ts\n'),
	]);
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			glob: '',
			includeHidden: false,
			listFilesLimit: 1,
			listFilesReturnAll: false,
			maxDepth: 3,
			operation: 'listFiles',
			resource: 'container',
			workingPath: '/workspace',
		},
	});

	await withPatchedDockerClient(
		{
			async createContainerExec(containerId, body) {
				captured.createContainerExec = { body, containerId };
				return { Id: 'exec-list-files' };
			},
			async inspectContainerExec(execId) {
				assert.equal(execId, 'exec-list-files');
				return { ExitCode: 0, ID: execId, Running: false };
			},
			async startContainerExec(execId, body) {
				assert.equal(execId, 'exec-list-files');
				assert.deepEqual(body, { Detach: false, Tty: false });
				return {
					body: rawOutput,
					headers: {
						'content-type': 'application/vnd.docker.raw-stream',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);

			assert.deepEqual(items.map((item) => item.json), [
				{
					absolutePath: '/workspace/src',
					containerId: 'demo',
					entryType: 'directory',
					operation: 'listFiles',
					path: 'src',
					workingPath: '/workspace',
				},
			]);
			assert.equal(captured.createContainerExec.containerId, 'demo');
			assert.deepEqual(captured.createContainerExec.body.Cmd.slice(0, 2), ['/bin/sh', '-lc']);
			assert.equal(
				captured.createContainerExec.body.Cmd[2].includes('find is required for listFiles'),
				true,
			);
			assert.deepEqual(captured.createContainerExec.body.Env, [
				'GLOB=',
				'INCLUDE_HIDDEN=false',
				'LIST_ROOT=/workspace',
				'MAX_DEPTH=3',
				'MAX_ENTRIES=1',
			]);
			assert.equal(captured.createContainerExec.body.WorkingDir, '/');
		},
	);
});

test('Docker searchText returns no items when grep-style search reports no matches', async () => {
	const dockerNode = new Docker();
	const captured = {};
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			caseSensitive: false,
			containerId: 'demo',
			glob: '*.ts',
			operation: 'searchText',
			query: 'missing',
			resource: 'container',
			searchTextLimit: 5,
			searchTextReturnAll: false,
			workingPath: '/workspace',
		},
	});

	await withPatchedDockerClient(
		{
			async createContainerExec(containerId, body) {
				captured.createContainerExec = { body, containerId };
				return { Id: 'exec-search-text' };
			},
			async inspectContainerExec(execId) {
				assert.equal(execId, 'exec-search-text');
				return { ExitCode: 1, ID: execId, Running: false };
			},
			async startContainerExec(execId) {
				assert.equal(execId, 'exec-search-text');
				return {
					body: Buffer.alloc(0),
					headers: {
						'content-type': 'application/vnd.docker.raw-stream',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);

			assert.equal(items.length, 0);
			assert.equal(captured.createContainerExec.containerId, 'demo');
			assert.equal(captured.createContainerExec.body.WorkingDir, '/');
			assert.equal(captured.createContainerExec.body.Cmd[2].includes('--no-ignore'), true);
			assert.deepEqual(captured.createContainerExec.body.Env, [
				'CASE_SENSITIVE=false',
				'GLOB=*.ts',
				'MAX_MATCHES=5',
				'QUERY=missing',
				'SEARCH_ROOT=/workspace',
			]);
		},
	);
});

test('Docker listFiles and searchText surface missing working paths as node errors', async () => {
	const dockerNode = new Docker();
	const listContext = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			glob: '',
			includeHidden: false,
			listFilesReturnAll: true,
			maxDepth: 3,
			operation: 'listFiles',
			resource: 'container',
			workingPath: '/missing',
		},
	});
	const searchContext = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			caseSensitive: false,
			containerId: 'demo',
			glob: '',
			operation: 'searchText',
			query: 'needle',
			resource: 'container',
			searchTextReturnAll: true,
			workingPath: '/missing',
		},
	});
	let executionCount = 0;

	await withPatchedDockerClient(
		{
			async createContainerExec() {
				executionCount += 1;

				return { Id: `exec-missing-${executionCount}` };
			},
			async inspectContainerExec(execId) {
				return { ExitCode: 0, ID: execId, Running: false };
			},
			async startContainerExec(execId) {
				return {
					body: Buffer.concat([
						createRawStreamFrame(1, '__ERROR__\tPATH_NOT_FOUND\t/missing\n'),
					]),
					headers: {
						'content-type': 'application/vnd.docker.raw-stream',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			await assert.rejects(
				async () => await dockerNode.execute.call(listContext),
				/Working Path "\/missing" was not found in the container\./,
			);
			await assert.rejects(
				async () => await dockerNode.execute.call(searchContext),
				/Working Path "\/missing" was not found in the container\./,
			);
		},
	);
});

test('Docker writeTextFile can create parent directories and upload UTF-8 content', async () => {
	const dockerNode = new Docker();
	const captured = {};
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			content: 'GREETING=hello\n',
			createParentDirectories: true,
			filePath: 'config/app.env',
			operation: 'writeTextFile',
			resource: 'container',
			workingPath: '/workspace',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async createContainerExec(containerId, body) {
				captured.createContainerExec = { body, containerId };
				return { Id: 'exec-write-text' };
			},
			async inspectContainerExec(execId) {
				assert.equal(execId, 'exec-write-text');
				return { ExitCode: 0, ID: execId, Running: false };
			},
			async putContainerArchive(containerId, options) {
				captured.putContainerArchive = { containerId, options };
				return {
					changed: true,
					statusCode: 200,
				};
			},
			async startContainerExec(execId) {
				assert.equal(execId, 'exec-write-text');
				return {
					body: Buffer.alloc(0),
					headers: {
						'content-type': 'application/vnd.docker.raw-stream',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);
			const extracted = await extractSingleFileFromTarBuffer(captured.putContainerArchive.options.body);

			assert.deepEqual(items.map((item) => item.json), [
				{
					bytesWritten: Buffer.byteLength('GREETING=hello\n', 'utf8'),
					changed: true,
					containerId: 'demo',
					operation: 'writeTextFile',
					requestedPath: 'config/app.env',
					resolvedPath: '/workspace/config/app.env',
					statusCode: 200,
				},
			]);
			assert.equal(captured.createContainerExec.containerId, 'demo');
			assert.deepEqual(captured.createContainerExec.body.Env, ['TARGET_DIR=/workspace/config']);
			assert.equal(captured.putContainerArchive.containerId, 'demo');
			assert.equal(captured.putContainerArchive.options.path, '/workspace/config');
			assert.equal(extracted.file.fileName, 'app.env');
			assert.equal(extracted.file.content.toString('utf8'), 'GREETING=hello\n');
		},
	);
});

test('Docker replaceExactText rewrites a file only when the old text matches once', async () => {
	const dockerNode = new Docker();
	const captured = {};
	const archiveBody = await createSingleFileTarArchive(
		'app.txt',
		Buffer.from('hello\r\nold\r\n', 'utf8'),
	);
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			filePath: 'app.txt',
			newText: 'new',
			oldText: 'old',
			operation: 'replaceExactText',
			resource: 'container',
			workingPath: '/workspace',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async getContainerArchive(containerId, options) {
				assert.equal(containerId, 'demo');
				assert.deepEqual(options, { path: '/workspace/app.txt' });
				return {
					body: archiveBody,
					headers: {
						'content-type': 'application/x-tar',
					},
					statusCode: 200,
				};
			},
			async putContainerArchive(containerId, options) {
				captured.putContainerArchive = { containerId, options };
				return {
					changed: true,
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);
			const extracted = await extractSingleFileFromTarBuffer(captured.putContainerArchive.options.body);

			assert.deepEqual(items.map((item) => item.json), [
				{
					bytesWritten: Buffer.byteLength('hello\r\nnew\r\n', 'utf8'),
					changed: true,
					containerId: 'demo',
					operation: 'replaceExactText',
					replacementCount: 1,
					requestedPath: 'app.txt',
					resolvedPath: '/workspace/app.txt',
					statusCode: 200,
				},
			]);
			assert.equal(captured.putContainerArchive.options.path, '/workspace');
			assert.equal(extracted.file.fileName, 'app.txt');
			assert.equal(extracted.file.content.toString('utf8'), 'hello\r\nnew\r\n');
		},
	);
});

test('Docker replaceExactText rejects ambiguous matches and Docker writeTextFile requires full control', async () => {
	const dockerNode = new Docker();
	const ambiguousArchiveBody = await createSingleFileTarArchive(
		'app.txt',
		Buffer.from('old and old again\n', 'utf8'),
	);
	const replaceContext = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			filePath: 'app.txt',
			newText: 'new',
			oldText: 'old',
			operation: 'replaceExactText',
			resource: 'container',
			workingPath: '/workspace',
		},
	});
	const writeContext = createExecuteContext({
		credentials: {
			accessMode: 'readOnly',
			apiVersion: '1.51',
			connectionMode: 'unixSocket',
			socketPath: '/var/run/docker.sock',
		},
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			content: 'hello',
			createParentDirectories: false,
			filePath: 'app.txt',
			operation: 'writeTextFile',
			resource: 'container',
			workingPath: '/workspace',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async getContainerArchive() {
				return {
					body: ambiguousArchiveBody,
					headers: {
						'content-type': 'application/x-tar',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			await assert.rejects(
				async () => await dockerNode.execute.call(replaceContext),
				/matched 2 locations/,
			);
		},
	);

	await assert.rejects(async () => await dockerNode.execute.call(writeContext), (error) => {
		assert.equal(error.name, 'NodeOperationError');
		assert.equal(
			error.message.includes('Operation "writeTextFile" requires the credential Access Mode to be set to Full Control.'),
			true,
		);
		return true;
	});
});

test('Docker replaceExactText surfaces invalid UTF-8 content as a node error', async () => {
	const dockerNode = new Docker();
	const invalidUtf8ArchiveBody = await createSingleFileTarArchive(
		'app.txt',
		Buffer.from([0x66, 0x6f, 0x80, 0x6f]),
	);
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			filePath: 'app.txt',
			newText: 'new',
			oldText: 'old',
			operation: 'replaceExactText',
			resource: 'container',
			workingPath: '/workspace',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async getContainerArchive() {
				return {
					body: invalidUtf8ArchiveBody,
					headers: {
						'content-type': 'application/x-tar',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			await assert.rejects(async () => await dockerNode.execute.call(context), (error) => {
				assert.equal(error.name, 'NodeOperationError');
				assert.equal(
					error.message.includes('is not valid UTF-8 text and cannot be edited as text.'),
					true,
				);
				return true;
			});
		},
	);
});

test('Docker Files copyTo converts binary input into a tar archive at the node boundary', async () => {
	const dockerFilesNode = new DockerFiles();
	const captured = {};
	const fileContent = Buffer.from('hello from copyTo', 'utf8');

	const context = createExecuteContext({
		inputItems: [
			{
				binary: {
					payload: {
						data: fileContent.toString('base64'),
						fileName: 'ignored.txt',
					},
				},
				json: {},
			},
		],
		node: createNodeMetadata('Docker Files', 'dockerFiles'),
		parameters: {
			binaryPropertyName: 'payload',
			containerId: 'demo',
			copyUidGid: true,
			fileName: 'report.txt',
			noOverwriteDirNonDir: true,
			operation: 'copyTo',
			resource: 'container',
			targetPath: '/tmp',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async putContainerArchive(containerId, options) {
				captured.putContainerArchive = { containerId, options };
				return {
					changed: true,
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerFilesNode.execute.call(context);
			const extracted = await extractSingleFileFromTarBuffer(captured.putContainerArchive.options.body);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'copyTo');
			assert.equal(items[0].json.containerId, 'demo');
			assert.equal(items[0].json.fileName, 'report.txt');
			assert.equal(items[0].json.targetPath, '/tmp');
			assert.equal(items[0].json.bytes, fileContent.length);
			assert.equal(items[0].json.changed, true);
			assert.equal(items[0].json.statusCode, 200);
			assert.equal(captured.putContainerArchive.containerId, 'demo');
			assert.equal(captured.putContainerArchive.options.path, '/tmp');
			assert.equal(captured.putContainerArchive.options.copyUidGid, true);
			assert.equal(captured.putContainerArchive.options.noOverwriteDirNonDir, true);
			assert.equal(extracted.file.fileName, 'report.txt');
			assert.equal(extracted.file.content.toString('utf8'), 'hello from copyTo');
		},
	);
});

test('Docker Files copyFrom extracts a single file into binary output at the node boundary', async () => {
	const dockerFilesNode = new DockerFiles();
	const archiveBody = await createSingleFileTarArchive('report.txt', Buffer.from('copied back', 'utf8'));
	const archiveHeader = Buffer.from(
		JSON.stringify({
			linkTarget: '',
			mode: 420,
			mtime: '2026-04-13T00:00:00Z',
			name: 'report.txt',
			size: 11,
		}),
	).toString('base64');
	const context = createExecuteContext({
		node: createNodeMetadata('Docker Files', 'dockerFiles'),
		parameters: {
			containerId: 'demo',
			extractSingleFile: true,
			operation: 'copyFrom',
			outputBinaryPropertyName: 'download',
			resource: 'container',
			sourcePath: '/tmp/report.txt',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async getContainerArchive(containerId, options) {
				assert.equal(containerId, 'demo');
				assert.deepEqual(options, { path: '/tmp/report.txt' });

				return {
					body: archiveBody,
					headers: {
						'content-type': 'application/x-tar',
					},
					statusCode: 200,
				};
			},
			async getContainerArchiveInfo(containerId, options) {
				assert.equal(containerId, 'demo');
				assert.deepEqual(options, { path: '/tmp/report.txt' });

				return {
					body: Buffer.alloc(0),
					headers: {
						'x-docker-container-path-stat': archiveHeader,
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerFilesNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'copyFrom');
			assert.equal(items[0].json.containerId, 'demo');
			assert.equal(items[0].json.outputMode, 'singleFile');
			assert.equal(items[0].json.extractedSingleFile, true);
			assert.equal(items[0].json.entryCount, 1);
			assert.deepEqual(items[0].json.archivePathStat, {
				linkTarget: '',
				mode: 420,
				mtime: '2026-04-13T00:00:00Z',
				name: 'report.txt',
				size: 11,
			});
			assert.equal(items[0].binary.download.fileName, 'report.txt');
			assert.equal(
				Buffer.from(items[0].binary.download.data, 'base64').toString('utf8'),
				'copied back',
			);
		},
	);
});

test('Docker Files copyFrom falls back to tar output when extraction sees multiple entries', async () => {
	const dockerFilesNode = new DockerFiles();
	const archiveBody = await createTarArchive([
		{ content: Buffer.from('alpha', 'utf8'), name: 'a.txt' },
		{ content: Buffer.from('beta', 'utf8'), name: 'b.txt' },
	]);
	const archiveHeader = Buffer.from(
		JSON.stringify({
			linkTarget: '',
			mode: 493,
			mtime: '2026-04-13T00:00:00Z',
			name: 'bundle',
			size: archiveBody.length,
		}),
	).toString('base64');
	const context = createExecuteContext({
		node: createNodeMetadata('Docker Files', 'dockerFiles'),
		parameters: {
			containerId: 'demo',
			extractSingleFile: true,
			operation: 'copyFrom',
			outputBinaryPropertyName: 'download',
			resource: 'container',
			sourcePath: '/tmp/bundle',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async getContainerArchive(containerId, options) {
				assert.equal(containerId, 'demo');
				assert.deepEqual(options, { path: '/tmp/bundle' });

				return {
					body: archiveBody,
					headers: {
						'content-type': 'application/x-tar',
					},
					statusCode: 200,
				};
			},
			async getContainerArchiveInfo(containerId, options) {
				assert.equal(containerId, 'demo');
				assert.deepEqual(options, { path: '/tmp/bundle' });

				return {
					body: Buffer.alloc(0),
					headers: {
						'x-docker-container-path-stat': archiveHeader,
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerFilesNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'copyFrom');
			assert.equal(items[0].json.containerId, 'demo');
			assert.equal(items[0].json.outputMode, 'tar');
			assert.equal(items[0].json.extractedSingleFile, false);
			assert.equal(items[0].json.entryCount, 2);
			assert.equal(items[0].json.fallbackReason, 'multipleEntries');
			assert.equal(items[0].binary.download.fileName, 'bundle.tar');
			assert.equal(items[0].binary.download.mimeType, 'application/x-tar');
			assert.deepEqual(Buffer.from(items[0].binary.download.data, 'base64'), archiveBody);
		},
	);
});

test('Docker Files surfaces Docker request metadata in continue-on-fail payloads', async () => {
	const dockerFilesNode = new DockerFiles();
	const context = createExecuteContext({
		continueOnFail: true,
		inputItems: [
			{
				binary: {
					payload: {
						data: Buffer.from('boom', 'utf8').toString('base64'),
						fileName: 'boom.txt',
					},
				},
				json: {},
			},
		],
		node: createNodeMetadata('Docker Files', 'dockerFiles'),
		parameters: {
			binaryPropertyName: 'payload',
			containerId: 'demo',
			copyUidGid: false,
			noOverwriteDirNonDir: false,
			operation: 'copyTo',
			resource: 'container',
			targetPath: '/tmp',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async putContainerArchive() {
				throw new DockerRequestError('Docker API request failed with status 500.', {
					bodyText: '{"message":"boom"}',
					details: { message: 'boom' },
					method: 'PUT',
					path: '/v1.51/containers/demo/archive',
					statusCode: 500,
				});
			},
		},
		async () => {
			const [items] = await dockerFilesNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.deepEqual(items[0].json, {
				error: 'Docker API request failed with status 500.',
				method: 'PUT',
				operation: 'copyTo',
				path: '/v1.51/containers/demo/archive',
				resource: 'container',
				response: '{"message":"boom"}',
				statusCode: 500,
			});
		},
	);
});

test('Docker image pull aggregates JSON-line progress output at the node boundary', async () => {
	const dockerNode = new Docker();
	const progressBody = Buffer.from(
		[
			JSON.stringify({ id: 'alpine:3.20', status: 'Pulling from library/alpine' }),
			JSON.stringify({ status: 'Digest: sha256:abc123' }),
			'',
		].join('\n'),
		'utf8',
	);
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			imagePlatform: '',
			imageReference: 'alpine:3.20',
			operation: 'pull',
			resource: 'image',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async inspectImage(imageReference) {
				assert.equal(imageReference, 'alpine:3.20');
				return { Id: 'sha256:abc123', RepoTags: ['alpine:3.20'] };
			},
			async pullImage(options) {
				assert.deepEqual(options, {
					fromImage: 'alpine:3.20',
					platform: undefined,
				});

				return {
					body: progressBody,
					headers: {
						'content-type': 'application/json',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'pull');
			assert.equal(items[0].json.imageReference, 'alpine:3.20');
			assert.equal(items[0].json.messageCount, 2);
			assert.deepEqual(items[0].json.rawLines, [
				'{"id":"alpine:3.20","status":"Pulling from library/alpine"}',
				'{"status":"Digest: sha256:abc123"}',
			]);
			assert.deepEqual(items[0].json.image, {
				Id: 'sha256:abc123',
				RepoTags: ['alpine:3.20'],
			});
		},
	);
});

test('Docker system events computes a bounded window and aggregates events into one item', async () => {
	const dockerNode = new Docker();
	const captured = {};
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			eventsActions: ['start', 'stop'],
			eventsLookbackSeconds: 300,
			eventsResourceTypes: ['container'],
			eventsUntil: '1712982000',
			operation: 'events',
			resource: 'system',
		},
	});

	await withPatchedDockerClient(
		{
			async getEvents(options) {
				captured.getEvents = options;
				return {
					body: Buffer.from(
						[
							JSON.stringify({ Action: 'start', Type: 'container', id: 'container-1' }),
							JSON.stringify({ Action: 'stop', Type: 'container', id: 'container-1' }),
							'',
						].join('\n'),
					),
					headers: {
						'content-type': 'application/json',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'events');
			assert.equal(items[0].json.count, 2);
			assert.deepEqual(items[0].json.filters, {
				actions: ['start', 'stop'],
				resourceTypes: ['container'],
			});
			assert.deepEqual(items[0].json.window, {
				lookbackSeconds: 300,
				since: '1712981700',
				until: '1712982000',
			});
			assert.deepEqual(captured.getEvents, {
				filters: JSON.stringify({
					type: ['container'],
					event: ['start', 'stop'],
				}),
				since: '1712981700',
				until: '1712982000',
			});
		},
	);
});

test('Docker container logs can follow a stream for a fixed duration and split log items', async () => {
	const dockerNode = new Docker();
	const stream = new PassThrough();
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			containerId: 'demo',
			includeStderr: true,
			includeStdout: true,
			logsFollowDurationSeconds: 1,
			logsMode: 'followForDuration',
			logsOutputMode: 'splitItems',
			operation: 'logs',
			resource: 'container',
			since: '',
			tail: 'all',
			timestamps: false,
			until: '',
		},
	});

	await withPatchedDockerClient(
		{
			async streamContainerLogs(containerId, options) {
				assert.equal(containerId, 'demo');
				assert.equal(options.follow, true);

				setImmediate(() => {
					stream.end(
						Buffer.concat([
							createRawStreamFrame(1, 'stdout line\n'),
							createRawStreamFrame(2, 'stderr line\n'),
						]),
					);
				});

				return {
					close() {
						stream.destroy();
					},
					headers: {
						'content-type': 'application/vnd.docker.raw-stream',
					},
					statusCode: 200,
					stream,
				};
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);

			assert.deepEqual(
				items.map((item) => item.json),
				[
					{
						containerId: 'demo',
						message: 'stdout line',
						operation: 'logs',
						stream: 'stdout',
					},
					{
						containerId: 'demo',
						message: 'stderr line',
						operation: 'logs',
						stream: 'stderr',
					},
				],
			);
		},
	);
});

test('Docker system events can resume from stored cursor and split items without duplicates', async () => {
	const dockerNode = new Docker();
	const duplicateEvent = {
		Action: 'start',
		Actor: {
			ID: 'container-1',
		},
		Type: 'container',
		id: 'container-1',
		time: 1712982000,
		timeNano: 1712982000000000000,
	};
	const nextEvent = {
		Action: 'stop',
		Actor: {
			ID: 'container-1',
		},
		Type: 'container',
		id: 'container-1',
		time: 1712982001,
		timeNano: 1712982001000000000,
	};
	const workflowStaticData = {
		lastEventTime: duplicateEvent.time,
		lastEventTimeNano: duplicateEvent.timeNano,
		recentEventKeys: [getDockerEventKey(duplicateEvent)],
	};
	const captured = {};
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			eventsActions: ['start', 'stop'],
			eventsLookbackSeconds: 300,
			eventsOutputMode: 'splitItems',
			eventsReadMode: 'resumeFromCursor',
			eventsResourceTypes: ['container'],
			operation: 'events',
			resource: 'system',
		},
		workflowStaticData,
	});

	await withPatchedDockerClient(
		{
			async getEvents(options) {
				captured.getEvents = options;
				return {
					body: Buffer.from(
						[
							JSON.stringify(duplicateEvent),
							JSON.stringify(nextEvent),
							'',
						].join('\n'),
					),
					headers: {
						'content-type': 'application/json',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.action, 'stop');
			assert.equal(items[0].json.type, 'container');
			assert.equal(items[0].json.cursor, String(nextEvent.timeNano));
			assert.equal(workflowStaticData.lastEventTime, nextEvent.time);
			assert.equal(workflowStaticData.lastEventTimeNano, nextEvent.timeNano);
			assert.deepEqual(captured.getEvents.filters, JSON.stringify({
				type: ['container'],
				event: ['start', 'stop'],
			}));
			assert.equal(captured.getEvents.since, String(duplicateEvent.time));
		},
	);
});

test('Docker system events resumeFromCursor ignores older nanosecond events after a newer seconds-only cursor', async () => {
	const dockerNode = new Docker();
	const initialEvent = {
		Action: 'start',
		Actor: {
			ID: 'container-1',
		},
		Type: 'container',
		id: 'container-1',
		time: 1712982000,
		timeNano: 1712982000000000000,
	};
	const newerSecondsOnlyEvent = {
		Action: 'stop',
		Actor: {
			ID: 'container-1',
		},
		Type: 'container',
		id: 'container-1',
		time: 1712982002,
	};
	const olderNanosecondEvent = {
		Action: 'die',
		Actor: {
			ID: 'container-1',
		},
		Type: 'container',
		id: 'container-1',
		time: 1712982001,
		timeNano: 1712982001000000000,
	};
	const workflowStaticData = {};
	let callCount = 0;
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			eventsActions: ['start', 'stop', 'die'],
			eventsLookbackSeconds: 300,
			eventsOutputMode: 'splitItems',
			eventsReadMode: 'resumeFromCursor',
			eventsResourceTypes: ['container'],
			operation: 'events',
			resource: 'system',
		},
		workflowStaticData,
	});

	await withPatchedDockerClient(
		{
			async getEvents() {
				callCount += 1;
				return {
					body: Buffer.from(
						[
							...(callCount === 1 ? [initialEvent, newerSecondsOnlyEvent] : [olderNanosecondEvent]),
						]
							.map((event) => JSON.stringify(event))
							.concat('')
							.join('\n'),
					),
					headers: {
						'content-type': 'application/json',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [firstItems] = await dockerNode.execute.call(context);
			const [secondItems] = await dockerNode.execute.call(context);

			assert.equal(callCount, 2);
			assert.equal(firstItems.length, 2);
			assert.equal(secondItems.length, 0);
			assert.equal(workflowStaticData.lastEventTime, newerSecondsOnlyEvent.time);
			assert.equal('lastEventTimeNano' in workflowStaticData, false);
			assert.deepEqual(workflowStaticData.recentEventKeys, [
				getDockerEventKey(newerSecondsOnlyEvent),
			]);
		},
	);
});

test('Docker Trigger manual execution resolves on the next matching event and stores the cursor', async () => {
	const dockerTrigger = new DockerTrigger();
	const stream = new PassThrough();
	const workflowStaticData = {};
	const { context } = createTriggerContext({
		mode: 'manual',
		node: createNodeMetadata('Docker Trigger', 'dockerTrigger'),
		parameters: {
			actions: ['start'],
			resourceTypes: ['container'],
		},
		workflowStaticData,
	});

	await withPatchedDockerClient(
		{
			async streamEvents(options) {
				assert.equal(options.filters, JSON.stringify({
					type: ['container'],
					event: ['start'],
				}));

				setImmediate(() => {
					stream.write(
						`${JSON.stringify({
							Action: 'start',
							Actor: { ID: 'container-1' },
							Type: 'container',
							id: 'container-1',
							time: 1712982002,
							timeNano: 1712982002000000000,
						})}\n`,
					);
				});

				return {
					close() {
						stream.destroy();
					},
					headers: {
						'content-type': 'application/json',
					},
					statusCode: 200,
					stream,
				};
			},
		},
		async () => {
			const response = await dockerTrigger.trigger.call(context);
			const items = await response.manualTriggerResponse;

			assert.equal(items[0][0].json.action, 'start');
			assert.equal(items[0][0].json.type, 'container');
			assert.equal(workflowStaticData.lastEventTime, 1712982002);
			assert.equal(workflowStaticData.lastEventTimeNano, 1712982002000000000);
		},
	);
});

test('Docker Trigger replays from cursor after a disconnect without emitting duplicates', async () => {
	const dockerTrigger = new DockerTrigger();
	const firstStream = new PassThrough();
	const secondStream = new PassThrough();
	const replayEvent = {
		Action: 'start',
		Actor: {
			ID: 'container-1',
		},
		Type: 'container',
		id: 'container-1',
		time: 1712982003,
		timeNano: 1712982003000000000,
	};
	const liveEvent = {
		Action: 'stop',
		Actor: {
			ID: 'container-1',
		},
		Type: 'container',
		id: 'container-1',
		time: 1712982004,
		timeNano: 1712982004000000000,
	};
	const { context, emitted, workflowStaticData } = createTriggerContext({
		node: createNodeMetadata('Docker Trigger', 'dockerTrigger'),
		parameters: {
			actions: ['start', 'stop'],
			resourceTypes: ['container'],
		},
		workflowStaticData: {
			lastEventTime: replayEvent.time,
			lastEventTimeNano: replayEvent.timeNano,
			recentEventKeys: [getDockerEventKey(replayEvent)],
		},
	});
	let streamCallCount = 0;
	let replayCallCount = 0;

	await withPatchedDockerClient(
		{
			async getEvents() {
				replayCallCount += 1;
				return {
					body: Buffer.from(`${JSON.stringify(replayEvent)}\n`),
					headers: {
						'content-type': 'application/json',
					},
					statusCode: 200,
				};
			},
			async streamEvents() {
				streamCallCount += 1;

				if (streamCallCount === 1) {
					setImmediate(() => {
						firstStream.end();
					});

					return {
						close() {
							firstStream.destroy();
						},
						headers: {
							'content-type': 'application/json',
						},
						statusCode: 200,
						stream: firstStream,
					};
				}

				setImmediate(() => {
					secondStream.write(`${JSON.stringify(liveEvent)}\n`);
				});

				return {
					close() {
						secondStream.destroy();
					},
					headers: {
						'content-type': 'application/json',
					},
					statusCode: 200,
					stream: secondStream,
				};
			},
		},
		async () => {
			const response = await dockerTrigger.trigger.call(context);

			await waitForCondition(() => emitted.length === 1, 2_500);
			assert.equal(replayCallCount >= 1, true);
			assert.equal(streamCallCount >= 2, true);
			assert.equal(emitted[0][0][0].json.action, 'stop');
			assert.equal(workflowStaticData.lastEventTime, liveEvent.time);
			assert.equal(workflowStaticData.lastEventTimeNano, liveEvent.timeNano);

			await response.closeFunction();
		},
	);
});

test('Docker Trigger recovers after an initial API negotiation failure on reconnect', async () => {
	const dockerTrigger = new DockerTrigger();
	const event = {
		Action: 'start',
		Actor: {
			ID: 'container-9',
		},
		Type: 'container',
		id: 'container-9',
		time: 1712982400,
		timeNano: 1712982400000000000,
	};
	let versionRequestCount = 0;
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');

		if (request.method === 'GET' && url.pathname === '/version') {
			versionRequestCount += 1;

			if (versionRequestCount === 1) {
				response.statusCode = 500;
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ message: 'daemon starting' }));
				return;
			}

			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ ApiVersion: '1.51' }));
			return;
		}

		if (request.method === 'GET' && url.pathname === '/v1.51/events') {
			response.setHeader('content-type', 'application/json');
			response.write(`${JSON.stringify(event)}\n`);
			return;
		}

		response.statusCode = 404;
		response.end(JSON.stringify({ message: 'not found' }));
	});

	try {
		await listen(server);

		const address = server.address();
		assert.notEqual(address, null);
		assert.equal(typeof address, 'object');

		const { context, emitted, workflowStaticData } = createTriggerContext({
			credentials: {
				accessMode: 'readOnly',
				apiVersion: 'auto',
				connectionMode: 'tcp',
				host: '127.0.0.1',
				port: address.port,
			},
			node: createNodeMetadata('Docker Trigger', 'dockerTrigger'),
			parameters: {
				actions: ['start'],
				resourceTypes: ['container'],
			},
		});
		const response = await dockerTrigger.trigger.call(context);

		try {
			await waitForCondition(() => emitted.length === 1, 4_000);

			assert.equal(versionRequestCount, 2);
			assert.equal(emitted[0][0][0].json.action, 'start');
			assert.equal(emitted[0][0][0].json.actorId, 'container-9');
			assert.equal(workflowStaticData.lastEventTime, event.time);
			assert.equal(workflowStaticData.lastEventTimeNano, event.timeNano);
		} finally {
			await response.closeFunction();
		}
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('Docker Trigger closeFunction stops delayed replay before it emits or opens a stream', async () => {
	const dockerTrigger = new DockerTrigger();
	const replayEvent = {
		Action: 'start',
		Actor: {
			ID: 'container-1',
		},
		Type: 'container',
		id: 'container-1',
		time: 1712982100,
		timeNano: 1712982100000000000,
	};
	const { context, emitted } = createTriggerContext({
		node: createNodeMetadata('Docker Trigger', 'dockerTrigger'),
		parameters: {
			actions: ['start'],
			resourceTypes: ['container'],
		},
		workflowStaticData: {
			lastEventTime: replayEvent.time,
			lastEventTimeNano: replayEvent.timeNano,
			recentEventKeys: [],
		},
	});
	let streamCallCount = 0;

	await withPatchedDockerClient(
		{
			async getEvents() {
				return await new Promise((resolve) => {
					setTimeout(() => {
						resolve({
							body: Buffer.from(`${JSON.stringify(replayEvent)}\n`),
							headers: {
								'content-type': 'application/json',
							},
							statusCode: 200,
						});
					}, 50);
				});
			},
			async streamEvents() {
				streamCallCount += 1;
				throw new Error('streamEvents should not be called after close');
			},
		},
		async () => {
			const response = await dockerTrigger.trigger.call(context);

			await response.closeFunction();
			await new Promise((resolve) => setTimeout(resolve, 100));

			assert.equal(emitted.length, 0);
			assert.equal(streamCallCount, 0);
		},
	);
});

test('Docker Trigger manual execution ignores stored cursor and waits for a fresh event', async () => {
	const dockerTrigger = new DockerTrigger();
	const stream = new PassThrough();
	const previousEventTime = 1712981000;
	const workflowStaticData = {
		lastEventTime: previousEventTime,
		lastEventTimeNano: 1712981000000000000,
		recentEventKeys: ['old-key'],
	};
	let capturedSince;
	const { context } = createTriggerContext({
		mode: 'manual',
		node: createNodeMetadata('Docker Trigger', 'dockerTrigger'),
		parameters: {
			actions: ['start'],
			resourceTypes: ['container'],
		},
		workflowStaticData,
	});

	await withPatchedDockerClient(
		{
			async streamEvents(options) {
				capturedSince = options.since;

				setImmediate(() => {
					stream.write(
						`${JSON.stringify({
							Action: 'start',
							Actor: { ID: 'container-2' },
							Type: 'container',
							id: 'container-2',
							time: 1712982200,
							timeNano: 1712982200000000000,
						})}\n`,
					);
				});

				return {
					close() {
						stream.destroy();
					},
					headers: {
						'content-type': 'application/json',
					},
					statusCode: 200,
					stream,
				};
			},
		},
		async () => {
			const response = await dockerTrigger.trigger.call(context);
			const items = await response.manualTriggerResponse;

			assert.equal(Number(capturedSince) > previousEventTime, true);
			assert.equal(items[0][0].json.actorId, 'container-2');
			assert.equal(workflowStaticData.lastEventTime, 1712982200);
		},
	);
});

test('Docker Trigger manual closeFunction rejects a pending manual trigger response', async () => {
	const dockerTrigger = new DockerTrigger();
	const stream = new PassThrough();
	const { context } = createTriggerContext({
		mode: 'manual',
		node: createNodeMetadata('Docker Trigger', 'dockerTrigger'),
		parameters: {
			actions: ['start'],
			resourceTypes: ['container'],
		},
	});
	let closeCount = 0;

	await withPatchedDockerClient(
		{
			async streamEvents() {
				return {
					close() {
						closeCount += 1;
						stream.destroy();
					},
					headers: {
						'content-type': 'application/json',
					},
					statusCode: 200,
					stream,
				};
			},
		},
		async () => {
			const response = await dockerTrigger.trigger.call(context);
			const pending = response.manualTriggerResponse;

			assert.notEqual(pending, undefined);

			await response.closeFunction();
			await assert.rejects(
				pending,
				/Docker Trigger manual execution was closed before an event was received/,
			);
			assert.equal(closeCount, 1);
		},
	);
});

test('Docker system events resumeFromCursor keeps same-second dedupe state bounded by the latest cursor', async () => {
	const dockerNode = new Docker();
	const sameSecondEvents = Array.from({ length: 101 }, (_, index) => ({
		Action: 'start',
		Actor: {
			ID: `container-${index}`,
		},
		Type: 'container',
		id: `container-${index}`,
		time: 1712982300,
		timeNano: 1712982300000000000 + index * 1024,
	}));
	const workflowStaticData = {};
	let callCount = 0;
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			eventsActions: ['start'],
			eventsLookbackSeconds: 300,
			eventsOutputMode: 'splitItems',
			eventsReadMode: 'resumeFromCursor',
			eventsResourceTypes: ['container'],
			operation: 'events',
			resource: 'system',
		},
		workflowStaticData,
	});

	await withPatchedDockerClient(
		{
			async getEvents() {
				callCount += 1;
				return {
					body: Buffer.from(
						`${sameSecondEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
					),
					headers: {
						'content-type': 'application/json',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [firstItems] = await dockerNode.execute.call(context);
			const [secondItems] = await dockerNode.execute.call(context);

			assert.equal(callCount, 2);
			assert.equal(firstItems.length, 101);
			assert.equal(secondItems.length, 0);
			assert.equal(workflowStaticData.recentEventKeys.length, 1);
			assert.equal(
				workflowStaticData.recentEventKeys[0],
				getDockerEventKey(sameSecondEvents[sameSecondEvents.length - 1]),
			);
		},
	);
});

test('Docker network connect builds the expected endpoint payload', async () => {
	const dockerNode = new Docker();
	const captured = {};
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			networkAliases: {
				values: [{ value: 'worker' }],
			},
			networkConnectAdvancedJson: '{}',
			networkContainerId: 'container-1',
			networkId: 'workflow-net',
			networkIpv4Address: '172.24.56.89',
			networkIpv6Address: '',
			operation: 'connect',
			resource: 'network',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async connectNetwork(networkId, body) {
				captured.connectNetwork = { body, networkId };
				return { changed: true, statusCode: 200 };
			},
			async inspectNetwork(networkId) {
				return { Id: 'network-1', Name: networkId };
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'connect');
			assert.equal(items[0].json.networkId, 'workflow-net');
			assert.equal(items[0].json.containerId, 'container-1');
			assert.deepEqual(captured.connectNetwork, {
				body: {
					Container: 'container-1',
					EndpointConfig: {
						Aliases: ['worker'],
						IPAMConfig: {
							IPv4Address: '172.24.56.89',
						},
					},
				},
				networkId: 'workflow-net',
			});
		},
	);
});

test('Docker volume create builds driver options and labels', async () => {
	const dockerNode = new Docker();
	const captured = {};
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			operation: 'create',
			resource: 'volume',
			volumeAdvancedJson: '{}',
			volumeDriver: 'local',
			volumeDriverOptions: {
				values: [{ name: 'type', value: 'tmpfs' }],
			},
			volumeLabels: {
				values: [{ name: 'team', value: 'ops' }],
			},
			volumeName: 'workflow-data',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async createVolume(body) {
				captured.createVolume = body;
				return { Driver: 'local', Labels: { team: 'ops' }, Name: 'workflow-data' };
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'create');
			assert.equal(items[0].json.Name, 'workflow-data');
			assert.deepEqual(captured.createVolume, {
				Driver: 'local',
				DriverOpts: {
					type: 'tmpfs',
				},
				Labels: {
					team: 'ops',
				},
				Name: 'workflow-data',
			});
		},
	);
});

test('Docker container create includes named volume mounts in HostConfig', async () => {
	const dockerNode = new Docker();
	const captured = {};
	const context = createExecuteContext({
		node: createNodeMetadata('Docker', 'docker'),
		parameters: {
			createAdvancedJson: '{}',
			createAutoRemove: false,
			createBindMounts: { values: [] },
			createCommandArgs: { values: [] },
			createEnv: { values: [] },
			createImage: 'alpine:3.20',
			createLabels: { values: [] },
			createName: 'demo',
			createNetworkMode: '',
			createOpenStdin: false,
			createPortBindings: { values: [] },
			createRestartPolicyMaximumRetryCount: 0,
			createRestartPolicyName: '',
			createTty: false,
			createUser: '',
			createVolumeMounts: {
				values: [{ readOnly: true, source: 'workflow-data', target: '/data' }],
			},
			createWorkingDir: '',
			operation: 'create',
			resource: 'container',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async createContainer(options) {
				captured.createContainer = options;
				return { Id: 'container-1', Warnings: [] };
			},
			async inspectContainer() {
				return { Id: 'container-1', Name: '/demo' };
			},
		},
		async () => {
			const [items] = await dockerNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'create');
			assert.deepEqual(captured.createContainer.body.HostConfig.Mounts, [
				{
					ReadOnly: true,
					Source: 'workflow-data',
					Target: '/data',
					Type: 'volume',
				},
			]);
		},
	);
});

test('Docker Files image save returns a tar binary payload', async () => {
	const dockerFilesNode = new DockerFiles();
	const archiveBody = Buffer.from('image-archive', 'utf8');
	const context = createExecuteContext({
		node: createNodeMetadata('Docker Files', 'dockerFiles'),
		parameters: {
			imageReferences: {
				values: [{ value: 'alpine:3.20' }, { value: 'busybox:latest' }],
			},
			operation: 'save',
			outputBinaryPropertyName: 'archive',
			resource: 'image',
			saveFileName: 'images.tar',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async saveImages(options) {
				assert.deepEqual(options, {
					names: ['alpine:3.20', 'busybox:latest'],
				});
				return {
					body: archiveBody,
					headers: {
						'content-type': 'application/x-tar',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerFilesNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'save');
			assert.equal(items[0].json.bytes, archiveBody.length);
			assert.deepEqual(items[0].json.imageReferences, ['alpine:3.20', 'busybox:latest']);
			assert.equal(items[0].binary.archive.fileName, 'images.tar');
			assert.equal(
				Buffer.from(items[0].binary.archive.data, 'base64').toString('utf8'),
				'image-archive',
			);
		},
	);
});

test('Docker Files image load consumes tar binary input and parses JSON-line output', async () => {
	const dockerFilesNode = new DockerFiles();
	const tarBuffer = Buffer.from('fake-tar-contents', 'utf8');
	const context = createExecuteContext({
		inputItems: [
			{
				binary: {
					archive: {
						data: tarBuffer.toString('base64'),
						fileName: 'images.tar',
					},
				},
				json: {},
			},
		],
		node: createNodeMetadata('Docker Files', 'dockerFiles'),
		parameters: {
			binaryPropertyName: 'archive',
			loadQuiet: true,
			operation: 'load',
			resource: 'image',
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async loadImages(options) {
				assert.equal(options.body.toString('utf8'), 'fake-tar-contents');
				assert.equal(options.quiet, true);
				return {
					body: Buffer.from(
						[
							JSON.stringify({ stream: 'Loaded image: alpine:3.20' }),
							JSON.stringify({ stream: 'Loaded image: busybox:latest' }),
							'',
						].join('\n'),
					),
					headers: {
						'content-type': 'application/json',
					},
					statusCode: 200,
				};
			},
		},
		async () => {
			const [items] = await dockerFilesNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'load');
			assert.equal(items[0].json.binaryPropertyName, 'archive');
			assert.equal(items[0].json.bytes, tarBuffer.length);
			assert.equal(items[0].json.messageCount, 2);
			assert.deepEqual(items[0].json.rawLines, [
				'{"stream":"Loaded image: alpine:3.20"}',
				'{"stream":"Loaded image: busybox:latest"}',
			]);
		},
	);
});

test('Docker Build build aggregates streamed progress output and extracts aux metadata', async () => {
	const dockerBuildNode = new DockerBuild();
	const tarBuffer = Buffer.from('fake-build-context', 'utf8');
	const context = createExecuteContext({
		inputItems: [
			{
				binary: {
					contextTar: {
						data: tarBuffer.toString('base64'),
						fileName: 'context.tar',
					},
				},
				json: {},
			},
		],
		node: createNodeMetadata('Docker Build', 'dockerBuild'),
		parameters: {
			binaryPropertyName: 'contextTar',
			buildAlwaysRemoveIntermediateContainers: true,
			buildArgs: {
				values: [{ name: 'NODE_ENV', value: 'production' }],
			},
			buildLabels: {
				values: [{ name: 'org.opencontainers.image.source', value: 'n8n' }],
			},
			buildNetworkMode: 'host',
			buildNoCache: true,
			buildPull: true,
			buildQuiet: true,
			buildRemoveIntermediateContainers: false,
			buildTags: {
				values: [{ value: 'demo:latest' }, { value: 'demo:1.0.0' }],
			},
			builderVersion: '2',
			dockerfilePath: 'docker/Dockerfile',
			operation: 'build',
			outputMode: 'aggregate',
			platform: 'linux/amd64',
			targetStage: 'runtime',
			timeoutSeconds: 30,
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async buildImage(options) {
				assert.deepEqual(options, {
					body: tarBuffer,
					buildArgs: { NODE_ENV: 'production' },
					dockerfile: 'docker/Dockerfile',
					forceRm: true,
					labels: { 'org.opencontainers.image.source': 'n8n' },
					networkMode: 'host',
					noCache: true,
					platform: 'linux/amd64',
					pull: true,
					quiet: true,
					rm: false,
					tags: ['demo:latest', 'demo:1.0.0'],
					target: 'runtime',
					timeoutMs: 0,
					version: '2',
				});

				return createDockerStreamResponse(
					Buffer.from(
						[
							JSON.stringify({ stream: '#1 building from tar context' }),
							JSON.stringify({
								aux: {
									Digest: 'sha256:digest-1',
									ID: 'sha256:image-1',
									Tags: ['demo:latest', 'demo:1.0.0'],
								},
							}),
							'',
						].join('\n'),
					),
				);
			},
		},
		async () => {
			const [items] = await dockerBuildNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'build');
			assert.equal(items[0].json.binaryPropertyName, 'contextTar');
			assert.equal(items[0].json.bytes, tarBuffer.length);
			assert.equal(items[0].json.builderVersion, '2');
			assert.equal(items[0].json.messageCount, 2);
			assert.equal(items[0].json.imageId, 'sha256:image-1');
			assert.equal(items[0].json.imageDigest, 'sha256:digest-1');
			assert.deepEqual(items[0].json.tags, ['demo:latest', 'demo:1.0.0']);
			assert.deepEqual(items[0].json.namedReferences, ['demo:latest', 'demo:1.0.0']);
		},
	);
});

test('Docker Build build can split streamed progress messages into separate items', async () => {
	const dockerBuildNode = new DockerBuild();
	const tarBuffer = Buffer.from('fake-build-context', 'utf8');
	const context = createExecuteContext({
		inputItems: [
			{
				binary: {
					contextTar: {
						data: tarBuffer.toString('base64'),
						fileName: 'context.tar',
					},
				},
				json: {},
			},
		],
		node: createNodeMetadata('Docker Build', 'dockerBuild'),
		parameters: {
			binaryPropertyName: 'contextTar',
			buildAlwaysRemoveIntermediateContainers: false,
			buildArgs: { values: [] },
			buildLabels: { values: [] },
			buildNetworkMode: '',
			buildNoCache: false,
			buildPull: false,
			buildQuiet: false,
			buildRemoveIntermediateContainers: true,
			buildTags: { values: [] },
			builderVersion: '1',
			dockerfilePath: 'Dockerfile',
			operation: 'build',
			outputMode: 'splitItems',
			platform: '',
			targetStage: '',
			timeoutSeconds: 30,
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async buildImage() {
				return createDockerStreamResponse(
					Buffer.from(
						[
							JSON.stringify({ stream: 'Step 1/2 : FROM alpine:3.20' }),
							JSON.stringify({ stream: 'Successfully built sha256:image-2' }),
							'',
						].join('\n'),
					),
				);
			},
		},
		async () => {
			const [items] = await dockerBuildNode.execute.call(context);

			assert.equal(items.length, 2);
			assert.equal(items[0].json.operation, 'build');
			assert.equal(items[0].json.messageIndex, 0);
			assert.equal(items[0].json.stream, 'Step 1/2 : FROM alpine:3.20');
			assert.equal(items[1].json.messageIndex, 1);
			assert.equal(items[1].json.stream, 'Successfully built sha256:image-2');
		},
	);
});

test('Docker Build surfaces missing binary input as a node operation error', async () => {
	const dockerBuildNode = new DockerBuild();
	const context = createExecuteContext({
		node: createNodeMetadata('Docker Build', 'dockerBuild'),
		parameters: {
			binaryPropertyName: 'missingTar',
			buildAlwaysRemoveIntermediateContainers: false,
			buildArgs: { values: [] },
			buildLabels: { values: [] },
			buildNetworkMode: '',
			buildNoCache: false,
			buildPull: false,
			buildQuiet: false,
			buildRemoveIntermediateContainers: true,
			buildTags: { values: [] },
			builderVersion: '2',
			dockerfilePath: 'Dockerfile',
			operation: 'build',
			outputMode: 'aggregate',
			timeoutSeconds: 30,
		},
	});

	await assert.rejects(async () => await dockerBuildNode.execute.call(context), (error) => {
		assert.equal(error.name, 'NodeOperationError');
		assert.equal(
			error.message.includes('Binary property "missingTar" was not found on the input item.'),
			true,
		);
		return true;
	});
});

test('Docker Build times out long-running build streams with a node operation error', async () => {
	const dockerBuildNode = new DockerBuild();
	const tarBuffer = Buffer.from('slow-build-context', 'utf8');
	const context = createExecuteContext({
		inputItems: [
			{
				binary: {
					contextTar: {
						data: tarBuffer.toString('base64'),
						fileName: 'context.tar',
					},
				},
				json: {},
			},
		],
		node: createNodeMetadata('Docker Build', 'dockerBuild'),
		parameters: {
			binaryPropertyName: 'contextTar',
			buildAlwaysRemoveIntermediateContainers: false,
			buildArgs: { values: [] },
			buildLabels: { values: [] },
			buildNetworkMode: '',
			buildNoCache: false,
			buildPull: false,
			buildQuiet: false,
			buildRemoveIntermediateContainers: true,
			buildTags: { values: [] },
			builderVersion: '2',
			dockerfilePath: 'Dockerfile',
			operation: 'build',
			outputMode: 'aggregate',
			timeoutSeconds: 1,
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async buildImage() {
				return createDockerStreamResponse(undefined);
			},
		},
		async () => {
			await assert.rejects(
				async () => await dockerBuildNode.execute.call(context),
				/timed out after 1 seconds/,
			);
		},
	);
});

test('Docker Build build surfaces Docker request metadata in continue-on-fail payloads', async () => {
	const dockerBuildNode = new DockerBuild();
	const tarBuffer = Buffer.from('broken-build-context', 'utf8');
	const context = createExecuteContext({
		continueOnFail: true,
		inputItems: [
			{
				binary: {
					contextTar: {
						data: tarBuffer.toString('base64'),
						fileName: 'context.tar',
					},
				},
				json: {},
			},
		],
		node: createNodeMetadata('Docker Build', 'dockerBuild'),
		parameters: {
			binaryPropertyName: 'contextTar',
			buildAlwaysRemoveIntermediateContainers: false,
			buildArgs: { values: [] },
			buildLabels: { values: [] },
			buildNetworkMode: '',
			buildNoCache: false,
			buildPull: false,
			buildQuiet: false,
			buildRemoveIntermediateContainers: true,
			buildTags: { values: [] },
			builderVersion: '2',
			dockerfilePath: 'Dockerfile',
			operation: 'build',
			outputMode: 'aggregate',
			timeoutSeconds: 30,
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async buildImage() {
				throw new DockerRequestError('Docker API request failed with status 500.', {
					bodyText: '{"message":"build failed"}',
					details: { message: 'build failed' },
					method: 'POST',
					path: '/v1.51/build',
					statusCode: 500,
				});
			},
		},
		async () => {
			const [items] = await dockerBuildNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.deepEqual(items[0].json, {
				error: 'Docker API request failed with status 500.',
				method: 'POST',
				operation: 'build',
				path: '/v1.51/build',
				response: '{"message":"build failed"}',
				statusCode: 500,
			});
		},
	);
});

test('Docker Build import aggregates streamed output and inspects the imported image when possible', async () => {
	const dockerBuildNode = new DockerBuild();
	const tarBuffer = Buffer.from('fake-image-archive', 'utf8');
	const context = createExecuteContext({
		inputItems: [
			{
				binary: {
					imageTar: {
						data: tarBuffer.toString('base64'),
						fileName: 'image.tar',
					},
				},
				json: {},
			},
		],
		node: createNodeMetadata('Docker Build', 'dockerBuild'),
		parameters: {
			binaryPropertyName: 'imageTar',
			importChanges: {
				values: [{ value: 'ENV DEBUG=true' }, { value: 'CMD [\"node\"]' }],
			},
			importMessage: 'imported from tar',
			importRepository: 'demo/imported',
			importTag: 'stable',
			operation: 'import',
			outputMode: 'aggregate',
			platform: 'linux/amd64',
			timeoutSeconds: 30,
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async importImage(options) {
				assert.deepEqual(options, {
					body: tarBuffer,
					changes: ['ENV DEBUG=true', 'CMD ["node"]'],
					message: 'imported from tar',
					platform: 'linux/amd64',
					repo: 'demo/imported',
					tag: 'stable',
					timeoutMs: 0,
				});

				return createDockerStreamResponse(
					Buffer.from(
						[
							JSON.stringify({ status: 'Importing image' }),
							JSON.stringify({ stream: 'Loaded image: demo/imported:stable' }),
							'',
						].join('\n'),
					),
				);
			},
			async inspectImage(reference) {
				assert.equal(reference, 'demo/imported:stable');
				return {
					Id: 'sha256:imported',
					RepoTags: ['demo/imported:stable'],
				};
			},
		},
		async () => {
			const [items] = await dockerBuildNode.execute.call(context);

			assert.equal(items.length, 1);
			assert.equal(items[0].json.operation, 'import');
			assert.equal(items[0].json.binaryPropertyName, 'imageTar');
			assert.equal(items[0].json.bytes, tarBuffer.length);
			assert.equal(items[0].json.repository, 'demo/imported');
			assert.equal(items[0].json.tag, 'stable');
			assert.equal(items[0].json.message, 'imported from tar');
			assert.deepEqual(items[0].json.changes, ['ENV DEBUG=true', 'CMD ["node"]']);
			assert.equal(items[0].json.messageCount, 2);
			assert.deepEqual(items[0].json.image, {
				Id: 'sha256:imported',
				RepoTags: ['demo/imported:stable'],
			});
		},
	);
});

test('Docker Build import timeout covers the post-import inspect step end-to-end', async () => {
	const dockerBuildNode = new DockerBuild();
	const tarBuffer = Buffer.from('fake-image-archive', 'utf8');
	const context = createExecuteContext({
		inputItems: [
			{
				binary: {
					imageTar: {
						data: tarBuffer.toString('base64'),
						fileName: 'image.tar',
					},
				},
				json: {},
			},
		],
		node: createNodeMetadata('Docker Build', 'dockerBuild'),
		parameters: {
			binaryPropertyName: 'imageTar',
			importChanges: { values: [] },
			importMessage: '',
			importRepository: 'demo/imported',
			importTag: 'stable',
			operation: 'import',
			outputMode: 'aggregate',
			platform: '',
			timeoutSeconds: 1,
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async importImage() {
				return createDockerStreamResponse(
					Buffer.from(
						[
							JSON.stringify({ status: 'Importing image' }),
							JSON.stringify({ stream: 'Loaded image: demo/imported:stable' }),
							'',
						].join('\n'),
					),
				);
			},
			async inspectImage() {
				await new Promise((resolve) => setTimeout(resolve, 1_500));
				return {
					Id: 'sha256:imported',
					RepoTags: ['demo/imported:stable'],
				};
			},
		},
		async () => {
			const startedAt = Date.now();

			await assert.rejects(
				async () => await dockerBuildNode.execute.call(context),
				/timed out after 1 seconds/,
			);
			assert.equal(Date.now() - startedAt < 1_400, true);
		},
	);
});

test('Docker Build import does not swallow cancellation during the post-import inspect step', async () => {
	const dockerBuildNode = new DockerBuild();
	const tarBuffer = Buffer.from('fake-image-archive', 'utf8');
	const abortController = new AbortController();
	const context = createExecuteContext({
		executionCancelSignal: abortController.signal,
		inputItems: [
			{
				binary: {
					imageTar: {
						data: tarBuffer.toString('base64'),
						fileName: 'image.tar',
					},
				},
				json: {},
			},
		],
		node: createNodeMetadata('Docker Build', 'dockerBuild'),
		parameters: {
			binaryPropertyName: 'imageTar',
			importChanges: { values: [] },
			importMessage: '',
			importRepository: 'demo/imported',
			importTag: 'stable',
			operation: 'import',
			outputMode: 'aggregate',
			platform: '',
			timeoutSeconds: 30,
		},
	});

	await withPatchedDockerClient(
		{
			accessMode: {
				get() {
					return 'fullControl';
				},
			},
			async importImage() {
				return createDockerStreamResponse(
					Buffer.from(
						[
							JSON.stringify({ status: 'Importing image' }),
							JSON.stringify({ stream: 'Loaded image: demo/imported:stable' }),
							'',
						].join('\n'),
					),
				);
			},
			async inspectImage() {
				setTimeout(() => abortController.abort(), 50);
				await new Promise((resolve) => setTimeout(resolve, 500));
				return {
					Id: 'sha256:imported',
					RepoTags: ['demo/imported:stable'],
				};
			},
		},
		async () => {
			const startedAt = Date.now();

			await assert.rejects(
				async () => await dockerBuildNode.execute.call(context),
				/was cancelled/,
			);
			assert.equal(Date.now() - startedAt < 400, true);
		},
	);
});
