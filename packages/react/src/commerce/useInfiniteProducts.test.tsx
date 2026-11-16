/* eslint-disable no-unused-expressions */
import React from 'react';
import { expect } from 'chai';
import { act, render, waitFor } from '@testing-library/react';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import {
  BuyerProduct,
  CommerceError,
  ListPage,
  OrderCloudService,
  RouteHandlerTokenClient,
} from '@sitecore-content-sdk/commerce';
import { SitecoreProviderReactContext, SitecoreProviderState } from '../components/SitecoreProvider';
import { CommerceContextValue, CommerceProvider, useCommerce } from './CommerceProvider';
import {
  InfiniteProductsParams,
  UseInfiniteProductsOptions,
  UseInfiniteProductsState,
  useInfiniteProducts,
} from './useInfiniteProducts';

const providerState = () =>
  (({
    api: { edge: { contextId: 'ctx', clientContextId: 'client-ctx', edgeUrl: 'https://edge.test' } },
    page: { mode: { isEditing: false, isPreview: false, isDesignLibrary: false } },
  } as unknown) as SitecoreProviderState);

const TOTAL_PAGES = 3;

const listPage = (prefix: string, page: number, totalPages = TOTAL_PAGES): ListPage<BuyerProduct> => ({
  Items: [`${prefix}${page}a`, `${prefix}${page}b`].map((ID) => ({ ID, Name: ID })),
  Meta: { Page: page, PageSize: 2, TotalCount: totalPages * 2, TotalPages: totalPages },
});

let commerce: CommerceContextValue;
const CommerceProbe = () => {
  commerce = useCommerce();
  return null;
};

const results: Record<string, UseInfiniteProductsState<unknown>> = {};
const Probe = ({
  id = 'a',
  params,
  options,
}: {
  id?: string;
  params?: InfiniteProductsParams;
  options?: UseInfiniteProductsOptions<unknown>;
}) => {
  results[id] = useInfiniteProducts(params, options as UseInfiniteProductsOptions);
  return null;
};

const tree = (ui: React.ReactNode) => (
  <SitecoreProviderReactContext.Provider value={providerState()}>
    <CommerceProvider tokens={{ mode: 'route-handler', cookies: { secure: false } }}>
      <CommerceProbe />
      {ui}
    </CommerceProvider>
  </SitecoreProviderReactContext.Provider>
);

const clearCookies = () => {
  document.cookie.split(/;\s*/).forEach((part) => {
    const name = part.split('=')[0];
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const ids = (state: UseInfiniteProductsState<unknown>) => state.rawItems.map((p) => p.ID);

describe('useInfiniteProducts', () => {
  let sandbox: SinonSandbox;
  let request: SinonStub;
  let respond: (query: URLSearchParams, init: RequestInit) => unknown;
  let paths: string[];
  let tokenCount: number;

  beforeEach(() => {
    sandbox = createSandbox();
    tokenCount = 0;
    paths = [];
    Object.keys(results).forEach((key) => delete results[key]);
    sandbox.stub(RouteHandlerTokenClient.prototype, 'getAnonymousToken').callsFake(async () => ({
      session: {
        accessToken: `at-${++tokenCount}`,
        expiresAt: Date.now() + 600_000,
        userType: 'anonymous' as const,
      },
      persisted: true,
    }));
    sandbox.stub(RouteHandlerTokenClient.prototype, 'clear').resolves();
    respond = (query) => listPage(query.get('search') ?? 'p', Number(query.get('page')));
    request = sandbox
      .stub(OrderCloudService.prototype, 'request')
      .callsFake(async (path: string, init: RequestInit = {}) => {
        paths.push(path);
        return respond(new URLSearchParams(path.split('?')[1]), init);
      });
  });

  afterEach(() => {
    sandbox.restore();
    clearCookies();
  });

  const nextPage = async (id = 'a') => {
    await act(async () => {
      await results[id].fetchNextPage();
    });
  };

  it('should load the first page', async () => {
    render(tree(<Probe params={{ pageSize: 2 }} />));
    expect(results.a.isLoading).to.be.true;
    await waitFor(() => expect(results.a.status).to.equal('success'));

    expect(paths).to.deep.equal(['/v1/me/products?page=1&pageSize=2']);
    expect(ids(results.a)).to.deep.equal(['p1a', 'p1b']);
    expect(results.a.pages).to.have.length(1);
    expect(results.a.hasNextPage).to.be.true;
    expect(results.a.meta?.TotalCount).to.equal(6);
  });

  it('should append pages until the last one', async () => {
    render(tree(<Probe />));
    await waitFor(() => expect(results.a.status).to.equal('success'));

    await nextPage();
    expect(ids(results.a)).to.deep.equal(['p1a', 'p1b', 'p2a', 'p2b']);
    expect(results.a.hasNextPage).to.be.true;

    await nextPage();
    expect(results.a.pages).to.have.length(3);
    expect(results.a.hasNextPage).to.be.false;
    expect(results.a.meta?.Page).to.equal(3);

    await nextPage();
    expect(paths).to.have.length(3);
  });

  it('should ignore a page param and fetchNextPage while one is in flight', async () => {
    render(tree(<Probe params={{ page: 5 } as InfiniteProductsParams} />));
    await waitFor(() => expect(results.a.status).to.equal('success'));
    expect(paths[0]).to.include('page=1');

    const slow = deferred<ListPage<BuyerProduct>>();
    respond = () => slow.promise;
    let first: Promise<void> | undefined;
    act(() => {
      first = results.a.fetchNextPage();
    });
    await waitFor(() => expect(results.a.isFetchingNextPage).to.be.true);
    await act(async () => {
      await results.a.fetchNextPage();
    });
    expect(paths).to.have.length(2);

    slow.resolve(listPage('p', 2));
    await act(async () => {
      await first;
    });
    expect(results.a.isFetchingNextPage).to.be.false;
    expect(results.a.pages).to.have.length(2);
  });

  it('should restart from the first page when params change', async () => {
    const { rerender } = render(tree(<Probe params={{ search: 'x' }} />));
    await waitFor(() => expect(results.a.status).to.equal('success'));
    await nextPage();
    expect(results.a.pages).to.have.length(2);

    rerender(tree(<Probe params={{ search: 'y' }} />));
    await waitFor(() => expect(ids(results.a)).to.deep.equal(['y1a', 'y1b']));
    expect(results.a.pages).to.have.length(1);
    expect(paths[paths.length - 1]).to.equal('/v1/me/products?search=y&page=1');
  });

  it('should keep pages visible while new params load unless keepPreviousData is false', async () => {
    const { rerender } = render(tree(<Probe params={{ search: 'x' }} />));
    await waitFor(() => expect(results.a.status).to.equal('success'));

    const slow = deferred<ListPage<BuyerProduct>>();
    respond = () => slow.promise;
    rerender(tree(<Probe params={{ search: 'y' }} />));
    await waitFor(() => expect(results.a.isRefetching).to.be.true);
    expect(ids(results.a)).to.deep.equal(['x1a', 'x1b']);

    rerender(tree(<Probe params={{ search: 'z' }} options={{ keepPreviousData: false }} />));
    await waitFor(() => expect(results.a.status).to.equal('loading'));
    expect(results.a.items).to.deep.equal([]);
    slow.resolve(listPage('z', 1));
  });

  it('should reload only the first page after an identity change', async () => {
    render(tree(<Probe />));
    await waitFor(() => expect(results.a.status).to.equal('success'));
    await nextPage();
    await nextPage();
    expect(results.a.pages).to.have.length(3);

    const slow = deferred<ListPage<BuyerProduct>>();
    respond = () => slow.promise;
    act(() => {
      commerce.resetSession();
    });
    await waitFor(() => expect(results.a.isRefetching).to.be.true);
    expect(results.a.pages).to.have.length(3);

    slow.resolve(listPage('r', 1));
    await waitFor(() => expect(results.a.isRefetching).to.be.false);
    expect(ids(results.a)).to.deep.equal(['r1a', 'r1b']);
    expect(results.a.hasNextPage).to.be.true;
    expect(paths.filter((p) => p.includes('page=1'))).to.have.length(2);
  });

  it('should drop a next page that resolves after params change', async () => {
    const { rerender } = render(tree(<Probe params={{ search: 'x' }} />));
    await waitFor(() => expect(results.a.status).to.equal('success'));

    const slowNext = deferred<ListPage<BuyerProduct>>();
    respond = () => slowNext.promise;
    act(() => {
      results.a.fetchNextPage();
    });
    await waitFor(() => expect(results.a.isFetchingNextPage).to.be.true);

    respond = (query) => listPage(query.get('search') ?? 'p', Number(query.get('page')));
    rerender(tree(<Probe params={{ search: 'y' }} />));
    await waitFor(() => expect(ids(results.a)).to.deep.equal(['y1a', 'y1b']));

    slowNext.resolve(listPage('x', 2));
    await tick();
    expect(ids(results.a)).to.deep.equal(['y1a', 'y1b']);
    expect(results.a.isFetchingNextPage).to.be.false;
  });

  it('should report a next-page error without losing loaded pages, and retry', async () => {
    render(tree(<Probe />));
    await waitFor(() => expect(results.a.status).to.equal('success'));

    respond = () => {
      throw new CommerceError('boom', { source: 'ordercloud', status: 500 });
    };
    await nextPage();
    expect(results.a.status).to.equal('success');
    expect(results.a.isFetchNextPageError).to.be.true;
    expect(results.a.error?.message).to.equal('boom');
    expect(results.a.pages).to.have.length(1);

    respond = (query) => listPage('p', Number(query.get('page')));
    await nextPage();
    expect(results.a.isFetchNextPageError).to.be.false;
    expect(results.a.error).to.equal(null);
    expect(results.a.pages).to.have.length(2);
  });

  it('should never render previous pages with new params when keepPreviousData is false', async () => {
    const renders: Array<{ search?: string; ids: string[]; status: string }> = [];
    const HistoryProbe = ({ search }: { search: string }) => {
      const state = useInfiniteProducts({ search }, { keepPreviousData: false });
      renders.push({ search, ids: state.rawItems.map((p) => p.ID), status: state.status });
      return null;
    };

    const { rerender } = render(tree(<HistoryProbe search="x" />));
    await waitFor(() => expect(renders[renders.length - 1].ids).to.deep.equal(['x1a', 'x1b']));

    rerender(tree(<HistoryProbe search="y" />));
    await waitFor(() => expect(renders[renders.length - 1].ids).to.deep.equal(['y1a', 'y1b']));

    const newRenders = renders.filter((r) => r.search === 'y');
    expect(newRenders.some((r) => r.ids.some((id) => id.startsWith('x')))).to.be.false;
    expect(newRenders[0]).to.deep.include({ ids: [], status: 'loading' });
  });

  it('should report a first-page error and recover on refetch', async () => {
    respond = () => {
      throw new CommerceError('down', { source: 'proxy', status: 404 });
    };
    render(tree(<Probe />));
    await waitFor(() => expect(results.a.status).to.equal('error'));
    expect(results.a.error?.source).to.equal('proxy');
    expect(results.a.hasNextPage).to.be.false;

    respond = (query) => listPage('p', Number(query.get('page')));
    await act(async () => {
      await results.a.refetch();
    });
    expect(results.a.status).to.equal('success');
  });

  it('should share page requests across components', async () => {
    render(
      tree(
        <>
          <Probe id="a" params={{ search: 'x' }} />
          <Probe id="b" params={{ search: 'x' }} />
        </>
      )
    );
    await waitFor(() => expect(results.b.status).to.equal('success'));
    await tick();
    expect(paths).to.have.length(1);

    await act(async () => {
      await Promise.all([results.a.fetchNextPage(), results.b.fetchNextPage()]);
    });
    expect(paths).to.have.length(2);
    expect(ids(results.a)).to.deep.equal(ids(results.b));
  });

  it('should render initialData as the first page and continue from it', async () => {
    render(
      tree(<Probe options={{ initialData: listPage('s', 1), revalidate: false }} />)
    );
    expect(results.a.status).to.equal('success');
    expect(ids(results.a)).to.deep.equal(['s1a', 's1b']);
    await tick();
    expect(request.called).to.be.false;

    await nextPage();
    expect(paths).to.deep.equal(['/v1/me/products?page=2']);
    expect(results.a.pages).to.have.length(2);
  });

  it('should be idle when disabled', async () => {
    render(tree(<Probe options={{ enabled: false }} />));
    await tick();
    expect(results.a.status).to.equal('idle');
    await nextPage();
    expect(request.called).to.be.false;
  });

  it('should treat a page without TotalPages as the last page', async () => {
    respond = () => ({ Items: [{ ID: 'only', Name: 'only' }], Meta: {} });
    render(tree(<Probe />));
    await waitFor(() => expect(results.a.status).to.equal('success'));
    expect(results.a.hasNextPage).to.be.false;
  });
});
