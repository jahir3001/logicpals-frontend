export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

  // These two are PUBLIC (safe to expose). Do NOT put service_role here.
  const payload = { SUPABASE_URL, SUPABASE_ANON_KEY };

  res.status(200).send(`window.__LP_ENV = ${JSON.stringify(payload)};`);
}
