import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { DockerApiClient, DockerJson } from '../transport/dockerClient';
import type { VolumeOperation } from '../types';
import {
	assertNonEmptyValue,
	assertWritableAccess,
	getNodeGetter,
	normalizePositiveInteger,
	toExecutionItem,
	trimToUndefined,
} from '../utils/execution';
import { deepMergeObjects, normalizeJsonParameter } from '../utils/merge';

interface KeyValuePair {
	name: string;
	value: string;
}

function getFixedCollectionValues(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
): IDataObject[] {
	const parameterValue = context.getNodeParameter(name, itemIndex, { values: [] }) as IDataObject;
	const values = parameterValue.values;

	return Array.isArray(values) ? (values as IDataObject[]) : [];
}

function getKeyValuePairs(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
	label: string,
): KeyValuePair[] {
	const node = getNodeGetter(context);

	return getFixedCollectionValues(context, name, itemIndex).map((entry) => ({
		name: assertNonEmptyValue(node, String(entry.name ?? ''), `${label} Name`, itemIndex),
		value: String(entry.value ?? ''),
	}));
}

function buildCreateVolumePayload(context: IExecuteFunctions, itemIndex: number): DockerJson {
	const volumeName = assertNonEmptyValue(
		getNodeGetter(context),
		context.getNodeParameter('volumeName', itemIndex) as string,
		'Volume Name',
		itemIndex,
	);
	const driver = trimToUndefined(
		context.getNodeParameter('volumeDriver', itemIndex, 'local') as string,
	);
	const labels = getKeyValuePairs(context, 'volumeLabels', itemIndex, 'Label');
	const driverOptions = getKeyValuePairs(context, 'volumeDriverOptions', itemIndex, 'Driver Option');
	const advancedJson = normalizeJsonParameter(
		context.getNodeParameter('volumeAdvancedJson', itemIndex, '{}'),
		'Advanced JSON',
		(message) => new NodeOperationError(context.getNode(), message, { itemIndex }),
	);

	const body: DockerJson = {
		Name: volumeName,
	};

	if (driver !== undefined) {
		body.Driver = driver;
	}

	if (labels.length > 0) {
		body.Labels = Object.fromEntries(labels.map(({ name, value }) => [name, value]));
	}

	if (driverOptions.length > 0) {
		body.DriverOpts = Object.fromEntries(driverOptions.map(({ name, value }) => [name, value]));
	}

	return deepMergeObjects(body, advancedJson);
}

export async function executeVolumeOperation(
	context: IExecuteFunctions,
	client: DockerApiClient,
	itemIndex: number,
	operation: VolumeOperation,
): Promise<INodeExecutionData[]> {
	const abortSignal = context.getExecutionCancelSignal();
	const node = getNodeGetter(context);

	switch (operation) {
		case 'list': {
			const returnAll = context.getNodeParameter('volumeReturnAll', itemIndex) as boolean;
			const limitValue = context.getNodeParameter('volumeLimit', itemIndex, 50) as number;
			const limit = returnAll
				? undefined
				: normalizePositiveInteger(node, limitValue, 'Limit', itemIndex);
			const response = await client.listVolumes({}, abortSignal);
			const volumes = Array.isArray(response.Volumes) ? response.Volumes : [];
			const selectedVolumes = limit === undefined ? volumes : volumes.slice(0, limit);

			return selectedVolumes.map((volume) => toExecutionItem(volume as IDataObject, itemIndex));
		}

		case 'inspect': {
			const volumeName = assertNonEmptyValue(
				node,
				context.getNodeParameter('volumeName', itemIndex) as string,
				'Volume Name',
				itemIndex,
			);
			const volume = await client.inspectVolume(volumeName, abortSignal);

			return [toExecutionItem(volume, itemIndex)];
		}

		case 'create': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const createBody = buildCreateVolumePayload(context, itemIndex);
			const volume = await client.createVolume(createBody, abortSignal);

			return [
				toExecutionItem(
					{
						...volume,
						operation: 'create',
					},
					itemIndex,
				),
			];
		}

		case 'delete': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const volumeName = assertNonEmptyValue(
				node,
				context.getNodeParameter('volumeName', itemIndex) as string,
				'Volume Name',
				itemIndex,
			);
			const force = context.getNodeParameter('volumeDeleteForce', itemIndex) as boolean;
			const actionResult = await client.deleteVolume(volumeName, { force }, abortSignal);

			return [
				toExecutionItem(
					{
						changed: actionResult.changed,
						deleted: true,
						force,
						operation: 'delete',
						statusCode: actionResult.statusCode,
						volumeName,
					},
					itemIndex,
				),
			];
		}

		case 'prune': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const includeNamedVolumes = context.getNodeParameter(
				'volumePruneIncludeNamed',
				itemIndex,
			) as boolean;
			const pruneResult = await client.pruneVolumes(
				{
					filters: includeNamedVolumes
						? JSON.stringify({
								all: ['true'],
							})
						: undefined,
				},
				abortSignal,
			);

			return [
				toExecutionItem(
					{
						...pruneResult,
						includeNamedVolumes,
						operation: 'prune',
					},
					itemIndex,
				),
			];
		}
	}

	throw new Error(`Unsupported volume operation "${operation}".`);
}
