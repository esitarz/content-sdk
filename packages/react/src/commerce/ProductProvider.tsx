'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BuyerProduct,
  CommerceError,
  ProductLineItemDraft,
  Spec,
  SpecSelection,
  SpecSelectionIssue,
  SpecSelections,
  Variant,
  getInitialSelections,
  getOptionAvailability,
  hasVariantSpecs,
  isProductNotFoundError,
  resolveVariant,
  toLineItemSpecs,
  validateSelections,
} from '@sitecore-content-sdk/commerce';
import { useCommerce, useCommerceInternal } from './CommerceProvider';
import { serviceUnavailableError, toCommerceError } from './product-list-utils';
// type-only imports: the hook modules import the contexts below at runtime
import type { ProductStatus, UseProductState } from './useProduct';
import type { ProductOptionsStatus, UseProductOptionsState } from './useProductOptions';
import type { UseProductSelectionState } from './useProductSelection';

/**
 * Product data rendered on the server and passed to {@link ProductProvider}.
 * @public
 */
export interface ProductInitialData<TXp = Record<string, unknown>> {
  product: BuyerProduct<TXp>;
  /**
   * Product specs. When omitted, specs are loaded on the client if the product has any.
   */
  specs?: Spec[];
  /**
   * Active product variants. When omitted, variants are loaded on the client if needed.
   */
  variants?: Variant[];
}

/**
 * Props for {@link ProductProvider}.
 * @public
 */
export interface ProductProviderProps<TProduct = BuyerProduct, TXp = Record<string, unknown>> {
  children?: React.ReactNode;
  /**
   * Resolved OrderCloud product ID. `undefined` or empty puts the provider in `idle` (nothing to load).
   */
  productId: string | undefined;
  /**
   * Maps the raw product to the shape returned by `useProduct().product`.
   * Must be referentially stable (module scope or `useCallback`). Re-runs only when the raw product
   * or `select` changes.
   */
  select?: (product: BuyerProduct<TXp>) => TProduct;
  /**
   * Data rendered on the server for the initial `productId`. Shown immediately (status `success`).
   */
  initialData?: ProductInitialData<TXp>;
  /**
   * Refetch on the client once the shopper session is known. Initial data may have been fetched as a
   * different (anonymous) shopper, and prices and visibility are buyer-specific. When false, initial
   * data is kept until the shopper identity changes (login, logout, session replaced).
   * @default true
   */
  revalidate?: boolean;
  /**
   * When to load specs and variants. `auto` uses `SpecCount` / `VariantCount`; `none` never loads them.
   * @default 'auto'
   */
  options?: 'auto' | 'none';
  /**
   * Initial selections (e.g. from a `?variant=` query), merged over OrderCloud defaults. Read when
   * options load.
   */
  initialSelections?: SpecSelections;
  /**
   * Extra per-spec validation (e.g. xp min/max). Runs only for specs without an OrderCloud rule issue.
   */
  validateSpec?: (spec: Spec, selection: SpecSelection) => SpecSelectionIssue<string> | undefined;
  /**
   * Whether to load the product.
   * @default true
   */
  enabled?: boolean;
}

interface ProductDataState {
  productId: string | undefined;
  raw: BuyerProduct | null;
  status: ProductStatus;
  isRefetching: boolean;
  error: CommerceError | null;
}

interface OptionsState {
  productId: string | undefined;
  specs: Spec[];
  variants: Variant[];
  status: ProductOptionsStatus;
  error: CommerceError | null;
}

interface SelectionState {
  productId: string | undefined;
  selections: SpecSelections;
  touched: string[];
  validated: boolean;
}

type LoadedVersion = number | 'initial';

/** @internal */
export const ProductContext = React.createContext<UseProductState<unknown> | null>(null);
/** @internal */
export const ProductOptionsContext = React.createContext<UseProductOptionsState | null>(null);
/** @internal */
export const ProductSelectionContext = React.createContext<UseProductSelectionState | null>(null);

const EMPTY: never[] = [];

const idleProduct = (): ProductDataState => ({
  productId: undefined,
  raw: null,
  status: 'idle',
  isRefetching: false,
  error: null,
});

const idleOptions = (productId?: string, status: ProductOptionsStatus = 'idle'): OptionsState => ({
  productId,
  specs: EMPTY,
  variants: EMPTY,
  status,
  error: null,
});

const emptySelection = (productId?: string, selections: SpecSelections = {}): SelectionState => ({
  productId,
  selections,
  touched: EMPTY,
  validated: false,
});

const toError = toCommerceError;

const needsVariants = (product: BuyerProduct, specs: Spec[]) =>
  hasVariantSpecs(specs) && product.VariantCount !== 0;

const selectionsStillValid = (selections: SpecSelections, specs: Spec[]) =>
  Object.entries(selections).every(([specId, selection]) => {
    const spec = specs.find((s) => s.ID === specId);
    if (!spec) return false;
    return !selection?.optionId || !!spec.Options?.some((o) => o.ID === selection.optionId);
  });

/**
 * Loads an OrderCloud product with its specs and variants for the current shopper, and shares the
 * product, option and selection state with `useProduct`, `useProductOptions` and
 * `useProductSelection`. Headless: renders only its children. Requires a `CommerceProvider`.
 * Reloads when the shopper identity changes (login, logout, session replaced), keeping current data
 * visible while reloading.
 * @param {ProductProviderProps} props provider props
 * @returns {React.ReactElement} provider element
 * @public
 */
export function ProductProvider<TProduct = BuyerProduct, TXp = Record<string, unknown>>(
  props: ProductProviderProps<TProduct, TXp>
): React.ReactElement {
  const {
    children,
    select,
    initialData,
    revalidate = true,
    options: optionsMode = 'auto',
    initialSelections,
    validateSpec,
    enabled = true,
  } = props;
  const { service, ensureSession, lastSessionChange } = useCommerce();
  const { sessionVersion, getSessionVersion, dedupe } = useCommerceInternal();

  const productId = (typeof props.productId === 'string' && props.productId.trim()) || undefined;
  const active = !!productId && enabled;

  // initial data applies only to the product ID present on first render
  const [initial] = useState(() => {
    if (!active || !initialData?.product) return null;
    const raw = (initialData.product as unknown) as BuyerProduct;
    let options: { specs: Spec[]; variants: Variant[] } | null = null;
    if (optionsMode === 'none' || raw.SpecCount === 0) {
      options = { specs: EMPTY, variants: EMPTY };
    } else if (initialData.specs) {
      if (initialData.variants || !needsVariants(raw, initialData.specs)) {
        options = { specs: initialData.specs, variants: initialData.variants ?? EMPTY };
      }
    }
    return { productId: productId as string, raw, options, version: getSessionVersion() };
  });

  const [productState, setProductState] = useState<ProductDataState>(() =>
    initial
      ? {
          productId: initial.productId,
          raw: initial.raw,
          status: 'success',
          isRefetching: false,
          error: null,
        }
      : active
      ? { ...idleProduct(), productId, status: 'loading' }
      : idleProduct()
  );
  const [optionsState, setOptionsState] = useState<OptionsState>(() =>
    initial?.options
      ? { productId, ...initial.options, status: 'success', error: null }
      : active
      ? idleOptions(productId, 'loading')
      : idleOptions()
  );
  const [selectionState, setSelectionState] = useState<SelectionState>(() =>
    initial?.options
      ? emptySelection(
          productId,
          getInitialSelections(initial.options.specs, initial.options.variants, initialSelections)
        )
      : emptySelection(productId)
  );

  const productRef = useRef(productState);
  productRef.current = productState;
  const optionsRef = useRef(optionsState);
  optionsRef.current = optionsState;
  const latest = useRef({ initialSelections, revalidate, optionsMode, lastSessionChange, service });
  latest.current = { initialSelections, revalidate, optionsMode, lastSessionChange, service };

  const runRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<{ productId: string; version: number | null; run: number } | null>(null);
  const loadedRef = useRef<{ productId: string; version: LoadedVersion } | null>(
    initial ? { productId: initial.productId, version: 'initial' } : null
  );

  const setProduct = useCallback((next: ProductDataState) => {
    productRef.current = next;
    setProductState(next);
  }, []);

  const setOptions = useCallback((next: OptionsState) => {
    optionsRef.current = next;
    setOptionsState(next);
  }, []);

  const load = useCallback(
    async (id: string, mode: 'all' | 'options', force = false): Promise<void> => {
      const run = ++runRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const { signal } = controller;
      const isStale = () => run !== runRef.current || signal.aborted;
      const keepInitialMarker = mode === 'options' && loadedRef.current?.version === 'initial';
      inFlightRef.current = { productId: id, version: null, run };
      // release the marker only if this load still owns it (a newer load may have replaced it)
      const release = () => {
        if (inFlightRef.current?.run === run) inFlightRef.current = null;
      };

      const finish = (version: number) => {
        inFlightRef.current = null;
        loadedRef.current = { productId: id, version: keepInitialMarker ? 'initial' : version };
      };

      const current = productRef.current;
      const sameProduct = current.productId === id;
      if (mode === 'all') {
        setProduct(
          sameProduct && current.raw
            ? { ...current, isRefetching: true, error: null }
            : { productId: id, raw: null, status: 'loading', isRefetching: false, error: null }
        );
      }
      if (!sameProduct) {
        setOptions(idleOptions(id, 'loading'));
        setSelectionState(emptySelection(id));
      }

      try {
        await ensureSession();
      } catch (err) {
        if (isStale()) return release();
        inFlightRef.current = null;
        loadedRef.current = null;
        setProduct({ productId: id, raw: null, status: 'error', isRefetching: false, error: toError(err) });
        setOptions(idleOptions(id));
        return;
      }
      if (isStale()) return release();

      const version = getSessionVersion();
      inFlightRef.current = { productId: id, version, run };
      const svc = latest.current.service;
      if (!svc) {
        inFlightRef.current = null;
        loadedRef.current = null;
        setProduct({
          productId: id,
          raw: null,
          status: 'error',
          isRefetching: false,
          error: serviceUnavailableError(),
        });
        setOptions(idleOptions(id));
        return;
      }

      let raw = productRef.current.raw;
      if (mode === 'all' || !raw) {
        try {
          raw = await dedupe(`product:${id}`, (s) => svc.products.get(id, { signal: s }), {
            signal,
            force,
          });
        } catch (err) {
          if (isStale()) return release();
          finish(version);
          setProduct({
            productId: id,
            raw: null,
            status: isProductNotFoundError(err) ? 'not-found' : 'error',
            isRefetching: false,
            error: isProductNotFoundError(err) ? null : toError(err),
          });
          setOptions(idleOptions(id));
          setSelectionState(emptySelection(id));
          return;
        }
        if (isStale()) return release();
        setProduct({ productId: id, raw, status: 'success', isRefetching: false, error: null });
      }

      const product = raw as BuyerProduct;
      let specs: Spec[] = EMPTY;
      let variants: Variant[] = EMPTY;

      if (latest.current.optionsMode !== 'none' && product.SpecCount !== 0) {
        const currentOptions = optionsRef.current;
        if (!(currentOptions.productId === id && currentOptions.status === 'success')) {
          setOptions(idleOptions(id, 'loading'));
        }
        try {
          specs = (
            await dedupe(`specs:${id}`, (s) => svc.products.listSpecs(id, undefined, { signal: s }), {
              signal,
              force,
            })
          ).Items;
          if (isStale()) return release();
          if (needsVariants(product, specs)) {
            variants = (
              await dedupe(
                `variants:${id}`,
                (s) => svc.products.listVariants(id, { filters: { Active: true } }, { signal: s }),
                { signal, force }
              )
            ).Items;
          }
        } catch (err) {
          if (isStale()) return release();
          finish(version);
          setOptions({ ...idleOptions(id, 'error'), error: toError(err) });
          return;
        }
        if (isStale()) return release();
      }

      finish(version);
      setOptions({ productId: id, specs, variants, status: 'success', error: null });
      setSelectionState((prev) =>
        prev.productId === id &&
        Object.keys(prev.selections).length > 0 &&
        selectionsStillValid(prev.selections, specs)
          ? prev
          : emptySelection(
              id,
              getInitialSelections(specs, variants, latest.current.initialSelections)
            )
      );
    },
    [ensureSession, getSessionVersion, dedupe, setProduct, setOptions]
  );

  const serviceRef = useRef(service);

  useEffect(() => {
    if (serviceRef.current !== service) {
      serviceRef.current = service;
      loadedRef.current = null;
      inFlightRef.current = null;
    }

    if (!active || !productId) {
      runRef.current += 1;
      controllerRef.current?.abort();
      inFlightRef.current = null;
      loadedRef.current = null;
      if (productRef.current.status !== 'idle') setProduct(idleProduct());
      if (optionsRef.current.status !== 'idle') setOptions(idleOptions());
      setSelectionState((prev) => (prev.productId === undefined ? prev : emptySelection()));
      return;
    }

    const version = getSessionVersion();
    const inFlight = inFlightRef.current;
    if (
      inFlight &&
      inFlight.productId === productId &&
      (inFlight.version === null || inFlight.version === version)
    ) {
      return;
    }

    const loaded = loadedRef.current;
    if (loaded && loaded.productId === productId) {
      if (loaded.version === version) return;
      if (loaded.version === 'initial') {
        const { revalidate: shouldRevalidate, lastSessionChange: change } = latest.current;
        const sameIdentity =
          initial?.version === version || !change || change.reason === 'acquired';
        if (!shouldRevalidate && sameIdentity) {
          if (optionsRef.current.status !== 'success') load(productId, 'options');
          return;
        }
      }
    }

    load(productId, 'all');
  }, [active, productId, sessionVersion, service, load, getSessionVersion, setProduct, setOptions, initial]);

  useEffect(
    () => () => {
      runRef.current += 1;
      controllerRef.current?.abort();
      // a remount (e.g. React Strict Mode) must start a fresh load, not wait for the cancelled one
      inFlightRef.current = null;
    },
    []
  );

  const refetch = useCallback(
    () => (active && productId ? load(productId, 'all', true) : Promise.resolve()),
    [active, productId, load]
  );

  const refetchOptions = useCallback(
    () =>
      active && productId && productRef.current.raw
        ? load(productId, 'options', true)
        : Promise.resolve(),
    [active, productId, load]
  );

  // product context
  const { raw, status, isRefetching, error } = productState;
  const product = useMemo(
    () =>
      raw
        ? select
          ? select((raw as unknown) as BuyerProduct<TXp>)
          : ((raw as unknown) as TProduct)
        : null,
    [raw, select]
  );

  const productValue = useMemo<UseProductState<unknown>>(
    () => ({
      productId,
      product,
      rawProduct: raw,
      status,
      isLoading: status === 'loading',
      isRefetching,
      isSuccess: status === 'success',
      isNotFound: status === 'not-found',
      isError: status === 'error',
      error,
      refetch,
    }),
    [productId, product, raw, status, isRefetching, error, refetch]
  );

  // options context
  const { specs, variants } = optionsState;
  const { selections, touched, validated } = selectionState;
  const variantSpecs = useMemo(() => hasVariantSpecs(specs), [specs]);
  const optionAvailability = useMemo(() => getOptionAvailability(specs, selections, variants), [
    specs,
    selections,
    variants,
  ]);

  const optionsValue = useMemo<UseProductOptionsState>(
    () => ({
      specs,
      variants,
      hasVariantSpecs: variantSpecs,
      status: optionsState.status,
      isLoading: optionsState.status === 'loading',
      isError: optionsState.status === 'error',
      error: optionsState.error,
      optionAvailability,
      refetch: refetchOptions,
    }),
    [specs, variants, variantSpecs, optionsState.status, optionsState.error, optionAvailability, refetchOptions]
  );

  // selection context
  const optionsReady = optionsState.status === 'success';
  const issues = useMemo<SpecSelectionIssue<string>[]>(() => {
    if (!optionsReady) return EMPTY;
    const result: SpecSelectionIssue<string>[] = validateSelections(specs, selections, variants);
    if (validateSpec) {
      const withIssue = new Set(result.map((issue) => issue.specId));
      for (const spec of specs) {
        if (!spec?.ID || withIssue.has(spec.ID)) continue;
        const extra = validateSpec(spec, selections[spec.ID] ?? {});
        if (extra) result.push(extra);
      }
    }
    return result;
  }, [optionsReady, specs, selections, variants, validateSpec]);

  const visibleIssues = useMemo(() => {
    if (validated) return issues;
    const touchedVariantSpec = specs.some((s) => s.DefinesVariant && touched.includes(s.ID));
    return issues.filter((issue) =>
      issue.specId === '' ? touchedVariantSpec : touched.includes(issue.specId)
    );
  }, [issues, validated, touched, specs]);

  const selectedVariant = useMemo(() => resolveVariant(specs, selections, variants), [
    specs,
    selections,
    variants,
  ]);

  const isComplete = status === 'success' && optionsReady && issues.length === 0;

  const setSelection = useCallback((specId: string, selection: SpecSelection) => {
    setSelectionState((prev) => ({
      ...prev,
      selections: { ...prev.selections, [specId]: selection },
      touched: prev.touched.includes(specId) ? prev.touched : [...prev.touched, specId],
    }));
  }, []);

  const resetSelections = useCallback(() => {
    const current = optionsRef.current;
    setSelectionState(
      emptySelection(
        current.productId,
        current.status === 'success'
          ? getInitialSelections(current.specs, current.variants, latest.current.initialSelections)
          : {}
      )
    );
  }, []);

  const validate = useCallback(() => {
    setSelectionState((prev) => (prev.validated ? prev : { ...prev, validated: true }));
    return isComplete;
  }, [isComplete]);

  const getLineItemDraft = useCallback((): ProductLineItemDraft | null => {
    if (!isComplete || !raw) return null;
    const draft: ProductLineItemDraft = {
      ProductID: raw.ID,
      Specs: toLineItemSpecs(specs, selections),
    };
    if (selectedVariant) draft.VariantID = selectedVariant.ID;
    return draft;
  }, [isComplete, raw, specs, selections, selectedVariant]);

  const selectionValue = useMemo<UseProductSelectionState>(
    () => ({
      selections,
      setSelection,
      resetSelections,
      selectedVariant,
      issues,
      visibleIssues,
      isComplete,
      validate,
      getLineItemDraft,
    }),
    [
      selections,
      setSelection,
      resetSelections,
      selectedVariant,
      issues,
      visibleIssues,
      isComplete,
      validate,
      getLineItemDraft,
    ]
  );

  return (
    <ProductContext.Provider value={productValue}>
      <ProductOptionsContext.Provider value={optionsValue}>
        <ProductSelectionContext.Provider value={selectionValue}>
          {children}
        </ProductSelectionContext.Provider>
      </ProductOptionsContext.Provider>
    </ProductContext.Provider>
  );
}
