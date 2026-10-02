import { createLocalJWKSet, createRemoteJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet } from 'jose';

export interface AccessEvidence {
  readonly issuer: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly tokenId: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly grantId: string;
}
export interface ResourceConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly clientIds: readonly string[];
}
export function bearerToken(header: string): string | undefined {
  return /^Bearer\s+([^\s,]+)\s*$/iu.exec(header)?.[1];
}
export function safeServerEpoch(value: unknown): number | undefined {
  if (typeof value === 'string' && !/^\d{1,16}$/u.test(value)) return undefined;
  if (!['string','number','bigint'].includes(typeof value)) return undefined;
  const milliseconds = Number(value);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

export function accessVerifier(config: ResourceConfig, testKeys?: JSONWebKeySet) {
  const issuer = new URL(config.issuer);
  const jwks = new URL(config.jwksUrl);
  if (config.issuer.length>1024||issuer.protocol !== 'https:' || jwks.protocol !== 'https:' || jwks.origin !== issuer.origin
    || issuer.username || issuer.password || jwks.username || jwks.password || config.clientIds.length === 0) throw new Error('afos/invalid-oauth-config');
  const keys = testKeys ? createLocalJWKSet(testKeys) : createRemoteJWKSet(jwks, { timeoutDuration: 5_000 });
  return async (token: string): Promise<AccessEvidence> => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer, audience: config.audience, algorithms: ['RS256'], typ:'at+jwt',
      requiredClaims: ['sub', 'exp', 'iat', 'jti', 'client_id', 'scope', 'grant_id'],
    });
    if (payload.cnf !== undefined || payload.aud !== config.audience || typeof payload.sub !== 'string' || !payload.sub||payload.sub.length>256
      || typeof payload.client_id !== 'string' || !config.clientIds.includes(payload.client_id)
      || typeof payload.scope !== 'string' || !payload.scope.split(/\s+/u).includes('afos')
      || typeof payload.jti !== 'string' || !payload.jti || typeof payload.exp !== 'number' || typeof payload.iat !== 'number'
      || typeof payload.grant_id !== 'string' || !payload.grant_id
      || payload.iat * 1_000 > Date.now() + 5_000) throw new Error('afos/invalid-access-evidence');
    return Object.freeze({ issuer:config.issuer, principalId: payload.sub, clientId: payload.client_id, tokenId: payload.jti, grantId:payload.grant_id, expiresAt: payload.exp * 1_000, issuedAt:payload.iat * 1_000 });
  };
}

/** Decoding is only a hint for denying non-gateway routes; never authenticates. */
export function isEnterpriseTokenCandidate(token: string, config: ResourceConfig): boolean {
  try {
    const payload = decodeJwt(token);
    return payload.iss === config.issuer && (config.clientIds.includes(String(payload.client_id))
      || typeof payload.scope === 'string' && payload.scope.split(/\s+/u).includes('afos'));
  } catch { return false; }
}
