---
'@sitecore-content-sdk/commerce': minor
'@sitecore-content-sdk/react': minor
'@sitecore-content-sdk/nextjs': minor
---

Add typed shopper cart, server-side shopper and order primitives for OrderCloud commerce.

- Cart APIs provide safe add retries, conflict recovery, line-item mutations, quantity validation and shopper-owned order reads.
- React commerce shares cart state through `CommerceProvider` and exposes `useCart` and `useAddToCart`, including editing-mode mutation guards.
- Next.js provides a server-only shopper service, bearer extraction and proxy-bound shopper token verification.
- A non-secret cookie marker preserves shopper-type history so expired carts are reported as replaced on later visits.
