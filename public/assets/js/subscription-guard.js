/**
 * LOGICPALS SUBSCRIPTION GUARD (Enterprise)
 * - NO hardcoded Supabase URL/keys in public
 * - Uses current logged-in JWT context
 * Version: 2.0
 */

(function () {
  // Tier access configuration (keep as-is; adjust tiers if your DB uses different names)
  const TIER_ACCESS = {
    free_trial: { regular: true, olympiad_preview: 3, levels: [] },
    thinker: { regular: true, olympiad_preview: 0, levels: [] },
    legend: { regular: true, olympiad_preview: 0, levels: ["primary", "junior"] },
    champion: { regular: true, olympiad_preview: 0, levels: ["primary", "junior"] },
    scholar: { regular: true, olympiad_preview: 0, levels: ["primary", "junior", "secondary", "higher_secondary"] },
    champion_annual: { regular: true, olympiad_preview: 0, levels: ["secondary", "higher_secondary", "advanced"] },
    elite: { regular: true, olympiad_preview: 0, levels: ["primary", "junior", "secondary", "higher_secondary", "advanced"] },
    family: { regular: true, olympiad_preview: 0, levels: ["primary", "junior"] },
  };

  async function fetchEnv() {
    const r = await fetch("/api/env", { method: "GET" });
    if (!r.ok) throw new Error("env_fetch_failed");
    const j = await r.json();

    const supabaseUrl = j.supabaseUrl || j.SUPABASE_URL || j.url || j.SUPABASE_URL;
    const supabaseAnonKey =
      j.supabaseAnonKey || j.SUPABASE_ANON_KEY || j.anonKey || j.SUPABASE_KEY;

    if (!supabaseUrl) throw new Error("missing_supabase_url_in_env");
    if (!supabaseAnonKey) throw new Error("missing_supabase_anon_key_in_env");

    return { supabaseUrl, supabaseAnonKey };
  }

  async function getSupabaseClient() {
    if (window.supabase && typeof window.supabase.auth?.getSession === "function") return window.supabase;
    if (window.sb && typeof window.sb.auth?.getSession === "function") return window.sb;

    if (window.supabase && typeof window.supabase.createClient === "function") {
      if (!window.__lp_env_promise) window.__lp_env_promise = fetchEnv();
      const env = await window.__lp_env_promise;

      if (!window.__lp_sb) {
        window.__lp_sb = window.supabase.createClient(env.supabaseUrl, env.supabaseAnonKey);
      }
      return window.__lp_sb;
    }

    console.error("Supabase client not available (missing supabase-js).");
    return null;
  }

  async function getUserSubscription() {
    const sb = await getSupabaseClient();
    if (!sb) return null;

    try {
      const { data: { session }, error: sessionError } = await sb.auth.getSession();

      if (sessionError || !session) return null;

      const userId = session.user.id;

      // Active subscription (make sure RLS allows the user to read their own subscription)
      const { data: subscription, error: subError } = await sb
        .from("subscriptions")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (subError || !subscription) return null;

      const now = new Date();
      const endDate = subscription.end_date ? new Date(subscription.end_date) : null;

      const expired = endDate ? endDate < now : false;

      // Optional child data (age filter)
      const { data: child } = await sb
        .from("children")
        .select("age, age_category, subscription_tier")
        .eq("parent_id", userId)
        .single();

      return {
        ...subscription,
        expired,
        child: child || null,
      };
    } catch (err) {
      console.error("Error getting subscription:", err);
      return null;
    }
  }

  async function getOlympiadAttemptCount(userId) {
    const sb = await getSupabaseClient();
    if (!sb) return 999; // safest: block preview if we cannot verify

    try {
      const { data: child } = await sb
        .from("children")
        .select("id")
        .eq("parent_id", userId)
        .single();

      if (!child) return 0;

      // Count unique Olympiad problems attempted (assumes problems.olympiad_level exists)
      const { data: attempts, error } = await sb
        .from("attempts")
        .select("problem_id, problems!inner(olympiad_level)")
        .eq("child_id", child.id)
        .neq("problems.olympiad_level", "regular");

      if (error || !attempts) return 0;

      const uniqueProblems = new Set(attempts.map((a) => a.problem_id));
      return uniqueProblems.size;
    } catch (err) {
      console.error("Error counting Olympiad attempts:", err);
      return 0;
    }
  }

  function getSuggestedTier(problemLevel) {
    const tierMap = {
      primary: "champion",
      junior: "champion",
      secondary: "scholar",
      higher_secondary: "scholar",
      advanced: "elite",
    };
    return tierMap[problemLevel] || "champion";
  }

  async function canAccessLevel(problemLevel) {
    const subscription = await getUserSubscription();

    if (!subscription) {
      return { allowed: false, reason: "no_subscription", message: "Please log in to continue" };
    }

    if (subscription.expired) {
      return {
        allowed: false,
        reason: "subscription_expired",
        message: "Your trial has expired. Upgrade to continue!",
        upgradeUrl: "upgrade.html",
      };
    }

    const tier = subscription.tier;
    const tierConfig = TIER_ACCESS[tier];

    if (!tierConfig) {
      return { allowed: false, reason: "invalid_tier", message: "Invalid subscription tier" };
    }

    if (problemLevel === "regular") {
      return { allowed: !!tierConfig.regular, tier };
    }

    // Olympiad levels
    if (tierConfig.levels.includes(problemLevel)) {
      return { allowed: true, tier };
    }

    // Free preview logic
    if (tier === "free_trial" && tierConfig.olympiad_preview > 0) {
      const count = await getOlympiadAttemptCount(subscription.user_id);
      if (count < tierConfig.olympiad_preview) {
        return {
          allowed: true,
          tier,
          preview: true,
          remaining: tierConfig.olympiad_preview - count,
          message: `Free preview: ${tierConfig.olympiad_preview - count} problems remaining`,
        };
      }

      return {
        allowed: false,
        reason: "preview_limit_reached",
        message: "Free preview limit reached! Upgrade to Champion tier for unlimited access.",
        upgradeUrl: "upgrade.html",
        suggestedTier: "champion",
      };
    }

    return {
      allowed: false,
      reason: "tier_insufficient",
      message: `Upgrade to access ${problemLevel} problems!`,
      upgradeUrl: "upgrade.html",
      suggestedTier: getSuggestedTier(problemLevel),
    };
  }

  async function requireLogin() {
    const sb = await getSupabaseClient();
    if (!sb) {
      window.location.href = "login.html";
      return false;
    }

    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      window.location.href = "login.html";
      return false;
    }
    return true;
  }

  function redirectToUpgrade(reason, suggestedTier = "champion") {
    const params = new URLSearchParams({
      reason,
      tier: suggestedTier,
      return: window.location.pathname,
    });
    window.location.href = `upgrade.html?${params.toString()}`;
  }

  function showUpgradeModal(message, suggestedTier = "champion") {
    const modalHTML = `
      <div id="upgradeModal" style="
        position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex;
        align-items:center; justify-content:center; z-index:9999; backdrop-filter: blur(3px);">
        <div style="
          background:white; padding:40px; border-radius:20px; max-width:500px; width:90%;
          text-align:center; box-shadow:0 10px 40px rgba(0,0,0,0.3);">
          <div style="font-size:60px; margin-bottom:20px;">🔒</div>
          <h2 style="color:#1F2937; margin-bottom:16px; font-size:28px;">Upgrade to Unlock</h2>
          <p style="color:#6B7280; margin-bottom:30px; font-size:16px; line-height:1.6;">${message}</p>
          <button onclick="window.location.href='upgrade.html?tier=${suggestedTier}'" style="
            background:linear-gradient(135deg,#F59E0B 0%,#D97706 100%); color:white;
            padding:16px 32px; border:none; border-radius:12px; font-size:18px; font-weight:700;
            cursor:pointer; width:100%; margin-bottom:12px; box-shadow:0 4px 12px rgba(245,158,11,0.4);">
            🚀 Upgrade Now
          </button>
          <button onclick="document.getElementById('upgradeModal')?.remove()" style="
            background:transparent; color:#6B7280; padding:12px; border:none; font-size:14px;
            cursor:pointer; width:100%;">
            Maybe Later
          </button>
        </div>
      </div>
    `;

    document.getElementById("upgradeModal")?.remove();
    document.body.insertAdjacentHTML("beforeend", modalHTML);
  }

  async function getUserTierInfo() {
    const subscription = await getUserSubscription();

    if (!subscription) {
      return { tier: "none", displayName: "No Subscription", daysRemaining: 0, expired: true };
    }

    const now = new Date();
    const endDate = subscription.end_date ? new Date(subscription.end_date) : null;
    const daysRemaining = endDate ? Math.ceil((endDate - now) / 86400000) : 0;

    const tierNames = {
      free_trial: "Free Trial",
      thinker: "Thinker",
      champion: "Champion",
      legend: "Legend",
      scholar: "Scholar",
      champion_annual: "Champion Annual",
      elite: "Elite",
      family: "Family",
    };

    return {
      tier: subscription.tier,
      displayName: tierNames[subscription.tier] || subscription.tier,
      daysRemaining: Math.max(0, daysRemaining),
      expired: !!subscription.expired,
      endDate: subscription.end_date || null,
    };
  }

  async function displaySubscriptionBadge(containerId) {
    const tierInfo = await getUserTierInfo();
    const container = document.getElementById(containerId);
    if (!container) return;

    let badgeHTML = "";

    if (tierInfo.expired) {
      badgeHTML = `
        <div style="background:#FEE2E2;color:#DC2626;padding:8px 16px;border-radius:20px;
          font-size:13px;font-weight:700;display:inline-block;border:1px solid #FCA5A5;">
          ⚠️ Trial Expired
        </div>`;
    } else if (tierInfo.tier === "free_trial") {
      badgeHTML = `
        <div style="background:#FEF3C7;color:#D97706;padding:8px 16px;border-radius:20px;
          font-size:13px;font-weight:700;display:inline-block;border:1px solid #FCD34D;">
          🎁 Free Trial • ${tierInfo.daysRemaining} days left
        </div>`;
    } else {
      badgeHTML = `
        <div style="background:linear-gradient(135deg,#F59E0B 0%,#D97706 100%);color:white;
          padding:8px 16px;border-radius:20px;font-size:13px;font-weight:700;display:inline-block;
          box-shadow:0 2px 8px rgba(245,158,11,0.3);">
          👑 ${tierInfo.displayName}
        </div>`;
    }

    container.innerHTML = badgeHTML;
  }

  window.SubscriptionGuard = {
    getUserSubscription,
    canAccessLevel,
    requireLogin,
    redirectToUpgrade,
    showUpgradeModal,
    getUserTierInfo,
    displaySubscriptionBadge,
    getOlympiadAttemptCount,
  };
})();