import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

import type { ParsedDockerJsonLines } from '../transport/dockerJsonLines';
import { toExecutionItem } from './execution';

export type DockerBuildLikeOperation = 'build' | 'import';
export type DockerBuildOutputMode = 'aggregate' | 'splitItems';

interface DockerAuxSummary {
	imageDigest: string | null;
	imageId: string | null;
	namedReferences: string[];
}

function appendUnique(values: string[], value: unknown): void {
	if (typeof value !== 'string') {
		return;
	}

	const normalized = value.trim();

	if (normalized === '' || values.includes(normalized)) {
		return;
	}

	values.push(normalized);
}

function collectNamedReferences(namedReferences: string[], key: string, value: unknown): void {
	switch (key) {
		case 'Name':
		case 'Names':
		case 'Named':
		case 'NamedReferences':
		case 'Reference':
		case 'References':
		case 'Repo':
		case 'Repository':
		case 'Tag':
		case 'Tags': {
			if (Array.isArray(value)) {
				for (const entry of value) {
					appendUnique(namedReferences, entry);
				}

				return;
			}

			appendUnique(namedReferences, value);
			return;
		}

		default:
			return;
	}
}

export function summarizeDockerBuildAux(messages: IDataObject[]): DockerAuxSummary {
	const namedReferences: string[] = [];
	let imageId: string | null = null;
	let imageDigest: string | null = null;

	for (const message of messages) {
		const aux = message.aux;

		if (aux === null || typeof aux !== 'object' || Array.isArray(aux)) {
			continue;
		}

		for (const [key, value] of Object.entries(aux as IDataObject)) {
			if (key === 'ID' && typeof value === 'string' && value.trim() !== '') {
				imageId = value;
				continue;
			}

			if (key === 'Digest' && typeof value === 'string' && value.trim() !== '') {
				imageDigest = value;
				continue;
			}

			collectNamedReferences(namedReferences, key, value);
		}
	}

	return {
		imageDigest,
		imageId,
		namedReferences,
	};
}

export function normalizeDockerBuildOutput(
	options: {
		aggregateData: IDataObject;
		itemIndex: number;
		operation: DockerBuildLikeOperation;
		outputMode: DockerBuildOutputMode;
		parsedMessages: ParsedDockerJsonLines;
		splitData?: IDataObject;
	},
): INodeExecutionData[] {
	if (options.outputMode === 'splitItems') {
		return options.parsedMessages.entries.map((entry, messageIndex) =>
			toExecutionItem(
				{
					...options.splitData,
					...entry,
					messageIndex,
					operation: options.operation,
				},
				options.itemIndex,
			),
		);
	}

	return [
		toExecutionItem(
			{
				...options.aggregateData,
				contentType: options.parsedMessages.contentType,
				messageCount: options.parsedMessages.entries.length,
				messages: options.parsedMessages.entries as IDataObject[],
				operation: options.operation,
				rawLines: options.parsedMessages.rawLines,
				unparsedLines: options.parsedMessages.unparsedLines,
			},
			options.itemIndex,
		),
	];
}
