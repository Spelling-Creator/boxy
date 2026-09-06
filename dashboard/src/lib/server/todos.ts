import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import type { Todo } from '$lib/types';

export type { Todo } from '$lib/types';

const DATA_DIR = env.BOXY_DATA_DIR
	? path.resolve(env.BOXY_DATA_DIR)
	: path.resolve(process.cwd(), '..');

const TODO_FILE = path.join(DATA_DIR, 'boxy_todo_list.json');

async function readRaw(): Promise<Record<string, unknown>> {
	try {
		const data = await fs.readFile(TODO_FILE, 'utf-8');
		const parsed = JSON.parse(data);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw err;
	}
}

async function writeRaw(value: Record<string, unknown>) {
	const tmp = `${TODO_FILE}.dashboard-${process.pid}-${Date.now()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
	await fs.rename(tmp, TODO_FILE);
}

function numberOrNull(value: unknown): number | null {
	const n = typeof value === 'string' ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

function toTodo(id: string, value: unknown): Todo {
	const entry = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
	return {
		id,
		title: typeof entry.title === 'string' ? entry.title : '',
		description: typeof entry.description === 'string' ? entry.description : '',
		completed: entry.completed === true,
		sourceRepoOwner: stringOrNull(entry.sourceRepoOwner),
		sourceRepoName: stringOrNull(entry.sourceRepoName),
		sourceIssueNumber: numberOrNull(entry.sourceIssueNumber),
		sourceInstallationId: numberOrNull(entry.sourceInstallationId)
	};
}

// Boxy's background queue takes the lowest numeric id first, so the dashboard
// lists them in that same order: this is the queue, not just a list.
export async function listTodos(): Promise<Todo[]> {
	const raw = await readRaw();
	return Object.entries(raw)
		.map(([id, value]) => toTodo(id, value))
		.sort((a, b) => Number(a.id) - Number(b.id));
}

function writeEntry(raw: Record<string, unknown>, todo: Todo) {
	raw[todo.id] = {
		title: todo.title,
		description: todo.description,
		completed: todo.completed,
		sourceRepoOwner: todo.sourceRepoOwner,
		sourceRepoName: todo.sourceRepoName,
		sourceIssueNumber: todo.sourceIssueNumber,
		sourceInstallationId: todo.sourceInstallationId
	};
}

export type SaveTodoInput = {
	id?: string;
	title: string;
	description: string;
	completed?: boolean;
	sourceRepoOwner?: string | null;
	sourceRepoName?: string | null;
	sourceIssueNumber?: number | null;
};

export async function saveTodo(input: SaveTodoInput): Promise<Todo> {
	const title = input.title.trim();
	if (!title) throw new Error('Title is required.');

	const raw = await readRaw();

	if (input.id) {
		if (!(input.id in raw)) throw new Error(`Task ${input.id} not found.`);
		// Keep the fields boxy owns (installation id, completion) unless the edit sets them.
		const existing = toTodo(input.id, raw[input.id]);
		const updated: Todo = {
			...existing,
			title,
			description: input.description,
			completed: input.completed ?? existing.completed,
			sourceRepoOwner:
				input.sourceRepoOwner === undefined ? existing.sourceRepoOwner : stringOrNull(input.sourceRepoOwner),
			sourceRepoName:
				input.sourceRepoName === undefined ? existing.sourceRepoName : stringOrNull(input.sourceRepoName),
			sourceIssueNumber:
				input.sourceIssueNumber === undefined
					? existing.sourceIssueNumber
					: numberOrNull(input.sourceIssueNumber)
		};
		writeEntry(raw, updated);
		await writeRaw(raw);
		return updated;
	}

	// Boxy keys tasks by Date.now(); step forward on the rare same-millisecond collision
	// so a new task never overwrites a queued one.
	let id = Date.now();
	while (String(id) in raw) id += 1;

	const created: Todo = {
		id: String(id),
		title,
		description: input.description,
		completed: input.completed ?? false,
		sourceRepoOwner: stringOrNull(input.sourceRepoOwner),
		sourceRepoName: stringOrNull(input.sourceRepoName),
		sourceIssueNumber: numberOrNull(input.sourceIssueNumber),
		sourceInstallationId: null
	};
	writeEntry(raw, created);
	await writeRaw(raw);
	return created;
}

export async function setTodoCompleted(id: string, completed: boolean): Promise<Todo> {
	const raw = await readRaw();
	if (!(id in raw)) throw new Error(`Task ${id} not found.`);
	const updated = { ...toTodo(id, raw[id]), completed };
	writeEntry(raw, updated);
	await writeRaw(raw);
	return updated;
}

export async function deleteTodo(id: string) {
	const raw = await readRaw();
	if (!(id in raw)) throw new Error(`Task ${id} not found.`);
	delete raw[id];
	await writeRaw(raw);
}

export async function clearCompletedTodos(): Promise<number> {
	const raw = await readRaw();
	let removed = 0;
	for (const [id, value] of Object.entries(raw)) {
		if (toTodo(id, value).completed) {
			delete raw[id];
			removed += 1;
		}
	}
	if (removed) await writeRaw(raw);
	return removed;
}
