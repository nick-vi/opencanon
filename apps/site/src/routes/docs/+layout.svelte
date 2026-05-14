<script>
  import { page } from '$app/state';
  import {
    BookOpen,
    Boxes,
    Cpu,
    Download,
    GitBranch,
    Layers,
    Network,
    PanelTop,
    Play,
    ShieldCheck,
    Terminal
  } from '@lucide/svelte';
  import { SITE } from '$lib/site.config.js';

  let { children } = $props();

  const navGroups = SITE.docsNav;
  const icons = {
    book: BookOpen,
    boxes: Boxes,
    cpu: Cpu,
    download: Download,
    gitBranch: GitBranch,
    layers: Layers,
    network: Network,
    panel: PanelTop,
    play: Play,
    shield: ShieldCheck,
    terminal: Terminal
  };
</script>

<div class="docs-shell">
  <aside class="docs-nav" aria-label="Documentation">
    <nav>
      {#each navGroups as group}
        {@const SectionIcon = icons[group.icon]}
        <div class="group">
          <p class="group-title smallcaps">
            {#if SectionIcon}<SectionIcon size={13} strokeWidth={2.2} />{/if}
            <span>{group.title}</span>
          </p>
          <ul>
            {#each group.items as item}
              {@const ItemIcon = icons[item.icon]}
              <li>
                <a
                  href={item.href}
                  class:current={page.url.pathname === item.href}
                >
                  {#if ItemIcon}<ItemIcon size={14} strokeWidth={2.1} />{/if}
                  <span>{item.label}</span>
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </nav>
  </aside>

  <article class="docs-body">
    {@render children()}
  </article>
</div>

<style>
  .docs-shell {
    max-width: 78rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-6) var(--space-7);
    display: grid;
    grid-template-columns: 16rem minmax(0, 1fr);
    gap: var(--space-7);
  }
  .docs-nav {
    position: sticky;
    top: var(--space-5);
    align-self: start;
    min-width: 0;
  }
  .group + .group { margin-top: var(--space-5); }
  .group-title {
    margin: 0 0 var(--space-2) 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .docs-nav ul { list-style: none; padding: 0; margin: 0; }
  .docs-nav li { padding: 0.18rem 0; }
  .docs-nav a {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    text-decoration: none;
    color: var(--c-ink-soft);
    font-size: 0.92rem;
    padding: 0.34rem 0.5rem;
    border: 1px solid transparent;
    border-radius: var(--radius-1);
  }
  .docs-nav a:hover {
    color: var(--c-ink);
    background: var(--c-surface);
  }
  .docs-nav a.current {
    color: var(--c-mark);
    border-color: var(--c-rule);
    background: var(--c-surface);
  }
  .docs-body {
    max-width: var(--measure-wide);
    min-width: 0;
  }
  .docs-body :global(h1) {
    font-size: var(--step-4);
    margin-bottom: var(--space-3);
    line-height: 1.1;
    letter-spacing: 0;
  }
  .docs-body :global(h2) {
    font-size: var(--step-3);
    margin: var(--space-7) 0 var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--c-rule);
  }
  .docs-body :global(h3) {
    font-size: var(--step-2);
    margin: var(--space-5) 0 var(--space-2);
  }
  .docs-body :global(p) { max-width: var(--measure); }
  .docs-body :global(ul), .docs-body :global(ol) { max-width: var(--measure); }
  .docs-body :global(.lead) {
    font-size: var(--step-2);
    color: var(--c-ink-soft);
    max-width: 50ch;
    margin-bottom: var(--space-5);
  }

  @media (max-width: 820px) {
    .docs-shell {
      display: block;
      padding: var(--space-5) var(--space-4) var(--space-7);
    }
    .docs-nav {
      position: static;
      width: 100%;
      margin-bottom: var(--space-6);
    }
    .docs-nav nav,
    .group,
    .docs-nav ul,
    .docs-nav li {
      width: 100%;
      min-width: 0;
    }
  }
</style>
