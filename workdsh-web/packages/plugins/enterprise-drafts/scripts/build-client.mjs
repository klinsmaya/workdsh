import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
for (const [entry, artifact, id] of [
  ['src/client.tsx', 'dist/client.browser.js', 'workdsh-plugin-enterprise-drafts'],
  ['src/local-client.tsx', 'dist/local-client.browser.js', 'workdsh-plugin-enterprise-drafts-local'],
]) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, root))],
    bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
    external: ['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react-dom', 'react/jsx-runtime'],
  });
  await writeFile(new URL(artifact, root),
    `window.__ModuleLoader__.load({id: ${JSON.stringify(id)}, factory: function(require) { const module = {exports:{}};\n${result.outputFiles[0].text}\nreturn module.exports; }});\n`);
}
