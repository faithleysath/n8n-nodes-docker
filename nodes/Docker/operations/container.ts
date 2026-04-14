import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { parseDockerRawStream } from '../transport/dockerLogs';
import type { DockerApiClient, DockerJson } from '../transport/dockerClient';
import { collectDockerStreamResponse } from '../transport/dockerStreams';
import type { ContainerOperation } from '../types';
import {
	decodeRawContainerTextBuffer,
	LIST_FILES_SHELL_SCRIPT,
	normalizeContainerPath,
	SEARCH_TEXT_SHELL_SCRIPT,
	parseListFilesOutput,
	parseSearchTextOutput,
	readContainerText,
	replaceExactContainerText,
	resolveContainerFilePath,
} from '../utils/containerText';
import { evaluateExecPolicy } from '../utils/execPolicy';
import {
	assertNonEmptyValue,
	assertWritableAccess,
	getNodeGetter,
	normalizePositiveInteger,
	toExecutionItem,
	trimToUndefined,
} from '../utils/execution';
import { deepMergeObjects, normalizeJsonParameter } from '../utils/merge';
import { createSingleFileTarArchive, extractSingleFileFromTarBuffer } from '../utils/tar';

interface KeyValuePair {
	name: string;
	value: string;
}

function getFixedCollectionValues(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
): IDataObject[] {
	const parameterValue = context.getNodeParameter(name, itemIndex, { values: [] }) as IDataObject;
	const values = parameterValue.values;

	return Array.isArray(values) ? (values as IDataObject[]) : [];
}

function getCommandArgs(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
): string[] {
	return getFixedCollectionValues(context, name, itemIndex).map((entry) => String(entry.value ?? ''));
}

function getKeyValuePairs(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
	label: string,
): KeyValuePair[] {
	const node = getNodeGetter(context);

	return getFixedCollectionValues(context, name, itemIndex).map((entry) => ({
		name: assertNonEmptyValue(node, String(entry.name ?? ''), `${label} Name`, itemIndex),
		value: String(entry.value ?? ''),
	}));
}

function getStringList(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
): string[] {
	return getFixedCollectionValues(context, name, itemIndex)
		.map((entry) => String(entry.value ?? '').trim())
		.filter((value) => value !== '');
}

function buildRestartPolicy(name: string, maximumRetryCount: number): DockerJson | undefined {
	if (name === '') {
		return undefined;
	}

	return {
		MaximumRetryCount: name === 'on-failure' ? maximumRetryCount : 0,
		Name: name,
	};
}

function buildCreatePayload(context: IExecuteFunctions, itemIndex: number): {
	body: DockerJson;
	name?: string;
} {
	const node = getNodeGetter(context);
	const image = assertNonEmptyValue(
		node,
		context.getNodeParameter('createImage', itemIndex) as string,
		'Image',
		itemIndex,
	);
	const containerName = trimToUndefined(
		context.getNodeParameter('createName', itemIndex, '') as string,
	);
	const commandArgs = getCommandArgs(context, 'createCommandArgs', itemIndex);
	const environmentVariables = getKeyValuePairs(
		context,
		'createEnv',
		itemIndex,
		'Environment Variable',
	);
	const labels = getKeyValuePairs(context, 'createLabels', itemIndex, 'Label');
	const workingDir = trimToUndefined(
		context.getNodeParameter('createWorkingDir', itemIndex, '') as string,
	);
	const user = trimToUndefined(context.getNodeParameter('createUser', itemIndex, '') as string);
	const tty = context.getNodeParameter('createTty', itemIndex) as boolean;
	const openStdin = context.getNodeParameter('createOpenStdin', itemIndex) as boolean;
	const restartPolicyName = context.getNodeParameter('createRestartPolicyName', itemIndex, '') as string;
	const restartPolicyMaximumRetryCount = context.getNodeParameter(
		'createRestartPolicyMaximumRetryCount',
		itemIndex,
		0,
	) as number;
	const autoRemove = context.getNodeParameter('createAutoRemove', itemIndex) as boolean;
	const networkMode = trimToUndefined(
		context.getNodeParameter('createNetworkMode', itemIndex, '') as string,
	);
	const bindMounts = getFixedCollectionValues(context, 'createBindMounts', itemIndex);
	const volumeMounts = getFixedCollectionValues(context, 'createVolumeMounts', itemIndex);
	const portBindings = getFixedCollectionValues(context, 'createPortBindings', itemIndex);
	const advancedJson = normalizeJsonParameter(
		context.getNodeParameter('createAdvancedJson', itemIndex, '{}'),
		'Advanced JSON',
		(message) => new NodeOperationError(context.getNode(), message, { itemIndex }),
	);

	const body: DockerJson = {
		Image: image,
	};

	if (commandArgs.length > 0) {
		body.Cmd = commandArgs;
	}

	if (environmentVariables.length > 0) {
		body.Env = environmentVariables.map(({ name, value }) => `${name}=${value}`);
	}

	if (labels.length > 0) {
		body.Labels = Object.fromEntries(labels.map(({ name, value }) => [name, value]));
	}

	if (workingDir !== undefined) {
		body.WorkingDir = workingDir;
	}

	if (user !== undefined) {
		body.User = user;
	}

	if (tty) {
		body.Tty = true;
	}

	if (openStdin) {
		body.AttachStdin = true;
		body.OpenStdin = true;
	}

	const hostConfig: DockerJson = {};
	const restartPolicy = buildRestartPolicy(restartPolicyName, restartPolicyMaximumRetryCount);

	if (restartPolicy !== undefined) {
		hostConfig.RestartPolicy = restartPolicy;
	}

	if (autoRemove) {
		hostConfig.AutoRemove = true;
	}

	if (networkMode !== undefined) {
		hostConfig.NetworkMode = networkMode;
	}

	if (bindMounts.length > 0) {
		hostConfig.Binds = bindMounts.map((entry) => {
			const source = assertNonEmptyValue(
				node,
				String(entry.source ?? ''),
				'Bind Source',
				itemIndex,
			);
			const target = assertNonEmptyValue(
				node,
				String(entry.target ?? ''),
				'Bind Target',
				itemIndex,
			);
			const readOnly = Boolean(entry.readOnly);

			return `${source}:${target}${readOnly ? ':ro' : ''}`;
		});
	}

	if (volumeMounts.length > 0) {
		hostConfig.Mounts = volumeMounts.map((entry) => {
			const source = assertNonEmptyValue(
				node,
				String(entry.source ?? ''),
				'Volume Name',
				itemIndex,
			);
			const target = assertNonEmptyValue(
				node,
				String(entry.target ?? ''),
				'Target Path',
				itemIndex,
			);

			return {
				ReadOnly: Boolean(entry.readOnly),
				Source: source,
				Target: target,
				Type: 'volume',
			};
		});
	}

	if (portBindings.length > 0) {
		const exposedPorts: Record<string, DockerJson> = {};
		const hostPortBindings: Record<string, Array<{ HostPort: string }>> = {};

		for (const entry of portBindings) {
			const containerPort = normalizePositiveInteger(
				node,
				Number(entry.containerPort ?? 0),
				'Container Port',
				itemIndex,
			);
			const hostPort = normalizePositiveInteger(
				node,
				Number(entry.hostPort ?? 0),
				'Host Port',
				itemIndex,
			);
			const protocol = String(entry.protocol ?? 'tcp');
			const key = `${containerPort}/${protocol}`;

			exposedPorts[key] = {};
			hostPortBindings[key] = [{ HostPort: String(hostPort) }];
		}

		body.ExposedPorts = exposedPorts;
		hostConfig.PortBindings = hostPortBindings;
	}

	if (Object.keys(hostConfig).length > 0) {
		body.HostConfig = hostConfig;
	}

	return {
		body: deepMergeObjects(body, advancedJson),
		name: containerName,
	};
}

function buildUpdatePayload(context: IExecuteFunctions, itemIndex: number): DockerJson {
	const restartPolicyName = context.getNodeParameter('updateRestartPolicyName', itemIndex, '') as string;
	const restartPolicyMaximumRetryCount = context.getNodeParameter(
		'updateRestartPolicyMaximumRetryCount',
		itemIndex,
		0,
	) as number;
	const resourceLimits = context.getNodeParameter('updateResourceLimits', itemIndex, {}) as IDataObject;
	const advancedJson = normalizeJsonParameter(
		context.getNodeParameter('updateAdvancedJson', itemIndex, '{}'),
		'Advanced JSON',
		(message) => new NodeOperationError(context.getNode(), message, { itemIndex }),
	);

	const body: DockerJson = {};
	const restartPolicy = buildRestartPolicy(restartPolicyName, restartPolicyMaximumRetryCount);

	if (restartPolicy !== undefined) {
		body.RestartPolicy = restartPolicy;
	}

	const limitMappings: Array<[string, string]> = [
		['memory', 'Memory'],
		['memorySwap', 'MemorySwap'],
		['memoryReservation', 'MemoryReservation'],
		['cpuShares', 'CpuShares'],
		['cpuPeriod', 'CpuPeriod'],
		['cpuQuota', 'CpuQuota'],
		['nanoCpus', 'NanoCpus'],
		['cpusetCpus', 'CpusetCpus'],
		['cpusetMems', 'CpusetMems'],
	];

	for (const [parameterName, payloadName] of limitMappings) {
		const value = resourceLimits[parameterName];

		if (value === undefined || value === '') {
			continue;
		}

		body[payloadName] = value;
	}

	return deepMergeObjects(body, advancedJson);
}

function buildExecRequest(context: IExecuteFunctions, itemIndex: number): {
	commandArgs: string[];
	execCreateBody: DockerJson;
	tty: boolean;
} {
	const commandArgs = getCommandArgs(context, 'execCommandArgs', itemIndex);

	if (commandArgs.length === 0 || commandArgs[0].trim() === '') {
		throw new NodeOperationError(context.getNode(), 'Command Arguments must include argv[0].', {
			itemIndex,
		});
	}

	const attachStdout = context.getNodeParameter('execAttachStdout', itemIndex) as boolean;
	const attachStderr = context.getNodeParameter('execAttachStderr', itemIndex) as boolean;

	if (!attachStdout && !attachStderr) {
		throw new NodeOperationError(
			context.getNode(),
			'Enable at least one exec output stream: stdout or stderr.',
			{ itemIndex },
		);
	}

	const allowList = getStringList(context, 'execAllowList', itemIndex);
	const denyList = getStringList(context, 'execDenyList', itemIndex);
	const policy = evaluateExecPolicy(commandArgs[0], allowList, denyList);

	if (policy.deniedBy === 'denyList') {
		throw new NodeOperationError(
			context.getNode(),
			`Exec command "${policy.commandName}" is blocked by Exec Deny List.`,
			{ itemIndex },
		);
	}

	if (policy.deniedBy === 'allowList') {
		throw new NodeOperationError(
			context.getNode(),
			`Exec command "${policy.commandName}" is not present in Exec Allow List.`,
			{ itemIndex },
		);
	}

	const environmentVariables = getKeyValuePairs(
		context,
		'execEnv',
		itemIndex,
		'Environment Variable',
	);
	const workingDir = trimToUndefined(
		context.getNodeParameter('execWorkingDir', itemIndex, '') as string,
	);
	const user = trimToUndefined(context.getNodeParameter('execUser', itemIndex, '') as string);
	const tty = context.getNodeParameter('execTty', itemIndex) as boolean;
	const privileged = context.getNodeParameter('execPrivileged', itemIndex) as boolean;

	const execCreateBody: DockerJson = {
		AttachStderr: attachStderr,
		AttachStdout: attachStdout,
		Cmd: commandArgs,
		Privileged: privileged,
		Tty: tty,
	};

	if (environmentVariables.length > 0) {
		execCreateBody.Env = environmentVariables.map(({ name, value }) => `${name}=${value}`);
	}

	if (workingDir !== undefined) {
		execCreateBody.WorkingDir = workingDir;
	}

	if (user !== undefined) {
		execCreateBody.User = user;
	}

	if (tty) {
		execCreateBody.AttachStderr = attachStderr;
		execCreateBody.AttachStdout = attachStdout;
	}

	return {
		commandArgs,
		execCreateBody,
		tty,
	};
}

function getOptionalPositiveInteger(
	context: IExecuteFunctions,
	itemIndex: number,
	name: string,
	label: string,
): number | undefined {
	const node = getNodeGetter(context);
	const rawValue = context.getNodeParameter(name, itemIndex, '') as number | string;

	if (rawValue === '' || rawValue === undefined || rawValue === null) {
		return undefined;
	}

	return normalizePositiveInteger(node, Number(rawValue), label, itemIndex);
}

function getContainerWorkingPath(context: IExecuteFunctions, itemIndex: number): string {
	const workingPath = normalizeContainerPath(
		String(context.getNodeParameter('workingPath', itemIndex, '/')).trim() || '/',
	);

	if (!workingPath.startsWith('/')) {
		throw new NodeOperationError(context.getNode(), 'Working Path must be an absolute container path.', {
			itemIndex,
		});
	}

	return workingPath;
}

function getContainerFileRequest(
	context: IExecuteFunctions,
	itemIndex: number,
): ReturnType<typeof resolveContainerFilePath> {
	const filePath = context.getNodeParameter('filePath', itemIndex) as string;
	const request = resolveContainerFilePath(
		assertNonEmptyValue(getNodeGetter(context), filePath, 'File Path', itemIndex),
		context.getNodeParameter('workingPath', itemIndex, '/') as string,
	);

	if (!request.workingPath.startsWith('/')) {
		throw new NodeOperationError(context.getNode(), 'Working Path must be an absolute container path.', {
			itemIndex,
		});
	}

	if (request.resolvedPath === '/' || request.fileName === '') {
		throw new NodeOperationError(
			context.getNode(),
			'File Path must resolve to a file, not a directory root.',
			{ itemIndex },
		);
	}

	return request;
}

function getInternalExecFailureMessage(stdout: string, stderr: string): string {
	const details = trimToUndefined(stderr) ?? trimToUndefined(stdout);

	if (details === undefined) {
		return 'No command output was returned.';
	}

	return details.length > 400 ? `${details.slice(0, 397)}...` : details;
}

function createContainerTextOperationError(
	context: IExecuteFunctions,
	itemIndex: number,
	resolvedPath: string,
	mode: 'edit' | 'read',
	error: unknown,
): NodeOperationError | undefined {
	if (!(error instanceof Error)) {
		return undefined;
	}

	if (error.message === 'BINARY_FILE_NOT_SUPPORTED') {
		return new NodeOperationError(
			context.getNode(),
			`File Path "${resolvedPath}" appears to be binary and cannot be ${mode === 'read' ? 'returned' : 'edited'} as text.`,
			{ itemIndex },
		);
	}

	if (error.message === 'INVALID_UTF8_TEXT') {
		return new NodeOperationError(
			context.getNode(),
			`File Path "${resolvedPath}" is not valid UTF-8 text and cannot be ${mode === 'read' ? 'returned' : 'edited'} as text.`,
			{ itemIndex },
		);
	}

	return undefined;
}

async function runInternalContainerShellCommand(
	client: DockerApiClient,
	context: IExecuteFunctions,
	itemIndex: number,
	containerId: string,
	script: string,
	options?: {
		env?: KeyValuePair[];
		workingDir?: string;
	},
): Promise<{
	exitCode: number | null;
	stderr: string;
	stdout: string;
}> {
	const abortSignal = context.getExecutionCancelSignal();
	const execCreateBody: DockerJson = {
		AttachStderr: true,
		AttachStdout: true,
		Cmd: ['/bin/sh', '-lc', script],
		Privileged: false,
		Tty: false,
	};

	if (options?.env !== undefined && options.env.length > 0) {
		execCreateBody.Env = options.env.map(({ name, value }) => `${name}=${value}`);
	}

	if (options?.workingDir !== undefined) {
		execCreateBody.WorkingDir = options.workingDir;
	}

	const execCreateResponse = await client.createContainerExec(containerId, execCreateBody, abortSignal);
	const execId = String(execCreateResponse.Id ?? '');

	if (execId === '') {
		throw new NodeOperationError(
			context.getNode(),
			'Docker did not return an exec ID for the internal container helper command.',
			{ itemIndex },
		);
	}

	const execStartResponse = await client.startContainerExec(
		execId,
		{
			Detach: false,
			Tty: false,
		},
		abortSignal,
	);
	const execInspectResponse = await client.inspectContainerExec(execId, abortSignal);
	const parsedOutput = parseDockerRawStream(
		execStartResponse.body,
		execStartResponse.headers['content-type'],
	);

	return {
		exitCode:
			typeof execInspectResponse.ExitCode === 'number' ? execInspectResponse.ExitCode : null,
		stderr: parsedOutput.streamText.stderr,
		stdout: parsedOutput.streamText.stdout,
	};
}

async function getSingleContainerFileBuffer(
	client: DockerApiClient,
	context: IExecuteFunctions,
	itemIndex: number,
	containerId: string,
	resolvedPath: string,
): Promise<Buffer> {
	const archiveResponse = await client.getContainerArchive(
		containerId,
		{ path: resolvedPath },
		context.getExecutionCancelSignal(),
	);
	const extractionResult = await extractSingleFileFromTarBuffer(archiveResponse.body);

	if (extractionResult.file !== undefined) {
		return extractionResult.file.content;
	}

	if (extractionResult.reason === 'multipleEntries') {
		throw new NodeOperationError(
			context.getNode(),
			`File Path "${resolvedPath}" expanded to multiple files. Specify a single regular file.`,
			{ itemIndex },
		);
	}

	if (extractionResult.reason === 'nonFileEntry') {
		throw new NodeOperationError(
			context.getNode(),
			`File Path "${resolvedPath}" is not a regular file.`,
			{ itemIndex },
		);
	}

	throw new NodeOperationError(
		context.getNode(),
		`File Path "${resolvedPath}" did not return any file content.`,
		{ itemIndex },
	);
}

function mapProcessRows(rawTopResponse: DockerJson): IDataObject[] {
	const titles = Array.isArray(rawTopResponse.Titles) ? rawTopResponse.Titles : [];
	const processes = Array.isArray(rawTopResponse.Processes) ? rawTopResponse.Processes : [];

	return processes
		.filter((processRow): processRow is unknown[] => Array.isArray(processRow))
		.map((processRow) => {
			const mappedRow: IDataObject = {};

			titles.forEach((title, index) => {
				mappedRow[String(title)] = processRow[index] ?? null;
			});

			return mappedRow;
		});
}

function getNestedNumber(value: unknown, path: string[]): number | undefined {
	let current: unknown = value;

	for (const segment of path) {
		if (current === null || typeof current !== 'object' || Array.isArray(current)) {
			return undefined;
		}

		current = (current as IDataObject)[segment];
	}

	return typeof current === 'number' ? current : undefined;
}

function calculateContainerStats(rawStats: DockerJson): IDataObject {
	const cpuTotal = getNestedNumber(rawStats, ['cpu_stats', 'cpu_usage', 'total_usage']) ?? 0;
	const preCpuTotal = getNestedNumber(rawStats, ['precpu_stats', 'cpu_usage', 'total_usage']) ?? 0;
	const systemCpu = getNestedNumber(rawStats, ['cpu_stats', 'system_cpu_usage']) ?? 0;
	const preSystemCpu = getNestedNumber(rawStats, ['precpu_stats', 'system_cpu_usage']) ?? 0;
	const onlineCpus =
		getNestedNumber(rawStats, ['cpu_stats', 'online_cpus']) ??
		(Array.isArray((rawStats.cpu_stats as IDataObject | undefined)?.cpu_usage as unknown)
			? 0
			: undefined) ??
		(() => {
			const percpuUsage = (((rawStats.cpu_stats as IDataObject | undefined)?.cpu_usage ??
				{}) as IDataObject).percpu_usage;

			return Array.isArray(percpuUsage) ? percpuUsage.length : 0;
		})();

	const cpuDelta = cpuTotal - preCpuTotal;
	const systemDelta = systemCpu - preSystemCpu;
	const cpuPercent =
		systemDelta > 0 && cpuDelta >= 0 && onlineCpus > 0
			? (cpuDelta / systemDelta) * onlineCpus * 100
			: 0;
	const memoryUsage = getNestedNumber(rawStats, ['memory_stats', 'usage']) ?? 0;
	const memoryLimit = getNestedNumber(rawStats, ['memory_stats', 'limit']) ?? 0;
	const inactiveFile = getNestedNumber(rawStats, ['memory_stats', 'stats', 'inactive_file']);
	const cache = getNestedNumber(rawStats, ['memory_stats', 'stats', 'cache']);
	const cacheToSubtract = inactiveFile ?? cache ?? 0;
	const memoryUsed = Math.max(memoryUsage - cacheToSubtract, 0);
	const memoryPercent = memoryLimit > 0 ? (memoryUsed / memoryLimit) * 100 : 0;
	const pidsCurrent = getNestedNumber(rawStats, ['pids_stats', 'current']) ?? 0;

	return {
		cpuPercent,
		memoryLimit,
		memoryPercent,
		memoryUsed,
		pidsCurrent,
	};
}

function toContainerLogItems(
	containerId: string,
	itemIndex: number,
	entries: Array<{ message: string; stream: string }>,
): INodeExecutionData[] {
	return entries.map((entry) =>
		toExecutionItem(
			{
				containerId,
				message: entry.message,
				operation: 'logs',
				stream: entry.stream,
			},
			itemIndex,
		),
	);
}

export async function executeContainerOperation(
	context: IExecuteFunctions,
	client: DockerApiClient,
	itemIndex: number,
	operation: ContainerOperation,
): Promise<INodeExecutionData[]> {
	const abortSignal = context.getExecutionCancelSignal();
	const node = getNodeGetter(context);

	switch (operation) {
		case 'list': {
			const allContainers = context.getNodeParameter('allContainers', itemIndex) as boolean;
			const returnAll = context.getNodeParameter('returnAll', itemIndex) as boolean;
			const limitValue = context.getNodeParameter('limit', itemIndex, 50) as number;
			const limit = returnAll
				? undefined
				: normalizePositiveInteger(node, limitValue, 'Limit', itemIndex);
			const containers = await client.listContainers({ all: allContainers }, abortSignal);
			const selectedContainers = limit === undefined ? containers : containers.slice(0, limit);

			return selectedContainers.map((container) => toExecutionItem(container, itemIndex));
		}

		case 'listFiles': {
			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const workingPath = getContainerWorkingPath(context, itemIndex);
			const glob = trimToUndefined(context.getNodeParameter('glob', itemIndex, '') as string);
			const includeHidden = context.getNodeParameter('includeHidden', itemIndex, false) as boolean;
			const maxDepth = normalizePositiveInteger(
				node,
				context.getNodeParameter('maxDepth', itemIndex, 4) as number,
				'Max Depth',
				itemIndex,
			);
			const returnAll = context.getNodeParameter('listFilesReturnAll', itemIndex, true) as boolean;
			const limit = returnAll
				? undefined
				: normalizePositiveInteger(
						node,
						context.getNodeParameter('listFilesLimit', itemIndex, 200) as number,
						'Limit',
						itemIndex,
					);
			const commandResult = await runInternalContainerShellCommand(
				client,
				context,
				itemIndex,
				containerId,
				LIST_FILES_SHELL_SCRIPT,
				{
					env: [
						{ name: 'GLOB', value: glob ?? '' },
						{ name: 'INCLUDE_HIDDEN', value: includeHidden ? 'true' : 'false' },
						{ name: 'LIST_ROOT', value: workingPath },
						{ name: 'MAX_DEPTH', value: String(maxDepth) },
						{ name: 'MAX_ENTRIES', value: String(limit ?? 0) },
					],
					workingDir: '/',
				},
			);
			const parsedOutput = parseListFilesOutput(commandResult.stdout, workingPath);

			if (parsedOutput.pathNotFound !== null) {
				throw new NodeOperationError(
					context.getNode(),
					`Working Path "${parsedOutput.pathNotFound}" was not found in the container.`,
					{ itemIndex },
				);
			}

			if (commandResult.exitCode !== null && commandResult.exitCode !== 0) {
				throw new NodeOperationError(
					context.getNode(),
					`listFiles failed with exit code ${commandResult.exitCode}: ${getInternalExecFailureMessage(commandResult.stdout, commandResult.stderr)}`,
					{ itemIndex },
				);
			}

			const entries =
				limit === undefined ? parsedOutput.entries : parsedOutput.entries.slice(0, limit);

			return entries.map((entry) =>
				toExecutionItem(
					{
						absolutePath: entry.absolutePath,
						containerId,
						entryType: entry.entryType,
						operation: 'listFiles',
						path: entry.path,
						workingPath,
					},
					itemIndex,
				),
			);
		}

		case 'inspect': {
			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const container = await client.inspectContainer(containerId, abortSignal);

			return [toExecutionItem(container, itemIndex)];
		}

		case 'logs': {
			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const includeStdout = context.getNodeParameter('includeStdout', itemIndex) as boolean;
			const includeStderr = context.getNodeParameter('includeStderr', itemIndex) as boolean;

			if (!includeStdout && !includeStderr) {
				throw new NodeOperationError(
					context.getNode(),
					'Enable at least one log stream: stdout or stderr.',
					{ itemIndex },
				);
			}
			const logsMode = context.getNodeParameter('logsMode', itemIndex, 'snapshot') as
				| 'followForDuration'
				| 'snapshot';
			const logsOutputMode = context.getNodeParameter(
				'logsOutputMode',
				itemIndex,
				'aggregate',
			) as 'aggregate' | 'splitItems';
			const logOptions = {
				follow: logsMode === 'followForDuration',
				since: trimToUndefined(context.getNodeParameter('since', itemIndex, '') as string),
				stderr: includeStderr,
				stdout: includeStdout,
				tail: trimToUndefined(context.getNodeParameter('tail', itemIndex) as string),
				timestamps: context.getNodeParameter('timestamps', itemIndex) as boolean,
				until: trimToUndefined(context.getNodeParameter('until', itemIndex, '') as string),
			};
			let rawLogsBody: Buffer;
			let contentType: string | string[] | undefined;

			if (logsMode === 'snapshot') {
				const rawLogs = await client.getContainerLogs(containerId, logOptions, abortSignal);

				rawLogsBody = rawLogs.body;
				contentType = rawLogs.headers['content-type'];
			} else {
				const followDurationSeconds = normalizePositiveInteger(
					node,
					context.getNodeParameter('logsFollowDurationSeconds', itemIndex, 30) as number,
					'Follow Duration Seconds',
					itemIndex,
				);
				const followAbortController = new AbortController();
				const timeout = setTimeout(() => {
					followAbortController.abort();
				}, followDurationSeconds * 1000);
				const abortListener = () => {
					followAbortController.abort();
				};

				abortSignal?.addEventListener('abort', abortListener, { once: true });

				try {
					const streamResponse = await client.streamContainerLogs(
						containerId,
						logOptions,
						followAbortController.signal,
					);

					contentType = streamResponse.headers['content-type'];
					rawLogsBody = await collectDockerStreamResponse(
						streamResponse,
						followAbortController.signal,
					);
				} finally {
					clearTimeout(timeout);
					abortSignal?.removeEventListener('abort', abortListener);
				}
			}

			const parsedLogs = parseDockerRawStream(rawLogsBody, contentType);

			if (logsOutputMode === 'splitItems') {
				return toContainerLogItems(
					containerId,
					itemIndex,
					parsedLogs.entries as Array<{ message: string; stream: string }>,
				);
			}

			return [
				toExecutionItem(
					{
						containerId,
						contentType: parsedLogs.contentType,
						entries: parsedLogs.entries as unknown as IDataObject[],
						lineCount: parsedLogs.entries.length,
						logs: parsedLogs.text,
						multiplexed: parsedLogs.multiplexed,
						operation: 'logs',
					},
					itemIndex,
				),
			];
		}

		case 'readTextFile': {
			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const fileRequest = getContainerFileRequest(context, itemIndex);
			const startLine = getOptionalPositiveInteger(context, itemIndex, 'startLine', 'Start Line');
			const endLine = getOptionalPositiveInteger(context, itemIndex, 'endLine', 'End Line');

			if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
				throw new NodeOperationError(
					context.getNode(),
					'Start Line must be less than or equal to End Line.',
					{ itemIndex },
				);
			}

			const fileBuffer = await getSingleContainerFileBuffer(
				client,
				context,
				itemIndex,
				containerId,
				fileRequest.resolvedPath,
			);
			let textResult;

			try {
				textResult = readContainerText(fileBuffer, { endLine, startLine });
			} catch (error) {
				const textError = createContainerTextOperationError(
					context,
					itemIndex,
					fileRequest.resolvedPath,
					'read',
					error,
				);

				if (textError !== undefined) {
					throw textError;
				}

				throw error;
			}

			return [
				toExecutionItem(
					{
						containerId,
						content: textResult.content,
						fileByteCount: textResult.fileByteCount,
						hasMoreAfter: textResult.hasMoreAfter,
						hasMoreBefore: textResult.hasMoreBefore,
						lineEnd: textResult.lineEnd,
						lineStart: textResult.lineStart,
						operation: 'readTextFile',
						requestedEndLine: textResult.requestedEndLine,
						requestedPath: fileRequest.requestedPath,
						requestedStartLine: textResult.requestedStartLine,
						resolvedPath: fileRequest.resolvedPath,
						returnedLineCount: textResult.returnedLineCount,
						totalLineCount: textResult.totalLineCount,
					},
					itemIndex,
				),
			];
		}

		case 'searchText': {
			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const workingPath = getContainerWorkingPath(context, itemIndex);
			const query = assertNonEmptyValue(
				node,
				context.getNodeParameter('query', itemIndex) as string,
				'Query',
				itemIndex,
			);
			const glob = trimToUndefined(context.getNodeParameter('glob', itemIndex, '') as string);
			const caseSensitive = context.getNodeParameter('caseSensitive', itemIndex, false) as boolean;
			const returnAll = context.getNodeParameter('searchTextReturnAll', itemIndex, true) as boolean;
			const limit = returnAll
				? undefined
				: normalizePositiveInteger(
						node,
						context.getNodeParameter('searchTextLimit', itemIndex, 50) as number,
						'Limit',
						itemIndex,
					);
			const commandResult = await runInternalContainerShellCommand(
				client,
				context,
				itemIndex,
				containerId,
				SEARCH_TEXT_SHELL_SCRIPT,
				{
						env: [
							{ name: 'CASE_SENSITIVE', value: caseSensitive ? 'true' : 'false' },
							{ name: 'GLOB', value: glob ?? '' },
							{ name: 'MAX_MATCHES', value: String(limit ?? 0) },
							{ name: 'QUERY', value: query },
							{ name: 'SEARCH_ROOT', value: workingPath },
						],
					workingDir: '/',
				},
			);
			const parsedOutput = parseSearchTextOutput(commandResult.stdout, workingPath);

			if (parsedOutput.pathNotFound !== null) {
				throw new NodeOperationError(
					context.getNode(),
					`Working Path "${parsedOutput.pathNotFound}" was not found in the container.`,
					{ itemIndex },
				);
			}

			if (
				commandResult.exitCode !== null &&
				commandResult.exitCode !== 0 &&
				!(
					commandResult.exitCode === 1 &&
					trimToUndefined(commandResult.stdout) === undefined
				)
			) {
				throw new NodeOperationError(
					context.getNode(),
					`searchText failed with exit code ${commandResult.exitCode}: ${getInternalExecFailureMessage(commandResult.stdout, commandResult.stderr)}`,
					{ itemIndex },
				);
			}

			const matches =
				limit === undefined ? parsedOutput.matches : parsedOutput.matches.slice(0, limit);

			return matches.map((match) =>
				toExecutionItem(
					{
						absolutePath: match.absolutePath,
						caseSensitive,
						containerId,
						line: match.line,
						operation: 'searchText',
						path: match.path,
						query,
						text: match.text,
						workingPath,
					},
					itemIndex,
				),
			);
		}

		case 'start':
		case 'stop':
		case 'restart': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const timeoutSeconds =
				operation === 'start'
					? undefined
					: normalizePositiveInteger(
							node,
							context.getNodeParameter('timeoutSeconds', itemIndex, 10) as number,
							'Timeout (Seconds)',
							itemIndex,
						);
			const actionResult =
				operation === 'start'
					? await client.startContainer(containerId, abortSignal)
					: operation === 'stop'
						? await client.stopContainer(containerId, { timeoutSeconds }, abortSignal)
						: await client.restartContainer(containerId, { timeoutSeconds }, abortSignal);
			const container = await client.inspectContainer(containerId, abortSignal);

			return [
				toExecutionItem(
					{
						changed: actionResult.changed,
						container,
						containerId,
						operation,
						statusCode: actionResult.statusCode,
						timeoutSeconds,
					},
					itemIndex,
				),
			];
		}

		case 'remove': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const force = context.getNodeParameter('force', itemIndex) as boolean;
			const removeVolumes = context.getNodeParameter('removeVolumes', itemIndex) as boolean;
			const actionResult = await client.removeContainer(
				containerId,
				{
					force,
					removeVolumes,
				},
				abortSignal,
			);

			return [
				toExecutionItem(
					{
						changed: actionResult.changed,
						containerId,
						force,
						operation: 'remove',
						removeVolumes,
						removed: true,
						statusCode: actionResult.statusCode,
					},
					itemIndex,
				),
			];
		}

		case 'top': {
			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const psArgs = trimToUndefined(context.getNodeParameter('psArgs', itemIndex, '-ef') as string);
			const topResponse = await client.topContainer(containerId, { psArgs }, abortSignal);

			return [
				toExecutionItem(
					{
						...topResponse,
						containerId,
						operation: 'top',
						processRows: mapProcessRows(topResponse),
					},
					itemIndex,
				),
			];
		}

		case 'stats': {
			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const rawStats = await client.getContainerStats(containerId, { oneShot: true }, abortSignal);

			return [
				toExecutionItem(
					{
						...rawStats,
						...calculateContainerStats(rawStats),
						containerId,
						operation: 'stats',
					},
					itemIndex,
				),
			];
		}

		case 'wait': {
			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const condition = context.getNodeParameter('waitCondition', itemIndex, 'not-running') as string;
			const waitResponse = await client.waitForContainer(containerId, { condition }, abortSignal);

			return [
				toExecutionItem(
					{
						...waitResponse,
						condition,
						containerId,
						operation: 'wait',
					},
					itemIndex,
				),
			];
		}

		case 'create': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const createRequest = buildCreatePayload(context, itemIndex);
			const createResponse = await client.createContainer(createRequest, abortSignal);
			const createdContainerId = String(createResponse.Id ?? '');

			if (createdContainerId === '') {
				throw new NodeOperationError(
					context.getNode(),
					'Docker did not return a container ID for the create operation.',
					{ itemIndex },
				);
			}

			const container = await client.inspectContainer(createdContainerId, abortSignal);

			return [
				toExecutionItem(
					{
						container,
						containerId: createdContainerId,
						name: createRequest.name,
						operation: 'create',
						warnings: Array.isArray(createResponse.Warnings) ? createResponse.Warnings : [],
					},
					itemIndex,
				),
			];
		}

		case 'update': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const updatePayload = buildUpdatePayload(context, itemIndex);
			const updateResponse = await client.updateContainer(containerId, updatePayload, abortSignal);
			const container = await client.inspectContainer(containerId, abortSignal);

			return [
				toExecutionItem(
					{
						container,
						containerId,
						operation: 'update',
						update: updateResponse,
					},
					itemIndex,
				),
			];
		}

		case 'writeTextFile': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const fileRequest = getContainerFileRequest(context, itemIndex);
			const content = String(context.getNodeParameter('content', itemIndex, ''));
			const createParentDirectories = context.getNodeParameter(
				'createParentDirectories',
				itemIndex,
				true,
			) as boolean;

			if (createParentDirectories) {
				const commandResult = await runInternalContainerShellCommand(
					client,
					context,
					itemIndex,
					containerId,
					'mkdir -p "$TARGET_DIR"',
					{
						env: [{ name: 'TARGET_DIR', value: fileRequest.targetPath }],
						workingDir: '/',
					},
				);

				if (commandResult.exitCode !== null && commandResult.exitCode !== 0) {
					throw new NodeOperationError(
						context.getNode(),
						`Failed to create parent directory "${fileRequest.targetPath}" in the container: ${getInternalExecFailureMessage(commandResult.stdout, commandResult.stderr)}`,
						{ itemIndex },
					);
				}
			}

			const fileBuffer = Buffer.from(content, 'utf8');
			const archiveBuffer = await createSingleFileTarArchive(fileRequest.fileName, fileBuffer);
			const actionResult = await client.putContainerArchive(
				containerId,
				{
					body: archiveBuffer,
					path: fileRequest.targetPath,
				},
				abortSignal,
			);

			return [
				toExecutionItem(
					{
						bytesWritten: fileBuffer.length,
						changed: actionResult.changed,
						containerId,
						operation: 'writeTextFile',
						requestedPath: fileRequest.requestedPath,
						resolvedPath: fileRequest.resolvedPath,
						statusCode: actionResult.statusCode,
					},
					itemIndex,
				),
			];
		}

		case 'replaceExactText': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const fileRequest = getContainerFileRequest(context, itemIndex);
			const oldText = String(context.getNodeParameter('oldText', itemIndex, ''));
			const newText = String(context.getNodeParameter('newText', itemIndex, ''));

			if (oldText === '') {
				throw new NodeOperationError(context.getNode(), 'Old Text is required.', { itemIndex });
			}

			const fileBuffer = await getSingleContainerFileBuffer(
				client,
				context,
				itemIndex,
				containerId,
				fileRequest.resolvedPath,
			);
			let currentText: string;

			try {
				currentText = decodeRawContainerTextBuffer(fileBuffer);
			} catch (error) {
				const textError = createContainerTextOperationError(
					context,
					itemIndex,
					fileRequest.resolvedPath,
					'edit',
					error,
				);

				if (textError !== undefined) {
					throw textError;
				}

				throw error;
			}

			const replacement = replaceExactContainerText(currentText, oldText, newText);

			if (replacement.updatedText === undefined && replacement.matchCount === 0) {
				throw new NodeOperationError(
					context.getNode(),
					`Old Text was not found in "${fileRequest.resolvedPath}".`,
					{ itemIndex },
				);
			}

			if (replacement.updatedText === undefined) {
				throw new NodeOperationError(
					context.getNode(),
					`Old Text matched ${replacement.matchCount} locations in "${fileRequest.resolvedPath}". Narrow the patch context and try again.`,
					{ itemIndex },
				);
			}

			const updatedBuffer = Buffer.from(replacement.updatedText, 'utf8');
			const archiveBuffer = await createSingleFileTarArchive(
				fileRequest.fileName,
				updatedBuffer,
			);
			const actionResult = await client.putContainerArchive(
				containerId,
				{
					body: archiveBuffer,
					path: fileRequest.targetPath,
				},
				abortSignal,
			);

			return [
				toExecutionItem(
					{
						bytesWritten: updatedBuffer.length,
						changed: actionResult.changed,
						containerId,
						operation: 'replaceExactText',
						replacementCount: 1,
						requestedPath: fileRequest.requestedPath,
						resolvedPath: fileRequest.resolvedPath,
						statusCode: actionResult.statusCode,
					},
					itemIndex,
				),
			];
		}

		case 'exec': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const execRequest = buildExecRequest(context, itemIndex);
			const execCreateResponse = await client.createContainerExec(
				containerId,
				execRequest.execCreateBody,
				abortSignal,
			);
			const execId = String(execCreateResponse.Id ?? '');

			if (execId === '') {
				throw new NodeOperationError(
					context.getNode(),
					'Docker did not return an exec ID for the exec operation.',
					{ itemIndex },
				);
			}

			const execStartResponse = await client.startContainerExec(
				execId,
				{
					Detach: false,
					Tty: execRequest.tty,
				},
				abortSignal,
			);
			const execInspectResponse = await client.inspectContainerExec(execId, abortSignal);
			const parsedOutput = parseDockerRawStream(
				execStartResponse.body,
				execStartResponse.headers['content-type'],
			);

			return [
				toExecutionItem(
					{
						commandArgs: execRequest.commandArgs,
						combinedOutput: parsedOutput.text,
						containerId,
						contentType: parsedOutput.contentType,
						entries: parsedOutput.entries as unknown as IDataObject[],
						execId,
						exitCode:
							typeof execInspectResponse.ExitCode === 'number'
								? execInspectResponse.ExitCode
								: null,
						multiplexed: parsedOutput.multiplexed,
						operation: 'exec',
						stderr: execRequest.tty ? '' : parsedOutput.streamText.stderr,
						stdout: parsedOutput.streamText.stdout,
						tty: execRequest.tty,
					},
					itemIndex,
				),
			];
		}
	}

	throw new Error(`Unsupported container operation "${operation}".`);
}
