import type { ICredentialType, INodeProperties, Icon } from 'n8n-workflow';

export class DockerApi implements ICredentialType {
	name = 'dockerApi';

	displayName = 'Docker API';

	documentationUrl = 'https://docs.docker.com/engine/security/protect-access/';

	icon: Icon = 'file:icons/docker.svg';

	properties: INodeProperties[] = [
		{
			displayName:
				'Phase 2 supports Unix Socket, TCP, and TLS across both Docker and Docker Files nodes. SSH is still planned for a later phase because n8n credential tests do not support Docker-over-SSH transport out of the box.',
			name: 'phaseTwoNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Connection Mode',
			name: 'connectionMode',
			type: 'options',
			default: 'unixSocket',
			options: [
				{
					name: 'Unix Socket',
					value: 'unixSocket',
					description: 'Connect through a local Docker socket',
				},
				{
					name: 'TCP',
					value: 'tcp',
					description: 'Connect to a remote Docker daemon over HTTP',
				},
				{
					name: 'TLS',
					value: 'tls',
					description: 'Connect to a remote Docker daemon over mutual TLS',
				},
			],
		},
		{
			displayName: 'Socket Path',
			name: 'socketPath',
			type: 'string',
			default: '/var/run/docker.sock',
			displayOptions: {
				show: {
					connectionMode: ['unixSocket'],
				},
			},
		},
		{
			displayName: 'Host',
			name: 'host',
			type: 'string',
			default: 'localhost',
			required: true,
			displayOptions: {
				show: {
					connectionMode: ['tcp', 'tls'],
				},
			},
			placeholder: 'docker.example.internal',
		},
		{
			displayName: 'Port',
			name: 'port',
			type: 'number',
			default: 2375,
			required: true,
			displayOptions: {
				show: {
					connectionMode: ['tcp', 'tls'],
				},
			},
			description: 'Use 2375 for plain TCP or 2376 for TLS by default',
		},
		{
			displayName: 'Passphrase',
			name: 'passphrase',
			type: 'string',
			default: '',
			typeOptions: {
				password: true,
				rows: 4,
			},
			displayOptions: {
				show: {
					connectionMode: ['tls'],
				},
			},
		},
		{
			displayName: 'CA Certificate',
			name: 'ca',
			type: 'string',
			default: '',
			typeOptions: {
				password: true,
				rows: 4,
			},
			displayOptions: {
				show: {
					connectionMode: ['tls'],
				},
			},
		},
		{
			displayName: 'Client Certificate',
			name: 'cert',
			type: 'string',
			default: '',
			typeOptions: {
				password: true,
				rows: 4,
			},
			displayOptions: {
				show: {
					connectionMode: ['tls'],
				},
			},
		},
		{
			displayName: 'Client Private Key',
			name: 'key',
			type: 'string',
			default: '',
			typeOptions: {
				password: true,
				rows: 4,
			},
			displayOptions: {
				show: {
					connectionMode: ['tls'],
				},
			},
		},
		{
			displayName: 'Ignore TLS Issues (Insecure)',
			name: 'ignoreTlsIssues',
			type: 'boolean',
			default: false,
			displayOptions: {
				show: {
					connectionMode: ['tls'],
				},
			},
			description: 'Whether to connect even if certificate validation fails',
		},
		{
			displayName: 'API Version',
			name: 'apiVersion',
			type: 'string',
			default: 'auto',
			placeholder: 'auto',
			description: 'Docker Engine API version, or "auto" to negotiate automatically',
		},
		{
			displayName: 'Access Mode',
			name: 'accessMode',
			type: 'options',
			default: 'readOnly',
			options: [
				{
					name: 'Read Only',
					value: 'readOnly',
					description: 'For list, inspect, logs, top, stats, wait, and daemon metadata workflows',
				},
				{
					name: 'Full Control',
					value: 'fullControl',
					description: 'For create, update, exec, Docker Files copy/export, lifecycle, and prune workflows',
				},
			],
			description: 'Planning guardrail used by this package to gate dangerous operations',
		},
	];
}
