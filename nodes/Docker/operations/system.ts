import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { DockerApiClient } from '../transport/dockerClient';
import { parseDockerJsonLines } from '../transport/dockerJsonLines';
import type { SystemOperation } from '../types';
import {
	createDockerEventFilterPayload,
	getDockerReplaySince,
	hasSeenDockerEvent,
	normalizeDockerEvent,
	readDockerEventCursorState,
	recordDockerEvent,
	type DockerEvent,
	type DockerEventCursorState,
	type NormalizedDockerEvent,
} from '../utils/dockerEvents';
import { normalizePositiveInteger, toExecutionItem, trimToUndefined } from '../utils/execution';

function resolveEventsWindow(
	context: IExecuteFunctions,
	itemIndex: number,
): { lookbackSeconds: number; since: string; until: string } {
	const lookbackSeconds = normalizePositiveInteger(
		() => context.getNode(),
		context.getNodeParameter('eventsLookbackSeconds', itemIndex, 300) as number,
		'Lookback Seconds',
		itemIndex,
	);
	const sinceInput = trimToUndefined(context.getNodeParameter('eventsSince', itemIndex, '') as string);
	const untilInput = trimToUndefined(context.getNodeParameter('eventsUntil', itemIndex, '') as string);
	const until = untilInput ?? String(Math.floor(Date.now() / 1000));

	if (sinceInput !== undefined) {
		return {
			lookbackSeconds,
			since: sinceInput,
			until,
		};
	}

	const unixSeconds = Number(until);

	if (Number.isFinite(unixSeconds) && unixSeconds > 0) {
		return {
			lookbackSeconds,
			since: String(Math.max(0, Math.floor(unixSeconds - lookbackSeconds))),
			until,
		};
	}

	const parsedUntil = Date.parse(until);

	if (Number.isNaN(parsedUntil)) {
		throw new NodeOperationError(
			context.getNode(),
			'Until must be a valid Unix timestamp or ISO date-time when Since is omitted.',
			{ itemIndex },
		);
	}

	return {
		lookbackSeconds,
		since: String(Math.max(0, Math.floor(parsedUntil / 1000) - lookbackSeconds)),
		until,
	};
}

function resolveResumeWindow(
	context: IExecuteFunctions,
	itemIndex: number,
	state: DockerEventCursorState,
): { lookbackSeconds: number; since: string; until: string } {
	const lookbackSeconds = normalizePositiveInteger(
		() => context.getNode(),
		context.getNodeParameter('eventsLookbackSeconds', itemIndex, 300) as number,
		'Lookback Seconds',
		itemIndex,
	);
	const until = String(Math.floor(Date.now() / 1000));
	const since = getDockerReplaySince(state) ?? String(Math.max(0, Number(until) - lookbackSeconds));

	return {
		lookbackSeconds,
		since,
		until,
	};
}

function toEventItems(events: NormalizedDockerEvent[], itemIndex: number): INodeExecutionData[] {
	return events.map((event) => toExecutionItem(event as unknown as IDataObject, itemIndex));
}

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

		case 'df': {
			const df = await client.getSystemDataUsage(abortSignal);
			const images = Array.isArray(df.Images) ? df.Images : [];
			const containers = Array.isArray(df.Containers) ? df.Containers : [];
			const volumes = Array.isArray(df.Volumes) ? df.Volumes : [];
			const buildCache = Array.isArray(df.BuildCache) ? df.BuildCache : [];

			return [
				toExecutionItem(
					{
						...df,
						operation: 'df',
						summary: {
							buildCacheCount: buildCache.length,
							containerCount: containers.length,
							imageCount: images.length,
							layersSize: df.LayersSize ?? 0,
							volumeCount: volumes.length,
						},
					},
					itemIndex,
				),
			];
		}

		case 'events': {
			const resourceTypes = context.getNodeParameter('eventsResourceTypes', itemIndex, []) as string[];
			const actions = context.getNodeParameter('eventsActions', itemIndex, []) as string[];
			const eventsReadMode = context.getNodeParameter(
				'eventsReadMode',
				itemIndex,
				'boundedWindow',
			) as 'boundedWindow' | 'resumeFromCursor';
			const eventsOutputMode = context.getNodeParameter(
				'eventsOutputMode',
				itemIndex,
				'aggregate',
			) as 'aggregate' | 'splitItems';
			const staticData =
				eventsReadMode === 'resumeFromCursor' ? context.getWorkflowStaticData('node') : undefined;
			let cursorState =
				staticData === undefined ? undefined : readDockerEventCursorState(staticData);
			const window =
				eventsReadMode === 'resumeFromCursor'
					? resolveResumeWindow(
							context,
							itemIndex,
							cursorState ?? readDockerEventCursorState({}),
						)
					: resolveEventsWindow(context, itemIndex);
			const filters = createDockerEventFilterPayload({
				actions,
				resourceTypes,
			});

			const response = await client.getEvents(
				{
					filters,
					since: window.since,
					until: window.until,
				},
				abortSignal,
			);
			const parsedEvents = parseDockerJsonLines(response.body, response.headers['content-type']);
			const normalizedEvents = parsedEvents.entries.map((entry) =>
				normalizeDockerEvent(entry as DockerEvent),
			);
			const selectedEvents: NormalizedDockerEvent[] = [];

			if (cursorState === undefined || staticData === undefined) {
				selectedEvents.push(...normalizedEvents);
			} else {
				for (const event of normalizedEvents) {
					if (hasSeenDockerEvent(cursorState, event)) {
						continue;
					}

					selectedEvents.push(event);
					cursorState = recordDockerEvent(staticData, cursorState, event);
				}
			}

			if (eventsOutputMode === 'splitItems') {
				return toEventItems(selectedEvents, itemIndex);
			}

			return [
				toExecutionItem(
					{
						contentType: parsedEvents.contentType,
						count: selectedEvents.length,
						events: selectedEvents as unknown as IDataObject[],
						filters: {
							actions,
							resourceTypes,
						},
						operation: 'events',
						outputMode: eventsOutputMode,
						rawLines: parsedEvents.rawLines,
						readMode: eventsReadMode,
						unparsedLines: parsedEvents.unparsedLines,
						window,
					},
					itemIndex,
				),
			];
		}

		case 'version': {
			const version = await client.getVersion(abortSignal);

			return [toExecutionItem(version, itemIndex)];
		}
	}

	throw new Error(`Unsupported system operation "${operation}".`);
}
