import type { INodeProperties } from 'n8n-workflow';

export const systemOperations: INodeProperties[] = [
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
			{ name: 'DF', value: 'df', action: 'Get docker data usage information' },
			{ name: 'Events', value: 'events', action: 'Read docker events within a bounded window' },
			{ name: 'Info', value: 'info', action: 'Fetch system info' },
			{ name: 'Ping', value: 'ping', action: 'Ping the daemon' },
			{ name: 'Version', value: 'version', action: 'Fetch daemon version' },
		],
	},
];

function systemOperationDisplay(operation: string[]): INodeProperties['displayOptions'] {
	return {
		show: {
			operation,
			resource: ['system'],
		},
	};
}

export const systemFields: INodeProperties[] = [
	{
		displayName: 'Lookback Seconds',
		name: 'eventsLookbackSeconds',
		type: 'number',
		default: 300,
		typeOptions: {
			minValue: 1,
		},
		description: 'How many seconds of historical events to read when Since is not set explicitly',
		displayOptions: systemOperationDisplay(['events']),
	},
	{
		displayName: 'Since',
		name: 'eventsSince',
		type: 'string',
		default: '',
		placeholder: '1712978400 or 2026-04-13T06:00:00Z',
		description: 'Only return events created since this timestamp',
		displayOptions: systemOperationDisplay(['events']),
	},
	{
		displayName: 'Until',
		name: 'eventsUntil',
		type: 'string',
		default: '',
		placeholder: '1712982000 or 2026-04-13T07:00:00Z',
		description: 'Only return events created before this timestamp. Defaults to now for bounded reads.',
		displayOptions: systemOperationDisplay(['events']),
	},
	{
		displayName: 'Resource Types',
		name: 'eventsResourceTypes',
		type: 'multiOptions',
		default: [],
		description: 'Optional Docker object types to filter',
		displayOptions: systemOperationDisplay(['events']),
		options: [
			{ name: 'Container', value: 'container' },
			{ name: 'Daemon', value: 'daemon' },
			{ name: 'Image', value: 'image' },
			{ name: 'Network', value: 'network' },
			{ name: 'Volume', value: 'volume' },
		],
	},
	{
		displayName: 'Actions',
		name: 'eventsActions',
		type: 'multiOptions',
		default: [],
		description: 'Optional Docker event actions to filter',
		displayOptions: systemOperationDisplay(['events']),
		options: [
			{ name: 'Connect', value: 'connect' },
			{ name: 'Create', value: 'create' },
			{ name: 'Destroy', value: 'destroy' },
			{ name: 'Die', value: 'die' },
			{ name: 'Disconnect', value: 'disconnect' },
			{ name: 'Load', value: 'load' },
			{ name: 'Mount', value: 'mount' },
			{ name: 'Prune', value: 'prune' },
			{ name: 'Pull', value: 'pull' },
			{ name: 'Reload', value: 'reload' },
			{ name: 'Remove', value: 'remove' },
			{ name: 'Restart', value: 'restart' },
			{ name: 'Save', value: 'save' },
			{ name: 'Start', value: 'start' },
			{ name: 'Stop', value: 'stop' },
			{ name: 'Tag', value: 'tag' },
			{ name: 'Unmount', value: 'unmount' },
			{ name: 'Untag', value: 'untag' },
			{ name: 'Update', value: 'update' },
		],
	},
];
