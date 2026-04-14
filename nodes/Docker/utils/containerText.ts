import { posix } from 'node:path';
import { TextDecoder } from 'node:util';

export interface ResolvedContainerFilePath {
	fileName: string;
	requestedPath: string;
	resolvedPath: string;
	targetPath: string;
	workingPath: string;
}

export interface ContainerTextReadResult {
	content: string;
	fileByteCount: number;
	hasMoreAfter: boolean;
	hasMoreBefore: boolean;
	lineEnd: number | null;
	lineStart: number | null;
	requestedEndLine: number | null;
	requestedStartLine: number | null;
	returnedLineCount: number;
	totalLineCount: number;
}

export interface ContainerListFileEntry {
	absolutePath: string;
	entryType: 'directory' | 'file' | 'other';
	path: string;
}

export interface ContainerSearchTextMatch {
	absolutePath: string;
	line: number;
	path: string;
	text: string;
}

export interface ExactTextReplacementResult {
	matchCount: number;
	updatedText?: string;
}

interface NormalizedContainerTextView {
	normalizedText: string;
	normalizedToRawOffsets: number[];
}

const pathNotFoundPrefix = '__ERROR__\tPATH_NOT_FOUND\t';
const utf8TextDecoder = new TextDecoder('utf-8', { fatal: true });

export const LIST_FILES_SHELL_SCRIPT = `root="\${LIST_ROOT:-/}"
max_depth="\${MAX_DEPTH:-4}"
glob="\${GLOB:-}"
include_hidden="\${INCLUDE_HIDDEN:-false}"
max_entries="\${MAX_ENTRIES:-0}"

if [ ! -e "$root" ]; then
  printf '__ERROR__\\tPATH_NOT_FOUND\\t%s\\n' "$root"
  exit 0
fi

command -v find >/dev/null 2>&1 || { printf 'find is required for listFiles\\n' >&2; exit 127; }
command -v sed >/dev/null 2>&1 || { printf 'sed is required for listFiles\\n' >&2; exit 127; }
command -v sort >/dev/null 2>&1 || { printf 'sort is required for listFiles\\n' >&2; exit 127; }

should_include_relative_path() {
  relative_path="$1"

  if [ "$include_hidden" = "true" ]; then
    return 0
  fi

  case "$relative_path" in
    .*|*/.*) return 1 ;;
  esac

  return 0
}

list_paths() {
  if [ -n "$glob" ]; then
    find "$root" -mindepth 1 -maxdepth "$max_depth" -name "$glob" -print
  else
    find "$root" -mindepth 1 -maxdepth "$max_depth" -print
  fi
}

emit_entries() {
  list_paths | sort | while IFS= read -r path; do
    if [ "$root" = "/" ]; then
      relative_path="\${path#/}"
    else
      relative_path="\${path#"$root"/}"
    fi

    should_include_relative_path "$relative_path" || continue

    if [ -d "$path" ]; then
      entry_type="directory"
    elif [ -f "$path" ]; then
      entry_type="file"
    else
      entry_type="other"
    fi

    printf '%s\\t%s\\n' "$entry_type" "$relative_path"
  done
}

if [ "$max_entries" -gt 0 ]; then
  emit_entries | sed -n "1,\${max_entries}p"
else
  emit_entries
fi`;

export const SEARCH_TEXT_SHELL_SCRIPT = `root="\${SEARCH_ROOT:-/}"
query="\${QUERY:-}"
glob="\${GLOB:-}"
case_sensitive="\${CASE_SENSITIVE:-false}"
max_matches="\${MAX_MATCHES:-0}"

if [ ! -e "$root" ]; then
  printf '__ERROR__\\tPATH_NOT_FOUND\\t%s\\n' "$root"
  exit 0
fi

if [ -z "$query" ]; then
  printf 'query is required for searchText\\n' >&2
  exit 64
fi

run_search_with_limit() {
  if [ "$max_matches" -le 0 ]; then
    "$@"
    return $?
  fi

  command -v mkfifo >/dev/null 2>&1 || { printf 'mkfifo is required for searchText limit handling\\n' >&2; return 127; }

  fifo_dir="\${TMPDIR:-/tmp}"
  fifo_path="$fifo_dir/n8n-search.$$.fifo"
  attempt=0

  while [ -e "$fifo_path" ]; do
    attempt=$((attempt + 1))
    fifo_path="$fifo_dir/n8n-search.$$.$attempt.fifo"
  done

  mkfifo "$fifo_path" || { printf 'mkfifo is required for searchText limit handling\\n' >&2; return 127; }

  line_count=0
  limit_reached=false

  "$@" >"$fifo_path" &
  backend_pid=$!

  while IFS= read -r line; do
    printf '%s\\n' "$line"
    line_count=$((line_count + 1))

    if [ "$line_count" -ge "$max_matches" ]; then
      limit_reached=true
      break
    fi
  done <"$fifo_path"

  if [ "$limit_reached" = "true" ]; then
    kill "$backend_pid" 2>/dev/null || true
  fi

  wait "$backend_pid"
  backend_rc=$?
  rm -f "$fifo_path"

  if [ "$limit_reached" = "true" ]; then
    case "$backend_rc" in
      0|141|143) return 0 ;;
    esac
  fi

  return "$backend_rc"
}

search_with_rg() {
  if [ "$case_sensitive" = "true" ]; then
    if [ -n "$glob" ]; then
      rg --hidden --no-heading --with-filename --line-number --color never --no-ignore -F -g "$glob" -- "$query" "$root"
    else
      rg --hidden --no-heading --with-filename --line-number --color never --no-ignore -F -- "$query" "$root"
    fi
  else
    if [ -n "$glob" ]; then
      rg --hidden --no-heading --with-filename --line-number --color never --no-ignore -i -F -g "$glob" -- "$query" "$root"
    else
      rg --hidden --no-heading --with-filename --line-number --color never --no-ignore -i -F -- "$query" "$root"
    fi
  fi
}

search_with_grep() {
  if [ "$case_sensitive" = "true" ]; then
    if [ -n "$glob" ]; then
      find "$root" -type f -name "$glob" -exec grep -nH -F -- "$query" {} +
    else
      grep -R -nH -F -- "$query" "$root"
    fi
  else
    if [ -n "$glob" ]; then
      find "$root" -type f -name "$glob" -exec grep -nH -i -F -- "$query" {} +
    else
      grep -R -nH -i -F -- "$query" "$root"
    fi
  fi
}

if command -v rg >/dev/null 2>&1; then
  run_search_with_limit search_with_rg
elif command -v grep >/dev/null 2>&1; then
  command -v find >/dev/null 2>&1 || { printf 'find is required for searchText glob filtering\\n' >&2; exit 127; }
  run_search_with_limit search_with_grep
else
  printf 'rg or grep is required for searchText\\n' >&2
  exit 127
fi`;

export function normalizeContainerPath(input: string): string {
	const raw = String(input).trim().replace(/\\/g, '/');

	if (raw === '') {
		return '';
	}

	const isAbsolute = raw.startsWith('/');
	const parts: string[] = [];

	for (const segment of raw.split('/')) {
		if (segment === '' || segment === '.') {
			continue;
		}

		if (segment === '..') {
			if (parts.length > 0) {
				parts.pop();
			}

			continue;
		}

		parts.push(segment);
	}

	const normalized = `${isAbsolute ? '/' : ''}${parts.join('/')}`;

	if (normalized === '') {
		return isAbsolute ? '/' : '.';
	}

	return normalized;
}

export function resolveContainerFilePath(
	filePath: string,
	workingPathInput: string,
): ResolvedContainerFilePath {
	const requestedPath = String(filePath).trim();
	const workingPath = normalizeContainerPath(String(workingPathInput).trim() || '/');
	let resolvedPath = '';

	if (requestedPath.startsWith('/')) {
		resolvedPath = normalizeContainerPath(requestedPath);
	} else if (requestedPath !== '') {
		resolvedPath = normalizeContainerPath(
			`${workingPath.replace(/\/+$/, '')}/${requestedPath}`,
		);
	}

	return {
		fileName: getContainerBaseName(resolvedPath),
		requestedPath,
		resolvedPath,
		targetPath: getContainerDirName(resolvedPath),
		workingPath,
	};
}

export function getContainerDirName(pathValue: string): string {
	const normalized = normalizeContainerPath(pathValue);

	if (normalized === '/' || normalized === '') {
		return '/';
	}

	const trimmed = normalized.endsWith('/') && normalized !== '/' ? normalized.slice(0, -1) : normalized;
	const index = trimmed.lastIndexOf('/');

	if (index <= 0) {
		return '/';
	}

	return trimmed.slice(0, index);
}

export function getContainerBaseName(pathValue: string): string {
	const normalized = normalizeContainerPath(pathValue);

	if (normalized === '/' || normalized === '') {
		return '';
	}

	const trimmed = normalized.endsWith('/') && normalized !== '/' ? normalized.slice(0, -1) : normalized;
	const index = trimmed.lastIndexOf('/');

	return index === -1 ? trimmed : trimmed.slice(index + 1);
}

export function normalizeContainerText(text: string): string {
	return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function decodeRawContainerTextBuffer(buffer: Buffer): string {
	if (buffer.includes(0)) {
		throw new Error('BINARY_FILE_NOT_SUPPORTED');
	}

	try {
		return utf8TextDecoder.decode(buffer);
	} catch {
		throw new Error('INVALID_UTF8_TEXT');
	}
}

export function decodeContainerTextBuffer(buffer: Buffer): string {
	return normalizeContainerText(decodeRawContainerTextBuffer(buffer));
}

export function readContainerText(
	buffer: Buffer,
	options?: {
		endLine?: number;
		startLine?: number;
	},
): ContainerTextReadResult {
	const text = decodeContainerTextBuffer(buffer);
	const allLines = text.split('\n');

	if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
		allLines.pop();
	}

	const requestedStartLine = options?.startLine ?? null;
	const requestedEndLine = options?.endLine ?? null;
	const effectiveStartLine = requestedStartLine ?? 1;
	const effectiveEndLine = requestedEndLine ?? allLines.length;
	const selectedLines =
		effectiveStartLine <= allLines.length
			? allLines.slice(effectiveStartLine - 1, effectiveEndLine)
			: [];
	const lineStart = selectedLines.length > 0 ? effectiveStartLine : null;
	const lineEnd =
		selectedLines.length > 0 ? effectiveStartLine + selectedLines.length - 1 : null;

	return {
		content: selectedLines.join('\n'),
		fileByteCount: buffer.length,
		hasMoreAfter: lineEnd != null ? lineEnd < allLines.length : false,
		hasMoreBefore: lineStart != null ? lineStart > 1 : false,
		lineEnd,
		lineStart,
		requestedEndLine,
		requestedStartLine,
		returnedLineCount: selectedLines.length,
		totalLineCount: allLines.length,
	};
}

export function replaceExactContainerText(
	currentText: string,
	oldText: string,
	newText: string,
): ExactTextReplacementResult {
	const normalizedOldText = normalizeContainerText(oldText);

	if (normalizedOldText === '') {
		return { matchCount: 0 };
	}

	const normalizedView = buildNormalizedContainerTextView(currentText);
	const { matchCount, matchIndex } = countExactTextMatches(
		normalizedView.normalizedText,
		normalizedOldText,
	);

	if (matchCount !== 1) {
		return { matchCount };
	}

	const rawStart = normalizedView.normalizedToRawOffsets[matchIndex];
	const rawEnd =
		normalizedView.normalizedToRawOffsets[matchIndex + normalizedOldText.length];
	const lineEnding = detectConsistentContainerLineEnding(currentText);
	const replacementText = adaptReplacementLineEndings(newText, lineEnding);

	return {
		matchCount,
		updatedText: `${currentText.slice(0, rawStart)}${replacementText}${currentText.slice(rawEnd)}`,
	};
}

export function parseListFilesOutput(
	stdout: string,
	workingPath: string,
): { entries: ContainerListFileEntry[]; pathNotFound: string | null } {
	const lines = normalizeContainerText(stdout)
		.split('\n')
		.filter((line) => line !== '');

	if (lines[0]?.startsWith(pathNotFoundPrefix)) {
		return {
			entries: [],
			pathNotFound: lines[0].slice(pathNotFoundPrefix.length),
		};
	}

	const entries: ContainerListFileEntry[] = [];

	for (const line of lines) {
		const [entryType, relativePath] = line.split('\t');

		if (
			(entryType !== 'directory' && entryType !== 'file' && entryType !== 'other') ||
			relativePath === undefined ||
			relativePath === ''
		) {
			continue;
		}

		entries.push({
			absolutePath: toAbsoluteContainerPath(workingPath, relativePath),
			entryType,
			path: relativePath,
		});
	}

	return {
		entries,
		pathNotFound: null,
	};
}

export function parseSearchTextOutput(
	stdout: string,
	workingPath: string,
): { matches: ContainerSearchTextMatch[]; pathNotFound: string | null } {
	const lines = normalizeContainerText(stdout)
		.split('\n')
		.filter((line) => line !== '');

	if (lines[0]?.startsWith(pathNotFoundPrefix)) {
		return {
			matches: [],
			pathNotFound: lines[0].slice(pathNotFoundPrefix.length),
		};
	}

	const matches: ContainerSearchTextMatch[] = [];

	for (const line of lines) {
		const match = line.match(/^(.*?):(\d+):(.*)$/);

		if (match === null) {
			continue;
		}

		const absolutePath = match[1];

		matches.push({
			absolutePath,
			line: Number(match[2]),
			path: toRelativeContainerPath(workingPath, absolutePath),
			text: match[3],
		});
	}

	return {
		matches,
		pathNotFound: null,
	};
}

function toAbsoluteContainerPath(workingPath: string, relativePath: string): string {
	if (workingPath === '/') {
		return normalizeContainerPath(`/${relativePath.replace(/^\/+/, '')}`);
	}

	return normalizeContainerPath(posix.join(workingPath, relativePath));
}

function toRelativeContainerPath(workingPath: string, absolutePath: string): string {
	if (absolutePath === '') {
		return absolutePath;
	}

	if (workingPath === '/') {
		return absolutePath.startsWith('/') ? absolutePath.slice(1) : absolutePath;
	}

	if (absolutePath === workingPath) {
		return '.';
	}

	const prefix = workingPath.endsWith('/') ? workingPath : `${workingPath}/`;

	return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

function buildNormalizedContainerTextView(rawText: string): NormalizedContainerTextView {
	const normalizedToRawOffsets = [0];
	const normalizedCharacters: string[] = [];
	let rawIndex = 0;

	while (rawIndex < rawText.length) {
		const character = rawText[rawIndex];

		if (character === '\r') {
			if (rawText[rawIndex + 1] === '\n') {
				rawIndex += 2;
			} else {
				rawIndex += 1;
			}

			normalizedCharacters.push('\n');
			normalizedToRawOffsets.push(rawIndex);
			continue;
		}

		rawIndex += 1;
		normalizedCharacters.push(character);
		normalizedToRawOffsets.push(rawIndex);
	}

	return {
		normalizedText: normalizedCharacters.join(''),
		normalizedToRawOffsets,
	};
}

function countExactTextMatches(
	text: string,
	query: string,
): {
	matchCount: number;
	matchIndex: number;
} {
	let matchCount = 0;
	let matchIndex = -1;
	let searchFrom = 0;

	while (searchFrom <= text.length) {
		const foundAt = text.indexOf(query, searchFrom);

		if (foundAt === -1) {
			break;
		}

		matchCount += 1;

		if (matchIndex === -1) {
			matchIndex = foundAt;
		}

		searchFrom = foundAt + query.length;
	}

	return {
		matchCount,
		matchIndex,
	};
}

function detectConsistentContainerLineEnding(text: string): '\n' | '\r' | '\r\n' | undefined {
	const lineEndings = text.match(/\r\n|\r|\n/g);

	if (lineEndings === null || lineEndings.length === 0) {
		return undefined;
	}

	const [firstLineEnding] = lineEndings;

	if (!lineEndings.every((lineEnding) => lineEnding === firstLineEnding)) {
		return undefined;
	}

	if (firstLineEnding === '\n' || firstLineEnding === '\r' || firstLineEnding === '\r\n') {
		return firstLineEnding;
	}

	return undefined;
}

function adaptReplacementLineEndings(
	text: string,
	lineEnding: '\n' | '\r' | '\r\n' | undefined,
): string {
	if (lineEnding === undefined) {
		return text;
	}

	return normalizeContainerText(text).replace(/\n/g, lineEnding);
}
