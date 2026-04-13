import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import type { DockerApiClient } from '../transport/dockerClient';
import { parseDockerJsonLines } from '../transport/dockerJsonLines';
import type { ImageOperation } from '../types';
import {
	assertNonEmptyValue,
	assertWritableAccess,
	getNodeGetter,
	normalizePositiveInteger,
	toExecutionItem,
	trimToUndefined,
} from '../utils/execution';

export async function executeImageOperation(
	context: IExecuteFunctions,
	client: DockerApiClient,
	itemIndex: number,
	operation: ImageOperation,
): Promise<INodeExecutionData[]> {
	const abortSignal = context.getExecutionCancelSignal();
	const node = getNodeGetter(context);

	switch (operation) {
		case 'list': {
			const allImages = context.getNodeParameter('imageAllImages', itemIndex) as boolean;
			const returnAll = context.getNodeParameter('imageReturnAll', itemIndex) as boolean;
			const limitValue = context.getNodeParameter('imageLimit', itemIndex, 50) as number;
			const limit = returnAll
				? undefined
				: normalizePositiveInteger(node, limitValue, 'Limit', itemIndex);
			const images = await client.listImages({ all: allImages }, abortSignal);
			const selectedImages = limit === undefined ? images : images.slice(0, limit);

			return selectedImages.map((image) => toExecutionItem(image, itemIndex));
		}

		case 'inspect': {
			const imageReference = assertNonEmptyValue(
				node,
				context.getNodeParameter('imageReference', itemIndex) as string,
				'Image Reference',
				itemIndex,
			);
			const image = await client.inspectImage(imageReference, abortSignal);

			return [toExecutionItem(image, itemIndex)];
		}

		case 'history': {
			const imageReference = assertNonEmptyValue(
				node,
				context.getNodeParameter('imageReference', itemIndex) as string,
				'Image Reference',
				itemIndex,
			);
			const returnAll = context.getNodeParameter('imageHistoryReturnAll', itemIndex) as boolean;
			const limitValue = context.getNodeParameter('imageHistoryLimit', itemIndex, 50) as number;
			const limit = returnAll
				? undefined
				: normalizePositiveInteger(node, limitValue, 'Limit', itemIndex);
			const platform = trimToUndefined(
				context.getNodeParameter('imagePlatform', itemIndex, '') as string,
			);
			const history = await client.getImageHistory(imageReference, { platform }, abortSignal);
			const selectedLayers = limit === undefined ? history : history.slice(0, limit);

			return selectedLayers.map((layer) =>
				toExecutionItem(
					{
						...layer,
						imageReference,
						operation: 'history',
					},
					itemIndex,
				),
			);
		}

		case 'pull': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const imageReference = assertNonEmptyValue(
				node,
				context.getNodeParameter('imageReference', itemIndex) as string,
				'Image Reference',
				itemIndex,
			);
			const platform = trimToUndefined(
				context.getNodeParameter('imagePlatform', itemIndex, '') as string,
			);
			const pullResponse = await client.pullImage(
				{
					fromImage: imageReference,
					platform,
				},
				abortSignal,
			);
			const parsedMessages = parseDockerJsonLines(
				pullResponse.body,
				pullResponse.headers['content-type'],
			);
			let image: IDataObject | null = null;

			try {
				image = (await client.inspectImage(imageReference, abortSignal)) as IDataObject;
			} catch {
				image = null;
			}

			return [
				toExecutionItem(
					{
						contentType: parsedMessages.contentType,
						image,
						imageReference,
						messageCount: parsedMessages.entries.length,
						messages: parsedMessages.entries as unknown as IDataObject[],
						operation: 'pull',
						platform: platform ?? null,
						rawLines: parsedMessages.rawLines,
						unparsedLines: parsedMessages.unparsedLines,
					},
					itemIndex,
				),
			];
		}

		case 'tag': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const sourceImageReference = assertNonEmptyValue(
				node,
				context.getNodeParameter('sourceImageReference', itemIndex) as string,
				'Source Image',
				itemIndex,
			);
			const targetRepository = assertNonEmptyValue(
				node,
				context.getNodeParameter('targetRepository', itemIndex) as string,
				'Target Repository',
				itemIndex,
			);
			const targetTag = trimToUndefined(
				context.getNodeParameter('targetTag', itemIndex, 'latest') as string,
			);
			const tagResult = await client.tagImage(
				sourceImageReference,
				{
					repo: targetRepository,
					tag: targetTag,
				},
				abortSignal,
			);
			const taggedReference =
				targetTag === undefined ? targetRepository : `${targetRepository}:${targetTag}`;
			const image = await client.inspectImage(taggedReference, abortSignal);

			return [
				toExecutionItem(
					{
						changed: tagResult.changed,
						image,
						operation: 'tag',
						sourceImageReference,
						statusCode: tagResult.statusCode,
						taggedReference,
					},
					itemIndex,
				),
			];
		}

		case 'remove': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const imageReference = assertNonEmptyValue(
				node,
				context.getNodeParameter('imageReference', itemIndex) as string,
				'Image Reference',
				itemIndex,
			);
			const force = context.getNodeParameter('imageRemoveForce', itemIndex) as boolean;
			const keepUntaggedParents = context.getNodeParameter(
				'imageKeepUntaggedParents',
				itemIndex,
			) as boolean;
			const removed = await client.removeImage(
				imageReference,
				{
					force,
					noPrune: keepUntaggedParents,
				},
				abortSignal,
			);

			return [
				toExecutionItem(
					{
						force,
						imageReference,
						keepUntaggedParents,
						operation: 'remove',
						removed: removed as unknown as IDataObject[],
					},
					itemIndex,
				),
			];
		}

		case 'prune': {
			assertWritableAccess(node, client.accessMode, operation, itemIndex);

			const danglingOnly = context.getNodeParameter('imagePruneDanglingOnly', itemIndex) as boolean;
			const pruneResult = await client.pruneImages(
				{
					filters: JSON.stringify({
						dangling: [danglingOnly ? 'true' : 'false'],
					}),
				},
				abortSignal,
			);

			return [
				toExecutionItem(
					{
						...pruneResult,
						danglingOnly,
						operation: 'prune',
					},
					itemIndex,
				),
			];
		}
	}

	throw new Error(`Unsupported image operation "${operation}".`);
}
