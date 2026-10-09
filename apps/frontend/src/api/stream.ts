// WebSocket client: reconnects from the last rendered seq, reports the display time (≤ 10 msgs/s) and watches
// heartbeats.
import type { StreamMessage } from '@pitwall/shared';
import { API_URL } from './client';

export interface StreamHandle {
  close(): void;
  setDisplayTime(t: number): void;
  readonly connected: boolean;
}

export function openStream(runId: string, onMessage: (m: StreamMessage) => void, onStatus?: (s: 'open' | 'closed' | 'stale') => void): StreamHandle {
  const wsBase = API_URL.replace(/^http/, 'ws');
  let ws: WebSocket | null = null;
  let lastSeq = -1;
  let closed = false;
  let connected = false;
  let lastBeat = Date.now();
  let lastSentDisplay = 0;
  let pendingDisplay: number | null = null;
  let retry = 0;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`${wsBase}/runs/${runId}/stream?fromSeq=${lastSeq + 1}`);
    ws.onopen = () => {
      connected = true;
      retry = 0;
      onStatus?.('open');
      if (pendingDisplay !== null) sendDisplay(pendingDisplay, true);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string) as StreamMessage;
      lastBeat = Date.now();
      if (m.type === 'heartbeat') return;
      if (m.seq <= lastSeq) return; // never apply a message twice
      lastSeq = m.seq;
      onMessage(m);
    };
    ws.onclose = () => {
      connected = false;
      onStatus?.('closed');
      if (!closed) setTimeout(connect, Math.min(5000, 250 * 2 ** retry++));
    };
  };

  const sendDisplay = (t: number, force = false) => {
    pendingDisplay = t;
    const now = Date.now();
    if (!force && now - lastSentDisplay < 100) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'display', raceTime_s: t }));
      lastSentDisplay = now;
    }
  };

  const watchdog = setInterval(() => {
    if (connected && Date.now() - lastBeat > 6000) {
      onStatus?.('stale');
      ws?.close();
    }
  }, 2000);

  connect();
  return {
    close() {
      closed = true;
      clearInterval(watchdog);
      ws?.close();
    },
    setDisplayTime: (t: number) => sendDisplay(t),
    get connected() {
      return connected;
    },
  };
}
