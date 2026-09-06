import { listAll } from '$lib/server/memories';
import { listTodos } from '$lib/server/todos';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [memories, todos] = await Promise.all([listAll(), listTodos()]);
	return { memories, todos };
};
