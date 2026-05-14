<script>
  import { Activity, Cpu, Database, GitBranch, Monitor, ShieldCheck, Terminal } from '@lucide/svelte';
  import InfoTip from './InfoTip.svelte';

  function fitWidth(label, sub = '', min = 126, max = 240) {
    return Math.min(
      max,
      Math.max(min, 68 + label.length * 7.6, 32 + sub.length * 6.2)
    );
  }

  function node(input) {
    const width = input.width ?? fitWidth(input.label, input.sub, input.minWidth, input.maxWidth);
    return {
      height: input.height ?? 76,
      width,
      ...input
    };
  }

  const desktopNodes = [
    node({
      id: 'repo',
      label: 'Repository',
      sub: 'git + working tree',
      icon: GitBranch,
      x: 36,
      y: 64
    }),
    node({
      id: 'watcher',
      label: 'Engine watcher',
      sub: 'changed paths',
      icon: Activity,
      x: 286,
      y: 64
    }),
    node({
      id: 'daemon',
      label: 'Daemon',
      sub: 'facts + validators',
      icon: Cpu,
      x: 504,
      y: 202,
      tone: 'primary',
      minWidth: 150
    }),
    node({
      id: 'state',
      label: 'SQLite state',
      sub: 'incremental cache',
      icon: Database,
      x: 286,
      y: 292,
      minWidth: 150
    }),
    node({
      id: 'findings',
      label: 'Findings',
      sub: 'rule + fix',
      icon: ShieldCheck,
      x: 74,
      y: 202
    })
  ];

  const desktopClients = [
    node({ id: 'cli', label: 'CLI', icon: Terminal, x: 704, y: 92, height: 54, minWidth: 92 }),
    node({ id: 'hooks', label: 'Hooks', icon: GitBranch, x: 704, y: 214, height: 54, minWidth: 92 }),
    node({ id: 'ui', label: 'UI', icon: Monitor, x: 704, y: 306, height: 54, minWidth: 92 })
  ];

  const mobileNodes = [
    node({ id: 'repo', label: 'Repository', sub: 'git + working tree', icon: GitBranch, x: 45, y: 26, height: 60, width: 270 }),
    node({ id: 'watcher', label: 'Engine watcher', sub: 'changed paths', icon: Activity, x: 45, y: 138, height: 60, width: 270 }),
    node({ id: 'daemon', label: 'Daemon', sub: 'facts + validators + SQLite', icon: Cpu, x: 45, y: 250, height: 60, width: 270, tone: 'primary' }),
    node({ id: 'findings', label: 'Findings', sub: 'rule + location + fix', icon: ShieldCheck, x: 45, y: 362, height: 60, width: 270 })
  ];

  const mobileClients = [
    node({ id: 'cli', label: 'CLI', x: 24, y: 504, height: 34, width: 92 }),
    node({ id: 'hooks', label: 'Hooks', x: 134, y: 504, height: 34, width: 92 }),
    node({ id: 'ui', label: 'UI', x: 244, y: 504, height: 34, width: 92 })
  ];

  function byId(nodes, id) {
    return nodes.find((item) => item.id === id);
  }

  function cx(item) {
    return item.x + item.width / 2;
  }

  function cy(item) {
    return item.y + item.height / 2;
  }

  function right(item) {
    return item.x + item.width;
  }

  function left(item) {
    return item.x;
  }

  function top(item) {
    return item.y;
  }

  function bottom(item) {
    return item.y + item.height;
  }

  function hPath(nodes, fromId, toId) {
    const from = byId(nodes, fromId);
    const to = byId(nodes, toId);
    const fromBeforeTo = cx(from) <= cx(to);
    const start = fromBeforeTo ? right(from) : left(from);
    const end = fromBeforeTo ? left(to) : right(to);
    const mid = start + (end - start) * 0.5;
    return `M${start} ${cy(from)} C${mid} ${cy(from)} ${mid} ${cy(to)} ${end} ${cy(to)}`;
  }

  function vPath(nodes, fromId, toId) {
    const from = byId(nodes, fromId);
    const to = byId(nodes, toId);
    const start = bottom(from);
    const end = top(to);
    const mid = start + (end - start) * 0.5;
    return `M${cx(from)} ${start} C${cx(from)} ${mid} ${cx(to)} ${mid} ${cx(to)} ${end}`;
  }

  function curve(nodes, fromId, toId) {
    const from = byId(nodes, fromId);
    const to = byId(nodes, toId);
    const dx = cx(to) - cx(from);
    const dy = cy(to) - cy(from);
    const horizontal = Math.abs(dx) >= Math.abs(dy);

    const startX = horizontal ? (dx >= 0 ? right(from) : left(from)) : cx(from);
    const startY = horizontal ? cy(from) : dy >= 0 ? bottom(from) : top(from);
    const endX = horizontal ? (dx >= 0 ? left(to) : right(to)) : cx(to);
    const endY = horizontal ? cy(to) : dy >= 0 ? top(to) : bottom(to);

    if (horizontal) {
      const midX = startX + (endX - startX) * 0.55;
      return `M${startX} ${startY} C${midX} ${startY} ${midX} ${endY} ${endX} ${endY}`;
    }

    const midY = startY + (endY - startY) * 0.55;
    return `M${startX} ${startY} C${startX} ${midY} ${endX} ${midY} ${endX} ${endY}`;
  }

  function fanPath(nodes, fromId, toId) {
    const from = byId(nodes, fromId);
    const to = byId(nodes, toId);
    const startX = cx(from);
    const startY = bottom(from);
    const endX = cx(to);
    const endY = top(to);
    const midY = startY + (endY - startY) * 0.55;
    return `M${startX} ${startY} C${startX} ${midY} ${endX} ${midY} ${endX} ${endY}`;
  }

  const desktopEdges = [
    { id: 'repo-watcher', d: hPath(desktopNodes, 'repo', 'watcher') },
    { id: 'watcher-daemon', d: curve(desktopNodes, 'watcher', 'daemon') },
    { id: 'daemon-state', d: hPath(desktopNodes, 'daemon', 'state') },
    { id: 'state-findings', d: hPath(desktopNodes, 'state', 'findings') },
    { id: 'daemon-cli', d: curve([...desktopNodes, ...desktopClients], 'daemon', 'cli'), muted: true },
    { id: 'daemon-hooks', d: hPath([...desktopNodes, ...desktopClients], 'daemon', 'hooks'), muted: true },
    { id: 'daemon-ui', d: curve([...desktopNodes, ...desktopClients], 'daemon', 'ui'), muted: true }
  ];

  const desktopCycle = [
    hPath(desktopNodes, 'repo', 'watcher'),
    curve(desktopNodes, 'watcher', 'daemon'),
    hPath([byId(desktopNodes, 'state'), byId(desktopNodes, 'daemon')], 'daemon', 'state'),
    hPath([byId(desktopNodes, 'findings'), byId(desktopNodes, 'state')], 'state', 'findings')
  ];

  const mobileEdges = [
    { id: 'm-repo-watch', d: vPath(mobileNodes, 'repo', 'watcher') },
    { id: 'm-watch-daemon', d: vPath(mobileNodes, 'watcher', 'daemon') },
    { id: 'm-daemon-findings', d: vPath(mobileNodes, 'daemon', 'findings') },
    { id: 'm-findings-cli', d: fanPath([...mobileNodes, ...mobileClients], 'findings', 'cli'), muted: true },
    { id: 'm-findings-hooks', d: fanPath([...mobileNodes, ...mobileClients], 'findings', 'hooks'), muted: true },
    { id: 'm-findings-ui', d: fanPath([...mobileNodes, ...mobileClients], 'findings', 'ui'), muted: true }
  ];

  const mobileCycle = [
    vPath(mobileNodes, 'repo', 'watcher'),
    vPath(mobileNodes, 'watcher', 'daemon'),
    vPath(mobileNodes, 'daemon', 'findings')
  ];
</script>

<figure class="system-diagram" aria-label="OpenCanon runtime diagram">
  <header class="diagram-head">
    <div>
      <p class="smallcaps">Runtime Loop</p>
      <h3>One daemon. Three clients.</h3>
    </div>
    <p>
      Changes become facts. Validators turn facts into findings. The CLI, hooks,
      and UI read the same local API.
      <InfoTip term="daemon" id="diagram-daemon-tip" />
    </p>
  </header>

  <div class="canvas" aria-hidden="true">
    <svg class="desktop-svg" viewBox="0 0 840 390" role="img" aria-labelledby="runtime-diagram-title">
      <title id="runtime-diagram-title">OpenCanon runtime flow</title>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>

      {#each desktopEdges as edge}
        <path class={`edge ${edge.muted ? 'muted-edge' : ''}`} d={edge.d} />
      {/each}

      {#each desktopNodes as item}
        {@const Icon = item.icon}
        <g class={`node ${item.tone === 'primary' ? 'primary' : ''}`} transform={`translate(${item.x} ${item.y})`}>
          <rect width={item.width} height={item.height} />
          <g transform="translate(16 14)"><Icon size={18} /></g>
          <text x="44" y="30">{item.label}</text>
          <text class="sub" x="16" y="56">{item.sub}</text>
        </g>
      {/each}

      {#each desktopClients as item}
        {@const Icon = item.icon}
        <g class="client" transform={`translate(${item.x} ${item.y})`}>
          <rect width={item.width} height={item.height} />
          <g transform="translate(14 13)"><Icon size={16} /></g>
          <text x="39" y="30">{item.label}</text>
        </g>
      {/each}

      {#each desktopCycle as path, index}
        <circle class="packet" r="5">
          <animateMotion dur="7s" begin={`${index * -1.45}s`} repeatCount="indefinite" path={path} />
        </circle>
      {/each}
    </svg>

    <svg class="mobile-svg" viewBox="0 0 360 540" role="img" aria-labelledby="runtime-diagram-mobile-title">
      <title id="runtime-diagram-mobile-title">OpenCanon runtime flow, compact layout</title>
      <defs>
        <marker id="mobile-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>

      {#each mobileEdges as edge}
        <path class={`edge mobile-edge ${edge.muted ? 'muted-edge' : ''}`} d={edge.d} />
      {/each}

      {#each mobileNodes as item}
        {@const Icon = item.icon}
        <g class={`node ${item.tone === 'primary' ? 'primary' : ''}`} transform={`translate(${item.x} ${item.y})`}>
          <rect width={item.width} height={item.height} />
          <g transform="translate(16 12)"><Icon size={17} /></g>
          <text x="44" y="28">{item.label}</text>
          <text class="sub" x="16" y="47">{item.sub}</text>
        </g>
      {/each}

      {#each mobileClients as item}
        <g class="client" transform={`translate(${item.x} ${item.y})`}>
          <rect width={item.width} height={item.height} />
          <text x="28" y="22">{item.label}</text>
        </g>
      {/each}

      {#each mobileCycle as path, index}
        <circle class="packet" r="5">
          <animateMotion dur="6s" begin={`${index * -1.4}s`} repeatCount="indefinite" path={path} />
        </circle>
      {/each}
    </svg>
  </div>

  <ol class="steps">
    <li><span>1</span> Watch changed files.</li>
    <li><span>2</span> Extract and cache facts.</li>
    <li><span>3</span> Run validators.</li>
    <li><span>4</span> Send findings to CLI, hooks, and UI.</li>
  </ol>
</figure>

<style>
  .system-diagram {
    margin: 0;
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-2);
    background: var(--c-surface);
    overflow: hidden;
  }
  .diagram-head {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(16rem, 1.1fr);
    gap: var(--space-5);
    padding: var(--space-5);
    border-bottom: 1px solid var(--c-rule);
  }
  .diagram-head h3 {
    margin: var(--space-1) 0 0;
    font-size: var(--step-3);
  }
  .diagram-head p {
    margin: 0;
    color: var(--c-ink-soft);
    max-width: 56ch;
  }
  .canvas {
    overflow-x: auto;
    padding: var(--space-4);
  }
  svg {
    display: block;
    min-width: 46rem;
    width: 100%;
    height: auto;
    color: var(--c-ink);
  }
  .mobile-svg { display: none; }
  rect {
    fill: var(--c-paper);
    stroke: var(--c-rule);
    rx: 6;
  }
  .primary rect {
    fill: var(--c-mark-bg);
    stroke: var(--c-mark);
  }
  .client rect {
    fill: var(--c-panel);
    stroke: var(--c-rule);
    rx: 6;
  }
  text {
    fill: currentColor;
    font-family: var(--font-sans);
    font-size: 14px;
    font-weight: 700;
  }
  .sub {
    fill: var(--c-ink-mute);
    font-size: 11px;
    font-weight: 400;
  }
  .edge {
    fill: none;
    stroke: var(--c-ink-mute);
    stroke-width: 1.4;
    marker-end: url(#arrow);
  }
  .mobile-edge {
    marker-end: url(#mobile-arrow);
  }
  .muted-edge {
    stroke: var(--c-rule-strong);
    stroke-dasharray: 4 5;
  }
  marker path { fill: var(--c-ink-mute); }
  .packet {
    fill: var(--c-mark);
    filter: drop-shadow(0 0 6px color-mix(in oklch, var(--c-mark), transparent 55%));
  }
  .steps {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--c-rule);
    list-style: none;
  }
  .steps li {
    margin: 0;
    padding: var(--space-4);
    border-right: 1px solid var(--c-rule);
    color: var(--c-ink-soft);
    font-size: 0.9rem;
  }
  .steps li:last-child { border-right: 0; }
  .steps span {
    display: inline-grid;
    place-items: center;
    width: 1.35rem;
    height: 1.35rem;
    margin-right: var(--space-2);
    border: 1px solid var(--c-rule);
    border-radius: 999px;
    color: var(--c-mark);
    font-family: var(--font-mono);
    font-size: 0.68rem;
  }
  @media (max-width: 860px) {
    .diagram-head { grid-template-columns: 1fr; }
    .steps { grid-template-columns: 1fr; }
    .steps li {
      border-right: 0;
      border-bottom: 1px solid var(--c-rule);
    }
    .steps li:last-child { border-bottom: 0; }
  }
  @media (max-width: 640px) {
    .canvas {
      overflow: visible;
      padding: var(--space-3);
    }
    .desktop-svg { display: none; }
    .mobile-svg {
      display: block;
      min-width: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .packet { display: none; }
  }
</style>
