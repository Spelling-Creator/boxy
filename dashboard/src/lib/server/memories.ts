import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import type { Kind, Memory } from '$lib/types';

export { KINDS, STICKY_LIMIT, isKind } from '$lib/types';
export type { Kind, Memory } from '$lib/types';

const DATA_DIR = env.BOXY_DATA_DIR
	? path.resolve(env.BOXY_DATA_DIR)
	: path.resolve(process.cwd(), '..');

const FILES: Record<Kind, string> = {
	notebook: 'boxy_notebook.json',
	sticky: 'boxy_sticky_notes.json'
};

function filePath(kind: Kind) {
	return path.join(DATA_DIR, FILES[kind]);
}

async function readRaw(kind: Kind): Promise<Record<string, unknown>> {
	try {
		const data = await fs.readFile(filePath(kind), 'utf-8');
		const parsed = JSON.parse(data);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw err;
	}
}

async function writeRaw(kind: Kind, value: Record<string, unknown>) {
	const target = filePath(kind);
	const tmp = `${target}.dashboard-${process.pid}-${Date.now()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
	await fs.rename(tmp, target);
}

function toMemory(kind: Kind, title: string, value: unknown): Memory {
	if (kind === 'sticky' && value && typeof value === 'object') {
		const entry = value as { content?: unknown; timestamp?: unknown };
		return {
			title,
			content: typeof entry.content === 'string' ? entry.content : '',
			timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null
		};
	}
	return { title, content: typeof value === 'string' ? value : String(value ?? ''), timestamp: null };
}

export async function listMemories(kind: Kind): Promise<Memory[]> {
	const raw = await readRaw(kind);
	const memories = Object.entries(raw).map(([title, value]) => toMemory(kind, title, value));
	if (kind === 'sticky') {
		return memories.sort(
			(a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime()
		);
	}
	return memories.sort((a, b) => a.title.localeCompare(b.title));
}

export async function listAll(): Promise<Record<Kind, Memory[]>> {
	const [notebook, sticky] = await Promise.all([listMemories('notebook'), listMemories('sticky')]);
	return { notebook, sticky };
}

export type SaveInput = {
	kind: Kind;
	title: string;
	content: string;
	originalTitle?: string;
};

export async function saveMemory({ kind, title, content, originalTitle }: SaveInput) {
	const trimmedTitle = title.trim();
	if (!trimmedTitle) throw new Error('Title is required.');

	const raw = await readRaw(kind);
	const previous = originalTitle?.trim();
	const isRename = previous && previous !== trimmedTitle;

	if (isRename) {
		if (trimmedTitle in raw) throw new Error(`A memory titled "${trimmedTitle}" already exists.`);
		delete raw[previous];
	}

	raw[trimmedTitle] =
		kind === 'sticky' ? { content, timestamp: new Date().toISOString() } : content;

	await writeRaw(kind, raw);
	return toMemory(kind, trimmedTitle, raw[trimmedTitle]);
}

export async function deleteMemory(kind: Kind, title: string) {
	const raw = await readRaw(kind);
	if (!(title in raw)) throw new Error(`Memory "${title}" not found.`);
	delete raw[title];
	await writeRaw(kind, raw);
}
