import type { INodeProperties } from 'n8n-workflow';

function volumeOperationDisplay(operation: string[]): INodeProperties['displayOptions'] {
	return {
		show: {
			operation,
			resource: ['volume'],
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

export const volumeOperations: INodeProperties[] = [
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
			{ name: 'Create', value: 'create', action: 'Create a volume' },
			{ name: 'Delete', value: 'delete', action: 'Delete a volume' },
			{ name: 'Inspect', value: 'inspect', action: 'Inspect a volume' },
			{ name: 'List', value: 'list', action: 'List volumes' },
			{ name: 'Prune', value: 'prune', action: 'Prune unused volumes' },
		],
	},
];

export const volumeFields: INodeProperties[] = [
	{
		displayName: 'Return All',
		name: 'volumeReturnAll',
		type: 'boolean',
		default: true,
		description: 'Whether to return all volumes or only up to a given limit',
		displayOptions: volumeOperationDisplay(['list']),
	},
	{
		displayName: 'Limit',
		name: 'volumeLimit',
		type: 'number',
		typeOptions: {
			minValue: 1,
		},
		default: 50,
		description: 'Max number of volumes to return',
		displayOptions: {
			show: {
				operation: ['list'],
				resource: ['volume'],
				volumeReturnAll: [false],
			},
		},
	},
	{
		displayName: 'Volume Name',
		name: 'volumeName',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'workflow-data',
		description: 'Volume name or ID',
		displayOptions: volumeOperationDisplay(['create', 'delete', 'inspect']),
	},
	{
		displayName: 'Driver',
		name: 'volumeDriver',
		type: 'string',
		default: 'local',
		placeholder: 'local',
		description: 'Volume driver to use',
		displayOptions: volumeOperationDisplay(['create']),
	},
	{
		displayName: 'Labels',
		name: 'volumeLabels',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Label',
		default: {
			values: [],
		},
		displayOptions: volumeOperationDisplay(['create']),
		options: [
			{
				displayName: 'Labels',
				name: 'values',
				values: keyValueCollectionValues,
			},
		],
	},
	{
		displayName: 'Driver Options',
		name: 'volumeDriverOptions',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Option',
		default: {
			values: [],
		},
		displayOptions: volumeOperationDisplay(['create']),
		options: [
			{
				displayName: 'Options',
				name: 'values',
				values: keyValueCollectionValues,
			},
		],
	},
	{
		displayName: 'Advanced JSON',
		name: 'volumeAdvancedJson',
		type: 'json',
		default: '{}',
		description: 'Merged last and allowed to override the structured volume create payload',
		displayOptions: volumeOperationDisplay(['create']),
	},
	{
		displayName: 'Force',
		name: 'volumeDeleteForce',
		type: 'boolean',
		default: false,
		description: 'Whether to force the removal of the volume',
		displayOptions: volumeOperationDisplay(['delete']),
	},
	{
		displayName: 'Include Named Volumes',
		name: 'volumePruneIncludeNamed',
		type: 'boolean',
		default: false,
		description: 'Whether to consider all local volumes and not just anonymous volumes when pruning',
		displayOptions: volumeOperationDisplay(['prune']),
	},
];
