import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { accessVerifier, isEnterpriseTokenCandidate } from '../auth.ts';

const keys=await generateKeyPair('RS256');
const jwk=await exportJWK(keys.publicKey);jwk.kid='test-only';
const config={issuer:'https://enterprise.example/api',audience:'https://enterprise.example/api/afos',jwksUrl:'https://enterprise.example/api/idpOAuth/jwks',clientIds:['desktop']};
const verify=accessVerifier(config,{keys:[jwk]});
function signed(overrides={}) {
  const {scope='afos offline_access',client_id='desktop',issuer=config.issuer,audience=config.audience,expires='5m',grant_id='grant1',typ='at+jwt',omitType=false,cnf,subject='alice'}=overrides;
  return new SignJWT({scope,client_id,grant_id,...(cnf!==undefined?{cnf}:{})}).setProtectedHeader({alg:'RS256',kid:'test-only',...(omitType?{}:{typ})}).setSubject(subject).setIssuer(issuer).setAudience(audience).setIssuedAt().setJti('test-token').setExpirationTime(expires).sign(keys.privateKey);
}

test('AFOS-CHECK-A01 verified immutable client/scope evidence from a real signed JWT',async()=>{
  const token=await signed();const evidence=await verify(token);
  assert.equal(evidence.principalId,'alice');assert.equal(evidence.clientId,'desktop');assert.ok(Object.isFrozen(evidence));
  assert.ok(isEnterpriseTokenCandidate(token,config));
});

test('AFOS-CHECK-A02 wrong issuer/audience/client/scope/expiry and tampered JWT rejected',async()=>{
  for(const options of [{issuer:'https://other.example'},{audience:'https://enterprise.example/api'},{client_id:'other'},{scope:'mcp'},{expires:'-1s'},{grant_id:null},{grant_id:''},{typ:'JWT'},{typ:'id+jwt'},{omitType:true},{cnf:{jkt:'test-proof-key'}}])await assert.rejects(verify(await signed(options)));
  const token=await signed();const parts=token.split('.');parts[1]=Buffer.from(JSON.stringify({iss:config.issuer,sub:'mallory',client_id:'desktop',scope:'afos'})).toString('base64url');
  await assert.rejects(verify(parts.join('.')));
  // Decoding alone is never accepted as identity; the verifier rejects the hint.
  assert.equal(isEnterpriseTokenCandidate(parts.join('.'),config),true);
});

test('AFOS-CHECK-A03 bearer normalization and database epoch values fail closed',async()=>{
  const {bearerToken,safeServerEpoch}=await import('../auth.ts');
  assert.equal(bearerToken('bEaReR   token'),'token');
  for(const header of ['Basic token','Bearer a, Bearer b','Bearer a b'])assert.equal(bearerToken(header),undefined);
  for(const value of [1700000000000,'1700000000000',1700000000000n])assert.equal(safeServerEpoch(value),1700000000000);
  for(const value of [NaN,Infinity,-1,'-1','bad','9007199254740993',null,{}])assert.equal(safeServerEpoch(value),undefined);
});

test('AFOS-CHECK-A04 issuer and subject stay within the independent authorization schema limits',async()=>{
  assert.throws(()=>accessVerifier({...config,issuer:`https://enterprise.example/${'x'.repeat(1024)}`},{keys:[jwk]}),/afos\/invalid-oauth-config/);
  await assert.rejects(verify(await signed({subject:'x'.repeat(257)})),/afos\/invalid-access-evidence/);
});
