import type { Context } from '@deepseek-ai/cordis';
import type {} from './native-captures.js';
export default {
  name: 'afos-owned-native-mux-capture',
  inject: ['connection', 'typertGateway', 'webServer', 'afosOwnedNativeMuxRead', 'afosNativeAssemblyCapture'],
  apply(ctx: Context) { ctx.afosNativeAssemblyCapture.mux?.(ctx); },
};
