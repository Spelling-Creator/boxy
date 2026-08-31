<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { toggleMode } from 'mode-watcher';
	import BookText from '@lucide/svelte/icons/book-text';
	import Moon from '@lucide/svelte/icons/moon';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Search from '@lucide/svelte/icons/search';
	import StickyNote from '@lucide/svelte/icons/sticky-note';
	import Sun from '@lucide/svelte/icons/sun';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { STICKY_LIMIT, type Kind, type Memory } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const TABS: { kind: Kind; label: string; blurb: string; icon: typeof BookText }[] = [
		{
			kind: 'notebook',
			label: 'Notebook',
			blurb: "Long-term memories: project rules, workflows, and PR audits boxy keeps for good.",
			icon: BookText
		},
		{
			kind: 'sticky',
			label: 'Sticky notes',
			blurb: `Short-term working memory. Boxy only keeps the ${STICKY_LIMIT} most recent notes.`,
			icon: StickyNote
		}
	];

	// Every mutation returns the full set, so we hold it as an override on top of
	// the server load rather than round-tripping through invalidate().
	let overrides = $state<Record<Kind, Memory[]> | null>(null);
	const memories = $derived(overrides ?? data.memories);
	// Tabs.Root works in plain strings; `kind` narrows it back for the rest of the page.
	let activeTab = $state<string>('notebook');
	const kind = $derived(activeTab as Kind);
	let query = $state('');
	let busy = $state(false);

	// Editor dialog state. `original` is null for a new memory.
	let editorOpen = $state(false);
	let original = $state<Memory | null>(null);
	let draftTitle = $state('');
	let draftContent = $state('');

	let pendingDelete = $state<Memory | null>(null);

	const active = $derived(TABS.find((t) => t.kind === kind)!);
	function filtered(of: Kind) {
		const q = query.trim().toLowerCase();
		const list = memories[of];
		if (!q) return list;
		return list.filter(
			(m) => m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)
		);
	}

	function openNew() {
		original = null;
		draftTitle = '';
		draftContent = '';
		editorOpen = true;
	}

	function openEdit(memory: Memory) {
		original = memory;
		draftTitle = memory.title;
		draftContent = memory.content;
		editorOpen = true;
	}

	async function send(method: 'POST' | 'DELETE', body: unknown) {
		const res = await fetch('/api/memories', {
			method,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			const detail = await res.json().catch(() => null);
			throw new Error(detail?.message ?? `Request failed (${res.status})`);
		}
		return res.json();
	}

	async function save() {
		if (!draftTitle.trim()) {
			toast.error('Give the memory a title.');
			return;
		}
		busy = true;
		try {
			const result = await send('POST', {
				kind,
				title: draftTitle,
				content: draftContent,
				originalTitle: original?.title
			});
			overrides = result.memories;
			editorOpen = false;
			toast.success(original ? 'Memory updated.' : 'Memory saved.');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not save memory.');
		} finally {
			busy = false;
		}
	}

	async function confirmDelete() {
		if (!pendingDelete) return;
		busy = true;
		try {
			const result = await send('DELETE', { kind, title: pendingDelete.title });
			overrides = result.memories;
			toast.success(`Deleted "${pendingDelete.title}".`);
			pendingDelete = null;
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not delete memory.');
		} finally {
			busy = false;
		}
	}

	async function refresh() {
		busy = true;
		try {
			const res = await fetch('/api/memories');
			if (!res.ok) throw new Error(`Request failed (${res.status})`);
			overrides = await res.json();
			toast.success('Reloaded from disk.');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not reload memories.');
		} finally {
			busy = false;
		}
	}

	function formatTime(iso: string | null) {
		if (!iso) return null;
		const date = new Date(iso);
		return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
	}
</script>

<div class="bg-background min-h-svh">
	<header class="border-b">
		<div class="mx-auto flex max-w-5xl items-center gap-4 px-6 py-5">
			<div class="flex-1">
				<h1 class="text-xl font-semibold tracking-tight">Boxy memories</h1>
				<p class="text-muted-foreground text-sm">
					{memories.notebook.length} notebook {memories.notebook.length === 1 ? 'entry' : 'entries'}
					· {memories.sticky.length} sticky {memories.sticky.length === 1 ? 'note' : 'notes'}
				</p>
			</div>
			<Button variant="outline" size="icon" onclick={refresh} disabled={busy} title="Reload from disk">
				<RefreshCw />
			</Button>
			<Button variant="outline" size="icon" onclick={toggleMode} title="Toggle theme">
				<Sun class="dark:hidden" />
				<Moon class="hidden dark:block" />
			</Button>
		</div>
	</header>

	<main class="mx-auto max-w-5xl px-6 py-8">
		<Tabs.Root bind:value={activeTab}>
			<div class="flex flex-wrap items-center gap-3">
				<Tabs.List>
					{#each TABS as tab (tab.kind)}
						<Tabs.Trigger value={tab.kind}>
							<tab.icon class="size-4" />
							{tab.label}
							<Badge variant="secondary">{memories[tab.kind].length}</Badge>
						</Tabs.Trigger>
					{/each}
				</Tabs.List>

				<div class="relative ml-auto w-full sm:w-64">
					<Search
						class="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
					/>
					<Input placeholder="Search memories…" class="pl-9" bind:value={query} />
				</div>
				<Button onclick={openNew}>
					<Plus />
					New memory
				</Button>
			</div>

			<p class="text-muted-foreground mt-4 text-sm">{active.blurb}</p>

			{#if kind === 'sticky' && memories.sticky.length > STICKY_LIMIT}
				<p class="text-destructive mt-2 text-sm">
					There are more than {STICKY_LIMIT} sticky notes on disk — boxy will trim the oldest ones
					the next time it saves one.
				</p>
			{/if}

			{#each TABS as tab (tab.kind)}
				<Tabs.Content value={tab.kind} class="mt-6">
					{@const visible = filtered(tab.kind)}
					{#if visible.length === 0}
						<div class="rounded-lg border border-dashed py-16 text-center">
							<p class="text-muted-foreground text-sm">
								{query.trim()
									? `No memories match “${query}”.`
									: `No ${tab.label.toLowerCase()} yet.`}
							</p>
						</div>
					{:else}
						<div class="grid gap-4 sm:grid-cols-2">
							{#each visible as memory (memory.title)}
								<Card.Root class="flex flex-col">
									<Card.Header>
										<Card.Title class="text-base break-words">{memory.title}</Card.Title>
										{#if formatTime(memory.timestamp)}
											<Card.Description>{formatTime(memory.timestamp)}</Card.Description>
										{/if}
									</Card.Header>
									<Card.Content class="flex-1">
										<p
											class="text-muted-foreground line-clamp-6 text-sm whitespace-pre-wrap break-words"
										>
											{memory.content || '(empty)'}
										</p>
									</Card.Content>
									<Card.Footer class="gap-2">
										<Button variant="outline" size="sm" onclick={() => openEdit(memory)}>
											<Pencil />
											Edit
										</Button>
										<Button
											variant="ghost"
											size="sm"
											class="text-destructive hover:text-destructive"
											onclick={() => (pendingDelete = memory)}
										>
											<Trash2 />
											Delete
										</Button>
									</Card.Footer>
								</Card.Root>
							{/each}
						</div>
					{/if}
				</Tabs.Content>
			{/each}
		</Tabs.Root>
	</main>
</div>

<Dialog.Root bind:open={editorOpen}>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{original ? 'Edit memory' : 'New memory'}</Dialog.Title>
			<Dialog.Description>
				Saved to boxy's {active.label.toLowerCase()} on disk. The title is the key boxy reads it
				back by.
			</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-4">
			<div class="grid gap-2">
				<Label for="memory-title">Title</Label>
				<Input id="memory-title" bind:value={draftTitle} placeholder="PR #123 Repo: org/repo …" />
			</div>
			<div class="grid gap-2">
				<Label for="memory-content">Content</Label>
				<Textarea
					id="memory-content"
					bind:value={draftContent}
					rows={14}
					placeholder="What boxy should remember…"
				/>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (editorOpen = false)} disabled={busy}>Cancel</Button>
			<Button onclick={save} disabled={busy}>Save</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root
	open={pendingDelete !== null}
	onOpenChange={(open) => {
		if (!open) pendingDelete = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete this memory?</AlertDialog.Title>
			<AlertDialog.Description>
				“{pendingDelete?.title}” will be removed from boxy's {active.label.toLowerCase()}. This
				can't be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={busy}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={confirmDelete} disabled={busy}>Delete</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
