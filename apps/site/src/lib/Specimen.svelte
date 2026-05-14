<script>
  import { highlightLine } from '$lib/syntax.js';

  let { caption = '', source = '', findings = [], path = '' } = $props();

  const lines = $derived(source.replace(/^\n/, '').replace(/\n$/, '').split('\n'));

  function findingFor(idx) {
    const lineNum = idx + 1;
    return findings.find((f) => f.line === lineNum);
  }
</script>

<figure class="specimen" aria-label={caption}>
  <header class="specimen-head">
    <span class="smallcaps">Validator output</span>
    <span class="specimen-path">{path}</span>
  </header>
  <pre class="specimen-body" aria-live="off"><code>{#each lines as line, idx}{@const f = findingFor(idx)}<span class="row" class:flagged={!!f}><span class="margin" aria-hidden="true">{#if f}{f.severity === 'error' ? '!' : '·'}{:else}&nbsp;{/if}</span><span class="num" aria-hidden="true">{String(idx + 1).padStart(2, ' ')}</span><span class="src">{#each highlightLine(line, 'ts') as token}<span class={`tok tok-${token.kind}`}>{token.text}</span>{/each}</span>{#if f}<span class="annot mark">  ← {f.message}</span>{/if}
</span>{/each}</code></pre>
  {#if findings.length}
    <ol class="findings">
      {#each findings as f}
        <li>
          <span class="sev" data-sev={f.severity}>{f.severity}</span>
          <span class="rule">{f.rule}</span>
          <span class="loc">{path}:{f.line}</span>
          <p class="detail">{f.detail}</p>
        </li>
      {/each}
    </ol>
  {/if}
  {#if caption}<figcaption class="muted">{caption}</figcaption>{/if}
</figure>

<style>
  .specimen {
    margin: 0;
    border-top: 1px solid var(--c-rule);
    border-bottom: 1px solid var(--c-rule);
    background: transparent;
    max-width: 100%;
    min-width: 0;
  }
  .specimen-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: var(--space-3) 0;
    border-bottom: 1px dotted var(--c-rule);
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .specimen-path {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--c-ink-soft);
    overflow-wrap: anywhere;
  }
  .specimen-body {
    margin: 0;
    padding: var(--space-4) 0;
    background: transparent;
    border: 0;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    font-size: 0.86rem;
    line-height: 1.7;
  }
  .specimen-body code { display: block; white-space: pre; }
  .row { display: block; }
  .row.flagged { color: var(--c-ink); }
  .margin {
    display: inline-block;
    width: 1ch;
    color: var(--c-mark);
    font-weight: 600;
    user-select: none;
  }
  .num {
    display: inline-block;
    width: 3ch;
    margin: 0 1.25ch 0 0.5ch;
    color: var(--c-ink-mute);
    text-align: right;
    user-select: none;
  }
  .src { color: inherit; }
  .tok-comment { color: var(--c-code-comment); }
  .tok-string { color: var(--c-code-string); }
  .tok-keyword,
  .tok-command { color: var(--c-code-keyword); }
  .tok-number,
  .tok-flag { color: var(--c-code-number); }
  .tok-path,
  .tok-package { color: var(--c-code-path); }
  .annot {
    font-family: var(--font-sans);
    font-style: italic;
    font-size: 0.92em;
  }
  .findings {
    list-style: none;
    padding: 0;
    margin: var(--space-4) 0 0;
    border-top: 1px dotted var(--c-rule);
  }
  .findings li {
    padding: var(--space-3) 0;
    border-bottom: 1px dotted var(--c-rule);
  }
  .findings .sev {
    display: inline-block;
    font-family: var(--font-sans);
    font-size: 0.7rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 0.05rem 0.4rem;
    margin-right: 0.6rem;
    color: var(--c-paper);
    background: var(--c-ink-soft);
  }
  .findings .sev[data-sev="error"] { background: var(--c-mark); }
  .findings .rule {
    font-family: var(--font-mono);
    font-size: 0.85rem;
  }
  .findings .loc {
    margin-left: 0.6rem;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--c-ink-mute);
    overflow-wrap: anywhere;
  }
  .findings .detail {
    margin: 0.3rem 0 0;
    color: var(--c-ink-soft);
    max-width: var(--measure);
  }
  figcaption {
    font-family: var(--font-sans);
    font-size: 0.78rem;
    padding: var(--space-3) 0;
    border-top: 1px dotted var(--c-rule);
  }
</style>
