export type DockerResource = 'container' | 'system';

export type ContainerOperation =
	| 'create'
	| 'exec'
	| 'inspect'
	| 'list'
	| 'logs'
	| 'remove'
	| 'restart'
	| 'start'
	| 'stats'
	| 'stop'
	| 'top'
	| 'update'
	| 'wait';

export type SystemOperation = 'info' | 'ping' | 'version';

export type DockerOperation = ContainerOperation | SystemOperation;

export const writableContainerOperations = new Set<ContainerOperation>([
	'create',
	'exec',
	'remove',
	'restart',
	'start',
	'stop',
	'update',
]);
