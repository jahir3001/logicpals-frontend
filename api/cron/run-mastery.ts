import { createClient } from '@supabase/supabase-js';
import { runMasteryWorkerOnce } from '../../worker/mastery/logic';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const config = {
  runtime: 'nodejs',
};

export default async function handler(req: Request): Promise<Response> {
  try {
    // Safety: only allow cron / internal calls
    const auth = req.headers.get('authorization');
    if (!auth || auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const result = await runMasteryWorkerOnce(supabase);

    return new Response(
      JSON.stringify({
        status: 'ok',
        processed: result.processed,
      }),
      { status: 200 }
    );
  } catch (err: any) {
    console.error('[mastery-cron-error]', err);
    return new Response('Internal error', { status: 500 });
  }
}
