/* ============================================================================
 *  LogicPals Admin Client — Shared Library
 *  Path:        public/admin/_shared/lp-admin-client.js
 *  Version:     lp_admin_client_v1.1.0 (Path C — 2026.04.19)
 *
 *  Path C tweaks:
 *    1. Tenant addressed by UUID (LPAdmin.config.tenantUuid)
 *    2. No hardcoded 'logicpals' anywhere
 *    3. Uses LPAdmin.url() for cross-origin readiness
 *    4. All endpoints/tenant/workspace/environment from bootstrap config
 *
 *  Depends on:
 *    - bootstrap.js MUST load before this file
 *    - admin-auth.js (for getClient() — fallbacks work without it)
 *
 *  Usage:
 *    <script src="/admin/_shared/bootstrap.js"></script>
 *    <script src="/admin/_shared/lp-admin-client.js"></script>
 *    ...
 *    await LPAdmin.breaker.forceOpen(ruleKey, reason);
 * ============================================================================ */

(function (global) {
  'use strict';

  global.LPAdmin = global.LPAdmin || {};
  const LPAdmin = global.LPAdmin;

  if (LPAdmin.__client_v1_mounted) return;
  LPAdmin.__client_v1_mounted = true;
  LPAdmin.__client_version = 'lp_admin_client_v1.1.0';

  /* ─── Config access ─── */

  function requireConfig() {
    if (!LPAdmin.config || typeof LPAdmin.config !== 'object') {
      throw new Error(
        'LPAdmin.config not found. Did you load /admin/_shared/bootstrap.js BEFORE lp-admin-client.js?'
      );
    }
    if (!LPAdmin.config.tenantUuid || LPAdmin.config.tenantUuid === 'REPLACE_ME_AFTER_MIGRATION') {
      throw new Error(
        'LPAdmin.config.tenantUuid is not configured. Edit /admin/_shared/bootstrap.js with the value from: ' +
        "SELECT id FROM ops_core.tenants WHERE slug='logicpals';"
      );
    }
    return LPAdmin.config;
  }

  /* ─── Endpoints ─── */

  function endpoint(path) {
    return (LPAdmin.url || ((p) => p))(path);
  }

  const PATHS = {
    telemetry:  '/api/admin/telemetry',
    adminOps:   '/api/admin/telemetry',
    opsGateway: '/api/ops/ops-gateway',
    abAdminOps: '/api/ab/admin-ops'
  };

  LPAdmin.paths = PATHS;
  LPAdmin.endpoints = {
    get telemetry()  { return endpoint(PATHS.telemetry); },
    get adminOps()   { return endpoint(PATHS.adminOps); },
    get opsGateway() { return endpoint(PATHS.opsGateway); },
    get abAdminOps() { return endpoint(PATHS.abAdminOps); }
  };

  /* ─── Auth ─── */

  async function getAdminToken() {
    if (typeof LPAdmin.getClient === 'function') {
      try {
        const sb = await LPAdmin.getClient();
        const { data } = await sb.auth.getSession();
        if (data?.session?.access_token) return data.session.access_token;
      } catch (_) {}
    }
    if (global.supabaseClient || global.supabase) {
      try {
        const sb = global.supabaseClient || global.supabase;
        const { data } = await sb.auth.getSession();
        if (data?.session?.access_token) return data.session.access_token;
      } catch (_) {}
    }
    try {
      for (let i = 0; i < global.localStorage.length; i++) {
        const key = global.localStorage.key(i);
        if (key && key.startsWith('logicpals.auth')) {
          const raw = global.localStorage.getItem(key);
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw);
            const token = parsed?.access_token || parsed?.currentSession?.access_token;
            if (token) return token;
          } catch (_) {}
        }
      }
    } catch (_) {}
    return null;
  }
  LPAdmin.getAdminToken = getAdminToken;

  /* ─── Idempotency ─── */

  function newIdempotencyKey(prefix = 'lp') {
    if (global.crypto?.randomUUID) return `${prefix}-${global.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }
  LPAdmin.newIdempotencyKey = newIdempotencyKey;

  /* ─── Event bus ─── */

  const listeners = new Map();
  function on(eventName, handler) {
    if (!listeners.has(eventName)) listeners.set(eventName, new Set());
    listeners.get(eventName).add(handler);
    return () => off(eventName, handler);
  }
  function off(eventName, handler) { listeners.get(eventName)?.delete(handler); }
  function emit(eventName, payload) {
    const set = listeners.get(eventName);
    if (!set) return;
    for (const handler of set) {
      try { handler(payload); }
      catch (err) { console.error(`[LPAdmin] handler "${eventName}" threw:`, err); }
    }
  }
  LPAdmin.on = on; LPAdmin.off = off; LPAdmin.emit = emit;

  /* ─── Busy state ─── */

  let busyCount = 0;
  function setBusy(delta) {
    const wasBusy = busyCount > 0;
    busyCount = Math.max(0, busyCount + delta);
    const isBusyNow = busyCount > 0;
    if (!wasBusy && isBusyNow) emit('busy:on', { count: busyCount });
    if (wasBusy && !isBusyNow) emit('busy:off', { count: busyCount });
  }
  LPAdmin.isBusy = () => busyCount > 0;

  /* ─── Errors ─── */

  class LPAdminError extends Error {
    constructor({ message, status, code, details, raw }) {
      super(message || code || 'admin_request_failed');
      this.name = 'LPAdminError';
      this.status = status ?? null;
      this.code = code || null;
      this.details = details || null;
      this.raw = raw || null;
    }
  }
  LPAdmin.LPAdminError = LPAdminError;

  function normalizeError(res, json) {
    return new LPAdminError({
      message: json?.details || json?.error || `Request failed (${res.status})`,
      status: res.status,
      code: json?.error || (res.status === 401 ? 'auth_required'
                       : res.status === 403 ? 'admin_access_required'
                       : res.status === 404 ? 'not_found'
                       : 'request_failed'),
      details: json?.details || null,
      raw: json
    });
  }

  /* ─── Core fetch ─── */

  async function rawRequest({ method, url, body, headers: extraHeaders, includeAuth = true }) {
    const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    if (includeAuth) {
      const jwt = await getAdminToken();
      if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
    }
    let res;
    try {
      res = await fetch(url, {
        method, credentials: 'include', headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      throw new LPAdminError({
        message: err?.message || 'Network error',
        code: 'network_error', details: String(err)
      });
    }
    let json = null;
    try { json = await res.json(); } catch (_) {}
    if (res.status === 401) emit('auth:expired', { url });
    if (!res.ok || (json && json.ok === false)) throw normalizeError(res, json);
    return json;
  }

  /* ─── High-level API helpers ─── */

  LPAdmin.api = {
    async post(url, body) {
      const fullUrl = url.startsWith('http') ? url : endpoint(url);
      return rawRequest({ method: 'POST', url: fullUrl, body });
    },
    async get(url) {
      const fullUrl = url.startsWith('http') ? url : endpoint(url);
      return rawRequest({ method: 'GET', url: fullUrl });
    },
    async postAction(url, action, body = {}) {
      const fullUrl = url.startsWith('http') ? url : endpoint(url);
      return rawRequest({ method: 'POST', url: fullUrl, body: { action, ...body } });
    },
    async getType(url, type, extraQs = '') {
      const baseUrl = url.startsWith('http') ? url : endpoint(url);
      const sep = baseUrl.includes('?') ? '&' : '?';
      const fullUrl = `${baseUrl}${sep}type=${encodeURIComponent(type)}${extraQs ? '&' + extraQs : ''}`;
      return rawRequest({ method: 'GET', url: fullUrl });
    }
  };

  /* ─── Command layer (uses tenant_uuid from config) ─── */

  async function command(commandType, targetType, targetId, reason, options = {}) {
    const cfg = requireConfig();
    const idempotencyKey = options.idempotencyKey || newIdempotencyKey(commandType);

    const body = {
      command_type:    commandType,
      target_type:     targetType,
      target_id:       targetId,
      reason:          reason || null,
      payload:         options.payload || {},
      idempotency_key: idempotencyKey,
      tenant_uuid:     options.tenantUuid     || cfg.tenantUuid,
      workspace_key:   options.workspaceKey   || cfg.workspaceKey,
      environment_key: options.environmentKey || cfg.environmentKey
    };

    const url = endpoint(PATHS.opsGateway) + '?action=create_command';

    setBusy(+1);
    emit('command:started', { commandType, targetType, targetId, idempotencyKey });

    try {
      const json = await rawRequest({ method: 'POST', url, body });
      const inner = json?.result;

      if (inner && inner.ok === false) {
        const err = new LPAdminError({
          message: inner.message || inner.result_code || 'Command execution failed',
          status: 200,
          code: inner.result_code || 'command_failed',
          details: inner.error_data || inner.message,
          raw: json
        });
        emit('command:failed', { commandType, targetType, targetId, idempotencyKey, error: err });
        throw err;
      }

      emit('command:succeeded', {
        commandType, targetType, targetId, idempotencyKey,
        commandId: inner?.command_id, status: inner?.status, result: inner
      });
      return json;
    } catch (err) {
      if (err.name !== 'LPAdminError') {
        const wrapped = new LPAdminError({
          message: err?.message || 'Command request failed',
          code: 'command_request_failed', details: String(err), raw: err
        });
        emit('command:failed', { commandType, targetType, targetId, idempotencyKey, error: wrapped });
        throw wrapped;
      }
      if (err.code !== 'command_failed') {
        emit('command:failed', { commandType, targetType, targetId, idempotencyKey, error: err });
      }
      throw err;
    } finally {
      setBusy(-1);
    }
  }
  LPAdmin.command = command;

  /* ─── Convenience wrappers ─── */

  LPAdmin.breaker = {
    forceOpen(ruleKey, reason, options) {
      return command('breaker.force_open', 'breaker', ruleKey, reason, options);
    },
    forceClose(ruleKey, reason, options) {
      return command('breaker.force_close', 'breaker', ruleKey, reason, options);
    },
    resetOverride(ruleKey, reason, options) {
      return command('breaker.reset_override', 'breaker', ruleKey, reason, options);
    }
  };

  LPAdmin.incident = {
    acknowledge(incidentId, options) {
      return command('incident.acknowledge', 'incident', incidentId, null, options);
    },
    assign(incidentId, assigneeId, assigneeType = 'user', options = {}) {
      return command('incident.assign', 'incident', incidentId, null, {
        ...options,
        payload: { ...(options.payload || {}), assignee_id: assigneeId, assignee_type: assigneeType }
      });
    },
    resolve(incidentId, resolutionNote, options) {
      if (!resolutionNote || !resolutionNote.trim()) {
        throw new LPAdminError({
          message: 'Resolution note is required',
          code: 'missing_reason', status: 400
        });
      }
      return command('incident.resolve', 'incident', incidentId, resolutionNote, options);
    }
  };

  /* ─── Event gateway ─── */

  async function ingestEvent(eventName, sourceKey, options = {}) {
    const cfg = requireConfig();
    const body = {
      event_name:      eventName,
      source_key:      sourceKey,
      title:           options.title || null,
      summary:         options.summary || null,
      payload:         options.payload || {},
      severity_hint:   options.severityHint || null,
      correlation_key: options.correlationKey || null,
      dedupe_key:      options.dedupeKey || null,
      tags:            options.tags || [],
      tenant_uuid:     options.tenantUuid     || cfg.tenantUuid,
      workspace_key:   options.workspaceKey   || cfg.workspaceKey,
      environment_key: options.environmentKey || cfg.environmentKey
    };
    const url = endpoint(PATHS.opsGateway) + '?action=ingest_event';
    return rawRequest({ method: 'POST', url, body });
  }
  LPAdmin.ingestEvent = ingestEvent;

  /* ─── Incident reads ─── */

  LPAdmin.incidents = {
    async list(params = {}) {
      const cfg = requireConfig();
      const qs = new URLSearchParams();
      if (Array.isArray(params.lifecycleStatus) && params.lifecycleStatus.length) {
        qs.set('lifecycle_status', params.lifecycleStatus.join(','));
      }
      if (Array.isArray(params.severity) && params.severity.length) {
        qs.set('severity', params.severity.join(','));
      }
      if (params.search) qs.set('search', params.search);
      if (params.limit)  qs.set('limit', String(params.limit));
      if (params.offset) qs.set('offset', String(params.offset));
      qs.set('tenant_uuid', params.tenantUuid || cfg.tenantUuid);
      qs.set('environment_key', params.environmentKey || cfg.environmentKey);
      const url = endpoint(PATHS.opsGateway) + '?action=list_incidents&' + qs.toString();
      return rawRequest({ method: 'GET', url });
    },
    async get(incidentId) {
      const url = endpoint(PATHS.opsGateway) + '?action=get_incident&incident_id=' + encodeURIComponent(incidentId);
      return rawRequest({ method: 'GET', url });
    },
    async timeline(incidentId, limit = 100) {
      const url = endpoint(PATHS.opsGateway) +
                  '?action=get_timeline&incident_id=' + encodeURIComponent(incidentId) +
                  '&limit=' + limit;
      return rawRequest({ method: 'GET', url });
    }
  };

  LPAdmin.commands = {
    async get(commandId) {
      const url = endpoint(PATHS.opsGateway) + '?action=get_command&command_id=' + encodeURIComponent(commandId);
      return rawRequest({ method: 'GET', url });
    }
  };

  /* ─── Debug ─── */

  LPAdmin.debug = {
    version: LPAdmin.__client_version,
    paths: PATHS,
    get config() { return LPAdmin.config; },
    get endpoints() {
      return {
        telemetry: endpoint(PATHS.telemetry),
        opsGateway: endpoint(PATHS.opsGateway),
        adminOps: endpoint(PATHS.adminOps),
        abAdminOps: endpoint(PATHS.abAdminOps)
      };
    },
    listenerCount: () => {
      const summary = {};
      for (const [event, set] of listeners.entries()) summary[event] = set.size;
      return summary;
    }
  };

  try {
    if (global.location && /admin/i.test(global.location.pathname)) {
      console.log(
        `%c[LPAdmin] %cclient ${LPAdmin.__client_version} ready`,
        'color: #06b6d4; font-weight: bold;', 'color: inherit;'
      );
    }
  } catch (_) {}

})(typeof window !== 'undefined' ? window : globalThis);
