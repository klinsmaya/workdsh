import { defineConfig } from 'tsdown'

// Installers ship this Electron carrier and the bundled WorkDSH Profile only.
export default defineConfig([{
  entry: { 'workdsh-main': 'src/workdsh-main.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
}, {
  entry: { 'enterprise-preload': 'src/enterprise-preload.ts' },
  outDir: 'lib', format: 'cjs', platform: 'node', target: 'es2024',
  fixedExtension: true, dts: false, clean: false, sourcemap: true,
}])
