const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const { Docker } = require('../dist/nodes/Docker/Docker.node.js');
const { DockerApiClient } = require('../dist/nodes/Docker/transport/dockerClient.js');
const { collectDockerStreamResponse } = require('../dist/nodes/Docker/transport/dockerStreams.js');
const { parseDockerJsonLines } = require('../dist/nodes/Docker/transport/dockerJsonLines.js');
const { parseDockerRawStream } = require('../dist/nodes/Docker/transport/dockerLogs.js');
const {
	createSingleFileTarArchive,
	extractSingleFileFromTarBuffer,
} = require('../dist/nodes/Docker/utils/tar.js');

const shouldRun = process.env.RUN_DOCKER_INTEGRATION === '1';
const shouldRunSsh = process.env.RUN_DOCKER_SSH_INTEGRATION === '1';

function docker(...args) {
	return execFileSync('docker', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function dockerAllowFailure(...args) {
	try {
		return docker(...args);
	} catch {
		return null;
	}
}

function ensureImage(imageReference) {
	if (dockerAllowFailure('image', 'inspect', imageReference) !== null) {
		return;
	}

	docker('pull', imageReference);
}

function createClient() {
	return new DockerApiClient({
		accessMode: 'fullControl',
		apiVersion: 'auto',
		connectionMode: 'unixSocket',
		socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
	});
}

function createDockerNodeContext(parameters) {
	return {
		continueOnFail() {
			return false;
		},
		async getCredentials() {
			return {
				accessMode: 'fullControl',
				apiVersion: 'auto',
				connectionMode: 'unixSocket',
				socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
			};
		},
		getExecutionCancelSignal() {
			return undefined;
		},
		getInputData() {
			return [{ json: {} }];
		},
		getNode() {
			return {
				id: '1',
				name: 'Docker',
				parameters: {},
				position: [0, 0],
				type: 'docker',
				typeVersion: 1,
			};
		},
		getNodeParameter(name, _itemIndex, defaultValue) {
			if (Object.hasOwn(parameters, name)) {
				return parameters[name];
			}

			return defaultValue;
		},
	};
}

function createSshClient() {
	const privateKeyPath = process.env.DOCKER_SSH_PRIVATE_KEY_PATH;

	if (privateKeyPath === undefined) {
		throw new Error('DOCKER_SSH_PRIVATE_KEY_PATH is required when RUN_DOCKER_SSH_INTEGRATION=1.');
	}

	return new DockerApiClient({
		accessMode: 'fullControl',
		apiVersion: 'auto',
		connectionMode: 'ssh',
		host: process.env.DOCKER_SSH_HOST || '127.0.0.1',
		privateKey: readFileSync(privateKeyPath, 'utf8'),
		remoteSocketPath: process.env.DOCKER_SSH_REMOTE_SOCKET_PATH || '/var/run/docker.sock',
		sshPort: Number(process.env.DOCKER_SSH_PORT || 22),
		username: process.env.DOCKER_SSH_USERNAME || 'docker',
	});
}

if (!shouldRun) {
	test.skip('Docker integration tests require RUN_DOCKER_INTEGRATION=1', () => {});
} else {
	test('Docker integration covers create/start/exec/wait/remove and file round-trips', async () => {
		docker('version');
		ensureImage('alpine:3.20');

		const client = createClient();
		const longRunningName = `n8n-docker-long-${randomUUID().slice(0, 8)}`;
		const shortLivedName = `n8n-docker-short-${randomUUID().slice(0, 8)}`;

		try {
			const createdLong = await client.createContainer({
				body: {
					Cmd: ['sh', '-c', 'sleep 60'],
					Image: 'alpine:3.20',
				},
				name: longRunningName,
			});
			assert.equal(typeof createdLong.Id, 'string');

			await client.startContainer(longRunningName);

			const execCreated = await client.createContainerExec(longRunningName, {
				AttachStderr: true,
				AttachStdout: true,
				Cmd: ['sh', '-c', 'printf copied'],
				Tty: false,
			});
			const execStarted = await client.startContainerExec(execCreated.Id, {
				Detach: false,
				Tty: false,
			});
			const execInspected = await client.inspectContainerExec(execCreated.Id);
			assert.equal(execInspected.ExitCode, 0);
			assert.equal(execStarted.body.toString('utf8').includes('copied'), true);

			const uploadTar = await createSingleFileTarArchive(
				'report.txt',
				Buffer.from('hello from integration'),
			);
			await client.putContainerArchive(longRunningName, {
				body: uploadTar,
				path: '/tmp',
			});
			const downloadedTar = await client.getContainerArchive(longRunningName, {
				path: '/tmp/report.txt',
			});
			const extracted = await extractSingleFileFromTarBuffer(downloadedTar.body);
			assert.equal(extracted.file.content.toString('utf8'), 'hello from integration');

			const exported = await client.exportContainer(longRunningName);
			assert.equal(exported.body.length > 0, true);

			const createdShort = await client.createContainer({
				body: {
					Cmd: ['sh', '-c', 'exit 7'],
					Image: 'alpine:3.20',
				},
				name: shortLivedName,
			});
			assert.equal(typeof createdShort.Id, 'string');
			await client.startContainer(shortLivedName);
			const waited = await client.waitForContainer(shortLivedName, {
				condition: 'not-running',
			});
			assert.equal(waited.StatusCode, 7);
		} finally {
			try {
				await client.removeContainer(shortLivedName, {
					force: true,
					removeVolumes: true,
				});
			} catch {}

			try {
				await client.removeContainer(longRunningName, {
					force: true,
					removeVolumes: true,
				});
			} catch {}
		}
	});

	test('Docker integration covers container text convenience operations', async () => {
		docker('version');
		ensureImage('alpine:3.20');

		const dockerNode = new Docker();
		const client = createClient();
		const containerName = `n8n-text-${randomUUID().slice(0, 8)}`;

		try {
			docker(
				'create',
				'--name',
				containerName,
				'alpine:3.20',
				'sh',
				'-lc',
				[
					'mkdir -p /workspace/src /workspace/search-ignored',
					'mkdir -p /workspace/.hidden-root/visible /workspace/.hidden-root/.nested-hidden',
					'printf "alpha\\r\\nbeta\\r\\ngamma\\r\\n" >/workspace/src/app.txt',
					'printf "sidecar\\n" >/workspace/src/other.txt',
					'printf "limit-one\\nlimit-two\\nlimit-three\\n" >/workspace/src/limit.txt',
					'printf "ignored.txt\\n" >/workspace/search-ignored/.ignore',
					'printf "needle\\n" >/workspace/search-ignored/ignored.txt',
					'printf "visible\\n" >/workspace/.hidden-root/visible/app.txt',
					'printf "secret\\n" >/workspace/.hidden-root/.nested-hidden/secret.txt',
					'sleep 60',
				].join(' && '),
			);
			docker('start', containerName);

			const [readWindowItems] = await dockerNode.execute.call(
				createDockerNodeContext({
					containerId: containerName,
					endLine: '3',
					filePath: 'src/app.txt',
					operation: 'readTextFile',
					resource: 'container',
					startLine: '2',
					workingPath: '/workspace',
				}),
			);
			assert.equal(readWindowItems.length, 1);
			assert.equal(readWindowItems[0].json.content, 'beta\ngamma');

			const [listItems] = await dockerNode.execute.call(
				createDockerNodeContext({
					containerId: containerName,
					glob: '',
					includeHidden: false,
					listFilesReturnAll: true,
					maxDepth: 3,
					operation: 'listFiles',
					resource: 'container',
					workingPath: '/workspace',
				}),
			);
			assert.equal(
				listItems.some(
					(item) =>
						item.json.path === 'src/app.txt' && item.json.entryType === 'file',
				),
				true,
			);
			const [hiddenRootListItems] = await dockerNode.execute.call(
				createDockerNodeContext({
					containerId: containerName,
					glob: '',
					includeHidden: false,
					listFilesReturnAll: true,
					maxDepth: 3,
					operation: 'listFiles',
					resource: 'container',
					workingPath: '/workspace/.hidden-root',
				}),
			);
			assert.deepEqual(
				hiddenRootListItems.map((item) => item.json.path),
				['visible', 'visible/app.txt'],
			);

			const [searchItems] = await dockerNode.execute.call(
				createDockerNodeContext({
					caseSensitive: false,
					containerId: containerName,
					glob: '*.txt',
					operation: 'searchText',
					query: 'beta',
					resource: 'container',
					searchTextReturnAll: true,
					workingPath: '/workspace',
				}),
			);
			assert.equal(searchItems.length, 1);
			assert.equal(searchItems[0].json.path, 'src/app.txt');
			assert.equal(searchItems[0].json.line, 2);
			assert.equal(searchItems[0].json.text, 'beta');
			const [limitedSearchItems] = await dockerNode.execute.call(
				createDockerNodeContext({
					caseSensitive: false,
					containerId: containerName,
					glob: '*.txt',
					operation: 'searchText',
					query: 'limit',
					resource: 'container',
					searchTextLimit: 2,
					searchTextReturnAll: false,
					workingPath: '/workspace',
				}),
			);
			assert.equal(limitedSearchItems.length, 2);
			assert.deepEqual(
				limitedSearchItems.map((item) => item.json.text),
				['limit-one', 'limit-two'],
			);

			const [ignoredSearchItems] = await dockerNode.execute.call(
				createDockerNodeContext({
					caseSensitive: false,
					containerId: containerName,
					glob: '*.txt',
					operation: 'searchText',
					query: 'needle',
					resource: 'container',
					searchTextReturnAll: true,
					workingPath: '/workspace/search-ignored',
				}),
			);
			assert.equal(ignoredSearchItems.length, 1);
			assert.equal(ignoredSearchItems[0].json.path, 'ignored.txt');

			const [replaceItems] = await dockerNode.execute.call(
				createDockerNodeContext({
					containerId: containerName,
					filePath: 'src/app.txt',
					newText: 'BETA',
					oldText: 'beta',
					operation: 'replaceExactText',
					resource: 'container',
					workingPath: '/workspace',
				}),
			);
			assert.equal(replaceItems[0].json.replacementCount, 1);

			const replacedArchive = await client.getContainerArchive(containerName, {
				path: '/workspace/src/app.txt',
			});
			const replacedFile = await extractSingleFileFromTarBuffer(replacedArchive.body);
			assert.equal(replacedFile.file.content.toString('utf8'), 'alpha\r\nBETA\r\ngamma\r\n');

			const [writeItems] = await dockerNode.execute.call(
				createDockerNodeContext({
					containerId: containerName,
					content: 'hello convenience\n',
					createParentDirectories: true,
					filePath: 'generated/new.txt',
					operation: 'writeTextFile',
					resource: 'container',
					workingPath: '/workspace',
				}),
			);
			assert.equal(writeItems[0].json.bytesWritten > 0, true);

			const [verifyAppItems] = await dockerNode.execute.call(
				createDockerNodeContext({
					containerId: containerName,
					filePath: 'src/app.txt',
					operation: 'readTextFile',
					resource: 'container',
					workingPath: '/workspace',
				}),
			);
			assert.equal(verifyAppItems[0].json.content, 'alpha\nBETA\ngamma');

			const [verifyWriteItems] = await dockerNode.execute.call(
				createDockerNodeContext({
					containerId: containerName,
					filePath: 'generated/new.txt',
					operation: 'readTextFile',
					resource: 'container',
					workingPath: '/workspace',
				}),
			);
			assert.equal(verifyWriteItems[0].json.content, 'hello convenience');

			await assert.rejects(
				async () =>
					await dockerNode.execute.call(
						createDockerNodeContext({
							containerId: containerName,
							glob: '',
							includeHidden: false,
							listFilesReturnAll: true,
							maxDepth: 3,
							operation: 'listFiles',
							resource: 'container',
							workingPath: '/workspace/missing',
						}),
					),
				/Working Path "\/workspace\/missing" was not found in the container\./,
			);
			await assert.rejects(
				async () =>
					await dockerNode.execute.call(
						createDockerNodeContext({
							caseSensitive: false,
							containerId: containerName,
							glob: '*.txt',
							operation: 'searchText',
							query: 'needle',
							resource: 'container',
							searchTextReturnAll: true,
							workingPath: '/workspace/missing',
						}),
					),
				/Working Path "\/workspace\/missing" was not found in the container\./,
			);
		} finally {
			dockerAllowFailure('rm', '-f', containerName);
		}
	});

	test('Docker integration covers Phase 3 image and system operations', async () => {
		docker('version');
		ensureImage('alpine:3.20');

		const client = createClient();
		const testId = randomUUID().slice(0, 8);
		const tempTagRepository = `n8n-phase3-image-${testId}`;
		const tempTaggedImage = `${tempTagRepository}:latest`;
		const pruneLabel = `n8n.integration.image=${testId}`;
		const pruneContainerName = `n8n-image-prune-src-${testId}`;
		const pruneImage = `n8n-phase3-prune:${testId}`;
		const eventContainerName = `n8n-events-${testId}`;

		try {
			const images = await client.listImages({ all: true });
			assert.equal(images.some((image) => (image.RepoTags ?? []).includes('alpine:3.20')), true);

			const pullResponse = await client.pullImage({ fromImage: 'alpine:3.20' });
			const pullMessages = parseDockerJsonLines(pullResponse.body, pullResponse.headers['content-type']);
			assert.equal(pullMessages.rawLines.length > 0, true);

			const tagged = await client.tagImage('alpine:3.20', {
				repo: tempTagRepository,
				tag: 'latest',
			});
			assert.deepEqual(tagged, { changed: true, statusCode: 201 });

			const inspected = await client.inspectImage(tempTaggedImage);
			assert.equal(typeof inspected.Id, 'string');

			const history = await client.getImageHistory(tempTaggedImage, {});
			assert.equal(Array.isArray(history), true);
			assert.equal(history.length > 0, true);

			const saved = await client.saveImages({ names: ['alpine:3.20'] });
			assert.equal(saved.body.length > 0, true);

			const loaded = await client.loadImages({
				body: saved.body,
				quiet: true,
			});
			const loadMessages = parseDockerJsonLines(loaded.body, loaded.headers['content-type']);
			assert.equal(
				loadMessages.rawLines.some((line) => line.includes('Loaded image')),
				true,
			);

			const removedTag = await client.removeImage(tempTaggedImage, {
				force: false,
				noPrune: true,
			});
			assert.equal(
				removedTag.some((entry) => Object.values(entry).some((value) => String(value).includes(tempTagRepository))),
				true,
			);

			docker('create', '--name', pruneContainerName, 'alpine:3.20', 'true');
			docker('commit', '--change', `LABEL ${pruneLabel}`, pruneContainerName, pruneImage);
			docker('rm', '-f', pruneContainerName);

			const prunedImages = await client.pruneImages({
				filters: JSON.stringify({
					dangling: ['false'],
					label: [pruneLabel],
				}),
			});
			assert.equal(Array.isArray(prunedImages.ImagesDeleted), true);
			assert.equal(dockerAllowFailure('image', 'inspect', pruneImage), null);

			const df = await client.getSystemDataUsage();
			assert.equal(Array.isArray(df.Images), true);
			assert.equal(Array.isArray(df.Containers), true);
			assert.equal(Array.isArray(df.Volumes), true);

			await client.createContainer({
				body: {
					Cmd: ['sh', '-c', 'sleep 60'],
					Image: 'alpine:3.20',
				},
				name: eventContainerName,
				});
				const eventSince = String(Math.floor(Date.now() / 1000) - 10);
				await client.startContainer(eventContainerName);
				await client.stopContainer(eventContainerName, { timeoutSeconds: 1 });
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				const eventUntil = String(Math.floor(Date.now() / 1000));
			const eventsResponse = await client.getEvents({
				filters: JSON.stringify({
					container: [eventContainerName],
					event: ['start', 'stop'],
					type: ['container'],
				}),
				since: eventSince,
				until: eventUntil,
			});
			const events = parseDockerJsonLines(
				eventsResponse.body,
				eventsResponse.headers['content-type'],
			);
			const eventActions = events.entries.map((event) => event.Action);
			assert.equal(eventActions.includes('start'), true);
			assert.equal(eventActions.includes('stop'), true);
		} finally {
			dockerAllowFailure('rm', '-f', pruneContainerName);
			dockerAllowFailure('rm', '-f', eventContainerName);
			dockerAllowFailure('image', 'rm', '-f', pruneImage);
			dockerAllowFailure('image', 'rm', '-f', tempTaggedImage);
		}
	});

	test('Docker integration covers Phase 3 network and volume operations', async () => {
		docker('version');
		ensureImage('alpine:3.20');

		const client = createClient();
		const testId = randomUUID().slice(0, 8);
		const networkName = `n8n-net-${testId}`;
		const networkPruneName = `n8n-net-prune-${testId}`;
		const volumeName = `n8n-vol-${testId}`;
		const volumePruneName = `n8n-vol-prune-${testId}`;
		const containerName = `n8n-net-ctr-${testId}`;
		const pruneLabel = `n8n.integration.phase3=${testId}`;

		try {
			const createdNetwork = await client.createNetwork({
				Attachable: true,
				Driver: 'bridge',
				Labels: {
					'n8n.integration.phase3': testId,
				},
				Name: networkName,
			});
			assert.equal(typeof createdNetwork.Id, 'string');

			const inspectedNetwork = await client.inspectNetwork(networkName);
			assert.equal(inspectedNetwork.Name, networkName);

			const listedNetworks = await client.listNetworks();
			assert.equal(listedNetworks.some((network) => network.Name === networkName), true);

			await client.createContainer({
				body: {
					Cmd: ['sh', '-c', 'sleep 60'],
					Image: 'alpine:3.20',
				},
				name: containerName,
			});
			await client.startContainer(containerName);

			const connectResult = await client.connectNetwork(networkName, {
				Container: containerName,
				EndpointConfig: {
					Aliases: ['worker'],
				},
			});
			assert.deepEqual(connectResult, { changed: true, statusCode: 200 });

			const connectedNetwork = await client.inspectNetwork(networkName);
			assert.equal(
				Object.values(connectedNetwork.Containers ?? {}).some(
					(container) => container.Name === containerName,
				),
				true,
			);

			const disconnectResult = await client.disconnectNetwork(networkName, {
				Container: containerName,
				Force: true,
			});
			assert.deepEqual(disconnectResult, { changed: true, statusCode: 200 });

			const disconnectedNetwork = await client.inspectNetwork(networkName);
			assert.equal(
				Object.values(disconnectedNetwork.Containers ?? {}).some(
					(container) => container.Name === containerName,
				),
				false,
			);

			const deleteNetworkResult = await client.deleteNetwork(networkName);
			assert.deepEqual(deleteNetworkResult, { changed: true, statusCode: 204 });

			await client.createNetwork({
				Driver: 'bridge',
				Labels: {
					'n8n.integration.phase3': testId,
				},
				Name: networkPruneName,
			});
			const prunedNetworks = await client.pruneNetworks({
				filters: JSON.stringify({
					label: [pruneLabel],
				}),
			});
			assert.equal(prunedNetworks.NetworksDeleted.includes(networkPruneName), true);

			const createdVolume = await client.createVolume({
				Driver: 'local',
				Labels: {
					'n8n.integration.phase3': testId,
				},
				Name: volumeName,
			});
			assert.equal(createdVolume.Name, volumeName);

			const inspectedVolume = await client.inspectVolume(volumeName);
			assert.equal(inspectedVolume.Name, volumeName);

			const listedVolumes = await client.listVolumes({});
			assert.equal(
				Array.isArray(listedVolumes.Volumes) &&
					listedVolumes.Volumes.some((volume) => volume.Name === volumeName),
				true,
			);

			const deletedVolume = await client.deleteVolume(volumeName, { force: true });
			assert.deepEqual(deletedVolume, { changed: true, statusCode: 204 });

			await client.createVolume({
				Driver: 'local',
				Labels: {
					'n8n.integration.phase3': testId,
				},
				Name: volumePruneName,
			});
			const prunedVolumes = await client.pruneVolumes({
				filters: JSON.stringify({
					all: ['true'],
					label: [pruneLabel],
				}),
			});
			assert.equal(prunedVolumes.VolumesDeleted.includes(volumePruneName), true);
		} finally {
			dockerAllowFailure('rm', '-f', containerName);
			dockerAllowFailure('network', 'rm', networkName);
			dockerAllowFailure('network', 'rm', networkPruneName);
			dockerAllowFailure('volume', 'rm', '-f', volumeName);
			dockerAllowFailure('volume', 'rm', '-f', volumePruneName);
		}
	});

	test('Docker integration covers Phase 4 event and log streaming endpoints', async () => {
		docker('version');
		ensureImage('alpine:3.20');

		const client = createClient();
		const testId = randomUUID().slice(0, 8);
		const eventContainerName = `n8n-trigger-${testId}`;
		const logContainerName = `n8n-log-stream-${testId}`;

		try {
			await client.createContainer({
				body: {
					Cmd: ['sh', '-c', 'sleep 60'],
					Image: 'alpine:3.20',
				},
				name: eventContainerName,
			});

			const eventAbortController = new AbortController();
			const eventTimeout = setTimeout(() => {
				eventAbortController.abort();
			}, 2_000);
			const eventsResponse = await client.streamEvents(
				{
					filters: JSON.stringify({
						container: [eventContainerName],
						event: ['start', 'stop'],
						type: ['container'],
					}),
					since: String(Math.floor(Date.now() / 1000) - 1),
				},
				eventAbortController.signal,
			);

			await client.startContainer(eventContainerName);
			await client.stopContainer(eventContainerName, { timeoutSeconds: 1 });

			const eventsBuffer = await collectDockerStreamResponse(
				eventsResponse,
				eventAbortController.signal,
			);
			clearTimeout(eventTimeout);
			const events = parseDockerJsonLines(
				eventsBuffer,
				eventsResponse.headers['content-type'],
			);
			const eventActions = events.entries.map((event) => event.Action);
			assert.equal(eventActions.includes('start'), true);
			assert.equal(eventActions.includes('stop'), true);

			await client.createContainer({
				body: {
					Cmd: [
						'sh',
						'-c',
						'sleep 1; i=0; while [ "$i" -lt 5 ]; do printf "phase4-%s\\n" "$i"; i=$((i+1)); sleep 1; done',
					],
					Image: 'alpine:3.20',
				},
				name: logContainerName,
			});
			await client.startContainer(logContainerName);

			const logAbortController = new AbortController();
			const logTimeout = setTimeout(() => {
				logAbortController.abort();
			}, 3_500);
			const logsResponse = await client.streamContainerLogs(
				logContainerName,
				{
					follow: true,
					stderr: true,
					stdout: true,
					tail: 'all',
					timestamps: false,
				},
				logAbortController.signal,
			);
			const logsBuffer = await collectDockerStreamResponse(
				logsResponse,
				logAbortController.signal,
			);
			clearTimeout(logTimeout);
			const logs = parseDockerRawStream(logsBuffer, logsResponse.headers['content-type']);

			assert.equal(logs.streamText.stdout.includes('phase4-0'), true);
			assert.equal(logs.streamText.stdout.includes('phase4-1'), true);
		} finally {
			dockerAllowFailure('rm', '-f', eventContainerName);
			dockerAllowFailure('rm', '-f', logContainerName);
		}
	});

	test('Docker integration covers Phase 5 build and import streaming endpoints', async () => {
		docker('version');
		ensureImage('alpine:3.20');

		const client = createClient();
		const testId = randomUUID().slice(0, 8);
		const builtImage = `n8n-phase5-build:${testId}`;
		const importRepository = `n8n-phase5-import-${testId}`;
		const importedImage = `${importRepository}:latest`;
		const exportContainerName = `n8n-phase5-export-${testId}`;

		try {
			const buildContext = await createSingleFileTarArchive(
				'Dockerfile',
				Buffer.from('FROM alpine:3.20\nRUN printf phase5-build >/build-proof.txt\n'),
			);
			const buildResponse = await client.buildImage({
				body: buildContext,
				tags: [builtImage],
				timeoutMs: 0,
				version: '2',
			});
			const buildBuffer = await collectDockerStreamResponse(buildResponse);
			const buildMessages = parseDockerJsonLines(
				buildBuffer,
				buildResponse.headers['content-type'],
			);

			assert.equal(buildMessages.entries.length > 0, true);
			assert.equal(
				buildMessages.entries.some((entry) => entry.aux?.ID !== undefined || entry.stream !== undefined),
				true,
			);

			const inspectedBuiltImage = await client.inspectImage(builtImage);
			assert.equal(typeof inspectedBuiltImage.Id, 'string');

			await client.createContainer({
				body: {
					Cmd: ['sh', '-c', 'printf imported-phase5 >/import-proof.txt'],
					Image: 'alpine:3.20',
				},
				name: exportContainerName,
			});
			await client.startContainer(exportContainerName);
			await client.waitForContainer(exportContainerName, {
				condition: 'not-running',
			});

			const exported = await client.exportContainer(exportContainerName);
			assert.equal(exported.body.length > 0, true);

			const importResponse = await client.importImage({
				body: exported.body,
				message: 'phase5 import integration',
				repo: importRepository,
				tag: 'latest',
				timeoutMs: 0,
			});
			const importBuffer = await collectDockerStreamResponse(importResponse);
			const importMessages = parseDockerJsonLines(
				importBuffer,
				importResponse.headers['content-type'],
			);

			assert.equal(importMessages.entries.length > 0, true);

			const inspectedImportedImage = await client.inspectImage(importedImage);
			assert.equal(typeof inspectedImportedImage.Id, 'string');
		} finally {
			dockerAllowFailure('rm', '-f', exportContainerName);
			dockerAllowFailure('image', 'rm', '-f', builtImage);
			dockerAllowFailure('image', 'rm', '-f', importedImage);
		}
	});
	}

if (!shouldRunSsh) {
	test.skip('Docker SSH integration tests require RUN_DOCKER_SSH_INTEGRATION=1', () => {});
} else {
	test('Docker SSH integration covers ping, logs, build, and import', async () => {
		docker('version');
		ensureImage('alpine:3.20');

		const client = createSshClient();
		const testId = randomUUID().slice(0, 8);
		const runningContainerName = `n8n-ssh-log-${testId}`;
		const importSourceContainerName = `n8n-ssh-import-src-${testId}`;
		const builtImage = `n8n-ssh-build:${testId}`;
		const importedImage = `n8n-ssh-import:${testId}`;

		try {
			const ping = await client.ping();
			assert.equal(ping.ok, true);

			const info = await client.getInfo();
			assert.equal(typeof info.ServerVersion === 'string' || typeof info.ServerVersion === 'undefined', true);

			docker(
				'run',
				'-d',
				'--name',
				runningContainerName,
				'alpine:3.20',
				'sh',
				'-c',
				'sleep 1; i=0; while [ "$i" -lt 3 ]; do printf "ssh-integration-%s\\n" "$i"; i=$((i+1)); sleep 1; done',
			);
			const logAbortController = new AbortController();
			const logTimeout = setTimeout(() => {
				logAbortController.abort();
			}, 5_000);
			const logsResponse = await client.streamContainerLogs(
				runningContainerName,
				{
					follow: true,
					stderr: true,
					stdout: true,
					tail: 'all',
					timestamps: false,
				},
				logAbortController.signal,
			);
			const logsBuffer = await collectDockerStreamResponse(
				logsResponse,
				logAbortController.signal,
			);
			clearTimeout(logTimeout);
			const logs = parseDockerRawStream(logsBuffer, logsResponse.headers['content-type']);
			assert.equal(logs.text.includes('ssh-integration-0'), true);
			assert.equal(logs.text.includes('ssh-integration-1'), true);

			const buildContext = await createSingleFileTarArchive(
				'Dockerfile',
				Buffer.from('FROM alpine:3.20\nCMD ["true"]\n'),
			);
			const buildResponse = await client.buildImage({
				body: buildContext,
				tags: [builtImage],
				timeoutMs: 0,
				version: '2',
			});
			const buildBuffer = await collectDockerStreamResponse(buildResponse);
			const buildMessages = parseDockerJsonLines(
				buildBuffer,
				buildResponse.headers['content-type'],
			);
			assert.equal(buildMessages.rawLines.length > 0, true);
			const inspectedBuiltImage = await client.inspectImage(builtImage);
			assert.equal(typeof inspectedBuiltImage.Id, 'string');

			docker('create', '--name', importSourceContainerName, 'alpine:3.20', 'true');
			const exportedImportSource = execFileSync(
				'docker',
				['export', importSourceContainerName],
				{
					encoding: null,
					maxBuffer: 20 * 1024 * 1024,
					stdio: ['ignore', 'pipe', 'pipe'],
				},
			);
			const importResponse = await client.importImage({
				body: exportedImportSource,
				repo: 'n8n-ssh-import',
				tag: testId,
				timeoutMs: 0,
			});
			const importBuffer = await collectDockerStreamResponse(importResponse);
			const importMessages = parseDockerJsonLines(
				importBuffer,
				importResponse.headers['content-type'],
			);
			assert.equal(importMessages.rawLines.length > 0, true);
			const inspectedImportedImage = await client.inspectImage(importedImage);
			assert.equal(typeof inspectedImportedImage.Id, 'string');
		} finally {
			await client.close();
			dockerAllowFailure('rm', '-f', runningContainerName);
			dockerAllowFailure('rm', '-f', importSourceContainerName);
			dockerAllowFailure('image', 'rm', '-f', builtImage);
			dockerAllowFailure('image', 'rm', '-f', importedImage);
		}
	});
}
