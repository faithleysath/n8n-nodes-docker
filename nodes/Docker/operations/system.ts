import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import type { DockerApiClient } from '../transport/dockerClient';
import type { SystemOperation } from '../types';
import { toExecutionItem } from '../utils/execution';

export async function executeSystemOperation(
	context: IExecuteFunctions,
	client: DockerApiClient,
	itemIndex: number,
	operation: SystemOperation,
): Promise<INodeExecutionData[]> {
	const abortSignal = context.getExecutionCancelSignal();

	switch (operation) {
		case 'ping': {
			const pingResult = await client.ping(abortSignal);

			return [
				toExecutionItem(
					{
						apiVersion: pingResult.apiVersion,
						dockerExperimental: pingResult.dockerExperimental,
						ok: pingResult.ok,
						osType: pingResult.osType,
						response: pingResult.rawResponse,
					},
					itemIndex,
				),
			];
		}

		case 'info': {
			const info = await client.getInfo(abortSignal);

			return [toExecutionItem(info, itemIndex)];
		}

		case 'version': {
			const version = await client.getVersion(abortSignal);

			return [toExecutionItem(version, itemIndex)];
		}
	}

	throw new Error(`Unsupported system operation "${operation}".`);
}
