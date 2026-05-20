<script>
  import { Check, Copy } from '@lucide/svelte';
  import TreeBlock from './TreeBlock.svelte';
  import { highlightLine } from '$lib/syntax.js';

  let {
    code = '',
    language = 'text',
    title = '',
    caption = '',
    lineNumbers = true
  } = $props();

  let copied = $state(false);
  let timer;

  const normalized = $derived(code.replace(/^\n/, '').replace(/\n$/, ''));
  const lines = $derived(normalized.split('\n'));
  const langLabel = $derived(language === 'shell' ? 'sh' : language);
  const isTree = $derived(language === 'tree');
  const displayTitle = $derived(title || (isTree ? 'Tree' : 'Code'));

  async function copyCode() {
    if (!navigator?.clipboard) return;
    await navigator.clipboard.writeText(normalized);
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      copied = false;
    }, 1400);
  }
</script>

<figure class="code-block">
  <header class="code-head">
    <span>{displayTitle}</span>
    <div class="code-actions">
      <span class="lang">{langLabel}</span>
      <button
        type="button"
        class="copy"
        onclick={copyCode}
        aria-label={copied ? 'Copied code' : 'Copy code'}
      >
        {#if copied}
          <Check size={14} />
        {:else}
          <Copy size={14} />
        {/if}
        <span class="sr-only" aria-live="polite">{copied ? 'Copied' : ''}</span>
      </button>
    </div>
  </header>
  {#if isTree}
    <TreeBlock code={normalized} />
  {:else}
    <pre><code>{#each lines as line, index}<span class="line">{#if lineNumbers}<span class="gutter" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{/if}<span class="source">{#each highlightLine(line, language) as token}<span class={`tok tok-${token.kind}`}>{token.text}</span>{/each}</span>
</span>{/each}</code></pre>
  {/if}
  {#if caption}<figcaption>{caption}</figcaption>{/if}
</figure>

<style>
  .code-block {
    margin: var(--space-5) 0;
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-2);
    background: var(--c-code-bg);
    overflow: hidden;
    max-width: 100%;
  }
  .code-head {
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
  .code-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .lang {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    letter-spacing: 0;
    text-transform: uppercase;
    color: var(--c-ink-mute);
  }
  .copy {
    width: 1.8rem;
    height: 1.8rem;
    border: 1px solid transparent;
    border-radius: var(--radius-1);
    display: inline-grid;
    place-items: center;
    color: var(--c-ink-mute);
    background: transparent;
    cursor: pointer;
  }
  .copy:hover,
  .copy:focus-visible {
    color: var(--c-mark);
    border-color: var(--c-rule);
    background: var(--c-surface);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
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
  .line:hover { background: var(--c-code-line); }
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
  figcaption {
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--c-rule);
    color: var(--c-ink-soft);
    font-family: var(--font-sans);
    font-size: 0.78rem;
  }
  @media (max-width: 640px) {
    .code-head { padding-left: var(--space-3); }
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
