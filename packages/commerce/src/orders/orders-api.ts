import { CommerceError } from '../errors';
import { CommerceRequestOptions } from '../models';
import { ListPage, Order } from '../ordercloud-types';

/**
 * Shopper-owned order operations.
 * @public
 */
export interface OrdersApi {
  /**
   * Gets one submitted order owned by the current shopper.
   */
  get<TXp = Record<string, unknown>>(
    orderId: string,
    options?: CommerceRequestOptions
  ): Promise<Order<TXp>>;
}

/**
 * Authorized request used by the orders API.
 * @internal
 */
export type OrdersRequest = <T>(path: `/v1/${string}`, init: RequestInit) => Promise<T>;

/**
 * Creates the shopper orders API.
 * @param {OrdersRequest} request authorized request
 * @returns {OrdersApi} orders API
 * @internal
 */
export function createOrdersApi(request: OrdersRequest): OrdersApi {
  return {
    get: async <TXp>(orderId: string, options?: CommerceRequestOptions) => {
      const id = typeof orderId === 'string' ? orderId.trim() : '';
      if (!id) throw new CommerceError('Order ID is required.', { source: 'sdk' });
      const page = await request<ListPage<Order<TXp>>>(
        `/v1/me/orders?ID=${encodeURIComponent(id)}&pageSize=1`,
        { ...options, method: 'GET' }
      );
      const order = page.Items?.[0];
      if (!order) {
        throw new CommerceError('Order was not found for the current shopper.', {
          source: 'ordercloud',
          status: 404,
          code: 'NotFound',
        });
      }
      return order;
    },
  };
}
