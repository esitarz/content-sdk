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
import { ProductListStatus, UseProductsOptions } from './useProducts';

/**
 * List params for {@link useInfiniteProducts}. `page` is managed by the hook.
 * @public
 */
export type InfiniteProductsParams = Omit<ListProductsOptions, 'page'>;

/**
 * Options for {@link useInfiniteProducts}.
 * @public
 */
export interface UseInfiniteProductsOptions<
  TProduct = BuyerProduct,
  TXp = Record<string, unknown>
> extends UseProductsOptions<TProduct, TXp> {
  /**
   * First page rendered on the server for the params present on first render.
   */
  initialData?: ListPage<BuyerProduct<TXp>>;
}

/**
 * State returned by {@link useInfiniteProducts}.
 * @public
 */
export interface UseInfiniteProductsState<TProduct = BuyerProduct, TXp = Record<string, unknown>> {
  /**
   * Products of every loaded page, in order, after `select`. Products without an `ID` are dropped.
   */
  items: TProduct[];
  /**
   * Raw products, index-aligned with `items`.
   */
  rawItems: BuyerProduct<TXp>[];
  /**
   * Loaded pages, in order.
   */
  pages: ListPage<BuyerProduct<TXp>>[];
  /**
   * Metadata of the last loaded page (total count, total pages, facets).
   */
  meta: ListMeta | null;
  /**
   * True when the last loaded page is not the last page.
   */
  hasNextPage: boolean;
  /**
   * Status of the first page. Next-page failures do not change it; see `isFetchNextPageError`.
   */
  status: ProductListStatus;
  /**
   * True while loading the first page with no data to show.
   */
  isLoading: boolean;
  /**
   * True while reloading the first page with data still shown (params change, identity change,
   * revalidation, refetch).
   */
  isRefetching: boolean;
  isFetchingNextPage: boolean;
  isSuccess: boolean;
  isError: boolean;
  /**
   * True when the last `fetchNextPage()` failed. Call `fetchNextPage()` again to retry.
   */
  isFetchNextPageError: boolean;
  /**
   * Error of the first page, or of the last `fetchNextPage()`.
   */
  error: CommerceError | null;
  /**
   * Loads the next page and appends it. Does nothing when there is no next page or a load is
   * in progress.
   */
  fetchNextPage(): Promise<void>;
  /**
   * Reloads from the first page, dropping later pages.
   */
  refetch(): Promise<void>;
}

interface InfiniteState {
  /**
   * Params key of the data in `pages`.
   */
  key: string | null;
  pages: ListPage<BuyerProduct>[];
  status: ProductListStatus;
  isRefetching: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  error: CommerceError | null;
}

type LoadedVersion = number | 'initial';

const IDLE: InfiniteState = {
  key: null,
  pages: [],
  status: 'idle',
  isRefetching: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  error: null,
};

const withoutPage = (params: InfiniteProductsParams | undefined): InfiniteProductsParams => {
  const rest = { ...(params ?? {}) } as ListProductsOptions;
  delete rest.page;
  return rest;
};

const hasMore = (pages: ListPage<BuyerProduct>[]) => {
  const last = pages[pages.length - 1];
  const totalPages = last?.Meta?.TotalPages;
  if (!last || typeof totalPages !== 'number') return false;
  return (last.Meta.Page ?? pages.length) < totalPages;
};

/**
 * Lists products visible to the current shopper page by page, appending each page (infinite scroll,
 * "load more"). Requires a `CommerceProvider`. Changing `params` or the shopper identity reloads from
 * the first page; an identity change drops later pages because prices and visibility may change.
 * Each page request is shared with other components requesting the same page at the same time.
 * @param {InfiniteProductsParams} [params] list params (search, filters, sort, page size); `page` is managed by the hook
 * @param {UseInfiniteProductsOptions} [options] hook options
 * @returns {UseInfiniteProductsState} list state
 * @public
 */
export function useInfiniteProducts<TProduct = BuyerProduct, TXp = Record<string, unknown>>(
  params?: InfiniteProductsParams,
  options: UseInfiniteProductsOptions<TProduct, TXp> = {}
): UseInfiniteProductsState<TProduct, TXp> {
  const {
    enabled = true,
    select,
    initialData,
    revalidate = true,
    keepPreviousData = true,
  } = options;
  const { service, ensureSession, lastSessionChange } = useCommerce();
  const { sessionVersion, getSessionVersion, dedupe } = useCommerceInternal();

  const baseParams = withoutPage(params);
  const key = productListKey(baseParams);
  const latest = useRef({ baseParams, revalidate, keepPreviousData, lastSessionChange, service });
  latest.current = { baseParams, revalidate, keepPreviousData, lastSessionChange, service };

  // initial data applies only to the params present on first render
  const [initial] = useState(() =>
    enabled && initialData ? { key, version: getSessionVersion() } : null
  );

  const [state, setState] = useState<InfiniteState>(() =>
    initial
      ? {
          ...IDLE,
          key,
          pages: [(initialData as unknown) as ListPage<BuyerProduct>],
          status: 'success',
        }
      : enabled
      ? { ...IDLE, status: 'loading' }
      : IDLE
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const runRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const nextControllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<{ key: string; version: number | null; run: number } | null>(null);
  const loadedRef = useRef<{ key: string; version: LoadedVersion } | null>(
    initial ? { key: initial.key, version: 'initial' } : null
  );
  // params used for the pages currently shown; next pages must use the same params
  const pagesParamsRef = useRef<InfiniteProductsParams>(initial ? baseParams : {});

  const update = useCallback((next: InfiniteState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const cancel = useCallback(() => {
    runRef.current += 1;
    controllerRef.current?.abort();
    nextControllerRef.current?.abort();
  }, []);

  const load = useCallback(
    async (loadKey: string, force = false): Promise<void> => {
      cancel();
      const run = runRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      const { signal } = controller;
      const isStale = () => run !== runRef.current || signal.aborted;
      const listParams = latest.current.baseParams;
      inFlightRef.current = { key: loadKey, version: null, run };
      // release the marker only if this load still owns it (a newer load may have replaced it)
      const release = () => {
        if (inFlightRef.current?.run === run) inFlightRef.current = null;
      };

      const current = stateRef.current;
      const keep =
        current.pages.length > 0 &&
        (current.key === loadKey || latest.current.keepPreviousData);
      update(
        keep
          ? {
              ...current,
              isRefetching: true,
              isFetchingNextPage: false,
              isFetchNextPageError: false,
              error: null,
            }
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
          `products-infinite:${loadKey}:page:1`,
          (s) => svc.products.list({ ...listParams, page: 1 }, { signal: s }),
          { signal, force }
        );
        if (isStale()) return release();
        pagesParamsRef.current = listParams;
        update({ ...IDLE, key: loadKey, pages: [page], status: 'success' });
      } catch (err) {
        if (isStale()) return release();
        fail(toCommerceError(err));
      }
      inFlightRef.current = null;
      loadedRef.current = { key: loadKey, version };
    },
    [cancel, ensureSession, getSessionVersion, dedupe, update]
  );

  const fetchNextPage = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    if (
      !enabled ||
      inFlightRef.current ||
      current.status !== 'success' ||
      current.isRefetching ||
      current.isFetchingNextPage ||
      !hasMore(current.pages)
    ) {
      return;
    }

    const run = runRef.current;
    const controller = new AbortController();
    nextControllerRef.current = controller;
    const { signal } = controller;
    const isStale = () => run !== runRef.current || signal.aborted;
    const pageKey = current.key as string;
    const pageNumber = current.pages.length + 1;
    const listParams = pagesParamsRef.current;

    update({ ...current, isFetchingNextPage: true, isFetchNextPageError: false, error: null });

    const svc = latest.current.service;
    if (!svc) {
      update({
        ...stateRef.current,
        isFetchingNextPage: false,
        isFetchNextPageError: true,
        error: serviceUnavailableError(),
      });
      return;
    }

    try {
      const page = await dedupe(
        `products-infinite:${pageKey}:page:${pageNumber}`,
        (s) => svc.products.list({ ...listParams, page: pageNumber }, { signal: s }),
        { signal }
      );
      if (isStale()) return;
      const latestState = stateRef.current;
      update({
        ...latestState,
        pages: [...latestState.pages, page],
        isFetchingNextPage: false,
      });
    } catch (err) {
      if (isStale()) return;
      update({
        ...stateRef.current,
        isFetchingNextPage: false,
        isFetchNextPageError: true,
        error: toCommerceError(err),
      });
    }
  }, [enabled, dedupe, update]);

  const serviceRef = useRef(service);

  useEffect(() => {
    if (serviceRef.current !== service) {
      serviceRef.current = service;
      loadedRef.current = null;
      inFlightRef.current = null;
    }

    if (!enabled) {
      cancel();
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
  }, [enabled, key, sessionVersion, service, load, cancel, getSessionVersion, update, initial]);

  useEffect(
    () => () => {
      cancel();
      // a remount (e.g. React Strict Mode) must start a fresh load, not wait for the cancelled one
      inFlightRef.current = null;
    },
    [cancel]
  );

  const refetch = useCallback(() => (enabled ? load(key, true) : Promise.resolve()), [
    enabled,
    key,
    load,
  ]);

  // derive the view at render time: the effect that starts the new load runs after this render
  const view = useMemo((): InfiniteState => {
    if (!enabled) return IDLE;
    if (!keepPreviousData && state.key !== null && state.key !== key) {
      return { ...IDLE, status: 'loading' };
    }
    return state;
  }, [enabled, keepPreviousData, state, key]);

  const { pages, status, isRefetching, isFetchingNextPage, isFetchNextPageError, error } = view;
  const typedPages = (pages as unknown) as ListPage<BuyerProduct<TXp>>[];
  const rawItems = useMemo(
    () => typedPages.flatMap((page) => withProductIds(page?.Items as BuyerProduct<TXp>[])),
    [typedPages]
  );
  const items = useMemo(
    () => (select ? rawItems.map((item) => select(item)) : ((rawItems as unknown) as TProduct[])),
    [rawItems, select]
  );
  const hasNextPage = useMemo(() => hasMore(pages), [pages]);

  return useMemo(
    (): UseInfiniteProductsState<TProduct, TXp> => ({
      items,
      rawItems,
      pages: typedPages,
      meta: typedPages[typedPages.length - 1]?.Meta ?? null,
      hasNextPage,
      status,
      isLoading: status === 'loading',
      isRefetching,
      isFetchingNextPage,
      isSuccess: status === 'success',
      isError: status === 'error',
      isFetchNextPageError,
      error,
      fetchNextPage,
      refetch,
    }),
    [
      items,
      rawItems,
      typedPages,
      hasNextPage,
      status,
      isRefetching,
      isFetchingNextPage,
      isFetchNextPageError,
      error,
      fetchNextPage,
      refetch,
    ]
  );
}
