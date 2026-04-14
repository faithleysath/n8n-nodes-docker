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

import { containerFields, containerOperations } from './descriptions/container';
import { imageFields, imageOperations } from './descriptions/image';
import { networkFields, networkOperations } from './descriptions/network';
import { systemFields, systemOperations } from './descriptions/system';
import { volumeFields, volumeOperations } from './descriptions/volume';
import { executeContainerOperation } from './operations/container';
import { executeImageOperation } from './operations/image';
import { executeNetworkOperation } from './operations/network';
import { executeSystemOperation } from './operations/system';
import { executeVolumeOperation } from './operations/volume';
import {
	DockerApiClient,
	DockerRequestError,
	type DockerCredentials,
} from './transport/dockerClient';
import type {
	ContainerOperation,
	DockerOperation,
	DockerResource,
	ImageOperation,
	NetworkOperation,
	SystemOperation,
	VolumeOperation,
} from './types';
import {
	createContinueOnFailItem,
	createNodeApiError,
} from './utils/execution';
import { validateDockerApiConnection } from './utils/credentialTest';

export class Docker implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Docker',
		name: 'docker',
		icon: { light: 'file:docker.svg', dark: 'file:docker.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Manage Docker containers, images, networks, volumes, and daemon metadata with Unix socket, TCP, TLS, or SSH connections',
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
					'Phase 6 keeps the main Docker node AI-usable for JSON and text operations across containers, images, networks, volumes, and daemon metadata, while Docker Files remains dedicated to binary archives, Docker Build handles long-running tar workflows, and Docker Trigger owns event subscriptions.',
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
					{ name: 'Image', value: 'image' },
					{ name: 'Network', value: 'network' },
					{ name: 'System', value: 'system' },
					{ name: 'Volume', value: 'volume' },
				],
			},
			...containerOperations,
			...imageOperations,
			...networkOperations,
			...systemOperations,
			...volumeOperations,
			...containerFields,
			...imageFields,
			...networkFields,
			...systemFields,
			...volumeFields,
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
			const resource = this.getNodeParameter('resource', itemIndex) as DockerResource;
			const operation = this.getNodeParameter('operation', itemIndex) as DockerOperation;
			let client: DockerApiClient | undefined;

			try {
				const credentials = await this.getCredentials<DockerCredentials>('dockerApi', itemIndex);
				client = new DockerApiClient(credentials);
				const operationResult =
					resource === 'container'
						? await executeContainerOperation(
								this,
								client,
								itemIndex,
								operation as ContainerOperation,
							)
						: resource === 'image'
							? await executeImageOperation(this, client, itemIndex, operation as ImageOperation)
							: resource === 'network'
								? await executeNetworkOperation(
										this,
										client,
										itemIndex,
										operation as NetworkOperation,
									)
								: resource === 'system'
									? await executeSystemOperation(
											this,
											client,
											itemIndex,
											operation as SystemOperation,
										)
									: await executeVolumeOperation(
											this,
											client,
											itemIndex,
											operation as VolumeOperation,
										);

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
			} finally {
				await client?.close();
			}
		}

		return [returnData];
	}
}
