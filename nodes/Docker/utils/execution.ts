import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import type { DockerAccessMode, DockerRequestError } from '../transport/dockerClient';

type NodeGetter = () => INode;

export function toExecutionItem(
	json: IDataObject | Record<string, unknown>,
	itemIndex: number,
	binary?: INodeExecutionData['binary'],
): INodeExecutionData {
	return {
		binary,
		json: json as IDataObject,
		pairedItem: {
			item: itemIndex,
		},
	};
}

export function assertWritableAccess(
	node: NodeGetter,
	accessMode: DockerAccessMode,
	operation: string,
	itemIndex: number,
): void {
	if (accessMode === 'fullControl') {
		return;
	}

	throw new NodeOperationError(
		node(),
		`Operation "${operation}" requires the credential Access Mode to be set to Full Control.`,
		{ itemIndex },
	);
}

export function assertNonEmptyValue(
	node: NodeGetter,
	value: string,
	label: string,
	itemIndex: number,
): string {
	const trimmed = value.trim();

	if (trimmed === '') {
		throw new NodeOperationError(node(), `${label} is required.`, { itemIndex });
	}

	return trimmed;
}

export function normalizePositiveInteger(
	node: NodeGetter,
	value: number,
	label: string,
	itemIndex: number,
): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new NodeOperationError(node(), `${label} must be a positive integer.`, {
			itemIndex,
		});
	}

	return value;
}

export function normalizeNonNegativeInteger(
	node: NodeGetter,
	value: number,
	label: string,
	itemIndex: number,
): number {
	if (!Number.isInteger(value) || value < 0) {
		throw new NodeOperationError(node(), `${label} must be a non-negative integer.`, {
			itemIndex,
		});
	}

	return value;
}

export function trimToUndefined(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	const trimmed = value.trim();

	return trimmed === '' ? undefined : trimmed;
}

export function createNodeApiError(
	node: NodeGetter,
	error: DockerRequestError,
	itemIndex: number,
): NodeApiError {
	const payload: JsonObject = {
		message: error.message,
		method: error.method,
		path: error.path,
	};

	if (typeof error.details === 'string') {
		payload.details = error.details;
	}

	return new NodeApiError(node(), payload, {
		description: error.bodyText,
		httpCode: error.statusCode === undefined ? undefined : String(error.statusCode),
		itemIndex,
	});
}

export function createContinueOnFailItem(
	error: unknown,
	itemIndex: number,
	context: IDataObject = {},
): INodeExecutionData {
	if (error instanceof Error && 'method' in error && 'path' in error) {
		const dockerError = error as DockerRequestError;

		return toExecutionItem(
			{
				...context,
				error: dockerError.message,
				method: dockerError.method,
				path: dockerError.path,
				response: dockerError.bodyText,
				statusCode: dockerError.statusCode,
			},
			itemIndex,
		);
	}

	if (error instanceof Error) {
		return toExecutionItem(
			{
				...context,
				error: error.message,
			},
			itemIndex,
		);
	}

	return toExecutionItem(
		{
			...context,
			error: 'Unknown error',
		},
		itemIndex,
	);
}

export function getNodeGetter(context: IExecuteFunctions): NodeGetter {
	return () => context.getNode();
}
