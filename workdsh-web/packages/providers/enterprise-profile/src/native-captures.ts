import type { Context } from '@deepseek-ai/cordis';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-api-gateway';
import type {} from '@deepseek-ai/dsh-client-connection';

export interface NativeAssemblyCaptures {
  controller(controller: SessionController): void;
  reader(context: Context): void;
}
declare module '@deepseek-ai/cordis' {
  interface Context { afosNativeAssemblyCapture: NativeAssemblyCaptures; }
}
export const ControllerCapture = {
  name: 'afos-native-controller-capture', inject: ['sessionController', 'afosNativeAssemblyCapture'],
  apply(ctx: Context) { ctx.afosNativeAssemblyCapture.controller(ctx.sessionController); },
};
export const ReaderCapture = {
  name: 'afos-native-reader-capture', inject: ['connection', 'typert', 'typertGateway', 'agents', 'sessions', 'afosNativeAssemblyCapture'],
  apply(ctx: Context) { ctx.afosNativeAssemblyCapture.reader(ctx); },
};
