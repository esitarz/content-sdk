import { CommerceError, isOrderCloudError } from '../errors';
import { CommerceRequestOptions } from '../models';
import { LineItem, ListPage, Order } from '../ordercloud-types';
import { listAll } from '../pagination';
import { ProductLineItemDraft } from '../products/product-options';
import { ListAllPagesOptions } from '../products/products-api';
import { serializeListOptions } from '../query';
import { ShopperSessionManager } from '../session/shopper-session-manager';

/**
 * Options for safely adding a line item.
 * @public
 */
export interface AddLineItemOptions {
  /**
   * Renew a spent anonymous session and retry. Registered sessions are never renewed this way.
   * @default true
   */
  renewSpentAnonymousSession?: boolean;
}

/**
 * Result of adding a line item.
 * @public
 */
export interface AddLineItemResult {
  lineItem: LineItem;
  /**
   * True when the previous anonymous cart had already been submitted and a fresh shopper was used.
   */
  sessionRenewed: boolean;
}

/**
 * Buyer cart operations.
 * @public
 */
export interface CartApi {
  get<TXp = Record<string, unknown>>(options?: CommerceRequestOptions): Promise<Order<TXp>>;
  listLineItems<TXp = Record<string, unknown>>(
    params?: ListAllPagesOptions,
    options?: CommerceRequestOptions
  ): Promise<ListPage<LineItem<TXp>>>;
  addLineItem(
    input: ProductLineItemDraft & { Quantity: number; ID?: string; xp?: Record<string, unknown> },
    options?: AddLineItemOptions & CommerceRequestOptions
  ): Promise<AddLineItemResult>;
  updateLineItem(
    lineItemId: string,
    patch: { Quantity?: number; Specs?: LineItem['Specs']; xp?: Record<string, unknown> },
    options?: CommerceRequestOptions
  ): Promise<LineItem>;
  removeLineItem(lineItemId: string, options?: CommerceRequestOptions): Promise<void>;
  patch<TXp = Record<string, unknown>>(
    patch: { xp?: Partial<TXp>; Comments?: string },
    options?: CommerceRequestOptions
  ): Promise<Order<TXp>>;
  delete(options?: CommerceRequestOptions): Promise<void>;
  submit<TXp = Record<string, unknown>>(options?: CommerceRequestOptions): Promise<Order<TXp>>;
}

/**
 * Authorized request used by the cart API.
 * @internal
 */
export type CartRequest = <T>(path: `/v1/${string}`, init: RequestInit) => Promise<T>;

const requiredId = (value: string, label: string): string => {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new CommerceError(`${label} is required.`, { source: 'sdk' });
  return encodeURIComponent(id);
};

const requiredProductId = (value: string): string => {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new CommerceError('ProductID is required.', { source: 'sdk' });
  return id;
};

const jsonInit = (method: string, body: unknown, options: CommerceRequestOptions = {}): RequestInit => {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  return { ...options, method, headers, body: JSON.stringify(body) };
};

const isTransient = (error: unknown): boolean =>
  error instanceof CommerceError &&
  (error.source === 'network' || (error.status !== undefined && error.status >= 500));

const retryTransient = async <T>(
  operation: () => Promise<T>,
  signal?: AbortSignal | null
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (signal?.aborted || !isTransient(error)) throw error;
    return operation();
  }
};

const generateLineItemId = (): string => {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (!randomUUID) {
    throw new CommerceError('Secure UUID generation is unavailable.', { source: 'sdk' });
  }
  return randomUUID.call(globalThis.crypto);
};

/**
 * Creates the cart API for an OrderCloud service.
 * @param {CartRequest} request authorized request
 * @param {ShopperSessionManager} sessionManager shopper session manager
 * @returns {CartApi} cart API
 * @internal
 */
export function createCartApi(
  request: CartRequest,
  sessionManager: ShopperSessionManager
): CartApi {
  const get = <TXp>(options?: CommerceRequestOptions) =>
    request<Order<TXp>>('/v1/cart', { ...options, method: 'GET' });

  const recoverConflict = async (
    error: unknown,
    lineItemId: string,
    canRenew: boolean,
    options: CommerceRequestOptions,
    post: () => Promise<LineItem>
  ): Promise<AddLineItemResult> => {
    if (!isOrderCloudError(error, { status: 409 })) throw error;

    try {
      const lineItem = await request<LineItem>(
        `/v1/cart/lineitems/${encodeURIComponent(lineItemId)}`,
        { ...options, method: 'GET' }
      );
      return { lineItem, sessionRenewed: false };
    } catch (readError) {
      if (!isOrderCloudError(readError, { status: 404 })) throw readError;
    }

    const cart = await get(options);
    if (cart.ID) {
      return { lineItem: await post(), sessionRenewed: false };
    }

    const session = await sessionManager.ensureSession(options);
    if (session.userType === 'anonymous' && canRenew) {
      await sessionManager.reset(options);
      return { lineItem: await post(), sessionRenewed: true };
    }
    throw error;
  };

  return {
    get,
    listLineItems: async <TXp>(
      params: ListAllPagesOptions = {},
      options?: CommerceRequestOptions
    ) => {
      const { all = true, maxPages, ...listParams } = params;
      if (!all) {
        const query = serializeListOptions(listParams);
        return request<ListPage<LineItem<TXp>>>(
          `/v1/cart/lineitems${query ? `?${query}` : ''}`,
          { ...options, method: 'GET' }
        );
      }
      return listAll<LineItem<TXp>>(
        (page, pageSize) =>
          request<ListPage<LineItem<TXp>>>(
            `/v1/cart/lineitems?${serializeListOptions({ ...listParams, page, pageSize })}`,
            { ...options, method: 'GET' }
          ),
        { pageSize: listParams.pageSize, maxPages, signal: options?.signal }
      );
    },
    addLineItem: async (input, options = {}) => {
      const { renewSpentAnonymousSession = true, ...requestOptions } = options;
      const lineItemId = input.ID?.trim() || generateLineItemId();
      const body = {
        ProductID: requiredProductId(input.ProductID),
        ID: lineItemId,
        Quantity: input.Quantity,
        ...(input.Specs?.length ? { Specs: input.Specs } : {}),
        ...(input.xp ? { xp: input.xp } : {}),
      };
      const post = () =>
        request<LineItem>('/v1/cart/lineitems', jsonInit('POST', body, requestOptions));

      try {
        return {
          lineItem: await retryTransient(post, requestOptions.signal),
          sessionRenewed: false,
        };
      } catch (error) {
        return recoverConflict(
          error,
          lineItemId,
          renewSpentAnonymousSession,
          requestOptions,
          post
        );
      }
    },
    updateLineItem: (lineItemId, patch, options) =>
      retryTransient(
        () =>
          request<LineItem>(
            `/v1/cart/lineitems/${requiredId(lineItemId, 'Line item ID')}`,
            jsonInit('PATCH', patch, options)
          ),
        options?.signal
      ),
    removeLineItem: async (lineItemId, options) => {
      try {
        await retryTransient(
          () =>
            request<void>(
              `/v1/cart/lineitems/${requiredId(lineItemId, 'Line item ID')}`,
              { ...options, method: 'DELETE' }
            ),
          options?.signal
        );
      } catch (error) {
        if (!isOrderCloudError(error, { status: 404 })) throw error;
      }
    },
    patch: <TXp>(
      patch: { xp?: Partial<TXp>; Comments?: string },
      options?: CommerceRequestOptions
    ) =>
      retryTransient(
        () => request<Order<TXp>>('/v1/cart', jsonInit('PATCH', patch, options)),
        options?.signal
      ),
    delete: async (options?: CommerceRequestOptions) => {
      await retryTransient(
        () => request<void>('/v1/cart', { ...options, method: 'DELETE' }),
        options?.signal
      );
    },
    submit: <TXp>(options?: CommerceRequestOptions) =>
      request<Order<TXp>>('/v1/cart/submit', { ...options, method: 'POST' }),
  };
}
