// Append-only per-run message log; serves GET /events and WS replay (optionally mirrored to JSONL).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StreamMessage, StreamType } from '@pitwall/shared';

export type Listener = (m: StreamMessage) => void;

export class EventStore {
  private readonly log: StreamMessage[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly file: string | null;

  constructor(
    readonly runId: string,
    dataDir?: string,
  ) {
    if (dataDir) {
      mkdirSync(join(dataDir, 'runs'), { recursive: true });
      this.file = join(dataDir, 'runs', `${runId}.jsonl`);
    } else this.file = null;
  }

  get lastSeq(): number {
    return this.log.length - 1;
  }

  append(type: StreamType, payload: unknown): StreamMessage {
    const m: StreamMessage = { v: 1, runId: this.runId, seq: this.log.length, type, payload };
    this.log.push(m);
    if (this.file) appendFileSync(this.file, JSON.stringify(m) + '\n');
    for (const l of this.listeners) l(m);
    return m;
  }

  query(fromSeq = 0, types?: StreamType[], limit = 10_000): { events: StreamMessage[]; nextSeq: number } {
    const out: StreamMessage[] = [];
    let i = Math.max(0, fromSeq);
    for (; i < this.log.length && out.length < limit; i++) {
      const m = this.log[i];
      if (!types || types.includes(m.type)) out.push(m);
    }
    return { events: out, nextSeq: i };
  }

  all(type?: StreamType): StreamMessage[] {
    return type ? this.log.filter((m) => m.type === type) : [...this.log];
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
