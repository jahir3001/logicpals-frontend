/**
 * LOGICPALS SUBSCRIPTION GUARD
 * Handles access control, tier checking, and trial limits
 * Version: 1.0
 */

// Supabase configuration
const SUPABASE_URL = 'https://ovszuxerimbmzfblzkgd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92c3p1eGVyaW1ibXpmYmx6a2dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1MDA4MzgsImV4cCI6MjA4MDA3NjgzOH0.cmMF8OsC8J_B-t0aBldiMqv4XiNZtJWSGMqg8At9V14';

// Tier access configuration
const TIER_ACCESS = {
    'free_trial': {
        regular: true,
        olympiad_preview: 3, // Can try 3 Olympiad problems
        levels: []
    },
    'thinker': {
        regular: true,
        olympiad_preview: 0,
        levels: []
    },
    'legend': {
        regular: true,
        olympiad_preview: 0,
        levels: ['primary', 'junior']
    },
    'champion': {
        regular: true,
        olympiad_preview: 0,
        levels: ['primary', 'junior']
    },
    'scholar': {
        regular: true,
        olympiad_preview: 0,
        levels: ['primary', 'junior', 'secondary', 'higher_secondary']
    },
    'champion_annual': {
        regular: true,
        olympiad_preview: 0,
        levels: ['secondary', 'higher_secondary', 'advanced']
    },
    'elite': {
        regular: true,
        olympiad_preview: 0,
        levels: ['primary', 'junior', 'secondary', 'higher_secondary', 'advanced']
    },
    'family': {
        regular: true,
        olympiad_preview: 0,
        levels: ['primary', 'junior']
    }
};

/**
 * Initialize Supabase client
 */
function initSupabase() {
    if (typeof supabase === 'undefined') {
        console.error('Supabase library not loaded!');
        return null;
    }
    return supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

/**
 * Get current user's subscription details
 */
async function getUserSubscription() {
    const sb = initSupabase();
    if (!sb) return null;

    try {
        // Get current session
        const { data: { session }, error: sessionError } = await sb.auth.getSession();
        
        if (sessionError || !session) {
            console.error('No active session');
            return null;
        }

        const userId = session.user.id;

        // Get user's active subscription
        const { data: subscription, error: subError } = await sb
            .from('subscriptions')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (subError || !subscription) {
            console.error('No active subscription:', subError);
            return null;
        }

        // Check if subscription is expired
        const now = new Date();
        const endDate = new Date(subscription.end_date);
        
        if (endDate < now) {
            console.warn('Subscription expired:', subscription.end_date);
            return {
                ...subscription,
                expired: true
            };
        }

        // Get child data for age-appropriate filtering
        const { data: child, error: childError } = await sb
            .from('children')
            .select('age, age_category, subscription_tier')
            .eq('parent_id', userId)
            .single();

        return {
            ...subscription,
            expired: false,
            child: child || null
        };

    } catch (err) {
        console.error('Error getting subscription:', err);
        return null;
    }
}

/**
 * Check if user can access a specific problem level
 */
async function canAccessLevel(problemLevel) {
    const subscription = await getUserSubscription();
    
    if (!subscription) {
        return {
            allowed: false,
            reason: 'no_subscription',
            message: 'Please log in to continue'
        };
    }

    if (subscription.expired) {
        return {
            allowed: false,
            reason: 'subscription_expired',
            message: 'Your trial has expired. Upgrade to continue!',
            upgradeUrl: 'upgrade.html'
        };
    }

    const tier = subscription.tier;
    const tierConfig = TIER_ACCESS[tier];

    if (!tierConfig) {
        return {
            allowed: false,
            reason: 'invalid_tier',
            message: 'Invalid subscription tier'
        };
    }

    // Check if it's a regular problem
    if (problemLevel === 'regular') {
        return {
            allowed: tierConfig.regular,
            tier: tier
        };
    }

    // Check Olympiad access
    const levels = tierConfig.levels;
    
    if (levels.includes(problemLevel)) {
        return {
            allowed: true,
            tier: tier
        };
    }

    // Check free trial preview
    if (tier === 'free_trial' && tierConfig.olympiad_preview > 0) {
        // Count how many Olympiad problems user has attempted
        const count = await getOlympiadAttemptCount(subscription.user_id);
        
        if (count < tierConfig.olympiad_preview) {
            return {
                allowed: true,
                tier: tier,
                preview: true,
                remaining: tierConfig.olympiad_preview - count,
                message: `Free preview: ${tierConfig.olympiad_preview - count} problems remaining`
            };
        } else {
            return {
                allowed: false,
                reason: 'preview_limit_reached',
                message: 'Free preview limit reached! Upgrade to Champion tier for unlimited access.',
                upgradeUrl: 'upgrade.html',
                suggestedTier: 'champion'
            };
        }
    }

    // Not allowed - suggest upgrade
    return {
        allowed: false,
        reason: 'tier_insufficient',
        message: `Upgrade to access ${problemLevel} problems!`,
        upgradeUrl: 'upgrade.html',
        suggestedTier: getSuggestedTier(problemLevel)
    };
}

/**
 * Get count of Olympiad problems user has attempted
 */
async function getOlympiadAttemptCount(userId) {
    const sb = initSupabase();
    if (!sb) return 999; // Block if can't check

    try {
        const { data: child } = await sb
            .from('children')
            .select('id')
            .eq('parent_id', userId)
            .single();

        if (!child) return 0;

        // Count unique Olympiad problems attempted
        const { data: attempts, error } = await sb
            .from('attempts')
            .select('problem_id, problems!inner(olympiad_level)')
            .eq('child_id', child.id)
            .neq('problems.olympiad_level', 'regular');

        if (error) {
            console.error('Error counting attempts:', error);
            return 0;
        }

        // Count unique problem IDs
        const uniqueProblems = new Set(attempts.map(a => a.problem_id));
        return uniqueProblems.size;

    } catch (err) {
        console.error('Error in getOlympiadAttemptCount:', err);
        return 0;
    }
}

/**
 * Get suggested tier for a problem level
 */
function getSuggestedTier(problemLevel) {
    const tierMap = {
        'primary': 'champion',
        'junior': 'champion',
        'secondary': 'scholar',
        'higher_secondary': 'scholar',
        'advanced': 'elite'
    };
    return tierMap[problemLevel] || 'champion';
}

/**
 * Redirect to upgrade page with context
 */
function redirectToUpgrade(reason, suggestedTier = 'champion') {
    const params = new URLSearchParams({
        reason: reason,
        tier: suggestedTier,
        return: window.location.pathname
    });
    window.location.href = `upgrade.html?${params.toString()}`;
}

/**
 * Show upgrade modal
 */
function showUpgradeModal(message, suggestedTier = 'champion') {
    // Create modal HTML
    const modalHTML = `
        <div id="upgradeModal" style="
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            backdrop-filter: blur(3px);
        ">
            <div style="
                background: white;
                padding: 40px;
                border-radius: 20px;
                max-width: 500px;
                width: 90%;
                text-align: center;
                box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            ">
                <div style="font-size: 60px; margin-bottom: 20px;">🔒</div>
                <h2 style="color: #1F2937; margin-bottom: 16px; font-size: 28px;">Upgrade to Unlock</h2>
                <p style="color: #6B7280; margin-bottom: 30px; font-size: 16px; line-height: 1.6;">
                    ${message}
                </p>
                <button onclick="window.location.href='upgrade.html?tier=${suggestedTier}'" style="
                    background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%);
                    color: white;
                    padding: 16px 32px;
                    border: none;
                    border-radius: 12px;
                    font-size: 18px;
                    font-weight: 700;
                    cursor: pointer;
                    width: 100%;
                    margin-bottom: 12px;
                    box-shadow: 0 4px 12px rgba(245, 158, 11, 0.4);
                ">
                    🚀 Upgrade Now
                </button>
                <button onclick="document.getElementById('upgradeModal').remove()" style="
                    background: transparent;
                    color: #6B7280;
                    padding: 12px;
                    border: none;
                    font-size: 14px;
                    cursor: pointer;
                    width: 100%;
                ">
                    Maybe Later
                </button>
            </div>
        </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('upgradeModal');
    if (existingModal) {
        existingModal.remove();
    }

    // Add modal to page
    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

/**
 * Check if user is logged in, redirect if not
 */
async function requireLogin() {
    const sb = initSupabase();
    if (!sb) {
        window.location.href = 'login.html';
        return false;
    }

    const { data: { session } } = await sb.auth.getSession();
    
    if (!session) {
        window.location.href = 'login.html';
        return false;
    }

    return true;
}

/**
 * Get user's tier information for display
 */
async function getUserTierInfo() {
    const subscription = await getUserSubscription();
    
    if (!subscription) {
        return {
            tier: 'none',
            displayName: 'No Subscription',
            daysRemaining: 0,
            expired: true
        };
    }

    const now = new Date();
    const endDate = new Date(subscription.end_date);
    const daysRemaining = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));

    const tierNames = {
        'free_trial': 'Free Trial',
        'thinker': 'Thinker',
        'champion': 'Champion',
        'legend': 'Legend',
        'scholar': 'Scholar',
        'champion_annual': 'Champion Annual',
        'elite': 'Elite',
        'family': 'Family'
    };

    return {
        tier: subscription.tier,
        displayName: tierNames[subscription.tier] || subscription.tier,
        daysRemaining: Math.max(0, daysRemaining),
        expired: subscription.expired,
        endDate: subscription.end_date
    };
}

/**
 * Display subscription status badge
 */
async function displaySubscriptionBadge(containerId) {
    const tierInfo = await getUserTierInfo();
    const container = document.getElementById(containerId);
    
    if (!container) return;

    let badgeHTML = '';

    if (tierInfo.expired) {
        badgeHTML = `
            <div style="
                background: #FEE2E2;
                color: #DC2626;
                padding: 8px 16px;
                border-radius: 20px;
                font-size: 13px;
                font-weight: 700;
                display: inline-block;
                border: 1px solid #FCA5A5;
            ">
                ⚠️ Trial Expired
            </div>
        `;
    } else if (tierInfo.tier === 'free_trial') {
        badgeHTML = `
            <div style="
                background: #FEF3C7;
                color: #D97706;
                padding: 8px 16px;
                border-radius: 20px;
                font-size: 13px;
                font-weight: 700;
                display: inline-block;
                border: 1px solid #FCD34D;
            ">
                🎁 Free Trial • ${tierInfo.daysRemaining} days left
            </div>
        `;
    } else {
        badgeHTML = `
            <div style="
                background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%);
                color: white;
                padding: 8px 16px;
                border-radius: 20px;
                font-size: 13px;
                font-weight: 700;
                display: inline-block;
                box-shadow: 0 2px 8px rgba(245, 158, 11, 0.3);
            ">
                👑 ${tierInfo.displayName}
            </div>
        `;
    }

    container.innerHTML = badgeHTML;
}

// Export functions for use in other files
window.SubscriptionGuard = {
    getUserSubscription,
    canAccessLevel,
    requireLogin,
    redirectToUpgrade,
    showUpgradeModal,
    getUserTierInfo,
    displaySubscriptionBadge,
    getOlympiadAttemptCount
};
