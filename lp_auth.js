/**
 * LogicPals shared auth guard (static HTML friendly).
 * - Redirects if not authenticated (optional)
 * - Provides a consistent topbar wiring (optional)
 *
 * NOTE: This file intentionally does NOT include any Supabase keys.
 * Pages should create a Supabase client using your existing /api/env pattern (recommended),
 * then call window.LPAuth.attach(sb, options).
 */
(function(){
  function qs(id){ return document.getElementById(id); }

  async function attach(sb, options){
    const opt = Object.assign({
      requireAuth: false,
      redirectTo: 'index.html',
      whoEl: 'who',
      onSession: null, // (session) => void
      signOutBtn: 'btnSignOut',
      signInBtn: 'btnSignIn',
      loginOverlay: 'loginOverlay'
    }, options || {});

    if(!sb || !sb.auth) throw new Error("LPAuth.attach requires a Supabase client");

    const { data: { session } } = await sb.auth.getSession();
    if(opt.requireAuth && !session){
      window.location.href = opt.redirectTo;
      return { session: null };
    }

    const who = qs(opt.whoEl);
    if(who){
      who.textContent = session?.user?.email ? `Signed in: ${session.user.email}` : 'Signed out';
    }

    const btnSignOut = qs(opt.signOutBtn);
    if(btnSignOut){
      btnSignOut.onclick = async () => {
        await sb.auth.signOut();
        window.location.href = opt.redirectTo;
      };
    }

    if(typeof opt.onSession === 'function'){
      try{ await opt.onSession(session); }catch(e){ console.warn(e); }
    }

    return { session };
  }

  window.LPAuth = { attach };
})();
