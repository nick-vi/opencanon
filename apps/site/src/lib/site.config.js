const repo = {
  owner: 'nick-vi',
  name: 'opencanon'
};

export const SITE = {
  name: 'OpenCanon',
  description:
    'Local repo rules for agents: context, validators, findings, and a daemon-backed UI.',
  repo,
  repoSlug: `${repo.owner}/${repo.name}`,
  repoUrl: `https://github.com/${repo.owner}/${repo.name}`,
  bunVersion: '1.3.13',
  nav: [
    { href: '/docs/install', label: 'Docs', icon: 'book' },
    { href: '/specimen', label: 'Output', icon: 'fileCode' },
    { href: `https://github.com/${repo.owner}/${repo.name}`, label: 'Source', icon: 'github' }
  ],
  docsNav: [
    {
      title: 'Start',
      icon: 'play',
      items: [
        { href: '/docs/install', label: 'Install', icon: 'download' },
        { href: '/docs/quickstart', label: 'Quickstart', icon: 'terminal' }
      ]
    },
    {
      title: 'Model',
      icon: 'layers',
      items: [
        { href: '/docs/concepts', label: 'Concepts', icon: 'boxes' },
        { href: '/docs/validators', label: 'Validators', icon: 'shield' },
        { href: '/docs/examples', label: 'Examples', icon: 'fileCode' }
      ]
    },
    {
      title: 'Surfaces',
      icon: 'panel',
      items: [
        { href: '/docs/cli', label: 'CLI', icon: 'terminal' },
        { href: '/docs/hooks', label: 'Hooks', icon: 'gitBranch' },
        { href: '/docs/daemon', label: 'Daemon', icon: 'cpu' }
      ]
    },
    {
      title: 'Reference',
      icon: 'book',
      items: [{ href: '/docs/architecture', label: 'Architecture', icon: 'network' }]
    }
  ]
};

export const SKILLS_INSTALL_COMMAND = `npx skills add ${SITE.repoSlug} --skill opencanon -a codex -y`;

export const SKILL_COMMAND = `bun .agents/skills/opencanon/scripts/opencanon.ts`;

export const INIT_COMMAND = `${SKILL_COMMAND} setup --yes --hooks codex`;

export const DAEMON_COMMAND = `bun run opencanon daemon start
bun run opencanon daemon status
bun run opencanon daemon open`;

export const RELEASE_MANIFEST_URL = `https://github.com/${repo.owner}/${repo.name}/releases/download/v0.3.1/opencanon-runtime-manifest.json`;
