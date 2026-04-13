import type { INodeProperties } from 'n8n-workflow';

function imageOperationDisplay(operation: string[]): INodeProperties['displayOptions'] {
	return {
		show: {
			operation,
			resource: ['image'],
		},
	};
}

export const imageOperations: INodeProperties[] = [
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
			{ name: 'History', value: 'history', action: 'Get an image history' },
			{ name: 'Inspect', value: 'inspect', action: 'Inspect an image' },
			{ name: 'List', value: 'list', action: 'List images' },
			{ name: 'Prune', value: 'prune', action: 'Prune unused images' },
			{ name: 'Pull', value: 'pull', action: 'Pull an image' },
			{ name: 'Remove', value: 'remove', action: 'Remove an image' },
			{ name: 'Tag', value: 'tag', action: 'Tag an image' },
		],
	},
];

export const imageFields: INodeProperties[] = [
	{
		displayName: 'All Images',
		name: 'imageAllImages',
		type: 'boolean',
		default: false,
		description: 'Whether to include intermediary images and images without a final tag',
		displayOptions: imageOperationDisplay(['list']),
	},
	{
		displayName: 'Return All',
		name: 'imageReturnAll',
		type: 'boolean',
		default: true,
		description: 'Whether to return all images or only up to a given limit',
		displayOptions: imageOperationDisplay(['list']),
	},
	{
		displayName: 'Limit',
		name: 'imageLimit',
		type: 'number',
		typeOptions: {
			minValue: 1,
		},
		default: 50,
		description: 'Max number of images to return',
		displayOptions: {
			show: {
				imageReturnAll: [false],
				operation: ['list'],
				resource: ['image'],
			},
		},
	},
	{
		displayName: 'Image Reference',
		name: 'imageReference',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'alpine:3.20 or sha256:abc123',
		description: 'Image name, tag, digest, or ID',
		displayOptions: imageOperationDisplay(['history', 'inspect', 'pull', 'remove']),
	},
	{
		displayName: 'Return All',
		name: 'imageHistoryReturnAll',
		type: 'boolean',
		default: true,
		description: 'Whether to return all history layers or only up to a given limit',
		displayOptions: imageOperationDisplay(['history']),
	},
	{
		displayName: 'Limit',
		name: 'imageHistoryLimit',
		type: 'number',
		typeOptions: {
			minValue: 1,
		},
		default: 50,
		description: 'Max number of history layers to return',
		displayOptions: {
			show: {
				imageHistoryReturnAll: [false],
				operation: ['history'],
				resource: ['image'],
			},
		},
	},
	{
		displayName: 'Platform',
		name: 'imagePlatform',
		type: 'string',
		default: '',
		placeholder: '{"os":"linux","architecture":"amd64"}',
		description: 'Optional JSON-encoded OCI platform string for pull or history selection',
		displayOptions: imageOperationDisplay(['history', 'pull']),
	},
	{
		displayName: 'Source Image',
		name: 'sourceImageReference',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'alpine:3.20',
		description: 'Existing image reference to tag',
		displayOptions: imageOperationDisplay(['tag']),
	},
	{
		displayName: 'Target Repository',
		name: 'targetRepository',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'myorg/alpine',
		description: 'Repository name for the new tag',
		displayOptions: imageOperationDisplay(['tag']),
	},
	{
		displayName: 'Target Tag',
		name: 'targetTag',
		type: 'string',
		default: 'latest',
		description: 'Tag name for the new image reference',
		displayOptions: imageOperationDisplay(['tag']),
	},
	{
		displayName: 'Force',
		name: 'imageRemoveForce',
		type: 'boolean',
		default: false,
		description: 'Whether to remove the image even if it is used by stopped containers or has other tags',
		displayOptions: imageOperationDisplay(['remove']),
	},
	{
		displayName: 'Keep Untagged Parents',
		name: 'imageKeepUntaggedParents',
		type: 'boolean',
		default: false,
		description: 'Whether to keep untagged parent images when removing this image',
		displayOptions: imageOperationDisplay(['remove']),
	},
	{
		displayName: 'Dangling Only',
		name: 'imagePruneDanglingOnly',
		type: 'boolean',
		default: true,
		description: 'Whether to prune only unused untagged images',
		displayOptions: imageOperationDisplay(['prune']),
	},
];
