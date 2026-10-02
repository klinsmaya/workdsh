import Sha512 from 'sha.js/sha512.js';
import randomBytes from 'randombytes/browser.js';

// ExcelJS 4.4.0 worksheet.protect always uses SHA-512 synchronously. Keep that
// real behavior and CSPRNG without introducing unused ECDSA/signing APIs.
export function getHashes() {
  return ['sha512'];
}

export function createHash(algorithm) {
  if (typeof algorithm !== 'string' || algorithm.toLowerCase() !== 'sha512') {
    throw new Error('Office browser supports SHA-512 worksheet protection only.');
  }
  const hash = new Sha512();
  let finalized = false;
  const ensureOpen = () => {
    if (finalized) throw new Error('Hash has already been finalized.');
  };
  const facade = {
    update(data, encoding) {
      ensureOpen();
      hash.update(data, encoding);
      return facade;
    },
    digest(encoding) {
      ensureOpen();
      finalized = true;
      return hash.digest(encoding);
    },
  };
  return facade;
}

export { randomBytes };
export default { createHash, getHashes, randomBytes };
