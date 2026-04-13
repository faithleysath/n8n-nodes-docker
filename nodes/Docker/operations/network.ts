import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { DockerApiClient, DockerJson } from '../transport/dockerClient';
import type { NetworkOperation } from '../types';
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

function getStringList(context: IExecuteFunctions, name: string, itemIndex: number): string[] {
	return getFixedCollectionValues(context, name, itemIndex)
		.map((entry) => String(entry.value ?? '').trim())
		.filter((value) => value !== '');
}

function buildCreateNetworkPayload(context: IExecuteFunctions, itemIndex: number): DockerJson {
	const name = assertNonEmptyValue(
		getNodeGetter(context),
		context.getNodeParameter('networkName', itemIndex) as string,
		'Name',
		itemIndex,
	);
	const driver = trimToUndefined(
		context.getNodeParameter('networkDriver', itemIndex, 'bridge') as string,
	);
	const labels = getKeyValuePairs(context, 'networkLabels', itemIndex, 'Label');
	const advancedJson = normalizeJsonParameter(
		context.getNodeParameter('networkAdvancedJson', itemIndex, '{}'),
		'Advanced JSON',
		(message) => new NodeOperationError(context.getNode(), message, { itemIndex }),
	);

	const body: DockerJson = {
		Name: name,
	};

	if (driver !== undefined) {
		body.Driver = driver;
	}

	if (context.getNodeParameter('networkAttachable', itemIndex) as boolean) {
		body.Attachable = true;
	}

	if (context.getNodeParameter('networkInternal', itemIndex) as boolean) {
		body.Internal = true;
	}

	if (context.getNodeParameter('networkEnableIpv6', itemIndex) as boolean) {
		body.EnableIPv6 = true;
	}

	if (labels.length > 0) {
		body.Labels = Object.fromEntries(labels.map(({ name: labelName, value }) => [labelName, value]));
	}

	return deepMergeObjects(body, advancedJson);
}

function buildConnectNetworkPayload(context: IExecuteFunctions, itemIndex: number): DockerJson {
	const containerId = assertNonEmptyValue(
		getNodeGetter(context),
		context.getNodeParameter('networkContainerId', itemIndex) as string,
		'Container ID or Name',
		itemIndex,
	);
	const aliases = getStringList(context, 'networkAliases', itemIndex);
	const ipv4Address = trimToUndefined(
		context.getNodeParameter('networkIpv4Address', itemIndex, '') as string,
	);
	const ipv6Address = trimToUndefined(
		context.getNodeParameter('networkIpv6Address', itemIndex, '') as string,
	);
	const advancedJson = normalizeJsonParameter(
		context.getNodeParameter('networkConnectAdvancedJson', itemIndex, '{}'),
		'Advanced JSON',
		(message) => new NodeOperationError(context.getNode(), message, { itemIndex }),
	);

	const body: DockerJson = {
		Container: containerId,
	};
	const endpointConfig: DockerJson = {};
	const ipamConfig: DockerJson = {};

	if (aliases.length > 0) {
		endpointConfig.Aliases = aliases;
	}

	if (ipv4Address !== undefined) {
		ipamConfig.IPv4Address = ipv4Address;
	}

	if (ipv6Address !== undefined) {
		ipamConfig.IPv6Address = ipv6Address;
	}

	if (Object.keys(ipamConfig).length > 0) {
		endpointConfig.IPAMConfig = ipamConfig;
	}

	if (Object.keys(endpointConfig).length > 0) {
		body.EndpointConfig = endpointConfig;
	}

	return deepMergeObjects(body, advancedJson);
}

export async function executeNetworkOperation(
	context: IExecuteFunctions,
	client: DockerApiClient,
	itemIndex: number,
	operation: NetworkOperation,
): Promise<INodeExecutionData[]> {
	const abortSignal = context.getExecutionCancelSignal();
	const node = getNodeGetter(context);

	switch (operation) {
		case 'list': {
			const returnAll = context.getNodeParameter('networkReturnAll', itemIndex) as boolean;
			const limitValue = context.getNodeParameter('networkLimit', itemIndex, 50) as number;
			const limit = returnAll
				? undefined
				: normalizePositiveInteger(node, limitValue, 'Limit', itemIndex);
			const networks = await client.listNetworks(abortSignal);
			const selectedNetworks = limit === undefined ? networks : networks.slice(0, limit);

			return selectedNetworks.map((network) => toExecutionItem(network, itemIndex));
		}

		case 'inspect': {
			const networkId = assertNonEmptyValue(
				node,
				context.getNodeParameter('networkId', itemIndex) as string,
				'Network ID or Name',
				itemIndex,
			);
			const network = await client.inspectNetwork(networkId, abortSignal);

			return [toExecutionItem(network, itemIndex)];
		}

		case 'create': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const requestBody = buildCreateNetworkPayload(context, itemIndex);
			const createResponse = await client.createNetwork(requestBody, abortSignal);
			const networkId = String(createResponse.Id ?? requestBody.Name ?? '');
			const network = await client.inspectNetwork(networkId, abortSignal);

			return [
				toExecutionItem(
					{
						network,
						networkId,
						operation: 'create',
						warning: createResponse.Warning ?? null,
					},
					itemIndex,
				),
			];
		}

		case 'connect': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const networkId = assertNonEmptyValue(
				node,
				context.getNodeParameter('networkId', itemIndex) as string,
				'Network ID or Name',
				itemIndex,
			);
			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('networkContainerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const connectBody = buildConnectNetworkPayload(context, itemIndex);
			const actionResult = await client.connectNetwork(networkId, connectBody, abortSignal);
			const network = await client.inspectNetwork(networkId, abortSignal);

			return [
				toExecutionItem(
					{
						changed: actionResult.changed,
						containerId,
						network,
						networkId,
						operation: 'connect',
						statusCode: actionResult.statusCode,
					},
					itemIndex,
				),
			];
		}

		case 'disconnect': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const networkId = assertNonEmptyValue(
				node,
				context.getNodeParameter('networkId', itemIndex) as string,
				'Network ID or Name',
				itemIndex,
			);
			const containerId = assertNonEmptyValue(
				node,
				context.getNodeParameter('networkContainerId', itemIndex) as string,
				'Container ID or Name',
				itemIndex,
			);
			const force = context.getNodeParameter('networkDisconnectForce', itemIndex) as boolean;
			const actionResult = await client.disconnectNetwork(
				networkId,
				{
					Container: containerId,
					Force: force,
				},
				abortSignal,
			);
			const network = await client.inspectNetwork(networkId, abortSignal);

			return [
				toExecutionItem(
					{
						changed: actionResult.changed,
						containerId,
						force,
						network,
						networkId,
						operation: 'disconnect',
						statusCode: actionResult.statusCode,
					},
					itemIndex,
				),
			];
		}

		case 'delete': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const networkId = assertNonEmptyValue(
				node,
				context.getNodeParameter('networkId', itemIndex) as string,
				'Network ID or Name',
				itemIndex,
			);
			const actionResult = await client.deleteNetwork(networkId, abortSignal);

			return [
				toExecutionItem(
					{
						changed: actionResult.changed,
						deleted: true,
						networkId,
						operation: 'delete',
						statusCode: actionResult.statusCode,
					},
					itemIndex,
				),
			];
		}

		case 'prune': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const pruneResult = await client.pruneNetworks({}, abortSignal);

			return [
				toExecutionItem(
					{
						...pruneResult,
						operation: 'prune',
					},
					itemIndex,
				),
			];
		}
	}

	throw new Error(`Unsupported network operation "${operation}".`);
}
