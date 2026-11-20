# Sitecore Content SDK Commerce

This module is provided as a part of Sitecore Content SDK. It contains APIs for SitecoreAI sites with OrderCloud enabled: shopper token retrieval through the Sitecore Edge commerce proxy, client-side token storage, session management, and an `OrderCloudService` for OrderCloud buyer APIs.

[Documentation](https://doc.sitecore.com/xmc/en/developers/content-sdk/index.html)

## Shopper sessions

Tokens come from a **token client** and are kept in a **token store**. A `ShopperSessionManager` owns the lifecycle:

- Anonymous shoppers get a `client_credentials` token. OrderCloud does not issue refresh tokens for anonymous shoppers, so the anonymous identity (and its cart) lasts as long as the buyer API client's `AnonymousTokenDuration`. When it expires, a new anonymous identity is created and a `replaced` session event is emitted.
- Registered sessions are refreshed with their refresh token.
- Concurrent requests share one token request; a request rejected with HTTP 401 is retried once with a renewed session.
- Network and server errors are surfaced and never silently replace the current identity.

```ts
import { OrderCloudService } from '@sitecore-content-sdk/commerce';

// Server or browser; defaults to an Edge token client with an in-memory token store
const service = new OrderCloudService({ contextId: 'SITECORE_EDGE_CONTEXT_ID' });

const me = await service.me.get(); // GET /v1/me (anonymous or registered)
const product = await service.products.get('product-id'); // GET /v1/me/products/{id}
```

## Products

`service.products` returns OrderCloud's own (PascalCase) shapes, with prices and visibility for the current shopper:

```ts
const page = await service.products.list({ search: 'shoe', filters: { 'xp.Brand': 'Acme' } });
const specs = await service.products.listSpecs('product-id'); // follows pages (max 20 by default)
const variants = await service.products.listVariants('product-id', { filters: { Active: true } });
```

`isProductNotFoundError(error)` is true only for an OrderCloud 404, not for a commerce proxy 404 (endpoint not enabled).

Pure helpers implement OrderCloud spec and variant rules and work anywhere (server, browser, tests): `getInitialSelections`, `resolveVariant`, `getOptionAvailability`, `validateSelections` (returns issue codes such as `required` or `variant-unavailable` for the app to localize) and `toLineItemSpecs`. `estimateUnitPrice` gives a display estimate only; OrderCloud computes the authoritative price.

In React, use `ProductProvider` with `useProduct`, `useProductOptions` and `useProductSelection` from `@sitecore-content-sdk/react/commerce` (or `@sitecore-content-sdk/nextjs/commerce`) for a single product, `useProducts(params)` for a page of products, and `useInfiniteProducts(params)` for infinite scroll. Pass `timeout` to `CommerceProvider` to bound every commerce request.

## Cart and orders

`service.cart` wraps the shopper cart, line items and submit operation. Add-to-cart uses a
client-generated line-item ID so an ambiguous retry can be resolved without creating duplicates:

```ts
const result = await service.cart.addLineItem({
  ProductID: product.ID,
  Quantity: 1,
  Specs: [],
});

const cart = await service.cart.get();
const order = await service.orders.get(submittedOrderId);
```

The cart API never deletes a cart to recover from a 409. It reads back the line item, retries when a
concurrent first add created the cart, or renews only a spent anonymous session. `validateQuantity`
returns localization-safe issue codes for product minimums, restricted quantities and multipliers.

In React, `useCart()` shares one cart and serializes mutations across consumers. `useAddToCart()` layers
product selection and quantity validation over the shared cart. Cart mutations reject in editing,
preview and Design Library modes.

Server routes can use `@sitecore-content-sdk/nextjs/commerce/server`:

```ts
import {
  createShopperService,
  createShopperTokenVerifier,
  readBearerToken,
} from '@sitecore-content-sdk/nextjs/commerce/server';

const token = readBearerToken(request);
const service = createShopperService({
  contextId: serverContextId,
  accessToken: token!,
});
```

The server shopper service never refreshes or replaces the supplied token. Use the token verifier
with keys from the configured commerce proxy and an allowlist of buyer client IDs before trusting
claims for business decisions.

## Storage patterns

| Pattern | Token client | Refresh token | Use when |
| --- | --- | --- | --- |
| Server-managed (recommended) | `RouteHandlerTokenClient` | httpOnly cookie set by a server endpoint | Next.js (`createCommerceTokenRouteHandler`) |
| Browser, memory | `EdgeTokenClient` + `createBrowserCookieTokenStore({ refreshTokenStorage: 'memory' })` | Memory only | SPA without a backend |
| Browser, cookie | `EdgeTokenClient` + `createBrowserCookieTokenStore({ refreshTokenStorage: 'cookie' })` | JS-readable cookie (exposed to XSS) | Explicit opt-in only |
| In-memory | `EdgeTokenClient` + `createMemoryTokenStore()` | Memory | Server code, editing/preview, tests |

Tokens are never stored in `localStorage` or `sessionStorage`. The access-token session cookie (`sc_oc_s`) is readable by the browser and expires with the token; the refresh token cookie (`sc_oc_rt`) is only written for registered sessions. A non-secret `sc_oc_seen` marker stores only the last shopper type so a later visit can distinguish an expired/lost cart from a first visit. Explicit token-store clears remove the marker.

## Buyer API client provisioning

OrderCloud token lifetimes are configured on the buyer API client, in minutes. Recommended values:

| Setting | Recommended |
| --- | --- |
| `AnonymousTokenDuration` | 86400 (60 days) |
| `AccessTokenDuration` | 600 (10 hours) |
| `RefreshTokenDuration` | 43200 (30 days), matching the default `refreshTokenMaxAge` cookie option |
