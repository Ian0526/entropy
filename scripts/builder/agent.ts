/** How the worker runs the agent (Claude Code, unmodified, via `claude -p`). Ported from the DIY Builder. */

/** Commands it can run without asking. It can't push or commit: the worker does those. */
const ALLOWED = [
  'Edit(./**)',
  'Write(./**)',
  'mcp__turinglife__finish',
  'Bash(npm run typecheck*)',
  'Bash(npm run selftest*)',
  'Bash(npm run build*)',
  'Bash(npx tsc *)',
  'Bash(npx tsx scripts/*)',
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
];

const DENIED = [
  'Bash(git push*)', 'Bash(git commit*)', 'Bash(git remote*)', 'Bash(railway*)', 'Bash(curl*)', 'Bash(wget*)', 'WebFetch', 'WebSearch',
  'Read(**/.env*)', 'Edit(**/.env*)', 'Write(**/.env*)', 'Edit(.claude/**)', 'Write(.claude/**)', 'Edit(.mcp.json)', 'Write(.mcp.json)',
  'Read(**/.credentials.json)', 'Edit(railway.json)', 'Write(railway.json)', 'Edit(.github/**)', 'Write(.github/**)',
  // Killing processes by name takes down the worker itself (it is a node process too).
  'Bash(taskkill*)', 'Bash(killall*)', 'Bash(pkill*)', 'Bash(Stop-Process*)', 'Bash(powershell*Stop-Process*)',
  'PowerShell(Stop-Process*)', 'PowerShell(taskkill*)', 'PowerShell(*Stop-Process*)', 'PowerShell(*taskkill*)',
];

/** Lifted by --dangerously-skip-permissions, which stops the allow list applying but keeps the rest of the deny list. */
const WEB = ['Bash(curl*)', 'Bash(wget*)', 'WebFetch', 'WebSearch'];

export function agentSettings(skipPermissions = false) {
  return { permissions: { allow: ALLOWED, deny: skipPermissions ? DENIED.filter((r) => !WEB.includes(r)) : DENIED } };
}

export function mcpConfig(port: number) {
  return { mcpServers: { turinglife: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } };
}

export interface AgentOptions {
  settingsPath: string;
  mcpPath: string;
  guidePath: string;
  model: string;
  maxUsd: number;
  sessionId: string | null;
  /** Runs every tool without a permission check and connects the owner's Chrome. */
  skipPermissions?: boolean;
}

export function claudeArgs(o: AgentOptions): string[] {
  return [
    '-p',
    // One word on purpose: an empty argument wouldn't survive the shell on Windows.
    '--setting-sources=',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', o.model,
    '--settings', o.settingsPath,
    '--mcp-config', o.mcpPath,
    '--strict-mcp-config',
    '--append-system-prompt-file', o.guidePath,
    ...(o.skipPermissions ? ['--dangerously-skip-permissions', '--chrome'] : ['--permission-mode', 'dontAsk']),
    '--permission-prompts', 'none',
    '--max-budget-usd', String(o.maxUsd),
    ...(o.sessionId ? ['--resume', o.sessionId] : []),
  ];
}

const PASSED_THROUGH = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'NUMBER_OF_PROCESSORS', 'NVM_HOME', 'NVM_SYMLINK'];

/** npm keeps a flag typed before `--` for itself, so `npm run builder --flag` only shows up in the environment. */
export function wantsSkipPermissions(argv: string[], env: Record<string, string | undefined>): boolean {
  return argv.includes('--dangerously-skip-permissions') || env.npm_config_dangerously_skip_permissions === 'true' || env.BUILDER_FULL_ACCESS === '1';
}

const ISOLATED = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
};

/**
 * The agent's whole environment. Nothing else from the worker carries over: no site token, no Railway
 * token, no API key. `claude` is set for the agent itself; project commands get only the basics.
 * configDir is optional: by default the agent uses the owner's normal Claude Code login.
 */
export function agentEnv(env: Record<string, string | undefined>, claude?: { configDir?: string }): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(PASSED_THROUGH.flatMap((k) => (env[k] === undefined ? [] : [[k, env[k]]])));
  return { ...kept, ...(claude ? { ...ISOLATED, ...(claude.configDir ? { CLAUDE_CONFIG_DIR: claude.configDir } : {}) } : {}) } as unknown as NodeJS.ProcessEnv;
}

/** Reads `claude auth status`. Builder only runs on a Claude plan login, so nothing gets billed to an API key by accident. */
export function loginProblem(status: string): string | null {
  const fix = 'Sign in to Claude Code (`claude auth login`), then start the worker again.';
  try {
    const { loggedIn, authMethod } = JSON.parse(status) as { loggedIn?: boolean; authMethod?: string };
    if (!loggedIn) return `Claude Code isn't signed in. ${fix}`;
    return authMethod === 'claude.ai' ? null : `Claude Code is signed in with ${authMethod}, not a Claude plan. ${fix}`;
  } catch {
    return `Couldn't check the Claude sign-in. ${fix}`;
  }
}

export interface AgentEvent {
  lines: string[];
  sessionId?: string;
  costUsd?: number;
  /** Present on the last event of a run. */
  result?: { text: string; failed: boolean };
}

const short = (p: unknown) => (typeof p === 'string' ? (p.split(/[\\/]/).pop() ?? p) : 'a file');

/** A tool call, in words a person can follow. */
function describe(name: string, input: Record<string, unknown>): string | null {
  switch (name) {
    case 'Read':
      return `Reading ${short(input.file_path)}`;
    case 'Edit':
    case 'Write':
      return `Changing ${short(input.file_path)}`;
    case 'Grep':
    case 'Glob':
      return 'Searching the code';
    case 'WebSearch':
    case 'WebFetch':
      return 'Looking something up online';
    case 'Bash': {
      const c = String(input.command ?? '');
      if (c.includes('selftest')) return 'Running the self-test';
      if (c.includes('typecheck') || c.includes('tsc')) return 'Checking types';
      if (c.includes('build')) return 'Building the app';
      if (c.includes('tsx scripts/')) return 'Running a simulation experiment';
      return null;
    }
    default:
      return null;
  }
}

/** Reads one line of Claude Code's stream. Unknown or broken lines are skipped: they mustn't stop a run. */
export function readEvent(line: string): AgentEvent {
  let e: { type?: string; subtype?: string; session_id?: string; total_cost_usd?: number; is_error?: boolean; result?: string; message?: { content?: { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[] } };
  try {
    e = JSON.parse(line);
  } catch {
    return { lines: [] };
  }
  const event: AgentEvent = { lines: [], ...(e.session_id ? { sessionId: e.session_id } : {}) };
  if (e.type === 'assistant') {
    for (const block of e.message?.content ?? []) {
      if (block.type !== 'tool_use') continue;
      const said = describe(block.name ?? '', block.input ?? {});
      if (said) event.lines.push(said);
    }
  }
  if (e.type === 'result') {
    event.costUsd = e.total_cost_usd;
    event.result = { text: e.result || (e.subtype === 'error_max_budget_usd' ? 'It reached the limit for one request.' : ''), failed: e.is_error === true || (e.subtype !== undefined && e.subtype !== 'success') };
  }
  return event;
}
