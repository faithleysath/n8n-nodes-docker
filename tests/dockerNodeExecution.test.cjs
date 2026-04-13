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
