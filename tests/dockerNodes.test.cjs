const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { pack } = require('tar-stream');

const { Docker } = require('../dist/nodes/Docker/Docker.node.js');
const { DockerBuild } = require('../dist/nodes/DockerBuild/DockerBuild.node.js');
const { DockerFiles } = require('../dist/nodes/DockerFiles/DockerFiles.node.js');
const { DockerTrigger } = require('../dist/nodes/DockerTrigger/DockerTrigger.node.js');
const {
	decodeContainerTextBuffer,
	decodeRawContainerTextBuffer,
	LIST_FILES_SHELL_SCRIPT,
	normalizeContainerPath,
	parseListFilesOutput,
	parseSearchTextOutput,
	readContainerText,
	replaceExactContainerText,
	resolveContainerFilePath,
	SEARCH_TEXT_SHELL_SCRIPT,
} = require('../dist/nodes/Docker/utils/containerText.js');
const { evaluateExecPolicy } = require('../dist/nodes/Docker/utils/execPolicy.js');
const {
	createSingleFileTarArchive,
	decodeContainerArchiveStatHeader,
	extractSingleFileFromTarBuffer,
} = require('../dist/nodes/Docker/utils/tar.js');

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
		[
			'create',
			'exec',
			'inspect',
			'list',
			'listFiles',
			'logs',
			'readTextFile',
			'remove',
			'replaceExactText',
			'restart',
			'searchText',
			'start',
			'stats',
			'stop',
			'top',
			'update',
			'wait',
			'writeTextFile',
		],
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

test('container text helpers normalize paths and resolve relative file requests', () => {
	assert.equal(normalizeContainerPath('/workspace/../app//config/./file.txt'), '/app/config/file.txt');
	assert.equal(normalizeContainerPath('logs/../app.txt'), 'app.txt');
	assert.deepEqual(resolveContainerFilePath('config/app.env', '/workspace/demo'), {
		fileName: 'app.env',
		requestedPath: 'config/app.env',
		resolvedPath: '/workspace/demo/config/app.env',
		targetPath: '/workspace/demo/config',
		workingPath: '/workspace/demo',
	});
	assert.deepEqual(resolveContainerFilePath('/etc/app.env', '/workspace/demo'), {
		fileName: 'app.env',
		requestedPath: '/etc/app.env',
		resolvedPath: '/etc/app.env',
		targetPath: '/etc',
		workingPath: '/workspace/demo',
	});
});

test('container text helpers decode text, slice lines, and reject binary content', () => {
	const buffer = Buffer.from('first\r\nsecond\r\nthird\r\n', 'utf8');
	const readResult = readContainerText(buffer, { endLine: 2, startLine: 2 });
	const invalidUtf8Buffer = Buffer.from([0x66, 0x6f, 0x80, 0x6f]);

	assert.equal(decodeRawContainerTextBuffer(Buffer.from('alpha\r\nbeta\r', 'utf8')), 'alpha\r\nbeta\r');
	assert.equal(decodeContainerTextBuffer(Buffer.from('alpha\r\nbeta\r', 'utf8')), 'alpha\nbeta\n');
	assert.deepEqual(readResult, {
		content: 'second',
		fileByteCount: buffer.length,
		hasMoreAfter: true,
		hasMoreBefore: true,
		lineEnd: 2,
		lineStart: 2,
		requestedEndLine: 2,
		requestedStartLine: 2,
		returnedLineCount: 1,
		totalLineCount: 3,
	});
	assert.throws(() => decodeContainerTextBuffer(Buffer.from([0, 1, 2])), /BINARY_FILE_NOT_SUPPORTED/);
	assert.throws(() => decodeContainerTextBuffer(invalidUtf8Buffer), /INVALID_UTF8_TEXT/);
});

test('container text helpers replace exact text and parse list/search shell output', () => {
	assert.deepEqual(replaceExactContainerText('hello world', 'world', 'docker'), {
		matchCount: 1,
		updatedText: 'hello docker',
	});
	assert.deepEqual(
		replaceExactContainerText('alpha\r\nbeta\r\ngamma\r\n', 'beta', 'BETA\ndelta'),
		{
			matchCount: 1,
			updatedText: 'alpha\r\nBETA\r\ndelta\r\ngamma\r\n',
		},
	);
	assert.deepEqual(replaceExactContainerText('repeat repeat', 'repeat', 'done'), {
		matchCount: 2,
	});
	assert.equal(LIST_FILES_SHELL_SCRIPT.includes('should_include_relative_path'), true);
	assert.equal(SEARCH_TEXT_SHELL_SCRIPT.includes('--no-ignore'), true);
	assert.equal(SEARCH_TEXT_SHELL_SCRIPT.includes('MAX_MATCHES'), true);
	assert.deepEqual(
		parseListFilesOutput('directory\tsrc\nfile\tsrc/app.ts\n', '/workspace'),
		{
			entries: [
				{
					absolutePath: '/workspace/src',
					entryType: 'directory',
					path: 'src',
				},
				{
					absolutePath: '/workspace/src/app.ts',
					entryType: 'file',
					path: 'src/app.ts',
				},
			],
			pathNotFound: null,
		},
	);
	assert.deepEqual(
		parseSearchTextOutput('/workspace/src/app.ts:12:needle here\n', '/workspace'),
		{
			matches: [
				{
					absolutePath: '/workspace/src/app.ts',
					line: 12,
					path: 'src/app.ts',
					text: 'needle here',
				},
			],
			pathNotFound: null,
		},
	);
	assert.deepEqual(
		parseListFilesOutput('__ERROR__\tPATH_NOT_FOUND\t/missing\n', '/workspace'),
		{
			entries: [],
			pathNotFound: '/missing',
		},
	);
});

test('container text listFiles helper traverses hidden roots while still filtering hidden descendants', () => {
	const workspaceRoot = mkdtempSync(join(tmpdir(), 'n8n-list-files-'));
	const hiddenRoot = join(workspaceRoot, '.hidden-root');

	mkdirSync(join(hiddenRoot, 'visible'), { recursive: true });
	mkdirSync(join(hiddenRoot, '.nested-hidden'), { recursive: true });
	writeFileSync(join(hiddenRoot, 'visible', 'app.txt'), 'visible\n');
	writeFileSync(join(hiddenRoot, '.nested-hidden', 'secret.txt'), 'secret\n');

	try {
		const stdout = execFileSync('sh', ['-lc', LIST_FILES_SHELL_SCRIPT], {
			encoding: 'utf8',
			env: {
				...process.env,
				GLOB: '',
				INCLUDE_HIDDEN: 'false',
				LIST_ROOT: hiddenRoot,
				MAX_DEPTH: '4',
				MAX_ENTRIES: '0',
			},
		});
		const parsed = parseListFilesOutput(stdout, hiddenRoot);

		assert.deepEqual(parsed, {
			entries: [
				{
					absolutePath: `${hiddenRoot}/visible`,
					entryType: 'directory',
					path: 'visible',
				},
				{
					absolutePath: `${hiddenRoot}/visible/app.txt`,
					entryType: 'file',
					path: 'visible/app.txt',
				},
			],
			pathNotFound: null,
		});
	} finally {
		rmSync(workspaceRoot, { force: true, recursive: true });
	}
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

test('tar helpers reject multi-entry archives for single-file extraction', async () => {
	const tarBuffer = await createTarArchive([
		{ content: Buffer.from('a'), name: 'a.txt' },
		{ content: Buffer.from('b'), name: 'b.txt' },
	]);
	const extracted = await extractSingleFileFromTarBuffer(tarBuffer);

	assert.equal(extracted.entryCount, 2);
	assert.equal(extracted.file, undefined);
	assert.equal(extracted.reason, 'multipleEntries');
});

test('tar helpers reject non-file entries for single-file extraction', async () => {
	const tarBuffer = await createTarArchive([{ name: 'nested', type: 'directory' }]);
	const extracted = await extractSingleFileFromTarBuffer(tarBuffer);

	assert.equal(extracted.entryCount, 1);
	assert.equal(extracted.file, undefined);
	assert.equal(extracted.reason, 'nonFileEntry');
});
