<script>
  import { goto } from '$app/navigation';
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
  const navItems = navGroups.flatMap((group) => group.items);
  const currentHref = $derived(navItems.find((item) => item.href === page.url.pathname)?.href ?? navItems[0]?.href ?? '/docs/install');
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

  function navigateDocs(event) {
    const target = event.currentTarget.value;
    if (target && target !== page.url.pathname) void goto(target);
  }
</script>

<div class="docs-shell">
  <aside class="docs-nav" aria-label="Documentation">
    <label class="mobile-doc-picker">
      <span class="smallcaps">Docs</span>
      <select value={currentHref} onchange={navigateDocs} aria-label="Documentation page">
        {#each navGroups as group}
          <optgroup label={group.title}>
            {#each group.items as item}
              <option value={item.href}>{item.label}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </label>

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
  .mobile-doc-picker {
    display: none;
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
      margin-bottom: var(--space-5);
    }
    .mobile-doc-picker {
      display: grid;
      gap: 0.35rem;
    }
    .mobile-doc-picker span {
      color: var(--c-ink-mute);
    }
    .mobile-doc-picker select {
      width: 100%;
      min-height: 2.35rem;
      border: 1px solid var(--c-rule);
      border-radius: var(--radius-1);
      background: var(--c-surface);
      color: var(--c-ink);
      padding: 0 2.1rem 0 0.75rem;
      font: inherit;
      font-size: 0.9rem;
      line-height: 1.2;
      appearance: none;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--c-ink-soft) 50%),
        linear-gradient(135deg, var(--c-ink-soft) 50%, transparent 50%);
      background-position:
        calc(100% - 1rem) 50%,
        calc(100% - 0.68rem) 50%;
      background-size: 0.32rem 0.32rem;
      background-repeat: no-repeat;
    }
    .mobile-doc-picker select:focus-visible {
      outline: 2px solid color-mix(in oklch, var(--c-mark), transparent 40%);
      outline-offset: 2px;
    }
    .docs-nav nav {
      display: none;
    }
  }
</style>
