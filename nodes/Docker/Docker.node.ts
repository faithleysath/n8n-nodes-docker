import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
} from 'n8n-workflow';

import {
	DockerApiClient,
	DockerRequestError,
	type DockerAccessMode,
	type DockerCredentials,
} from './transport/dockerClient';
import { parseDockerLogStream } from './transport/dockerLogs';

type DockerResource = 'container' | 'system';
type ContainerOperation = 'inspect' | 'list' | 'logs' | 'remove' | 'restart' | 'start' | 'stop';
type SystemOperation = 'info' | 'ping' | 'version';
type DockerOperation = ContainerOperation | SystemOperation;

const writableContainerOperations = new Set<ContainerOperation>([
	'remove',
	'restart',
	'start',
	'stop',
]);

const containerOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['container'],
			},
		},
		default: 'list',
		options: [
			{ name: 'Inspect', value: 'inspect', action: 'Inspect a container' },
			{ name: 'List', value: 'list', action: 'List containers' },
			{ name: 'Logs', value: 'logs', action: 'Fetch container logs' },
			{ name: 'Remove', value: 'remove', action: 'Remove a container' },
			{ name: 'Restart', value: 'restart', action: 'Restart a container' },
			{ name: 'Start', value: 'start', action: 'Start a container' },
			{ name: 'Stop', value: 'stop', action: 'Stop a container' },
		],
	},
];

const systemOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['system'],
			},
		},
		default: 'ping',
		options: [
			{ name: 'Info', value: 'info', action: 'Fetch system info' },
			{ name: 'Ping', value: 'ping', action: 'Ping the daemon' },
			{ name: 'Version', value: 'version', action: 'Fetch daemon version' },
		],
	},
];

const containerFields: INodeProperties[] = [
	{
		displayName: 'Container ID or Name',
		name: 'containerId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'n8n or cd17c922acd6',
		description: 'Container name or full/short container ID',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['inspect', 'logs', 'remove', 'restart', 'start', 'stop'],
			},
		},
	},
	{
		displayName: 'All Containers',
		name: 'allContainers',
		type: 'boolean',
		default: false,
		description: 'Whether to include stopped and exited containers',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['list'],
			},
		},
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: true,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['list'],
			},
		},
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: {
			minValue: 1,
		},
		default: 50,
		description: 'Max number of results to return',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['list'],
				returnAll: [false],
			},
		},
	},
	{
		displayName: 'Include Stdout',
		name: 'includeStdout',
		type: 'boolean',
		default: true,
		description: 'Whether to include stdout output',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['logs'],
			},
		},
	},
	{
		displayName: 'Include Stderr',
		name: 'includeStderr',
		type: 'boolean',
		default: true,
		description: 'Whether to include stderr output',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['logs'],
			},
		},
	},
	{
		displayName: 'Tail',
		name: 'tail',
		type: 'string',
		default: '100',
		placeholder: '100 or all',
		description: 'Number of lines from the end of the logs, or "all"',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['logs'],
			},
		},
	},
	{
		displayName: 'Include Timestamps',
		name: 'timestamps',
		type: 'boolean',
		default: false,
		description: 'Whether to prefix log lines with Docker timestamps',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['logs'],
			},
		},
	},
	{
		displayName: 'Since',
		name: 'since',
		type: 'string',
		default: '',
		placeholder: '2026-04-13T06:00:00Z or 1712978400',
		description: 'Only return logs since this timestamp',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['logs'],
			},
		},
	},
	{
		displayName: 'Until',
		name: 'until',
		type: 'string',
		default: '',
		placeholder: '2026-04-13T07:00:00Z or 1712982000',
		description: 'Only return logs before this timestamp',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['logs'],
			},
		},
	},
	{
		displayName: 'Timeout (Seconds)',
		name: 'timeoutSeconds',
		type: 'number',
		default: 10,
		description: 'How long Docker should wait before forcing the action',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['restart', 'stop'],
			},
		},
	},
	{
		displayName: 'Force',
		name: 'force',
		type: 'boolean',
		default: false,
		description: 'Whether to force container removal',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['remove'],
			},
		},
	},
	{
		displayName: 'Remove Volumes',
		name: 'removeVolumes',
		type: 'boolean',
		default: false,
		description: 'Whether to remove anonymous volumes attached to the container',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['remove'],
			},
		},
	},
];

function trimToUndefined(value: string): string | undefined {
	const trimmed = value.trim();

	return trimmed === '' ? undefined : trimmed;
}

function toExecutionItem(json: IDataObject, itemIndex: number): INodeExecutionData {
	return {
		json,
		pairedItem: {
			item: itemIndex,
		},
	};
}

function assertWritableAccess(
	node: IExecuteFunctions['getNode'],
	accessMode: DockerAccessMode,
	operation: ContainerOperation,
	itemIndex: number,
): void {
	if (accessMode === 'fullControl' || !writableContainerOperations.has(operation)) {
		return;
	}

	throw new NodeOperationError(
		node(),
		`Container operation "${operation}" requires the credential Access Mode to be set to Full Control.`,
		{ itemIndex },
	);
}

function assertNonEmptyValue(
	node: IExecuteFunctions['getNode'],
	value: string,
	label: string,
	itemIndex: number,
): string {
	const trimmed = value.trim();

	if (trimmed === '') {
		throw new NodeOperationError(node(), `${label} is required.`, { itemIndex });
	}

	return trimmed;
}

function normalizePositiveInteger(
	node: IExecuteFunctions['getNode'],
	value: number,
	label: string,
	itemIndex: number,
): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new NodeOperationError(node(), `${label} must be a positive integer.`, {
			itemIndex,
		});
	}

	return value;
}

function createNodeApiError(
	node: IExecuteFunctions['getNode'],
	error: DockerRequestError,
	itemIndex: number,
): NodeApiError {
	const payload: JsonObject = {
		message: error.message,
		method: error.method,
		path: error.path,
	};

	if (typeof error.details === 'string') {
		payload.details = error.details;
	}

	return new NodeApiError(node(), payload, {
		description: error.bodyText,
		httpCode: error.statusCode === undefined ? undefined : String(error.statusCode),
		itemIndex,
	});
}

function createContinueOnFailItem(error: unknown, itemIndex: number): INodeExecutionData {
	if (error instanceof DockerRequestError) {
		return toExecutionItem(
			{
				error: error.message,
				path: error.path,
				method: error.method,
				statusCode: error.statusCode,
				response: error.bodyText,
			},
			itemIndex,
		);
	}

	if (error instanceof Error) {
		return toExecutionItem(
			{
				error: error.message,
			},
			itemIndex,
		);
	}

	return toExecutionItem(
		{
			error: 'Unknown error',
		},
		itemIndex,
	);
}

async function executeContainerOperation(
	context: IExecuteFunctions,
	client: DockerApiClient,
	itemIndex: number,
	operation: ContainerOperation,
): Promise<INodeExecutionData[]> {
	const abortSignal = context.getExecutionCancelSignal();

	switch (operation) {
		case 'list': {
			const allContainers = context.getNodeParameter('allContainers', itemIndex) as boolean;
			const returnAll = context.getNodeParameter('returnAll', itemIndex) as boolean;
			const limitValue = context.getNodeParameter('limit', itemIndex, 50) as number;
			const limit = returnAll
				? undefined
				: normalizePositiveInteger(() => context.getNode(), limitValue, 'Limit', itemIndex);
			const containers = await client.listContainers({ all: allContainers }, abortSignal);
			const selectedContainers = limit === undefined ? containers : containers.slice(0, limit);

			return selectedContainers.map((container) =>
				toExecutionItem(container as unknown as IDataObject, itemIndex),
			);
		}

		case 'inspect': {
			const containerId = assertNonEmptyValue(
				() => context.getNode(),
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const container = await client.inspectContainer(containerId, abortSignal);

			return [toExecutionItem(container as unknown as IDataObject, itemIndex)];
		}

		case 'logs': {
			const containerId = assertNonEmptyValue(
				() => context.getNode(),
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

			const rawLogs = await client.getContainerLogs(
				containerId,
				{
					since: trimToUndefined(context.getNodeParameter('since', itemIndex, '') as string),
					stderr: includeStderr,
					stdout: includeStdout,
					tail: trimToUndefined(context.getNodeParameter('tail', itemIndex) as string),
					timestamps: context.getNodeParameter('timestamps', itemIndex) as boolean,
					until: trimToUndefined(context.getNodeParameter('until', itemIndex, '') as string),
				},
				abortSignal,
			);
			const parsedLogs = parseDockerLogStream(rawLogs.body, rawLogs.headers['content-type']);

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

		case 'start':
		case 'stop':
		case 'restart': {
			assertWritableAccess(() => context.getNode(), client.accessMode, operation, itemIndex);

			const containerId = assertNonEmptyValue(
				() => context.getNode(),
				context.getNodeParameter('containerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const timeoutSeconds =
				operation === 'start'
					? undefined
					: normalizePositiveInteger(
							() => context.getNode(),
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
					} as unknown as IDataObject,
					itemIndex,
				),
			];
		}

		case 'remove': {
			assertWritableAccess(() => context.getNode(), client.accessMode, operation, itemIndex);

			const containerId = assertNonEmptyValue(
				() => context.getNode(),
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
	}

	throw new NodeOperationError(context.getNode(), `Unsupported container operation "${operation}".`, {
		itemIndex,
	});
}

async function executeSystemOperation(
	context: IExecuteFunctions,
	client: DockerApiClient,
	itemIndex: number,
	operation: SystemOperation,
): Promise<INodeExecutionData[]> {
	const abortSignal = context.getExecutionCancelSignal();

	switch (operation) {
		case 'ping': {
			const pingResult = await client.ping(abortSignal);

			return [
				toExecutionItem(
					{
						apiVersion: pingResult.apiVersion,
						dockerExperimental: pingResult.dockerExperimental,
						ok: pingResult.ok,
						osType: pingResult.osType,
						response: pingResult.rawResponse,
					},
					itemIndex,
				),
			];
		}

		case 'info': {
			const info = await client.getInfo(abortSignal);

			return [toExecutionItem(info as unknown as IDataObject, itemIndex)];
		}

		case 'version': {
			const version = await client.getVersion(abortSignal);

			return [toExecutionItem(version as unknown as IDataObject, itemIndex)];
		}
	}

	throw new NodeOperationError(context.getNode(), `Unsupported system operation "${operation}".`, {
		itemIndex,
	});
}

export class Docker implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Docker',
		name: 'docker',
		icon: { light: 'file:docker.svg', dark: 'file:docker.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Manage Docker containers and daemon metadata with Unix socket, TCP, or TLS connections',
		defaults: {
			name: 'Docker',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'dockerApi',
				required: true,
				testedBy: 'validateDockerApiConnection',
			},
		],
		properties: [
			{
				displayName:
					'Phase 1 currently supports container lifecycle, inspection, logs, and daemon ping/info/version. SSH, image, network, volume, and binary operations are planned for later phases.',
				name: 'phaseOneNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'container',
				options: [
					{ name: 'Container', value: 'container' },
					{ name: 'System', value: 'system' },
				],
			},
			...containerOperations,
			...systemOperations,
			...containerFields,
		],
	};

	methods = {
		credentialTest: {
			async validateDockerApiConnection(
				this: ICredentialTestFunctions,
				credential: { data?: ICredentialDataDecryptedObject },
			): Promise<INodeCredentialTestResult> {
				try {
					const client = new DockerApiClient((credential.data ?? {}) as DockerCredentials);
					const pingResult = await client.ping();

					if (!pingResult.ok) {
						return {
							message: 'Docker daemon did not return an OK ping response.',
							status: 'Error',
						};
					}

					return {
						message: `Connected to Docker daemon${pingResult.apiVersion ? ` (API ${pingResult.apiVersion})` : ''}.`,
						status: 'OK',
					};
				} catch (error) {
					return {
						message: error instanceof Error ? error.message : 'Failed to connect to Docker daemon.',
						status: 'Error',
					};
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const inputItems = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex += 1) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as DockerResource;
				const operation = this.getNodeParameter('operation', itemIndex) as DockerOperation;
				const credentials = await this.getCredentials<DockerCredentials>('dockerApi', itemIndex);
				const client = new DockerApiClient(credentials);
				const operationResult =
					resource === 'container'
						? await executeContainerOperation(this, client, itemIndex, operation as ContainerOperation)
						: await executeSystemOperation(this, client, itemIndex, operation as SystemOperation);

				returnData.push(...operationResult);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push(createContinueOnFailItem(error, itemIndex));
					continue;
				}

				if (error instanceof NodeApiError || error instanceof NodeOperationError) {
					throw error;
				}

				if (error instanceof DockerRequestError) {
					throw createNodeApiError(() => this.getNode(), error, itemIndex);
				}

				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}
