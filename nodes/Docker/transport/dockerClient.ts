import { access } from 'node:fs/promises';
import type { IncomingHttpHeaders, RequestOptions as HttpRequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { URLSearchParams } from 'node:url';

export type DockerConnectionMode = 'unixSocket' | 'tcp' | 'tls' | 'ssh';
export type DockerAccessMode = 'readOnly' | 'fullControl';
export type DockerRequestMethod = 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PUT';
export type DockerJson = Record<string, unknown>;

export interface DockerCredentials {
	accessMode?: DockerAccessMode;
	apiVersion?: string;
	ca?: string;
	cert?: string;
	connectionMode?: DockerConnectionMode;
	host?: string;
	ignoreTlsIssues?: boolean;
	key?: string;
	passphrase?: string;
	port?: number;
	socketPath?: string;
}

export interface DockerRequestOptions {
	abortSignal?: AbortSignal;
	body?: Buffer | string;
	expectedStatusCodes?: number[];
	headers?: Record<string, string>;
	method?: DockerRequestMethod;
	path: string;
	query?: Record<string, boolean | number | string | undefined>;
	versioned?: boolean;
}

export interface DockerRawResponse {
	body: Buffer;
	headers: IncomingHttpHeaders;
	statusCode: number;
}

export interface DockerVersionResponse extends DockerJson {
	ApiVersion?: string;
	MinAPIVersion?: string;
	Version?: string;
}

export interface DockerPingResponse {
	apiVersion?: string;
	dockerExperimental?: string;
	ok: boolean;
	osType?: string;
	rawResponse: string;
}

export interface DockerActionResult {
	changed: boolean;
	statusCode: number;
}

export interface DockerContainerCreateResponse extends DockerJson {
	Id?: string;
	Warnings?: string[];
}

export interface DockerExecCreateResponse extends DockerJson {
	Id?: string;
}

export interface DockerExecInspectResponse extends DockerJson {
	ContainerID?: string;
	ExitCode?: number;
	ID?: string;
	Running?: boolean;
}

export class DockerRequestError extends Error {
	bodyText?: string;
	details?: unknown;
	method: DockerRequestMethod;
	path: string;
	statusCode?: number;

	constructor(
		message: string,
		options: {
			bodyText?: string;
			details?: unknown;
			method: DockerRequestMethod;
			path: string;
			statusCode?: number;
		},
	) {
		super(message);
		this.name = 'DockerRequestError';
		this.bodyText = options.bodyText;
		this.details = options.details;
		this.method = options.method;
		this.path = options.path;
		this.statusCode = options.statusCode;
	}
}

function trimToUndefined(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	const trimmed = value.trim();

	return trimmed === '' ? undefined : trimmed;
}

function normalizePort(value: number | undefined, fallback: number): number {
	if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
		return value;
	}

	return fallback;
}

function parseJsonIfPossible(buffer: Buffer): unknown {
	if (buffer.length === 0) {
		return undefined;
	}

	const text = buffer.toString('utf8').trim();

	if (text === '') {
		return undefined;
	}

	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function buildQueryString(
	query: Record<string, boolean | number | string | undefined> | undefined,
): string {
	if (query === undefined) {
		return '';
	}

	const searchParams = new URLSearchParams();

	for (const [key, rawValue] of Object.entries(query)) {
		if (rawValue === undefined) {
			continue;
		}

		if (typeof rawValue === 'boolean') {
			searchParams.set(key, rawValue ? '1' : '0');
			continue;
		}

		searchParams.set(key, String(rawValue));
	}

	const serialized = searchParams.toString();

	return serialized === '' ? '' : `?${serialized}`;
}

export function normalizeDockerApiVersion(apiVersion: string | undefined): string | 'auto' {
	const normalized = trimToUndefined(apiVersion);

	if (normalized === undefined || normalized.toLowerCase() === 'auto') {
		return 'auto';
	}

	const withoutPrefix = normalized.startsWith('v') ? normalized.slice(1) : normalized;

	if (!/^\d+\.\d+$/.test(withoutPrefix)) {
		throw new Error(
			`Invalid Docker API version "${apiVersion}". Use "auto" or a value like "1.51".`,
		);
	}

	return withoutPrefix;
}

export class DockerApiClient {
	private readonly credentials: DockerCredentials;

	private readonly timeoutMs: number;

	private negotiatedApiVersion?: Promise<string>;

	private validatedConnection?: Promise<void>;

	constructor(credentials: DockerCredentials, options?: { timeoutMs?: number }) {
		this.credentials = credentials;
		this.timeoutMs = options?.timeoutMs ?? 30_000;
	}

	get accessMode(): DockerAccessMode {
		return this.credentials.accessMode ?? 'readOnly';
	}

	async ping(abortSignal?: AbortSignal): Promise<DockerPingResponse> {
		const response = await this.request({
			abortSignal,
			path: '/_ping',
			versioned: false,
		});

		return {
			apiVersion: firstHeaderValue(response.headers['api-version']),
			dockerExperimental: firstHeaderValue(response.headers['docker-experimental']),
			ok: response.body.toString('utf8').trim() === 'OK',
			osType: firstHeaderValue(response.headers.ostype),
			rawResponse: response.body.toString('utf8'),
		};
	}

	async getVersion(abortSignal?: AbortSignal): Promise<DockerVersionResponse> {
		return this.requestJson<DockerVersionResponse>({
			abortSignal,
			path: '/version',
			versioned: false,
		});
	}

	async getInfo(abortSignal?: AbortSignal): Promise<DockerJson> {
		return this.requestJson<DockerJson>({
			abortSignal,
			path: '/info',
		});
	}

	async listContainers(
		options: { all: boolean },
		abortSignal?: AbortSignal,
	): Promise<DockerJson[]> {
		return this.requestJson<DockerJson[]>({
			abortSignal,
			path: '/containers/json',
			query: {
				all: options.all,
			},
		});
	}

	async inspectContainer(containerId: string, abortSignal?: AbortSignal): Promise<DockerJson> {
		return this.requestJson<DockerJson>({
			abortSignal,
			path: `/containers/${encodeURIComponent(containerId)}/json`,
		});
	}

	async topContainer(
		containerId: string,
		options: { psArgs?: string },
		abortSignal?: AbortSignal,
	): Promise<DockerJson> {
		return this.requestJson<DockerJson>({
			abortSignal,
			path: `/containers/${encodeURIComponent(containerId)}/top`,
			query: {
				ps_args: options.psArgs,
			},
		});
	}

	async getContainerStats(
		containerId: string,
		options: { oneShot: boolean },
		abortSignal?: AbortSignal,
	): Promise<DockerJson> {
		return this.requestJson<DockerJson>({
			abortSignal,
			path: `/containers/${encodeURIComponent(containerId)}/stats`,
			query: {
				'one-shot': options.oneShot,
				stream: false,
			},
		});
	}

	async waitForContainer(
		containerId: string,
		options: { condition?: string },
		abortSignal?: AbortSignal,
	): Promise<DockerJson> {
		return this.requestJson<DockerJson>({
			abortSignal,
			method: 'POST',
			path: `/containers/${encodeURIComponent(containerId)}/wait`,
			query: {
				condition: options.condition,
			},
		});
	}

	async createContainer(
		options: { body: DockerJson; name?: string; platform?: string },
		abortSignal?: AbortSignal,
	): Promise<DockerContainerCreateResponse> {
		return this.requestJson<DockerContainerCreateResponse>({
			abortSignal,
			body: JSON.stringify(options.body),
			headers: {
				'Content-Type': 'application/json',
			},
			method: 'POST',
			path: '/containers/create',
			query: {
				name: options.name,
				platform: options.platform,
			},
		});
	}

	async updateContainer(
		containerId: string,
		body: DockerJson,
		abortSignal?: AbortSignal,
	): Promise<DockerJson> {
		return this.requestJson<DockerJson>({
			abortSignal,
			body: JSON.stringify(body),
			headers: {
				'Content-Type': 'application/json',
			},
			method: 'POST',
			path: `/containers/${encodeURIComponent(containerId)}/update`,
		});
	}

	async startContainer(containerId: string, abortSignal?: AbortSignal): Promise<DockerActionResult> {
		return this.requestNoContent({
			abortSignal,
			expectedStatusCodes: [204, 304],
			method: 'POST',
			path: `/containers/${encodeURIComponent(containerId)}/start`,
		});
	}

	async stopContainer(
		containerId: string,
		options: { timeoutSeconds?: number },
		abortSignal?: AbortSignal,
	): Promise<DockerActionResult> {
		return this.requestNoContent({
			abortSignal,
			expectedStatusCodes: [204, 304],
			method: 'POST',
			path: `/containers/${encodeURIComponent(containerId)}/stop`,
			query: {
				t: options.timeoutSeconds,
			},
		});
	}

	async restartContainer(
		containerId: string,
		options: { timeoutSeconds?: number },
		abortSignal?: AbortSignal,
	): Promise<DockerActionResult> {
		return this.requestNoContent({
			abortSignal,
			expectedStatusCodes: [204, 304],
			method: 'POST',
			path: `/containers/${encodeURIComponent(containerId)}/restart`,
			query: {
				t: options.timeoutSeconds,
			},
		});
	}

	async removeContainer(
		containerId: string,
		options: { force: boolean; removeVolumes: boolean },
		abortSignal?: AbortSignal,
	): Promise<DockerActionResult> {
		return this.requestNoContent({
			abortSignal,
			method: 'DELETE',
			path: `/containers/${encodeURIComponent(containerId)}`,
			query: {
				force: options.force,
				v: options.removeVolumes,
			},
		});
	}

	async getContainerLogs(
		containerId: string,
		options: {
			since?: string;
			stderr: boolean;
			stdout: boolean;
			tail?: string;
			timestamps: boolean;
			until?: string;
		},
		abortSignal?: AbortSignal,
	): Promise<DockerRawResponse> {
		return this.request({
			abortSignal,
			path: `/containers/${encodeURIComponent(containerId)}/logs`,
			query: {
				since: options.since,
				stderr: options.stderr,
				stdout: options.stdout,
				tail: options.tail,
				timestamps: options.timestamps,
				until: options.until,
			},
		});
	}

	async createContainerExec(
		containerId: string,
		body: DockerJson,
		abortSignal?: AbortSignal,
	): Promise<DockerExecCreateResponse> {
		return this.requestJson<DockerExecCreateResponse>({
			abortSignal,
			body: JSON.stringify(body),
			headers: {
				'Content-Type': 'application/json',
			},
			method: 'POST',
			path: `/containers/${encodeURIComponent(containerId)}/exec`,
		});
	}

	async startContainerExec(
		execId: string,
		body: DockerJson,
		abortSignal?: AbortSignal,
	): Promise<DockerRawResponse> {
		return this.request({
			abortSignal,
			body: JSON.stringify(body),
			headers: {
				'Content-Type': 'application/json',
			},
			method: 'POST',
			path: `/exec/${encodeURIComponent(execId)}/start`,
		});
	}

	async inspectContainerExec(
		execId: string,
		abortSignal?: AbortSignal,
	): Promise<DockerExecInspectResponse> {
		return this.requestJson<DockerExecInspectResponse>({
			abortSignal,
			path: `/exec/${encodeURIComponent(execId)}/json`,
		});
	}

	async getContainerArchiveInfo(
		containerId: string,
		options: { path: string },
		abortSignal?: AbortSignal,
	): Promise<DockerRawResponse> {
		return this.request({
			abortSignal,
			method: 'HEAD',
			path: `/containers/${encodeURIComponent(containerId)}/archive`,
			query: {
				path: options.path,
			},
		});
	}

	async getContainerArchive(
		containerId: string,
		options: { path: string },
		abortSignal?: AbortSignal,
	): Promise<DockerRawResponse> {
		return this.request({
			abortSignal,
			headers: {
				Accept: 'application/x-tar',
			},
			path: `/containers/${encodeURIComponent(containerId)}/archive`,
			query: {
				path: options.path,
			},
		});
	}

	async putContainerArchive(
		containerId: string,
		options: {
			body: Buffer;
			copyUidGid?: boolean;
			noOverwriteDirNonDir?: boolean;
			path: string;
		},
		abortSignal?: AbortSignal,
	): Promise<DockerActionResult> {
		const response = await this.request({
			abortSignal,
			body: options.body,
			expectedStatusCodes: [200],
			headers: {
				'Content-Type': 'application/x-tar',
			},
			method: 'PUT',
			path: `/containers/${encodeURIComponent(containerId)}/archive`,
			query: {
				copyUIDGID: options.copyUidGid,
				noOverwriteDirNonDir: options.noOverwriteDirNonDir,
				path: options.path,
			},
		});

		return {
			changed: response.statusCode === 200,
			statusCode: response.statusCode,
		};
	}

	async exportContainer(containerId: string, abortSignal?: AbortSignal): Promise<DockerRawResponse> {
		return this.request({
			abortSignal,
			headers: {
				Accept: 'application/octet-stream',
			},
			path: `/containers/${encodeURIComponent(containerId)}/export`,
		});
	}

	private async requestJson<T>(options: DockerRequestOptions): Promise<T> {
		const response = await this.request(options);
		const parsed = parseJsonIfPossible(response.body);

		if (parsed === undefined) {
			throw new DockerRequestError('Docker API returned an empty JSON response.', {
				method: options.method ?? 'GET',
				path: options.path,
			});
		}

		return parsed as T;
	}

	private async requestNoContent(options: DockerRequestOptions): Promise<DockerActionResult> {
		const response = await this.request(options);

		return {
			changed: response.statusCode === 204,
			statusCode: response.statusCode,
		};
	}

	async request(options: DockerRequestOptions): Promise<DockerRawResponse> {
		await this.validateConnectionSettings();

		const method = options.method ?? 'GET';
		const requestPath = await this.buildRequestPath(
			options.path,
			options.query,
			options.versioned ?? true,
		);
		const requestOptions = this.buildRequestOptions(method, requestPath, options);
		const requestFn = this.credentials.connectionMode === 'tls' ? httpsRequest : httpRequest;

		return await new Promise<DockerRawResponse>((resolve, reject) => {
			const request = requestFn(requestOptions, (response) => {
				const chunks: Buffer[] = [];

				response.on('data', (chunk: Buffer | string) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});

				response.on('end', () => {
					const body = Buffer.concat(chunks);
					const statusCode = response.statusCode ?? 0;
					const expectedStatusCodes = options.expectedStatusCodes;
					const isSuccess =
						expectedStatusCodes !== undefined
							? expectedStatusCodes.includes(statusCode)
							: statusCode >= 200 && statusCode < 300;

					if (!isSuccess) {
						const parsedBody = parseJsonIfPossible(body);
						const bodyText =
							typeof parsedBody === 'string'
								? parsedBody
								: parsedBody === undefined
									? undefined
									: JSON.stringify(parsedBody);

						reject(
							new DockerRequestError(`Docker API request failed with status ${statusCode}.`, {
								bodyText,
								details: parsedBody,
								method,
								path: requestPath,
								statusCode,
							}),
						);

						return;
					}

					resolve({
						body,
						headers: response.headers,
						statusCode,
					});
				});
			});

			request.on('error', (error) => {
				reject(
					new DockerRequestError(error.message, {
						method,
						path: requestPath,
					}),
				);
			});

			request.setTimeout(this.timeoutMs, () => {
				request.destroy(new Error(`Docker request timed out after ${this.timeoutMs} ms.`));
			});

			if (options.body !== undefined) {
				request.write(options.body);
			}

			request.end();
		});
	}

	private async buildRequestPath(
		pathname: string,
		query: Record<string, boolean | number | string | undefined> | undefined,
		versioned: boolean,
	): Promise<string> {
		const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
		const queryString = buildQueryString(query);

		if (!versioned) {
			return `${normalizedPath}${queryString}`;
		}

		const apiVersion = await this.resolveApiVersion();

		return `/v${apiVersion}${normalizedPath}${queryString}`;
	}

	private buildRequestOptions(
		method: DockerRequestMethod,
		path: string,
		options: DockerRequestOptions,
	): HttpRequestOptions | HttpsRequestOptions {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			...options.headers,
		};

		if (options.body !== undefined && headers['Content-Length'] === undefined) {
			headers['Content-Length'] = Buffer.byteLength(options.body).toString();
		}

		if (this.credentials.connectionMode === 'unixSocket') {
			return {
				headers,
				method,
				path,
				signal: options.abortSignal,
				socketPath: trimToUndefined(this.credentials.socketPath),
			};
		}

		const hostname = trimToUndefined(this.credentials.host);
		const isTls = this.credentials.connectionMode === 'tls';
		const port = normalizePort(this.credentials.port, isTls ? 2376 : 2375);

		return {
			ca: trimToUndefined(this.credentials.ca),
			cert: trimToUndefined(this.credentials.cert),
			headers,
			hostname,
			key: trimToUndefined(this.credentials.key),
			method,
			passphrase: trimToUndefined(this.credentials.passphrase),
			path,
			port,
			rejectUnauthorized: isTls ? !this.credentials.ignoreTlsIssues : true,
			signal: options.abortSignal,
		};
	}

	private async resolveApiVersion(): Promise<string> {
		const configuredVersion = normalizeDockerApiVersion(this.credentials.apiVersion);

		if (configuredVersion !== 'auto') {
			return configuredVersion;
		}

		if (this.negotiatedApiVersion === undefined) {
			this.negotiatedApiVersion = (async () => {
				const version = await this.getVersion();
				const negotiatedVersion = normalizeDockerApiVersion(version.ApiVersion);

				if (negotiatedVersion === 'auto') {
					throw new Error('Docker daemon did not report an API version for negotiation.');
				}

				return negotiatedVersion;
			})();
		}

		return this.negotiatedApiVersion;
	}

	private async validateConnectionSettings(): Promise<void> {
		if (this.validatedConnection !== undefined) {
			return await this.validatedConnection;
		}

		this.validatedConnection = (async () => {
			switch (this.credentials.connectionMode) {
				case 'unixSocket': {
					const socketPath = trimToUndefined(this.credentials.socketPath);

					if (socketPath === undefined) {
						throw new Error('Socket Path is required for Unix Socket mode.');
					}

					await access(socketPath);
					return;
				}

				case 'tcp':
				case 'tls': {
					const host = trimToUndefined(this.credentials.host);

					if (host === undefined) {
						throw new Error('Host is required for TCP and TLS modes.');
					}

					const port = normalizePort(
						this.credentials.port,
						this.credentials.connectionMode === 'tls' ? 2376 : 2375,
					);

					if (!Number.isInteger(port) || port <= 0) {
						throw new Error('Port must be a positive integer.');
					}

					const cert = trimToUndefined(this.credentials.cert);
					const key = trimToUndefined(this.credentials.key);

					if ((cert === undefined) !== (key === undefined)) {
						throw new Error(
							'TLS client certificate and client private key must be provided together.',
						);
					}

					return;
				}

				case 'ssh':
					throw new Error(
						'Connection mode SSH is planned for a later phase and is not supported in this release.',
					);

				default:
					throw new Error('Select a supported Docker connection mode.');
			}
		})();

		return await this.validatedConnection;
	}
}
