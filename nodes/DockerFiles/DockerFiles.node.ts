/* eslint-disable @n8n/community-nodes/node-usable-as-tool */
import { posix } from 'node:path';

import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
} from 'n8n-workflow';

import {
	DockerApiClient,
	DockerRequestError,
	type DockerCredentials,
} from '../Docker/transport/dockerClient';
import { parseDockerJsonLines } from '../Docker/transport/dockerJsonLines';
import {
	createContinueOnFailItem,
	createNodeApiError,
	assertNonEmptyValue,
	assertWritableAccess,
	getNodeGetter,
	toExecutionItem,
	trimToUndefined,
} from '../Docker/utils/execution';
import {
	createSingleFileTarArchive,
	decodeContainerArchiveStatHeader,
	extractSingleFileFromTarBuffer,
} from '../Docker/utils/tar';
import { validateDockerApiConnection } from '../Docker/utils/credentialTest';

type DockerFilesResource = 'container' | 'image';
type DockerFilesOperation = 'copyFrom' | 'copyTo' | 'export' | 'load' | 'save';

function getFixedCollectionValues(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
): Array<{ value?: string }> {
	const parameterValue = context.getNodeParameter(name, itemIndex, { values: [] }) as {
		values?: Array<{ value?: string }>;
	};

	return Array.isArray(parameterValue.values) ? parameterValue.values : [];
}

function getStringList(context: IExecuteFunctions, name: string, itemIndex: number): string[] {
	return getFixedCollectionValues(context, name, itemIndex)
		.map((entry) => String(entry.value ?? '').trim())
		.filter((value) => value !== '');
}

function getPreferredFileName(pathValue: string, fallback: string): string {
	const candidate = posix.basename(pathValue);

	return candidate === '' || candidate === '.' || candidate === '/' ? fallback : candidate;
}

export class DockerFiles implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Docker Files',
		name: 'dockerFiles',
		icon: { light: 'file:../Docker/docker.svg', dark: 'file:../Docker/docker.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Copy files to and from Docker containers, export container filesystems, and save or load Docker image tar archives',
		defaults: {
			name: 'Docker Files',
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
					'Docker Files handles binary and tar workflows for container archives and image save/load. It stays separate from the AI-usable Docker node so binary streams, long archive transfers, and SSH-backed file operations remain isolated.',
				name: 'dockerFilesNotice',
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
					{ name: 'Image', value: 'image' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'copyFrom',
				displayOptions: {
					show: {
						resource: ['container'],
					},
				},
				options: [
					{ name: 'Copy From', value: 'copyFrom', action: 'Copy files from a container' },
					{ name: 'Copy To', value: 'copyTo', action: 'Copy files to a container' },
					{ name: 'Export', value: 'export', action: 'Export a container filesystem' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'save',
				displayOptions: {
					show: {
						resource: ['image'],
					},
				},
				options: [
					{ name: 'Load', value: 'load', action: 'Load docker images from a tar archive' },
					{ name: 'Save', value: 'save', action: 'Save docker images to a tar archive' },
				],
			},
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
					},
				},
			},
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						operation: ['copyTo', 'load'],
					},
				},
			},
			{
				displayName: 'Target Path',
				name: 'targetPath',
				type: 'string',
				default: '',
				required: true,
				placeholder: '/tmp',
				description: 'Directory inside the container where the uploaded tar archive will be extracted',
				displayOptions: {
					show: {
						operation: ['copyTo'],
					},
				},
			},
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: '',
				description: 'Optional file name inside the generated tar archive. Defaults to the source binary file name.',
				displayOptions: {
					show: {
						operation: ['copyTo'],
					},
				},
			},
			{
				displayName: 'No Overwrite Dir/Non-Dir',
				name: 'noOverwriteDirNonDir',
				type: 'boolean',
				default: false,
					description:
						'Whether to fail if extraction would replace a directory with a non-directory or vice versa',
				displayOptions: {
					show: {
						operation: ['copyTo'],
					},
				},
			},
			{
				displayName: 'Copy UID/GID',
				name: 'copyUidGid',
				type: 'boolean',
				default: false,
					description: 'Whether to copy file ownership metadata when the daemon supports it',
				displayOptions: {
					show: {
						operation: ['copyTo'],
					},
				},
			},
			{
				displayName: 'Source Path',
				name: 'sourcePath',
				type: 'string',
				default: '',
				required: true,
				placeholder: '/tmp/report.txt',
				description: 'Path inside the container to archive and download',
				displayOptions: {
					show: {
						operation: ['copyFrom'],
					},
				},
			},
			{
				displayName: 'Output Binary Property',
				name: 'outputBinaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						operation: ['copyFrom', 'export', 'save'],
					},
				},
			},
			{
				displayName: 'Extract Single File',
				name: 'extractSingleFile',
				type: 'boolean',
				default: false,
					description:
						'Whether to unpack a single regular file from the tar archive instead of returning the raw tar binary',
				displayOptions: {
					show: {
						operation: ['copyFrom'],
					},
				},
			},
			{
				displayName: 'Image References',
				name: 'imageReferences',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Image',
				default: {
					values: [],
				},
				displayOptions: {
					show: {
						operation: ['save'],
						resource: ['image'],
					},
				},
				options: [
					{
						displayName: 'Images',
						name: 'values',
						values: [
							{
								displayName: 'Image Reference',
								name: 'value',
								type: 'string',
								default: '',
								required: true,
							},
						],
					},
				],
				description: 'One or more image names, tags, digests, or IDs to include in the exported tar archive',
			},
			{
				displayName: 'File Name',
				name: 'saveFileName',
				type: 'string',
				default: 'docker-images.tar',
				description: 'Optional binary file name for the exported image tarball',
				displayOptions: {
					show: {
						operation: ['save'],
						resource: ['image'],
					},
				},
			},
			{
				displayName: 'Quiet',
				name: 'loadQuiet',
				type: 'boolean',
				default: false,
				description: 'Whether to suppress progress details during image load',
				displayOptions: {
					show: {
						operation: ['load'],
						resource: ['image'],
					},
				},
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
			const resource = this.getNodeParameter('resource', itemIndex) as DockerFilesResource;
			const operation = this.getNodeParameter('operation', itemIndex) as DockerFilesOperation;
			let client: DockerApiClient | undefined;

			try {
				const credentials = await this.getCredentials<DockerCredentials>('dockerApi', itemIndex);
				client = new DockerApiClient(credentials);
				const node = getNodeGetter(this);
				assertWritableAccess(node, client.accessMode, operation, itemIndex);
				if (resource === 'container' && operation === 'copyTo') {
					const containerId = assertNonEmptyValue(
						node,
						this.getNodeParameter('containerId', itemIndex) as string,
						'Container ID or Name',
						itemIndex,
					);
					const binaryPropertyName = assertNonEmptyValue(
						node,
						this.getNodeParameter('binaryPropertyName', itemIndex) as string,
						'Binary Property',
						itemIndex,
					);
					const targetPath = assertNonEmptyValue(
						node,
						this.getNodeParameter('targetPath', itemIndex) as string,
						'Target Path',
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
					const fileName =
						trimToUndefined(this.getNodeParameter('fileName', itemIndex, '') as string) ??
						resolvedBinary.fileName ??
						'file.bin';
					const tarBuffer = await createSingleFileTarArchive(fileName, binaryBuffer);
					const actionResult = await client.putContainerArchive(
						containerId,
						{
							body: tarBuffer,
							copyUidGid: this.getNodeParameter('copyUidGid', itemIndex) as boolean,
							noOverwriteDirNonDir: this.getNodeParameter(
								'noOverwriteDirNonDir',
								itemIndex,
							) as boolean,
							path: targetPath,
						},
						this.getExecutionCancelSignal(),
					);

					returnData.push(
						toExecutionItem(
							{
								bytes: binaryBuffer.length,
								changed: actionResult.changed,
								containerId,
								fileName,
								operation,
								statusCode: actionResult.statusCode,
								targetPath,
							},
							itemIndex,
						),
					);
					continue;
				}

				if (resource === 'container' && operation === 'copyFrom') {
					const containerId = assertNonEmptyValue(
						node,
						this.getNodeParameter('containerId', itemIndex) as string,
						'Container ID or Name',
						itemIndex,
					);
					const sourcePath = assertNonEmptyValue(
						node,
						this.getNodeParameter('sourcePath', itemIndex) as string,
						'Source Path',
						itemIndex,
					);
					const outputBinaryPropertyName = assertNonEmptyValue(
						node,
						this.getNodeParameter('outputBinaryPropertyName', itemIndex) as string,
						'Output Binary Property',
						itemIndex,
					);
					const shouldExtractSingleFile = this.getNodeParameter(
						'extractSingleFile',
						itemIndex,
					) as boolean;
					const archiveInfoResponse = await client.getContainerArchiveInfo(
						containerId,
						{ path: sourcePath },
						this.getExecutionCancelSignal(),
					);
					const pathStat = decodeContainerArchiveStatHeader(
						archiveInfoResponse.headers['x-docker-container-path-stat'],
					);
					const archiveResponse = await client.getContainerArchive(
						containerId,
						{ path: sourcePath },
						this.getExecutionCancelSignal(),
					);
					const extractionResult = shouldExtractSingleFile
						? await extractSingleFileFromTarBuffer(archiveResponse.body)
						: undefined;
					const extractedFile =
						extractionResult !== undefined && extractionResult.reason === undefined
							? extractionResult.file
							: undefined;
					const extractionEntryCount = extractionResult?.entryCount ?? null;

					if (extractedFile !== undefined) {
						const preparedBinary = await this.helpers.prepareBinaryData(
							extractedFile.content,
							extractedFile.fileName,
						);

						returnData.push(
							toExecutionItem(
								{
									archivePathStat: pathStat ?? null,
									containerId,
									entryCount: extractionEntryCount,
									extractedSingleFile: true,
									operation,
									outputMode: 'singleFile',
									sourcePath,
								},
								itemIndex,
								{
									[outputBinaryPropertyName]: preparedBinary,
								},
							),
						);
						continue;
					}

					const tarFileName = `${getPreferredFileName(
						pathStat?.name ?? sourcePath,
						'archive',
					)}.tar`;
					const preparedBinary = await this.helpers.prepareBinaryData(
						archiveResponse.body,
						tarFileName,
						'application/x-tar',
					);

					returnData.push(
						toExecutionItem(
							{
								archivePathStat: pathStat ?? null,
								containerId,
								entryCount: extractionEntryCount,
								extractedSingleFile: false,
								fallbackReason: extractionResult?.reason ?? null,
								operation,
								outputMode: 'tar',
								sourcePath,
							},
							itemIndex,
							{
								[outputBinaryPropertyName]: preparedBinary,
							},
						),
					);
					continue;
				}

				if (resource === 'container' && operation === 'export') {
					const containerId = assertNonEmptyValue(
						node,
						this.getNodeParameter('containerId', itemIndex) as string,
						'Container ID or Name',
						itemIndex,
					);
					const outputBinaryPropertyName = assertNonEmptyValue(
						node,
						this.getNodeParameter('outputBinaryPropertyName', itemIndex) as string,
						'Output Binary Property',
						itemIndex,
					);
					const exportResponse = await client.exportContainer(
						containerId,
						this.getExecutionCancelSignal(),
					);
					const preparedBinary = await this.helpers.prepareBinaryData(
						exportResponse.body,
						`${containerId}.tar`,
						'application/x-tar',
					);

					returnData.push(
						toExecutionItem(
							{
								bytes: exportResponse.body.length,
								containerId,
								operation,
								outputMode: 'tar',
							},
							itemIndex,
							{
								[outputBinaryPropertyName]: preparedBinary,
							},
						),
					);
					continue;
				}

				if (resource === 'image' && operation === 'save') {
					const imageReferences = getStringList(this, 'imageReferences', itemIndex);

					if (imageReferences.length === 0) {
						throw new NodeOperationError(this.getNode(), 'Image References must include at least one image.', {
							itemIndex,
						});
					}

					const outputBinaryPropertyName = assertNonEmptyValue(
						node,
						this.getNodeParameter('outputBinaryPropertyName', itemIndex) as string,
						'Output Binary Property',
						itemIndex,
					);
					const fileName =
						trimToUndefined(this.getNodeParameter('saveFileName', itemIndex, '') as string) ??
						'docker-images.tar';
					const saveResponse = await client.saveImages(
						{
							names: imageReferences,
						},
						this.getExecutionCancelSignal(),
					);
					const preparedBinary = await this.helpers.prepareBinaryData(
						saveResponse.body,
						fileName,
						'application/x-tar',
					);

					returnData.push(
						toExecutionItem(
							{
								bytes: saveResponse.body.length,
								imageReferences,
								operation,
								outputMode: 'tar',
							},
							itemIndex,
							{
								[outputBinaryPropertyName]: preparedBinary,
							},
						),
					);
					continue;
				}

				if (resource === 'image' && operation === 'load') {
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
					const quiet = this.getNodeParameter('loadQuiet', itemIndex) as boolean;
					const loadResponse = await client.loadImages(
						{
							body: binaryBuffer,
							quiet,
						},
						this.getExecutionCancelSignal(),
					);
					const parsedMessages = parseDockerJsonLines(
						loadResponse.body,
						loadResponse.headers['content-type'],
					);

					returnData.push(
						toExecutionItem(
							{
								binaryPropertyName,
								bytes: binaryBuffer.length,
								contentType: parsedMessages.contentType,
								messageCount: parsedMessages.entries.length,
								messages: parsedMessages.entries,
								operation,
								quiet,
								rawLines: parsedMessages.rawLines,
								unparsedLines: parsedMessages.unparsedLines,
							},
							itemIndex,
						),
					);
					continue;
				}

				throw new NodeOperationError(
					this.getNode(),
					`Unsupported Docker Files combination: resource "${resource}" with operation "${operation}".`,
					{ itemIndex },
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push(
						createContinueOnFailItem(error, itemIndex, {
							operation,
							resource,
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
