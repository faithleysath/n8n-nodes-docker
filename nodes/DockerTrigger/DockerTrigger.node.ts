/* eslint-disable @n8n/community-nodes/node-usable-as-tool */

import type {
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
	IDataObject,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import {
	DockerApiClient,
	DockerRequestError,
	type DockerCredentials,
	type DockerStreamResponse,
} from '../Docker/transport/dockerClient';
import { DockerJsonLinesDecoder } from '../Docker/transport/dockerJsonLines';
import { waitForAbortableDelay } from '../Docker/transport/dockerStreams';
import {
	computeDockerReconnectDelayMs,
	createDockerEventFilterPayload,
	getDockerReplaySince,
	hasSeenDockerEvent,
	normalizeDockerEvent,
	readDockerEventCursorState,
	recordDockerEvent,
	type DockerEvent,
	type NormalizedDockerEvent,
} from '../Docker/utils/dockerEvents';
import {
	isDockerConnectionConfigurationError,
	validateDockerApiConnection,
} from '../Docker/utils/credentialTest';

function createTriggerItem(event: NormalizedDockerEvent): INodeExecutionData {
	return {
		json: event as unknown as IDataObject,
	};
}

function isFatalTriggerError(error: unknown): boolean {
	if (error instanceof DockerRequestError) {
		return error.statusCode !== undefined && error.statusCode < 500;
	}

	return isDockerConnectionConfigurationError(error);
}

async function readReplayEvents(
	client: DockerApiClient,
	filters: string | undefined,
	since: string,
	abortSignal?: AbortSignal,
): Promise<DockerEvent[]> {
	const response = await client.getEvents({
		filters,
		since,
		until: String(Math.floor(Date.now() / 1000)),
	}, abortSignal);
	const parsed = new DockerJsonLinesDecoder();
	const messages = [...parsed.write(response.body), ...parsed.flush()];

	return messages
		.filter((message): message is { entry: DockerEvent; rawLine: string } => message.entry !== undefined)
		.map((message) => message.entry);
}

export class DockerTrigger implements INodeType {
	description: INodeTypeDescription = {
		activationMessage: 'Listening for Docker events',
		defaults: {
			name: 'Docker Trigger',
		},
		description: 'Start workflows from Docker daemon events with replay and reconnect support',
		displayName: 'Docker Trigger',
		eventTriggerDescription: 'Starts the workflow when Docker emits matching events',
		group: ['trigger'],
		icon: {
			light: 'file:../Docker/docker.svg',
			dark: 'file:../Docker/docker.dark.svg',
		},
		inputs: [],
		name: 'dockerTrigger',
		outputs: [NodeConnectionTypes.Main],
		version: 1,
			credentials: [
				{
					name: 'dockerApi',
					required: true,
					testedBy: 'validateDockerApiConnection',
				},
			],
			properties: [
				{
					displayName:
						'Phase 6 keeps Docker Trigger dedicated to Docker daemon events with cursor replay, reconnect backoff, and SSH-capable long-lived subscriptions.',
					name: 'phaseFourNotice',
					type: 'notice',
					default: '',
				},
				{
					displayName: 'Resource Types',
					name: 'resourceTypes',
					type: 'multiOptions',
					default: [],
					description: 'Only trigger on Docker events for these resource types',
					options: [
						{ name: 'Container', value: 'container' },
						{ name: 'Daemon', value: 'daemon' },
						{ name: 'Image', value: 'image' },
						{ name: 'Network', value: 'network' },
						{ name: 'Volume', value: 'volume' },
					],
				},
				{
					displayName: 'Actions',
					name: 'actions',
					type: 'multiOptions',
					default: [],
					description: 'Only trigger on Docker events with these actions',
					options: [
						{ name: 'Create', value: 'create' },
						{ name: 'Destroy', value: 'destroy' },
						{ name: 'Die', value: 'die' },
						{ name: 'Pull', value: 'pull' },
						{ name: 'Remove', value: 'remove' },
						{ name: 'Restart', value: 'restart' },
						{ name: 'Start', value: 'start' },
						{ name: 'Stop', value: 'stop' },
					],
				},
			] as INodeProperties[],
	};

	methods = {
		credentialTest: {
			validateDockerApiConnection,
		},
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = await this.getCredentials<DockerCredentials>('dockerApi');
		const client = new DockerApiClient(credentials);

		try {
			const staticData = this.getWorkflowStaticData('node');
			const resourceTypes = this.getNodeParameter('resourceTypes', []) as string[];
			const actions = this.getNodeParameter('actions', []) as string[];
			const filters = createDockerEventFilterPayload({
				actions,
				resourceTypes,
			});
			const isManualMode = this.getMode() === 'manual';
			const manualSince = String(Math.floor(Date.now() / 1000));
			let cursorState = readDockerEventCursorState(staticData);
			let closed = false;
			let reconnectAttempt = 0;
			let reconnectTimer: NodeJS.Timeout | undefined;
			let activeAbortController: AbortController | undefined;
			let activeStream: DockerStreamResponse | undefined;
			let manualTimedOut = false;
			let manualResolve: ((data: INodeExecutionData[][]) => void) | undefined;
			let manualReject: ((error: Error) => void) | undefined;
			let manualTimeout: NodeJS.Timeout | undefined;
			const createManualCloseError = () =>
				new Error('Docker Trigger manual execution was closed before an event was received.');

			const closeFunction = async () => {
				closed = true;

				if (reconnectTimer !== undefined) {
					clearTimeout(reconnectTimer);
					reconnectTimer = undefined;
				}

				if (manualTimeout !== undefined) {
					clearTimeout(manualTimeout);
					manualTimeout = undefined;
				}

				activeAbortController?.abort();
				activeAbortController = undefined;
				activeStream?.close();
				activeStream = undefined;

				if (manualReject !== undefined && !manualTimedOut) {
					const reject = manualReject;

					manualResolve = undefined;
					manualReject = undefined;
					reject(createManualCloseError());
				}

				await client.close();
			};

			const resolveManualResponse = (event: NormalizedDockerEvent) => {
				if (manualResolve === undefined || manualTimedOut) {
					return;
				}

				recordDockerEvent(staticData, cursorState, event);
				cursorState = readDockerEventCursorState(staticData);
				const resolve = manualResolve;

				manualResolve = undefined;
				manualReject = undefined;
				resolve([[createTriggerItem(event)]]);
				void closeFunction();
			};

			const emitEvent = (event: NormalizedDockerEvent) => {
				if (closed) {
					return;
				}

				if (hasSeenDockerEvent(cursorState, event)) {
					return;
				}

				if (isManualMode) {
					resolveManualResponse(event);
					return;
				}

				this.emit([[createTriggerItem(event)]]);
				cursorState = recordDockerEvent(staticData, cursorState, event);
			};

			const handleFatalError = (error: Error) => {
				if (isManualMode) {
					if (manualReject !== undefined && !manualTimedOut) {
						const reject = manualReject;

						manualResolve = undefined;
						manualReject = undefined;
						reject(error);
					}

					void closeFunction();
					return;
				}

				this.emitError(error);
				void closeFunction();
			};

			const scheduleReconnect = () => {
				if (closed || reconnectTimer !== undefined) {
					return;
				}

				const delayMs = computeDockerReconnectDelayMs(reconnectAttempt);

				reconnectTimer = setTimeout(() => {
					reconnectTimer = undefined;
					reconnectAttempt += 1;
					void startListener(true);
				}, delayMs);
			};

			const handleDisconnect = (error?: Error) => {
				activeAbortController = undefined;
				activeStream = undefined;

				if (closed || manualTimedOut) {
					return;
				}

				if (error !== undefined && isFatalTriggerError(error)) {
					handleFatalError(error);
					return;
				}

				scheduleReconnect();
			};

			const startStream = async () => {
				const since =
					isManualMode
						? manualSince
						: getDockerReplaySince(cursorState) ?? String(Math.floor(Date.now() / 1000));

				activeAbortController = new AbortController();
				activeStream = await client.streamEvents(
					{
						filters,
						since,
					},
					activeAbortController.signal,
				);

				const decoder = new DockerJsonLinesDecoder();

				activeStream.stream.on('data', (chunk: Buffer | string) => {
					for (const message of decoder.write(chunk)) {
						if (message.entry === undefined) {
							continue;
						}

						emitEvent(normalizeDockerEvent(message.entry as DockerEvent));
					}
				});

				activeStream.stream.once('end', () => {
					for (const message of decoder.flush()) {
						if (message.entry === undefined) {
							continue;
						}

						emitEvent(normalizeDockerEvent(message.entry as DockerEvent));
					}

					handleDisconnect();
				});

				activeStream.stream.once('error', (error) => {
					handleDisconnect(error);
				});
			};

			const replayIfNeeded = async () => {
				if (isManualMode || closed) {
					return;
				}

				const since = getDockerReplaySince(cursorState);

				if (since === undefined) {
					return;
				}

				const replayAbortController = new AbortController();

				activeAbortController = replayAbortController;

				const events = await readReplayEvents(client, filters, since, replayAbortController.signal);

				if (activeAbortController === replayAbortController) {
					activeAbortController = undefined;
				}

				for (const event of events) {
					if (closed) {
						return;
					}

					emitEvent(normalizeDockerEvent(event));
				}
			};

			const startListener = async (shouldReplay: boolean) => {
				if (closed) {
					return;
				}

				try {
					if (shouldReplay) {
						await replayIfNeeded();
					}

					if (closed) {
						return;
					}

					await startStream();
					reconnectAttempt = 0;
				} catch (error) {
					handleDisconnect(error instanceof Error ? error : new Error(String(error)));
				}
			};

			void startListener(!isManualMode);

			let manualTriggerResponse: Promise<INodeExecutionData[][]> | undefined;

			if (isManualMode) {
				manualTriggerResponse = new Promise<INodeExecutionData[][]>((resolve, reject) => {
					manualResolve = resolve;
					manualReject = reject;
					manualTimeout = setTimeout(() => {
						manualTimedOut = true;
						manualResolve = undefined;
						manualReject = undefined;
						reject(new Error('Timed out waiting for a Docker event after 60 seconds.'));
						void closeFunction();
					}, 60_000);
				});
			}

			return {
				closeFunction,
				manualTriggerFunction: async () => {
					if (!isManualMode) {
						return;
					}

					await waitForAbortableDelay(0);
				},
				manualTriggerResponse,
			};
		} catch (error) {
			await client.close();
			throw error;
		}
	}
}
