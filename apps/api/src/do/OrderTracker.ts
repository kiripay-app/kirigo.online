import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

interface Point { lat: number; lng: number; at: number; acc?: number }

/**
 * One per order (child return/correction trips share their parent's). Receives the driver's GPS, pushes it
 * live to the customer's and shop's screens, and writes the whole route to D1 once when tracking ends —
 * one database write per trip instead of one per point, which keeps Cloudflare costs low.
 */
export class OrderTracker extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const op = url.pathname.slice(1);

    if (op === 'last') {
      const last = await this.ctx.storage.get<{ orderId: string; point: Point }>('last');
      return Response.json(last ?? null);
    }

    if (op === 'socket') {
      const who = url.searchParams.get('who') ?? 'viewer';
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [who]);
      const last = await this.ctx.storage.get<{ orderId: string; point: Point }>('last');
      if (last) pair[1].send(JSON.stringify({ type: 'position', ...last }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const b = await req.json<any>().catch(() => ({}));

    if (op === 'gps') {
      const key = `route:${b.orderId}`;
      const route = (await this.ctx.storage.get<Point[]>(key)) ?? [];
      const pts: Point[] = (b.points as Point[]).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)).sort((a, z) => a.at - z.at);
      route.push(...pts);
      await this.ctx.storage.put(key, route.slice(-5000));
      const last = pts.at(-1);
      if (last) {
        await this.ctx.storage.put('last', { orderId: b.orderId, point: last });
        this.broadcast({ type: 'position', orderId: b.orderId, point: last });
      }
      return Response.json({ ok: true });
    }

    if (op === 'broadcast') {
      this.broadcast(b);
      return Response.json({ ok: true });
    }

    if (op === 'finish') {
      const key = `route:${b.orderId}`;
      const route = (await this.ctx.storage.get<Point[]>(key)) ?? [];
      await this.env.DB.prepare('INSERT INTO order_routes (order_id, points_json) VALUES (?,?) ON CONFLICT(order_id) DO UPDATE SET points_json=excluded.points_json')
        .bind(b.orderId, JSON.stringify(route)).run();
      await this.ctx.storage.delete(key);
      await this.ctx.storage.delete('last');
      this.broadcast({ type: 'tracking_ended', orderId: b.orderId });
      return Response.json({ ok: true, points: route.length });
    }

    return new Response('not found', { status: 404 });
  }

  private broadcast(msg: unknown) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch { /* closed */ }
    }
  }

  async webSocketMessage() { /* viewers only listen */ }
}
