/* eslint-disable no-redeclare */
import { useContext } from 'react';
import {
  ProductLineItemDraft,
  SpecSelection,
  SpecSelectionIssue,
  SpecSelections,
  Variant,
} from '@sitecore-content-sdk/commerce';
import { ProductSelectionContext } from './ProductProvider';
import { ProductHookOptions, missingProductProvider } from './useProduct';

/**
 * State returned by `useProductSelection`.
 * @public
 */
export interface UseProductSelectionState {
  selections: SpecSelections;
  selectedVariant: Variant | undefined;
  /**
   * Current issues (OrderCloud rules plus `validateSpec`), always computed.
   */
  issues: SpecSelectionIssue<string>[];
  /**
   * Issues the UI should show: those for specs the shopper touched, plus all issues after `validate()`.
   * Product-level issues (`specId: ''`) show after `validate()` or once a variant spec is touched.
   */
  visibleIssues: SpecSelectionIssue<string>[];
  /**
   * True when the product and options are loaded and there are no issues.
   */
  isComplete: boolean;
  /**
   * Sets the selection of one spec and marks it as touched.
   */
  setSelection(specId: string, selection: SpecSelection): void;
  /**
   * Restores initial selections and hides all issues.
   */
  resetSelections(): void;
  /**
   * Makes every issue visible and returns `isComplete`.
   */
  validate(): boolean;
  /**
   * Line-item draft for the current selection, or null when not complete.
   */
  getLineItemDraft(): ProductLineItemDraft | null;
}

/**
 * Returns the spec selections, issues and line-item draft of the nearest `ProductProvider`.
 * @returns {UseProductSelectionState} selection state
 * @throws {Error} outside a `ProductProvider`
 * @public
 */
export function useProductSelection(): UseProductSelectionState;
/**
 * Returns the selection state of the nearest `ProductProvider`, or null outside one.
 * @param {object} options hook options
 * @param {true} options.optional return null outside a `ProductProvider`
 * @returns {UseProductSelectionState | null} selection state or null
 * @public
 */
export function useProductSelection(options: { optional: true }): UseProductSelectionState | null;
/**
 * Implementation of `useProductSelection`.
 * @param {ProductHookOptions} [options] hook options
 * @returns {UseProductSelectionState | null} selection state or null
 */
export function useProductSelection(
  options?: ProductHookOptions
): UseProductSelectionState | null {
  const context = useContext(ProductSelectionContext);
  if (!context && !options?.optional) throw missingProductProvider('useProductSelection');
  return context;
}
