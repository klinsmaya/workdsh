'use strict';

function unavailable() {
  const error = new Error('Filesystem APIs are unavailable in the Office browser. Use the authorized Office file workflow.');
  error.code = 'AFOS_OFFICE_BROWSER_FS_DENIED';
  throw error;
}

// The document-workbook API uses buffers. Keep accidental Node file operations
// explicit failures instead of a successful empty filesystem or a host bridge.
module.exports = Object.freeze({
  constants: Object.freeze({ F_OK: 0 }),
  access: unavailable,
  accessSync: unavailable,
  stat: unavailable,
  readFile: unavailable,
  readFileSync: unavailable,
  writeFile: unavailable,
  writeFileSync: unavailable,
  createReadStream: unavailable,
  createWriteStream: unavailable,
  existsSync: unavailable,
  promises: Object.freeze({ stat: unavailable, readFile: unavailable, writeFile: unavailable }),
});
