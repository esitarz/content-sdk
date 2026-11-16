import { LineItemSpec, Spec, SpecOption, Variant } from '../ordercloud-types';

/**
 * Shopper selection for one spec.
 * @public
 */
export interface SpecSelection {
  /**
   * Selected option ID.
   */
  optionId?: string;
  /**
   * Open-text value (spec with no options and `AllowOpenText`, or an option with `IsOpenText`).
   */
  value?: string;
}

/**
 * Selections keyed by spec ID.
 * @public
 */
export type SpecSelections = Record<string, SpecSelection>;

/**
 * Selection issue codes produced by {@link validateSelections}.
 * - `required`: a required spec has no option or value
 * - `value-required`: the selected option is open text (or a required spec is text-only) but the value is empty
 * - `invalid-option`: the option ID is not one of the spec's options
 * - `open-text-not-allowed`: a value was given for a spec that does not accept open text
 * - `spec-unavailable`: a required spec has no options and does not accept open text
 * - `variant-unavailable`: every variant spec is selected but no active variant matches
 * @public
 */
export type SpecSelectionIssueCode =
  | 'required'
  | 'value-required'
  | 'invalid-option'
  | 'open-text-not-allowed'
  | 'spec-unavailable'
  | 'variant-unavailable';

/**
 * Selection validation issue. Contains a code, never display text.
 * @public
 */
export interface SpecSelectionIssue<TCode extends string = SpecSelectionIssueCode> {
  /**
   * Spec the issue applies to; '' for product-level issues such as `variant-unavailable`.
   */
  specId: string;
  code: TCode;
  params?: Record<string, string | number>;
}

/**
 * Availability of options keyed by spec ID, then option ID.
 * @public
 */
export type OptionAvailability = Record<string, Record<string, boolean>>;

/**
 * Line-item draft for a product selection. Add a `Quantity` to create an OrderCloud line item.
 * @public
 */
export interface ProductLineItemDraft {
  ProductID: string;
  /**
   * Resolved variant, when the product has variant specs. Informational; OrderCloud resolves the
   * variant from `Specs`.
   */
  VariantID?: string;
  Specs: LineItemSpec[];
}

const getOptions = (spec: Spec): SpecOption[] =>
  Array.isArray(spec.Options) ? spec.Options.filter((option) => !!option?.ID) : [];

const validSpecs = (specs: Spec[]): Spec[] => (specs ?? []).filter((spec) => !!spec?.ID);

const variantSpecsOf = (specs: Spec[]) => validSpecs(specs).filter((spec) => spec.DefinesVariant);

const activeVariants = (variants: Variant[]) =>
  (variants ?? []).filter((variant) => !!variant?.ID && variant.Active !== false);

const variantOption = (variant: Variant, specId: string): string | undefined =>
  variant.Specs?.find((entry) => entry?.SpecID === specId)?.OptionID ?? undefined;

const nonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const variantMatches = (
  variant: Variant,
  variantSpecs: Spec[],
  selections: SpecSelections,
  ignoredSpecId?: string
) =>
  variantSpecs.every((spec) => {
    if (spec.ID === ignoredSpecId) return true;
    const optionId = selections[spec.ID]?.optionId;
    return !optionId || variantOption(variant, spec.ID) === optionId;
  });

/**
 * Checks whether any spec defines variants.
 * @param {Spec[]} specs product specs
 * @returns {boolean} true when at least one spec has `DefinesVariant`
 * @public
 */
export function hasVariantSpecs(specs: Spec[]): boolean {
  return variantSpecsOf(specs).length > 0;
}

/**
 * Returns OrderCloud default selections: `DefaultOptionID` (only when it is one of the spec's
 * options) and `DefaultValue`. Specs without defaults are omitted.
 * @param {Spec[]} specs product specs
 * @returns {SpecSelections} default selections
 * @public
 */
export function getDefaultSelections(specs: Spec[]): SpecSelections {
  const selections: SpecSelections = {};
  for (const spec of validSpecs(specs)) {
    const selection: SpecSelection = {};
    if (spec.DefaultOptionID && getOptions(spec).some((o) => o.ID === spec.DefaultOptionID)) {
      selection.optionId = spec.DefaultOptionID;
    }
    const value = nonEmpty(spec.DefaultValue);
    if (value) selection.value = value;
    if (selection.optionId || selection.value) selections[spec.ID] = selection;
  }
  return selections;
}

/**
 * Returns the initial selections for a product: OrderCloud defaults, overridden by `initial`, then
 * adjusted so variant-defining specs land on an existing active variant (most matching selections
 * first, then variant ID order). Entries in `initial` for unknown specs or options are ignored.
 * @param {Spec[]} specs product specs
 * @param {Variant[]} variants product variants
 * @param {SpecSelections} [initial] preferred selections, e.g. from a URL
 * @returns {SpecSelections} initial selections
 * @public
 */
export function getInitialSelections(
  specs: Spec[],
  variants: Variant[],
  initial?: SpecSelections
): SpecSelections {
  const selections = getDefaultSelections(specs);

  for (const spec of validSpecs(specs)) {
    const preferred = initial?.[spec.ID];
    if (!preferred) continue;
    if (preferred.optionId && !getOptions(spec).some((o) => o.ID === preferred.optionId)) continue;
    selections[spec.ID] = { ...preferred };
  }

  const variantSpecs = variantSpecsOf(specs);
  if (!variantSpecs.length || resolveVariant(specs, selections, variants)) return selections;

  const matchCount = (variant: Variant) =>
    variantSpecs.filter((spec) => selections[spec.ID]?.optionId === variantOption(variant, spec.ID))
      .length;

  const [closest] = activeVariants(variants)
    .filter((variant) => variantSpecs.every((spec) => !!variantOption(variant, spec.ID)))
    .sort((a, b) => matchCount(b) - matchCount(a) || a.ID.localeCompare(b.ID));

  if (!closest) return selections;

  for (const spec of variantSpecs) {
    selections[spec.ID] = { optionId: variantOption(closest, spec.ID) };
  }
  return selections;
}

/**
 * Resolves the active variant matching every variant-defining selection.
 * @param {Spec[]} specs product specs
 * @param {SpecSelections} selections current selections
 * @param {Variant[]} variants product variants
 * @returns {Variant | undefined} matching variant, or undefined when a variant spec is unselected or nothing matches
 * @public
 */
export function resolveVariant(
  specs: Spec[],
  selections: SpecSelections,
  variants: Variant[]
): Variant | undefined {
  const variantSpecs = variantSpecsOf(specs);
  if (!variantSpecs.length) return undefined;
  if (variantSpecs.some((spec) => !selections[spec.ID]?.optionId)) return undefined;
  return activeVariants(variants).find((variant) =>
    variantMatches(variant, variantSpecs, selections)
  );
}

/**
 * Returns whether each option of each variant-defining spec can form an active variant together
 * with the other current selections. Non-variant specs are not listed.
 * @param {Spec[]} specs product specs
 * @param {SpecSelections} selections current selections
 * @param {Variant[]} variants product variants
 * @returns {OptionAvailability} availability by spec ID and option ID
 * @public
 */
export function getOptionAvailability(
  specs: Spec[],
  selections: SpecSelections,
  variants: Variant[]
): OptionAvailability {
  const variantSpecs = variantSpecsOf(specs);
  const candidates = activeVariants(variants);
  const availability: OptionAvailability = {};

  for (const spec of variantSpecs) {
    availability[spec.ID] = {};
    for (const option of getOptions(spec)) {
      availability[spec.ID][option.ID] = candidates.some(
        (variant) =>
          variantOption(variant, spec.ID) === option.ID &&
          variantMatches(variant, variantSpecs, selections, spec.ID)
      );
    }
  }
  return availability;
}

/**
 * Validates selections against OrderCloud spec rules. Value constraints (e.g. from `xp`) are not
 * checked; layer them on in the caller.
 * @param {Spec[]} specs product specs
 * @param {SpecSelections} selections current selections
 * @param {Variant[]} [variants] product variants; when given, adds `variant-unavailable` if all variant specs are selected but no active variant matches
 * @returns {SpecSelectionIssue[]} issues, at most one per spec plus product-level issues
 * @public
 */
export function validateSelections(
  specs: Spec[],
  selections: SpecSelections,
  variants?: Variant[]
): SpecSelectionIssue[] {
  const issues: SpecSelectionIssue[] = [];
  const issue = (specId: string, code: SpecSelectionIssueCode) => issues.push({ specId, code });

  for (const spec of validSpecs(specs)) {
    const options = getOptions(spec);
    const selection = selections?.[spec.ID] ?? {};
    const value = nonEmpty(selection.value);
    const selected = selection.optionId
      ? options.find((option) => option.ID === selection.optionId)
      : undefined;
    const acceptsText = !!spec.AllowOpenText || !!selected?.IsOpenText;
    const textOnly = options.length === 0 && !!spec.AllowOpenText;

    if (selection.optionId && !selected) {
      issue(spec.ID, 'invalid-option');
    } else if (spec.Required && options.length === 0 && !spec.AllowOpenText) {
      issue(spec.ID, 'spec-unavailable');
    } else if (value && !acceptsText) {
      issue(spec.ID, 'open-text-not-allowed');
    } else if (selected?.IsOpenText && !value) {
      issue(spec.ID, 'value-required');
    } else if (spec.Required && textOnly && !value) {
      issue(spec.ID, 'value-required');
    } else if (spec.Required && !selected && !value) {
      issue(spec.ID, 'required');
    }
  }

  if (variants) {
    const variantSpecs = variantSpecsOf(specs);
    const allSelected =
      variantSpecs.length > 0 && variantSpecs.every((spec) => !!selections?.[spec.ID]?.optionId);
    if (allSelected && !resolveVariant(specs, selections, variants)) {
      issue('', 'variant-unavailable');
    }
  }

  return issues;
}

/**
 * Builds OrderCloud line-item specs from selections. Specs without an option or a non-blank value are
 * omitted; values are trimmed.
 * @param {Spec[]} specs product specs
 * @param {SpecSelections} selections current selections
 * @returns {LineItemSpec[]} line-item specs, in spec order
 * @public
 */
export function toLineItemSpecs(specs: Spec[], selections: SpecSelections): LineItemSpec[] {
  const result: LineItemSpec[] = [];
  for (const spec of validSpecs(specs)) {
    const selection = selections?.[spec.ID];
    const optionId = nonEmpty(selection?.optionId);
    const value = nonEmpty(selection?.value);
    if (!optionId && !value) continue;
    const entry: LineItemSpec = { SpecID: spec.ID };
    if (optionId) entry.OptionID = optionId;
    if (value) entry.Value = value;
    result.push(entry);
  }
  return result;
}
