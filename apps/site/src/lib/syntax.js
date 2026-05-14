const TS_KEYWORDS =
  /\b(?:async|await|class|const|else|export|for|from|function|if|import|let|new|null|of|return|true|false|type|interface|extends|implements|readonly|private|public|protected|throw|try|catch|switch|case|break|continue|default)\b/g;

const COMMAND_WORDS =
  /\b(?:opencanon|git|bun|cd|npx|npm|pnpm|yarn|claude|codex|opencode)\b/g;

const COMMON_PATTERN =
  /(\/\/.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|--[a-z0-9-]+|@[a-z0-9_/-]+|~\/[^\s]+|\.?[a-z0-9_./-]+\/[a-z0-9_./-]+)/gi;

const SHELL_PATTERN =
  /(\/\/.*|#.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|--[a-z0-9-]+|@[a-z0-9_/-]+|~\/[^\s]+|\.?[a-z0-9_./-]+\/[a-z0-9_./-]+)/gi;

function pushPlain(parts, text, language) {
  if (!text) return;
  const pattern = language === 'shell' || language === 'bash' ? COMMAND_WORDS : TS_KEYWORDS;
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), kind: 'plain' });
    parts.push({
      text: match[0],
      kind: language === 'shell' || language === 'bash' ? 'command' : 'keyword'
    });
    last = match.index + match[0].length;
  }

  if (last < text.length) parts.push({ text: text.slice(last), kind: 'plain' });
}

function kindFor(token, language) {
  if (token.startsWith('//') || token.startsWith('#')) return 'comment';
  if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) return 'string';
  if (token.startsWith('--')) return 'flag';
  if (/^\d/.test(token)) return 'number';
  if (token.startsWith('@')) return 'package';
  if (token.includes('/') || token.startsWith('~/') || token.startsWith('./')) return 'path';
  if (language === 'shell' || language === 'bash') return 'command';
  return 'plain';
}

export function highlightLine(line, language = 'text') {
  if (!line) return [{ text: ' ', kind: 'plain' }];

  const normalized = language === 'sh' ? 'shell' : language;
  const pattern = normalized === 'shell' || normalized === 'bash' ? SHELL_PATTERN : COMMON_PATTERN;
  const parts = [];
  let last = 0;

  for (const match of line.matchAll(pattern)) {
    if (match.index > last) pushPlain(parts, line.slice(last, match.index), normalized);
    parts.push({ text: match[0], kind: kindFor(match[0], normalized) });
    last = match.index + match[0].length;
  }

  if (last < line.length) pushPlain(parts, line.slice(last), normalized);
  return parts;
}
