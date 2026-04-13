/* eslint-disable @n8n/community-nodes/node-usable-as-tool */
import { posix } from 'node:path';

import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunctions,
	IExecuteFunctions,
	INodeCredentialTestResult,
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

type DockerFilesOperation = 'copyFrom' | 'copyTo' | 'export';

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
		description: 'Copy files to and from Docker containers, and export container filesystems',
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
					'Docker Files handles binary and tar workflows. It is intentionally separate from the AI-usable Docker node so binary data and file-system exports stay isolated.',
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
				options: [{ name: 'Container', value: 'container' }],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'copyFrom',
				options: [
					{ name: 'Copy From', value: 'copyFrom', action: 'Copy files from a container' },
					{ name: 'Copy To', value: 'copyTo', action: 'Copy files to a container' },
					{ name: 'Export', value: 'export', action: 'Export a container filesystem' },
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
			},
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						operation: ['copyTo'],
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
						operation: ['copyFrom', 'export'],
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
			const operation = this.getNodeParameter('operation', itemIndex) as DockerFilesOperation;

			try {
				const credentials = await this.getCredentials<DockerCredentials>('dockerApi', itemIndex);
				const client = new DockerApiClient(credentials);
				const node = getNodeGetter(this);
				assertWritableAccess(node, client.accessMode, operation, itemIndex);
				const containerId = assertNonEmptyValue(
					node,
					this.getNodeParameter('containerId', itemIndex) as string,
					'Container ID or Name',
					itemIndex,
				);

				if (operation === 'copyTo') {
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

				if (operation === 'copyFrom') {
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
					const extractedFile = extractionResult?.file;
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
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push(
						createContinueOnFailItem(error, itemIndex, {
							operation,
							resource: 'container',
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
			}
		}

		return [returnData];
	}
}
