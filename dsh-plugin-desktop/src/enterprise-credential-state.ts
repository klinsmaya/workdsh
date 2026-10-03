/** Main-native presentation only; contains no account, namespace or credential. */
export type EnterpriseCredentialStorageState = 'signed-out' | 'memory-only' | 'encrypted'

export function credentialStorageUi(state: EnterpriseCredentialStorageState): { readonly label: string; readonly detail?: string } {
  switch (state) {
    case 'signed-out': return Object.freeze({ label: 'Signed out / 未登录' })
    case 'encrypted': return Object.freeze({ label: 'Credentials: encrypted / 登录凭据：已加密保存' })
    case 'memory-only': return Object.freeze({
      label: 'Credentials: this session only / 登录凭据：仅本次内存',
      detail: 'Sign-in credentials remain in memory for this session. Sign in again after restarting WorkDSH. / 登录凭据仅在本次会话内存中保留，重启 WorkDSH 后需重新登录。',
    })
    default: throw new Error('enterprise/credential-state-refused')
  }
}
