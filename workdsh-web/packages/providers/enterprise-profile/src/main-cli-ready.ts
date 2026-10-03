import { isAbsolute } from 'node:path';
import { denied, integer, record, text } from './main-ipc-data.js';

/** Private Node IPC only. Neither bootstrap nor readiness is a Renderer DTO. */
export interface MainCliOnlineBootstrap { readonly frontendIndex: string; readonly nonce: string }
export interface MainCliReady { readonly host: '127.0.0.1'; readonly port: number; readonly authenticatedUrl: string }
export interface MainCliOnlineOwner { readonly frontendIndex: string; readonly onReady: (ready: MainCliReady) => void }
export function onlineBootstrap(value: unknown): MainCliOnlineBootstrap {
  const v = record(value, ['frontendIndex', 'nonce']);
  const frontendIndex = text(v.frontendIndex, 4096), nonce = text(v.nonce, 64);
  if (!isAbsolute(frontendIndex) || /[\u0000-\u001f\u007f]/u.test(frontendIndex)
    || !/^[a-f0-9-]{36}$/u.test(nonce)) denied();
  return Object.freeze({ frontendIndex, nonce });
}
/** Canonical original Connection URL; its token stays inside Main and the child. */
export function cliReady(value: unknown): MainCliReady {
  const v = record(value, ['host', 'port', 'authenticatedUrl']);
  const port = integer(v.port, 65535), authenticatedUrl = text(v.authenticatedUrl, 4096);
  if (v.host !== '127.0.0.1' || !port) denied();
  const url = new URL(authenticatedUrl), token = url.searchParams.get('token');
  if (url.origin !== `http://127.0.0.1:${port}` || url.pathname !== '/' || url.username || url.password || url.hash
    || !token || !/^[A-Za-z0-9_-]{16,256}$/u.test(token) || [...url.searchParams.keys()].join() !== 'token'
    || url.href !== `http://127.0.0.1:${port}/?token=${token}`) denied();
  return Object.freeze({ host: '127.0.0.1', port, authenticatedUrl });
}
