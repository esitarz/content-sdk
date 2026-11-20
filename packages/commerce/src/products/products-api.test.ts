import { expect } from 'chai';
import nock from 'nock';
import sinon from 'sinon';
import { debug } from '../debug';
import { CommerceError } from '../errors';
import { OrderCloudService } from '../ordercloud-service';
import { ShopperSessionManager } from '../session/shopper-session-manager';
import { createMemoryTokenStore } from '../token-store/memory-token-store';
import { CommerceTokenClient } from '../token/token-client';
import { isProductNotFoundError } from './product-errors';
import { listAll } from '../pagination';

const EDGE = 'https://edge.test';
const contextId = 'ctx-123';
const BASE = '/oc/storefront/v1/me/products';

const createService = (fetchOverride?: typeof fetch) => {
  let n = 0;
  const tokenClient: CommerceTokenClient & { getAnonymousToken: sinon.SinonStub } = {
    getAnonymousToken: sinon.stub().callsFake(async () => ({
      session: { accessToken: `at-${++n}`, expiresAt: Date.now() + 600_000, userType: 'anonymous' },
      persisted: false,
    })),
    refresh: sinon.stub().rejects(new Error('unused')),
  };
  const sessionManager = new ShopperSessionManager({
    tokenClient,
    tokenStore: createMemoryTokenStore(),
  });
  return {
    tokenClient,
    service: new OrderCloudService({ contextId, edgeUrl: EDGE, sessionManager, fetch: fetchOverride }),
  };
};

const page = <T>(items: T[], pageNo: number, totalPages: number, totalCount = 0) => ({
  Items: items,
  Meta: { Page: pageNo, PageSize: items.length, TotalPages: totalPages, TotalCount: totalCount },
});

describe('service.products', () => {
  afterEach(() => nock.cleanAll());

  describe('get', () => {
    it('should get a product with bearer and context headers', async () => {
      const { service } = createService();
      nock(EDGE, { reqheaders: { authorization: 'Bearer at-1', 'x-sitecore-contextid': contextId } })
        .get(`${BASE}/p1`)
        .reply(200, { ID: 'p1', Name: 'Product 1' });

      expect(await service.products.get('p1')).to.deep.equal({ ID: 'p1', Name: 'Product 1' });
    });

    it('should trim and encode the product ID', async () => {
      const { service } = createService();
      nock(EDGE)
        .get(`${BASE}/a%2Fb%20c%C3%A9`)
        .reply(200, { ID: 'a/b cé', Name: 'x' });

      expect((await service.products.get('  a/b cé ')).ID).to.equal('a/b cé');
    });

    it('should throw without sending a request for an empty ID', async () => {
      const { service, tokenClient } = createService();
      for (const id of ['', '   ', (undefined as unknown) as string]) {
        const error = await service.products.get(id).catch((e) => e);
        expect(error).to.be.instanceOf(CommerceError);
        expect(error.source).to.equal('sdk');
      }
      const listError = await service.products.listSpecs(' ').catch((e) => e);
      expect(listError.source).to.equal('sdk');
      expect(tokenClient.getAnonymousToken.called).to.equal(false);
    });

    it('should renew the session and retry once on 401', async () => {
      const { service, tokenClient } = createService();
      nock(EDGE)
        .get(`${BASE}/p1`)
        .matchHeader('authorization', 'Bearer at-1')
        .reply(401, { Errors: [{ ErrorCode: 'InvalidToken', Message: 'no' }] })
        .get(`${BASE}/p1`)
        .matchHeader('authorization', 'Bearer at-2')
        .reply(200, { ID: 'p1', Name: 'x' });

      expect((await service.products.get('p1')).ID).to.equal('p1');
      expect(tokenClient.getAnonymousToken.calledTwice).to.equal(true);
    });

    it('should not retry when aborted', async () => {
      const controller = new AbortController();
      const abortingFetch = (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abort = new Error('aborted');
            abort.name = 'AbortError';
            reject(abort);
          });
        });
      const { service, tokenClient } = createService(abortingFetch as typeof fetch);

      const pending = service.products.get('p1', { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      const error = await pending.catch((e) => e);

      expect(error.name).to.equal('AbortError');
      expect(tokenClient.getAnonymousToken.calledOnce).to.equal(true);
    });
  });

  describe('list', () => {
    it('should list products with serialized options', async () => {
      const { service } = createService();
      nock(EDGE)
        .get(BASE)
        .query({ catalogID: 'c1', pageSize: '10', 'xp.Brand': 'Acme', ID: 'a|b' })
        .reply(200, page([{ ID: 'a', Name: 'A' }], 1, 1, 1));

      const result = await service.products.list({
        catalogID: 'c1',
        pageSize: 10,
        filters: { 'xp.Brand': 'Acme', ID: ['a', 'b'] },
      });
      expect(result.Items.map((p) => p.ID)).to.deep.equal(['a']);
    });

    it('should not send a query string without options', async () => {
      const { service } = createService();
      nock(EDGE).get(BASE).reply(200, page([], 1, 0));
      expect((await service.products.list()).Items).to.deep.equal([]);
    });

    it('loads product IDs in input order and chunks requests at 100', async () => {
      const { service } = createService();
      const ids = Array.from({ length: 102 }, (_, index) => `p-${index}`);
      const orderedIds = ['p-2', 'p-1', ...ids.slice(3)];
      nock(EDGE)
        .get(BASE)
        .query((query) => query.pageSize === '100' && query.ID === orderedIds.slice(0, 100).join('|'))
        .reply(200, page([{ ID: 'p-2', Name: 'Two' }, { ID: 'p-1', Name: 'One' }], 1, 1, 2))
        .get(BASE)
        .query({ pageSize: '1', ID: 'p-101' })
        .reply(200, page([{ ID: 'p-101', Name: 'Last' }], 1, 1, 1));

      const result = await service.products.listByIds([
        ' p-2 ',
        'p-1',
        'p-2',
        ...ids.slice(3),
      ]);
      expect(result.Items.map((item) => item.ID)).to.deep.equal(['p-2', 'p-1', 'p-101']);
      expect(result.Meta.TotalCount).to.equal(3);
    });

    it('returns an empty list and rejects IDs that cannot be represented in a filter', async () => {
      const { service, tokenClient } = createService();
      expect(await service.products.listByIds([' ', ''])).to.deep.include({
        Items: [],
      });
      const error = await service.products.listByIds(['p|other']).catch((caught) => caught);
      expect(error).to.be.instanceOf(CommerceError);
      expect(error.source).to.equal('sdk');
      expect(tokenClient.getAnonymousToken.called).to.equal(false);
    });
  });

  describe('listSpecs / listVariants', () => {
    it('should follow pages by default and merge them', async () => {
      const { service } = createService();
      nock(EDGE)
        .get(`${BASE}/p1/specs`)
        .query({ page: '1', pageSize: '100' })
        .reply(200, page([{ ID: 's1' }], 1, 3, 3))
        .get(`${BASE}/p1/specs`)
        .query({ page: '2', pageSize: '100' })
        .reply(200, page([{ ID: 's2' }], 2, 3, 3))
        .get(`${BASE}/p1/specs`)
        .query({ page: '3', pageSize: '100' })
        .reply(200, page([{ ID: 's3' }], 3, 3, 3));

      const result = await service.products.listSpecs('p1');
      expect(result.Items.map((s) => s.ID)).to.deep.equal(['s1', 's2', 's3']);
      expect(result.Meta).to.include({ TotalCount: 3, TotalPages: 1, Page: 1, PageSize: 3 });
    });

    it('should pass filters to every page', async () => {
      const { service } = createService();
      nock(EDGE)
        .get(`${BASE}/p1/variants`)
        .query({ page: '1', pageSize: '100', Active: 'true' })
        .reply(200, page([{ ID: 'v1' }], 1, 2, 2))
        .get(`${BASE}/p1/variants`)
        .query({ page: '2', pageSize: '100', Active: 'true' })
        .reply(200, page([{ ID: 'v2' }], 2, 2, 2));

      const result = await service.products.listVariants('p1', { filters: { Active: true } });
      expect(result.Items.map((v) => v.ID)).to.deep.equal(['v1', 'v2']);
    });

    it('should stop at maxPages and log a debug message', async () => {
      const { service } = createService();
      const scope = nock(EDGE)
        .get(`${BASE}/p1/variants`)
        .query(true)
        .times(2)
        .reply(200, (uri) => {
          const pageNo = Number(new URL(uri, EDGE).searchParams.get('page'));
          return page([{ ID: `v${pageNo}` }], pageNo, 5, 5);
        });

      const originalEnabled = debug.enabled;
      const originalLog = debug.log;
      const log = sinon.spy();
      debug.enabled = true;
      debug.log = log;
      try {
        const result = await service.products.listVariants('p1', { maxPages: 2 });
        expect(result.Items.map((v) => v.ID)).to.deep.equal(['v1', 'v2']);
        expect(result.Meta.TotalCount).to.equal(5);
      } finally {
        debug.enabled = originalEnabled;
        debug.log = originalLog;
      }
      expect(scope.isDone()).to.equal(true);
      expect(log.calledWithMatch(sinon.match(/maxPages/))).to.equal(true);
    });

    it('should request a single page when all is false', async () => {
      const { service } = createService();
      nock(EDGE)
        .get(`${BASE}/p1/specs`)
        .query({ page: '2', pageSize: '5' })
        .reply(200, page([{ ID: 's6' }], 2, 4, 16));

      const result = await service.products.listSpecs('p1', { all: false, page: 2, pageSize: 5 });
      expect(result.Meta.TotalPages).to.equal(4);
    });

    it('should stop requesting pages after an abort', async () => {
      const controller = new AbortController();
      const fetchPage = sinon.stub().callsFake(async (pageNo: number) => {
        controller.abort();
        return page([{ ID: `s${pageNo}` }], pageNo, 3, 3);
      });

      const error = await listAll(fetchPage, { signal: controller.signal }).catch((e) => e);
      expect(error.name).to.equal('AbortError');
      expect(fetchPage.calledOnce).to.equal(true);
    });

    it('should reject reserved filter keys before sending', async () => {
      const { service, tokenClient } = createService();
      const error = await service.products
        .listSpecs('p1', { filters: { page: 3 } })
        .catch((e) => e);
      expect(error).to.be.instanceOf(CommerceError);
      expect(tokenClient.getAnonymousToken.called).to.equal(false);
    });
  });

  describe('isProductNotFoundError', () => {
    it('should be true for an OrderCloud 404', async () => {
      const { service } = createService();
      nock(EDGE)
        .get(`${BASE}/missing`)
        .reply(404, { Errors: [{ ErrorCode: 'NotFound', Message: 'Product not found' }] });
      const error = await service.products.get('missing').catch((e) => e);
      expect(isProductNotFoundError(error)).to.equal(true);
    });

    it('should be false for a proxy plain-text 404', async () => {
      const { service } = createService();
      nock(EDGE).get(`${BASE}/p1`).reply(404, 'Not Found', { 'content-type': 'text/plain' });
      const error = await service.products.get('p1').catch((e) => e);
      expect(error.source).to.equal('proxy');
      expect(isProductNotFoundError(error)).to.equal(false);
    });

    it('should be false for other errors', () => {
      expect(isProductNotFoundError(new Error('x'))).to.equal(false);
      expect(isProductNotFoundError({ status: 404, source: 'ordercloud' })).to.equal(false);
      expect(
        isProductNotFoundError(new CommerceError('x', { source: 'ordercloud', status: 500 }))
      ).to.equal(false);
      expect(isProductNotFoundError(undefined)).to.equal(false);
    });
  });
});
