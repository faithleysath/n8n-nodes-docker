import { basename, posix } from 'node:path';

export interface ExecPolicyEvaluation {
	commandName: string;
	deniedBy?: string;
	requiresAllowListMatch: boolean;
}

function normalizeCommandName(commandName: string): string {
	const trimmed = commandName.trim();

	if (trimmed === '') {
		return '';
	}

	const normalizedPath = trimmed.replace(/\\/g, '/');

	return basename(posix.normalize(normalizedPath));
}

function normalizeRules(rules: string[]): string[] {
	return rules
		.map((rule) => normalizeCommandName(rule))
		.filter((rule) => rule !== '');
}

export function evaluateExecPolicy(
	command: string,
	allowList: string[],
	denyList: string[],
): ExecPolicyEvaluation {
	const commandName = normalizeCommandName(command);
	const normalizedAllowList = normalizeRules(allowList);
	const normalizedDenyList = normalizeRules(denyList);

	if (normalizedDenyList.includes(commandName)) {
		return {
			commandName,
			deniedBy: 'denyList',
			requiresAllowListMatch: normalizedAllowList.length > 0,
		};
	}

	if (normalizedAllowList.length > 0 && !normalizedAllowList.includes(commandName)) {
		return {
			commandName,
			deniedBy: 'allowList',
			requiresAllowListMatch: true,
		};
	}

	return {
		commandName,
		requiresAllowListMatch: normalizedAllowList.length > 0,
	};
}
