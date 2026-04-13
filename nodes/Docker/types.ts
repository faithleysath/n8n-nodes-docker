export type DockerResource = 'container' | 'image' | 'network' | 'system' | 'volume';

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

export type ImageOperation =
	| 'history'
	| 'inspect'
	| 'list'
	| 'pull'
	| 'prune'
	| 'remove'
	| 'tag';

export type NetworkOperation =
	| 'connect'
	| 'create'
	| 'delete'
	| 'disconnect'
	| 'inspect'
	| 'list'
	| 'prune';

export type VolumeOperation = 'create' | 'delete' | 'inspect' | 'list' | 'prune';

export type SystemOperation = 'df' | 'events' | 'info' | 'ping' | 'version';

export type DockerOperation =
	| ContainerOperation
	| ImageOperation
	| NetworkOperation
	| SystemOperation
	| VolumeOperation;

export const writableDockerOperations = new Set<DockerOperation>([
	'create',
	'connect',
	'delete',
	'disconnect',
	'exec',
	'pull',
	'prune',
	'remove',
	'restart',
	'start',
	'stop',
	'tag',
	'update',
]);
