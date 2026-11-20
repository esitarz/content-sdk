import { expect } from 'chai';
import nock from 'nock';
import {
  clearShopperTokenVerifierCache,
  createShopperTokenVerifier,
} from './shopper-token-verifier';

const EDGE = 'https://edge.test';
const CONTEXT_ID = 'ctx-123';
const KID = 'key_1';

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const makeToken = async (
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: KID }
) => {
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await globalThis.crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
};

describe('createShopperTokenVerifier', () => {
  let privateKey: CryptoKey;
  let publicJwk: JsonWebKey;

  before(async () => {
    const pair = (await globalThis.crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
  });

  beforeEach(() => clearShopperTokenVerifierCache());
  afterEach(() => nock.cleanAll());

  it('verifies a proxy-bound RS256 token and caches the signing key', async () => {
    const now = Date.now();
    const token = await makeToken(privateKey, {
      cid: 'buyer-1',
      aud: 'https://attacker.invalid',
      usrtype: 'buyer',
      exp: Math.floor((now + 60_000) / 1000),
    });
    const scope = nock(EDGE)
      .get(`/oc/storefront/oauth/certs/${KID}`)
      .matchHeader('x-sitecore-contextid', CONTEXT_ID)
      .once()
      .reply(200, { ...publicJwk, kid: KID, alg: 'RS256' });
    const verifier = createShopperTokenVerifier({
      contextId: CONTEXT_ID,
      edgeUrl: EDGE,
      allowedClientIds: ['buyer-1'],
    });

    const result = await verifier.verify(token);
    const cached = await verifier.verify(token);

    expect(result.clientId).to.equal('buyer-1');
    expect(result.userType).to.equal('anonymous');
    expect(cached).to.deep.equal(result);
    expect(scope.isDone()).to.equal(true);
  });

  it('validates registered shopper claims and optional audience', async () => {
    const token = await makeToken(privateKey, {
      cid: 'buyer-1',
      aud: ['hosted-store'],
      usr: 'shopper@example.test',
      usrtype: 'user',
      exp: Math.floor((Date.now() + 60_000) / 1000),
    });
    nock(EDGE).get(`/oc/storefront/oauth/certs/${KID}`).reply(200, publicJwk);
    const verifier = createShopperTokenVerifier({
      contextId: CONTEXT_ID,
      edgeUrl: EDGE,
      allowedClientIds: ['buyer-1'],
      expectedAudience: 'hosted-store',
    });

    expect(await verifier.verify(token)).to.deep.include({
      clientId: 'buyer-1',
      userType: 'registered',
      username: 'shopper@example.test',
    });
  });

  it('rejects unsupported algorithms and malformed key ids before fetching keys', async () => {
    const none = `${encode({ alg: 'none', kid: KID })}.${encode({
      cid: 'buyer-1',
      exp: 9_999_999_999,
    })}.signature`;
    const verifier = createShopperTokenVerifier({
      contextId: CONTEXT_ID,
      edgeUrl: EDGE,
      allowedClientIds: ['buyer-1'],
    });

    expect(await verifier.verify(none).catch((error) => error)).to.include({
      source: 'sdk',
      code: 'invalid-token',
    });
    expect(nock.pendingMocks()).to.deep.equal([]);
  });

  it('rejects client IDs and audience values that are not allowlisted', async () => {
    const token = await makeToken(privateKey, {
      cid: 'other',
      aud: 'wrong',
      exp: Math.floor((Date.now() + 60_000) / 1000),
    });
    const verifier = createShopperTokenVerifier({
      contextId: CONTEXT_ID,
      edgeUrl: EDGE,
      allowedClientIds: ['buyer-1'],
      expectedAudience: 'hosted-store',
    });

    const error = await verifier.verify(token).catch((caught) => caught);
    expect(error).to.include({ source: 'sdk', code: 'invalid-token' });
    expect(nock.pendingMocks()).to.deep.equal([]);
  });

  it('rejects malformed or unknown shopper type claims before fetching a key', async () => {
    const token = await makeToken(privateKey, {
      cid: 'buyer-1',
      usrtype: 'admin',
      exp: Math.floor((Date.now() + 60_000) / 1000),
    });
    const verifier = createShopperTokenVerifier({
      contextId: CONTEXT_ID,
      edgeUrl: EDGE,
      allowedClientIds: ['buyer-1'],
    });

    const error = await verifier.verify(token).catch((caught) => caught);
    expect(error).to.include({ source: 'sdk', code: 'invalid-token' });
    expect(nock.pendingMocks()).to.deep.equal([]);
  });

  it('caches unknown key failures for the configured TTL', async () => {
    const token = await makeToken(privateKey, {
      cid: 'buyer-1',
      usrtype: 'buyer',
      exp: Math.floor((Date.now() + 60_000) / 1000),
    });
    const scope = nock(EDGE)
      .get(`/oc/storefront/oauth/certs/${KID}`)
      .once()
      .reply(404, 'Not Found');
    const verifier = createShopperTokenVerifier({
      contextId: CONTEXT_ID,
      edgeUrl: EDGE,
      allowedClientIds: ['buyer-1'],
      keyCacheTtlMs: 60_000,
    });

    const first = await verifier.verify(token).catch((error) => error);
    const second = await verifier.verify(token).catch((error) => error);
    expect(first).to.include({ source: 'sdk', code: 'invalid-token' });
    expect(second).to.deep.include({ source: 'sdk', code: 'invalid-token' });
    expect(scope.isDone()).to.equal(true);
  });
});
