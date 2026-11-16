/* eslint-disable no-unused-expressions */
import React from 'react';
import { expect } from 'chai';
import { act, render, waitFor } from '@testing-library/react';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import {
  BuyerProduct,
  CommerceError,
  OrderCloudService,
  RouteHandlerTokenClient,
  Spec,
  SpecSelection,
  Variant,
} from '@sitecore-content-sdk/commerce';
import { SitecoreProviderReactContext, SitecoreProviderState } from '../components/SitecoreProvider';
import { CommerceContextValue, CommerceProvider, useCommerce } from './CommerceProvider';
import { ProductProvider, ProductProviderProps } from './ProductProvider';
import { UseProductState, useProduct } from './useProduct';
import { UseProductOptionsState, useProductOptions } from './useProductOptions';
import { UseProductSelectionState, useProductSelection } from './useProductSelection';

const providerState = () =>
  (({
    api: { edge: { contextId: 'ctx', clientContextId: 'client-ctx', edgeUrl: 'https://edge.test' } },
    page: { mode: { isEditing: false, isPreview: false, isDesignLibrary: false } },
  } as unknown) as SitecoreProviderState);

const PLAIN: BuyerProduct = { ID: 'plain', Name: 'Plain', SpecCount: 0, VariantCount: 0 };
const SPECS_ONLY: BuyerProduct = { ID: 'specs', Name: 'Specs only', SpecCount: 1, VariantCount: 0 };
const VARIANTS: BuyerProduct = { ID: 'shirt', Name: 'Shirt', SpecCount: 2, VariantCount: 2 };

const COLOR: Spec = {
  ID: 'COLOR',
  Name: 'Color',
  Required: true,
  DefinesVariant: true,
  DefaultOptionID: 'RED',
  Options: [
    { ID: 'RED', Value: 'Red' },
    { ID: 'BLUE', Value: 'Blue' },
    { ID: 'GREEN', Value: 'Green' },
  ],
};
const ENGRAVING: Spec = { ID: 'ENGRAVING', Name: 'Engraving', AllowOpenText: true };
const SIZE: Spec = {
  ID: 'SIZE',
  Name: 'Size',
  Required: true,
  Options: [
    { ID: 'S', Value: 'S' },
    { ID: 'M', Value: 'M' },
  ],
};
const SHIRT_VARIANTS: Variant[] = [
  { ID: 'shirt-red', Active: true, Specs: [{ SpecID: 'COLOR', OptionID: 'RED' }] },
  { ID: 'shirt-blue', Active: true, Specs: [{ SpecID: 'COLOR', OptionID: 'BLUE' }] },
];

const list = <T,>(items: T[]) => ({ Items: items, Meta: { Page: 1, TotalPages: 1 } });

type Handler = (path: string, init: RequestInit) => unknown;

let commerce: CommerceContextValue;
const CommerceProbe = () => {
  commerce = useCommerce();
  return null;
};

let product: UseProductState<unknown> | null;
let options: UseProductOptionsState | null;
let selection: UseProductSelectionState | null;
let productRenders = 0;

const ProductProbe = () => {
  productRenders += 1;
  product = useProduct({ optional: true });
  return null;
};
const OptionsProbe = () => {
  options = useProductOptions({ optional: true });
  return null;
};
const SelectionProbe = () => {
  selection = useProductSelection({ optional: true });
  return null;
};

const Probes = () => (
  <>
    <ProductProbe />
    <OptionsProbe />
    <SelectionProbe />
  </>
);

const tree = (props: Partial<ProductProviderProps>, extra: React.ReactNode = null) => (
  <SitecoreProviderReactContext.Provider value={providerState()}>
    <CommerceProvider tokens={{ mode: 'route-handler', cookies: { secure: false } }}>
      <CommerceProbe />
      <ProductProvider productId={undefined} {...props}>
        <Probes />
      </ProductProvider>
      {extra}
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const abortable = <T,>(init: RequestInit, promise: Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
    promise.then(resolve, reject);
  });

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('ProductProvider', () => {
  let sandbox: SinonSandbox;
  let routeAnonymous: SinonStub;
  let request: SinonStub;
  let handlers: Record<string, Handler>;
  let paths: string[];
  let tokenCount: number;

  const calls = (suffix: string) => paths.filter((path) => path.split('?')[0].endsWith(suffix));

  beforeEach(() => {
    sandbox = createSandbox();
    tokenCount = 0;
    paths = [];
    product = null;
    options = null;
    selection = null;
    productRenders = 0;
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
    handlers = {
      '/v1/me/products/plain': () => PLAIN,
      '/v1/me/products/specs': () => SPECS_ONLY,
      '/v1/me/products/specs/specs': () => list([SIZE]),
      '/v1/me/products/shirt': () => VARIANTS,
      '/v1/me/products/shirt/specs': () => list([COLOR, ENGRAVING]),
      '/v1/me/products/shirt/variants': () => list(SHIRT_VARIANTS),
    };
    request = sandbox
      .stub(OrderCloudService.prototype, 'request')
      .callsFake(async (path: string, init: RequestInit = {}) => {
        paths.push(path);
        const handler = handlers[path.split('?')[0]];
        if (!handler) throw new Error(`Unexpected request ${path}`);
        return handler(path, init);
      });
  });

  afterEach(() => {
    sandbox.restore();
    clearCookies();
  });

  describe('loading', () => {
    it('should be idle without a product ID and make no requests', async () => {
      render(tree({ productId: '  ' }));
      await tick();
      expect(product?.status).to.equal('idle');
      expect(options?.status).to.equal('idle');
      expect(request.called).to.be.false;
      expect(routeAnonymous.called).to.be.false;
    });

    it('should be idle when disabled', async () => {
      render(tree({ productId: 'plain', enabled: false }));
      await tick();
      expect(product?.status).to.equal('idle');
      expect(request.called).to.be.false;
    });

    it('should not request specs or variants when SpecCount is 0', async () => {
      render(tree({ productId: 'plain' }));
      expect(product?.status).to.equal('loading');
      expect(product?.isLoading).to.be.true;

      await waitFor(() => expect(options?.status).to.equal('success'));
      expect(product).to.include({ status: 'success', isSuccess: true, productId: 'plain' });
      expect(product?.rawProduct).to.deep.equal(PLAIN);
      expect(paths).to.deep.equal(['/v1/me/products/plain']);
      expect(selection?.isComplete).to.be.true;
      expect(selection?.getLineItemDraft()).to.deep.equal({ ProductID: 'plain', Specs: [] });
    });

    it('should not request variants when no spec defines variants', async () => {
      render(tree({ productId: 'specs' }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      expect(calls('/variants')).to.have.length(0);
      expect(options?.specs.map((s) => s.ID)).to.deep.equal(['SIZE']);
      expect(options?.hasVariantSpecs).to.be.false;
    });

    it('should not request variants when VariantCount is 0', async () => {
      handlers['/v1/me/products/shirt'] = () => ({ ...VARIANTS, VariantCount: 0 });
      render(tree({ productId: 'shirt' }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      expect(calls('/variants')).to.have.length(0);
      expect(selection?.issues).to.deep.equal([{ specId: '', code: 'variant-unavailable' }]);
    });

    it('should load specs and active variants and compute initial selections', async () => {
      render(tree({ productId: 'shirt' }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      expect(calls('/variants')[0]).to.include('Active=true');
      expect(options?.optionAvailability).to.deep.equal({
        COLOR: { RED: true, BLUE: true, GREEN: false },
      });
      expect(selection?.selections).to.deep.equal({ COLOR: { optionId: 'RED' } });
      expect(selection?.selectedVariant?.ID).to.equal('shirt-red');
      expect(selection?.getLineItemDraft()).to.deep.equal({
        ProductID: 'shirt',
        VariantID: 'shirt-red',
        Specs: [{ SpecID: 'COLOR', OptionID: 'RED' }],
      });
    });

    it('should apply initialSelections over defaults', async () => {
      render(tree({ productId: 'shirt', initialSelections: { COLOR: { optionId: 'BLUE' } } }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      expect(selection?.selectedVariant?.ID).to.equal('shirt-blue');
    });

    it('should map the product with select', async () => {
      const select = (p: BuyerProduct) => ({ title: p.Name.toUpperCase() });
      render(tree({ productId: 'plain', select: select as ProductProviderProps['select'] }));
      await waitFor(() => expect(product?.status).to.equal('success'));
      expect(product?.product).to.deep.equal({ title: 'PLAIN' });
    });

    it('should report not-found for an OrderCloud 404', async () => {
      handlers['/v1/me/products/plain'] = () => {
        throw new CommerceError('Not found', { source: 'ordercloud', status: 404 });
      };
      render(tree({ productId: 'plain' }));
      await waitFor(() => expect(product?.status).to.equal('not-found'));
      expect(product?.isNotFound).to.be.true;
      expect(product?.error).to.equal(null);
    });

    it('should report an error for a proxy 404', async () => {
      handlers['/v1/me/products/plain'] = () => {
        throw new CommerceError('Proxy', { source: 'proxy', status: 404 });
      };
      render(tree({ productId: 'plain' }));
      await waitFor(() => expect(product?.status).to.equal('error'));
      expect(product?.error?.source).to.equal('proxy');
    });

    it('should propagate session errors', async () => {
      routeAnonymous.rejects(new CommerceError('down', { source: 'network' }));
      render(tree({ productId: 'plain' }));
      await waitFor(() => expect(product?.status).to.equal('error'));
      expect(product?.error?.source).to.equal('network');
      expect(request.called).to.be.false;
    });

    it('should report options errors separately', async () => {
      handlers['/v1/me/products/shirt/specs'] = () => {
        throw new CommerceError('boom', { source: 'ordercloud', status: 500 });
      };
      render(tree({ productId: 'shirt' }));
      await waitFor(() => expect(options?.status).to.equal('error'));
      expect(product?.status).to.equal('success');
      expect(options?.isError).to.be.true;
      expect(selection?.isComplete).to.be.false;
      expect(selection?.getLineItemDraft()).to.equal(null);
    });

    it('should drop a stale response after the product ID changes', async () => {
      const slow = deferred<BuyerProduct>();
      handlers['/v1/me/products/plain'] = (_, init) => abortable(init, slow.promise);
      const { rerender } = render(tree({ productId: 'plain' }));
      await waitFor(() => expect(calls('/plain')).to.have.length(1));

      rerender(tree({ productId: 'specs' }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      slow.resolve(PLAIN);
      await tick();

      expect(product?.productId).to.equal('specs');
      expect(product?.rawProduct?.ID).to.equal('specs');
    });

    it('should clear data when the product ID changes', async () => {
      const { rerender } = render(tree({ productId: 'plain' }));
      await waitFor(() => expect(product?.status).to.equal('success'));
      const slow = deferred<BuyerProduct>();
      handlers['/v1/me/products/specs'] = () => slow.promise;

      rerender(tree({ productId: 'specs' }));
      await waitFor(() => expect(product?.status).to.equal('loading'));
      expect(product?.rawProduct).to.equal(null);
      slow.resolve(SPECS_ONLY);
      await waitFor(() => expect(product?.status).to.equal('success'));
    });

    it('should report a provider timeout as an error, not stay loading', async () => {
      request.restore();
      sandbox.stub(globalThis, 'fetch').callsFake(() => new Promise<Response>(() => undefined));
      render(
        <SitecoreProviderReactContext.Provider value={providerState()}>
          <CommerceProvider
            tokens={{ mode: 'route-handler', cookies: { secure: false } }}
            timeout={30}
          >
            <ProductProvider productId="plain">
              <Probes />
            </ProductProvider>
          </CommerceProvider>
        </SitecoreProviderReactContext.Provider>
      );
      await waitFor(() => expect(product?.status).to.equal('error'));
      expect(product?.error?.source).to.equal('network');
    });

    it('should abort in-flight requests on unmount', async () => {
      let signal: AbortSignal | undefined;
      handlers['/v1/me/products/plain'] = (_, init) => {
        signal = init.signal ?? undefined;
        return abortable(init, new Promise(() => undefined));
      };
      const { unmount } = render(tree({ productId: 'plain' }));
      await waitFor(() => expect(signal).to.exist);
      unmount();
      expect(signal?.aborted).to.be.true;
    });
  });

  describe('identity changes', () => {
    it('should reload on identity change, keeping data visible', async () => {
      render(tree({ productId: 'shirt' }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      expect(calls('/shirt')).to.have.length(1);

      const slow = deferred<BuyerProduct>();
      handlers['/v1/me/products/shirt'] = () => slow.promise;
      act(() => {
        commerce.resetSession();
      });

      await waitFor(() => expect(product?.isRefetching).to.be.true);
      expect(product?.status).to.equal('success');
      expect(product?.rawProduct?.ID).to.equal('shirt');

      slow.resolve({ ...VARIANTS, Name: 'Shirt (registered)' });
      await waitFor(() => expect(product?.isRefetching).to.be.false);
      expect(product?.rawProduct?.Name).to.equal('Shirt (registered)');
      expect(calls('/shirt')).to.have.length(2);
    });

    it('should keep selections across an identity reload when still valid', async () => {
      render(tree({ productId: 'shirt' }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      act(() => selection?.setSelection('COLOR', { optionId: 'BLUE' }));

      await act(async () => {
        await commerce.resetSession();
      });
      await waitFor(() => expect(calls('/shirt')).to.have.length(2));
      await waitFor(() => expect(calls('/shirt/variants')).to.have.length(2));
      await tick();
      expect(selection?.selections.COLOR).to.deep.equal({ optionId: 'BLUE' });
    });

    it('should recompute selections when a selected option no longer exists', async () => {
      render(tree({ productId: 'shirt' }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      act(() => selection?.setSelection('COLOR', { optionId: 'BLUE' }));

      handlers['/v1/me/products/shirt/specs'] = () =>
        list([{ ...COLOR, Options: [{ ID: 'RED', Value: 'Red' }] }, ENGRAVING]);
      await act(async () => {
        await commerce.resetSession();
      });
      await waitFor(() => expect(calls('/shirt/variants')).to.have.length(2));
      await waitFor(() => expect(selection?.selections.COLOR).to.deep.equal({ optionId: 'RED' }));
    });

    it('should not reload on a token refresh', async () => {
      render(tree({ productId: 'plain' }));
      await waitFor(() => expect(product?.status).to.equal('success'));
      const manager = commerce.service?.sessionManager as unknown as {
        emit(event: unknown): void;
      };
      act(() =>
        manager.emit({
          reason: 'refreshed',
          session: { accessToken: 'r', expiresAt: Date.now() + 600_000, userType: 'anonymous' },
        })
      );
      await tick();
      expect(calls('/plain')).to.have.length(1);
    });
  });

  describe('initialData', () => {
    it('should render initial data as success and revalidate once', async () => {
      const slow = deferred<BuyerProduct>();
      handlers['/v1/me/products/plain'] = () => slow.promise;
      render(
        tree({ productId: 'plain', initialData: { product: { ...PLAIN, Name: 'Server' } } })
      );

      expect(product?.status).to.equal('success');
      expect(product?.rawProduct?.Name).to.equal('Server');
      await waitFor(() => expect(product?.isRefetching).to.be.true);
      expect(product?.isLoading).to.be.false;

      slow.resolve({ ...PLAIN, Name: 'Client' });
      await waitFor(() => expect(product?.rawProduct?.Name).to.equal('Client'));
      await tick();
      expect(calls('/plain')).to.have.length(1);
    });

    it('should not request anything when revalidate is false and options are complete', async () => {
      render(
        tree({
          productId: 'shirt',
          revalidate: false,
          initialData: { product: VARIANTS, specs: [COLOR, ENGRAVING], variants: SHIRT_VARIANTS },
        })
      );
      expect(options?.status).to.equal('success');
      expect(selection?.selectedVariant?.ID).to.equal('shirt-red');
      await tick();
      expect(request.called).to.be.false;

      // first session acquisition elsewhere does not reload
      await act(async () => {
        await commerce.ensureSession();
      });
      await tick();
      expect(request.called).to.be.false;

      // identity change does
      await act(async () => {
        await commerce.resetSession();
      });
      await waitFor(() => expect(calls('/shirt')).to.have.length(1));
    });

    it('should load missing options without refetching the product when revalidate is false', async () => {
      render(tree({ productId: 'shirt', revalidate: false, initialData: { product: VARIANTS } }));
      expect(product?.status).to.equal('success');
      expect(options?.status).to.equal('loading');
      await waitFor(() => expect(options?.status).to.equal('success'));
      expect(calls('/shirt')).to.have.length(0);
      expect(calls('/shirt/specs')).to.have.length(1);
      expect(calls('/shirt/variants')).to.have.length(1);
    });
  });

  describe('hooks', () => {
    const silenced = (fn: () => void) => {
      const original = console.error;
      console.error = () => undefined;
      try {
        fn();
      } finally {
        console.error = original;
      }
    };

    it('should throw outside a ProductProvider by default', () => {
      const Strict = ({ hook }: { hook: () => unknown }) => {
        hook();
        return null;
      };
      silenced(() => {
        expect(() => render(<Strict hook={() => useProduct()} />)).to.throw('useProduct must');
        expect(() => render(<Strict hook={() => useProductOptions()} />)).to.throw(
          'useProductOptions must'
        );
        expect(() => render(<Strict hook={() => useProductSelection()} />)).to.throw(
          'useProductSelection must'
        );
      });
    });

    it('should return null outside a ProductProvider when optional', () => {
      product = options = selection = {} as never;
      render(<Probes />);
      expect(product).to.equal(null);
      expect(options).to.equal(null);
      expect(selection).to.equal(null);
    });

    it('should throw when ProductProvider has no CommerceProvider', () => {
      silenced(() => {
        expect(() => render(<ProductProvider productId="x" />)).to.throw('CommerceProvider');
      });
    });

    it('should not re-render product-only consumers on selection changes', async () => {
      render(tree({ productId: 'shirt' }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      await tick();
      const before = productRenders;

      act(() => selection?.setSelection('COLOR', { optionId: 'BLUE' }));
      act(() => selection?.setSelection('ENGRAVING', { value: 'Hi' }));

      expect(selection?.selectedVariant?.ID).to.equal('shirt-blue');
      expect(productRenders).to.equal(before);
    });

    it('should reveal issues on touch and validate()', async () => {
      render(tree({ productId: 'specs' }));
      await waitFor(() => expect(options?.status).to.equal('success'));

      expect(selection?.issues).to.deep.equal([{ specId: 'SIZE', code: 'required' }]);
      expect(selection?.visibleIssues).to.deep.equal([]);
      expect(selection?.isComplete).to.be.false;
      expect(selection?.getLineItemDraft()).to.equal(null);

      let valid: boolean | undefined;
      act(() => {
        valid = selection?.validate();
      });
      expect(valid).to.be.false;
      expect(selection?.visibleIssues).to.deep.equal([{ specId: 'SIZE', code: 'required' }]);

      act(() => selection?.setSelection('SIZE', { optionId: 'M' }));
      expect(selection?.visibleIssues).to.deep.equal([]);
      expect(selection?.isComplete).to.be.true;
      expect(selection?.getLineItemDraft()).to.deep.equal({
        ProductID: 'specs',
        Specs: [{ SpecID: 'SIZE', OptionID: 'M' }],
      });

      act(() => selection?.resetSelections());
      expect(selection?.selections).to.deep.equal({});
      expect(selection?.visibleIssues).to.deep.equal([]);
    });

    it('should show issues for touched specs only', async () => {
      render(tree({ productId: 'specs' }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      act(() => selection?.setSelection('SIZE', { optionId: 'XL' }));
      expect(selection?.visibleIssues).to.deep.equal([{ specId: 'SIZE', code: 'invalid-option' }]);
    });

    it('should append validateSpec issues for specs without OrderCloud issues', async () => {
      const validateSpec = (spec: Spec, value: SpecSelection) =>
        spec.ID === 'ENGRAVING' && value.value && value.value.length < 3
          ? { specId: spec.ID, code: 'min-length', params: { min: 3 } }
          : undefined;
      render(tree({ productId: 'shirt', validateSpec }));
      await waitFor(() => expect(options?.status).to.equal('success'));

      act(() => selection?.setSelection('ENGRAVING', { value: 'Hi' }));
      expect(selection?.visibleIssues).to.deep.equal([
        { specId: 'ENGRAVING', code: 'min-length', params: { min: 3 } },
      ]);
      expect(selection?.isComplete).to.be.false;

      act(() => selection?.setSelection('ENGRAVING', { value: 'Hello' }));
      expect(selection?.issues).to.deep.equal([]);
      expect(selection?.getLineItemDraft()?.Specs).to.deep.equal([
        { SpecID: 'COLOR', OptionID: 'RED' },
        { SpecID: 'ENGRAVING', Value: 'Hello' },
      ]);
    });

    it('should report variant-unavailable after a variant spec is touched', async () => {
      render(tree({ productId: 'shirt' }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      act(() => selection?.setSelection('COLOR', { optionId: 'GREEN' }));
      expect(selection?.visibleIssues).to.deep.equal([{ specId: '', code: 'variant-unavailable' }]);
      expect(selection?.selectedVariant).to.equal(undefined);
    });

    it('should refetch the product and options', async () => {
      render(tree({ productId: 'shirt' }));
      await waitFor(() => expect(options?.status).to.equal('success'));
      await act(async () => {
        await product?.refetch();
      });
      expect(calls('/shirt')).to.have.length(2);
      expect(calls('/shirt/specs')).to.have.length(2);

      await act(async () => {
        await options?.refetch();
      });
      expect(calls('/shirt')).to.have.length(2);
      expect(calls('/shirt/specs')).to.have.length(3);
    });
  });

  describe('dedupe', () => {
    const Second = ({ id }: { id: string }) => <ProductProvider productId={id} />;

    it('should share one request per resource across providers', async () => {
      render(tree({ productId: 'shirt' }, <Second id="shirt" />));
      await waitFor(() => expect(options?.status).to.equal('success'));
      await tick();
      expect(calls('/shirt')).to.have.length(1);
      expect(calls('/shirt/specs')).to.have.length(1);
      expect(calls('/shirt/variants')).to.have.length(1);
    });

    it('should not share requests across identities', async () => {
      render(tree({ productId: 'shirt' }, <Second id="shirt" />));
      await waitFor(() => expect(options?.status).to.equal('success'));
      await tick();

      await act(async () => {
        await commerce.resetSession();
      });
      await waitFor(() => expect(calls('/shirt/variants')).to.have.length(2));
      await tick();
      expect(calls('/shirt')).to.have.length(2);
      expect(calls('/shirt/specs')).to.have.length(2);
    });

    it('should keep the shared request alive when one consumer aborts', async () => {
      const slow = deferred<BuyerProduct>();
      let signal: AbortSignal | undefined;
      handlers['/v1/me/products/plain'] = (_, init) => {
        signal = init.signal ?? undefined;
        return abortable(init, slow.promise);
      };
      const Toggle = ({ show }: { show: boolean }) => (show ? <Second id="plain" /> : null);
      const { rerender } = render(tree({ productId: 'plain' }, <Toggle show />));
      await waitFor(() => expect(signal).to.exist);

      rerender(tree({ productId: 'plain' }, <Toggle show={false} />));
      expect(signal?.aborted).to.be.false;

      slow.resolve(PLAIN);
      await waitFor(() => expect(product?.status).to.equal('success'));
      expect(calls('/plain')).to.have.length(1);
    });
  });
});
