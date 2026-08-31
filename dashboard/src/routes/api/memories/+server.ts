import { error, json } from '@sveltejs/kit';
import { deleteMemory, listAll, saveMemory } from '$lib/server/memories';
import { isKind } from '$lib/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json(await listAll());
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || !isKind(body.kind)) error(400, 'Unknown memory kind.');
	if (typeof body.title !== 'string' || typeof body.content !== 'string') {
		error(400, 'Title and content are required.');
	}

	try {
		const memory = await saveMemory({
			kind: body.kind,
			title: body.title,
			content: body.content,
			originalTitle: typeof body.originalTitle === 'string' ? body.originalTitle : undefined
		});
		return json({ memory, memories: await listAll() });
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'Could not save memory.');
	}
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || !isKind(body.kind)) error(400, 'Unknown memory kind.');
	if (typeof body.title !== 'string') error(400, 'Title is required.');

	try {
		await deleteMemory(body.kind, body.title);
		return json({ memories: await listAll() });
	} catch (err) {
		error(404, err instanceof Error ? err.message : 'Could not delete memory.');
	}
};
