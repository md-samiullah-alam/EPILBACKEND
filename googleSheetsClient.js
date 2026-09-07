const { google } = require("googleapis");

// ============================================================
// GOOGLE SHEETS CONNECTION WITH AUTO-RETRY ON AUTH ERRORS
// Handles "invalid_grant: Invalid JWT" errors caused by:
// - Clock skew between server and Google
// - Token expiration (JWT tokens only valid for 60 minutes)
// - Cached client with expired credentials
// ============================================================

let cachedClient = null;
let cachedAuth = null;
let lastInitTime = null;
const CACHE_TTL = 45 * 60 * 1000; // 45 minutes (well under 60 min token expiry)

/**
 * Creates a fresh authenticated Google Sheets client with NEW auth instance
 * This forces a new JWT token generation
 */
async function createFreshClient() {
  // Create NEW auth instance each time to force fresh JWT
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  // Force get a fresh client (this generates new JWT)
  const client = await auth.getClient();
  
  // Also force token refresh to get fresh JWT
  try {
    await client.refreshAccessToken();
  } catch (e) {
    // Ignore refresh errors, will fail on actual API call if needed
  }

  cachedAuth = auth;
  return google.sheets({ version: "v4", auth: client });
}

/**
 * Get Google Sheets client with automatic retry on auth failures
 * @param {number} retryCount - Number of retries attempted (internal use)
 */
async function getSheets(retryCount = 0) {
  const now = Date.now();

  // Return cached client if valid and not expired
  if (cachedClient && lastInitTime && (now - lastInitTime) < CACHE_TTL) {
    return cachedClient;
  }

  try {
    // Create fresh client with new auth instance
    cachedClient = await createFreshClient();
    lastInitTime = now;
    return cachedClient;
  } catch (error) {
    // Check if it's an invalid_grant error (JWT token issue)
    const isInvalidGrant = error.message?.includes('invalid_grant') || 
                           error.code === 400 ||
                           error.response?.data?.error === 'invalid_grant';
    
    if (isInvalidGrant && retryCount < 2) {
      console.warn(`[GoogleSheets] Invalid grant error during client creation, retrying... (attempt ${retryCount + 1})`);
      invalidateCache();
      await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
      return getSheets(retryCount + 1);
    }
    
    console.error('[GoogleSheets] Failed to create client:', error.message);
    throw error;
  }
}

/**
 * Force refresh the cached client (for credential rotation or after auth errors)
 */
function invalidateCache() {
  cachedClient = null;
  cachedAuth = null;
  lastInitTime = null;
}

/**
 * Wrapper to execute sheets API calls with automatic auth retry
 * USE THIS FOR ALL GOOGLE SHEETS API CALLS to handle token expiration gracefully
 * 
 * @param {Function} apiCall - Async function that receives sheets client and returns result
 * @returns {Promise<any>} Result of apiCall
 */
async function withSheets(apiCall) {
  let attempt = 0;
  const maxAttempts = 3;
  
  while (attempt < maxAttempts) {
    try {
      const sheets = await getSheets();
      return await apiCall(sheets);
    } catch (error) {
      const isAuthError = error.message?.includes('invalid_grant') ||
                          error.message?.includes('Invalid JWT') ||
                          error.message?.includes('unauthorized') ||
                          error.code === 401 ||
                          error.response?.status === 401 ||
                          error.response?.data?.error === 'invalid_grant' ||
                          error.response?.data?.error?.includes?.('invalid_grant');
      
      if (isAuthError && attempt < maxAttempts - 1) {
        console.warn(`[GoogleSheets] Auth error on attempt ${attempt + 1}/${maxAttempts}, invalidating cache and retrying...`);
        console.warn(`[GoogleSheets] Error: ${error.message}`);
        invalidateCache();
        attempt++;
        // Brief delay before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Execute with guaranteed fresh client (no cache)
 * Use for critical operations that must not fail due to stale tokens
 */
async function withFreshSheets(apiCall) {
  invalidateCache();
  return withSheets(apiCall);
}

module.exports = { getSheets, invalidateCache, withSheets, withFreshSheets };