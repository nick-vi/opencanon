<script>
  import TreeBlock from './TreeBlock.svelte';
  import { highlightLine } from '$lib/syntax.js';

  let {
    before = '',
    after = '',
    language = 'text',
    beforeTitle = 'Before',
    afterTitle = 'After',
    beforeLanguage = '',
    afterLanguage = '',
    mode = 'compare'
  } = $props();

  const beforeCode = $derived(before.replace(/^\n/, '').replace(/\n$/, ''));
  const afterCode = $derived(after.replace(/^\n/, '').replace(/\n$/, ''));
  const beforeLines = $derived(beforeCode.split('\n'));
  const afterLines = $derived(afterCode.split('\n'));
  const beforeLineSet = $derived(new Set(beforeLines));
  const afterLineSet = $derived(new Set(afterLines));
  const panes = $derived([
    {
      id: 'before',
      title: beforeTitle,
      language: beforeLanguage || language,
      code: beforeCode,
      lines: beforeLines.map((line) => ({
        text: line,
        tone: mode === 'diff' && !afterLineSet.has(line) ? 'removed' : 'neutral'
      }))
    },
    {
      id: 'after',
      title: afterTitle,
      language: afterLanguage || language,
      code: afterCode,
      lines: afterLines.map((line) => ({
        text: line,
        tone: mode === 'diff' && !beforeLineSet.has(line) ? 'added' : 'neutral'
      }))
    }
  ]);

  function languageLabel(value) {
    return value === 'shell' ? 'sh' : value;
  }
</script>

<figure class="before-after">
  <div class="pane-grid">
    {#each panes as pane}
      <section class="pane" aria-label={pane.title}>
        <header class="pane-head">
          <span>{pane.title}</span>
          <span class="lang">{languageLabel(pane.language)}</span>
        </header>
        {#if pane.language === 'tree'}
          <TreeBlock code={pane.code} />
        {:else}
          <pre><code>{#each pane.lines as line, index}<span class={`line line-${line.tone}`}><span class="gutter" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span class="source">{#each highlightLine(line.text, pane.language) as token}<span class={`tok tok-${token.kind}`}>{token.text}</span>{/each}</span>
</span>{/each}</code></pre>
        {/if}
      </section>
    {/each}
  </div>
</figure>

<style>
  .before-after {
    margin: var(--space-5) 0;
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-2);
    background: var(--c-code-bg);
    overflow: hidden;
    max-width: 100%;
  }

  .pane-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: stretch;
  }

  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .pane + .pane {
    border-left: 1px solid var(--c-rule);
  }

  .pane-head {
    min-height: 2.4rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: 0 var(--space-3) 0 var(--space-4);
    border-bottom: 1px solid var(--c-rule);
    font-family: var(--font-sans);
    font-size: 0.78rem;
    color: var(--c-ink-soft);
    background: var(--c-code-head);
  }

  .lang {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    letter-spacing: 0;
    text-transform: uppercase;
    color: var(--c-ink-mute);
  }

  pre {
    margin: 0;
    --gutter-width: 3.25rem;
    padding: var(--space-3) 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--c-code);
    font-size: 0.78rem;
    line-height: 1.5;
    overflow-x: auto;
    position: relative;
    flex: 1;
  }

  pre::before {
    background: var(--c-rule);
    bottom: 0;
    content: "";
    left: var(--gutter-width);
    position: absolute;
    top: 0;
    width: 1px;
    z-index: 2;
  }

  code {
    position: relative;
    display: block;
    min-width: max-content;
    padding: 0;
    background: transparent;
    font-size: inherit;
    line-height: inherit;
  }

  .line {
    display: grid;
    grid-template-columns: var(--gutter-width) max-content;
    min-height: 1.5em;
    position: relative;
    z-index: 1;
  }

  .line:hover {
    background: var(--c-code-line);
  }

  .line-removed {
    background: color-mix(in oklch, crimson, transparent 88%);
  }

  .line-added {
    background: color-mix(in oklch, seagreen, transparent 86%);
  }

  .gutter {
    display: block;
    padding: 0 0.65rem 0 var(--space-4);
    color: var(--c-code-gutter);
    text-align: right;
    user-select: none;
  }

  .source {
    padding-left: 0.75rem;
    white-space: pre;
  }

  .tok-comment { color: var(--c-code-comment); }
  .tok-string { color: var(--c-code-string); }
  .tok-keyword,
  .tok-command { color: var(--c-code-keyword); }
  .tok-number,
  .tok-flag { color: var(--c-code-number); }
  .tok-path,
  .tok-package { color: var(--c-code-path); }

  @media (max-width: 760px) {
    .pane-grid {
      grid-template-columns: 1fr;
    }

    .pane + .pane {
      border-left: 0;
      border-top: 1px solid var(--c-rule);
    }

    pre {
      --gutter-width: 2.75rem;
      font-size: 0.74rem;
      line-height: 1.48;
    }

    .line {
      min-height: 1.48em;
    }

    .gutter {
      padding: 0 0.55rem 0 var(--space-3);
    }

    .source {
      padding-left: 0.65rem;
    }
  }
</style>
