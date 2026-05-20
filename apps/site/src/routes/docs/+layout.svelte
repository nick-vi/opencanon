<script>
  import { page } from '$app/state';
  import {
    BookOpen,
    Boxes,
    Cpu,
    Download,
    FileCode,
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
    fileCode: FileCode,
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
    max-width: 76rem;
    margin: 0 auto;
    padding: var(--space-5) var(--space-6) var(--space-7);
    display: grid;
    grid-template-columns: 14.5rem minmax(0, 1fr);
    gap: var(--space-6);
  }
  .docs-nav {
    position: sticky;
    top: var(--space-4);
    align-self: start;
    min-width: 0;
  }
  .docs-nav nav {
    padding: 0;
  }
  .group {
    padding: 0.35rem 0;
  }
  .group + .group {
    border-top: 1px solid var(--c-rule);
  }
  .group-title {
    margin: 0 0 0.22rem 0;
    padding: 0.18rem 0.45rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--c-ink-mute);
  }
  .docs-nav ul { list-style: none; padding: 0; margin: 0; }
  .docs-nav li { padding: 0.05rem 0; }
  .docs-nav a {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    text-decoration: none;
    color: var(--c-ink-soft);
    font-size: 0.84rem;
    line-height: 1.25;
    padding: 0.42rem 0.5rem;
    border: 1px solid transparent;
    border-radius: var(--radius-1);
    transition:
      background var(--motion-fast) var(--motion-ease),
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }
  .docs-nav a:hover {
    color: var(--c-ink);
    background: var(--c-paper);
  }
  .docs-nav a.current {
    color: var(--c-mark);
    border-color: color-mix(in oklch, var(--c-mark), var(--c-rule) 70%);
    background: var(--c-paper);
  }
  .docs-body {
    max-width: 72ch;
    min-width: 0;
    font-size: 0.94rem;
    line-height: 1.52;
  }
  .docs-body :global(h1) {
    font-size: 1.72rem;
    margin: 0 0 var(--space-2);
    line-height: 1.1;
    letter-spacing: 0;
  }
  .docs-body :global(h2) {
    font-size: 1.2rem;
    margin: var(--space-6) 0 var(--space-2);
    padding-top: var(--space-3);
    border-top: 1px solid var(--c-rule);
  }
  .docs-body :global(h3) {
    font-size: 1rem;
    margin: var(--space-4) 0 var(--space-2);
  }
  .docs-body :global(p),
  .docs-body :global(li) {
    line-height: 1.52;
  }
  .docs-body :global(p) {
    margin: 0 0 var(--space-3);
    max-width: var(--measure);
  }
  .docs-body :global(ul), .docs-body :global(ol) { max-width: var(--measure); }
  .docs-body :global(.lead) {
    font-size: 1rem;
    color: var(--c-ink-soft);
    max-width: 54ch;
    margin-bottom: var(--space-4);
  }

  @media (max-width: 820px) {
    .docs-shell {
      display: block;
      padding: var(--space-5) var(--space-4) var(--space-7);
    }
    .docs-nav {
      position: static;
      width: 100%;
      margin-bottom: var(--space-4);
    }
    .docs-nav nav {
      display: flex;
      gap: var(--space-2);
      overflow-x: auto;
      padding: 0 0 var(--space-2);
      scrollbar-width: thin;
      -webkit-overflow-scrolling: touch;
    }
    .group {
      display: contents;
    }
    .group-title {
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
    .docs-nav ul {
      display: flex;
      gap: 0.35rem;
      flex: 0 0 auto;
    }
    .docs-nav li {
      flex: 0 0 auto;
      padding: 0;
    }
    .docs-nav a {
      white-space: nowrap;
      min-height: 2rem;
    }
  }
</style>
