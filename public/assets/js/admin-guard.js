/**
 * LOGICPALS ADMIN GUARD
 * Security layer for admin dashboard access
 * Version: 1.0
 */

// Supabase configuration
const SUPABASE_URL = 'https://ovszuxerimbmzfblzkgd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92c3p1eGVyaW1ibXpmYmx6a2dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1MDA4MzgsImV4cCI6MjA4MDA3NjgzOH0.cmMF8OsC8J_B-t0aBldiMqv4XiNZtJWSGMqg8At9V14';

// ADMIN EMAIL LIST
// Add your admin emails here
const ADMIN_EMAILS = [
    'jahir3001@gmail.com',
    'admin@logicpals.com'
];

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
 * Check if current user is admin
 */
async function isAdmin() {
    const sb = initSupabase();
    if (!sb) return false;

    try {
        const { data: { session }, error } = await sb.auth.getSession();
        
        if (error || !session) {
            console.error('No active session');
            return false;
        }

        const userEmail = session.user.email;
        
        // Check if email is in admin list
        const isAdminUser = ADMIN_EMAILS.includes(userEmail.toLowerCase());
        
        if (isAdminUser) {
            console.log('✅ Admin access granted:', userEmail);
        } else {
            console.warn('❌ Admin access denied:', userEmail);
        }
        
        return isAdminUser;

    } catch (err) {
        console.error('Error checking admin status:', err);
        return false;
    }
}

/**
 * Require admin access - redirect if not admin
 */
async function requireAdmin() {
    const adminAccess = await isAdmin();
    
    if (!adminAccess) {
        // Not admin - show access denied
        document.body.innerHTML = `
            <div style="
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100vh;
                font-family: 'Inter', sans-serif;
                background: linear-gradient(135deg, #FEE2E2 0%, #FECACA 100%);
                padding: 20px;
                text-align: center;
            ">
                <div style="font-size: 80px; margin-bottom: 20px;">🚫</div>
                <h1 style="color: #991B1B; font-size: 32px; margin-bottom: 12px;">Access Denied</h1>
                <p style="color: #7F1D1D; font-size: 16px; margin-bottom: 30px; max-width: 400px;">
                    You do not have permission to access the admin dashboard.
                </p>
                <a href="dashboard.html" style="
                    background: #DC2626;
                    color: white;
                    padding: 14px 28px;
                    border-radius: 10px;
                    text-decoration: none;
                    font-weight: 700;
                    box-shadow: 0 4px 6px rgba(220, 38, 38, 0.3);
                ">
                    Return to Dashboard
                </a>
            </div>
        `;
        return false;
    }

    // User IS admin - just return true, don't modify the page
    return true;
}

/**
 * Get current admin user info
 */
async function getAdminUser() {
    const sb = initSupabase();
    if (!sb) return null;

    try {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return null;

        return {
            id: session.user.id,
            email: session.user.email,
            name: session.user.user_metadata?.full_name || 'Admin'
        };
    } catch (err) {
        console.error('Error getting admin user:', err);
        return null;
    }
}

/**
 * Log admin action (for audit trail)
 */
async function logAdminAction(action, details) {
    const adminUser = await getAdminUser();
    if (!adminUser) return;

    const logEntry = {
        admin_email: adminUser.email,
        action: action,
        details: details,
        timestamp: new Date().toISOString()
    };

    console.log('📝 Admin Action:', logEntry);

    // TODO: Store in database for audit trail
    // For now, just console log
    
    return logEntry;
}

// Export functions
window.AdminGuard = {
    isAdmin,
    requireAdmin,
    getAdminUser,
    logAdminAction,
    ADMIN_EMAILS
};
