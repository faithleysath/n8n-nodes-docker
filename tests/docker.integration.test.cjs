const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const { DockerApiClient } = require('../dist/nodes/Docker/transport/dockerClient.js');
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
		docker('pull', 'alpine:3.20');

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
}
