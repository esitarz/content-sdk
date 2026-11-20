import { expect } from 'chai';
import nock from 'nock';
import sinon from 'sinon';
import { CommerceError } from '../errors';
import { OrderCloudService } from '../ordercloud-service';
import { ShopperSessionManager } from '../session/shopper-session-manager';
import { createMemoryTokenStore } from '../token-store/memory-token-store';
import { CommerceTokenClient } from '../token/token-client';

const EDGE = 'https://edge.test';

const createService = () => {
  const tokenClient: CommerceTokenClient = {
    getAnonymousToken: sinon.stub().resolves({
      session: {
        accessToken: 'at-1',
        expiresAt: Date.now() + 600_000,
        userType: 'anonymous',
      },
      persisted: false,
    }),
    refresh: sinon.stub().rejects(new Error('unused')),
  };
  return new OrderCloudService({
    contextId: 'ctx-123',
    edgeUrl: EDGE,
    sessionManager: new ShopperSessionManager({
      tokenClient,
      tokenStore: createMemoryTokenStore(),
    }),
  });
};

describe('service.orders', () => {
  afterEach(() => nock.cleanAll());

  it('gets one shopper-owned order through the me orders allowlist', async () => {
    const service = createService();
    nock(EDGE)
      .get('/oc/storefront/v1/me/orders')
      .query({ ID: 'order/1', pageSize: '1' })
      .reply(200, {
        Items: [{ ID: 'order/1', Status: 'Open', Direction: 'Outgoing' }],
        Meta: { Page: 1, PageSize: 1, TotalCount: 1, TotalPages: 1 },
      });

    expect(await service.orders.get(' order/1 ')).to.deep.include({
      ID: 'order/1',
      Status: 'Open',
    });
  });

  it('maps an empty shopper order list to an OrderCloud 404', async () => {
    const service = createService();
    nock(EDGE)
      .get('/oc/storefront/v1/me/orders')
      .query({ ID: 'missing', pageSize: '1' })
      .reply(200, {
        Items: [],
        Meta: { Page: 1, PageSize: 1, TotalCount: 0, TotalPages: 0 },
      });

    const error = await service.orders.get('missing').catch((caught) => caught);
    expect(error).to.be.instanceOf(CommerceError);
    expect(error).to.include({ source: 'ordercloud', status: 404, code: 'NotFound' });
  });

  it('rejects an empty order ID before sending a request', async () => {
    const error = await createService().orders.get(' ').catch((caught) => caught);
    expect(error).to.be.instanceOf(CommerceError);
    expect(error.source).to.equal('sdk');
  });
});
