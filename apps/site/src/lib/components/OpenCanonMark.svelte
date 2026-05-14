<script>
  let {
    title = 'OpenCanon mark',
    decorative = true,
    size = 24
  } = $props();

  const titleId = 'opencanon-mark-title';
</script>

<svg
  class="opencanon-mark"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden={decorative ? 'true' : undefined}
  role={decorative ? undefined : 'img'}
  aria-labelledby={decorative ? undefined : titleId}
>
  {#if !decorative}
    <title id={titleId}>{title}</title>
  {/if}
  <rect class="mark-shell" x="3.5" y="3.5" width="17" height="17" rx="3.5" />
  <path class="mark-rule" d="M7 8.25h10" />
  <path class="mark-rule accent" d="M7 12h6.4" />
  <path class="mark-join accent" d="M13.4 12h2.1" />
  <circle class="mark-node accent" cx="17" cy="12" r="1.45" />
  <path class="mark-rule short" d="M7 15.75h4.7" />
</svg>

<style>
  .opencanon-mark {
    display: block;
    color: var(--c-ink);
  }
  .mark-shell {
    fill: var(--c-surface);
    stroke: var(--c-rule-strong);
  }
  .mark-rule,
  .mark-join {
    stroke: currentColor;
    stroke-width: 1.35;
    stroke-linecap: round;
  }
  .mark-rule.short {
    opacity: 0.72;
  }
  .accent {
    color: var(--c-mark);
    stroke: currentColor;
    fill: currentColor;
  }
</style>
