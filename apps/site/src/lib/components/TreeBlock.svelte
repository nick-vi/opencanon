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
    const parsed = [];

    for (const [index, raw] of rawLines.entries()) {
      if (!raw.trim()) {
        parsed.push({ id: `blank-${index}`, blank: true });
        continue;
      }

      const body = raw.trimEnd();
      const commentOnly = body.match(/^#\s?(.*)$/);
      if (commentOnly && parsed.length > 0) {
        const previous = parsed[parsed.length - 1];
        if (!previous.blank) previous.note = [previous.note, commentOnly[1]].filter(Boolean).join(' ');
        continue;
      }

      const parsedLine = parseTreeLine(body);
      const parts = parsedLine.name.match(/^(.*?)(?:\s+#\s?(.*))?$/);
      const name = (parts?.[1] ?? parsedLine.name).trimEnd();
      const note = parts?.[2] ?? '';

      parsed.push({
        id: `tree-${index}`,
        blank: false,
        prefixCells: prefixCells(parsedLine.prefix),
        depth: prefixCells(parsedLine.prefix).length,
        kind: entryKind(name),
        name,
        note
      });
    }

    return parsed;
  }

  function parseTreeLine(line) {
    const match = line.match(/^((?:(?:│  |   ))*(?:├─ |└─ ))(.+)$/);
    if (!match) return { prefix: '', name: line };
    return { prefix: match[1], name: match[2] };
  }

  function prefixCells(prefix) {
    if (!prefix) return [];
    const cells = [];
    for (let offset = 0; offset < prefix.length; offset += 3) {
      const chunk = prefix.slice(offset, offset + 3);
      if (chunk === '│  ') cells.push('pipe');
      else if (chunk === '├─ ') cells.push('tee');
      else if (chunk === '└─ ') cells.push('elbow');
      else cells.push('empty');
    }
    return cells;
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
        style={`--tree-depth: ${row.depth}`}
      >
        <span class="tree-prefix" aria-hidden="true">
          {#each row.prefixCells as cell}
            <span class={`tree-cell tree-cell-${cell}`}></span>
          {/each}
        </span>
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
    font-size: 0.78rem;
    overflow-x: auto;
  }
  .tree-row {
    --tree-cell: 1.55rem;
    --tree-icon: 1.25rem;
    align-items: center;
    display: grid;
    grid-template-columns:
      calc(var(--tree-depth) * var(--tree-cell))
      var(--tree-icon)
      max-content
      minmax(0, 1fr);
    line-height: 1.6;
    min-height: 1.6rem;
    min-width: max-content;
    padding-left: var(--space-4);
    padding-right: var(--space-4);
  }
  .tree-row:hover {
    background: var(--c-code-line);
  }
  .tree-prefix {
    color: var(--c-code-gutter);
    display: inline-flex;
    align-self: stretch;
    height: 100%;
    width: calc(var(--tree-depth) * var(--tree-cell));
  }
  .tree-cell {
    flex: 0 0 var(--tree-cell);
    position: relative;
  }
  .tree-cell-pipe::before,
  .tree-cell-tee::before,
  .tree-cell-elbow::before {
    background: var(--c-code-gutter);
    content: "";
    left: calc(var(--tree-cell) / 2);
    opacity: 0.72;
    position: absolute;
    width: 1px;
  }
  .tree-cell-pipe::before,
  .tree-cell-tee::before {
    bottom: 0;
    top: 0;
  }
  .tree-cell-elbow::before {
    top: 0;
    height: 50%;
  }
  .tree-cell-tee::after,
  .tree-cell-elbow::after {
    background: var(--c-code-gutter);
    content: "";
    height: 1px;
    left: calc(var(--tree-cell) / 2);
    opacity: 0.72;
    position: absolute;
    top: 50%;
    width: calc(var(--tree-cell) / 2);
  }
  .tree-node {
    align-items: center;
    color: var(--c-code-gutter);
    display: inline-flex;
    justify-content: center;
    width: var(--tree-icon);
  }
  .tree-node :global(svg) {
    display: block;
    height: 0.9rem;
    width: 0.9rem;
  }
  .tree-directory .tree-node,
  .tree-directory .tree-name {
    color: var(--c-code-path);
  }
  .tree-name {
    color: var(--c-code);
    padding-left: 0.45rem;
    white-space: pre;
  }
  .tree-note {
    color: var(--c-code-comment);
    font-family: var(--font-sans);
    font-size: 0.78rem;
    margin-left: 0.6rem;
    max-width: 52ch;
    white-space: normal;
  }
  .tree-space {
    height: var(--space-3);
  }
  @media (max-width: 640px) {
    .tree-render { font-size: 0.74rem; }
    .tree-row {
      padding-left: var(--space-3);
      padding-right: var(--space-3);
    }
  }
</style>
