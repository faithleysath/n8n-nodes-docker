import type { IDataObject } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

function isPlainObject(value: unknown): value is IDataObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeJsonParameter(
	value: unknown,
	label: string,
	errorFactory: (message: string) => NodeOperationError,
): IDataObject {
	if (value === undefined || value === null || value === '') {
		return {};
	}

	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as unknown;

			if (!isPlainObject(parsed)) {
				throw new Error('Expected an object.');
			}

			return parsed;
		} catch (error) {
			throw errorFactory(
				`${label} must be a valid JSON object.${error instanceof Error ? ` ${error.message}` : ''}`,
			);
		}
	}

	if (!isPlainObject(value)) {
		throw errorFactory(`${label} must be a JSON object.`);
	}

	return value;
}

export function deepMergeObjects<T extends Record<string, unknown>>(
	base: T,
	override: Record<string, unknown>,
): T {
	const result: Record<string, unknown> = { ...base };

	for (const [key, overrideValue] of Object.entries(override)) {
		const baseValue = result[key];

		if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
			result[key] = deepMergeObjects(baseValue, overrideValue);
			continue;
		}

		result[key] = overrideValue;
	}

	return result as T;
}
