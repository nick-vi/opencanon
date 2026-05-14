<script>
  import '$lib/styles/global.css';
  import { page } from '$app/state';
  import { BookOpen, ExternalLink, FileCode } from '@lucide/svelte';
  import OpenCanonMark from '$lib/components/OpenCanonMark.svelte';
  import { SITE } from '$lib/site.config.js';

  let { children } = $props();

  const isDocs = $derived(page.url.pathname.startsWith('/docs'));
  const navIcons = {
    book: BookOpen,
    fileCode: FileCode,
    github: ExternalLink
  };
</script>

<a class="skip-link" href="#main">Skip to content</a>

<header class="masthead">
  <div class="masthead-inner">
    <div class="brand-cluster">
      <a class="wordmark" href="/" aria-label="OpenCanon home">
        <span class="wordmark-mark" aria-hidden="true">
          <OpenCanonMark size={23} />
        </span>
        <span class="wordmark-text">{SITE.name}</span>
      </a>
    </div>
    <nav class="topnav" aria-label="Primary">
      {#each SITE.nav as item}
        {@const Icon = navIcons[item.icon]}
        <a
          href={item.href}
          target={item.href.startsWith('http') ? '_blank' : undefined}
          rel={item.href.startsWith('http') ? 'noreferrer' : undefined}
          class:current={item.href.startsWith('/docs') ? isDocs : page.url.pathname === item.href}
        >
          {#if Icon}<Icon size={14} strokeWidth={2.1} />{/if}
          <span>{item.label}</span>
        </a>
      {/each}
    </nav>
  </div>
</header>

<main id="main">
  {@render children()}
</main>

<footer class="site-footer">
  <div class="site-footer-inner">
    <p>Local repo rules for agents.</p>
    <p class="muted">Open source. Local-first. No analytics.</p>
  </div>
</footer>

<style>
  .masthead {
    border-bottom: 1px solid var(--c-rule);
    background: var(--c-paper);
  }
  .masthead-inner {
    max-width: 78rem;
    margin: 0 auto;
    padding: var(--space-4) var(--space-6);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-6);
  }
  .brand-cluster {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
  }
  .wordmark {
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
    text-decoration: none;
    color: var(--c-ink);
    flex: 0 0 auto;
  }
  .wordmark-mark {
    display: block;
    flex: 0 0 auto;
  }
  .wordmark-text {
    font-family: var(--font-sans);
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: 0;
  }
  .topnav {
    display: flex;
    gap: var(--space-2);
    font-family: var(--font-sans);
    font-size: 0.84rem;
    letter-spacing: 0;
    text-transform: none;
  }
  .topnav a {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    text-decoration: none;
    color: var(--c-ink-soft);
    padding: 0.4rem 0.55rem;
    border: 1px solid transparent;
    border-radius: var(--radius-1);
  }
  .topnav a:hover {
    color: var(--c-ink);
    background: var(--c-surface);
  }
  .topnav a.current {
    color: var(--c-mark);
    border-color: var(--c-rule);
    background: var(--c-surface);
  }

  main { display: block; }

  .site-footer {
    margin-top: var(--space-9);
    border-top: 1px solid var(--c-rule);
    background: var(--c-paper);
  }
  .site-footer-inner {
    margin: 0 auto;
    padding: var(--space-6) var(--space-6) var(--space-7);
    max-width: 60rem;
  }
  .site-footer p { margin: 0 0 var(--space-3) 0; max-width: var(--measure); }

  @media (max-width: 640px) {
    .masthead-inner {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-3);
      padding: var(--space-4);
    }
    .brand-cluster {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-1);
    }
    .topnav { gap: var(--space-2); flex-wrap: wrap; }
    .site-footer-inner { padding: var(--space-5) var(--space-4); }
  }
</style>
