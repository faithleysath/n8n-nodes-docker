const assert = require('node:assert/strict');
const test = require('node:test');

const { Docker } = require('../dist/nodes/Docker/Docker.node.js');
const { DockerBuild } = require('../dist/nodes/DockerBuild/DockerBuild.node.js');
const { DockerFiles } = require('../dist/nodes/DockerFiles/DockerFiles.node.js');
const { DockerTrigger } = require('../dist/nodes/DockerTrigger/DockerTrigger.node.js');
const { evaluateExecPolicy } = require('../dist/nodes/Docker/utils/execPolicy.js');
const {
	createSingleFileTarArchive,
	decodeContainerArchiveStatHeader,
	extractSingleFileFromTarBuffer,
} = require('../dist/nodes/Docker/utils/tar.js');

test('Docker remains AI-usable while Docker Files is not', () => {
	const dockerNode = new Docker();
	const dockerBuildNode = new DockerBuild();
	const dockerFilesNode = new DockerFiles();
	const dockerTriggerNode = new DockerTrigger();

	assert.equal(dockerNode.description.usableAsTool, true);
	assert.notEqual(dockerBuildNode.description.usableAsTool, true);
	assert.notEqual(dockerFilesNode.description.usableAsTool, true);
	assert.notEqual(dockerTriggerNode.description.usableAsTool, true);
	assert.deepEqual(dockerTriggerNode.description.group, ['trigger']);
	assert.deepEqual(dockerTriggerNode.description.inputs, []);
	assert.deepEqual(dockerTriggerNode.description.outputs, ['main']);
	assert.equal(dockerBuildNode.description.credentials[0].name, 'dockerApi');

	const dockerContainerOperationProperty = dockerNode.description.properties.find(
		(property) =>
			property.name === 'operation' &&
			property.displayOptions?.show?.resource?.includes?.('container'),
	);
	const dockerFilesOperationProperty = dockerFilesNode.description.properties.find(
		(property) =>
			property.name === 'operation' &&
			property.displayOptions?.show?.resource?.includes?.('container'),
	);
	const dockerImageOperationProperty = dockerNode.description.properties.find(
		(property) =>
			property.name === 'operation' &&
			property.displayOptions?.show?.resource?.includes?.('image'),
	);
	const dockerNetworkOperationProperty = dockerNode.description.properties.find(
		(property) =>
			property.name === 'operation' &&
			property.displayOptions?.show?.resource?.includes?.('network'),
	);
	const dockerVolumeOperationProperty = dockerNode.description.properties.find(
		(property) =>
			property.name === 'operation' &&
			property.displayOptions?.show?.resource?.includes?.('volume'),
	);
	const dockerSystemOperationProperty = dockerNode.description.properties.find(
		(property) =>
			property.name === 'operation' &&
			property.displayOptions?.show?.resource?.includes?.('system'),
	);
	const dockerFilesImageOperationProperty = dockerFilesNode.description.properties.find(
		(property) =>
			property.name === 'operation' &&
			property.displayOptions?.show?.resource?.includes?.('image'),
	);
	const dockerBuildOperationProperty = dockerBuildNode.description.properties.find(
		(property) => property.name === 'operation',
	);

	assert.deepEqual(
		dockerContainerOperationProperty.options.map((option) => option.value),
		['create', 'exec', 'inspect', 'list', 'logs', 'remove', 'restart', 'start', 'stats', 'stop', 'top', 'update', 'wait'],
	);
	assert.deepEqual(
		dockerFilesOperationProperty.options.map((option) => option.value),
		['copyFrom', 'copyTo', 'export'],
	);
	assert.deepEqual(
		dockerImageOperationProperty.options.map((option) => option.value),
		['history', 'inspect', 'list', 'prune', 'pull', 'remove', 'tag'],
	);
	assert.deepEqual(
		dockerNetworkOperationProperty.options.map((option) => option.value),
		['connect', 'create', 'delete', 'disconnect', 'inspect', 'list', 'prune'],
	);
	assert.deepEqual(
		dockerVolumeOperationProperty.options.map((option) => option.value),
		['create', 'delete', 'inspect', 'list', 'prune'],
	);
	assert.deepEqual(
		dockerSystemOperationProperty.options.map((option) => option.value),
		['df', 'events', 'info', 'ping', 'version'],
	);
	assert.deepEqual(
		dockerFilesImageOperationProperty.options.map((option) => option.value),
		['load', 'save'],
	);
	assert.deepEqual(
		dockerBuildOperationProperty.options.map((option) => option.value),
		['build', 'import'],
	);
	assert.deepEqual(
		dockerTriggerNode.description.properties
			.find((property) => property.name === 'resourceTypes')
			.options.map((option) => option.value),
		['container', 'daemon', 'image', 'network', 'volume'],
	);
	assert.deepEqual(
		dockerTriggerNode.description.properties
			.find((property) => property.name === 'actions')
			.options.map((option) => option.value),
		['create', 'destroy', 'die', 'pull', 'remove', 'restart', 'start', 'stop'],
	);
});

test('evaluateExecPolicy applies allow and deny lists to argv[0] names', () => {
	assert.deepEqual(evaluateExecPolicy('/bin/sh', [], []), {
		commandName: 'sh',
		requiresAllowListMatch: false,
	});
	assert.deepEqual(evaluateExecPolicy('python', ['python'], []), {
		commandName: 'python',
		requiresAllowListMatch: true,
	});
	assert.deepEqual(evaluateExecPolicy('python', ['node'], []), {
		commandName: 'python',
		deniedBy: 'allowList',
		requiresAllowListMatch: true,
	});
	assert.deepEqual(evaluateExecPolicy('python', [], ['python']), {
		commandName: 'python',
		deniedBy: 'denyList',
		requiresAllowListMatch: false,
	});
	assert.deepEqual(evaluateExecPolicy('/usr/bin/bash', ['bash'], ['bash']), {
		commandName: 'bash',
		deniedBy: 'denyList',
		requiresAllowListMatch: true,
	});
});

test('tar helpers round-trip a single file and decode archive headers', async () => {
	const tarBuffer = await createSingleFileTarArchive('report.txt', Buffer.from('hello world'));
	const extracted = await extractSingleFileFromTarBuffer(tarBuffer);
	const headerValue = Buffer.from(
		JSON.stringify({
			linkTarget: '',
			mode: 420,
			mtime: '2026-04-13T00:00:00Z',
			name: 'report.txt',
			size: 11,
		}),
	).toString('base64');

	assert.equal(extracted.entryCount, 1);
	assert.equal(extracted.reason, undefined);
	assert.equal(extracted.file.fileName, 'report.txt');
	assert.equal(extracted.file.content.toString('utf8'), 'hello world');
	assert.deepEqual(decodeContainerArchiveStatHeader(headerValue), {
		linkTarget: '',
		mode: 420,
		mtime: '2026-04-13T00:00:00Z',
		name: 'report.txt',
		size: 11,
	});
});
