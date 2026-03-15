/**
 * api/admin/assign-role.js — Admin Role Change API
 * ─────────────────────────────────────────────────────────────
 * Phase 0B · Admin Role Change with Slack Alerting
 *
 * 1. Verifies caller is super_admin via their JWT
 * 2. Looks up target user by email
 * 3. Gets current role
 * 4. Updates role
 * 5. Fires admin_role_change Slack alert (server-side, secure)
 *
 * ENDPOINT: POST /api/admin/assign-role
 * AUTH:     Bearer JWT (must be super_admin)
 * BODY:     { target_email, new_role, reason? }
 * ─────────────────────────────────────────────────────────────
 */

const { createClient } = require('@supabase/supabase-js');

const VALID_ROLES = [
  'super_admin',
  'admin_regular',
  'admin_olympiad',
  'support_readonly',
  'reviewer',
  'no_role',
];

function getBearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

module.exports = async (req, res) => {
  // ── Method check ───────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // ── Auth check ─────────────────────────────────────────
  const jwt = getBearer(req);
  if (!jwt) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  // Client with caller's JWT (for role verification)
  const callerSb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, storageKey: 'logicpals.auth' },
  });

  // Service client (for role updates — bypasses RLS)
  const serviceSb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, storageKey: 'logicpals.auth' },
  });

  // ── Verify caller is super_admin ───────────────────────
  const { data: { user }, error: authErr } = await callerSb.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'invalid_token', details: authErr?.message });
  }

  // Get caller's role
  let callerRole = 'no_role';
  try {
    const { data } = await callerSb.rpc('rpc_lp_my_role');
    callerRole = data || 'no_role';
  } catch (_) {
    // Try alternative RPC names
    const candidates = ['get_my_role', 'rp_get_my_role'];
    for (const fn of candidates) {
      try {
        const { data, error } = await callerSb.rpc(fn);
        if (!error && data) { callerRole = typeof data === 'string' ? data : 'no_role'; break; }
      } catch (_e) {}
    }
  }

  if (callerRole !== 'super_admin') {
    return res.status(403).json({
      error: 'super_admin_required',
      your_role: callerRole,
    });
  }

  // ── Parse body ─────────────────────────────────────────
  const { target_email, new_role, reason } = req.body || {};

  if (!target_email || !new_role) {
    return res.status(400).json({ error: 'missing_fields', required: ['target_email', 'new_role'] });
  }

  if (!VALID_ROLES.includes(new_role)) {
    return res.status(400).json({ error: 'invalid_role', valid_roles: VALID_ROLES });
  }

  // ── Look up target user ────────────────────────────────
  const { data: targetUsers, error: lookupErr } = await serviceSb
    .from('profiles')
    .select('id, email, full_name')
    .eq('email', target_email.trim().toLowerCase())
    .limit(1);

  if (lookupErr) {
    return res.status(500).json({ error: 'user_lookup_failed', details: lookupErr.message });
  }

  if (!targetUsers || targetUsers.length === 0) {
    return res.status(404).json({ error: 'user_not_found', email: target_email });
  }

  const targetUser = targetUsers[0];

  // ── Get current role ───────────────────────────────────
  let oldRole = 'no_role';
  const { data: existingRole } = await serviceSb
    .from('user_roles')
    .select('role')
    .eq('user_id', targetUser.id)
    .limit(1)
    .single();

  if (existingRole) {
    oldRole = existingRole.role;
  }

  // Don't update if same role
  if (oldRole === new_role) {
    return res.status(200).json({
      ok: true,
      changed: false,
      message: `User already has role: ${new_role}`,
      target_email,
      old_role: oldRole,
      new_role,
    });
  }

  // ── Perform role change ────────────────────────────────
  const { error: upsertErr } = await serviceSb
    .from('user_roles')
    .upsert({
      user_id: targetUser.id,
      role: new_role,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    }, { onConflict: 'user_id' });

  if (upsertErr) {
    return res.status(500).json({ error: 'role_update_failed', details: upsertErr.message });
  }

  // ── Write audit log ────────────────────────────────────
  try {
    await serviceSb.from('audit_log').insert({
      user_id: user.id,
      action: 'admin_role_change',
      metadata: {
        changed_by: user.email,
        target_user: target_email,
        target_user_id: targetUser.id,
        old_role: oldRole,
        new_role: new_role,
        reason: reason || null,
      },
    });
  } catch (_) {
    // Non-fatal — audit write failure shouldn't block the role change
    console.warn('[assign-role] Audit log write failed');
  }

  // ── Fire Slack alert (server-side, secure) ─────────────
  try {
    const { recordAdminRoleChange } = await import('../../backend/alerts/monitoring.js');
    await recordAdminRoleChange({
      changed_by:  user.email || user.id,
      target_user: target_email,
      old_role:    oldRole,
      new_role:    new_role,
      reason:      reason || null,
    });
  } catch (err) {
    // Non-fatal — Slack failure shouldn't block the role change
    console.warn('[assign-role] Slack alert failed:', err.message);
  }

  // ── Return success ─────────────────────────────────────
  return res.status(200).json({
    ok: true,
    changed: true,
    target_email,
    target_name: targetUser.full_name || null,
    old_role: oldRole,
    new_role: new_role,
    changed_by: user.email,
    reason: reason || null,
  });
};
