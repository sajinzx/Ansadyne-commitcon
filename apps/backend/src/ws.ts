// WS /api/v1/runs/:runId/stream — replay from fromSeq without gaps or duplicates, then live; heartbeats every
// 2 s (not stored; they carry the latest seq); client pacing messages set the run's display time.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { StreamMessage, StreamType } from '@pitwall/shared';
import type { RunManager } from './runs/RunManager';

export function registerStream(app: FastifyInstance, runs: RunManager, heartbeatMs = 2000): void {
  app.get<{ Params: { runId: string }; Querystring: { fromSeq?: string } }>('/api/v1/runs/:runId/stream', { websocket: true }, (socket, req) => {
    const { runId } = req.params;
    let store;
    try {
      store = runs.store(runId);
    } catch {
      socket.close(4404, 'unknown run');
      return;
    }
    const clientId = randomUUID();
    const fromSeq = Math.max(0, Number(req.query.fromSeq ?? 0) || 0);
    let lastSent = fromSeq - 1;
    const send = (m: StreamMessage) => {
      if (m.seq <= lastSent) return;
      lastSent = m.seq;
      socket.send(JSON.stringify(m));
    };
    // replay synchronously, then subscribe: no message can be appended in between (single thread)
    for (const m of store.query(fromSeq).events) send(m);
    const unsubscribe = store.subscribe(send);
    const hb = setInterval(() => {
      const m: StreamMessage = { v: 1, runId, seq: store.lastSeq, type: 'heartbeat' as StreamType, payload: { serverTime: Date.now() } };
      socket.send(JSON.stringify(m));
    }, heartbeatMs);
    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; raceTime_s?: number };
        if (msg.type === 'display' && typeof msg.raceTime_s === 'number') runs.setDisplay(runId, clientId, msg.raceTime_s);
        else if (msg.type === 'ping') socket.send(JSON.stringify({ v: 1, runId, seq: store.lastSeq, type: 'heartbeat', payload: { serverTime: Date.now() } }));
      } catch {
        /* ignore malformed client messages */
      }
    });
    socket.on('close', () => {
      clearInterval(hb);
      unsubscribe();
      runs.setDisplay(runId, clientId, null);
    });
  });
}
