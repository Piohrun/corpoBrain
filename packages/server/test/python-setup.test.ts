import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PythonSetup, type Runner, venvPython } from '../src/python-setup.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-pysetup-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fake machine: which programs exist, and what each command answers. */
function machine(opts: {
  uv?: string | null;
  oldUv?: boolean;
  pipFails?: boolean;
  python?: string[];
}) {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'uv') {
      if (!opts.uv) return { code: null, output: 'spawn uv ENOENT' };
      if (args[0] === '--version') return { code: 0, output: opts.uv };
      if (opts.oldUv && args.includes('--system-certs'))
        return { code: 2, output: "error: unexpected argument '--system-certs' found" };
      if (args[0] === 'venv') {
        mkdirSync(dirname(venvPython(root)), { recursive: true });
        writeFileSync(venvPython(root), '');
        return { code: 0, output: 'Creating virtual environment at: .venv' };
      }
      if (args[0] === 'pip')
        return opts.pipFails
          ? { code: 1, output: 'network error' }
          : { code: 0, output: 'Installed 1 package' };
    }
    if (opts.python?.includes(cmd) && args[1] === 'venv') {
      mkdirSync(dirname(venvPython(root)), { recursive: true });
      writeFileSync(venvPython(root), '');
      return { code: 0, output: '' };
    }
    if (cmd === venvPython(root)) {
      if (args[1] === 'pip')
        return opts.pipFails
          ? { code: 1, output: 'no network' }
          : { code: 0, output: 'Successfully installed comtypes' };
      if (args[0] === '-c') return { code: 0, output: '' };
    }
    return { code: null, output: `spawn ${cmd} ENOENT` };
  };
  return { run, calls };
}

const finished = async (setup: PythonSetup) => {
  await vi.waitFor(() => expect(setup.status.running).toBe(false));
  return setup.status;
};

describe('Python setup for Outlook', () => {
  it('creates .venv with uv, trusting the system certificate store, and installs comtypes', async () => {
    const { run, calls } = machine({ uv: 'uv 0.9.2' });
    const setup = new PythonSetup(root, run);
    expect(await setup.ready()).toBe(false);
    setup.start();
    expect((await finished(setup)).ok).toBe(true);
    expect(calls).toEqual([
      'uv --version',
      `uv venv ${join(root, '.venv')} --system-certs`,
      `uv pip install --python ${venvPython(root)} comtypes>=1.4 --system-certs`,
      `${venvPython(root)} -c import comtypes.client`,
    ]);
    expect(await setup.ready()).toBe(true);
    expect(setup.status.log.at(-1)).toContain('ready');
  });

  it('falls back to --native-tls on an older uv', async () => {
    const { run, calls } = machine({ uv: 'uv 0.4.0', oldUv: true });
    const setup = new PythonSetup(root, run);
    setup.start();
    expect((await finished(setup)).ok).toBe(true);
    expect(calls.filter((c) => c.includes('--native-tls'))).toHaveLength(2);
  });

  it('uses Python’s own venv and pip when uv is not installed', async () => {
    const { run, calls } = machine({ uv: null, python: ['py', 'python3'] });
    const setup = new PythonSetup(root, run);
    setup.start();
    expect((await finished(setup)).ok).toBe(true);
    expect(calls.some((c) => c.endsWith(`-m venv ${join(root, '.venv')}`))).toBe(true);
    expect(calls).toContain(`${venvPython(root)} -m pip install comtypes>=1.4`);
  });

  it('reports a failed install and leaves the next attempt possible', async () => {
    const { run } = machine({ uv: 'uv 0.9.2', pipFails: true });
    const setup = new PythonSetup(root, run);
    setup.start();
    const status = await finished(setup);
    expect(status.ok).toBe(false);
    expect(status.log.join('\n')).toMatch(/network error[\s\S]*failed: could not install comtypes/);
    expect(setup.start().running).toBe(true);
    await finished(setup);
  });

  it('skips creating the environment when it already exists', async () => {
    mkdirSync(dirname(venvPython(root)), { recursive: true });
    writeFileSync(venvPython(root), '');
    const { run, calls } = machine({ uv: 'uv 0.9.2' });
    const setup = new PythonSetup(root, run);
    setup.start();
    expect((await finished(setup)).ok).toBe(true);
    expect(calls.some((c) => c.startsWith('uv venv'))).toBe(false);
  });
});
