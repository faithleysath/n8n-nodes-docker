import type { INodeProperties } from 'n8n-workflow';

function containerOperationDisplay(operation: string[]): INodeProperties['displayOptions'] {
	return {
		show: {
			operation,
			resource: ['container'],
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

export const containerOperations: INodeProperties[] = [
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
			{ name: 'Create', value: 'create', action: 'Create a container' },
			{ name: 'Exec', value: 'exec', action: 'Execute a command in a container' },
			{ name: 'Inspect', value: 'inspect', action: 'Inspect a container' },
			{ name: 'List', value: 'list', action: 'List containers' },
			{ name: 'Logs', value: 'logs', action: 'Fetch container logs' },
			{ name: 'Remove', value: 'remove', action: 'Remove a container' },
			{ name: 'Restart', value: 'restart', action: 'Restart a container' },
			{ name: 'Start', value: 'start', action: 'Start a container' },
			{ name: 'Stats', value: 'stats', action: 'Get container stats' },
			{ name: 'Stop', value: 'stop', action: 'Stop a container' },
			{ name: 'Top', value: 'top', action: 'List processes in a container' },
			{ name: 'Update', value: 'update', action: 'Update a container' },
			{ name: 'Wait', value: 'wait', action: 'Wait for a container state' },
		],
	},
];

export const containerFields: INodeProperties[] = [
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
				operation: [
					'exec',
					'inspect',
					'logs',
					'remove',
					'restart',
					'start',
					'stats',
					'stop',
					'top',
					'update',
					'wait',
				],
			},
		},
	},
	{
		displayName: 'All Containers',
		name: 'allContainers',
		type: 'boolean',
		default: false,
		description: 'Whether to include stopped and exited containers',
		displayOptions: containerOperationDisplay(['list']),
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: true,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: containerOperationDisplay(['list']),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: {
			minValue: 1,
		},
		default: 50,
		description: 'Max number of results to return',
		displayOptions: {
			show: {
				operation: ['list'],
				resource: ['container'],
				returnAll: [false],
			},
		},
	},
	{
		displayName: 'Include Stdout',
		name: 'includeStdout',
		type: 'boolean',
		default: true,
		description: 'Whether to include stdout output',
		displayOptions: containerOperationDisplay(['logs']),
	},
	{
		displayName: 'Include Stderr',
		name: 'includeStderr',
		type: 'boolean',
		default: true,
		description: 'Whether to include stderr output',
		displayOptions: containerOperationDisplay(['logs']),
	},
	{
		displayName: 'Logs Mode',
		name: 'logsMode',
		type: 'options',
		default: 'snapshot',
		description: 'Whether to read a bounded snapshot or follow the log stream for a fixed duration',
		displayOptions: containerOperationDisplay(['logs']),
		options: [
			{
				name: 'Snapshot',
				value: 'snapshot',
				description: 'Read a bounded log snapshot and return immediately',
			},
			{
				name: 'Follow For Duration',
				value: 'followForDuration',
				description: 'Follow the log stream until the configured duration elapses',
			},
		],
	},
	{
		displayName: 'Output Mode',
		name: 'logsOutputMode',
		type: 'options',
		default: 'aggregate',
		description: 'How to return the collected log lines',
		displayOptions: containerOperationDisplay(['logs']),
		options: [
			{
				name: 'Aggregate',
				value: 'aggregate',
				description: 'Return one item that contains the full log batch',
			},
			{
				name: 'Split Items',
				value: 'splitItems',
				description: 'Return one item per log entry',
			},
		],
	},
	{
		displayName: 'Tail',
		name: 'tail',
		type: 'string',
		default: '100',
		placeholder: '100 or all',
		description: 'Number of lines from the end of the logs, or "all"',
		displayOptions: containerOperationDisplay(['logs']),
	},
	{
		displayName: 'Include Timestamps',
		name: 'timestamps',
		type: 'boolean',
		default: false,
		description: 'Whether to prefix log lines with Docker timestamps',
		displayOptions: containerOperationDisplay(['logs']),
	},
	{
		displayName: 'Since',
		name: 'since',
		type: 'string',
		default: '',
		placeholder: '2026-04-13T06:00:00Z or 1712978400',
		description: 'Only return logs since this timestamp',
		displayOptions: containerOperationDisplay(['logs']),
	},
	{
		displayName: 'Until',
		name: 'until',
		type: 'string',
		default: '',
		placeholder: '2026-04-13T07:00:00Z or 1712982000',
		description: 'Only return logs before this timestamp',
		displayOptions: containerOperationDisplay(['logs']),
	},
	{
		displayName: 'Follow Duration Seconds',
		name: 'logsFollowDurationSeconds',
		type: 'number',
		default: 30,
		typeOptions: {
			minValue: 1,
		},
		description: 'How long to keep following the log stream before returning',
		displayOptions: {
			show: {
				logsMode: ['followForDuration'],
				operation: ['logs'],
				resource: ['container'],
			},
		},
	},
	{
		displayName: 'Timeout (Seconds)',
		name: 'timeoutSeconds',
		type: 'number',
		default: 10,
		description: 'How long Docker should wait before forcing the action',
		displayOptions: containerOperationDisplay(['restart', 'stop']),
	},
	{
		displayName: 'Force',
		name: 'force',
		type: 'boolean',
		default: false,
		description: 'Whether to force container removal',
		displayOptions: containerOperationDisplay(['remove']),
	},
	{
		displayName: 'Remove Volumes',
		name: 'removeVolumes',
		type: 'boolean',
		default: false,
		description: 'Whether to remove anonymous volumes attached to the container',
		displayOptions: containerOperationDisplay(['remove']),
	},
	{
		displayName: 'PS Args',
		name: 'psArgs',
		type: 'string',
		default: '-ef',
		description: 'Arguments to pass to ps inside Docker top',
		displayOptions: containerOperationDisplay(['top']),
	},
	{
		displayName: 'Condition',
		name: 'waitCondition',
		type: 'options',
		default: 'not-running',
		displayOptions: containerOperationDisplay(['wait']),
		options: [
			{
				name: 'Not Running',
				value: 'not-running',
				description: 'Return when the container is no longer running',
			},
			{
				name: 'Next Exit',
				value: 'next-exit',
				description: 'Return after the next time the container exits',
			},
			{
				name: 'Removed',
				value: 'removed',
				description: 'Return when the container is removed',
			},
		],
	},
	{
		displayName: 'Command Arguments',
		name: 'execCommandArgs',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Argument',
		default: {
			values: [],
		},
		required: true,
		displayOptions: containerOperationDisplay(['exec']),
		options: [
			{
				displayName: 'Arguments',
				name: 'values',
				values: [
					{
						displayName: 'Argument',
						name: 'value',
						type: 'string',
						default: '',
						required: true,
					},
				],
			},
		],
		description: 'The command to execute, passed as argv segments',
	},
	{
		displayName: 'Working Directory',
		name: 'execWorkingDir',
		type: 'string',
		default: '',
		displayOptions: containerOperationDisplay(['exec']),
	},
	{
		displayName: 'User',
		name: 'execUser',
		type: 'string',
		default: '',
		placeholder: 'root or 1000:1000',
		displayOptions: containerOperationDisplay(['exec']),
	},
	{
		displayName: 'Allocate TTY',
		name: 'execTty',
		type: 'boolean',
		default: false,
		displayOptions: containerOperationDisplay(['exec']),
		description: 'Whether to allocate a pseudo-TTY for the command',
	},
	{
		displayName: 'Privileged',
		name: 'execPrivileged',
		type: 'boolean',
		default: false,
		displayOptions: containerOperationDisplay(['exec']),
	},
	{
		displayName: 'Attach Stdout',
		name: 'execAttachStdout',
		type: 'boolean',
		default: true,
		displayOptions: containerOperationDisplay(['exec']),
	},
	{
		displayName: 'Attach Stderr',
		name: 'execAttachStderr',
		type: 'boolean',
		default: true,
		displayOptions: containerOperationDisplay(['exec']),
	},
	{
		displayName: 'Environment Variables',
		name: 'execEnv',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Variable',
		default: {
			values: [],
		},
		displayOptions: containerOperationDisplay(['exec']),
		options: [
			{
				displayName: 'Variables',
				name: 'values',
				values: keyValueCollectionValues,
			},
		],
	},
	{
		displayName: 'Exec Allow List',
		name: 'execAllowList',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Command',
		default: {
			values: [],
		},
		displayOptions: containerOperationDisplay(['exec']),
		options: [
			{
				displayName: 'Commands',
				name: 'values',
				values: [
					{
						displayName: 'Command',
						name: 'value',
						type: 'string',
						default: '',
						required: true,
					},
				],
			},
		],
		description: 'Allowed argv[0] values. Leave empty to allow all commands.',
	},
	{
		displayName: 'Exec Deny List',
		name: 'execDenyList',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Command',
		default: {
			values: [],
		},
		displayOptions: containerOperationDisplay(['exec']),
		options: [
			{
				displayName: 'Commands',
				name: 'values',
				values: [
					{
						displayName: 'Command',
						name: 'value',
						type: 'string',
						default: '',
						required: true,
					},
				],
			},
		],
		description: 'Denied argv[0] values. Deny list always overrides the allow list.',
	},
	{
		displayName: 'Name',
		name: 'createName',
		type: 'string',
		default: '',
		description: 'Optional container name',
		displayOptions: containerOperationDisplay(['create']),
	},
	{
		displayName: 'Image',
		name: 'createImage',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'alpine:latest',
		displayOptions: containerOperationDisplay(['create']),
	},
	{
		displayName: 'Command Arguments',
		name: 'createCommandArgs',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Argument',
		default: {
			values: [],
		},
		displayOptions: containerOperationDisplay(['create']),
		options: [
			{
				displayName: 'Arguments',
				name: 'values',
				values: [
					{
						displayName: 'Argument',
						name: 'value',
						type: 'string',
						default: '',
						required: true,
					},
				],
			},
		],
		description: 'Optional command override, passed as argv segments',
	},
	{
		displayName: 'Environment Variables',
		name: 'createEnv',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Variable',
		default: {
			values: [],
		},
		displayOptions: containerOperationDisplay(['create']),
		options: [
			{
				displayName: 'Variables',
				name: 'values',
				values: keyValueCollectionValues,
			},
		],
	},
	{
		displayName: 'Labels',
		name: 'createLabels',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Label',
		default: {
			values: [],
		},
		displayOptions: containerOperationDisplay(['create']),
		options: [
			{
				displayName: 'Labels',
				name: 'values',
				values: [
					{
						displayName: 'Key',
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
					},
				],
			},
		],
	},
	{
		displayName: 'Working Directory',
		name: 'createWorkingDir',
		type: 'string',
		default: '',
		displayOptions: containerOperationDisplay(['create']),
	},
	{
		displayName: 'User',
		name: 'createUser',
		type: 'string',
		default: '',
		displayOptions: containerOperationDisplay(['create']),
	},
	{
		displayName: 'Allocate TTY',
		name: 'createTty',
		type: 'boolean',
		default: false,
		displayOptions: containerOperationDisplay(['create']),
	},
	{
		displayName: 'Open Stdin',
		name: 'createOpenStdin',
		type: 'boolean',
		default: false,
		displayOptions: containerOperationDisplay(['create']),
	},
	{
		displayName: 'Restart Policy',
		name: 'createRestartPolicyName',
		type: 'options',
		default: '',
		displayOptions: containerOperationDisplay(['create']),
			options: [
				{ name: 'Always', value: 'always' },
				{ name: 'Docker Default', value: '' },
				{ name: 'No', value: 'no' },
				{ name: 'On Failure', value: 'on-failure' },
				{ name: 'Unless Stopped', value: 'unless-stopped' },
			],
	},
	{
		displayName: 'Restart Max Retries',
		name: 'createRestartPolicyMaximumRetryCount',
		type: 'number',
		default: 0,
		typeOptions: {
			minValue: 0,
		},
		displayOptions: {
			show: {
				createRestartPolicyName: ['on-failure'],
				operation: ['create'],
				resource: ['container'],
			},
		},
	},
	{
		displayName: 'Auto Remove',
		name: 'createAutoRemove',
		type: 'boolean',
		default: false,
		displayOptions: containerOperationDisplay(['create']),
	},
	{
		displayName: 'Network Mode',
		name: 'createNetworkMode',
		type: 'string',
		default: '',
		placeholder: 'bridge',
		displayOptions: containerOperationDisplay(['create']),
	},
	{
		displayName: 'Bind Mounts',
		name: 'createBindMounts',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Bind',
		default: {
			values: [],
		},
		displayOptions: containerOperationDisplay(['create']),
		options: [
			{
				displayName: 'Binds',
				name: 'values',
				values: [
					{
						displayName: 'Source',
						name: 'source',
						type: 'string',
						default: '',
						required: true,
					},
					{
						displayName: 'Target',
						name: 'target',
						type: 'string',
						default: '',
						required: true,
					},
					{
						displayName: 'Read Only',
						name: 'readOnly',
						type: 'boolean',
						default: false,
					},
				],
			},
		],
	},
	{
		displayName: 'Port Bindings',
		name: 'createPortBindings',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Port Binding',
		default: {
			values: [],
		},
		displayOptions: containerOperationDisplay(['create']),
		options: [
			{
				displayName: 'Bindings',
				name: 'values',
				values: [
					{
						displayName: 'Container Port',
						name: 'containerPort',
						type: 'number',
						default: 80,
						required: true,
						typeOptions: {
							minValue: 1,
						},
					},
					{
						displayName: 'Host Port',
						name: 'hostPort',
						type: 'number',
						default: 80,
						required: true,
						typeOptions: {
							minValue: 1,
						},
					},
					{
						displayName: 'Protocol',
						name: 'protocol',
						type: 'options',
						default: 'tcp',
						options: [
							{ name: 'TCP', value: 'tcp' },
							{ name: 'UDP', value: 'udp' },
							{ name: 'SCTP', value: 'sctp' },
						],
					},
				],
			},
		],
	},
	{
		displayName: 'Named Volume Mounts',
		name: 'createVolumeMounts',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Volume Mount',
		default: {
			values: [],
		},
		displayOptions: containerOperationDisplay(['create']),
		options: [
			{
				displayName: 'Mounts',
				name: 'values',
				values: [
					{
						displayName: 'Volume Name',
						name: 'source',
						type: 'string',
						default: '',
						required: true,
					},
					{
						displayName: 'Target Path',
						name: 'target',
						type: 'string',
						default: '',
						required: true,
					},
					{
						displayName: 'Read Only',
						name: 'readOnly',
						type: 'boolean',
						default: false,
					},
				],
			},
		],
	},
	{
		displayName: 'Advanced JSON',
		name: 'createAdvancedJson',
		type: 'json',
		default: '{}',
		displayOptions: containerOperationDisplay(['create']),
		description: 'Merged last and allowed to override the structured create payload',
	},
	{
		displayName: 'Restart Policy',
		name: 'updateRestartPolicyName',
		type: 'options',
		default: '',
		displayOptions: containerOperationDisplay(['update']),
			options: [
				{ name: 'Always', value: 'always' },
				{ name: 'Do Not Change', value: '' },
				{ name: 'No', value: 'no' },
				{ name: 'On Failure', value: 'on-failure' },
				{ name: 'Unless Stopped', value: 'unless-stopped' },
			],
	},
	{
		displayName: 'Restart Max Retries',
		name: 'updateRestartPolicyMaximumRetryCount',
		type: 'number',
		default: 0,
		typeOptions: {
			minValue: 0,
		},
		displayOptions: {
			show: {
				operation: ['update'],
				resource: ['container'],
				updateRestartPolicyName: ['on-failure'],
			},
		},
	},
	{
		displayName: 'Update Fields',
		name: 'updateResourceLimits',
		type: 'collection',
		default: {},
		placeholder: 'Add Limit',
		displayOptions: containerOperationDisplay(['update']),
			options: [
				{
					displayName: 'CPU Period',
					name: 'cpuPeriod',
					type: 'number',
					default: 0,
					typeOptions: {
						minValue: 0,
					},
				},
				{
					displayName: 'CPU Quota',
					name: 'cpuQuota',
					type: 'number',
					default: 0,
				},
				{
					displayName: 'CPU Set CPUs',
					name: 'cpusetCpus',
					type: 'string',
					default: '',
				},
				{
					displayName: 'CPU Set MEMs',
					name: 'cpusetMems',
					type: 'string',
					default: '',
				},
				{
					displayName: 'CPU Shares',
					name: 'cpuShares',
					type: 'number',
					default: 0,
					typeOptions: {
						minValue: 0,
					},
				},
				{
					displayName: 'Memory',
					name: 'memory',
					type: 'number',
					default: 0,
					description: 'Memory limit in bytes',
					typeOptions: {
						minValue: 0,
					},
				},
				{
					displayName: 'Memory Reservation',
					name: 'memoryReservation',
					type: 'number',
					default: 0,
					description: 'Soft memory limit in bytes',
					typeOptions: {
						minValue: 0,
					},
				},
				{
					displayName: 'Memory Swap',
					name: 'memorySwap',
					type: 'number',
					default: 0,
					description: 'Total memory plus swap in bytes',
					typeOptions: {
						minValue: 0,
					},
				},
				{
					displayName: 'Nano CPUs',
					name: 'nanoCpus',
					type: 'number',
					default: 0,
					typeOptions: {
						minValue: 0,
					},
				},
			],
	},
	{
		displayName: 'Advanced JSON',
		name: 'updateAdvancedJson',
		type: 'json',
		default: '{}',
		displayOptions: containerOperationDisplay(['update']),
		description: 'Merged last and allowed to override the structured update payload',
	},
];
