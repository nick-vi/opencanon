<script>
  import {
    ArrowRight,
    BookOpen,
    Braces,
    CircleCheck,
    ExternalLink,
    GitBranch,
    ShieldCheck,
    Terminal,
    Zap
  } from '@lucide/svelte';
  import CodeBlock from '$lib/components/CodeBlock.svelte';
  import InfoTip from '$lib/components/InfoTip.svelte';
  import SystemDiagram from '$lib/components/SystemDiagram.svelte';
  import Specimen from '$lib/Specimen.svelte';
  import {
    DAEMON_COMMAND,
    INIT_COMMAND,
    SITE,
    SKILLS_INSTALL_COMMAND
  } from '$lib/site.config.js';

  const heroSource = `import { db } from "../db/client";

export class CompanyService {
  constructor(private readonly billing: BillingClient) {}

  async deactivate(companyId: string) {
    const row = await db
      .from("companies")
      .where({ id: companyId })
      .update({ status: "inactive" });

    return row;
  }
}`;

  const heroFindings = [
    {
      line: 1,
      severity: 'error',
      rule: 'service-no-db-client',
      message: 'service imports db client',
      detail:
        'Services must not import the database client directly. Route persistence through a repository in src/repositories/.'
    },
    {
      line: 7,
      severity: 'warn',
      rule: 'repeated-domain-literals',
      message: '"companies" appears in multiple services',
      detail:
        'The literal "companies" is duplicated across services. Extract into the shared domain table registry.'
    }
  ];

  const features = [
    {
      icon: BookOpen,
      title: 'Context',
      href: '/docs/quickstart',
      text: 'Load the docs, decisions, and validators for a path before an agent edits it.',
      tip: 'canon'
    },
    {
      icon: ShieldCheck,
      title: 'Validators',
      href: '/docs/validators',
      text: 'Run typed rules over repository facts. Fixtures pin the behavior.',
      tip: 'facts'
    },
    {
      icon: Braces,
      title: 'Findings',
      href: '/docs/concepts',
      text: 'Return severity, location, decision links, and fix metadata.',
      tip: 'findings'
    },
    {
      icon: Zap,
      title: 'Hooks',
      href: '/docs/hooks',
      text: 'Send concise validation output to Codex, Claude Code, and OpenCode after edits.',
      tip: 'daemon'
    }
  ];

  const cliSession = `opencanon context --files src/services/company.service.ts
opencanon validate --changed
opencanon feedback --changed`;

  const installSession = `${SKILLS_INSTALL_COMMAND}

${INIT_COMMAND}

${DAEMON_COMMAND}`;
</script>

<svelte:head>
  <title>{SITE.name}: executable repository conventions</title>
  <meta name="description" content={SITE.description} />
</svelte:head>

<article class="page">
  <section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">
        <GitBranch size={16} />
        Local repo rules
      </p>
      <h1>Executable repo conventions for agents.</h1>
      <p class="dek">
        OpenCanon loads the rules for a repo, runs validators, and returns
        findings agents can act on.
      </p>
      <div class="actions">
        <a class="button primary" href="/docs/install">
          <Terminal size={16} />
          Install skill
        </a>
        <a class="button secondary" href={SITE.repoUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={16} />
          View source
        </a>
      </div>
      <p class="status-line">
        <CircleCheck size={15} />
        Runs locally. Open source. No analytics.
      </p>
    </div>

    <div class="hero-panel">
      <div class="panel-top">
        <span>validator output</span>
        <span>local daemon</span>
      </div>
      <Specimen
        caption="Finding record with code, margin signal, and action details."
        path="src/services/company.service.ts"
        source={heroSource}
        findings={heroFindings}
      />
    </div>
  </section>

  <section class="section">
    <header class="section-head">
      <p class="smallcaps">Workflow</p>
      <h2>Rules beside the code they govern.</h2>
      <p>
        Keep docs, decisions, validators, and findings in one local loop.
      </p>
    </header>

    <div class="feature-grid">
      {#each features as feature}
        {@const Icon = feature.icon}
        <div class="feature">
          <span class="feature-icon"><Icon size={18} strokeWidth={2.1} /></span>
          <span class="feature-copy">
            <span class="feature-title">
              {feature.title}
              <InfoTip term={feature.tip} id={`feature-${feature.tip}`} />
            </span>
            <span>{feature.text}</span>
          </span>
          <a class="feature-arrow" href={feature.href} aria-label={`${feature.title} documentation`}>
            <ArrowRight size={15} />
          </a>
        </div>
      {/each}
    </div>
  </section>

  <section class="section runtime">
    <header class="section-head">
      <p class="smallcaps">Runtime</p>
      <h2>One daemon, same result everywhere.</h2>
      <p>
        The daemon watches changes, caches facts, and serves the CLI, hooks,
        and UI.
      </p>
    </header>
    <SystemDiagram />
  </section>

  <section class="section split">
    <div>
      <p class="smallcaps">Feedback</p>
      <h2>Findings agents can act on.</h2>
      <p>
        Each finding includes the rule, location, reason, and fix metadata.
      </p>
      <ul class="command-list">
        <li>
          <Terminal size={16} />
          <span><code>context</code> loads rules for a path.</span>
        </li>
        <li>
          <ShieldCheck size={16} />
          <span><code>validate</code> runs the validators in scope.</span>
        </li>
        <li>
          <Zap size={16} />
          <span><code>feedback</code> returns agent-ready findings.</span>
        </li>
      </ul>
    </div>
    <CodeBlock
      title="local session"
      language="shell"
      code={cliSession}
      caption="Inspect context, validate changes, send findings back."
    />
  </section>

  <section class="section install">
    <header class="section-head">
      <p class="smallcaps">Install</p>
      <h2>Install the skill.</h2>
      <p>
        Clone OpenCanon into your agent host's skills directory. The skill
        includes the CLI, daemon, UI assets, validators, and engine.
      </p>
    </header>
    <CodeBlock title={SITE.repoSlug} language="shell" code={installSession} />
    <p class="install-note">
      <a class="text-link" href="/docs/install">
        Read the install guide <ArrowRight size={14} />
      </a>
    </p>
  </section>
</article>

<style>
  .page {
    max-width: 78rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-6) var(--space-7);
  }

  .hero {
    display: grid;
    grid-template-columns: minmax(0, 0.85fr) minmax(28rem, 1.15fr);
    gap: var(--space-7);
    align-items: center;
    padding: var(--space-7) 0 var(--space-8);
    border-bottom: 1px solid var(--c-rule);
  }
  .hero-copy {
    min-width: 0;
  }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-4);
    color: var(--c-mark);
    font-family: var(--font-sans);
    font-size: 0.82rem;
    font-weight: 700;
  }
  h1 {
    max-width: 11ch;
    font-size: var(--step-6);
    line-height: 0.98;
    letter-spacing: 0;
  }
  .dek {
    margin: var(--space-5) 0;
    max-width: 42ch;
    color: var(--c-ink-soft);
    font-size: var(--step-2);
    line-height: var(--leading-loose);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 2.45rem;
    padding: 0 var(--space-4);
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-2);
    text-decoration: none;
    font-family: var(--font-sans);
    font-size: 0.9rem;
    font-weight: 700;
  }
  .button.primary {
    color: var(--c-paper);
    background: var(--c-ink);
    border-color: var(--c-ink);
  }
  .button.secondary {
    color: var(--c-ink);
    background: var(--c-surface);
  }
  .button:hover {
    transform: translateY(-1px);
    transition: transform var(--motion-fast) var(--motion-ease);
  }
  .status-line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-4) 0 0;
    color: var(--c-ink-mute);
    font-size: 0.9rem;
  }
  .status-line :global(svg) { color: var(--c-mark); }

  .hero-panel {
    min-width: 0;
    padding: var(--space-4);
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-2);
    background: var(--c-surface);
  }
  .panel-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
    color: var(--c-ink-mute);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    text-transform: uppercase;
  }

  .section {
    padding: var(--space-8) 0;
    border-bottom: 1px solid var(--c-rule);
  }
  .section-head {
    max-width: 48rem;
    margin-bottom: var(--space-5);
  }
  .section-head h2,
  .split h2 {
    margin: var(--space-2) 0 var(--space-3);
    font-size: var(--step-4);
    line-height: 1.1;
  }
  .section-head p:not(.smallcaps),
  .split p {
    color: var(--c-ink-soft);
    font-size: var(--step-1);
    max-width: var(--measure);
  }

  .feature-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-2);
    overflow: hidden;
    background: var(--c-surface);
  }
  .feature {
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--space-3);
    padding: var(--space-4);
    border-right: 1px solid var(--c-rule);
    color: inherit;
  }
  .feature:last-child { border-right: 0; }
  .feature:hover {
    background: var(--c-panel);
  }
  .feature-icon {
    width: 2rem;
    height: 2rem;
    display: inline-grid;
    place-items: center;
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-1);
    color: var(--c-mark);
    background: var(--c-paper);
  }
  .feature-copy {
    min-width: 0;
    display: grid;
    gap: var(--space-2);
    color: var(--c-ink-soft);
    font-size: 0.9rem;
  }
  .feature-title {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--c-ink);
    font-weight: 700;
  }
  .feature-arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border: 1px solid transparent;
    border-radius: var(--radius-1);
    color: var(--c-ink-mute);
    text-decoration: none;
  }
  .feature-arrow:hover {
    color: var(--c-mark);
    border-color: var(--c-rule);
    background: var(--c-surface);
  }

  .runtime {
    display: grid;
    grid-template-columns: minmax(16rem, 0.32fr) minmax(0, 0.68fr);
    gap: var(--space-6);
    align-items: start;
  }
  .runtime .section-head {
    margin-bottom: 0;
  }

  .split {
    display: grid;
    grid-template-columns: minmax(18rem, 0.42fr) minmax(0, 0.58fr);
    gap: var(--space-6);
    align-items: start;
  }
  .command-list {
    list-style: none;
    padding: 0;
    margin: var(--space-5) 0 0;
    border-top: 1px solid var(--c-rule);
  }
  .command-list li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: 0;
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--c-rule);
    color: var(--c-ink-soft);
  }
  .command-list :global(svg) {
    color: var(--c-mark);
    flex: 0 0 auto;
  }
  .install {
    border-bottom: 0;
    padding-bottom: 0;
  }
  .install-note {
    margin-top: var(--space-3);
  }
  .text-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--c-mark);
    font-weight: 700;
    text-decoration: none;
  }
  .text-link:hover { text-decoration: underline; }

  @media (max-width: 1060px) {
    .hero,
    .runtime,
    .split {
      grid-template-columns: 1fr;
    }
    .feature-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .feature:nth-child(2) { border-right: 0; }
    .feature:nth-child(-n + 2) { border-bottom: 1px solid var(--c-rule); }
  }
  @media (max-width: 640px) {
    .page {
      padding: var(--space-5) var(--space-4) var(--space-7);
    }
    .hero {
      padding-top: var(--space-5);
      gap: var(--space-5);
    }
    h1 { font-size: var(--step-5); }
    .dek { font-size: var(--step-1); }
    .feature-grid { grid-template-columns: 1fr; }
    .feature,
    .feature:nth-child(2) {
      border-right: 0;
      border-bottom: 1px solid var(--c-rule);
    }
    .feature:last-child { border-bottom: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .button:hover {
      transform: none;
      transition: none;
    }
  }
</style>
