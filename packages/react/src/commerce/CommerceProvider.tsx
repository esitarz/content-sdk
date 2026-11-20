'use client';
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AddLineItemResult,
  CommerceCookieOptions,
  CommerceError,
  CommerceTokenClient,
  CommerceTokenStore,
  EdgeTokenClient,
  MeUser,
  OrderCloudService,
  ProductLineItemDraft,
  RouteHandlerTokenClient,
  SessionChangeEvent,
  ShopperSession,
  ShopperSessionManager,
  ShopperUserType,
  createBrowserCookieTokenStore,
  createMemoryTokenStore,
  isSessionUsable,
  DEFAULT_TOKEN_KEY,
} from '@sitecore-content-sdk/commerce';
import { useSitecore } from '../components/SitecoreProvider';
import type { CartData, CartReset } from './useCart';

/**
 * How the provider obtains and stores shopper tokens.
 * - `route-handler`: a same-origin endpoint keeps the refresh token in an httpOnly cookie (recommended)
 * - `browser`: tokens are obtained directly from Edge; the refresh token is kept in memory or, if
 *   explicitly opted in, in a JS-readable cookie
 * @public
 */
export type CommerceTokenOptions =
  | {
      mode: 'route-handler';
      /**
       * Token endpoint.
       * @default '/api/commerce/token'
       */
      endpoint?: string;
      cookies?: CommerceCookieOptions;
    }
  | {
      mode: 'browser';
      refreshTokenStorage: 'memory' | 'cookie';
      cookies?: CommerceCookieOptions;
    };

/**
 * Props for {@link CommerceProvider}.
 * @public
 */
export interface CommerceProviderProps {
  children?: React.ReactNode;
  /**
   * How tokens are obtained and stored. Ignored in editing, preview and Design Library modes,
   * where tokens are kept in memory only.
   */
  tokens: CommerceTokenOptions;
  /**
   * Acquire a session on mount instead of on first use.
   * @default false
   */
  eager?: boolean;
  /**
   * Timeout in milliseconds for every commerce request made by the provider and its hooks
   * (OrderCloud and token requests). A timed-out request fails with a `CommerceError` whose
   * `source` is `network`. No timeout when omitted.
   */
  timeout?: number;
}

/**
 * Status of the commerce provider session.
 * @public
 */
export type CommerceStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Value returned by {@link useCommerce}.
 * @public
 */
export interface CommerceContextValue {
  /**
   * OrderCloud service bound to the provider's session. Null when the provider is misconfigured.
   */
  service: OrderCloudService | null;
  /**
   * Last known session. Null before a session has been obtained. May be stale.
   */
  session: ShopperSession | null;
  /**
   * Type of the current shopper, available as soon as a session exists.
   */
  userType: ShopperUserType | null;
  /**
   * Whether the current shopper is anonymous.
   */
  isAnonymous: boolean;
  /**
   * Status of the provider session.
   */
  status: CommerceStatus;
  /**
   * Last session error, or configuration error.
   */
  error: CommerceError | null;
  /**
   * True in editing, preview and Design Library modes.
   */
  isEditing: boolean;
  /**
   * Most recent identity change (`acquired`, `replaced` or `cleared`) observed by this provider, or
   * null. Not updated on `refreshed`. Use `reason === 'replaced'` and `previousUserType` to tell the
   * shopper that their session or cart expired.
   */
  lastSessionChange: SessionChangeEvent | null;
  /**
   * Returns a usable session, acquiring one if needed.
   */
  ensureSession(): Promise<ShopperSession>;
  /**
   * Drops the current session and starts a new anonymous one.
   */
  resetSession(): Promise<ShopperSession>;
}

/**
 * State of the shared current-shopper request.
 * @internal
 */
export interface ShopperState {
  user: MeUser | null;
  status: 'idle' | 'loading' | 'success' | 'error';
  error: CommerceError | null;
}

/**
 * Internal provider context shared by commerce hooks.
 * @internal
 */
export interface CommerceInternalContextValue {
  sessionVersion: number;
  shopper: ShopperState;
  cart: CartInternalState;
  loadShopper(force?: boolean): Promise<void>;
  /**
   * Current identity version, read synchronously (updated before `sessionVersion` re-renders).
   */
  getSessionVersion(): number;
  /**
   * Shares one in-flight request per key and shopper identity across consumers. Each caller can
   * abort independently; the underlying request is aborted when every caller has aborted.
   * Settled requests are not cached beyond the current tick.
   */
  dedupe<T>(
    key: string,
    factory: (signal: AbortSignal) => Promise<T>,
    options?: { signal?: AbortSignal; force?: boolean }
  ): Promise<T>;
  loadCart(force?: boolean, signal?: AbortSignal): Promise<void>;
  addCartLineItem(
    input: ProductLineItemDraft & { Quantity: number }
  ): Promise<AddLineItemResult>;
  updateCartLineItem(lineItemId: string, quantity: number): Promise<void>;
  removeCartLineItem(lineItemId: string): Promise<void>;
  clearCart(): Promise<void>;
  acknowledgeCartReset(): void;
}

/**
 * Shared cart state held by `CommerceProvider`.
 * @internal
 */
export interface CartInternalState {
  data: CartData | null;
  status: 'idle' | 'loading' | 'success' | 'error';
  isRefetching: boolean;
  isMutating: boolean;
  error: CommerceError | null;
  reset: CartReset | null;
}

interface InFlightRequest {
  promise: Promise<unknown>;
  controller: AbortController;
  refs: number;
  settled: boolean;
}

const abortError = () => {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
};

const CommerceContext = React.createContext<CommerceContextValue | undefined>(undefined);
const CommerceInternalContext = React.createContext<CommerceInternalContextValue | undefined>(
  undefined
);

const IDLE_SHOPPER: ShopperState = { user: null, status: 'idle', error: null };
const IDLE_CART: CartInternalState = {
  data: null,
  status: 'idle',
  isRefetching: false,
  isMutating: false,
  error: null,
  reset: null,
};

const toError = (error: unknown): CommerceError =>
  error instanceof CommerceError
    ? error
    : new CommerceError((error as Error)?.message || 'Commerce request failed.', {
        source: 'sdk',
      });

const isAborted = (error: unknown) => (error as Error | undefined)?.name === 'AbortError';

interface CommerceSetup {
  service: OrderCloudService;
  tokenStore: CommerceTokenStore;
}

const createSetup = (
  contextId: string,
  edgeUrl: string | undefined,
  tokens: CommerceTokenOptions,
  isEditing: boolean,
  timeout: number | undefined
): CommerceSetup => {
  let tokenStore: CommerceTokenStore;
  let tokenClient: CommerceTokenClient;

  if (isEditing) {
    // avoid third-party cookie issues in the Pages iframe and never touch the visitor's cookies
    tokenStore = createMemoryTokenStore();
    tokenClient = new EdgeTokenClient({ contextId, edgeUrl, timeout });
  } else if (tokens.mode === 'route-handler') {
    tokenStore = createBrowserCookieTokenStore({
      refreshTokenStorage: 'none',
      cookies: tokens.cookies,
    });
    tokenClient = new RouteHandlerTokenClient({ endpoint: tokens.endpoint, timeout });
  } else {
    tokenStore = createBrowserCookieTokenStore({
      refreshTokenStorage: tokens.refreshTokenStorage,
      cookies: tokens.cookies,
    });
    tokenClient = new EdgeTokenClient({ contextId, edgeUrl, timeout });
  }

  const sessionManager = new ShopperSessionManager({ tokenClient, tokenStore });
  return {
    service: new OrderCloudService({ contextId, edgeUrl, sessionManager, timeout }),
    tokenStore,
  };
};

/**
 * Provides commerce (OrderCloud) session state to commerce hooks.
 * Reads the context ID, Edge URL and page mode from `SitecoreProvider`.
 * Lazy by default: no request is made until a hook needs a session.
 * @param {CommerceProviderProps} props provider props
 * @returns {React.ReactElement} provider element
 * @public
 */
export const CommerceProvider = (props: CommerceProviderProps): React.ReactElement => {
  const { children, tokens, eager = false, timeout } = props;
  const { api, page } = useSitecore();
  const contextId = api?.edge?.clientContextId;
  const edgeUrl = api?.edge?.edgeUrl;
  const isEditing = !!(
    page?.mode?.isEditing ||
    page?.mode?.isPreview ||
    page?.mode?.isDesignLibrary
  );
  // inline `tokens` objects change identity every render; key on their content instead
  const tokensKey = JSON.stringify(tokens ?? null);

  const setup = useMemo<CommerceSetup | null>(
    () =>
      contextId
        ? createSetup(contextId, edgeUrl, JSON.parse(tokensKey), isEditing, timeout)
        : null,
    [contextId, edgeUrl, tokensKey, isEditing, timeout]
  );

  const configError = useMemo(
    () =>
      setup
        ? null
        : new CommerceError(
            'CommerceProvider: api.edge.clientContextId is not configured in SitecoreProvider.',
            { source: 'sdk' }
          ),
    [setup]
  );

  const [session, setSession] = useState<ShopperSession | null>(null);
  const [status, setStatus] = useState<CommerceStatus>(configError ? 'error' : 'idle');
  const [error, setError] = useState<CommerceError | null>(configError);
  const [lastSessionChange, setLastSessionChange] = useState<SessionChangeEvent | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [shopper, setShopper] = useState<ShopperState>(IDLE_SHOPPER);
  const [cart, setCart] = useState<CartInternalState>(IDLE_CART);

  // identity version, bumped synchronously by session events so loads can read it immediately
  const versionRef = useRef(0);
  const shopperRef = useRef<{ version: number; controller: AbortController | null } | null>(null);
  const setupRef = useRef(setup);
  const inFlightRef = useRef(new Map<string, InFlightRequest>());
  const cartLoadedVersionRef = useRef<number | null>(null);
  const cartMutationQueueRef = useRef(Promise.resolve());
  const activeCartMutationsRef = useRef(0);

  useEffect(() => {
    // reset only when the setup changes after mount; child effects may already have updated state
    if (setupRef.current !== setup) {
      setupRef.current = setup;
      setSession(null);
      setLastSessionChange(null);
      setShopper(IDLE_SHOPPER);
      setCart(IDLE_CART);
      setError(configError);
      setStatus(configError ? 'error' : 'idle');
      shopperRef.current?.controller?.abort();
      shopperRef.current = null;
      cartLoadedVersionRef.current = null;
      inFlightRef.current.clear();
    }

    if (!setup) return undefined;

    let active = true;
    const unsubscribe = setup.service.sessionManager.subscribe((event) => {
      if (!active) return;
      setSession(event.session);
      if (event.reason !== 'refreshed') {
        versionRef.current += 1;
        inFlightRef.current.clear();
        cartLoadedVersionRef.current = null;
        setCart((current) => ({
          ...IDLE_CART,
          reset:
            event.reason === 'replaced' && event.previousUserType === 'anonymous'
              ? { reason: 'session-replaced' }
              : event.reason === 'acquired' || event.reason === 'cleared'
              ? null
              : current.reset,
        }));
        setSessionVersion(versionRef.current);
        setLastSessionChange(event);
      }
    });

    // pick up an existing session cookie without any network request
    Promise.resolve(setup.tokenStore.get(DEFAULT_TOKEN_KEY))
      .then((stored) => {
        if (active && isSessionUsable(stored)) {
          setSession((current) => current ?? stored);
          setStatus((current) => (current === 'idle' ? 'ready' : current));
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unsubscribe();
      shopperRef.current?.controller?.abort();
    };
  }, [setup, configError]);

  const runSessionOperation = useCallback(
    async (operation: (service: OrderCloudService) => Promise<ShopperSession>) => {
      if (!setup) throw configError as CommerceError;
      setStatus((current) => (current === 'ready' ? current : 'loading'));
      try {
        const next = await operation(setup.service);
        setSession((current) =>
          current?.accessToken === next.accessToken && current.expiresAt === next.expiresAt
            ? current
            : next
        );
        setStatus('ready');
        setError(null);
        return next;
      } catch (err) {
        const normalized = toError(err);
        setStatus('error');
        setError(normalized);
        throw normalized;
      }
    },
    [setup, configError]
  );

  const ensureSession = useCallback(
    () => runSessionOperation((service) => service.auth.getSession()),
    [runSessionOperation]
  );

  const resetSession = useCallback(
    () => runSessionOperation((service) => service.auth.reset()),
    [runSessionOperation]
  );

  const loadShopper = useCallback(
    async (force = false): Promise<void> => {
      if (!setup) {
        setShopper({ user: null, status: 'error', error: configError });
        return;
      }

      try {
        await ensureSession();
      } catch (err) {
        setShopper({ user: null, status: 'error', error: toError(err) });
        return;
      }

      // read after ensureSession: acquiring a session bumps the version synchronously
      const version = versionRef.current;
      if (!force && shopperRef.current?.version === version) return;

      shopperRef.current?.controller?.abort();
      const controller = new AbortController();
      shopperRef.current = { version, controller };
      // identity change clears the previous user; an explicit refetch keeps it while loading
      setShopper((current) => ({
        user: force ? current.user : null,
        status: 'loading',
        error: null,
      }));

      try {
        const user = await setup.service.me.get({ signal: controller.signal });
        if (controller.signal.aborted || versionRef.current !== version) return;
        setShopper({ user, status: 'success', error: null });
      } catch (err) {
        if (controller.signal.aborted || isAborted(err)) return;
        // keep the error until refetch() or an identity change; do not retry automatically
        setShopper({ user: null, status: 'error', error: toError(err) });
      }
    },
    [setup, configError, ensureSession]
  );

  useEffect(() => {
    if (eager && setup) ensureSession().catch(() => undefined);
  }, [eager, setup, ensureSession]);

  const getSessionVersion = useCallback(() => versionRef.current, []);

  const dedupe = useCallback(
    <T,>(
      key: string,
      factory: (signal: AbortSignal) => Promise<T>,
      options: { signal?: AbortSignal; force?: boolean } = {}
    ): Promise<T> => {
      const { signal, force } = options;
      if (signal?.aborted) return Promise.reject(abortError());

      const map = inFlightRef.current;
      const fullKey = `${versionRef.current}|${key}`;
      let entry = force ? undefined : map.get(fullKey);

      if (!entry) {
        const controller = new AbortController();
        const created: InFlightRequest = {
          controller,
          refs: 0,
          settled: false,
          promise: Promise.resolve(),
        };
        created.promise = factory(controller.signal).then(
          (value) => {
            created.settled = true;
            // keep the entry for one tick so consumers starting in the same commit still share it
            setTimeout(() => {
              if (map.get(fullKey) === created) map.delete(fullKey);
            }, 0);
            return value;
          },
          (err) => {
            created.settled = true;
            // drop failures immediately so a retry sends a new request
            if (map.get(fullKey) === created) map.delete(fullKey);
            throw err;
          }
        );
        // avoid unhandled rejections when every consumer has aborted
        created.promise.catch(() => undefined);
        map.set(fullKey, created);
        entry = created;
      }

      const shared = entry;
      shared.refs += 1;

      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          shared.refs -= 1;
          if (shared.refs <= 0 && !shared.settled) {
            shared.controller.abort();
            if (map.get(fullKey) === shared) map.delete(fullKey);
          }
          reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        shared.promise.then(
          (value) => {
            signal?.removeEventListener('abort', onAbort);
            if (!signal?.aborted) resolve(value as T);
          },
          (err) => {
            signal?.removeEventListener('abort', onAbort);
            if (!signal?.aborted) reject(err);
          }
        );
      });
    },
    []
  );

  const loadCart = useCallback(
    async (force = false, signal?: AbortSignal): Promise<void> => {
      if (!setup) {
        setCart({
          ...IDLE_CART,
          status: 'error',
          error: configError,
        });
        return;
      }
      if (signal?.aborted) return;

      setCart((current) => ({
        ...current,
        status: current.data ? 'success' : 'loading',
        isRefetching: !!current.data,
        error: null,
      }));

      try {
        await ensureSession();
        if (signal?.aborted) return;
        const version = getSessionVersion();
        if (!force && cartLoadedVersionRef.current === version) {
          setCart((current) => ({ ...current, isRefetching: false }));
          return;
        }

        const order = await dedupe(
          'cart:order',
          (sharedSignal) => setup.service.cart.get({ signal: sharedSignal }),
          { signal, force }
        );
        if (signal?.aborted || versionRef.current !== version) return;

        const lineItems = order.ID
          ? (
              await dedupe(
                'cart:line-items',
                (sharedSignal) =>
                  setup.service.cart.listLineItems(undefined, { signal: sharedSignal }),
                { signal, force }
              )
            ).Items
          : [];
        if (signal?.aborted || versionRef.current !== version) return;

        cartLoadedVersionRef.current = version;
        setCart((current) => ({
          ...current,
          data: { order, lineItems },
          status: 'success',
          isRefetching: false,
          error: null,
        }));
      } catch (err) {
        if (signal?.aborted || isAborted(err)) return;
        cartLoadedVersionRef.current = null;
        setCart((current) => ({
          ...current,
          status: 'error',
          isRefetching: false,
          error: toError(err),
        }));
      }
    },
    [setup, configError, ensureSession, getSessionVersion, dedupe]
  );

  const runCartMutation = useCallback(
    <T,>(operation: (service: OrderCloudService) => Promise<T>): Promise<T> => {
      if (!setup) return Promise.reject(configError as CommerceError);
      if (isEditing) {
        return Promise.reject(
          new CommerceError('Cart mutations are disabled in editing and preview modes.', {
            source: 'sdk',
            code: 'editing-mode',
          })
        );
      }

      activeCartMutationsRef.current += 1;
      setCart((current) => ({ ...current, isMutating: true }));
      const run = async () => {
        try {
          const result = await operation(setup.service);
          await loadCart(true);
          return result;
        } catch (error) {
          await loadCart(true);
          throw error;
        } finally {
          activeCartMutationsRef.current -= 1;
          setCart((current) => ({
            ...current,
            isMutating: activeCartMutationsRef.current > 0,
          }));
        }
      };
      const next = cartMutationQueueRef.current.then(run, run);
      cartMutationQueueRef.current = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
    [setup, configError, isEditing, loadCart]
  );

  const addCartLineItem = useCallback(
    async (input: ProductLineItemDraft & { Quantity: number }) => {
      const result = await runCartMutation((service) => service.cart.addLineItem(input));
      if (result.sessionRenewed) {
        setCart((current) => ({
          ...current,
          reset: { reason: 'cart-submitted' },
        }));
      }
      return result;
    },
    [runCartMutation]
  );

  const updateCartLineItem = useCallback(
    (lineItemId: string, quantity: number) =>
      runCartMutation(async (service) => {
        await service.cart.updateLineItem(lineItemId, { Quantity: quantity });
      }),
    [runCartMutation]
  );

  const removeCartLineItem = useCallback(
    (lineItemId: string) =>
      runCartMutation((service) => service.cart.removeLineItem(lineItemId)),
    [runCartMutation]
  );

  const clearCart = useCallback(
    () => runCartMutation((service) => service.cart.delete()),
    [runCartMutation]
  );

  const acknowledgeCartReset = useCallback(() => {
    setCart((current) => (current.reset ? { ...current, reset: null } : current));
  }, []);

  const userType = session?.userType ?? null;

  const value = useMemo<CommerceContextValue>(
    () => ({
      service: setup?.service ?? null,
      session,
      userType,
      isAnonymous: userType === 'anonymous',
      status,
      error,
      ensureSession,
      resetSession,
      isEditing,
      lastSessionChange,
    }),
    [
      setup,
      session,
      userType,
      status,
      error,
      ensureSession,
      resetSession,
      isEditing,
      lastSessionChange,
    ]
  );

  const internal = useMemo<CommerceInternalContextValue>(
    () => ({
      sessionVersion,
      shopper,
      loadShopper,
      getSessionVersion,
      dedupe,
      cart,
      loadCart,
      addCartLineItem,
      updateCartLineItem,
      removeCartLineItem,
      clearCart,
      acknowledgeCartReset,
    }),
    [
      sessionVersion,
      shopper,
      loadShopper,
      getSessionVersion,
      dedupe,
      cart,
      loadCart,
      addCartLineItem,
      updateCartLineItem,
      removeCartLineItem,
      clearCart,
      acknowledgeCartReset,
    ]
  );

  return (
    <CommerceContext.Provider value={value}>
      <CommerceInternalContext.Provider value={internal}>{children}</CommerceInternalContext.Provider>
    </CommerceContext.Provider>
  );
};

CommerceProvider.displayName = 'CommerceProvider';

/**
 * Low-level access to the commerce provider: the OrderCloud service, the current session and
 * session operations. Does not make any request by itself.
 * @returns {CommerceContextValue} commerce context
 * @throws {Error} when used outside a `CommerceProvider`
 * @public
 */
export function useCommerce(): CommerceContextValue {
  const context = useContext(CommerceContext);
  if (!context) {
    throw new Error('useCommerce must be used within a CommerceProvider.');
  }
  return context;
}

/**
 * Internal commerce context for hooks.
 * @returns {CommerceInternalContextValue} internal context
 * @throws {Error} when used outside a `CommerceProvider`
 * @internal
 */
export function useCommerceInternal(): CommerceInternalContextValue {
  const context = useContext(CommerceInternalContext);
  if (!context) {
    throw new Error('Commerce hooks must be used within a CommerceProvider.');
  }
  return context;
}
