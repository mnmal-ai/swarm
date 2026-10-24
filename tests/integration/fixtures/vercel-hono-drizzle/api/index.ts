// Vercel serverless entry. Exports a Hono app as the default handler so the
// `api/` convention and the Hono dependency both register with the detector.
// Kept import-only: nothing here runs during static fingerprinting.
import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => c.json({ ok: true }));

export default app;
