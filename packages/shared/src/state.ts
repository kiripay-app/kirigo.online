import type { OrderStatus } from './types';

/**
 * The only allowed order status transitions. Every transition must also write one
 * row to `order_events` (append-only).
 */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PAID_HELD: ['DRIVER_ASSIGNED', 'CANCELLED'],
  // back to PAID_HELD = driver dropped the job before pickup; customer re-picks
  DRIVER_ASSIGNED: ['AT_SHOP', 'PAID_HELD', 'CANCELLED'],
  AT_SHOP: ['PICKED_UP', 'PAID_HELD', 'CANCELLED'],
  PICKED_UP: ['ARRIVED'],
  ARRIVED: ['HANDED_OVER', 'NOT_DELIVERED'],
  HANDED_OVER: ['ACCEPTED', 'PROBLEM_REPORTED'],
  // keep / ruled for shop → ACCEPTED; refund → REFUNDED. Return/swap/correction run as child orders.
  PROBLEM_REPORTED: ['ACCEPTED', 'REFUNDED'],
  ACCEPTED: [],
  REFUNDED: [],
  NOT_DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(public from: OrderStatus, public to: OrderStatus) {
    super(`Invalid order transition ${from} → ${to}`);
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(s: OrderStatus): boolean {
  return TRANSITIONS[s].length === 0;
}

/** Statuses before pickup: cancelling gives a full refund. */
export const PRE_PICKUP: readonly OrderStatus[] = ['PAID_HELD', 'DRIVER_ASSIGNED', 'AT_SHOP'];

/** Statuses where the driver's GPS is tracked. */
export const TRACKED: readonly OrderStatus[] = ['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED'];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PAID_HELD: 'Paid, held by KiriPay',
  DRIVER_ASSIGNED: 'Driver on the way to the shop',
  AT_SHOP: 'Driver at the shop',
  PICKED_UP: 'On the way to you',
  ARRIVED: 'Driver has arrived',
  HANDED_OVER: 'Delivered, please check your order',
  ACCEPTED: 'Completed',
  PROBLEM_REPORTED: 'Problem reported',
  REFUNDED: 'Refunded',
  NOT_DELIVERED: 'Not delivered',
  CANCELLED: 'Cancelled',
};
