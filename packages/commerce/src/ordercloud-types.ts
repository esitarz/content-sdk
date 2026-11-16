// Local OrderCloud types, shaped and named like OrderCloud's own models (PascalCase).
// Only the fields the SDK reads are required; responses are passed through unvalidated.

/**
 * OrderCloud list metadata.
 * @public
 */
export interface ListMeta {
  Page?: number;
  PageSize?: number;
  TotalCount?: number;
  TotalPages?: number;
  ItemRange?: number[];
  NextPageKey?: string;
  Facets?: Array<{
    Name: string;
    XpPath: string;
    Values: Array<{ Value: string; Count: number }>;
  }>;
}

/**
 * OrderCloud list response.
 * @public
 */
export interface ListPage<T> {
  Items: T[];
  Meta: ListMeta;
}

/**
 * OrderCloud price break.
 * @public
 */
export interface PriceBreak {
  Quantity: number;
  Price: number;
  SalePrice?: number | null;
}

/**
 * OrderCloud price schedule.
 * @public
 */
export interface PriceSchedule {
  ID?: string;
  Name?: string;
  Currency?: string | null;
  MinQuantity?: number;
  MaxQuantity?: number | null;
  RestrictedQuantity?: boolean;
  IsOnSale?: boolean;
  PriceBreaks?: PriceBreak[];
  xp?: unknown;
}

/**
 * OrderCloud product or variant inventory.
 * @public
 */
export interface Inventory {
  Enabled?: boolean;
  NotificationPoint?: number | null;
  VariantLevelTracking?: boolean;
  OrderCanExceed?: boolean;
  QuantityAvailable?: number | null;
}

/**
 * OrderCloud buyer product (`GET /v1/me/products`).
 * @public
 */
export interface BuyerProduct<TXp = Record<string, unknown>> {
  ID: string;
  Name: string;
  Description?: string | null;
  Active?: boolean;
  ParentID?: string | null;
  IsParent?: boolean;
  QuantityMultiplier?: number;
  SpecCount?: number;
  VariantCount?: number;
  PriceSchedule?: PriceSchedule | null;
  Inventory?: Inventory | null;
  DefaultSupplierID?: string | null;
  xp?: TXp;
}

/**
 * OrderCloud spec option price markup type.
 * @public
 */
export type PriceMarkupType = 'NoMarkup' | 'AmountPerQuantity' | 'AmountTotal' | 'Percentage';

/**
 * OrderCloud spec option.
 * @public
 */
export interface SpecOption<TXp = Record<string, unknown>> {
  ID: string;
  Value: string;
  ListOrder?: number;
  IsOpenText?: boolean;
  PriceMarkupType?: PriceMarkupType;
  PriceMarkup?: number | null;
  xp?: TXp;
}

/**
 * OrderCloud product spec.
 * @public
 */
export interface Spec<TXp = Record<string, unknown>, TOptionXp = Record<string, unknown>> {
  ID: string;
  Name: string;
  ListOrder?: number;
  Required?: boolean;
  AllowOpenText?: boolean;
  DefinesVariant?: boolean;
  DefaultValue?: string | null;
  DefaultOptionID?: string | null;
  OptionCount?: number;
  Options?: Array<SpecOption<TOptionXp>>;
  xp?: TXp;
}

/**
 * Spec entry on an OrderCloud variant.
 * @public
 */
export interface VariantSpec {
  SpecID: string;
  OptionID?: string | null;
  Name?: string;
  Value?: string;
  PriceMarkupType?: PriceMarkupType;
  PriceMarkup?: number | null;
}

/**
 * OrderCloud product variant.
 * @public
 */
export interface Variant<TXp = Record<string, unknown>> {
  ID: string;
  Name?: string;
  Description?: string | null;
  Active?: boolean;
  Specs?: VariantSpec[];
  Inventory?: Inventory | null;
  xp?: TXp;
}

/**
 * Spec entry on a line item.
 * @public
 */
export interface LineItemSpec {
  SpecID: string;
  OptionID?: string;
  Value?: string;
}
