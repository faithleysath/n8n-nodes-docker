/* eslint-disable @n8n/community-nodes/node-usable-as-tool */
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
} from 'n8n-workflow';

import { parseDockerJsonLines } from '../Docker/transport/dockerJsonLines';
import {
	DockerApiClient,
	DockerRequestError,
	type DockerCredentials,
	type DockerStreamResponse,
} from '../Docker/transport/dockerClient';
import { collectDockerStreamResponse } from '../Docker/transport/dockerStreams';
import {
	type DockerBuildOutputMode,
	normalizeDockerBuildOutput,
	summarizeDockerBuildAux,
} from '../Docker/utils/buildOutput';
import {
	assertNonEmptyValue,
	assertWritableAccess,
	createContinueOnFailItem,
	createNodeApiError,
	getNodeGetter,
	normalizePositiveInteger,
	trimToUndefined,
} from '../Docker/utils/execution';
import { validateDockerApiConnection } from '../Docker/utils/credentialTest';

type DockerBuildOperation = 'build' | 'import';
interface DockerBuildOperationScope {
	complete(): void;
	run<T>(operation: (abortSignal: AbortSignal) => Promise<T>): Promise<T>;
	throwIfAborted(): void;
}

function getOperationDisplay(operation: DockerBuildOperation[]): INodeProperties['displayOptions'] {
	return {
		show: {
			operation,
		},
	};
}

function getFixedCollectionValues(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
): Array<Record<string, string | undefined>> {
	const parameterValue = context.getNodeParameter(name, itemIndex, { values: [] }) as {
		values?: Array<Record<string, string | undefined>>;
	};

	return Array.isArray(parameterValue.values) ? parameterValue.values : [];
}

function getStringList(context: IExecuteFunctions, name: string, itemIndex: number): string[] {
	return getFixedCollectionValues(context, name, itemIndex)
		.map((entry) => String(entry.value ?? '').trim())
		.filter((value) => value !== '');
}

function getStringRecord(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
): Record<string, string> | undefined {
	const record = getFixedCollectionValues(context, name, itemIndex).reduce<Record<string, string>>(
		(accumulator, entry) => {
			const entryName = String(entry.name ?? '').trim();
			const entryValue = String(entry.value ?? '').trim();

			if (entryName === '' || entryValue === '') {
				return accumulator;
			}

			accumulator[entryName] = entryValue;
			return accumulator;
		},
		{},
	);

	return Object.keys(record).length === 0 ? undefined : record;
}

function resolveImportReference(repository: string | undefined, tag: string | undefined): string | undefined {
	if (repository === undefined) {
		return undefined;
	}

	return tag === undefined ? repository : `${repository}:${tag}`;
}

async function collectTimedDockerStream(
	scope: DockerBuildOperationScope,
	request: (abortSignal: AbortSignal) => Promise<DockerStreamResponse>,
): Promise<{ body: Buffer; headers: DockerStreamResponse['headers'] }> {
	return await scope.run(async (abortSignal) => {
		const streamResponse = await request(abortSignal);
		const body = await collectDockerStreamResponse(streamResponse, abortSignal);

		scope.throwIfAborted();
		return {
			body,
			headers: streamResponse.headers,
		};
	});
}

function createDockerBuildOperationScope(
	context: IExecuteFunctions,
	itemIndex: number,
	operation: DockerBuildOperation,
	timeoutSeconds: number,
): DockerBuildOperationScope {
	const executionAbortSignal = context.getExecutionCancelSignal();
	const operationAbortController = new AbortController();
	const deadlineMs = Date.now() + timeoutSeconds * 1000;

	const createTimeoutError = () =>
		new NodeOperationError(
			context.getNode(),
			`Docker ${operation} timed out after ${timeoutSeconds} seconds.`,
			{ itemIndex },
		);
	const createCancelError = () =>
		new NodeOperationError(context.getNode(), `Docker ${operation} was cancelled.`, {
			itemIndex,
		});

	const clearAbortReason = () => {
		if (executionAbortSignal?.aborted) {
			throw createCancelError();
		}

		if (Date.now() >= deadlineMs) {
			operationAbortController.abort();
			throw createTimeoutError();
		}
	};

	return {
		complete() {
			// No-op: per-step timeout and cancel listeners are cleaned up inside run().
		},
		async run<T>(task: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
			clearAbortReason();
			const remainingMs = deadlineMs - Date.now();
			const taskPromise = task(operationAbortController.signal);
			const timeoutPromise = new Promise<never>((_, reject) => {
				const timeout = setTimeout(() => {
					operationAbortController.abort();
					reject(createTimeoutError());
				}, remainingMs);

				taskPromise.finally(() => clearTimeout(timeout)).catch(() => {});
			});
			const cancelPromise =
				executionAbortSignal === undefined
					? undefined
					: new Promise<never>((_, reject) => {
							const onAbort = () => {
								executionAbortSignal.removeEventListener('abort', onAbort);
								operationAbortController.abort();
								reject(createCancelError());
							};

							if (executionAbortSignal.aborted) {
								onAbort();
								return;
							}

							executionAbortSignal.addEventListener('abort', onAbort, { once: true });
							taskPromise.finally(() => {
								executionAbortSignal.removeEventListener('abort', onAbort);
							}).catch(() => {});
						});

			return await Promise.race(
				cancelPromise === undefined ? [taskPromise, timeoutPromise] : [taskPromise, timeoutPromise, cancelPromise],
			);
		},
		throwIfAborted() {
			clearAbortReason();
		},
	};
}

export class DockerBuild implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Docker Build',
		name: 'dockerBuild',
		icon: { light: 'file:../Docker/docker.svg', dark: 'file:../Docker/docker.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Build images from tar contexts and import image archives with streamed Docker output',
		defaults: {
			name: 'Docker Build',
		},
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
						'Phase 6 keeps Docker Build dedicated to long-running tar-based image build and import workflows, including streamed progress, timeout-aware execution, cancellation, and SSH-backed daemon connections.',
					name: 'phaseFiveNotice',
					type: 'notice',
					default: '',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'build',
				options: [
					{ name: 'Build', value: 'build', action: 'Build an image from a tar context' },
					{ name: 'Import', value: 'import', action: 'Import an image from a tar archive' },
				],
			},
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						operation: ['build', 'import'],
					},
				},
			},
			{
				displayName: 'Dockerfile Path',
				name: 'dockerfilePath',
				type: 'string',
				default: 'Dockerfile',
				description: 'Path inside the tar build context to the Dockerfile',
				displayOptions: getOperationDisplay(['build']),
			},
			{
				displayName: 'Tags',
				name: 'buildTags',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Tag',
				default: {
					values: [],
				},
				displayOptions: getOperationDisplay(['build']),
				options: [
					{
						displayName: 'Tags',
						name: 'values',
						values: [
							{
								displayName: 'Tag',
								name: 'value',
								type: 'string',
								default: '',
								required: true,
							},
						],
					},
				],
				description: 'Optional image names and tags to apply during build',
			},
			{
				displayName: 'Build Args',
				name: 'buildArgs',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Build Arg',
				default: {
					values: [],
				},
				displayOptions: getOperationDisplay(['build']),
				options: [
					{
						displayName: 'Arguments',
						name: 'values',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								required: true,
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								required: true,
							},
						],
					},
				],
				description: 'Build-time variables passed to Docker during image build',
			},
			{
				displayName: 'Labels',
				name: 'buildLabels',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Label',
				default: {
					values: [],
				},
				displayOptions: getOperationDisplay(['build']),
				options: [
					{
						displayName: 'Labels',
						name: 'values',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								required: true,
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								required: true,
							},
						],
					},
				],
				description: 'Image labels applied during build',
			},
			{
				displayName: 'Platform',
				name: 'platform',
				type: 'string',
				default: '',
				placeholder: 'linux/amd64',
				description: 'Optional target platform in the format os[/arch[/variant]]',
				displayOptions: {
					show: {
						operation: ['build', 'import'],
					},
				},
			},
			{
				displayName: 'Target Stage',
				name: 'targetStage',
				type: 'string',
				default: '',
				description: 'Optional multi-stage build target name',
				displayOptions: getOperationDisplay(['build']),
			},
			{
				displayName: 'Builder Backend',
				name: 'builderVersion',
				type: 'options',
				default: '2',
				displayOptions: getOperationDisplay(['build']),
				options: [
					{ name: 'BuildKit', value: '2' },
					{ name: 'Classic', value: '1' },
				],
				description: 'Version 2 uses BuildKit, while version 1 uses the classic Docker builder',
			},
			{
				displayName: 'Pull',
				name: 'buildPull',
				type: 'boolean',
				default: false,
				description: 'Whether to pull newer base images even if an older one exists locally',
				displayOptions: getOperationDisplay(['build']),
			},
			{
				displayName: 'No Cache',
				name: 'buildNoCache',
				type: 'boolean',
				default: false,
				description: 'Whether to disable the build cache',
				displayOptions: getOperationDisplay(['build']),
			},
			{
				displayName: 'Quiet',
				name: 'buildQuiet',
				type: 'boolean',
				default: false,
				description: 'Whether to suppress verbose build progress output',
				displayOptions: getOperationDisplay(['build']),
			},
			{
				displayName: 'Remove Intermediate Containers',
				name: 'buildRemoveIntermediateContainers',
				type: 'boolean',
				default: true,
				description: 'Whether to remove intermediate containers after a successful build',
				displayOptions: getOperationDisplay(['build']),
			},
			{
				displayName: 'Always Remove Intermediate Containers',
				name: 'buildAlwaysRemoveIntermediateContainers',
				type: 'boolean',
				default: false,
				description: 'Whether to remove intermediate containers even if the build fails',
				displayOptions: getOperationDisplay(['build']),
			},
			{
				displayName: 'Network Mode',
				name: 'buildNetworkMode',
				type: 'string',
				default: '',
				description: 'Networking mode to use for RUN steps during build',
				displayOptions: getOperationDisplay(['build']),
			},
			{
				displayName: 'Timeout Seconds',
				name: 'timeoutSeconds',
				type: 'number',
				typeOptions: {
					minValue: 1,
				},
				default: 900,
				description: 'Maximum time to wait before cancelling the build or import request',
				displayOptions: {
					show: {
						operation: ['build', 'import'],
					},
				},
			},
			{
				displayName: 'Output Mode',
				name: 'outputMode',
				type: 'options',
				default: 'aggregate',
				displayOptions: {
					show: {
						operation: ['build', 'import'],
					},
				},
				options: [
					{ name: 'Aggregate', value: 'aggregate' },
					{ name: 'Split Items', value: 'splitItems' },
				],
				description: 'Whether to return a single aggregated result or one item per parsed progress message',
			},
			{
				displayName: 'Repository',
				name: 'importRepository',
				type: 'string',
				default: '',
				description: 'Optional repository name to assign to the imported image',
				displayOptions: getOperationDisplay(['import']),
			},
			{
				displayName: 'Tag',
				name: 'importTag',
				type: 'string',
				default: '',
				description: 'Optional tag to assign when importing the image',
				displayOptions: getOperationDisplay(['import']),
			},
			{
				displayName: 'Changes',
				name: 'importChanges',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Change',
				default: {
					values: [],
				},
				displayOptions: getOperationDisplay(['import']),
				options: [
					{
						displayName: 'Changes',
						name: 'values',
						values: [
							{
								displayName: 'Instruction',
								name: 'value',
								type: 'string',
								default: '',
								required: true,
							},
						],
					},
				],
				description: 'Optional Dockerfile instructions to apply while importing the image',
			},
			{
				displayName: 'Message',
				name: 'importMessage',
				type: 'string',
				default: '',
				description: 'Optional commit message to record for the imported image',
				displayOptions: getOperationDisplay(['import']),
			},
		],
	};

	methods = {
		credentialTest: {
			validateDockerApiConnection,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const inputItems = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex += 1) {
			const operation = this.getNodeParameter('operation', itemIndex) as DockerBuildOperation;
			let client: DockerApiClient | undefined;

			try {
				const credentials = await this.getCredentials<DockerCredentials>('dockerApi', itemIndex);
				client = new DockerApiClient(credentials);
				const node = getNodeGetter(this);
				assertWritableAccess(node, client.accessMode, operation, itemIndex);
				const binaryPropertyName = assertNonEmptyValue(
					node,
					this.getNodeParameter('binaryPropertyName', itemIndex) as string,
					'Binary Property',
					itemIndex,
				);
				const inputBinary = inputItems[itemIndex].binary?.[binaryPropertyName];

				if (inputBinary === undefined) {
					throw new NodeOperationError(
						this.getNode(),
						`Binary property "${binaryPropertyName}" was not found on the input item.`,
						{ itemIndex },
					);
				}

				const resolvedBinary = this.helpers.assertBinaryData(itemIndex, inputBinary);
				const binaryBuffer = await this.helpers.getBinaryDataBuffer(itemIndex, resolvedBinary);
				const timeoutSeconds = normalizePositiveInteger(
					node,
					this.getNodeParameter('timeoutSeconds', itemIndex, 900) as number,
					'Timeout Seconds',
					itemIndex,
				);
				const outputMode = this.getNodeParameter(
					'outputMode',
					itemIndex,
					'aggregate',
				) as DockerBuildOutputMode;
				const operationScope = createDockerBuildOperationScope(
					this,
					itemIndex,
					operation,
					timeoutSeconds,
				);

				try {
					if (operation === 'build') {
						const tags = getStringList(this, 'buildTags', itemIndex);
						const builderVersion = this.getNodeParameter(
							'builderVersion',
							itemIndex,
							'2',
						) as '1' | '2';
							const streamResult = await collectTimedDockerStream(
								operationScope,
								async (abortSignal) =>
									await client!.buildImage(
									{
										body: binaryBuffer,
										buildArgs: getStringRecord(this, 'buildArgs', itemIndex),
										dockerfile: trimToUndefined(
											this.getNodeParameter('dockerfilePath', itemIndex, 'Dockerfile') as string,
										),
										forceRm: this.getNodeParameter(
											'buildAlwaysRemoveIntermediateContainers',
											itemIndex,
										) as boolean,
										labels: getStringRecord(this, 'buildLabels', itemIndex),
										networkMode: trimToUndefined(
											this.getNodeParameter('buildNetworkMode', itemIndex, '') as string,
										),
										noCache: this.getNodeParameter('buildNoCache', itemIndex) as boolean,
										platform: trimToUndefined(
											this.getNodeParameter('platform', itemIndex, '') as string,
										),
										pull: this.getNodeParameter('buildPull', itemIndex) as boolean,
										quiet: this.getNodeParameter('buildQuiet', itemIndex) as boolean,
										rm: this.getNodeParameter(
											'buildRemoveIntermediateContainers',
											itemIndex,
										) as boolean,
										tags,
										target: trimToUndefined(
											this.getNodeParameter('targetStage', itemIndex, '') as string,
										),
										timeoutMs: 0,
										version: builderVersion,
									},
									abortSignal,
								),
						);
						const parsedMessages = parseDockerJsonLines(
							streamResult.body,
							streamResult.headers['content-type'],
						);
						const auxSummary = summarizeDockerBuildAux(parsedMessages.entries as IDataObject[]);

						operationScope.throwIfAborted();
						returnData.push(
							...normalizeDockerBuildOutput({
								aggregateData: {
									binaryPropertyName,
									builderVersion,
									bytes: binaryBuffer.length,
									imageDigest: auxSummary.imageDigest,
									imageId: auxSummary.imageId,
									namedReferences: auxSummary.namedReferences,
									tags,
								},
								itemIndex,
								operation,
								outputMode,
								parsedMessages,
								splitData: {
									binaryPropertyName,
									builderVersion,
									bytes: binaryBuffer.length,
									tags,
								},
							}),
						);
						continue;
					}

					const repository = trimToUndefined(
						this.getNodeParameter('importRepository', itemIndex, '') as string,
					);
					const tag = trimToUndefined(
						this.getNodeParameter('importTag', itemIndex, '') as string,
					);
					const changes = getStringList(this, 'importChanges', itemIndex);
					const importMessage = trimToUndefined(
						this.getNodeParameter('importMessage', itemIndex, '') as string,
					);
						const streamResult = await collectTimedDockerStream(
							operationScope,
							async (abortSignal) =>
								await client!.importImage(
								{
									body: binaryBuffer,
									changes,
									message: importMessage,
									platform: trimToUndefined(
										this.getNodeParameter('platform', itemIndex, '') as string,
									),
									repo: repository,
									tag,
									timeoutMs: 0,
								},
								abortSignal,
							),
					);
					const parsedMessages = parseDockerJsonLines(
						streamResult.body,
						streamResult.headers['content-type'],
					);
					const importReference = resolveImportReference(repository, tag);
					let image: IDataObject | null = null;

						if (importReference !== undefined) {
							try {
								image = (await operationScope.run(
									async (abortSignal) =>
										(await client!.inspectImage(importReference, abortSignal)) as IDataObject,
								)) as IDataObject;
						} catch {
							operationScope.throwIfAborted();
							image = null;
						}
					}

					operationScope.throwIfAborted();
					returnData.push(
						...normalizeDockerBuildOutput({
							aggregateData: {
								binaryPropertyName,
								bytes: binaryBuffer.length,
								changes,
								image,
								message: importMessage ?? null,
								repository: repository ?? null,
								tag: tag ?? null,
							},
							itemIndex,
							operation,
							outputMode,
							parsedMessages,
							splitData: {
								binaryPropertyName,
								bytes: binaryBuffer.length,
								message: importMessage ?? null,
								repository: repository ?? null,
								tag: tag ?? null,
							},
						}),
					);
				} finally {
					operationScope.complete();
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push(
						createContinueOnFailItem(error, itemIndex, {
							operation,
						}),
					);
					continue;
				}

				if (error instanceof NodeApiError || error instanceof NodeOperationError) {
					throw error;
				}

				if (error instanceof DockerRequestError) {
					throw createNodeApiError(() => this.getNode(), error, itemIndex);
				}

				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			} finally {
				await client?.close();
			}
		}

		return [returnData];
	}
}
