import { Context, Service } from '@deepseek-ai/cordis';
import type { HostConnectionHandle, HostConnectionRpc, ConnectionTrustRequest, ConnectionIndexRequest, ConnectionIndexResponse } from '@deepseek-ai/dsh-client-connection';
import { EnterpriseProfileError } from './snapshot-authority.js';
import type {} from './native-ws-http-admission.js';
declare module '@deepseek-ai/cordis' {
  interface Context { afosNativeParentConnection: HostConnectionHandle; }
}
/** The original mux receives the parent's authentication/Peer, with no shared RPC ownership. */
export default class NativeMuxConnectionCapability extends Service {
  static inject = ['afosNativeParentConnection', 'afosNativeHttpProof'];
  readonly rpc: HostConnectionRpc;
  constructor(ctx: Context) {
    super(ctx, 'connection');
    this.rpc = Object.freeze({
      handle: () => { throw new EnterpriseProfileError('afos/native-read-denied'); },
      // Gateway normally contributes its RPC interceptor. This mux-only scope has
      // zero RPC contribution; the existing fixed parent Ingress stays sole owner.
      intercept: (channel: '/api') => {
        if (channel !== '/api') throw new EnterpriseProfileError('afos/native-read-denied');
        return async () => {};
      },
    });
  }
  get operator() { return this.ctx.afosNativeParentConnection.operator; }
  get fetch() { return this.ctx.afosNativeParentConnection.fetch; }
  admit = (request: ConnectionTrustRequest) => {
    const admission = this.ctx.afosNativeParentConnection.admit(request);
    if ('rejection' in admission) return admission;
    try { const peer = this.ctx.afosNativeHttpProof.carrierPeer(request, admission.peer); return peer ? { peer } : { rejection: 403 as const }; }
    catch { return { rejection: 403 as const }; }
  };
  requestRejection = (request: ConnectionTrustRequest) => this.ctx.afosNativeParentConnection.requestRejection(request);
  createSharedFetchHandler = (channel: '/api') => this.ctx.afosNativeParentConnection.createSharedFetchHandler(channel);
  authorizeIndex = (request: ConnectionIndexRequest, response: ConnectionIndexResponse) => this.ctx.afosNativeParentConnection.authorizeIndex(request, response);
  authenticatedUrl = (baseUrl: string) => this.ctx.afosNativeParentConnection.authenticatedUrl(baseUrl);
}
