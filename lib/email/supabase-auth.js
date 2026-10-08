// The email API is called by the cloud OpticAdmin app, not by this app's own
// pages, so it authenticates the caller's Supabase session instead of a local
// login: the bearer token is checked against Supabase Auth and the user must
// hold a staff role in public.user_roles.

const DEFAULT_SUPABASE_URL = "https://xstmeirxhfbiyayrrsob.supabase.co";
const STAFF_ROLES = new Set(["admin", "operator"]);
const CACHE_MS = 60 * 1000;

function bearerToken(header) {
  const match = String(header || "").match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

function createSupabaseStaffAuth({
  supabaseUrl = process.env.OPTILENS_SUPABASE_URL || DEFAULT_SUPABASE_URL,
  getAnonKey,
  fetchFn = fetch,
  now = () => Date.now()
} = {}) {
  if (typeof getAnonKey !== "function") throw new TypeError("getAnonKey is required.");
  const cache = new Map();

  async function getJson(path, token, anonKey) {
    const response = await fetchFn(`${supabaseUrl.replace(/\/+$/, "")}${path}`, {
      headers: { apikey: anonKey, authorization: `Bearer ${token}` }
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw Object.assign(new Error(`Supabase returned ${response.status} while checking the session.`), { statusCode: 502 });
    return response.json();
  }

  async function verify(authorizationHeader) {
    const token = bearerToken(authorizationHeader);
    if (!token) throw Object.assign(new Error("Sign in to OpticAdmin to use Email."), { statusCode: 401 });

    const cached = cache.get(token);
    if (cached && cached.expiresAt > now()) return cached.user;

    const anonKey = getAnonKey();
    if (!anonKey) throw Object.assign(new Error("The bridge has no Supabase project key. Start the live gateway once on the Integrations page."), { statusCode: 503 });

    const user = await getJson("/auth/v1/user", token, anonKey);
    if (!user?.id) throw Object.assign(new Error("Your OpticAdmin session has expired. Sign in again."), { statusCode: 401 });

    const roles = await getJson(`/rest/v1/user_roles?select=role&user_id=eq.${encodeURIComponent(user.id)}`, token, anonKey) || [];
    const isStaff = roles.some((row) => STAFF_ROLES.has(row.role));
    if (!isStaff) throw Object.assign(new Error("Email is available to admin and operator accounts only."), { statusCode: 403 });

    const result = { id: user.id, email: user.email || null };
    if (cache.size > 500) cache.clear();
    cache.set(token, { user: result, expiresAt: now() + CACHE_MS });
    return result;
  }

  return { verify };
}

module.exports = { bearerToken, createSupabaseStaffAuth, STAFF_ROLES };
