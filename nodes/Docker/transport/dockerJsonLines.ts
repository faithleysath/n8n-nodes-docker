import type { DockerJson } from './dockerClient';

export interface ParsedDockerJsonLines {
	contentType?: string;
	entries: DockerJson[];
	rawLines: string[];
	text: string;
	unparsedLines: string[];
}

export interface DockerJsonLineMessage {
	entry?: DockerJson;
	rawLine: string;
}

function normalizeContentType(contentType?: string | string[]): string | undefined {
	return Array.isArray(contentType) ? contentType[0] : contentType;
}

function parseDockerJsonLine(rawLine: string): DockerJsonLineMessage | undefined {
	const normalizedLine = rawLine.trim();

	if (normalizedLine === '') {
		return undefined;
	}

	try {
		const parsed = JSON.parse(normalizedLine) as unknown;

		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return {
				entry: parsed as DockerJson,
				rawLine: normalizedLine,
			};
		}
	} catch {
		// Keep non-JSON lines for callers that want the raw output.
	}

	return {
		rawLine: normalizedLine,
	};
}

export class DockerJsonLinesDecoder {
	private remainder = '';

	write(chunk: Buffer | string): DockerJsonLineMessage[] {
		const text = `${this.remainder}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk}`.replace(
			/\r\n/g,
			'\n',
		);
		const segments = text.split('\n');

		this.remainder = segments.pop() ?? '';

		return segments
			.map((segment) => parseDockerJsonLine(segment))
			.filter((message): message is DockerJsonLineMessage => message !== undefined);
	}

	flush(): DockerJsonLineMessage[] {
		const remainder = this.remainder;

		this.remainder = '';

		const message = parseDockerJsonLine(remainder);

		return message === undefined ? [] : [message];
	}
}

export function parseDockerJsonLines(
	buffer: Buffer,
	contentType?: string | string[],
): ParsedDockerJsonLines {
	const text = buffer.toString('utf8');
	const decoder = new DockerJsonLinesDecoder();
	const messages = [...decoder.write(buffer), ...decoder.flush()];
	const entries: DockerJson[] = [];
	const unparsedLines: string[] = [];
	const rawLines = messages.map((message) => message.rawLine);

	for (const message of messages) {
		if (message.entry !== undefined) {
			entries.push(message.entry);
			continue;
		}

		unparsedLines.push(message.rawLine);
	}

	return {
		contentType: normalizeContentType(contentType),
		entries,
		rawLines,
		text,
		unparsedLines,
	};
}
