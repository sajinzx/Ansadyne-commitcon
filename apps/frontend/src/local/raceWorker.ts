// Web Worker: one live race (three paired worlds) for the static web build. Same RaceSession as the server.
import { RaceSession, type ToSession } from '@pitwall/engine';

const ctx = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<ToSession>) => void) | null };

// a macrotask tick that is not clamped like setTimeout(0): lets incoming messages in between steps
const channel = new MessageChannel();
let waiting: (() => void)[] = [];
channel.port1.onmessage = () => {
  const w = waiting;
  waiting = [];
  for (const f of w) f();
};
const yieldNow = () =>
  new Promise<void>((res) => {
    waiting.push(res);
    channel.port2.postMessage(0);
  });

const session = new RaceSession((m) => ctx.postMessage(m), yieldNow);
ctx.onmessage = (e) => session.handle(e.data);
