<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { toggleMode } from 'mode-watcher';
	import BookText from '@lucide/svelte/icons/book-text';
	import Circle from '@lucide/svelte/icons/circle';
	import CircleCheckBig from '@lucide/svelte/icons/circle-check-big';
	import ListTodo from '@lucide/svelte/icons/list-todo';
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
	import { STICKY_LIMIT, type Kind, type Memory, type Todo } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const TODO_TAB = 'todos';

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
	let todoOverrides = $state<Todo[] | null>(null);
	const todos = $derived(todoOverrides ?? data.todos);
	const pendingTodos = $derived(todos.filter((t) => !t.completed));
	// Tabs.Root works in plain strings; `kind` narrows it back for the rest of the page.
	let activeTab = $state<string>('notebook');
	const onTodos = $derived(activeTab === TODO_TAB);
	const kind = $derived(activeTab as Kind);
	let query = $state('');
	let busy = $state(false);

	// Editor dialog state. `original` is null for a new memory.
	let editorOpen = $state(false);
	let original = $state<Memory | null>(null);
	let draftTitle = $state('');
	let draftContent = $state('');

	let pendingDelete = $state<Memory | null>(null);

	// The to-do editor is separate: tasks carry the repo context boxy needs to work them.
	let todoEditorOpen = $state(false);
	let originalTodo = $state<Todo | null>(null);
	let todoTitle = $state('');
	let todoDescription = $state('');
	let todoRepo = $state('');
	let todoIssue = $state('');

	let pendingTodoDelete = $state<Todo | null>(null);
	let clearCompletedOpen = $state(false);

	// Falls back to the first tab so the memory dialogs still read sanely while the
	// to-do tab is the active one.
	const active = $derived(TABS.find((t) => t.kind === kind) ?? TABS[0]);
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

	function filteredTodos() {
		const q = query.trim().toLowerCase();
		if (!q) return todos;
		return todos.filter(
			(t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
		);
	}

	function repoOf(todo: Todo) {
		return todo.sourceRepoOwner && todo.sourceRepoName
			? `${todo.sourceRepoOwner}/${todo.sourceRepoName}`
			: '';
	}

	function openNewTodo() {
		originalTodo = null;
		todoTitle = '';
		todoDescription = '';
		todoRepo = '';
		todoIssue = '';
		todoEditorOpen = true;
	}

	function openEditTodo(todo: Todo) {
		originalTodo = todo;
		todoTitle = todo.title;
		todoDescription = todo.description;
		todoRepo = repoOf(todo);
		todoIssue = todo.sourceIssueNumber === null ? '' : String(todo.sourceIssueNumber);
		todoEditorOpen = true;
	}

	async function sendTodo(method: 'POST' | 'PATCH' | 'DELETE', body: unknown) {
		const res = await fetch('/api/todos', {
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

	async function saveTodo() {
		if (!todoTitle.trim()) {
			toast.error('Give the task a title.');
			return;
		}
		const repo = todoRepo.trim();
		if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
			toast.error('Repository must look like owner/name.');
			return;
		}
		const issue = todoIssue.trim();
		if (issue && !/^\d+$/.test(issue)) {
			toast.error('Issue or PR number must be a number.');
			return;
		}
		const [owner, name] = repo ? repo.split('/') : [null, null];

		busy = true;
		try {
			const result = await sendTodo('POST', {
				id: originalTodo?.id,
				title: todoTitle,
				description: todoDescription,
				sourceRepoOwner: owner,
				sourceRepoName: name,
				sourceIssueNumber: issue ? Number(issue) : null
			});
			todoOverrides = result.todos;
			todoEditorOpen = false;
			toast.success(originalTodo ? 'Task updated.' : 'Task queued for boxy.');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not save task.');
		} finally {
			busy = false;
		}
	}

	async function toggleTodo(todo: Todo) {
		busy = true;
		try {
			const result = await sendTodo('PATCH', { id: todo.id, completed: !todo.completed });
			todoOverrides = result.todos;
			toast.success(todo.completed ? 'Task reopened.' : 'Task marked done.');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not update task.');
		} finally {
			busy = false;
		}
	}

	async function confirmTodoDelete() {
		if (!pendingTodoDelete) return;
		busy = true;
		try {
			const result = await sendTodo('DELETE', { id: pendingTodoDelete.id });
			todoOverrides = result.todos;
			toast.success(`Deleted "${pendingTodoDelete.title}".`);
			pendingTodoDelete = null;
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not delete task.');
		} finally {
			busy = false;
		}
	}

	async function confirmClearCompleted() {
		busy = true;
		try {
			const result = await sendTodo('DELETE', { completed: true });
			todoOverrides = result.todos;
			clearCompletedOpen = false;
			toast.success(
				result.removed === 1 ? 'Cleared 1 finished task.' : `Cleared ${result.removed} finished tasks.`
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not clear finished tasks.');
		} finally {
			busy = false;
		}
	}

	async function refresh() {
		busy = true;
		try {
			const [memoryRes, todoRes] = await Promise.all([
				fetch('/api/memories'),
				fetch('/api/todos')
			]);
			if (!memoryRes.ok) throw new Error(`Request failed (${memoryRes.status})`);
			if (!todoRes.ok) throw new Error(`Request failed (${todoRes.status})`);
			overrides = await memoryRes.json();
			todoOverrides = (await todoRes.json()).todos;
			toast.success('Reloaded from disk.');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not reload from disk.');
		} finally {
			busy = false;
		}
	}

	function formatTime(iso: string | null) {
		if (!iso) return null;
		const date = new Date(iso);
		return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
	}

	function queuedAt(id: string) {
		const date = new Date(Number(id));
		return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
	}
</script>

<div class="bg-background min-h-svh">
	<header class="border-b">
		<div class="mx-auto flex max-w-5xl items-center gap-4 px-6 py-5">
			<div class="flex-1">
				<h1 class="text-xl font-semibold tracking-tight">Boxy dashboard</h1>
				<p class="text-muted-foreground text-sm">
					{memories.notebook.length} notebook {memories.notebook.length === 1 ? 'entry' : 'entries'}
					· {memories.sticky.length} sticky {memories.sticky.length === 1 ? 'note' : 'notes'}
					· {pendingTodos.length} task{pendingTodos.length === 1 ? '' : 's'} queued
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
					<Tabs.Trigger value={TODO_TAB}>
						<ListTodo class="size-4" />
						To-do
						<Badge variant="secondary">{pendingTodos.length}</Badge>
					</Tabs.Trigger>
				</Tabs.List>

				<div class="relative ml-auto w-full sm:w-64">
					<Search
						class="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
					/>
					<Input
						placeholder={onTodos ? 'Search tasks…' : 'Search memories…'}
						class="pl-9"
						bind:value={query}
					/>
				</div>
				{#if onTodos}
					<Button onclick={openNewTodo}>
						<Plus />
						New task
					</Button>
				{:else}
					<Button onclick={openNew}>
						<Plus />
						New memory
					</Button>
				{/if}
			</div>

			<p class="text-muted-foreground mt-4 text-sm">
				{onTodos
					? "Boxy's background queue. It works the oldest unfinished task first, so anything you add here it will actually go and do."
					: active.blurb}
			</p>

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

			<Tabs.Content value={TODO_TAB} class="mt-6">
				{@const visible = filteredTodos()}
				{#if todos.some((t) => t.completed)}
					<div class="mb-4 flex justify-end">
						<Button variant="outline" size="sm" onclick={() => (clearCompletedOpen = true)}>
							<Trash2 />
							Clear finished
						</Button>
					</div>
				{/if}

				{#if visible.length === 0}
					<div class="rounded-lg border border-dashed py-16 text-center">
						<p class="text-muted-foreground text-sm">
							{query.trim() ? `No tasks match “${query}”.` : 'Nothing on the to-do list.'}
						</p>
					</div>
				{:else}
					<div class="flex flex-col gap-4">
						{#each visible as todo (todo.id)}
							<Card.Root class={todo.completed ? 'opacity-60' : ''}>
								<Card.Header>
									<div class="flex items-start gap-3">
										<Button
											variant="ghost"
											size="icon"
											class="mt-0.5 shrink-0"
											disabled={busy}
											onclick={() => toggleTodo(todo)}
											title={todo.completed ? 'Reopen task' : 'Mark as done'}
										>
											{#if todo.completed}
												<CircleCheckBig class="text-muted-foreground" />
											{:else}
												<Circle />
											{/if}
										</Button>
										<div class="min-w-0 flex-1">
											<Card.Title
												class="text-base break-words {todo.completed ? 'line-through' : ''}"
											>
												{todo.title || '(untitled task)'}
											</Card.Title>
											<Card.Description class="flex flex-wrap items-center gap-2 pt-1">
												{#if todo.completed}
													<Badge variant="secondary">Done</Badge>
												{:else if todo.id === pendingTodos[0]?.id}
													<Badge>Next up</Badge>
												{/if}
												{#if repoOf(todo)}
													<span class="font-mono text-xs">{repoOf(todo)}</span>
												{/if}
												{#if todo.sourceIssueNumber !== null}
													<span class="font-mono text-xs">#{todo.sourceIssueNumber}</span>
												{/if}
												{#if queuedAt(todo.id)}
													<span class="text-xs">Queued {queuedAt(todo.id)}</span>
												{/if}
											</Card.Description>
										</div>
									</div>
								</Card.Header>
								<Card.Content>
									<p
										class="text-muted-foreground line-clamp-6 text-sm whitespace-pre-wrap break-words"
									>
										{todo.description || '(no description)'}
									</p>
								</Card.Content>
								<Card.Footer class="gap-2">
									<Button variant="outline" size="sm" onclick={() => openEditTodo(todo)}>
										<Pencil />
										Edit
									</Button>
									<Button
										variant="ghost"
										size="sm"
										class="text-destructive hover:text-destructive"
										onclick={() => (pendingTodoDelete = todo)}
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

<Dialog.Root bind:open={todoEditorOpen}>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{originalTodo ? 'Edit task' : 'New task'}</Dialog.Title>
			<Dialog.Description>
				Boxy picks this up in the background with no thread context, so put everything it needs to
				know in the description.
			</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-4">
			<div class="grid gap-2">
				<Label for="todo-title">Title</Label>
				<Input id="todo-title" bind:value={todoTitle} placeholder="Audit the webhook retry path" />
			</div>
			<div class="grid gap-2">
				<Label for="todo-description">Description</Label>
				<Textarea
					id="todo-description"
					bind:value={todoDescription}
					rows={12}
					placeholder="Context, what to look at, what counts as done…"
				/>
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="grid gap-2">
					<Label for="todo-repo">Repository (optional)</Label>
					<Input id="todo-repo" bind:value={todoRepo} placeholder="Spelling-Creator/boxy" />
				</div>
				<div class="grid gap-2">
					<Label for="todo-issue">Issue or PR number (optional)</Label>
					<Input id="todo-issue" bind:value={todoIssue} placeholder="42" inputmode="numeric" />
				</div>
			</div>
			<p class="text-muted-foreground text-xs">
				Leave the repository blank and boxy falls back to Spelling-Creator/boxy. It reports findings
				by commenting, so give it an issue or PR number if you want to read the results.
			</p>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (todoEditorOpen = false)} disabled={busy}>
				Cancel
			</Button>
			<Button onclick={saveTodo} disabled={busy}>Save</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root
	open={pendingTodoDelete !== null}
	onOpenChange={(open) => {
		if (!open) pendingTodoDelete = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete this task?</AlertDialog.Title>
			<AlertDialog.Description>
				“{pendingTodoDelete?.title}” will be removed from boxy's to-do list. If boxy is working on
				it right now, it will keep going until it finishes this run.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={busy}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={confirmTodoDelete} disabled={busy}>Delete</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={clearCompletedOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Clear finished tasks?</AlertDialog.Title>
			<AlertDialog.Description>
				Every task marked done will be removed from boxy's to-do list. This can't be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={busy}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={confirmClearCompleted} disabled={busy}>Clear</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
