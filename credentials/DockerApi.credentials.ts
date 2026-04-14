import type { ICredentialType, INodeProperties, Icon } from 'n8n-workflow';

export class DockerApi implements ICredentialType {
	name = 'dockerApi';

	displayName = 'Docker API';

	documentationUrl = 'https://docs.docker.com/engine/security/protect-access/';

	icon: Icon = 'file:icons/docker.svg';

	properties: INodeProperties[] = [
		{
			displayName:
				'Phase 6 supports Unix Socket, TCP, TLS, and SSH-backed remote socket access across Docker, Docker Files, Docker Build, and Docker Trigger. SSH credentials use key-based authentication to reach a remote Unix socket such as /var/run/docker.sock.',
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
				{
					name: 'SSH',
					value: 'ssh',
					description: 'Connect to a remote Docker Unix socket over SSH using a private key',
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
					connectionMode: ['tcp', 'tls', 'ssh'],
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
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
			displayOptions: {
				show: {
					connectionMode: ['ssh'],
				},
			},
			placeholder: 'docker',
			description: 'SSH user that can reach the remote Docker socket',
		},
		{
			displayName: 'SSH Port',
			name: 'sshPort',
			type: 'number',
			default: 22,
			required: true,
			displayOptions: {
				show: {
					connectionMode: ['ssh'],
				},
			},
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
					connectionMode: ['tls', 'ssh'],
				},
			},
			description: 'Passphrase for the TLS key or encrypted SSH private key, if required',
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
			displayName: 'Private Key',
			name: 'privateKey',
			type: 'string',
			default: '',
			typeOptions: {
				password: true,
				rows: 8,
			},
			displayOptions: {
				show: {
					connectionMode: ['ssh'],
				},
			},
			description: 'OpenSSH private key used to connect to the remote host',
		},
		{
			displayName: 'Remote Socket Path',
			name: 'remoteSocketPath',
			type: 'string',
			default: '/var/run/docker.sock',
			displayOptions: {
				show: {
					connectionMode: ['ssh'],
				},
			},
			description: 'Unix socket path on the remote host that exposes the Docker daemon',
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
					description: 'For container/image/network/volume read workflows, plus logs, top, stats, wait, history, df, events, and daemon metadata',
				},
				{
					name: 'Full Control',
					value: 'fullControl',
					description: 'For create, update, exec, image pull/tag/remove, network and volume changes, Docker Files save/load/copy/export, and prune workflows',
				},
			],
			description: 'Planning guardrail used by this package to gate dangerous operations',
		},
	];
}
