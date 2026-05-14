<script>
  import { tick } from 'svelte';
  import { Info } from '@lucide/svelte';
  import { GLOSSARY } from '$lib/glossary.js';

  let { term = '', label = '', text = '', id = '' } = $props();
  let root;
  let trigger;
  let bubble;
  let open = $state(false);
  let pinned = $state(false);
  let placement = $state('top');
  let tipStyle = $state('');

  const description = $derived(text || GLOSSARY[term] || '');
  const title = $derived(label || term || 'More information');
  const tipId = $derived(id || `tip-${term || label}`.replace(/[^a-z0-9_-]/gi, '-'));

  function portal(node) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      }
    };
  }

  function updatePosition() {
    if (!open || !trigger) return;

    const pad = 10;
    const gap = 8;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - pad * 2);
    const estimatedHeight = bubble?.offsetHeight || 76;
    const canUseTop = rect.top - estimatedHeight - gap > pad;
    placement = canUseTop ? 'top' : 'bottom';

    const rawLeft = rect.left + rect.width / 2;
    const left = Math.min(
      window.innerWidth - pad - width / 2,
      Math.max(pad + width / 2, rawLeft)
    );
    const top = placement === 'top' ? rect.top - gap : rect.bottom + gap;
    tipStyle = `--tip-left: ${left}px; --tip-top: ${top}px; --tip-width: ${width}px;`;
  }

  async function show() {
    open = true;
    await tick();
    updatePosition();
  }

  async function toggle() {
    pinned = !pinned;
    open = pinned;
    await tick();
    updatePosition();
  }

  function close() {
    open = false;
    pinned = false;
  }

  function hideHover() {
    if (pinned || document.activeElement === trigger) return;
    open = false;
  }

  function closeIfFocusLeaves() {
    requestAnimationFrame(() => {
      if (!root?.contains(document.activeElement)) close();
    });
  }

  function handlePointerDown(event) {
    if (!open) return;
    const target = event.target;
    if (root?.contains(target) || bubble?.contains(target)) return;
    close();
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      close();
    }
  }
</script>

<svelte:window
  onpointerdown={handlePointerDown}
  onkeydown={handleKeydown}
  onresize={updatePosition}
  onscroll={updatePosition}
/>

<span
  bind:this={root}
  class="info-tip"
  class:open
>
  <button
    bind:this={trigger}
    class="tip-trigger"
    type="button"
    aria-label={`About ${title}`}
    aria-describedby={tipId}
    onclick={toggle}
    onfocus={show}
    onblur={closeIfFocusLeaves}
    onmouseenter={show}
    onmouseleave={hideHover}
  >
    <Info size={13} strokeWidth={2.2} />
  </button>
</span>

<span
  use:portal
  bind:this={bubble}
  class="tip-bubble"
  class:open
  class:below={placement === 'bottom'}
  role="tooltip"
  id={tipId}
  style={tipStyle}
>{description}</span>

<style>
  .info-tip {
    display: inline-flex;
    vertical-align: text-top;
  }
  .tip-trigger {
    width: 1rem;
    height: 1rem;
    padding: 0;
    border: 1px solid var(--c-rule);
    border-radius: 999px;
    display: inline-grid;
    place-items: center;
    color: var(--c-ink-mute);
    background: var(--c-surface);
    cursor: pointer;
  }
  .tip-trigger:hover,
  .tip-trigger:focus-visible {
    color: var(--c-mark);
    border-color: var(--c-mark);
  }
  .tip-bubble {
    position: fixed;
    z-index: 1000;
    left: var(--tip-left, 0);
    top: var(--tip-top, 0);
    width: var(--tip-width, min(18rem, calc(100vw - 2rem)));
    transform: translate(-50%, calc(-100% - 0.2rem));
    padding: var(--space-3);
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-2);
    background: var(--c-surface);
    color: var(--c-ink-soft);
    box-shadow: var(--shadow-pop);
    font-family: var(--font-sans);
    font-size: 0.78rem;
    line-height: 1.45;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
      opacity var(--motion-fast) var(--motion-ease),
      transform var(--motion-fast) var(--motion-ease);
  }
  .tip-bubble.open {
    opacity: 1;
    visibility: visible;
    transform: translate(-50%, -100%);
  }
  .tip-bubble.below {
    transform: translate(-50%, 0.2rem);
  }
  .tip-bubble.below.open {
    transform: translate(-50%, 0);
  }
  @media (prefers-reduced-motion: reduce) {
    .tip-bubble { transition: none; }
  }
</style>
