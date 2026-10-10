// Web Worker: calibrated models per circuit for the Track tab (geometry payload and surface previews). Building a
// model takes 2–4 s, so it never runs on the page's thread; each circuit is built once.
import { defaultConfigs, defaultRunConfig } from '@pitwall/shared';
import { buildModel, trackPreview, type ModelBundle, type TrackPreviewRequest } from '@pitwall/engine';

export type ToolsCall = { op: 'track'; trackId: string } | { op: 'preview'; body: TrackPreviewRequest & { trackId?: string } };
export type ToolsRequest = ToolsCall & { id: number };

const ctx = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<ToolsRequest>) => void) | null };
const models = new Map<string, ModelBundle>();
const model = (trackId = 'daytona') => {
  let m = models.get(trackId);
  if (!m) {
    m = buildModel(defaultConfigs(), defaultRunConfig({ trackId }));
    models.set(trackId, m);
  }
  return m;
};

ctx.onmessage = (e) => {
  const r = e.data;
  try {
    const result = r.op === 'track' ? model(r.trackId).geo.payload() : trackPreview(model(r.body.trackId), r.body);
    ctx.postMessage({ id: r.id, ok: true, result });
  } catch (err) {
    ctx.postMessage({ id: r.id, ok: false, detail: String((err as Error).message ?? err) });
  }
};
