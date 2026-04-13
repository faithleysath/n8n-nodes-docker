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
			{ name: 'Info', value: 'info', action: 'Fetch system info' },
			{ name: 'Ping', value: 'ping', action: 'Ping the daemon' },
			{ name: 'Version', value: 'version', action: 'Fetch daemon version' },
		],
	},
];
