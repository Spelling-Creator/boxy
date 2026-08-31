import { listAll } from '$lib/server/memories';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return { memories: await listAll() };
};
