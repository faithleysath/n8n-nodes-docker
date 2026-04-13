import { Readable } from 'node:stream';

import { extract, pack } from 'tar-stream';

export interface ContainerArchivePathStat {
	linkTarget: string;
	mode: number;
	mtime: string;
	name: string;
	size: number;
}

export interface ExtractedTarEntry {
	content: Buffer;
	fileName: string;
	mode?: number;
	type: string;
}

export interface ExtractSingleFileResult {
	entryCount: number;
	file?: ExtractedTarEntry;
	reason?: 'emptyArchive' | 'multipleEntries' | 'nonFileEntry';
}

function bufferToReadable(buffer: Buffer): Readable {
	return Readable.from(buffer);
}

export async function createSingleFileTarArchive(
	fileName: string,
	content: Buffer,
	options?: { mode?: number },
): Promise<Buffer> {
	const archive = pack();
	const chunks: Buffer[] = [];

	archive.on('data', (chunk: Buffer | string) => {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	});

	const completed = new Promise<Buffer>((resolve, reject) => {
		archive.on('end', () => resolve(Buffer.concat(chunks)));
		archive.on('error', reject);
	});

	archive.entry(
		{
			mode: options?.mode ?? 0o644,
			name: fileName,
			size: content.length,
			type: 'file',
		},
		content,
		(error) => {
			if (error != null) {
				archive.destroy(error);
				return;
			}

			archive.finalize();
		},
	);

	return await completed;
}

export function decodeContainerArchiveStatHeader(
	header: string | string[] | undefined,
): ContainerArchivePathStat | undefined {
	const normalizedHeader = Array.isArray(header) ? header[0] : header;

	if (normalizedHeader === undefined || normalizedHeader.trim() === '') {
		return undefined;
	}

	const decoded = Buffer.from(normalizedHeader, 'base64').toString('utf8');

	return JSON.parse(decoded) as ContainerArchivePathStat;
}

export async function extractSingleFileFromTarBuffer(
	buffer: Buffer,
): Promise<ExtractSingleFileResult> {
	const archive = extract();
	const reader = bufferToReadable(buffer);
	let entryCount = 0;
	let file: ExtractedTarEntry | undefined;
	let reason: ExtractSingleFileResult['reason'];
	let sawRegularFile = false;

	const finished = new Promise<ExtractSingleFileResult>((resolve, reject) => {
		archive.on('entry', (header, stream, next) => {
			entryCount += 1;
			const chunks: Buffer[] = [];

			stream.on('data', (chunk: Buffer | string) => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});

			stream.on('error', reject);
			stream.on('end', () => {
				if (entryCount > 1) {
					reason = 'multipleEntries';
					file = undefined;
					next();
					return;
				}

				if (header.type !== 'file') {
					reason = 'nonFileEntry';
					file = undefined;
					next();
					return;
				}

				sawRegularFile = true;
				file = {
					content: Buffer.concat(chunks),
					fileName: header.name,
					mode: header.mode,
					type: header.type,
				};
				next();
			});
		});

		archive.on('finish', () => {
			if (entryCount === 0) {
				resolve({
					entryCount,
					reason: 'emptyArchive',
				});
				return;
			}

			resolve({
				entryCount,
				file: entryCount === 1 && sawRegularFile && reason === undefined ? file : undefined,
				reason:
					entryCount === 1 && sawRegularFile && reason === undefined
						? undefined
						: reason ?? 'nonFileEntry',
			});
		});
		archive.on('error', reject);
	});

	reader.pipe(archive);

	return await finished;
}
