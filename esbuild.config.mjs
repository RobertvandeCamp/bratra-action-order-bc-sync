import { build } from 'esbuild';

await build({
  entryPoints: {
    'dispatcher/handler': 'src/dispatcher/handler.ts',
    'verifier/handler': 'src/verifier/handler.ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node22',
  outdir: 'dist',
  external: ['@aws-sdk/*'],
  minify: false,
  sourcemap: true,
});
