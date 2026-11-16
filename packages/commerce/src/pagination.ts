import { debug } from './debug';
import { ListPage } from './ordercloud-types';

/**
 * Default maximum number of pages followed by {@link listAll}.
 * @internal
 */
export const DEFAULT_MAX_PAGES = 20;

/**
 * Maximum OrderCloud page size.
 * @internal
 */
export const MAX_PAGE_SIZE = 100;

/**
 * Options for {@link listAll}.
 * @internal
 */
export interface ListAllOptions {
  pageSize?: number;
  maxPages?: number;
  signal?: AbortSignal | null;
}

const abortError = () => {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
};

/**
 * Loads every page of an OrderCloud list, up to `maxPages`, and merges them into one page.
 * Pages are requested sequentially; `Meta.TotalCount` is taken from the first page.
 * @param {Function} fetchPage loads one page (1-based)
 * @param {ListAllOptions} [options] pagination options
 * @returns {Promise<ListPage<T>>} merged list
 * @internal
 */
export async function listAll<T>(
  fetchPage: (page: number, pageSize: number) => Promise<ListPage<T>>,
  options: ListAllOptions = {}
): Promise<ListPage<T>> {
  const pageSize = options.pageSize ?? MAX_PAGE_SIZE;
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);

  const first = await fetchPage(1, pageSize);
  const items = [...(first.Items ?? [])];
  const totalPages = first.Meta?.TotalPages ?? 1;
  const lastPage = Math.min(totalPages, maxPages);

  for (let page = 2; page <= lastPage; page++) {
    if (options.signal?.aborted) throw abortError();
    const next = await fetchPage(page, pageSize);
    items.push(...(next.Items ?? []));
  }

  if (totalPages > maxPages) {
    debug(
      'listAll: stopped after %d of %d pages (maxPages); returning %d items',
      maxPages,
      totalPages,
      items.length
    );
  }

  return {
    Items: items,
    Meta: {
      ...first.Meta,
      Page: 1,
      PageSize: items.length,
      TotalPages: 1,
      ItemRange: [items.length ? 1 : 0, items.length],
    },
  };
}
