/* ============================================================================
 *  LogicPals Admin Bootstrap
 *  Path:        public/admin/_shared/bootstrap.js
 *  Version:     bootstrap_v1.0.0 (2026.04.19)
 *
 *  Purpose:     The SEAM for future admin extraction. This is the ONE file
 *               that needs to change when admin moves to its own Vercel
 *               project. Everything that is "admin-environment-specific"
 *               (tenant ID, default workspace, environment key, gateway
 *               base URL) lives here.
 *
 *               When admin is its own project, this file's values change.
 *               No other admin code needs to touch.
 *
 *  Load order:  This script must load BEFORE lp-admin-client.js.
 *               Both go in <head>:
 *                 <script src="/admin/_shared/bootstrap.js"></script>
 *                 <script src="/admin/_shared/lp-admin-client.js"></script>
 *
 *  Why this matters:
 *    Today: LogicPals admin lives in the same Vercel project as student-
 *           facing surfaces. Tenant is hardcoded as logicpals.
 *
 *    Future: Admin extracts to its own Vercel project (logicpals-admin.
 *            vercel.app). Cross-origin requests need explicit base URL.
 *            Multi-tenant means tenant_uuid changes per-installation.
 *
 *    The seam: change THIS file → admin behavior changes. No other code
 *              touches.
 * ============================================================================ */

(function (global) {
  'use strict';

  global.LPAdmin = global.LPAdmin || {};

  if (global.LPAdmin.__bootstrap_v1_mounted) return;
  global.LPAdmin.__bootstrap_v1_mounted = true;

  /* --------------------------------------------------------------------------
   *  CONFIG VALUES
   *
   *  These are the admin-environment specific values. When extracting admin
   *  to its own Vercel project, only these values change.
   * -------------------------------------------------------------------------- */

  global.LPAdmin.config = {
    /* The tenant UUID. Captured from `SELECT id FROM ops_core.tenants WHERE
     * slug='logicpals'` after running 04_path_c_tenant_uuid.sql.
     *
     * IMPORTANT: This MUST be replaced with the actual UUID from your
     * Supabase tenants table after running the migration. The placeholder
     * below will cause every command to fail with `unknown_tenant`.
     *
     * To get the value:
     *   SELECT id FROM ops_core.tenants WHERE slug='logicpals';
     *
     * Then paste the returned UUID below. */
    tenantUuid: '67c0ebf5-7f52-4d69-ba89-1a1b7baf14be',

    /* Default workspace within the tenant. LogicPals only has one workspace
     * for now ('primary'); if you ever add staging/dev environments as
     * separate workspaces, this changes per-installation. */
    workspaceKey: 'primary',

    /* Environment. Production by default. If admin runs against staging,
     * this changes. */
    environmentKey: 'production',

    /* API base URL. Same-origin today (admin and student app share a
     * Vercel project). When admin extracts:
     *   apiBaseUrl: 'https://logicpals.com'  (from logicpals-admin.vercel.app)
     * with CORS configured on the gateway accordingly. */
    apiBaseUrl: '',  // empty = same-origin

    /* Tenant slug. Human-friendly identifier, used in UI labels. Don't use
     * this in API calls — those use tenantUuid. */
    tenantSlug: 'logicpals',

    /* Tenant display name. UI string only. */
    tenantDisplayName: 'LogicPals',

    /* Operational hint: which environment is this admin instance running
     * against? Useful for visual cues like a red banner when in production
     * vs gray banner in staging. */
    deploymentLabel: 'production'
  };

  /* --------------------------------------------------------------------------
   *  VALIDATION
   *
   *  Surface common misconfigurations early with a console error so you
   *  notice them in dev.
   * -------------------------------------------------------------------------- */

  function validateConfig() {
    const cfg = global.LPAdmin.config;
    const issues = [];

    if (!cfg.tenantUuid || cfg.tenantUuid === 'REPLACE_ME_AFTER_MIGRATION') {
      issues.push('LPAdmin.config.tenantUuid is not set. Run the migration and paste your tenant UUID into bootstrap.js.');
    } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cfg.tenantUuid)) {
      issues.push(`LPAdmin.config.tenantUuid does not look like a UUID: ${cfg.tenantUuid}`);
    }

    if (!cfg.workspaceKey) issues.push('LPAdmin.config.workspaceKey missing');
    if (!cfg.environmentKey) issues.push('LPAdmin.config.environmentKey missing');

    if (issues.length > 0) {
      console.error('[LPAdmin Bootstrap] Configuration issues detected:');
      for (const issue of issues) console.error('  - ' + issue);
      console.error('  → Edit /admin/_shared/bootstrap.js to fix.');
    }

    return issues.length === 0;
  }

  global.LPAdmin.validateConfig = validateConfig;

  /* --------------------------------------------------------------------------
   *  HELPERS — used by lp-admin-client.js to build URLs
   * -------------------------------------------------------------------------- */

  global.LPAdmin.url = function (path) {
    const base = global.LPAdmin.config.apiBaseUrl || '';
    if (base.endsWith('/') && path.startsWith('/')) {
      return base + path.slice(1);
    }
    if (!base.endsWith('/') && !path.startsWith('/') && base.length > 0) {
      return base + '/' + path;
    }
    return base + path;
  };

  /* --------------------------------------------------------------------------
   *  Diagnostic banner
   * -------------------------------------------------------------------------- */

  try {
    const cfg = global.LPAdmin.config;
    if (global.location && /admin/i.test(global.location.pathname)) {
      console.log(
        '%c[LPAdmin Bootstrap]%c tenant=%s env=%s ' + (cfg.apiBaseUrl ? 'api=' + cfg.apiBaseUrl : 'api=same-origin'),
        'color: #06b6d4; font-weight: bold;',
        'color: inherit;',
        cfg.tenantSlug,
        cfg.environmentKey
      );
      validateConfig();
    }
  } catch (_) { /* SSR / non-browser */ }

})(typeof window !== 'undefined' ? window : globalThis);
