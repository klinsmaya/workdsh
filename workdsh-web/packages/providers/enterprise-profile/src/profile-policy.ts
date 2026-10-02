import { EnterpriseProfileError } from './snapshot-authority.js';

/** Reviewed Host component set. No app/default bundle or user-selected package expands it. */
export const ENTERPRISE_HOST_PACKAGES = Object.freeze([
  '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-agent-preset',
  '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-credentials-local', '@deepseek-ai/dsh-client-connection',
  'workdsh-plugin-audit', 'workdsh-plugin-access', 'workdsh-provider-identity-nocobase',
  'workdsh-provider-enterprise-profile/authority', 'workdsh-provider-enterprise-profile/runtime',
  'workdsh-provider-enterprise-profile', 'workdsh-plugin-enterprise-drafts',
] as const);
export const ENTERPRISE_TOOL_NAMES = Object.freeze(['afos_read_snapshot', 'afos_render_draft'] as const);
export interface EnterpriseComposition {
  readonly contractVersion: 'afos.profile.v1';
  readonly mode: 'enterprise';
  readonly plugins: readonly { readonly name: string; readonly version: string }[];
  readonly toolMode: 'native';
  readonly tools: readonly string[];
  readonly bindHost: '127.0.0.1';
  readonly autoBindPersonalSessions: false;
  readonly rawGateway: false;
  readonly userPatches: false;
  readonly nativeExecution: 'unavailable';
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(right)) return Array.isArray(left) && Object.getPrototypeOf(left) === Array.prototype && left.length === right.length
    && Reflect.ownKeys(left).length === right.length + 1 && right.every((entry, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(left, index);
      return descriptor && 'value' in descriptor && descriptor.enumerable === true && equal(descriptor.value, entry);
    });
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
    || Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) return false;
  const leftKeys = Reflect.ownKeys(left); const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length && rightKeys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(left, key);
    return descriptor && 'value' in descriptor && descriptor.enumerable === true && equal(descriptor.value, Reflect.get(right, key));
  });
}
export function fixedEnterpriseComposition(): EnterpriseComposition {
  return Object.freeze({ contractVersion: 'afos.profile.v1', mode: 'enterprise',
    plugins: Object.freeze(ENTERPRISE_HOST_PACKAGES.map(name => Object.freeze({ name,
      version: name.startsWith('@deepseek-ai/dsh-') ? '0.1.7-rc.2'
        : name === 'workdsh-plugin-audit' ? '0.1.0-alpha.6'
        : name === 'workdsh-plugin-access' ? '0.1.0-alpha.7' : '0.1.0-alpha.1',
    }))), toolMode: 'native', tools: ENTERPRISE_TOOL_NAMES, bindHost: '127.0.0.1',
    autoBindPersonalSessions: false, rawGateway: false, userPatches: false, nativeExecution: 'unavailable',
  });
}

/** Validates trusted resolved data, never evaluates YAML/js tags or caller extensions. */
export function assertFixedEnterpriseComposition(value: unknown): asserts value is EnterpriseComposition {
  if (!value || typeof value !== 'object' || !equal(value, fixedEnterpriseComposition())) throw new EnterpriseProfileError('afos/profile-composition-denied');
}

/** This fragment deliberately has no activation certificate for the complete desktop. */
export function assertEnterpriseDesktopActivation(): never {
  throw new EnterpriseProfileError('afos/profile-desktop-integration-unverified');
}
