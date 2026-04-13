const assert = require('node:assert/strict');
const test = require('node:test');

const { Docker } = require('../dist/nodes/Docker/Docker.node.js');
const { DockerFiles } = require('../dist/nodes/DockerFiles/DockerFiles.node.js');
const { evaluateExecPolicy } = require('../dist/nodes/Docker/utils/execPolicy.js');
const {
	createSingleFileTarArchive,
	decodeContainerArchiveStatHeader,
	extractSingleFileFromTarBuffer,
} = require('../dist/nodes/Docker/utils/tar.js');

test('Docker remains AI-usable while Docker Files is not', () => {
	const dockerNode = new Docker();
	const dockerFilesNode = new DockerFiles();

	assert.equal(dockerNode.description.usableAsTool, true);
	assert.notEqual(dockerFilesNode.description.usableAsTool, true);

	const dockerContainerOperationProperty = dockerNode.description.properties.find(
		(property) =>
			property.name === 'operation' &&
			property.displayOptions?.show?.resource?.includes?.('container'),
	);
	const dockerFilesOperationProperty = dockerFilesNode.description.properties.find(
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
