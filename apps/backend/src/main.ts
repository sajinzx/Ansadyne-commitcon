import { buildServer } from './server';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const { app } = await buildServer({
  logger: true,
  dataDir: process.env.PITWALL_DATA_DIR,
  frozenSettingsHash: process.env.PITWALL_FROZEN_SETTINGS,
  benchDurationHours: process.env.PITWALL_BENCH_HOURS ? (Number(process.env.PITWALL_BENCH_HOURS) as 1 | 3 | 6) : undefined,
});
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await app.listen({ port, host });
