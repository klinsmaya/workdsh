import { createRequire } from 'node:module';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const web = fileURLToPath(new URL('../../workdsh-web/', import.meta.url));
const online = process.argv.length === 3 && process.argv[2] === '--online';
if (process.argv.length !== 2 && !online) throw Error('enterprise/client-build-mode-refused');
const face = online ? 'afos-online' : 'afos-local';
const ownId = 'workdsh-plugin-enterprise-drafts' + (online ? '' : '-local');
const out = join(desktop, 'renderer', face);
const local = join(web, 'packages', 'plugins', 'enterprise-drafts');
const rootRequire = createRequire(join(web, 'package.json'));
const webRequire = createRequire(createRequire(rootRequire.resolve('@deepseek-ai/dsh/package.json')).resolve('@deepseek-ai/dsh-web-app/package.json'));
const { bootInjections, orderByModuleGraph } = await import(pathToFileURL(webRequire.resolve('@deepseek-ai/dsh-client-modules')).href);
const frontend = dirname(webRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json'));
if (JSON.parse(await readFile(join(frontend, 'package.json'), 'utf8')).version !== '0.1.7-rc.2') throw Error('enterprise/client-version-refused');
const rows = new Map(), outputs = new Map();
const statics = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']);
async function add(name) {
  name = name.replace(/\/client$/, ''); if (rows.has(name) || statics.has(name)) return;
  const own = name === ownId;
  const packagePath = own ? join(local, 'package.json') : webRequire.resolve(name + '/package.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  const declaration = own ? (online ? manifest.dsh.client : manifest.dsh.localClient) : manifest.dsh?.client;
  if (!declaration || (!own && manifest.version !== '0.1.7-rc.2')) throw Error('enterprise/client-version-refused');
  const source = own ? join(local, manifest.exports[online ? './client' : './local-client'].default) : webRequire.resolve(name + '/client');
  const bytes = await readFile(source), rev = createHash('sha256').update(bytes).digest('hex');
  const url = '/plugins/' + name.replaceAll('@', '').replaceAll('/', '-') + '.js';
  rows.set(name, { id: name, url, rev, inject: declaration.inject ?? [], external: declaration.external ?? [], immediately: declaration.immediately ?? false });
  outputs.set(url.slice(1), bytes);
  for (const dependency of [...(declaration.inject ?? []), ...(declaration.external ?? [])]) await add(dependency);
}
await add('@deepseek-ai/dsh-client-modules');
await add(ownId);
// Use the existing original layout/sidebar/session components; no copied shell or Conversation.
await add('@deepseek-ai/dsh-client-ui-chat');
const entries = orderByModuleGraph([...rows.values()]);
const graph = { rev: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries,
  batches: entries.map(row => ({ phase: row.id === '@deepseek-ai/dsh-client-modules' ? 'bootstrap' : 'application', url: row.url, rev: row.rev, entries: [row.id] })) };
const tags = [];
for (const [index, injection] of bootInjections(graph).entries()) {
  if (injection.kind === 'script' || injection.kind === 'global') {
    const file = 'boot-' + index + '.js';
    outputs.set(file, Buffer.from(injection.kind === 'script' ? injection.text : `window[${JSON.stringify(injection.name)}]=${JSON.stringify(injection.value)};`));
    tags.push(`<script src="/${file}"></script>`);
  } else if (injection.kind === 'script-src') tags.push(`<script src="${injection.src}"></script>`);
  else if (injection.kind === 'script-preload') tags.push(`<link rel="preload" as="script" href="${injection.src}">`);
  else throw Error('enterprise/client-injection-refused');
}
async function assets(relative) {
  for (const entry of await readdir(join(frontend, 'dist', relative), { withFileTypes: true })) {
    const path = join(relative, entry.name), absolute = join(frontend, 'dist', path), stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw Error('enterprise/client-assets-refused');
    if (stat.isDirectory()) await assets(path);
    else if (stat.isFile()) outputs.set(path, await readFile(absolute));
    else throw Error('enterprise/client-assets-refused');
  }
}
await assets('assets');
let html = await readFile(join(frontend, 'dist', 'index.html'), 'utf8');
html = html.replace('<head>', '<head>' + tags.join('\n'));
outputs.set('index.html', Buffer.from(html));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const files = []; let total = 0;
for (const [file, bytes] of outputs) {
  if (bytes.length > 16 * 1048576 || (total += bytes.length) > 64 * 1048576) throw Error('enterprise/client-assets-refused');
  await mkdir(dirname(join(out, file)), { recursive: true });
  await writeFile(join(out, file), bytes);
  files.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), type: types[extname(file)] ?? 'application/octet-stream' });
}
await writeFile(join(out, 'assets.json'), JSON.stringify({ contractVersion: online ? 'afos.online-assets.v1' : 'afos.local-assets.v1', files }, null, 2) + '\n');
console.log(JSON.stringify({ modules: entries.length, files: files.length, bytes: total, out, originalModuleSystem: true, originalLayout: true, clientExport: online ? './client' : './local-client' }));
