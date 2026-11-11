import { DurableObject } from 'cloudflare:workers';
import { haversine } from '@kirigo/shared';
import type { Env } from '../env';

interface Pos { driverId: string; lat: number; lng: number; at: number; prevLat?: number; prevLng?: number }

const STALE_MS = 3 * 60_000; // a driver who hasn't reported for 3 minutes isn't offered jobs

/**
 * Who is online right now and where. One instance for South Tarawa. Kept in memory (and in the DO's
 * storage so a restart doesn't forget who is online). Drivers' sockets get offers pushed instantly.
 */
export class DriverPresence extends DurableObject<Env> {
  private online = new Map<string, Pos>();
  private loaded = false;

  private async load() {
    if (this.loaded) return;
    const saved = await this.ctx.storage.get<Pos[]>('online');
    for (const p of saved ?? []) this.online.set(p.driverId, p);
    this.loaded = true;
  }

  private save() {
    return this.ctx.storage.put('online', [...this.online.values()]);
  }

  async fetch(req: Request): Promise<Response> {
    await this.load();
    const url = new URL(req.url);
    const op = url.pathname.slice(1);

    if (op === 'socket') {
      const driverId = url.searchParams.get('driver') ?? '';
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [driverId]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (op === 'near') {
      const at = { lat: Number(url.searchParams.get('lat')), lng: Number(url.searchParams.get('lng')) };
      const km = Number(url.searchParams.get('km') ?? 3);
      const now = Date.now();
      const out = [...this.online.values()].filter((p) => now - p.at < STALE_MS && haversine(p, at) <= km * 1000);
      return Response.json(out);
    }

    const b = req.method === 'POST' ? await req.json<any>() : {};
    if (op === 'online' || op === 'position') {
      if (op === 'position' && !this.online.has(b.driverId)) return Response.json({ ok: false, offline: true });
      const prev = this.online.get(b.driverId);
      this.online.set(b.driverId, { driverId: b.driverId, lat: b.lat, lng: b.lng, at: Date.now(), prevLat: prev?.lat, prevLng: prev?.lng });
      if (op === 'online') await this.save();
      return Response.json({ ok: true });
    }
    if (op === 'offline') {
      this.online.delete(b.driverId);
      await this.save();
      return Response.json({ ok: true });
    }
    if (op === 'push') {
      for (const ws of this.ctx.getWebSockets(b.driverId)) {
        try { ws.send(JSON.stringify(b.msg)); } catch { /* closed */ }
      }
      return Response.json({ ok: true });
    }
    if (op === 'one') {
      const p = this.online.get(url.searchParams.get('driver') ?? '');
      return Response.json(p ? { ...p, staleAfterMs: STALE_MS } : null);
    }
    if (op === 'all') return Response.json([...this.online.values()]);
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    // drivers may send {lat,lng} over the socket instead of POST /driver/position
    try {
      const [driverId] = this.ctx.getTags(ws);
      const m = JSON.parse(typeof msg === 'string' ? msg : new TextDecoder().decode(msg));
      if (driverId && typeof m.lat === 'number' && typeof m.lng === 'number' && this.online.has(driverId)) {
        const prev = this.online.get(driverId)!;
        this.online.set(driverId, { driverId, lat: m.lat, lng: m.lng, at: Date.now(), prevLat: prev.lat, prevLng: prev.lng });
      }
    } catch { /* ignore */ }
  }
}
