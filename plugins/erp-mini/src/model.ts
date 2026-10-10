export type Currency = 'USD' | 'EUR' | 'GBP' | 'VND' | 'JPY';
export const MINOR_UNITS: Record<Currency, number> = { USD: 2, EUR: 2, GBP: 2, VND: 0, JPY: 0 };
export const MAX_PRICE_MINOR = 1_000_000_000_000;
export const PAGE_SIZE = 25;
export const MAX_LINES = 50;
export const MAX_CONTACTS = 10;

export interface Metadata {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}
export interface Contact { name: string; email: string; phone: string }
export interface Customer extends Metadata {
  code: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  contacts: Contact[];
  active: boolean;
}
export interface Item extends Metadata {
  code: string;
  name: string;
  unit: string;
  priceMinor: number;
  currency: Currency;
  active: boolean;
}
export interface SaleLine {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  quantity: number;
  priceMinor: number;
  totalMinor: number;
}
export interface SaleOrder {
  id: string;
  number: string;
  status: 'open' | 'fulfilled' | 'cancelled';
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}
export interface Sale extends Metadata {
  number: string;
  reference: string;
  currency: Currency;
  customer: { id: string; name: string; email: string; phone: string; address: string; contact?: Contact };
  lines: SaleLine[];
  totalMinor: number;
  validUntil: string;
  notes: string;
  status: 'draft' | 'submitted' | 'accepted' | 'converted' | 'cancelled';
  hasOrder: boolean;
  order: SaleOrder | null;
  submittedAt?: string;
  acceptedAt?: string;
  cancelledAt?: string;
}
export interface RecordView<T> { id: string; revision: string; value: T }
export interface ListEntry<T> { id: string; value: T }
export interface ListPage<T> { items: ListEntry<T>[]; cursor?: string; hasMore: boolean }
export type Entity = 'customers' | 'items' | 'quotes' | 'orders';
export type Action = 'submit' | 'accept' | 'convert' | 'cancel-quote' | 'fulfill-order' | 'cancel-order';
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
export interface Info { version: '0.1.0'; currency: Currency; minorUnits: number; pageSize: 25; maxLines: 50; maxContacts: 10 }
export interface CustomerInput extends Contact { id: string; revision: string | null; code: string; address: string; contacts: Contact[]; active: boolean }
export interface ItemInput { id: string; revision: string | null; code: string; name: string; unit: string; priceMinor: number; active: boolean }
export interface QuoteInput { id: string; revision: string | null; reference: string; customerId: string; contactIndex?: number; lines: { itemId: string; quantity: number }[]; validUntil: string; notes: string }
export interface TransitionInput { id: string; revision: string; action: Action }
export interface ListInput { entity: Entity; cursor?: string; search?: string; active?: boolean }
export interface GetInput { entity: Entity; id: string }
