/**
 * One-click Python environment for the Outlook connector: a `.venv` next to
 * dist/ (where resolvePython() looks) with comtypes installed. Uses uv when it
 * is on PATH (trusting the system certificate store, as corporate TLS
 * interception requires), otherwise `python -m venv` + pip.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SetupStatus {
  running: boolean;
  /** the last run's outcome; null before the first run */
  ok: boolean | null;
  log: string[];
  venv: string;
}

export interface CommandResult {
  code: number | null;
  output: string;
}

export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

/** Run a program without a shell; never throws (a missing program is code null). */
export const runCommand: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    let output = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, output: (e as Error).message });
      return;
    }
    const add = (d: Buffer) => {
      output = (output + d.toString()).slice(-20_000);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

const here = dirname(fileURLToPath(import.meta.url));
/** The folder holding dist/ (bundled), or the repository root (development). */
export function appRoot(): string {
  return basename(here) === 'dist' ? join(here, '..') : join(here, '..', '..', '..');
}

export function venvPython(root = appRoot()): string {
  return process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python');
}

export class PythonSetup {
  private state: SetupStatus;

  constructor(
    private readonly root = appRoot(),
    private readonly run: Runner = runCommand,
    /** what to install and prove importable (tests swap these) */
    private readonly pkg = { spec: 'comtypes>=1.4', module: 'comtypes.client' },
  ) {
    this.state = { running: false, ok: null, log: [], venv: join(root, '.venv') };
  }

  get status(): SetupStatus {
    return { ...this.state, log: [...this.state.log] };
  }

  /** Is the venv there and can it import the package? (one short Python run) */
  async ready(): Promise<boolean> {
    const python = venvPython(this.root);
    if (!existsSync(python)) return false;
    const r = await this.run(python, ['-c', `import ${this.pkg.module}`], 30_000);
    return r.code === 0;
  }

  /** Start the setup in the background; a second call while running is ignored. */
  start(): SetupStatus {
    if (this.state.running) return this.status;
    this.state = { ...this.state, running: true, ok: null, log: [] };
    void this.setup().then(
      (ok) => {
        this.state = { ...this.state, running: false, ok };
      },
      (e: Error) => {
        this.say(`failed: ${e.message}`);
        this.state = { ...this.state, running: false, ok: false };
      },
    );
    return this.status;
  }

  private say(line: string): void {
    this.state.log.push(line);
    if (this.state.log.length > 200) this.state.log.splice(0, this.state.log.length - 200);
  }

  private async step(label: string, cmd: string, args: string[], timeoutMs = 300_000) {
    this.say(`${label}…`);
    const r = await this.run(cmd, args, timeoutMs);
    const tail = r.output.trim().split('\n').slice(-6);
    for (const line of tail) if (line.trim()) this.say(`  ${line.trim()}`);
    return r;
  }

  private async setup(): Promise<boolean> {
    const venv = join(this.root, '.venv');
    const python = venvPython(this.root);
    const uv = await this.run('uv', ['--version'], 15_000);
    if (uv.code === 0) {
      this.say(`using ${uv.output.trim()}`);
      // uv renamed --native-tls to --system-certs; try the new name first
      const withCerts = async (label: string, args: string[]) => {
        let r = await this.step(label, 'uv', [...args, '--system-certs']);
        if (r.code !== 0 && /unexpected argument|unrecognized|--system-certs/i.test(r.output))
          r = await this.step(`${label} (older uv)`, 'uv', [...args, '--native-tls']);
        return r;
      };
      if (!existsSync(python)) {
        const r = await withCerts(`creating ${venv}`, ['venv', venv]);
        if (r.code !== 0) return this.fail('could not create the environment');
      }
      const r = await withCerts(`installing ${this.pkg.spec}`, [
        'pip',
        'install',
        '--python',
        python,
        this.pkg.spec,
      ]);
      if (r.code !== 0) return this.fail(`could not install ${this.pkg.spec}`);
    } else {
      this.say('uv not found: using Python’s own venv and pip');
      if (!existsSync(python)) {
        const base = process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python'];
        let created = false;
        for (const exe of base) {
          const r = await this.step(`creating ${venv} with ${exe}`, exe, ['-m', 'venv', venv]);
          if (r.code === 0) {
            created = true;
            break;
          }
        }
        if (!created)
          return this.fail('no Python found to create the environment (install Python or uv)');
      }
      const r = await this.step(`installing ${this.pkg.spec}`, python, [
        '-m',
        'pip',
        'install',
        this.pkg.spec,
      ]);
      if (r.code !== 0) return this.fail(`could not install ${this.pkg.spec}`);
    }
    const check = await this.step(
      `checking that ${this.pkg.module} imports`,
      python,
      ['-c', `import ${this.pkg.module}`],
      60_000,
    );
    if (check.code !== 0) return this.fail(`${this.pkg.module} does not import`);
    this.say('ready: the Outlook sync uses this environment automatically');
    return true;
  }

  private fail(message: string): false {
    this.say(`failed: ${message}`);
    return false;
  }
}

let shared: PythonSetup | null = null;
export function pythonSetup(): PythonSetup {
  shared ??= new PythonSetup();
  return shared;
}
