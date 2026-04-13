import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

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
			{ name: 'Copy From', value: 'copyFrom', action: 'Copy files from a container' },
			{ name: 'Copy To', value: 'copyTo', action: 'Copy files into a container' },
			{ name: 'Exec', value: 'exec', action: 'Execute a command in a container' },
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

const imageOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['image'],
			},
		},
		default: 'list',
		options: [
			{ name: 'List', value: 'list', action: 'List images' },
			{ name: 'Inspect', value: 'inspect', action: 'Inspect an image' },
			{ name: 'Pull', value: 'pull', action: 'Pull an image' },
			{ name: 'Remove', value: 'remove', action: 'Remove an image' },
		],
	},
];

const networkOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['network'],
			},
		},
		default: 'list',
		options: [
			{ name: 'List', value: 'list', action: 'List networks' },
			{ name: 'Inspect', value: 'inspect', action: 'Inspect a network' },
			{ name: 'Create', value: 'create', action: 'Create a network' },
			{ name: 'Delete', value: 'delete', action: 'Delete a network' },
		],
	},
];

const volumeOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['volume'],
			},
		},
		default: 'list',
		options: [
			{ name: 'List', value: 'list', action: 'List volumes' },
			{ name: 'Inspect', value: 'inspect', action: 'Inspect a volume' },
			{ name: 'Create', value: 'create', action: 'Create a volume' },
			{ name: 'Delete', value: 'delete', action: 'Delete a volume' },
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
			{ name: 'Ping', value: 'ping', action: 'Ping the daemon' },
			{ name: 'Info', value: 'info', action: 'Fetch system info' },
			{ name: 'Version', value: 'version', action: 'Fetch daemon version' },
			{ name: 'Events', value: 'events', action: 'Read daemon events' },
		],
	},
];

const sharedFields: INodeProperties[] = [
	{
		displayName: 'Container ID or Name',
		name: 'containerId',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['inspect', 'start', 'stop', 'restart', 'remove', 'logs', 'exec', 'copyTo', 'copyFrom'],
			},
		},
	},
	{
		displayName: 'Image Reference',
		name: 'imageRef',
		type: 'string',
		default: '',
		placeholder: 'nginx:latest',
		displayOptions: {
			show: {
				resource: ['image'],
				operation: ['inspect', 'pull', 'remove'],
			},
		},
	},
	{
		displayName: 'Network ID or Name',
		name: 'networkId',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: ['network'],
				operation: ['inspect', 'delete'],
			},
		},
	},
	{
		displayName: 'Volume Name',
		name: 'volumeName',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: ['volume'],
				operation: ['inspect', 'delete'],
			},
		},
	},
	{
		displayName: 'Command',
		name: 'command',
		type: 'string',
		default: '',
		placeholder: 'sh -lc "echo hello"',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['exec'],
			},
		},
	},
	{
		displayName: 'Source Path',
		name: 'sourcePath',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['copyFrom'],
			},
		},
		placeholder: '/app/logs',
	},
	{
		displayName: 'Target Path',
		name: 'targetPath',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['copyTo'],
			},
		},
		placeholder: '/app/inbox',
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		displayOptions: {
			show: {
				resource: ['container'],
				operation: ['copyTo'],
			},
		},
	},
];

export class Docker implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Docker',
		name: 'docker',
		icon: { light: 'file:docker.svg', dark: 'file:docker.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Manage Docker containers, images, networks, volumes, and daemon operations',
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
			},
		],
		properties: [
			{
				displayName:
					'This repository currently contains the Docker package scaffold and roadmap. The executable Docker operations will be implemented phase by phase.',
				name: 'scaffoldNotice',
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
			...volumeOperations,
			...systemOperations,
			...sharedFields,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		throw new NodeOperationError(
			this.getNode(),
			`Docker node scaffold only: "${resource}:${operation}" is planned but not implemented yet. See README.md and docs/roadmap.md for the delivery plan.`,
		);
	}
}
