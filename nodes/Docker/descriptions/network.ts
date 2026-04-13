import type { INodeProperties } from 'n8n-workflow';

function networkOperationDisplay(operation: string[]): INodeProperties['displayOptions'] {
	return {
		show: {
			operation,
			resource: ['network'],
		},
	};
}

const keyValueCollectionValues: INodeProperties[] = [
	{
		displayName: 'Name',
		name: 'name',
		required: true,
		type: 'string',
		default: '',
	},
	{
		displayName: 'Value',
		name: 'value',
		type: 'string',
		default: '',
	},
];

export const networkOperations: INodeProperties[] = [
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
			{ name: 'Connect', value: 'connect', action: 'Connect a container to a network' },
			{ name: 'Create', value: 'create', action: 'Create a network' },
			{ name: 'Delete', value: 'delete', action: 'Delete a network' },
			{ name: 'Disconnect', value: 'disconnect', action: 'Disconnect a container from a network' },
			{ name: 'Inspect', value: 'inspect', action: 'Inspect a network' },
			{ name: 'List', value: 'list', action: 'List networks' },
			{ name: 'Prune', value: 'prune', action: 'Prune unused networks' },
		],
	},
];

export const networkFields: INodeProperties[] = [
	{
		displayName: 'Return All',
		name: 'networkReturnAll',
		type: 'boolean',
		default: true,
		description: 'Whether to return all networks or only up to a given limit',
		displayOptions: networkOperationDisplay(['list']),
	},
	{
		displayName: 'Limit',
		name: 'networkLimit',
		type: 'number',
		typeOptions: {
			minValue: 1,
		},
		default: 50,
		description: 'Max number of networks to return',
		displayOptions: {
			show: {
				networkReturnAll: [false],
				operation: ['list'],
				resource: ['network'],
			},
		},
	},
	{
		displayName: 'Network ID or Name',
		name: 'networkId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'bridge or 3c1f18dd9f11',
		description: 'Network name or ID',
		displayOptions: networkOperationDisplay(['connect', 'delete', 'disconnect', 'inspect']),
	},
	{
		displayName: 'Name',
		name: 'networkName',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'workflow-net',
		description: 'Name of the new network',
		displayOptions: networkOperationDisplay(['create']),
	},
	{
		displayName: 'Driver',
		name: 'networkDriver',
		type: 'string',
		default: 'bridge',
		placeholder: 'bridge',
		description: 'Network driver to use',
		displayOptions: networkOperationDisplay(['create']),
	},
	{
		displayName: 'Attachable',
		name: 'networkAttachable',
		type: 'boolean',
		default: false,
		description: 'Whether standalone containers can manually attach to the network',
		displayOptions: networkOperationDisplay(['create']),
	},
	{
		displayName: 'Internal',
		name: 'networkInternal',
		type: 'boolean',
		default: false,
		description: 'Whether to restrict external access to the network',
		displayOptions: networkOperationDisplay(['create']),
	},
	{
		displayName: 'Enable IPv6',
		name: 'networkEnableIpv6',
		type: 'boolean',
		default: false,
		description: 'Whether to enable IPv6 on the network',
		displayOptions: networkOperationDisplay(['create']),
	},
	{
		displayName: 'Labels',
		name: 'networkLabels',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Label',
		default: {
			values: [],
		},
		displayOptions: networkOperationDisplay(['create']),
		options: [
			{
				displayName: 'Labels',
				name: 'values',
				values: keyValueCollectionValues,
			},
		],
	},
	{
		displayName: 'Advanced JSON',
		name: 'networkAdvancedJson',
		type: 'json',
		default: '{}',
		description: 'Merged last and allowed to override the structured network create payload',
		displayOptions: networkOperationDisplay(['create']),
	},
	{
		displayName: 'Container ID or Name',
		name: 'networkContainerId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'n8n or cd17c922acd6',
		description: 'Container to attach or detach',
		displayOptions: networkOperationDisplay(['connect', 'disconnect']),
	},
	{
		displayName: 'Aliases',
		name: 'networkAliases',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Alias',
		default: {
			values: [],
		},
		displayOptions: networkOperationDisplay(['connect']),
		options: [
			{
				displayName: 'Aliases',
				name: 'values',
				values: [
					{
						displayName: 'Alias',
						name: 'value',
						type: 'string',
						default: '',
						required: true,
					},
				],
			},
		],
	},
	{
		displayName: 'IPv4 Address',
		name: 'networkIpv4Address',
		type: 'string',
		default: '',
		placeholder: '172.24.56.89',
		description: 'Optional static IPv4 address for the endpoint',
		displayOptions: networkOperationDisplay(['connect']),
	},
	{
		displayName: 'IPv6 Address',
		name: 'networkIpv6Address',
		type: 'string',
		default: '',
		placeholder: '2001:db8::5689',
		description: 'Optional static IPv6 address for the endpoint',
		displayOptions: networkOperationDisplay(['connect']),
	},
	{
		displayName: 'Advanced JSON',
		name: 'networkConnectAdvancedJson',
		type: 'json',
		default: '{}',
		description: 'Merged last and allowed to override the structured network connect payload',
		displayOptions: networkOperationDisplay(['connect']),
	},
	{
		displayName: 'Force',
		name: 'networkDisconnectForce',
		type: 'boolean',
		default: false,
		description: 'Whether to force the container disconnect from the network',
		displayOptions: networkOperationDisplay(['disconnect']),
	},
];
