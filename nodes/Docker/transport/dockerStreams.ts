import type { DockerStreamResponse } from './dockerClient';

function normalizeErrorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== 'object') {
		return undefined;
	}

	const code = (error as { code?: unknown }).code;

	return typeof code === 'string' ? code : undefined;
}

export function isAbortLikeError(error: unknown): boolean {
	const code = normalizeErrorCode(error);
	const name =
		error instanceof Error ? error.name : typeof error === 'object' && error !== null ? String((error as { name?: unknown }).name ?? '') : '';
	const message = error instanceof Error ? error.message : String(error ?? '');

	return (
		name === 'AbortError' ||
		code === 'ABORT_ERR' ||
		code === 'ECONNRESET' ||
		message.includes('aborted') ||
		message.includes('The operation was aborted')
	);
}

export async function collectDockerStreamResponse(
	response: DockerStreamResponse,
	abortSignal?: AbortSignal,
): Promise<Buffer> {
	return await new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let settled = false;

		const cleanup = () => {
			response.stream.off('data', onData);
			response.stream.off('end', onEnd);
			response.stream.off('error', onError);
			abortSignal?.removeEventListener('abort', onAbort);
		};

		const settle = (handler: () => void) => {
			if (settled) {
				return;
			}

			settled = true;
			cleanup();
			handler();
		};

		const onData = (chunk: Buffer | string) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		};

		const onEnd = () => {
			settle(() => resolve(Buffer.concat(chunks)));
		};

		const onError = (error: Error) => {
			if (abortSignal?.aborted || isAbortLikeError(error)) {
				settle(() => resolve(Buffer.concat(chunks)));
				return;
			}

			settle(() => reject(error));
		};

		const onAbort = () => {
			response.close();
			settle(() => resolve(Buffer.concat(chunks)));
		};

		response.stream.on('data', onData);
		response.stream.on('end', onEnd);
		response.stream.on('error', onError);

		if (abortSignal?.aborted) {
			onAbort();
			return;
		}

		abortSignal?.addEventListener('abort', onAbort, { once: true });
	});
}

export async function waitForAbortableDelay(
	delayMs: number,
	abortSignal?: AbortSignal,
): Promise<void> {
	return await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			abortSignal?.removeEventListener('abort', onAbort);
			resolve();
		}, delayMs);

		const onAbort = () => {
			clearTimeout(timeout);
			resolve();
		};

		if (abortSignal?.aborted) {
			onAbort();
			return;
		}

		abortSignal?.addEventListener('abort', onAbort, { once: true });
	});
}
