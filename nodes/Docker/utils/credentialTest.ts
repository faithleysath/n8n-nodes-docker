import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunctions,
	INodeCredentialTestResult,
} from 'n8n-workflow';

import { DockerApiClient, type DockerCredentials } from '../transport/dockerClient';

const dockerConnectionErrorFragments = [
	'Host is required',
	'Port must be a positive integer',
	'SSH Port must be a positive integer',
	'Socket Path is required',
	'TLS client certificate and client private key must be provided together',
	'Username is required',
	'Private Key is required',
	'Private Key is not a valid SSH private key',
	'Remote Socket Path is required',
	'Invalid Docker API version',
	'Select a supported Docker connection mode',
];

export function isDockerConnectionConfigurationError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	return dockerConnectionErrorFragments.some((fragment) => error.message.includes(fragment));
}

export async function validateDockerApiConnection(
	this: ICredentialTestFunctions,
	credential: { data?: ICredentialDataDecryptedObject },
): Promise<INodeCredentialTestResult> {
	const client = new DockerApiClient((credential.data ?? {}) as DockerCredentials);

	try {
		const pingResult = await client.ping();

		if (!pingResult.ok) {
			return {
				message: 'Docker daemon did not return an OK ping response.',
				status: 'Error',
			};
		}

		return {
			message: `Connected to Docker daemon${pingResult.apiVersion ? ` (API ${pingResult.apiVersion})` : ''}.`,
			status: 'OK',
		};
	} catch (error) {
		return {
			message: error instanceof Error ? error.message : 'Failed to connect to Docker daemon.',
			status: 'Error',
		};
	} finally {
		await client.close();
	}
}
