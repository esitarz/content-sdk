/* eslint-disable no-unused-expressions */
import React from 'react';
import { expect } from 'chai';
import { act, render, waitFor } from '@testing-library/react';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import {
  BuyerProduct,
  CommerceError,
  ListPage,
  ListProductsOptions,
  OrderCloudService,
  RouteHandlerTokenClient,
} from '@sitecore-content-sdk/commerce';
import { SitecoreProviderReactContext, SitecoreProviderState } from '../components/SitecoreProvider';
import { CommerceContextValue, CommerceProvider, useCommerce } from './CommerceProvider';
import { UseProductsOptions, UseProductsState, useProducts } from './useProducts';

const providerState = () =>
  (({
    api: { edge: { contextId: 'ctx', clientContextId: 'client-ctx', edgeUrl: 'https://edge.test' } },
    page: { mode: { isEditing: false, isPreview: false, isDesignLibrary: false } },
  } as unknown) as SitecoreProviderState);

const product = (id: string): BuyerProduct => ({ ID: id, Name: `Product ${id}` });

const listPage = (ids: string[], page = 1): ListPage<BuyerProduct> => ({
  Items: ids.map(product),
  Meta: { Page: page, PageSize: ids.length, TotalCount: 10, TotalPages: 5 },
});

let commerce: CommerceContextValue;
const CommerceProbe = () => {
  commerce = useCommerce();
  return null;
};

const results: Record<string, UseProductsState<unknown>> = {};
const ListProbe = ({
  id = 'a',
  params,
  options,
}: {
  id?: string;
  params?: ListProductsOptions;
  options?: UseProductsOptions<unknown>;
}) => {
  results[id] = useProducts(params, options as UseProductsOptions);
  return null;
};

const tree = (ui: React.ReactNode, { timeout }: { timeout?: number } = {}) => (
  <SitecoreProviderReactContext.Provider value={providerState()}>
    <CommerceProvider tokens={{ mode: 'route-handler', cookies: { secure: false } }} timeout={timeout}>
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

describe('useProducts', () => {
  let sandbox: SinonSandbox;
  let routeAnonymous: SinonStub;
  let request: SinonStub;
  let respond: (path: string, init: RequestInit) => unknown;
  let paths: string[];
  let tokenCount: number;

  beforeEach(() => {
    sandbox = createSandbox();
    tokenCount = 0;
    paths = [];
    Object.keys(results).forEach((key) => delete results[key]);
    routeAnonymous = sandbox
      .stub(RouteHandlerTokenClient.prototype, 'getAnonymousToken')
      .callsFake(async () => ({
        session: {
          accessToken: `at-${++tokenCount}`,
          expiresAt: Date.now() + 600_000,
          userType: 'anonymous' as const,
        },
        persisted: true,
      }));
    sandbox.stub(RouteHandlerTokenClient.prototype, 'clear').resolves();
    respond = (path) => {
      const pageNo = Number(new URLSearchParams(path.split('?')[1]).get('page') || 1);
      return listPage([`p${pageNo}a`, `p${pageNo}b`], pageNo);
    };
    request = sandbox
      .stub(OrderCloudService.prototype, 'request')
      .callsFake(async (path: string, init: RequestInit = {}) => {
        paths.push(path);
        return respond(path, init);
      });
  });

  afterEach(() => {
    sandbox.restore();
    clearCookies();
  });

  it('should list products with the given params', async () => {
    render(tree(<ListProbe params={{ search: 'shoe', filters: { 'xp.Brand': 'Acme' } }} />));
    expect(results.a.status).to.equal('loading');
    expect(results.a.isLoading).to.be.true;

    await waitFor(() => expect(results.a.status).to.equal('success'));
    expect(paths).to.deep.equal(['/v1/me/products?search=shoe&xp.Brand=Acme']);
    expect(results.a.items.map((p) => (p as BuyerProduct).ID)).to.deep.equal(['p1a', 'p1b']);
    expect(results.a.meta?.TotalCount).to.equal(10);
    expect(results.a).to.include({ isSuccess: true, isError: false, isRefetching: false });
  });

  it('should be idle and make no requests when disabled', async () => {
    render(tree(<ListProbe options={{ enabled: false }} />));
    await tick();
    expect(results.a.status).to.equal('idle');
    expect(results.a.items).to.deep.equal([]);
    expect(request.called).to.be.false;
    expect(routeAnonymous.called).to.be.false;
  });

  it('should map items with select', async () => {
    const select = (p: BuyerProduct) => p.Name.toUpperCase();
    render(tree(<ListProbe options={{ select: select as UseProductsOptions['select'] }} />));
    await waitFor(() => expect(results.a.status).to.equal('success'));
    expect(results.a.items).to.deep.equal(['PRODUCT P1A', 'PRODUCT P1B']);
    expect(results.a.rawItems[0].ID).to.equal('p1a');
  });

  it('should not refetch when re-rendered with equal inline params', async () => {
    const { rerender } = render(tree(<ListProbe params={{ page: 1, search: 'x' }} />));
    await waitFor(() => expect(results.a.status).to.equal('success'));

    rerender(tree(<ListProbe params={{ search: 'x', page: 1, pageSize: undefined }} />));
    await tick();
    expect(paths).to.have.length(1);
  });

  it('should keep the previous page visible while the next one loads', async () => {
    const { rerender } = render(tree(<ListProbe params={{ page: 1 }} />));
    await waitFor(() => expect(results.a.status).to.equal('success'));

    const slow = deferred<ListPage<BuyerProduct>>();
    respond = () => slow.promise;
    rerender(tree(<ListProbe params={{ page: 2 }} />));

    await waitFor(() => expect(results.a.isRefetching).to.be.true);
    expect(results.a.status).to.equal('success');
    expect(results.a.isLoading).to.be.false;
    expect(results.a.meta?.Page).to.equal(1);

    slow.resolve(listPage(['p2a'], 2));
    await waitFor(() => expect(results.a.meta?.Page).to.equal(2));
    expect(results.a.isRefetching).to.be.false;
  });

  it('should drop a stale response after params change', async () => {
    const slow = deferred<ListPage<BuyerProduct>>();
    respond = () => slow.promise;
    const { rerender } = render(tree(<ListProbe params={{ page: 1 }} />));
    await waitFor(() => expect(paths).to.have.length(1));

    respond = () => listPage(['p2a'], 2);
    rerender(tree(<ListProbe params={{ page: 2 }} />));
    await waitFor(() => expect(results.a.meta?.Page).to.equal(2));

    slow.resolve(listPage(['p1a'], 1));
    await tick();
    expect(results.a.meta?.Page).to.equal(2);
  });

  it('should share one request across components with the same params', async () => {
    render(
      tree(
        <>
          <ListProbe id="a" params={{ search: 'x', page: 1 }} />
          <ListProbe id="b" params={{ page: 1, search: 'x' }} />
        </>
      )
    );
    await waitFor(() => expect(results.b.status).to.equal('success'));
    await tick();
    expect(paths).to.have.length(1);
    expect(results.a.items).to.deep.equal(results.b.items);
  });

  it('should reload on identity change but not on a token refresh', async () => {
    render(tree(<ListProbe />));
    await waitFor(() => expect(results.a.status).to.equal('success'));

    const manager = (commerce.service?.sessionManager as unknown) as { emit(e: unknown): void };
    act(() =>
      manager.emit({
        reason: 'refreshed',
        session: { accessToken: 'r', expiresAt: Date.now() + 600_000, userType: 'anonymous' },
      })
    );
    await tick();
    expect(paths).to.have.length(1);

    await act(async () => {
      await commerce.resetSession();
    });
    await waitFor(() => expect(paths).to.have.length(2));
  });

  it('should render initialData and revalidate once', async () => {
    const slow = deferred<ListPage<BuyerProduct>>();
    respond = () => slow.promise;
    render(tree(<ListProbe options={{ initialData: listPage(['server']) }} />));

    expect(results.a.status).to.equal('success');
    expect(results.a.rawItems[0].ID).to.equal('server');
    await waitFor(() => expect(results.a.isRefetching).to.be.true);

    slow.resolve(listPage(['client']));
    await waitFor(() => expect(results.a.rawItems[0].ID).to.equal('client'));
    await tick();
    expect(paths).to.have.length(1);
  });

  it('should keep initialData without requests when revalidate is false', async () => {
    render(tree(<ListProbe options={{ initialData: listPage(['server']), revalidate: false }} />));
    await tick();
    expect(request.called).to.be.false;

    await act(async () => {
      await commerce.ensureSession();
    });
    await tick();
    expect(request.called).to.be.false;

    await act(async () => {
      await commerce.resetSession();
    });
    await waitFor(() => expect(paths).to.have.length(1));
  });

  it('should load when the params differ from the initialData params', async () => {
    const { rerender } = render(
      tree(<ListProbe params={{ page: 1 }} options={{ initialData: listPage(['server']), revalidate: false }} />)
    );
    rerender(
      tree(<ListProbe params={{ page: 2 }} options={{ initialData: listPage(['server']), revalidate: false }} />)
    );
    await waitFor(() => expect(results.a.meta?.Page).to.equal(2));
    expect(paths).to.have.length(1);
  });

  it('should expose errors and recover on refetch', async () => {
    respond = () => {
      throw new CommerceError('boom', { source: 'ordercloud', status: 500 });
    };
    render(tree(<ListProbe />));
    await waitFor(() => expect(results.a.status).to.equal('error'));
    expect(results.a.error?.message).to.equal('boom');
    expect(results.a.isError).to.be.true;
    await tick();
    expect(paths).to.have.length(1);

    respond = () => listPage(['ok']);
    await act(async () => {
      await results.a.refetch();
    });
    expect(results.a.status).to.equal('success');
    expect(results.a.error).to.equal(null);
  });

  it('should surface invalid filters as an sdk error', async () => {
    render(tree(<ListProbe params={{ filters: { page: 2 } }} />));
    await waitFor(() => expect(results.a.status).to.equal('error'));
    expect(results.a.error?.source).to.equal('sdk');
    expect(request.called).to.be.false;
  });

  it('should propagate session errors', async () => {
    routeAnonymous.rejects(new CommerceError('down', { source: 'network' }));
    render(tree(<ListProbe />));
    await waitFor(() => expect(results.a.status).to.equal('error'));
    expect(results.a.error?.source).to.equal('network');
    expect(request.called).to.be.false;
  });

  it('should abort the request on unmount', async () => {
    let signal: AbortSignal | undefined;
    respond = (_, init) => {
      signal = init.signal ?? undefined;
      return new Promise(() => undefined);
    };
    const { unmount } = render(tree(<ListProbe />));
    await waitFor(() => expect(signal).to.exist);
    unmount();
    expect(signal?.aborted).to.be.true;
  });

  it('should drop products without an ID and keep items aligned with rawItems', async () => {
    respond = () => ({
      Items: [
        product('a'),
        { Name: 'no id' },
        { ID: '  ', Name: 'blank' },
        null,
        product('b'),
      ],
      Meta: { Page: 1, TotalPages: 1 },
    });
    const select = (p: BuyerProduct) => p.ID.toUpperCase();
    render(tree(<ListProbe options={{ select: select as UseProductsOptions['select'] }} />));
    await waitFor(() => expect(results.a.status).to.equal('success'));
    expect(results.a.items).to.deep.equal(['A', 'B']);
    expect(results.a.rawItems.map((p) => p.ID)).to.deep.equal(['a', 'b']);
  });

  describe('keepPreviousData: false', () => {
    it('should never render previous results with new params', async () => {
      const renders: Array<{ search?: string; ids: string[]; status: string }> = [];
      const HistoryProbe = ({ search }: { search: string }) => {
        const state = useProducts({ search }, { keepPreviousData: false });
        renders.push({ search, ids: state.rawItems.map((p) => p.ID), status: state.status });
        return null;
      };
      respond = (path) => listPage([`${new URLSearchParams(path.split('?')[1]).get('search')}-1`]);

      const { rerender } = render(tree(<HistoryProbe search="old" />));
      await waitFor(() => expect(renders[renders.length - 1].ids).to.deep.equal(['old-1']));

      rerender(tree(<HistoryProbe search="new" />));
      await waitFor(() => expect(renders[renders.length - 1].ids).to.deep.equal(['new-1']));

      const newRenders = renders.filter((r) => r.search === 'new');
      expect(newRenders.some((r) => r.ids.includes('old-1'))).to.be.false;
      expect(newRenders[0]).to.deep.include({ ids: [], status: 'loading' });
    });

    it('should not render a previous error with new params', async () => {
      const renders: Array<{ search?: string; status: string }> = [];
      const HistoryProbe = ({ search }: { search: string }) => {
        const state = useProducts({ search }, { keepPreviousData: false });
        renders.push({ search, status: state.status });
        return null;
      };
      respond = () => {
        throw new CommerceError('boom', { source: 'ordercloud', status: 500 });
      };
      const { rerender } = render(tree(<HistoryProbe search="old" />));
      await waitFor(() => expect(renders[renders.length - 1].status).to.equal('error'));

      respond = () => listPage(['ok']);
      rerender(tree(<HistoryProbe search="new" />));
      await waitFor(() => expect(renders[renders.length - 1].status).to.equal('success'));
      expect(renders.filter((r) => r.search === 'new').some((r) => r.status === 'error')).to.be
        .false;
    });

    it('should render idle immediately when disabled', async () => {
      const renders: Array<{ enabled: boolean; count: number }> = [];
      const HistoryProbe = ({ enabled }: { enabled: boolean }) => {
        const state = useProducts({}, { enabled });
        renders.push({ enabled, count: state.items.length });
        return null;
      };
      const { rerender } = render(tree(<HistoryProbe enabled />));
      await waitFor(() => expect(renders[renders.length - 1].count).to.equal(2));
      rerender(tree(<HistoryProbe enabled={false} />));
      expect(renders.filter((r) => !r.enabled).every((r) => r.count === 0)).to.be.true;
    });
    it('should clear items when params change', async () => {
      const options = { keepPreviousData: false };
      const { rerender } = render(tree(<ListProbe params={{ page: 1 }} options={options} />));
      await waitFor(() => expect(results.a.status).to.equal('success'));

      const slow = deferred<ListPage<BuyerProduct>>();
      respond = () => slow.promise;
      rerender(tree(<ListProbe params={{ page: 2 }} options={options} />));

      await waitFor(() => expect(results.a.status).to.equal('loading'));
      expect(results.a.isLoading).to.be.true;
      expect(results.a.items).to.deep.equal([]);
      expect(results.a.meta).to.equal(null);

      slow.resolve(listPage(['p2a'], 2));
      await waitFor(() => expect(results.a.meta?.Page).to.equal(2));
    });

    it('should keep items visible on identity reload and refetch', async () => {
      render(tree(<ListProbe options={{ keepPreviousData: false }} />));
      await waitFor(() => expect(results.a.status).to.equal('success'));

      const slow = deferred<ListPage<BuyerProduct>>();
      respond = () => slow.promise;
      act(() => {
        commerce.resetSession();
      });
      await waitFor(() => expect(results.a.isRefetching).to.be.true);
      expect(results.a.status).to.equal('success');
      expect(results.a.items).to.have.length(2);
      slow.resolve(listPage(['x']));
      await waitFor(() => expect(results.a.isRefetching).to.be.false);

      const slowRefetch = deferred<ListPage<BuyerProduct>>();
      respond = () => slowRefetch.promise;
      let pending: Promise<void> | undefined;
      act(() => {
        pending = results.a.refetch();
      });
      await waitFor(() => expect(results.a.isRefetching).to.be.true);
      expect(results.a.items).to.have.length(1);
      slowRefetch.resolve(listPage(['y']));
      await act(async () => {
        await pending;
      });
    });
  });

  it('should report a provider timeout as a network error', async () => {
    request.restore();
    sandbox.stub(globalThis, 'fetch').callsFake(() => new Promise<Response>(() => undefined));
    render(tree(<ListProbe />, { timeout: 30 }));

    await waitFor(() => expect(results.a.status).to.equal('error'));
    expect(results.a.error?.source).to.equal('network');
    expect(results.a.error?.message).to.include('timed out');
    expect(results.a.isLoading).to.be.false;
  });

  it('should not stay loading when the commerce service disappears mid-load', async () => {
    const pendingToken = deferred<void>();
    routeAnonymous.callsFake(async () => {
      await pendingToken.promise;
      return {
        session: {
          accessToken: 'late',
          expiresAt: Date.now() + 600_000,
          userType: 'anonymous' as const,
        },
        persisted: true,
      };
    });
    const withContext = (clientContextId: string) =>
      (({
        api: { edge: { contextId: 'ctx', clientContextId, edgeUrl: 'https://edge.test' } },
        page: { mode: { isEditing: false, isPreview: false, isDesignLibrary: false } },
      } as unknown) as SitecoreProviderState);
    const ui = (state: SitecoreProviderState) => (
      <SitecoreProviderReactContext.Provider value={state}>
        <CommerceProvider tokens={{ mode: 'route-handler', cookies: { secure: false } }}>
          <ListProbe />
        </CommerceProvider>
      </SitecoreProviderReactContext.Provider>
    );

    const { rerender } = render(ui(withContext('client-ctx')));
    await waitFor(() => expect(routeAnonymous.called).to.be.true);
    rerender(ui(withContext('')));
    pendingToken.resolve();

    await waitFor(() => expect(results.a.status).to.equal('error'));
    expect(results.a.error?.source).to.equal('sdk');
    expect(request.called).to.be.false;
  });
});
