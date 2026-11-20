/* eslint-disable no-unused-expressions */
import React from 'react';
import { expect } from 'chai';
import { act, render, waitFor } from '@testing-library/react';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import {
  CommerceError,
  EdgeTokenClient,
  OrderCloudService,
  RouteHandlerTokenClient,
  ShopperSession,
} from '@sitecore-content-sdk/commerce';
import { SitecoreProviderReactContext, SitecoreProviderState } from '../components/SitecoreProvider';
import { CommerceProvider, CommerceContextValue, useCommerce } from './CommerceProvider';
import { ProductProvider } from './ProductProvider';
import { useCart, UseCartState } from './useCart';
import { useAddToCart } from './useAddToCart';

const NOT_EDITING = { isEditing: false, isPreview: false, isDesignLibrary: false };
const providerState = (mode: Partial<typeof NOT_EDITING> = {}): SitecoreProviderState =>
  (({
    api: { edge: { contextId: 'ctx', clientContextId: 'client-ctx', edgeUrl: 'https://edge.test' } },
    page: { mode: { ...NOT_EDITING, ...mode } },
  } as unknown) as SitecoreProviderState);

const session = (accessToken: string, userType: 'anonymous' | 'registered' = 'anonymous') => ({
  session: {
    accessToken,
    expiresAt: Date.now() + 600_000,
    userType,
  } as ShopperSession,
  persisted: true,
});

let commerce: CommerceContextValue;
const CommerceProbe = () => {
  commerce = useCommerce();
  return null;
};

let cartState: UseCartState;
const CartProbe = ({ id = 'cart' }: { id?: string }) => {
  cartState = useCart();
  return (
    <span id={id}>
      {JSON.stringify({
        id: cartState.data?.order.ID ?? null,
        itemCount: cartState.itemCount,
        status: cartState.status,
        loading: cartState.isLoading,
        mutating: cartState.isMutating,
        reset: cartState.cartReset?.reason ?? null,
      })}
    </span>
  );
};

let addToCart: ReturnType<typeof useAddToCart>['addToCart'];
let canAdd: boolean;
const AddToCartProbe = () => {
  const state = useAddToCart();
  addToCart = state.addToCart;
  canAdd = state.canAdd;
  return <span id="can-add">{String(canAdd)}</span>;
};

const readCart = (container: HTMLElement, id = 'cart') =>
  JSON.parse(container.querySelector(`#${id}`)?.textContent || '{}');

const renderCart = (
  ui: React.ReactNode,
  state: SitecoreProviderState = providerState()
) =>
  render(
    <SitecoreProviderReactContext.Provider value={state}>
      <CommerceProvider tokens={{ mode: 'route-handler', cookies: { secure: false } }}>
        <CommerceProbe />
        {ui}
      </CommerceProvider>
    </SitecoreProviderReactContext.Provider>
  );

describe('commerce cart (react)', () => {
  let sandbox: SinonSandbox;
  let request: SinonStub;
  let routeAnonymous: SinonStub;
  let tokenCount: number;
  let cartGetCount: number;

  beforeEach(() => {
    sandbox = createSandbox();
    tokenCount = 0;
    cartGetCount = 0;
    routeAnonymous = sandbox
      .stub(RouteHandlerTokenClient.prototype, 'getAnonymousToken')
      .callsFake(async () => session(`at-${++tokenCount}`));
    sandbox.stub(RouteHandlerTokenClient.prototype, 'clear').resolves();
    sandbox
      .stub(EdgeTokenClient.prototype, 'getAnonymousToken')
      .callsFake(async () => ({ ...session(`at-${++tokenCount}`), persisted: false }));
    request = sandbox.stub(OrderCloudService.prototype, 'request').callsFake(async (path, init) => {
      if (path === '/v1/cart' && (!init?.method || init.method === 'GET')) {
        cartGetCount += 1;
        return { ID: `cart-${cartGetCount}`, Status: 'Unsubmitted' };
      }
      if (path.startsWith('/v1/cart/lineitems?')) {
        return {
          Items: [{ ID: 'line-1', ProductID: 'p1', Quantity: 2 }],
          Meta: { Page: 1, PageSize: 100, TotalPages: 1, TotalCount: 1 },
        };
      }
      if (path === '/v1/cart/lineitems' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return { ...body };
      }
      if (path.startsWith('/v1/cart/lineitems/')) {
        return { ID: path.split('/').at(-1), ProductID: 'p1', Quantity: 1 };
      }
      return {};
    });
  });

  afterEach(() => sandbox.restore());

  it('shares one lazy cart load across consumers', async () => {
    const { container } = renderCart(
      <>
        <CartProbe id="a" />
        <CartProbe id="b" />
      </>
    );

    await waitFor(() => expect(readCart(container, 'a').status).to.equal('success'));
    expect(readCart(container, 'a')).to.deep.include({
      id: 'cart-1',
      itemCount: 2,
      reset: null,
    });
    expect(readCart(container, 'b').id).to.equal('cart-1');
    expect(
      request.getCalls().filter((call) => call.args[0] === '/v1/cart')
    ).to.have.length(1);
    expect(
      request.getCalls().filter((call) => String(call.args[0]).startsWith('/v1/cart/lineitems?'))
    ).to.have.length(1);
    expect(routeAnonymous.calledOnce).to.be.true;
  });

  it('reloads and reports a replaced anonymous cart on identity change', async () => {
    const { container } = renderCart(<CartProbe />);
    await waitFor(() => expect(readCart(container).status).to.equal('success'));

    await act(async () => {
      await commerce.resetSession();
    });

    await waitFor(() => expect(readCart(container).id).to.equal('cart-2'));
    expect(readCart(container).reset).to.equal('session-replaced');
  });

  it('does not request line items when the shopper has no cart', async () => {
    request.callsFake(async (path) => {
      if (path === '/v1/cart') return { ID: null, Status: 'Unsubmitted' };
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    const { container } = renderCart(<CartProbe />);

    await waitFor(() => expect(readCart(container).status).to.equal('success'));
    expect(readCart(container)).to.deep.include({ id: null, itemCount: 0 });
    expect(request.calledOnce).to.equal(true);
  });

  it('reloads cart data after a mutation and exposes spent-session renewal', async () => {
    const { container } = renderCart(<CartProbe />);
    await waitFor(() => expect(readCart(container).status).to.equal('success'));
    sandbox.stub(commerce.service!.cart, 'addLineItem').resolves({
      lineItem: { ID: 'line-new', ProductID: 'p1', Quantity: 1 },
      sessionRenewed: true,
    });

    await act(async () => {
      await cartState.addLineItem({
        ProductID: 'p1',
        Quantity: 1,
        Specs: [],
      });
    });

    await waitFor(() => expect(readCart(container).mutating).to.equal(false));
    expect(readCart(container).reset).to.equal('cart-submitted');
    expect(cartGetCount).to.equal(2);
  });

  it('rejects cart mutations in editing mode without an OrderCloud request', async () => {
    renderCart(<CartProbe />, providerState({ isEditing: true }));
    await waitFor(() => expect(cartState.status).to.equal('success'));
    const before = request.callCount;

    const error = await act(() =>
      cartState
        .addLineItem({ ProductID: 'p1', Quantity: 1, Specs: [] })
        .catch((caught) => caught)
    );

    expect(error).to.be.instanceOf(CommerceError);
    expect(error.code).to.equal('editing-mode');
    expect(request.callCount).to.equal(before);
  });

  it('queues cart mutations in provider order', async () => {
    renderCart(<CartProbe />);
    await waitFor(() => expect(cartState.status).to.equal('success'));
    let releaseFirst = () => undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const update = sandbox.stub(commerce.service!.cart, 'updateLineItem');
    update.onFirstCall().callsFake(async () => first);
    update.onSecondCall().resolves({
      ID: 'line-2',
      ProductID: 'p1',
      Quantity: 2,
    });

    let second: Promise<void>;
    act(() => {
      void cartState.updateLineItem('line-1', 2);
      second = cartState.updateLineItem('line-2', 3);
    });
    await waitFor(() => expect(update.calledOnce).to.equal(true));

    releaseFirst();
    await act(async () => {
      await second!;
    });
    expect(update.getCalls().map((call) => call.args[0])).to.deep.equal(['line-1', 'line-2']);
  });

  it('validates quantity through useAddToCart and adds a complete draft', async () => {
    renderCart(
      <ProductProvider
        productId="p1"
        revalidate={false}
        options="none"
        initialData={{
          product: {
            ID: 'p1',
            Name: 'Product',
            SpecCount: 0,
            PriceSchedule: { MinQuantity: 2, PriceBreaks: [] },
          },
        }}
      >
        <AddToCartProbe />
      </ProductProvider>
    );
    await waitFor(() => expect(canAdd).to.equal(true));

    const invalid = await addToCart(1);
    expect(invalid).to.deep.equal({
      ok: false,
      reason: 'quantity',
      quantityIssue: { code: 'quantity-below-min' },
    });
    const added = await act(() => addToCart(2));
    expect(added.ok).to.equal(true);
  });
});
