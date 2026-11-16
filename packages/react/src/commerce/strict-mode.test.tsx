/* eslint-disable no-unused-expressions */
import React from 'react';
import { expect } from 'chai';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createSandbox, SinonSandbox } from 'sinon';
import {
  BuyerProduct,
  CommerceError,
  OrderCloudService,
  RouteHandlerTokenClient,
  Spec,
  Variant,
} from '@sitecore-content-sdk/commerce';
import { SitecoreProviderReactContext, SitecoreProviderState } from '../components/SitecoreProvider';
import { CommerceProvider } from './CommerceProvider';
import { ProductProvider } from './ProductProvider';
import { useInfiniteProducts } from './useInfiniteProducts';
import { useProduct } from './useProduct';
import { useProductOptions } from './useProductOptions';
import { useProductSelection } from './useProductSelection';
import { useProducts } from './useProducts';
import { useShopper } from './useShopper';

// React Strict Mode mounts, unmounts and remounts effects on first render. Hooks must still make
// exactly one request per resource and settle instead of waiting for a cancelled load.
// Use the `reactStrictMode` render option: a <React.StrictMode> wrapper passed to renderHook does
// not double-invoke the hook's effects.

const providerState = () =>
  (({
    api: { edge: { contextId: 'ctx', clientContextId: 'client-ctx', edgeUrl: 'https://edge.test' } },
    page: { mode: { isEditing: false, isPreview: false, isDesignLibrary: false } },
  } as unknown) as SitecoreProviderState);

const SHIRT: BuyerProduct = { ID: 'shirt', Name: 'Shirt', SpecCount: 1, VariantCount: 1 };
const COLOR: Spec = {
  ID: 'COLOR',
  Name: 'Color',
  Required: true,
  DefinesVariant: true,
  DefaultOptionID: 'RED',
  Options: [{ ID: 'RED', Value: 'Red' }],
};
const RED: Variant = { ID: 'shirt-red', Active: true, Specs: [{ SpecID: 'COLOR', OptionID: 'RED' }] };

const listPage = (page: number, totalPages = 3) => ({
  Items: [{ ID: `p${page}`, Name: `P${page}` }],
  Meta: { Page: page, TotalPages: totalPages, TotalCount: totalPages },
});

const providersWrapper = (inner?: (children: React.ReactNode) => React.ReactNode) => ({
  children,
}: {
  children: React.ReactNode;
}) => (
  <SitecoreProviderReactContext.Provider value={providerState()}>
    <CommerceProvider tokens={{ mode: 'route-handler', cookies: { secure: false } }}>
      {inner ? inner(children) : children}
    </CommerceProvider>
  </SitecoreProviderReactContext.Provider>
);

const clearCookies = () => {
  document.cookie.split(/;\s*/).forEach((part) => {
    const name = part.split('=')[0];
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('commerce hooks in React Strict Mode', () => {
  let sandbox: SinonSandbox;
  let paths: string[];
  let respond: (path: string) => unknown;

  const count = (pathWithoutQuery: string) =>
    paths.filter((path) => path.split('?')[0] === pathWithoutQuery).length;

  beforeEach(() => {
    sandbox = createSandbox();
    paths = [];
    let tokenCount = 0;
    sandbox.stub(RouteHandlerTokenClient.prototype, 'getAnonymousToken').callsFake(async () => ({
      session: {
        accessToken: `at-${++tokenCount}`,
        expiresAt: Date.now() + 600_000,
        userType: 'anonymous' as const,
      },
      persisted: true,
    }));
    sandbox.stub(RouteHandlerTokenClient.prototype, 'clear').resolves();
    respond = (path) => {
      const [base, query] = path.split('?');
      if (base === '/v1/me') return { ID: 'me', Username: 'me' };
      if (base === '/v1/me/products/shirt') return SHIRT;
      if (base === '/v1/me/products/shirt/specs') return { Items: [COLOR], Meta: { TotalPages: 1 } };
      if (base === '/v1/me/products/shirt/variants') return { Items: [RED], Meta: { TotalPages: 1 } };
      if (base === '/v1/me/products') {
        return listPage(Number(new URLSearchParams(query).get('page') || 1));
      }
      throw new Error(`Unexpected request ${path}`);
    };
    sandbox
      .stub(OrderCloudService.prototype, 'request')
      .callsFake(async (path: string) => {
        paths.push(path);
        return respond(path);
      });
  });

  afterEach(() => {
    sandbox.restore();
    clearCookies();
  });

  describe('useProducts', () => {
    it('should make one request and reach success', async () => {
      const { result } = renderHook(() => useProducts({ search: 'x' }), {
        wrapper: providersWrapper(), reactStrictMode: true,
      });
      await waitFor(() => expect(result.current.status).to.equal('success'));
      await tick();
      expect(count('/v1/me/products')).to.equal(1);
      expect(result.current.items).to.have.length(1);
    });

    it('should make one request and reach error', async () => {
      respond = () => {
        throw new CommerceError('boom', { source: 'ordercloud', status: 500 });
      };
      const { result } = renderHook(() => useProducts(), { wrapper: providersWrapper(), reactStrictMode: true });
      await waitFor(() => expect(result.current.status).to.equal('error'));
      await tick();
      expect(paths).to.have.length(1);
    });

    it('should keep initialData without requests when revalidate is false', async () => {
      const { result } = renderHook(
        () => useProducts({}, { initialData: listPage(1), revalidate: false }),
        { wrapper: providersWrapper(), reactStrictMode: true }
      );
      await tick();
      expect(result.current.status).to.equal('success');
      expect(paths).to.have.length(0);
    });
  });

  describe('useInfiniteProducts', () => {
    it('should make one first-page request, reach success and append pages', async () => {
      const { result } = renderHook(() => useInfiniteProducts({ search: 'x' }), {
        wrapper: providersWrapper(), reactStrictMode: true,
      });
      await waitFor(() => expect(result.current.status).to.equal('success'));
      await tick();
      expect(paths).to.have.length(1);

      await act(async () => {
        await result.current.fetchNextPage();
      });
      expect(paths).to.have.length(2);
      expect(result.current.pages).to.have.length(2);
    });

    it('should make one request and reach error', async () => {
      respond = () => {
        throw new CommerceError('boom', { source: 'ordercloud', status: 500 });
      };
      const { result } = renderHook(() => useInfiniteProducts(), { wrapper: providersWrapper(), reactStrictMode: true });
      await waitFor(() => expect(result.current.status).to.equal('error'));
      await tick();
      expect(paths).to.have.length(1);
    });
  });

  describe('ProductProvider', () => {
    const productWrapper = (productId: string) =>
      providersWrapper((children) => <ProductProvider productId={productId}>{children}</ProductProvider>);

    const useAll = () => ({
      product: useProduct(),
      options: useProductOptions(),
      selection: useProductSelection(),
    });

    it('should make one request per resource and reach success', async () => {
      const { result } = renderHook(useAll, { wrapper: productWrapper('shirt'), reactStrictMode: true });
      await waitFor(() => expect(result.current.options.status).to.equal('success'));
      await tick();
      expect(result.current.product.status).to.equal('success');
      expect(count('/v1/me/products/shirt')).to.equal(1);
      expect(count('/v1/me/products/shirt/specs')).to.equal(1);
      expect(count('/v1/me/products/shirt/variants')).to.equal(1);
      expect(result.current.selection.selectedVariant?.ID).to.equal('shirt-red');
    });

    it('should make one request and reach not-found', async () => {
      respond = () => {
        throw new CommerceError('missing', { source: 'ordercloud', status: 404 });
      };
      const { result } = renderHook(useAll, { wrapper: productWrapper('missing'), reactStrictMode: true });
      await waitFor(() => expect(result.current.product.status).to.equal('not-found'));
      await tick();
      expect(paths).to.have.length(1);
    });
  });

  describe('useShopper', () => {
    it('should make one /v1/me request and reach success', async () => {
      const { result } = renderHook(() => useShopper(), { wrapper: providersWrapper(), reactStrictMode: true });
      await waitFor(() => expect(result.current.status).to.equal('success'));
      await tick();
      expect(count('/v1/me')).to.equal(1);
    });
  });
});
