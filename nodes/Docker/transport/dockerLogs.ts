export type DockerLogStream = 'stdout' | 'stderr' | 'system' | 'unknown';

export interface DockerLogEntry {
	stream: DockerLogStream;
	message: string;
}

export interface ParsedDockerLogStream {
	contentType?: string;
	entries: DockerLogEntry[];
	multiplexed: boolean;
	streamText: Record<DockerLogStream, string>;
	text: string;
}

interface ParsedFrame {
	entries: DockerLogEntry[];
	streamText: Record<DockerLogStream, string>;
	text: string;
}

function splitLogChunk(stream: DockerLogStream, chunk: string): DockerLogEntry[] {
	if (chunk.length === 0) {
		return [];
	}

	const normalized = chunk.replace(/\r\n/g, '\n');
	const segments = normalized.split('\n');
	const entries: DockerLogEntry[] = [];

	for (let index = 0; index < segments.length; index += 1) {
		const message = segments[index];
		const isTrailingEmptyLine = index === segments.length - 1 && message === '';

		if (isTrailingEmptyLine) {
			continue;
		}

		entries.push({
			message,
			stream,
		});
	}

	return entries;
}

function getStreamName(streamType: number): DockerLogStream {
	switch (streamType) {
		case 1:
			return 'stdout';
		case 2:
			return 'stderr';
		case 3:
			return 'system';
		default:
			return 'unknown';
	}
}

function tryParseRawStream(buffer: Buffer): ParsedFrame | null {
	if (buffer.length < 8) {
		return null;
	}

	let offset = 0;
	const textChunks: string[] = [];
	const entries: DockerLogEntry[] = [];
	const streamText: Record<DockerLogStream, string> = {
		stderr: '',
		stdout: '',
		system: '',
		unknown: '',
	};

	while (offset < buffer.length) {
		if (offset + 8 > buffer.length) {
			return null;
		}

		const streamType = buffer[offset];
		const payloadLength = buffer.readUInt32BE(offset + 4);
		const payloadStart = offset + 8;
		const payloadEnd = payloadStart + payloadLength;

		if (payloadEnd > buffer.length) {
			return null;
		}

		const chunk = buffer.subarray(payloadStart, payloadEnd).toString('utf8');
		const stream = getStreamName(streamType);

		textChunks.push(chunk);
		entries.push(...splitLogChunk(stream, chunk));
		streamText[stream] += chunk;

		offset = payloadEnd;
	}

	return {
		entries,
		streamText,
		text: textChunks.join(''),
	};
}

export function parseDockerRawStream(
	buffer: Buffer,
	contentType?: string | string[],
): ParsedDockerLogStream {
	const normalizedContentType = Array.isArray(contentType) ? contentType[0] : contentType;
	const parsedRawStream = tryParseRawStream(buffer);

	if (parsedRawStream !== null) {
		return {
			contentType: normalizedContentType,
			entries: parsedRawStream.entries,
			multiplexed: true,
			streamText: parsedRawStream.streamText,
			text: parsedRawStream.text,
		};
	}

	const text = buffer.toString('utf8');

	return {
		contentType: normalizedContentType,
		entries: splitLogChunk('stdout', text),
		multiplexed: false,
		streamText: {
			stderr: '',
			stdout: text,
			system: '',
			unknown: '',
		},
		text,
	};
}

export function parseDockerLogStream(
	buffer: Buffer,
	contentType?: string | string[],
): ParsedDockerLogStream {
	return parseDockerRawStream(buffer, contentType);
}
