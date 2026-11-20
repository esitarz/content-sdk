import { expect } from 'chai';
import nock from 'nock';
import { CommerceError } from '@sitecore-content-sdk/commerce';
import { createShopperService, readBearerToken } from './server';

const EDGE = 'https://edge.test';

describe('nextjs commerce server shopper service', () => {
  afterEach(() => nock.cleanAll());

  it('extracts only a valid bearer header', () => {
    expect(readBearerToken(new Request('https://app.test', {
      headers: { Authorization: 'Bearer token' },
    }))).to.equal('token');
    expect(readBearerToken(new Request('https://app.test', {
      headers: { Authorization: 'Basic token' },
    }))).to.equal(null);
    expect(readBearerToken(new Request('https://app.test'))).to.equal(null);
    expect(readBearerToken(new Request('https://app.test', {
      headers: { Authorization: 'Bearer token extra' },
    }))).to.equal(null);
  });

  it('uses the supplied shopper token through the proxy', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const fetchOverride = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedInit = init;
      return ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({ ID: 'u1', Username: 'shopper' }),
        text: async () => JSON.stringify({ ID: 'u1', Username: 'shopper' }),
      } as Response);
    }) as typeof fetch;

    const service = createShopperService({
      contextId: 'ctx-123',
      edgeUrl: EDGE,
      accessToken: 'shopper-token',
      userType: 'registered',
      fetch: fetchOverride,
    });
    expect(await service.me.get()).to.deep.equal({ ID: 'u1', Username: 'shopper' });
    expect(requestedUrl).to.equal(`${EDGE}/oc/storefront/v1/me`);
    expect(new Headers(requestedInit?.headers).get('authorization')).to.equal(
      'Bearer shopper-token'
    );
    expect(new Headers(requestedInit?.headers).get('x-sitecore-contextid')).to.equal('ctx-123');
  });

  it('surfaces a rejected static token without retrying or replacing identity', async () => {
    const scope = nock(EDGE)
      .get('/oc/storefront/v1/me')
      .once()
      .reply(401, { Errors: [{ ErrorCode: 'InvalidToken', Message: 'expired' }] });
    const service = createShopperService({
      contextId: 'ctx-123',
      edgeUrl: EDGE,
      accessToken: 'shopper-token',
    });

    const error = await service.me.get().catch((caught) => caught);

    expect(error).to.be.instanceOf(CommerceError);
    expect(error).to.include({ status: 401, code: 'invalid-token' });
    expect(scope.isDone()).to.equal(true);
  });

  it('returns a fresh per-request service instance', () => {
    const config = {
      contextId: 'ctx-123',
      edgeUrl: EDGE,
      accessToken: 'shopper-token',
    };
    expect(createShopperService(config)).not.to.equal(createShopperService(config));
  });
});
