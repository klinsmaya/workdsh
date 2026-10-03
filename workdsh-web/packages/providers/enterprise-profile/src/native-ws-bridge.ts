import type { Context } from '@deepseek-ai/cordis';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import { EnterpriseNativeReadBridge } from './native-reads.js';
declare module '@deepseek-ai/cordis' {
  interface Context { afosNativePrivateController: SessionController; afosNativePrivateReader: Context; }
}
/** Official Loader entry for the existing bridge in the explicit mux composition. */
export default class NativeWsBridge extends EnterpriseNativeReadBridge {
  static inject = [...EnterpriseNativeReadBridge.inject, 'afosNativePrivateController', 'afosNativePrivateReader'];
  constructor(ctx: Context, config: { readonly workspace: string }) {
    super(ctx, { controller: ctx.afosNativePrivateController, reader: ctx.afosNativePrivateReader, workspace: config.workspace, requireCallerProof: true });
  }
}
