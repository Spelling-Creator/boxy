export const KINDS = ['notebook', 'sticky'] as const;
export type Kind = (typeof KINDS)[number];

export function isKind(value: unknown): value is Kind {
	return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

export const STICKY_LIMIT = 5;

export type Memory = {
	title: string;
	content: string;
	timestamp: string | null;
};

export type Todo = {
	id: string;
	title: string;
	description: string;
	completed: boolean;
	sourceRepoOwner: string | null;
	sourceRepoName: string | null;
	sourceIssueNumber: number | null;
	sourceInstallationId: number | null;
};
