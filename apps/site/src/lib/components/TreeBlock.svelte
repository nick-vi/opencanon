<script>
  import { File, Folder } from '@lucide/svelte';

  let { code = '' } = $props();

  const TreeEntryKind = {
    Directory: 'directory',
    File: 'file'
  };

  const rows = $derived(parseTree(code));

  function parseTree(value) {
    const rawLines = value.replace(/^\n/, '').replace(/\n$/, '').split('\n');
    const indentUnit = resolveIndentUnit(rawLines);
    const parsed = [];

    for (const [index, raw] of rawLines.entries()) {
      if (!raw.trim()) {
        parsed.push({ id: `blank-${index}`, blank: true });
        continue;
      }

      const indent = raw.match(/^\s*/)?.[0].length ?? 0;
      const body = raw.slice(indent).trimEnd();
      const commentOnly = body.match(/^#\s?(.*)$/);
      if (commentOnly && parsed.length > 0) {
        const previous = parsed[parsed.length - 1];
        if (!previous.blank) previous.note = [previous.note, commentOnly[1]].filter(Boolean).join(' ');
        continue;
      }

      const parts = body.match(/^(.*?)(?:\s+#\s?(.*))?$/);
      const name = (parts?.[1] ?? body).trimEnd();
      const note = parts?.[2] ?? '';
      const depth = Math.max(0, Math.floor(indent / indentUnit));

      parsed.push({
        id: `tree-${index}`,
        blank: false,
        depth,
        kind: entryKind(name),
        name,
        note
      });
    }

    return parsed;
  }

  function resolveIndentUnit(lines) {
    const widths = lines
      .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
      .filter((width) => width > 0);
    return Math.max(1, Math.min(...widths, 4));
  }

  function entryKind(name) {
    return name.endsWith('/') ? TreeEntryKind.Directory : TreeEntryKind.File;
  }
</script>

<div class="tree-render" role="list" aria-label="Directory tree">
  {#each rows as row (row.id)}
    {#if row.blank}
      <div class="tree-space" aria-hidden="true"></div>
    {:else}
      <div
        class={`tree-row tree-${row.kind}`}
        role="listitem"
        style={`padding-left: ${14 + row.depth * 22}px`}
      >
        <span class="tree-guide" class:root={row.depth === 0} aria-hidden="true"></span>
        <span class="tree-node" aria-hidden="true">
          {#if row.kind === TreeEntryKind.Directory}
            <Folder size={14} strokeWidth={1.8} />
          {:else}
            <File size={14} strokeWidth={1.8} />
          {/if}
        </span>
        <span class="tree-name">{row.name}</span>
        {#if row.note}<span class="tree-note">{row.note}</span>{/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .tree-render {
    padding: var(--space-4) 0;
    color: var(--c-code);
    font-family: var(--font-mono);
    font-size: 0.82rem;
    overflow-x: auto;
  }
  .tree-row {
    align-items: center;
    column-gap: 0.55rem;
    display: grid;
    grid-template-columns: 1rem 1rem max-content minmax(12rem, 1fr);
    min-height: 1.7rem;
    min-width: max-content;
    padding-right: var(--space-4);
  }
  .tree-row:hover {
    background: var(--c-code-line);
  }
  .tree-guide {
    height: 100%;
    opacity: 0.7;
    position: relative;
    width: 1rem;
  }
  .tree-guide::before,
  .tree-guide::after {
    background: color-mix(in oklch, var(--c-code-gutter), transparent 35%);
    content: "";
    position: absolute;
  }
  .tree-guide::before {
    height: 1px;
    left: 0.3rem;
    top: 50%;
    width: 0.55rem;
  }
  .tree-guide::after {
    bottom: 0;
    left: 0.3rem;
    top: 0;
    width: 1px;
  }
  .tree-guide.root::before,
  .tree-guide.root::after {
    display: none;
  }
  .tree-node {
    color: var(--c-code-gutter);
    display: inline-grid;
    place-items: center;
  }
  .tree-directory .tree-node,
  .tree-directory .tree-name {
    color: var(--c-code-path);
  }
  .tree-name {
    color: var(--c-code);
    white-space: pre;
  }
  .tree-note {
    color: var(--c-code-comment);
    font-family: var(--font-sans);
    font-size: 0.78rem;
    line-height: 1.45;
    max-width: 52ch;
    white-space: normal;
  }
  .tree-space {
    height: var(--space-3);
  }
  @media (max-width: 640px) {
    .tree-render { font-size: 0.78rem; }
    .tree-row {
      grid-template-columns: 0.8rem 1rem max-content minmax(10rem, 1fr);
      padding-right: var(--space-3);
    }
  }
</style>
