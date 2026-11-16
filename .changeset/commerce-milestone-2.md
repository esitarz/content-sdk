---
'@sitecore-content-sdk/commerce': minor
'@sitecore-content-sdk/react': minor
'@sitecore-content-sdk/nextjs': minor
---

Add commerce (OrderCloud) product APIs, product option helpers and a headless product provider.

- `@sitecore-content-sdk/commerce`: `service.products.get()`, `list()`, `listSpecs()` and `listVariants()` (specs and variants follow pages, up to `maxPages`), local OrderCloud types (`BuyerProduct`, `Spec`, `Variant`, `ListPage`…), `isProductNotFoundError()`, and pure spec/variant helpers: `getDefaultSelections`, `getInitialSelections`, `resolveVariant`, `getOptionAvailability`, `validateSelections` (returns issue codes, never display text), `toLineItemSpecs`, plus `estimateUnitPrice()` for display price estimates.
- `@sitecore-content-sdk/react/commerce` (re-exported from `@sitecore-content-sdk/nextjs/commerce`): `ProductProvider` with `useProduct()`, `useProductOptions()` and `useProductSelection()`. Products reload when the shopper identity changes, keep data visible while reloading, accept server-rendered `initialData`, and share in-flight requests across providers under one `CommerceProvider`.
- `useProducts(params, options)` for product lists: keyed on the params content and the shopper identity, keeps the previous page visible while the next one loads (`keepPreviousData`, default true), accepts server-rendered `initialData`, drops items without an `ID`, and shares identical in-flight requests.
- `useInfiniteProducts(params, options)` for infinite scroll / "load more": `fetchNextPage()`, `hasNextPage`, `isFetchingNextPage`; restarts from page 1 when params change and reloads only page 1 when the shopper identity changes.
- `CommerceProvider` accepts a `timeout` (ms) applied to every commerce request it makes; `RouteHandlerTokenClient` gains a matching `timeout` option.
