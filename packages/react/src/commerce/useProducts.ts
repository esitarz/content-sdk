import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BuyerProduct,
  CommerceError,
  ListMeta,
  ListPage,
  ListProductsOptions,
} from '@sitecore-content-sdk/commerce';
import { useCommerce, useCommerceInternal } from './CommerceProvider';
import {
  productListKey,
  serviceUnavailableError,
  toCommerceError,
  withProductIds,
} from './product-list-utils';

/**
 * Product list load status.
 * @public
 */
export type ProductListStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * Options for {@link useProducts}.
 * @public
 */
export interface UseProductsOptions<TProduct = BuyerProduct, TXp = Record<string, unknown>> {
  /**
   * Whether to load the list.
   * @default true
   */
  enabled?: boolean;
  /**
   * Maps each raw product to the shape returned in `items`. Products without an `ID` are dropped
   * before mapping. Must be referentially stable (module scope or `useCallback`).
   */
  select?: (product: BuyerProduct<TXp>) => TProduct;
  /**
   * List rendered on the server for the params present on first render. Shown immediately
   * (status `success`).
   */
  initialData?: ListPage<BuyerProduct<TXp>>;
  /**
   * Refetch on the client once the shopper session is known. Initial data may have been fetched as a
   * different (anonymous) shopper, and prices and visibility are buyer-specific. When false, initial
   * data is kept until the shopper identity changes (login, logout, session replaced).
   * @default true
   */
  revalidate?: boolean;
  /**
   * Keep the previous items visible while the list for new params loads. When false, a params
   * change clears `items` and sets `status` to `loading`. Identity reloads and `refetch()` always
   * keep the current items visible.
   * @default true
   */
  keepPreviousData?: boolean;
}

/**
 * State returned by {@link useProducts}.
 * @public
 */
export interface UseProductsState<TProduct = BuyerProduct, TXp = Record<string, unknown>> {
  /**
   * Products after `select`. Products without an `ID` are dropped.
   */
  items: TProduct[];
  /**
   * List metadata (paging, facets) for `items`.
   */
  meta: ListMeta | null;
  /**
   * Raw products, index-aligned with `items`.
   */
  rawItems: BuyerProduct<TXp>[];
  status: ProductListStatus;
  /**
   * True while loading with no data to show.
   */
  isLoading: boolean;
  /**
   * True while loading with data still shown (params change, identity change, revalidation, refetch).
   */
  isRefetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: CommerceError | null;
  /**
   * Reloads the list.
   */
  refetch(): Promise<void>;
}

interface ListState {
  /**
   * Params key of the data in `page`.
   */
  key: string | null;
  page: ListPage<BuyerProduct> | null;
  status: ProductListStatus;
  isRefetching: boolean;
  error: CommerceError | null;
}

type LoadedVersion = number | 'initial';

const IDLE: ListState = { key: null, page: null, status: 'idle', isRefetching: false, error: null };

/**
 * Lists products visible to the current shopper (`GET /v1/me/products`). Requires a `CommerceProvider`.
 * Keyed on the content of `params` (inline objects are fine) and on the shopper identity: changing
 * either reloads. Identical lists requested at the same time by several components share one request.
 * Returns one page; use `useInfiniteProducts` to accumulate pages.
 * @param {ListProductsOptions} [params] list params (search, filters, sort, paging)
 * @param {UseProductsOptions} [options] hook options
 * @returns {UseProductsState} list state
 * @public
 */
export function useProducts<TProduct = BuyerProduct, TXp = Record<string, unknown>>(
  params?: ListProductsOptions,
  options: UseProductsOptions<TProduct, TXp> = {}
): UseProductsState<TProduct, TXp> {
  const {
    enabled = true,
    select,
    initialData,
    revalidate = true,
    keepPreviousData = true,
  } = options;
  const { service, ensureSession, lastSessionChange } = useCommerce();
  const { sessionVersion, getSessionVersion, dedupe } = useCommerceInternal();

  const key = productListKey(params);
  const latest = useRef({ params, revalidate, keepPreviousData, lastSessionChange, service });
  latest.current = { params, revalidate, keepPreviousData, lastSessionChange, service };

  // initial data applies only to the params present on first render
  const [initial] = useState(() =>
    enabled && initialData ? { key, version: getSessionVersion() } : null
  );

  const [state, setState] = useState<ListState>(() =>
    initial
      ? {
          key,
          page: (initialData as unknown) as ListPage<BuyerProduct>,
          status: 'success',
          isRefetching: false,
          error: null,
        }
      : enabled
      ? { ...IDLE, status: 'loading' }
      : IDLE
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const runRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<{ key: string; version: number | null; run: number } | null>(null);
  const loadedRef = useRef<{ key: string; version: LoadedVersion } | null>(
    initial ? { key: initial.key, version: 'initial' } : null
  );

  const update = useCallback((next: ListState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const load = useCallback(
    async (loadKey: string, force = false): Promise<void> => {
      const run = ++runRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const { signal } = controller;
      const isStale = () => run !== runRef.current || signal.aborted;
      const listParams = latest.current.params;
      inFlightRef.current = { key: loadKey, version: null, run };
      // release the marker only if this load still owns it (a newer load may have replaced it)
      const release = () => {
        if (inFlightRef.current?.run === run) inFlightRef.current = null;
      };

      const current = stateRef.current;
      const keep =
        !!current.page && (current.key === loadKey || latest.current.keepPreviousData);
      update(
        keep
          ? { ...current, isRefetching: true, error: null }
          : { ...IDLE, status: 'loading' }
      );

      const fail = (error: CommerceError) => {
        inFlightRef.current = null;
        update({ ...IDLE, key: loadKey, status: 'error', error });
      };

      try {
        await ensureSession();
      } catch (err) {
        if (isStale()) return release();
        loadedRef.current = null;
        fail(toCommerceError(err));
        return;
      }
      if (isStale()) return release();

      const version = getSessionVersion();
      inFlightRef.current = { key: loadKey, version, run };
      const svc = latest.current.service;
      if (!svc) {
        loadedRef.current = null;
        fail(serviceUnavailableError());
        return;
      }

      try {
        const page = await dedupe(
          `products:${loadKey}`,
          (s) => svc.products.list(listParams, { signal: s }),
          { signal, force }
        );
        if (isStale()) return release();
        update({ key: loadKey, page, status: 'success', isRefetching: false, error: null });
      } catch (err) {
        if (isStale()) return release();
        // an abort this hook did not cause (e.g. a timeout) is an error, not a cancellation;
        // keep the error until refetch(), a params change or an identity change
        fail(toCommerceError(err));
      }
      inFlightRef.current = null;
      loadedRef.current = { key: loadKey, version };
    },
    [ensureSession, getSessionVersion, dedupe, update]
  );

  const serviceRef = useRef(service);

  useEffect(() => {
    if (serviceRef.current !== service) {
      serviceRef.current = service;
      loadedRef.current = null;
      inFlightRef.current = null;
    }

    if (!enabled) {
      runRef.current += 1;
      controllerRef.current?.abort();
      inFlightRef.current = null;
      loadedRef.current = null;
      if (stateRef.current.status !== 'idle') update(IDLE);
      return;
    }

    const version = getSessionVersion();
    const inFlight = inFlightRef.current;
    if (
      inFlight &&
      inFlight.key === key &&
      (inFlight.version === null || inFlight.version === version)
    ) {
      return;
    }

    const loaded = loadedRef.current;
    if (loaded && loaded.key === key) {
      if (loaded.version === version) return;
      if (loaded.version === 'initial') {
        const { revalidate: shouldRevalidate, lastSessionChange: change } = latest.current;
        const sameIdentity =
          initial?.version === version || !change || change.reason === 'acquired';
        if (!shouldRevalidate && sameIdentity) return;
      }
    }

    load(key);
  }, [enabled, key, sessionVersion, service, load, getSessionVersion, update, initial]);

  useEffect(
    () => () => {
      runRef.current += 1;
      controllerRef.current?.abort();
      // a remount (e.g. React Strict Mode) must start a fresh load, not wait for the cancelled one
      inFlightRef.current = null;
    },
    []
  );

  const refetch = useCallback(() => (enabled ? load(key, true) : Promise.resolve()), [
    enabled,
    key,
    load,
  ]);

  // derive the view at render time: the effect that starts the new load runs after this render
  const view = useMemo((): ListState => {
    if (!enabled) return IDLE;
    if (!keepPreviousData && state.key !== null && state.key !== key) {
      return { ...IDLE, status: 'loading' };
    }
    return state;
  }, [enabled, keepPreviousData, state, key]);

  const { page, status, isRefetching, error } = view;
  const rawItems = useMemo(
    () => withProductIds((page?.Items ?? []) as BuyerProduct<TXp>[]),
    [page]
  );
  const items = useMemo(
    () => (select ? rawItems.map((item) => select(item)) : ((rawItems as unknown) as TProduct[])),
    [rawItems, select]
  );

  return useMemo(
    (): UseProductsState<TProduct, TXp> => ({
      items,
      meta: page?.Meta ?? null,
      rawItems,
      status,
      isLoading: status === 'loading',
      isRefetching,
      isSuccess: status === 'success',
      isError: status === 'error',
      error,
      refetch,
    }),
    [items, page, rawItems, status, isRefetching, error, refetch]
  );
}
