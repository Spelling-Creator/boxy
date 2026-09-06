import { error, json } from '@sveltejs/kit';
import {
	clearCompletedTodos,
	deleteTodo,
	listTodos,
	saveTodo,
	setTodoCompleted
} from '$lib/server/todos';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json({ todos: await listTodos() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body) error(400, 'Invalid request body.');
	if (typeof body.title !== 'string' || typeof body.description !== 'string') {
		error(400, 'Title and description are required.');
	}
	if (body.id !== undefined && typeof body.id !== 'string') error(400, 'Invalid task id.');

	try {
		const todo = await saveTodo({
			id: body.id,
			title: body.title,
			description: body.description,
			completed: typeof body.completed === 'boolean' ? body.completed : undefined,
			sourceRepoOwner: body.sourceRepoOwner,
			sourceRepoName: body.sourceRepoName,
			sourceIssueNumber: body.sourceIssueNumber
		});
		return json({ todo, todos: await listTodos() });
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'Could not save task.');
	}
};

export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body.id !== 'string') error(400, 'Task id is required.');
	if (typeof body.completed !== 'boolean') error(400, 'A completed flag is required.');

	try {
		const todo = await setTodoCompleted(body.id, body.completed);
		return json({ todo, todos: await listTodos() });
	} catch (err) {
		error(404, err instanceof Error ? err.message : 'Could not update task.');
	}
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body) error(400, 'Invalid request body.');

	try {
		if (body.completed === true && body.id === undefined) {
			const removed = await clearCompletedTodos();
			return json({ removed, todos: await listTodos() });
		}
		if (typeof body.id !== 'string') error(400, 'Task id is required.');
		await deleteTodo(body.id);
		return json({ todos: await listTodos() });
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		error(404, err instanceof Error ? err.message : 'Could not delete task.');
	}
};
