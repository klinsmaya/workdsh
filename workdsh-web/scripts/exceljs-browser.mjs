import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../package.json', import.meta.url));
const officeRequire = createRequire(new URL('../packages/plugins/office/package.json', import.meta.url));
const excelManifestPath = officeRequire.resolve('exceljs/package.json');
const excelManifest = JSON.parse(readFileSync(excelManifestPath, 'utf8'));
const excelRequire = createRequire(excelManifestPath);
const uuidManifestPath = excelRequire.resolve('uuid/package.json');
const uuidManifest = JSON.parse(readFileSync(uuidManifestPath, 'utf8'));

if (excelManifest.version !== '4.4.0' || uuidManifest.version !== '11.1.1') {
  throw new Error('Office browser requires the reviewed ExcelJS 4.4.0 / UUID 11.1.1 consuming graph.');
}

const excelSource = join(dirname(excelManifestPath), 'lib/exceljs.bare.js');
const aliases = new Map([
  ['buffer', require.resolve('buffer/')],
  ['process', require.resolve('process/browser.js')],
  ['events', require.resolve('events/')],
  ['stream', require.resolve('stream-browserify')],
  ['util', require.resolve('util/')],
  ['crypto', fileURLToPath(new URL('./browser/exceljs-crypto.mjs', import.meta.url))],
  ['fs', fileURLToPath(new URL('./browser/fs-denied.cjs', import.meta.url))],
]);

export const officeBrowserInject = [fileURLToPath(new URL('./browser/globals.mjs', import.meta.url))];

export function exceljsBrowserPlugin() {
  return {
    name: 'office-exceljs-reviewed-browser-source',
    setup(builder) {
      builder.onResolve({ filter: /^exceljs$/ }, () => ({ path: excelSource }));
      builder.onResolve({ filter: /^(?:node:)?(?:buffer|process|events|stream|util|crypto|fs)\/?$/ }, args => {
        const key = args.path.replace(/^node:/, '').replace(/\/$/, '');
        if (key === 'crypto' && !args.importer.replaceAll('\\', '/').endsWith('/exceljs/lib/utils/encryptor.js')) return;
        return { path: aliases.get(key) };
      });
    },
  };
}

export function verifyExceljsBrowserInputs(metafile) {
  const inputs = Object.keys(metafile.inputs);
  const excel = inputs.filter(input => /\/exceljs\//.test(input));
  if (!excel.length) return { spreadsheetIncluded: false };
  if (excel.some(input => /\/exceljs\/dist\//.test(input)) || !excel.some(input => input.endsWith('/exceljs/lib/exceljs.bare.js'))) {
    throw new Error('Office browser included a precompiled ExcelJS artifact instead of the reviewed source entry.');
  }
  const uuidInputs = inputs.filter(input => /\/uuid\//.test(input));
  if (!uuidInputs.length || uuidInputs.some(input => !input.includes('uuid@11.1.1/') || !input.includes('/dist/cjs-browser/'))) {
    throw new Error('Office ExcelJS browser did not resolve the reviewed UUID 11.1.1 browser entry.');
  }
  const uuidSource = realpathSync(join(dirname(uuidManifestPath), 'dist/cjs-browser/v35.js'));
  if (!readFileSync(uuidSource, 'utf8').includes('offset + 16 > buf.length')) {
    throw new Error('Reviewed UUID browser buffer bounds check is absent.');
  }
  return {
    spreadsheetIncluded: true,
    exceljs: excelManifest.version,
    uuid: uuidManifest.version,
    sourceEntry: 'exceljs/lib/exceljs.bare.js',
    uuidEntry: 'uuid/dist/cjs-browser/index.js',
    filesystem: 'explicitly refused in browser; Node Host entry unchanged',
    inputs: inputs.map(input => input.replaceAll('\\', '/')),
  };
}
