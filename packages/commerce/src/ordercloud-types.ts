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
  Facets?: ListFacet[];
}

/**
 * OrderCloud facet value.
 * @public
 */
export interface ListFacetValue {
  Value: string;
  Count: number;
}

/**
 * OrderCloud list facet.
 * @public
 */
export interface ListFacet {
  Name: string;
  XpPath: string;
  Values: ListFacetValue[];
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

/**
 * OrderCloud address.
 * @public
 */
export interface Address<TXp = Record<string, unknown>> {
  ID?: string | null;
  FirstName?: string | null;
  LastName?: string | null;
  Street1?: string | null;
  Street2?: string | null;
  City?: string | null;
  State?: string | null;
  Zip?: string | null;
  Country?: string | null;
  Phone?: string | null;
  xp?: TXp;
}

/**
 * Direction of an OrderCloud order.
 * @public
 */
export type OrderDirection = 'Incoming' | 'Outgoing';

/**
 * Status of an OrderCloud order.
 * @public
 */
export type OrderStatus =
  | 'Unsubmitted'
  | 'AwaitingApproval'
  | 'Declined'
  | 'Open'
  | 'Completed'
  | 'Canceled';

/**
 * Product snapshot stored on an OrderCloud line item.
 * @public
 */
export interface LineItemProduct<TXp = Record<string, unknown>> {
  ID: string;
  Name?: string;
  Description?: string | null;
  PriceSchedule?: PriceSchedule | null;
  xp?: TXp;
}

/**
 * Variant snapshot stored on an OrderCloud line item.
 * @public
 */
export interface LineItemVariant<TXp = Record<string, unknown>> {
  ID: string;
  Name?: string;
  Specs?: VariantSpec[];
  xp?: TXp;
}

/**
 * OrderCloud cart or order line item.
 * @public
 */
export interface LineItem<
  TXp = Record<string, unknown>,
  TProductXp = Record<string, unknown>,
  TVariantXp = Record<string, unknown>
> {
  ID: string;
  ProductID: string;
  Quantity: number;
  LineTotal?: number;
  UnitPrice?: number;
  Product?: LineItemProduct<TProductXp>;
  Variant?: LineItemVariant<TVariantXp> | null;
  VariantID?: string | null;
  Specs?: LineItemSpec[];
  xp?: TXp;
}

/**
 * OrderCloud buyer order, including the current unsubmitted cart.
 * `ID` is null when the shopper has no active cart.
 * @public
 */
export interface Order<TXp = Record<string, unknown>> {
  ID: string | null;
  FromUserID?: string;
  BuyerID?: string;
  SupplierID?: string | null;
  Currency?: string | null;
  Direction?: OrderDirection;
  Status?: OrderStatus;
  Comments?: string | null;
  Subtotal?: number;
  ShippingCost?: number;
  TaxCost?: number;
  Total?: number;
  IsSubmitted?: boolean;
  DateCreated?: string;
  DateSubmitted?: string | null;
  BillingAddress?: Address | null;
  ShippingAddress?: Address | null;
  xp?: TXp;
}
