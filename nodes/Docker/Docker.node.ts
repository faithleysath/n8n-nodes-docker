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

import { containerFields, containerOperations } from './descriptions/container';
import { systemOperations } from './descriptions/system';
import { executeContainerOperation } from './operations/container';
import { executeSystemOperation } from './operations/system';
import {
	DockerApiClient,
	DockerRequestError,
	type DockerCredentials,
} from './transport/dockerClient';
import type {
	ContainerOperation,
	DockerOperation,
	DockerResource,
	SystemOperation,
} from './types';
import {
	createContinueOnFailItem,
	createNodeApiError,
} from './utils/execution';

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
					'Phase 2 keeps this main Docker node AI-usable for non-binary operations. File import/export is split into a separate Docker Files node, while this node now covers container lifecycle, exec, create/update, stats, top, wait, and daemon metadata.',
				name: 'phaseTwoNotice',
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
			const resource = this.getNodeParameter('resource', itemIndex) as DockerResource;
			const operation = this.getNodeParameter('operation', itemIndex) as DockerOperation;

			try {
				const credentials = await this.getCredentials<DockerCredentials>('dockerApi', itemIndex);
				const client = new DockerApiClient(credentials);
				const operationResult =
					resource === 'container'
						? await executeContainerOperation(
								this,
								client,
								itemIndex,
								operation as ContainerOperation,
							)
						: await executeSystemOperation(this, client, itemIndex, operation as SystemOperation);

				returnData.push(...operationResult);
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
			}
		}

		return [returnData];
	}
}
