/**
 * Core session, runner and orchestration code depends only on core types. The files and git modules implement
 * `src/session/cwd.ts`, and the composition root injects them. A feature import here would make core code depend on a
 * feature again, which is the inversion the cwd resolver removed.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');
const CORE = ['session', 'orchestration'].map((d) => path.join(SRC, d)).concat(path.join(SRC, 'agent', 'runner.ts'));
const FEATURES = ['files', 'git', 'projects'].map((d) => path.join(SRC, d));

/** `from '...'`, `import('...')`, `require('...')` and `import '...'`, type-only imports included. */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function tsFiles(entry: string): string[] {
  if (!fs.statSync(entry).isDirectory()) return [entry];
  return fs.readdirSync(entry, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(entry, d.name);
    return d.isDirectory() ? tsFiles(full) : d.name.endsWith('.ts') ? [full] : [];
  });
}

/** The feature modules `text`, read as the source of `file`, imports, as `file -> specifier`. */
function featureImportsIn(file: string, text: string): string[] {
  return [...text.matchAll(SPECIFIER_RE)]
    .map((m) => m[1]!)
    .filter((spec) => spec.startsWith('.'))
    .filter((spec) => {
      const target = path.resolve(path.dirname(file), spec);
      return FEATURES.some((feature) => target === feature || target.startsWith(feature + path.sep));
    })
    .map((spec) => `${path.relative(SRC, file)} -> ${spec}`);
}

describe('import direction', () => {
  const files = CORE.flatMap(tsFiles);

  it('scans the session, orchestration and runner sources', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(path.join(SRC, 'agent', 'runner.ts'));
    expect(files).toContain(path.join(SRC, 'session', 'process.ts'));
    expect(files).toContain(path.join(SRC, 'orchestration', 'tasks', 'driver.ts'));
  });

  it('finds no import of src/files, src/git or src/projects in core code', () => {
    expect(files.flatMap((file) => featureImportsIn(file, fs.readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('catches every import form the rule must see', () => {
    const probe = [
      "import { resolveDir } from '../../files/fs';",
      "import type { GitStatus } from '../../git/status';",
      "const lazy = () => import('../../files/holds');",
      "const old = require('../../projects/chat');",
      "import '../../files/marks';",
      "import { CwdResolver } from '../cwd';",
      "import { pathWithin } from '../../utils/paths';",
    ].join('\n');
    expect(featureImportsIn(path.join(SRC, 'session', 'tasks', 'probe.ts'), probe).map((hit) => hit.split(' -> ')[1])).toEqual([
      '../../files/fs', '../../git/status', '../../files/holds', '../../projects/chat', '../../files/marks',
    ]);
  });
});
