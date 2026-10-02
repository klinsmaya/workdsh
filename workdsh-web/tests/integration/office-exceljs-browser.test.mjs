import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { exceljsBrowserPlugin, officeBrowserInject, verifyExceljsBrowserInputs } from '../../scripts/exceljs-browser.mjs';

const office = resolve('packages/plugins/office');
const officeRequire = createRequire(resolve(office, 'package.json'));
const excelRoot = dirname(officeRequire.resolve('exceljs/package.json'));
const product = path => JSON.stringify(resolve(office, path));
const fixture = await build({
  stdin: {
    resolveDir: excelRoot,
    contents: `
      export {default as ExcelJS} from 'exceljs';
      export const {v3, v4, v5, validate, version} = require('uuid');
      export {importWorkbook, exportWorkbook} from ${product('src/excel-adapter.js')};
      export {spreadsheetXlsx} from ${product('src/spreadsheet/xlsx.ts')};
      export {createHash, getHashes, randomBytes} from ${JSON.stringify(resolve('scripts/browser/exceljs-crypto.mjs'))};
    `,
  },
  bundle: true, write: false, metafile: true, platform: 'browser', format: 'iife', globalName: 'OfficeExcelFixture',
  plugins: [exceljsBrowserPlugin()], inject: officeBrowserInject,
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
});
verifyExceljsBrowserInputs(fixture.metafile);
const fixtureCode = fixture.outputFiles[0].text;
const executablePath = process.env.AFOS_TEST_CHROMIUM;

async function withBrowser(run) {
  const browser = await chromium.launch({ headless: true, executablePath });
  try { await run(browser); } finally { await browser.close(); }
}
async function fixturePage(browser, {withoutCrypto = false} = {}) {
  const page = await browser.newPage();
  if (withoutCrypto) await page.addInitScript(() => Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true }));
  await page.route('https://office-source.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
  await page.goto('https://office-source.test/fixture');
  await page.addScriptTag({content: fixtureCode});
  return page;
}

test('Real browser XLSX, UUID bounds, images, conditional-format IDs and synchronous protection match Node', async () => {
  await withBrowser(async browser => {
    const page = await fixturePage(browser);
    const result = await page.evaluate(async () => {
      const f = OfficeExcelFixture;
      for (const api of ['v3', 'v5']) for (const [length, offset] of [[8, 4], [16, -1], [16, 1]]) {
        let error; try { f[api]('probe', f.v5.DNS, new Uint8Array(length), offset); } catch (e) { error = e; }
        if (error?.name !== 'RangeError') throw new Error(`${api} failed to reject buffer bounds`);
      }
      const h = f.createHash('sha512').update('abc');
      const hash = h.digest('hex');
      let reuses = 0; for (const run of [() => h.update('x'), () => h.digest()]) { try { run(); } catch { reuses++; } }
      if (reuses !== 2) throw new Error('Hash finalize guard failed');
      try { f.createHash('sha256'); throw new Error('Unsupported hash accepted'); } catch (e) { if (e.message === 'Unsupported hash accepted') throw e; }
      const random = f.randomBytes(16); if (random.length !== 16) throw new Error('CSPRNG output size');
      const wb = new f.ExcelJS.Workbook(), ws = wb.addWorksheet('Roundtrip');
      ws.getCell('A1').value = '企业材料'; ws.getCell('A2').value = 19; ws.getCell('A3').value = {formula: 'SUM(A2,1)', result: 20};
      ws.addConditionalFormatting({ref: 'A1', rules: [{type: 'iconSet', iconSet: '3Stars', cfvo: [{type: 'percent', value: 0}, {type: 'percent', value: 33}, {type: 'percent', value: 66}]}]});
      const image = wb.addImage({base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', extension: 'png'});
      ws.addImage(image, 'B1:C3');
      await ws.protect('fixture-password', {spinCount: 7});
      const bytes = await wb.xlsx.writeBuffer(), restored = new f.ExcelJS.Workbook(); await restored.xlsx.load(bytes);
      const sheet = restored.getWorksheet('Roundtrip');
      if (sheet.getCell('A1').value !== '企业材料' || sheet.getCell('A3').formula !== 'SUM(A2,1)' || restored.model.media.length !== 1) throw new Error('XLSX model lost content');
      const id = sheet.conditionalFormattings[0].rules[0].x14Id?.replace(/[{}]/g, '').toLowerCase();
      if (!f.validate(id) || f.version(id) !== 4) throw new Error('Conditional format UUID v4 not preserved');
      let denied = 0;
      for (const run of [() => wb.xlsx.readFile('not-a-real-file.xlsx'), () => wb.xlsx.writeFile('not-a-real-file.xlsx')]) {
        try { await run(); } catch (e) { if (e.code === 'AFOS_OFFICE_BROWSER_FS_DENIED') denied++; else throw e; }
      }
      if (denied !== 2) throw new Error('Browser filesystem did not refuse');
      return {hash, protection: sheet.sheetProtection, xlsxBytes: [...bytes], conditionalId: id, filesystemRefusals: denied, browser: navigator.userAgent};
    });
    assert.equal(result.hash, createHash('sha512').update('abc').digest('hex'));
    const Encryptor = officeRequire('exceljs/lib/utils/encryptor.js');
    assert.equal(result.protection.hashValue, Encryptor.convertPasswordToHash('fixture-password', 'sha512', result.protection.saltValue, 7));
    const NodeExcel = officeRequire('exceljs'), restored = new NodeExcel.Workbook(); await restored.xlsx.load(Uint8Array.from(result.xlsxBytes));
    assert.equal(restored.getWorksheet('Roundtrip').getCell('A3').formula, 'SUM(A2,1)');
    assert.equal(restored.model.media.length, 1);
  });
});

test('Actual WorkDSH spreadsheet generation and compatibility import/export survive a fresh browser context', async () => {
  await withBrowser(async browser => {
    for (let cold = 0; cold < 2; cold++) {
      const page = await fixturePage(browser);
      const bytes = await page.evaluate(async () => {
        const f = OfficeExcelFixture;
        const data = await f.spreadsheetXlsx({state: {modelVersion: 1, sheetOrder: ['sheet-1'], sheets: {'sheet-1': {sheetId: 'sheet-1', name: '企业材料', cells: {A1: {value: '安全浏览器导出'}, A2: {value: 12}, A3: {formula: '=SUM(A2,1)'}}}}}});
        const imported = await f.importWorkbook(data), id = imported.snapshot.sheetOrder[0];
        imported.snapshot.sheets[id].cellData[1][0] = {v: 24, t: 2};
        return [...await f.exportWorkbook(imported, imported.snapshot)];
      });
      const NodeExcel = officeRequire('exceljs'), restored = new NodeExcel.Workbook(); await restored.xlsx.load(Uint8Array.from(bytes));
      const sheet = restored.getWorksheet('企业材料'); assert.equal(sheet.getCell('A1').value, '安全浏览器导出'); assert.equal(sheet.getCell('A2').value, 24); assert.equal(sheet.getCell('A3').formula, 'SUM(A2,1)');
      await page.close();
    }
    const noCrypto = await fixturePage(browser, {withoutCrypto: true});
    assert.equal(await noCrypto.evaluate(() => {try {OfficeExcelFixture.randomBytes(16); return false;} catch {return true;}}), true, 'Missing CSPRNG must fail');
  });
});

test('Both actual Office browser artifacts exclude the precompiled entry; real editor opens and exports XLSX after cold loading', async () => {
  const inputs = JSON.parse(await readFile(resolve(office, 'dist/browser-build-inputs.json'), 'utf8'));
  for (const scope of ['editor', 'client']) {
    assert.equal(inputs[scope].uuid, '11.1.1'); assert.equal(inputs[scope].sourceEntry, 'exceljs/lib/exceljs.bare.js');
    assert.ok(!inputs[scope].inputs.some(path => /\/exceljs\/dist\/|uuid@8\./.test(path)));
  }
  const html = await readFile(resolve(office, 'dist/editor.html'), 'utf8'), client = await readFile(resolve(office, 'dist/client.browser.js'), 'utf8');
  assert.ok(!html.includes('exceljs/dist/exceljs.min.js')); assert.ok(!client.includes('exceljs/dist/exceljs.min.js'));
  const NodeExcel = officeRequire('exceljs'), wb = new NodeExcel.Workbook(), sheet = wb.addWorksheet('ColdLoad'); sheet.getCell('A1').value = '真实编辑器'; sheet.getCell('A2').value = 17;
  const bytes = [...await wb.xlsx.writeBuffer()];
  await withBrowser(async browser => {
    for (let cold = 0; cold < 2; cold++) {
      const page = await browser.newPage({acceptDownloads: true}), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://office-source.test/editor', route => route.fulfill({contentType: 'text/html', body: html}));
      await page.goto('https://office-source.test/editor');
      await page.evaluate(bytes => window.postMessage({type: 'workdsh-office-open', bytes: Uint8Array.from(bytes), extension: 'xlsx'}, '*'), bytes);
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Excel 支持单元格值'), undefined, {timeout: 20000});
      const downloading = page.waitForEvent('download'); await page.locator('#save').click(); const download = await downloading;
      const path = await download.path(); assert.ok(path); const exported = new NodeExcel.Workbook(); await exported.xlsx.load(await readFile(path));
      assert.equal(exported.getWorksheet('ColdLoad').getCell('A1').value, '真实编辑器'); assert.equal(exported.getWorksheet('ColdLoad').getCell('A2').value, 17);
      assert.deepEqual(errors, []); await page.close();
    }
  });
});

test('Actual shipped client factory cold loads and its spreadsheet download exports real bytes', async () => {
  const support = await build({
    stdin: {resolveDir: office, contents: `
      import React from 'react';
      import * as ReactDOM from 'react-dom';
      import * as ReactDOMClient from 'react-dom/client';
      import * as JSX from 'react/jsx-runtime';
      const deps = {'react': React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient, 'react/jsx-runtime': JSX};
      window.__ModuleLoader__ = {load(descriptor) {
        if (descriptor.id !== 'workdsh-plugin-office') throw new Error('Unexpected module');
        window.actualOfficeClient = descriptor.factory(name => {
          if (!(name in deps)) throw new Error('Unexpected external dependency: ' + name);
          return deps[name];
        });
      }};
    `}, bundle: true, write: false, platform: 'browser', format: 'iife', define: {'process.env.NODE_ENV': '"production"'},
  });
  const client = await readFile(resolve(office, 'dist/client.browser.js'), 'utf8');
  await withBrowser(async browser => {
    for (let cold = 0; cold < 2; cold++) {
      const page = await browser.newPage({acceptDownloads: true}), errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://office-source.test/client', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><div id="root"></div>'}));
      await page.route('https://office-source.test/api/workdsh-office', route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({contentType: 'application/json', body: JSON.stringify({ok: true, value: {kind: 'spreadsheet', title: '实际客户端导出', state: {modelVersion: 1, sheetOrder: ['sheet-1'], sheets: {'sheet-1': {sheetId: 'sheet-1', name: 'ClientDownload', cells: {A1: {value: '已冷载'}, A2: {value: 31}, A3: {formula: '=SUM(A2,1)'}}}}}}})});
      });
      await page.goto('https://office-source.test/client');
      await page.addScriptTag({content: support.outputFiles[0].text});
      await page.addScriptTag({content: client});
      const downloading = page.waitForEvent('download');
      await page.evaluate(async () => {
        const module = window.actualOfficeClient;
        if (module.name !== 'workdsh-office-client') throw new Error('Client factory did not initialize');
        const registrations = [], disposers = [];
        const noRegistration = () => () => {};
        const ctx = {
          effect(fn) {const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose);},
          inject(_keys, callback) {callback(ctx);},
          workdshLibraryPreview: {register: noRegistration},
          documentPreviews: {register: noRegistration},
          sidebarRightTabs: {register: noRegistration},
          sidebarRight: {openTabIn() {}},
          inputTriggers: {registerSource: noRegistration},
          sessions: {list: {getSnapshot: () => ({byId: {}})}},
          slots: {inject(_key, callback) {callback();}, register(meta) {registrations.push(meta); return () => {};}},
        };
        module.apply(ctx);
        const office = registrations.find(row => row.key === 'workdsh-office').inject().office;
        try {await office.download('fixture-session', 'fixture-document');} finally {for (const dispose of disposers.reverse()) dispose();}
      });
      const download = await downloading, path = await download.path(); assert.ok(path);
      const NodeExcel = officeRequire('exceljs'), restored = new NodeExcel.Workbook(); await restored.xlsx.load(await readFile(path));
      const sheet = restored.getWorksheet('ClientDownload'); assert.equal(sheet.getCell('A1').value, '已冷载'); assert.equal(sheet.getCell('A2').value, 31); assert.equal(sheet.getCell('A3').formula, 'SUM(A2,1)');
      assert.equal(requests.length, 1); assert.equal(requests[0].request.endpoint, 'read'); assert.deepEqual(errors, []);
      await page.close();
    }
  });
});
