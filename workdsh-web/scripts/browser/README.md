# Office browser compatibility

The Office editor and client build the exact published ExcelJS 4.4.0
`lib/exceljs.bare.js` source. The existing consuming override selects UUID
11.1.1; the browser build refuses the old precompiled ExcelJS artifact and
checks its actual UUID browser inputs. The Node Host keeps its normal entry.

Exact Web build dependencies provide Buffer, process, events, stream and util.
`fs-denied.cjs` rejects Node file operations with a stable error. It provides
no filesystem bridge. `exceljs-crypto.mjs` is limited to the synchronous SHA512
and CSPRNG APIs used by ExcelJS worksheet protection, using official sha.js and
randombytes browser sources. It rejects other hash algorithms and finalized
hash reuse. It does not replace global WebCrypto. SHA.js requires both MIT and
BSD-3-Clause notices; the build includes the actual dependency license texts.

Run the owning Office build, then:

```sh
corepack pnpm --filter workdsh-plugin-office build
node --test tests/integration/office-exceljs-browser.test.mjs
corepack pnpm audit --json --registry=https://registry.npmjs.org
```

The browser test uses the pinned Playwright browser by default. Set
`AFOS_TEST_CHROMIUM` to an authorized local Chromium executable when needed.
The test checks real XLSX/UUID/protection behavior, filesystem refusal and
both built artifacts through fresh browser contexts. Its client Host response
is a local fixture; it does not establish SQL, IdP, desktop OS, signatures or
enterprise acceptance. Registry results describe the locked graph at that
time. The independent Bridge PDF.js and native node-forge findings remain.

回滚时一起撤销消费方构建适配和新增 build dependencies，按锁重新安装、重建
两份 Office 产物并重跑消费测试。无需修改上游 checkout 或业务数据。
