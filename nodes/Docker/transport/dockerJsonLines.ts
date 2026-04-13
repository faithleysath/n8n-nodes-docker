import type { DockerJson } from './dockerClient';

export interface ParsedDockerJsonLines {
	contentType?: string;
	entries: DockerJson[];
	rawLines: string[];
	text: string;
	unparsedLines: string[];
}

function normalizeContentType(contentType?: string | string[]): string | undefined {
	return Array.isArray(contentType) ? contentType[0] : contentType;
}

export function parseDockerJsonLines(
	buffer: Buffer,
	contentType?: string | string[],
): ParsedDockerJsonLines {
	const text = buffer.toString('utf8');
	const rawLines = text
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '');
	const entries: DockerJson[] = [];
	const unparsedLines: string[] = [];

	for (const line of rawLines) {
		try {
			const parsed = JSON.parse(line) as unknown;

			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				entries.push(parsed as DockerJson);
				continue;
			}
		} catch {
			// Keep non-JSON lines for callers that want the raw output.
		}

		unparsedLines.push(line);
	}

	return {
		contentType: normalizeContentType(contentType),
		entries,
		rawLines,
		text,
		unparsedLines,
	};
}
