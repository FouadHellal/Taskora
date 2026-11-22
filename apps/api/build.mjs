// Bundles the API and worker into dist/ (workspace packages are inlined,
// node_modules dependencies stay external).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@taskora/'));

await build({
  entryPoints: ['src/server.ts', 'src/worker.ts', 'src/db/migrate-cli.ts', 'src/db/seed/demo-cli.ts', 'src/cli/reset-password.ts', 'src/cli/api-docs.ts', 'src/cli/migration.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
