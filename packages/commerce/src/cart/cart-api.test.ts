import { expect } from 'chai';
import nock from 'nock';
import sinon from 'sinon';
import { OrderCloudService } from '../ordercloud-service';
import { ShopperSessionManager } from '../session/shopper-session-manager';
import { createMemoryTokenStore } from '../token-store/memory-token-store';
import { CommerceTokenClient } from '../token/token-client';

const EDGE = 'https://edge.test';
const CONTEXT_ID = 'ctx-123';
const CART = '/oc/storefront/v1/cart';

const orderCloudError = (code: string, message: string) => ({
  Errors: [{ ErrorCode: code, Message: message }],
});

const createService = () => {
  let tokenNumber = 0;
  const tokenClient: CommerceTokenClient & { getAnonymousToken: sinon.SinonStub } = {
    getAnonymousToken: sinon.stub().callsFake(async () => ({
      session: {
        accessToken: `at-${++tokenNumber}`,
        expiresAt: Date.now() + 600_000,
        userType: 'anonymous',
      },
      persisted: false,
    })),
    refresh: sinon.stub().rejects(new Error('unused')),
  };
  const store = createMemoryTokenStore();
  const sessionManager = new ShopperSessionManager({ tokenClient, tokenStore: store });
  const service = new OrderCloudService({
    contextId: CONTEXT_ID,
    edgeUrl: EDGE,
    sessionManager,
  });
  return { service, sessionManager, store, tokenClient };
};

describe('service.cart', () => {
  afterEach(() => nock.cleanAll());

  it('gets a cart and follows line-item pages', async () => {
    const { service } = createService();
    nock(EDGE)
      .get(CART)
      .matchHeader('authorization', 'Bearer at-1')
      .reply(200, { ID: null, Status: 'Unsubmitted' })
      .get(`${CART}/lineitems`)
      .query({ page: '1', pageSize: '100' })
      .reply(200, {
        Items: [{ ID: 'l1', ProductID: 'p1', Quantity: 1 }],
        Meta: { Page: 1, PageSize: 100, TotalPages: 2, TotalCount: 2 },
      })
      .get(`${CART}/lineitems`)
      .query({ page: '2', pageSize: '100' })
      .reply(200, {
        Items: [{ ID: 'l2', ProductID: 'p2', Quantity: 1 }],
        Meta: { Page: 2, PageSize: 100, TotalPages: 2, TotalCount: 2 },
      });

    expect((await service.cart.get()).ID).to.equal(null);
    const result = await service.cart.listLineItems();
    expect(result.Items.map((item) => item.ID)).to.deep.equal(['l1', 'l2']);
    expect(result.Meta).to.include({ Page: 1, PageSize: 2, TotalPages: 1, TotalCount: 2 });
  });

  it('serializes an add, strips VariantID and safely retries a transient failure', async () => {
    const { service } = createService();
    const body = {
      ProductID: 'p/1',
      ID: 'line-1',
      Quantity: 2,
      Specs: [{ SpecID: 'SIZE', OptionID: 'M' }],
      xp: { source: 'sdk' },
    };
    const scope = nock(EDGE)
      .post(`${CART}/lineitems`, body)
      .matchHeader('content-type', 'application/json')
      .reply(503, { Errors: [{ ErrorCode: 'Unavailable', Message: 'later' }] })
      .post(`${CART}/lineitems`, body)
      .reply(201, body);

    const result = await service.cart.addLineItem({
      ProductID: ' p/1 ',
      VariantID: 'ignored',
      ID: 'line-1',
      Quantity: 2,
      Specs: [{ SpecID: 'SIZE', OptionID: 'M' }],
      xp: { source: 'sdk' },
    });

    expect(result).to.deep.equal({ lineItem: body, sessionRenewed: false });
    expect(scope.isDone()).to.equal(true);
  });

  it('returns the saved line item after an IdExists conflict', async () => {
    const { service } = createService();
    const saved = { ID: 'line-1', ProductID: 'p1', Quantity: 1 };
    nock(EDGE)
      .post(`${CART}/lineitems`)
      .reply(409, orderCloudError('IdExists', 'Object already exists.'))
      .get(`${CART}/lineitems/line-1`)
      .reply(200, saved);

    const result = await service.cart.addLineItem({
      ProductID: 'p1',
      ID: 'line-1',
      Quantity: 1,
      Specs: [],
    });

    expect(result).to.deep.equal({ lineItem: saved, sessionRenewed: false });
  });

  it('retries once when a concurrent first add created the cart', async () => {
    const { service } = createService();
    const saved = { ID: 'line-1', ProductID: 'p1', Quantity: 1 };
    nock(EDGE)
      .post(`${CART}/lineitems`)
      .reply(409, orderCloudError('IdExists', 'Object already exists.'))
      .get(`${CART}/lineitems/line-1`)
      .reply(404, orderCloudError('NotFound', 'Line item not found.'))
      .get(CART)
      .reply(200, { ID: 'cart-1', Status: 'Unsubmitted' })
      .post(`${CART}/lineitems`)
      .reply(201, saved);

    const result = await service.cart.addLineItem({
      ProductID: 'p1',
      ID: 'line-1',
      Quantity: 1,
      Specs: [],
    });

    expect(result).to.deep.equal({ lineItem: saved, sessionRenewed: false });
  });

  it('renews a spent anonymous session and reports the identity change', async () => {
    const { service, tokenClient } = createService();
    const saved = { ID: 'line-1', ProductID: 'p1', Quantity: 1 };
    nock(EDGE)
      .post(`${CART}/lineitems`)
      .matchHeader('authorization', 'Bearer at-1')
      .reply(409, orderCloudError('IdExists', 'Object already exists.'))
      .get(`${CART}/lineitems/line-1`)
      .reply(404, orderCloudError('NotFound', 'Line item not found.'))
      .get(CART)
      .reply(200, { ID: null, Status: 'Unsubmitted' })
      .post(`${CART}/lineitems`)
      .matchHeader('authorization', 'Bearer at-2')
      .reply(201, saved);

    const result = await service.cart.addLineItem({
      ProductID: 'p1',
      ID: 'line-1',
      Quantity: 1,
      Specs: [],
    });

    expect(result).to.deep.equal({ lineItem: saved, sessionRenewed: true });
    expect(tokenClient.getAnonymousToken.calledTwice).to.equal(true);
  });

  it('does not renew a spent anonymous session when disabled', async () => {
    const { service, tokenClient } = createService();
    nock(EDGE)
      .post(`${CART}/lineitems`)
      .reply(409, orderCloudError('IdExists', 'Object already exists.'))
      .get(`${CART}/lineitems/line-1`)
      .reply(404, orderCloudError('NotFound', 'Line item not found.'))
      .get(CART)
      .reply(200, { ID: null, Status: 'Unsubmitted' });

    const error = await service.cart
      .addLineItem(
        { ProductID: 'p1', ID: 'line-1', Quantity: 1, Specs: [] },
        { renewSpentAnonymousSession: false }
      )
      .catch((caught) => caught);

    expect(error).to.include({ status: 409, source: 'ordercloud' });
    expect(tokenClient.getAnonymousToken.calledOnce).to.equal(true);
  });

  it('never deletes the cart to recover and surfaces a second conflict', async () => {
    const { service } = createService();
    nock(EDGE)
      .post(`${CART}/lineitems`)
      .twice()
      .reply(409, orderCloudError('IdExists', 'Object already exists.'))
      .get(`${CART}/lineitems/line-1`)
      .reply(404, orderCloudError('NotFound', 'Line item not found.'))
      .get(CART)
      .reply(200, { ID: 'cart-1', Status: 'Unsubmitted' });

    const error = await service.cart
      .addLineItem({ ProductID: 'p1', ID: 'line-1', Quantity: 1, Specs: [] })
      .catch((caught) => caught);

    expect(error).to.include({ status: 409, source: 'ordercloud' });
  });

  it('retries safe writes, treats line-item 404 as success, and never retries submit', async () => {
    const { service } = createService();
    nock(EDGE)
      .patch(`${CART}/lineitems/line%2F1`, { Quantity: 2 })
      .reply(503, orderCloudError('Unavailable', 'later'))
      .patch(`${CART}/lineitems/line%2F1`, { Quantity: 2 })
      .reply(200, { ID: 'line/1', ProductID: 'p1', Quantity: 2 })
      .delete(`${CART}/lineitems/missing`)
      .reply(404, orderCloudError('NotFound', 'Missing'))
      .post(`${CART}/submit`)
      .reply(503, orderCloudError('Unavailable', 'later'));

    expect(
      (await service.cart.updateLineItem('line/1', { Quantity: 2 })).Quantity
    ).to.equal(2);
    await service.cart.removeLineItem('missing');
    const submitError = await service.cart.submit().catch((caught) => caught);

    expect(submitError).to.include({ status: 503, source: 'ordercloud' });
  });
});
