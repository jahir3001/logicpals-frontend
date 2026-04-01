/**
 * LogicPals Admin Auth Module
 * /assets/js/admin-auth.js  ·  v2.0  ·  March 2026
 *
 * Provides:
 *   window.LPAdmin.init(config)       — bootstrap auth for any admin page
 *   window.LPAdmin.getSupabase()      — get the shared Supabase client
 *   window.LPAdmin.getSession()       — get current session object
 *   window.LPAdmin.getRole()          — get resolved role string
 *   window.LPAdmin.getToken()         — get current Bearer JWT
 *   window.LPAdmin.signIn(email, pw)  — sign in + role gate
 *   window.LPAdmin.signOut()          — sign out + redirect
 *   window.LPAdmin.toast(msg, type)   — show toast notification
 *   window.LPAdmin.setStatus(k, txt)  — update status pill
 *   window.LPAdmin.setOutput(data)    — write to page output block
 *   window.LPAdmin.openLogin()        — open login dialog
 *   window.LPAdmin.requireRole(roles) — gate-check, returns {ok, sb, role, token}
 *
 * Enterprise features:
 *   — JWT expiry monitor: toast warning 5 min before expiry
 *   — Role-aware sidebar: hides Role Manager for non super_admin
 *   — Session initials avatar from email
 *   — Copy-to-clipboard on output block
 *   — Keyboard: Escape closes login dialog
 *
 * Dependencies (loaded automatically):
 *   — /assets/js/env-loader.js  (must be loaded BEFORE this script)
 *   — @supabase/supabase-js UMD (loaded dynamically from CDN)
 *   — /assets/css/admin.css     (must be linked in page <head>)
 */

(function () {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────── */
  const SB_CDN      = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  const STORAGE_KEY = 'lp_admin_auth';
  const RPC_CANDIDATES = [
    'rpc_lp_my_role',
    'get_my_role',
    'rp_get_my_role',
    'admin_get_role',
    'rp_admin_get_user_role',
  ];

  const ALL_ADMIN_ROLES = new Set([
    'super_admin', 'admin_regular', 'admin_olympiad',
    'support_readonly', 'reviewer', 'admin',
  ]);

  const ROLE_META = {
    super_admin:      { label: 'Super Admin',      color: 'indigo' },
    admin_regular:    { label: 'Admin · Regular',  color: 'teal'   },
    admin_olympiad:   { label: 'Admin · Olympiad', color: 'teal'   },
    support_readonly: { label: 'Support',          color: 'amber'  },
    reviewer:         { label: 'Reviewer',         color: 'blue'   },
    admin:            { label: 'Admin',            color: 'indigo' },
    no_role:          { label: 'No Role',          color: 'gray'   },
  };

  /* ── SVG Icons ─────────────────────────────────────────────── */
  const ICONS = {
    grid:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
    card:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/><path d="M6 15h4"/></svg>`,
    refresh: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>`,
    shield:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>`,
    beaker:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6m-3 0v6l5.196 7.794A2 2 0 0115.5 20h-7a2 2 0 01-1.696-3.206L12 9V3"/><path d="M7.5 16.5h9"/></svg>`,
    signout: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>`,
    menu:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`,
    close:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
    check:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
    warn:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>`,
    info:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>`,
    danger:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6m0-6l6 6"/></svg>`,
    clock:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
  };

  /* ── Nav definition ────────────────────────────────────────── */
  const NAV = [
    {
      section: 'Workspace',
      items: [
        { id: 'overview',      label: 'Overview',       href: '/admin.html',                    icon: ICONS.grid    },
      ],
    },
    {
      section: 'Operations',
      items: [
        { id: 'payments',      label: 'Payments',        href: '/admin/admin-payments.html',      icon: ICONS.card    },
        { id: 'subscriptions', label: 'Subscriptions',   href: '/admin/admin-subscriptions.html', icon: ICONS.refresh },
        { id: 'roles',         label: 'Role Manager',    href: '/admin/admin-roles.html',         icon: ICONS.shield,  requiresRole: 'super_admin' },
      ],
    },
    {
      section: 'Analytics',
      items: [
        { id: 'ab',            label: 'A/B Dashboard',   href: '/admin/ab-dashboard.html',        icon: ICONS.beaker  },
      ],
    },
  ];

  /* ── Internal state ────────────────────────────────────────── */
  let _sb           = null;
  let _session      = null;
  let _role         = null;
  let _config       = {};
  let _expireTimer  = null;
  let _authSub      = null;
  let _toastStack   = null;
  let _loginDialog  = null;
  let _loginResolve = null;

  /* ══════════════════════════════════════════════════════════════
     SUPABASE + ENV LOADING
  ══════════════════════════════════════════════════════════════ */

  async function loadSbLib() {
    if (window.__LP_SB_LIB) return window.__LP_SB_LIB;
    if (window.__LP_SB_LIB_PROMISE) return window.__LP_SB_LIB_PROMISE;

    window.__LP_SB_LIB_PROMISE = new Promise((resolve, reject) => {
      // Already available as window.supabase UMD global?
      if (window.supabase && typeof window.supabase.createClient === 'function') {
        window.__LP_SB_LIB = window.supabase;
        return resolve(window.supabase);
      }
      const s = document.createElement('script');
      s.src   = SB_CDN;
      s.async = true;
      s.onload = () => {
        if (window.supabase && typeof window.supabase.createClient === 'function') {
          window.__LP_SB_LIB = window.supabase;
          resolve(window.supabase);
        } else {
          reject(new Error('supabase_umd_load_failed'));
        }
      };
      s.onerror = () => reject(new Error('supabase_cdn_unreachable'));
      document.head.appendChild(s);
    });

    return window.__LP_SB_LIB_PROMISE;
  }

  async function getSupabase() {
    if (_sb) return _sb;

    const env = await window.__LP_GET_ENV();
    if (!env || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      throw new Error('Supabase config unavailable — ensure /api/env is deployed and env vars are set.');
    }

    const lib = await loadSbLib();
    _sb = lib.createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: {
        storageKey:          STORAGE_KEY,
        persistSession:      true,
        autoRefreshToken:    true,
        detectSessionInUrl:  false,
      },
    });

    return _sb;
  }

  /* ══════════════════════════════════════════════════════════════
     ROLE RESOLUTION
  ══════════════════════════════════════════════════════════════ */

  async function resolveRole(sb) {
    for (const fn of RPC_CANDIDATES) {
      try {
        const { data, error } = await sb.rpc(fn);
        if (!error) {
          if (typeof data === 'string') return data.trim();
          if (data && typeof data === 'object') {
            return String(data.role || data.current_role || data.name || 'no_role').trim();
          }
          return 'no_role';
        }
      } catch (_) { /* try next */ }
    }
    return 'no_role';
  }

  /* ══════════════════════════════════════════════════════════════
     STATUS PILL
  ══════════════════════════════════════════════════════════════ */

  function setStatus(kind, text) {
    const dotId  = _config.dotEl      || 'dot';
    const textId = _config.statusEl   || 'statusTxt';
    const dot    = document.getElementById(dotId);
    const txt    = document.getElementById(textId);

    if (dot) {
      dot.className = 'admin-dot';
      if (kind === 'ok')   dot.classList.add('ok');
      if (kind === 'warn') dot.classList.add('warn', 'pulse');
      if (kind === 'err')  dot.classList.add('err');
      if (kind === 'idle') { /* default gray */ }
    }
    if (txt) txt.textContent = text;
  }

  function setWho(text) {
    const el = document.getElementById(_config.whoEl || 'who');
    if (el) el.textContent = text;
  }

  /* ══════════════════════════════════════════════════════════════
     OUTPUT BLOCK
  ══════════════════════════════════════════════════════════════ */

  function setOutput(data) {
    const outId = _config.outputEl || 'out';
    const el    = document.getElementById(outId);
    if (!el) return;
    el.value = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  }

  /* ══════════════════════════════════════════════════════════════
     TOAST SYSTEM
  ══════════════════════════════════════════════════════════════ */

  function ensureToastStack() {
    if (_toastStack && document.body.contains(_toastStack)) return _toastStack;
    _toastStack = document.createElement('div');
    _toastStack.className = 'admin-toast-stack';
    document.body.appendChild(_toastStack);
    return _toastStack;
  }

  const TOAST_ICONS = {
    success: ICONS.check,
    error:   ICONS.danger,
    warning: ICONS.warn,
    info:    ICONS.info,
  };

  const TOAST_TITLES = {
    success: 'Success',
    error:   'Error',
    warning: 'Warning',
    info:    'Info',
  };

  /**
   * Show a toast notification.
   * @param {string|{title,message}} msg
   * @param {'success'|'error'|'warning'|'info'} type
   * @param {number} duration  ms before auto-dismiss (0 = manual only)
   */
  function toast(msg, type = 'info', duration = 4500) {
    const stack  = ensureToastStack();
    const title  = typeof msg === 'object' ? msg.title   : (TOAST_TITLES[type] || 'Notice');
    const body   = typeof msg === 'object' ? msg.message : msg;
    const icon   = TOAST_ICONS[type] || TOAST_ICONS.info;

    const el = document.createElement('div');
    el.className = `admin-toast admin-toast-${type}`;
    el.innerHTML = `
      <span class="admin-toast-icon">${icon}</span>
      <div class="admin-toast-body">
        <div class="admin-toast-title">${_esc(title)}</div>
        ${body ? `<div class="admin-toast-message">${_esc(body)}</div>` : ''}
      </div>
      <button class="admin-toast-close" aria-label="Dismiss">${ICONS.close}</button>
    `;

    stack.appendChild(el);

    const dismiss = () => {
      el.classList.add('admin-toast-exit');
      el.addEventListener('animationend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 350);
    };

    el.querySelector('.admin-toast-close').addEventListener('click', dismiss);
    if (duration > 0) setTimeout(dismiss, duration);

    return dismiss;
  }

  /* ══════════════════════════════════════════════════════════════
     LOGIN DIALOG
  ══════════════════════════════════════════════════════════════ */

  function renderLoginDialog() {
    if (document.getElementById('lp-login-dialog')) return;

    const tmpl = document.createElement('template');
    tmpl.innerHTML = `
      <dialog id="lp-login-dialog" class="admin-dialog" style="border-radius:24px; padding:0; border:1px solid var(--lp-border); max-width:420px; width:calc(100% - 40px);">
        <div class="admin-dialog-header">
          <div class="admin-dialog-title-row">
            <div class="admin-dialog-logo">LP</div>
            <div class="admin-dialog-heading">Admin Sign In</div>
          </div>
          <button class="admin-dialog-close" id="lp-dlg-close" type="button">${ICONS.close}</button>
        </div>
        <div class="admin-dialog-body">
          <div id="lp-dlg-denied-banner" class="admin-banner admin-banner-danger" style="display:none;margin-bottom:16px;">
            <span class="admin-banner-icon">${ICONS.danger}</span>
            <div class="admin-banner-body">
              <div class="admin-banner-title">Access Denied</div>
              <div id="lp-dlg-denied-msg"></div>
            </div>
          </div>
          <form id="lp-dlg-form" autocomplete="on">
            <div style="display:flex;flex-direction:column;gap:14px;">
              <div class="admin-field">
                <label class="admin-label" for="lp-dlg-email">Email</label>
                <input class="admin-input" id="lp-dlg-email" type="email" autocomplete="username" placeholder="admin@logicpals.com" required />
              </div>
              <div class="admin-field">
                <label class="admin-label" for="lp-dlg-pass">Password</label>
                <input class="admin-input" id="lp-dlg-pass" type="password" autocomplete="current-password" placeholder="••••••••" required />
              </div>
            </div>
            <div class="admin-dialog-actions">
              <button class="admin-btn admin-btn-primary" id="lp-dlg-submit" type="submit">Sign In</button>
              <button class="admin-btn admin-btn-secondary" id="lp-dlg-close-btn" type="button">Cancel</button>
            </div>
            <div class="admin-dialog-hint" id="lp-dlg-hint"></div>
          </form>
        </div>
      </dialog>
    `.trim();

    document.body.appendChild(tmpl.content.firstChild);
    _loginDialog = document.getElementById('lp-login-dialog');

    // Wire close buttons
    document.getElementById('lp-dlg-close').addEventListener('click', closeLogin);
    document.getElementById('lp-dlg-close-btn').addEventListener('click', closeLogin);

    // Wire form submit
    document.getElementById('lp-dlg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (document.getElementById('lp-dlg-email').value || '').trim();
      const pass  =  document.getElementById('lp-dlg-pass').value  || '';
      await _handleDialogLogin(email, pass);
    });

    // Escape key
    _loginDialog.addEventListener('cancel', (e) => { e.preventDefault(); closeLogin(); });
  }

  function openLogin(deniedMessage) {
    renderLoginDialog();
    const banner = document.getElementById('lp-dlg-denied-banner');
    const msg    = document.getElementById('lp-dlg-denied-msg');
    const hint   = document.getElementById('lp-dlg-hint');

    if (deniedMessage) {
      if (banner) banner.style.display = 'flex';
      if (msg)    msg.textContent = deniedMessage;
    } else {
      if (banner) banner.style.display = 'none';
    }

    if (hint) { hint.textContent = ''; hint.className = 'admin-dialog-hint'; }
    if (_loginDialog && !_loginDialog.open) _loginDialog.showModal();
  }

  function closeLogin() {
    if (_loginDialog && _loginDialog.open) {
      try { _loginDialog.close(); } catch (_) {}
    }
  }

  async function _handleDialogLogin(email, password) {
    const hint   = document.getElementById('lp-dlg-hint');
    const submit = document.getElementById('lp-dlg-submit');

    if (hint)   { hint.textContent = 'Signing in…'; hint.className = 'admin-dialog-hint'; }
    if (submit) submit.classList.add('loading');
    setStatus('warn', 'Signing in…');

    const result = await signIn(email, password);

    if (submit) submit.classList.remove('loading');

    if (!result.ok) {
      if (hint) {
        hint.textContent = result.error || 'Sign in failed.';
        hint.className   = 'admin-dialog-hint err';
      }
      setStatus('err', 'Sign in failed');
      return;
    }

    closeLogin();
    // onAuth callback (if any)
    if (typeof _config.onAuth === 'function') {
      _config.onAuth(_session, _role, _sb);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     SIDEBAR
  ══════════════════════════════════════════════════════════════ */

  function _initials(email) {
    if (!email) return 'AD';
    const parts = email.split('@')[0].split(/[._\-+]/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return email.slice(0, 2).toUpperCase();
  }

  function _roleBadgeClass(role) {
    const meta = ROLE_META[role];
    if (!meta) return 'admin-badge admin-badge-gray';
    return `admin-badge admin-badge-${meta.color}`;
  }

  function renderSidebar() {
    const container = document.querySelector('.admin-sidebar');
    if (!container) return;

    const page  = _config.page  || '';
    const role  = _role         || 'no_role';
    const email = _session?.user?.email || '';
    const meta  = ROLE_META[role] || ROLE_META['no_role'];

    let navHtml = '';

    for (const group of NAV) {
      navHtml += `<div class="admin-nav-section">${group.section}</div>`;
      for (const item of group.items) {
        // Role filter: hide items that require a role the user doesn't have
        if (item.requiresRole && role !== item.requiresRole) continue;

        const isActive = item.id === page;
        navHtml += `
          <a class="admin-nav-item${isActive ? ' active' : ''}" href="${item.href}">
            <span class="admin-nav-icon">${item.icon}</span>
            <span class="admin-nav-label">${item.label}</span>
          </a>
        `;
      }
    }

    container.innerHTML = `
      <div class="admin-sidebar-inner">
        <div class="admin-sidebar-logo">
          <div class="admin-logo">LP</div>
          <div>
            <div class="admin-sidebar-brand">LogicPals</div>
            <div class="admin-sidebar-sub">Admin Console</div>
          </div>
        </div>

        <nav class="admin-nav" aria-label="Admin navigation">
          ${navHtml}
        </nav>

        <div class="admin-sidebar-footer">
          <div class="admin-user-card">
            <div class="admin-user-avatar">${_initials(email)}</div>
            <div class="admin-user-info">
              <div class="admin-user-email">${_esc(email)}</div>
              <div class="admin-user-role">${meta.label}</div>
            </div>
            <button class="admin-signout-btn" id="lp-sidebar-signout" title="Sign out">
              ${ICONS.signout}
            </button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('lp-sidebar-signout')?.addEventListener('click', signOut);
  }

  /* ── Mobile sidebar toggle ────────────────────────────────── */
  function _wireMobileToggle() {
    const toggleBtn = document.getElementById('lp-menu-toggle');
    const app       = document.querySelector('.admin-app');
    if (!toggleBtn || !app) return;

    // Inject backdrop if not present
    if (!document.querySelector('.admin-sidebar-backdrop')) {
      const bd = document.createElement('div');
      bd.className = 'admin-sidebar-backdrop';
      bd.id = 'lp-sb-backdrop';
      app.insertBefore(bd, app.firstChild);
    }

    toggleBtn.addEventListener('click', () => {
      app.classList.toggle('sidebar-open');
    });

    document.getElementById('lp-sb-backdrop')?.addEventListener('click', () => {
      app.classList.remove('sidebar-open');
    });

    // Close on nav click (mobile)
    document.querySelector('.admin-sidebar')?.addEventListener('click', (e) => {
      if (e.target.closest('.admin-nav-item')) {
        app.classList.remove('sidebar-open');
      }
    });
  }

  /* ── Output block copy button ─────────────────────────────── */
  function _wireOutputBlocks() {
    document.querySelectorAll('.admin-output-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const area = btn.closest('.admin-output-block')?.querySelector('.admin-output-area');
        if (!area || !area.value) return;
        navigator.clipboard.writeText(area.value).then(() => {
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 2000);
        }).catch(() => {
          // Fallback
          area.select();
          document.execCommand('copy');
        });
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════
     SESSION EXPIRY MONITOR
     Warn the admin 5 minutes before JWT expires
  ══════════════════════════════════════════════════════════════ */

  function startExpiryMonitor(session) {
    if (_expireTimer) clearTimeout(_expireTimer);

    const exp = session?.expires_at; // Unix timestamp (seconds)
    if (!exp) return;

    const now     = Math.floor(Date.now() / 1000);
    const warn    = (exp - now - 300) * 1000; // 5 min before
    const expire  = (exp - now) * 1000;

    if (warn > 0) {
      _expireTimer = setTimeout(() => {
        toast(
          { title: 'Session expiring soon', message: 'Your admin session expires in ~5 minutes. Save any work.' },
          'warning',
          0 // manual dismiss
        );
      }, warn);
    }

    // At actual expiry, show error toast and reset status
    setTimeout(() => {
      toast({ title: 'Session expired', message: 'Please sign in again to continue.' }, 'error', 0);
      setStatus('err', 'Session expired');
    }, expire > 0 ? expire : 0);
  }

  /* ══════════════════════════════════════════════════════════════
     AUTH ACTIONS
  ══════════════════════════════════════════════════════════════ */

  async function signIn(email, password) {
    try {
      const sb = await getSupabase();
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return { ok: false, error: error.message };

      const { data: { session } } = await sb.auth.getSession();
      if (!session) return { ok: false, error: 'No session after sign-in.' };

      const role = await resolveRole(sb);
      _session = session;
      _role    = role;

      // Role gate
      const allowed = _config.allowedRoles
        ? _config.allowedRoles.includes(role)
        : ALL_ADMIN_ROLES.has(role);

      if (!allowed) {
        await sb.auth.signOut();
        _session = null;
        _role    = null;
        return { ok: false, error: `Role "${role}" is not permitted on this page.` };
      }

      return { ok: true, role, session };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function signOut() {
    try {
      const sb = await getSupabase();
      setStatus('warn', 'Signing out…');
      await sb.auth.signOut();
    } catch (_) {}
    _session = null;
    _role    = null;
    // Redirect to login
    const loginUrl = _config.loginUrl || '/admin-login.html';
    window.location.href = loginUrl + '?logged_out=1';
  }

  /* ══════════════════════════════════════════════════════════════
     REQUIRE ROLE GATE
     Call before any privileged operation.
     Returns { ok: true, sb, role, token } or { ok: false }
  ══════════════════════════════════════════════════════════════ */

  async function requireRole(allowedRoles) {
    try {
      const sb = await getSupabase();
      const { data: { session } } = await sb.auth.getSession();

      if (!session) {
        setStatus('warn', 'Sign-in required');
        openLogin();
        return { ok: false };
      }

      const role = await resolveRole(sb);
      _role = role;

      const permitted = Array.isArray(allowedRoles)
        ? allowedRoles.includes(role)
        : ALL_ADMIN_ROLES.has(role);

      if (!permitted) {
        setStatus('err', 'Access denied');
        const msg = `Role "${role}" cannot perform this action.`;
        openLogin(msg);
        return { ok: false };
      }

      setStatus('ok', 'Ready');
      const token = session.access_token;
      return { ok: true, sb, role, token };

    } catch (e) {
      setStatus('err', 'Auth error');
      toast({ title: 'Auth error', message: e?.message }, 'error');
      return { ok: false };
    }
  }

  /* ══════════════════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════════════════ */

  /**
   * Bootstrap authentication for an admin page.
   *
   * @param {object} config
   *   page         {string}   — nav item id for active state
   *   allowedRoles {string[]} — which roles can access this page (default: all admin roles)
   *   onAuth       {function} — callback(session, role, sb) when auth succeeds
   *   loginUrl     {string}   — where to redirect on sign-out (default: /admin-login.html)
   *   statusEl     {string}   — id of status text element    (default: 'statusTxt')
   *   dotEl        {string}   — id of dot element            (default: 'dot')
   *   whoEl        {string}   — id of who display element    (default: 'who')
   *   outputEl     {string}   — id of output textarea        (default: 'out')
   */
  async function init(config = {}) {
    _config = config;

    setStatus('warn', 'Loading…');

    try {
      const sb = await getSupabase();

      // Subscribe to auth state changes (once, guarded)
      if (!_authSub) {
        const { data: sub } = sb.auth.onAuthStateChange((event) => {
          if (event === 'SIGNED_OUT') {
            setStatus('idle', 'Signed out');
            renderSidebar(); // re-render with no user
          }
          if (event === 'TOKEN_REFRESHED' && _session) {
            // Restart expiry monitor with new token expiry
            sb.auth.getSession().then(({ data: { session } }) => {
              if (session) {
                _session = session;
                startExpiryMonitor(session);
              }
            });
          }
        });
        _authSub = sub;
      }

      const { data: { session } } = await sb.auth.getSession();

      if (!session) {
        setStatus('warn', 'Sign-in required');
        setWho('—');
        renderLoginDialog();
        openLogin();
        return { ok: false };
      }

      const role = await resolveRole(sb);
      _session = session;
      _role    = role;

      // Gate check
      const permitted = config.allowedRoles
        ? config.allowedRoles.includes(role)
        : ALL_ADMIN_ROLES.has(role);

      if (!permitted) {
        setStatus('err', 'Access denied');
        setWho(`${session.user.email} · ${role}`);
        openLogin(`Role "${role}" is not permitted on this page.`);
        return { ok: false, role };
      }

      // Auth success
      setStatus('ok', 'Ready');
      setWho(`${session.user.email}  ·  ${role}`);
      renderSidebar();
      _wireMobileToggle();
      _wireOutputBlocks();
      startExpiryMonitor(session);

      if (typeof config.onAuth === 'function') {
        config.onAuth(session, role, sb);
      }

      return { ok: true, session, role, sb, token: session.access_token };

    } catch (e) {
      setStatus('err', 'Boot error');
      toast({ title: 'Startup error', message: e?.message }, 'error');
      openLogin();
      return { ok: false, error: e?.message };
    }
  }

  /* ══════════════════════════════════════════════════════════════
     UTILITIES
  ══════════════════════════════════════════════════════════════ */

  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════════════ */
  window.LPAdmin = {
  /** Bootstrap auth for a page. Call once on DOMContentLoaded. */
  init,

  /** Get the shared SupabaseClient instance (null before init). */
  getSupabase: () => _sb,

  /** Backward/forward-compatible alias used by newer admin pages. */
  getClient: async () => getSupabase(),

  /** Get the current Supabase session object (null if not signed in). */
  getSession: () => _session,

  /** Get the resolved role string (null before init). */
  getRole: () => _role,

  /** Get the current JWT Bearer token (null if not signed in). */
  getToken: () => _session?.access_token || null,

  /**
   * Full auth context helper for enterprise admin pages.
   * Returns { sb, session, role, token }.
   */
  getAuthContext: async () => {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    const role = _role || (session ? await resolveRole(sb) : null);
    return {
      sb,
      session,
      role,
      token: session?.access_token || null,
    };
  },

  /** Sign in with email + password. Returns {ok, role?, error?}. */
  signIn,

  /** Sign out and redirect to loginUrl. */
  signOut,

  /**
   * Gate-check the current session against allowed roles.
   * Automatically opens login dialog if not authenticated.
   * Returns {ok, sb, role, token} on success or {ok: false} on failure.
   */
  requireRole,

  /** Show a toast notification. type: 'success'|'error'|'warning'|'info' */
  toast,

  /** Update the status pill. kind: 'ok'|'warn'|'err'|'idle' */
  setStatus,

  /** Write data to the page's output block (#out by default). */
  setOutput,

  /** Open the login dialog. Optional deniedMessage shown as banner. */
  openLogin,

  /** Close the login dialog. */
  closeLogin,

  /** Re-render the sidebar (e.g. after role change). */
  renderSidebar,
};

})();
