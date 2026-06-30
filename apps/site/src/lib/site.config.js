const repo = {
  owner: 'nick-vi',
  name: 'opencanon'
};

export const SITE = {
  name: 'OpenCanon',
  description:
    'Agent-ready, human-readable Project Canon: enforced specs, conventions, checks, search, and local runtime APIs.',
  repo,
  repoSlug: `${repo.owner}/${repo.name}`,
  repoUrl: `https://github.com/${repo.owner}/${repo.name}`,
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
        { href: '/docs/validators', label: 'Proof', icon: 'shield' },
        { href: '/docs/examples', label: 'Examples', icon: 'fileCode' }
      ]
    },
    {
      title: 'Surfaces',
      icon: 'panel',
      items: [
        { href: '/docs/cli', label: 'CLI', icon: 'terminal' },
        { href: '/docs/hooks', label: 'Hooks', icon: 'gitBranch' },
        { href: '/docs/runtime', label: 'Runtime', icon: 'cpu' }
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

export const INSTALL_COMMAND = `curl -fsSL https://github.com/${repo.owner}/${repo.name}/releases/latest/download/opencanon-install.mjs -o opencanon-install.mjs
node opencanon-install.mjs
rm opencanon-install.mjs`;

export const SETUP_COMMAND = `opencanon setup --yes --hooks codex`;

export const SERVICE_COMMAND = `opencanon service start
opencanon service status
opencanon project status
opencanon project open`;

export const RELEASE_MANIFEST_URL = `https://github.com/${repo.owner}/${repo.name}/releases/latest/download/opencanon-runtime-manifest.json`;
