import { CommerceError } from './errors';

/**
 * Value of an OrderCloud list filter. Arrays are joined with `|` (OR).
 * @public
 */
export type ListFilterValue = string | number | boolean | Array<string | number> | undefined;

/**
 * Options for OrderCloud list endpoints.
 * @public
 */
export interface ListOptions {
  /**
   * Search terms.
   */
  search?: string;
  /**
   * Properties to search on.
   */
  searchOn?: string[];
  /**
   * How search terms are matched.
   */
  searchType?:
    | 'AnyTerm'
    | 'AllTermsAnyField'
    | 'AllTermsSameField'
    | 'ExactPhrase'
    | 'ExactPhrasePrefix';
  /**
   * Sort properties; prefix with `!` for descending.
   */
  sortBy?: string[];
  /**
   * 1-based page number.
   */
  page?: number;
  /**
   * Page size (OrderCloud maximum: 100).
   */
  pageSize?: number;
  /**
   * OrderCloud filters, e.g. `{ 'xp.Brand': 'Acme', ID: ['a', 'b'], Price: '>10' }`.
   * Keys are sent verbatim; arrays are joined with `|` (OR).
   */
  filters?: Record<string, ListFilterValue>;
}

/**
 * Options for listing buyer products.
 * @public
 */
export interface ListProductsOptions extends ListOptions {
  catalogID?: string;
  categoryID?: string;
  depth?: string;
}

const RESERVED_KEYS = [
  'search',
  'searchOn',
  'searchType',
  'sortBy',
  'page',
  'pageSize',
  'catalogID',
  'categoryID',
  'depth',
];

const encodePair = (key: string, value: string) =>
  `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;

/**
 * Serializes OrderCloud list options into a query string (without a leading `?`).
 * Undefined values are dropped, `sortBy`/`searchOn` are comma-joined and filter arrays are `|`-joined.
 * @param {ListProductsOptions} [options] list options
 * @returns {string} query string, or '' when there is nothing to send
 * @throws {CommerceError} when a filter key collides with a reserved list parameter
 * @internal
 */
export function serializeListOptions(options: ListProductsOptions = {}): string {
  const { filters, ...params } = options;
  const pairs: string[] = [];

  for (const key of RESERVED_KEYS) {
    const value = (params as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length) pairs.push(encodePair(key, value.join(',')));
    } else if (value !== '') {
      pairs.push(encodePair(key, String(value)));
    }
  }

  for (const [key, value] of Object.entries(filters ?? {})) {
    if (RESERVED_KEYS.some((reserved) => reserved.toLowerCase() === key.toLowerCase())) {
      throw new CommerceError(`Filter key "${key}" collides with a reserved list parameter.`, {
        source: 'sdk',
      });
    }
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length) pairs.push(encodePair(key, value.join('|')));
    } else {
      pairs.push(encodePair(key, String(value)));
    }
  }

  return pairs.join('&');
}
