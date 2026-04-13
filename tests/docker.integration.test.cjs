const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const { DockerApiClient } = require('../dist/nodes/Docker/transport/dockerClient.js');
const { collectDockerStreamResponse } = require('../dist/nodes/Docker/transport/dockerStreams.js');
const { parseDockerJsonLines } = require('../dist/nodes/Docker/transport/dockerJsonLines.js');
const { parseDockerRawStream } = require('../dist/nodes/Docker/transport/dockerLogs.js');
const {
	createSingleFileTarArchive,
	extractSingleFileFromTarBuffer,
} = require('../dist/nodes/Docker/utils/tar.js');

const shouldRun = process.env.RUN_DOCKER_INTEGRATION === '1';

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
