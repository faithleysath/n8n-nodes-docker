const assert = require('node:assert/strict');
const test = require('node:test');

const { Docker } = require('../dist/nodes/Docker/Docker.node.js');
const { DockerFiles } = require('../dist/nodes/DockerFiles/DockerFiles.node.js');
const {
	DockerApiClient,
	DockerRequestError,
} = require('../dist/nodes/Docker/transport/dockerClient.js');
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
	inputItems = [{ json: {} }],
	node,
	parameters,
} = {}) {
	return {
		continueOnFail() {
			return continueOnFail;
		},
		async getCredentials() {
			return credentials;
		},
		getExecutionCancelSignal() {
			return undefined;
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
