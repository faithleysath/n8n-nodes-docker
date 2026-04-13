import type { IDataObject } from 'n8n-workflow';

import type { DockerJson } from '../transport/dockerClient';

interface DockerEventActor extends IDataObject {
	ID?: string;
}

export interface DockerEvent extends DockerJson {
	Action?: string;
	Actor?: DockerEventActor;
	Type?: string;
	from?: string;
	id?: string;
	time?: number;
	timeNano?: number;
}

export interface DockerEventCursorState {
	lastEventTime?: number;
	lastEventTimeNano?: number;
	recentEventKeys: string[];
}

export interface NormalizedDockerEvent extends DockerEvent {
	action?: string;
	actorId?: string;
	cursor?: string;
	emittedAt?: string;
	eventKey: string;
	type?: string;
}

interface DockerEventCursorValue {
	seconds: number;
	value: bigint;
}

interface DockerEventCursorLike {
	lastEventTime?: number;
	lastEventTimeNano?: number;
	time?: number;
	timeNano?: number;
}

const NANOSECONDS_PER_SECOND = BigInt('1000000000');

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();

	return trimmed === '' ? undefined : trimmed;
}

function normalizePositiveInteger(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		return undefined;
	}

	return value;
}

function toIsoString(event: DockerEvent): string | undefined {
	const timeNano = normalizePositiveInteger(event.timeNano);

	if (timeNano !== undefined) {
		return new Date(Math.floor(timeNano / 1_000_000)).toISOString();
	}

	const time = normalizePositiveInteger(event.time);

	if (time !== undefined) {
		return new Date(time * 1000).toISOString();
	}

	return undefined;
}

export function createDockerEventFilterPayload(options: {
	actions: string[];
	resourceTypes: string[];
}): string | undefined {
	const payload: Record<string, string[]> = {};

	if (options.resourceTypes.length > 0) {
		payload.type = options.resourceTypes;
	}

	if (options.actions.length > 0) {
		payload.event = options.actions;
	}

	return Object.keys(payload).length === 0 ? undefined : JSON.stringify(payload);
}

export function getDockerEventCursor(event: DockerEvent): string | undefined {
	const timeNano = normalizePositiveInteger(event.timeNano);

	if (timeNano !== undefined) {
		return String(timeNano);
	}

	const time = normalizePositiveInteger(event.time);

	if (time !== undefined) {
		return String(time);
	}

	return undefined;
}

export function getDockerEventKey(event: DockerEvent): string {
	const cursor = getDockerEventCursor(event) ?? '';
	const type = normalizeString(event.Type) ?? '';
	const action = normalizeString(event.Action) ?? '';
	const actorId = normalizeString(event.Actor?.ID) ?? '';
	const objectId = normalizeString(event.id) ?? '';
	const source = normalizeString(event.from) ?? '';

	return [cursor, type, action, actorId, objectId, source].join('|');
}

export function normalizeDockerEvent(event: DockerEvent): NormalizedDockerEvent {
	return {
		...event,
		action: normalizeString(event.Action),
		actorId:
			normalizeString(event.Actor?.ID) ??
			normalizeString(event.id) ??
			normalizeString(event.from),
		cursor: getDockerEventCursor(event),
		emittedAt: toIsoString(event),
		eventKey: getDockerEventKey(event),
		type: normalizeString(event.Type),
	};
}

export function readDockerEventCursorState(staticData: IDataObject): DockerEventCursorState {
	const recentEventKeys = Array.isArray(staticData.recentEventKeys)
		? (staticData.recentEventKeys as unknown[])
				.map((value) => (typeof value === 'string' ? value.trim() : ''))
				.filter((value) => value !== '')
		: [];

	return {
		lastEventTime: normalizePositiveInteger(staticData.lastEventTime),
		lastEventTimeNano: normalizePositiveInteger(staticData.lastEventTimeNano),
		recentEventKeys,
	};
}

function getEventCursorValue(
	event: DockerEvent | NormalizedDockerEvent | DockerEventCursorLike,
): DockerEventCursorValue | undefined {
	const timeNano = normalizePositiveInteger(event.timeNano ?? event.lastEventTimeNano);

	if (timeNano !== undefined) {
		const value = BigInt(String(timeNano));
		const time =
			normalizePositiveInteger(event.time ?? event.lastEventTime) ??
			Number(value / NANOSECONDS_PER_SECOND);

		return {
			seconds: time,
			value,
		};
	}

	const time = normalizePositiveInteger(event.time ?? event.lastEventTime);

	if (time === undefined) {
		return undefined;
	}

	return {
		seconds: time,
		value: BigInt(time) * NANOSECONDS_PER_SECOND,
	};
}

function compareEventCursorValues(
	left: DockerEventCursorValue | undefined,
	right: DockerEventCursorValue | undefined,
): -1 | 0 | 1 | undefined {
	if (left === undefined || right === undefined) {
		return undefined;
	}

	if (left.value < right.value) {
		return -1;
	}

	if (left.value > right.value) {
		return 1;
	}

	return 0;
}

export function hasSeenDockerEvent(
	state: DockerEventCursorState,
	event: DockerEvent | NormalizedDockerEvent,
): boolean {
	const comparison = compareEventCursorValues(
		getEventCursorValue(event),
		getEventCursorValue(state),
	);

	if (comparison === -1) {
		return true;
	}

	if (comparison === 1) {
		return false;
	}

	const eventKey = 'eventKey' in event ? String(event.eventKey) : getDockerEventKey(event);

	return state.recentEventKeys.includes(eventKey);
}

export function recordDockerEvent(
	staticData: IDataObject,
	state: DockerEventCursorState,
	event: DockerEvent | NormalizedDockerEvent,
): DockerEventCursorState {
	const normalized = 'eventKey' in event ? event : normalizeDockerEvent(event);
	const normalizedEventKey = String(normalized.eventKey);
	const previousEventCursor = getEventCursorValue(state);
	const nextEventCursor = getEventCursorValue(normalized);
	const comparison = compareEventCursorValues(nextEventCursor, previousEventCursor);
	const recentEventKeys =
		comparison !== undefined && comparison !== 0
			? [normalizedEventKey]
			: [...state.recentEventKeys.filter((key) => key !== normalizedEventKey), normalizedEventKey];
	const lastEventTime = nextEventCursor?.seconds ?? state.lastEventTime;
	const lastEventTimeNano =
		nextEventCursor === undefined ? state.lastEventTimeNano : normalizePositiveInteger(normalized.timeNano);

	staticData.lastEventTime = lastEventTime;
	staticData.recentEventKeys = recentEventKeys;

	if (lastEventTimeNano === undefined) {
		delete staticData.lastEventTimeNano;
	} else {
		staticData.lastEventTimeNano = lastEventTimeNano;
	}

	return {
		lastEventTime,
		lastEventTimeNano,
		recentEventKeys,
	};
}

export function getDockerReplaySince(state: DockerEventCursorState): string | undefined {
	if (state.lastEventTime !== undefined) {
		return String(state.lastEventTime);
	}

	if (state.lastEventTimeNano !== undefined) {
		return String(Math.floor(state.lastEventTimeNano / 1_000_000_000));
	}

	return undefined;
}

export function computeDockerReconnectDelayMs(
	attempt: number,
	random: () => number = Math.random,
): number {
	const baseDelayMs = Math.min(1000 * 2 ** Math.max(0, attempt), 30_000);
	const jitterMs = Math.floor(Math.max(0, random()) * 250);

	return baseDelayMs + jitterMs;
}
