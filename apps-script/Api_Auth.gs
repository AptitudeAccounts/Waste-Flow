/**
 * Basic username/password auth suitable for an internal staff tool.
 * Sessions are opaque tokens held in Apps Script's CacheService (12h TTL) —
 * nothing sensitive is ever stored client-side except the token itself.
 *
 * NOTE ON SECURITY: this is adequate for an internal team tool behind a
 * private link, not a bank-grade auth system. If you need stronger
 * guarantees (SSO, audit-proof access control), front this with Google
 * Workspace domain restriction on the Web App deployment, or swap this
 * module for Google Sign-In and verify the ID token server-side instead.
 */

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

function hashPassword_(password, salt) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt + ':' + password,
    Utilities.Charset.UTF_8
  );
  return raw.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

function makeSalt_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 16);
}

function createUser_(username, password, fullName, role, outlet, email) {
  const sh = sheet_(SHEET_NAMES.USERS);
  const salt = makeSalt_();
  const hash = hashPassword_(password, salt);
  sh.appendRow([username, hash, salt, fullName, role, outlet, email, 'Yes']);
}

/** action=login  { username, password } -> { token, role, outlet, fullName, username } */
function apiLogin_(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return { ok: false, error: 'Username and password are required.' };

  const users = readAll_(SHEET_NAMES.USERS);
  const user = users.find(u => String(u.Username).toLowerCase() === username.toLowerCase());
  if (!user || String(user.Active).toLowerCase() !== 'yes') {
    return { ok: false, error: 'Invalid username or password.' };
  }
  const hash = hashPassword_(password, user.Salt);
  if (hash !== user.PasswordHash) {
    return { ok: false, error: 'Invalid username or password.' };
  }

  const token = Utilities.getUuid();
  const session = { username: user.Username, role: user.Role, outlet: user.Outlet, fullName: user.FullName };
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(session), SESSION_TTL_SECONDS);

  return { ok: true, token: token, role: user.Role, outlet: user.Outlet, fullName: user.FullName, username: user.Username };
}

/** Resolves a session token to {username, role, outlet, fullName} or null if invalid/expired. */
function getSession_(token) {
  if (!token) return null;
  const raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) return null;
  return JSON.parse(raw);
}

function apiLogout_(body) {
  const token = body.token;
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return { ok: true };
}

/** action=changePassword  { token, oldPassword, newPassword } */
function apiChangePassword_(body) {
  const session = getSession_(body.token);
  if (!session) return { ok: false, error: 'Session expired. Please log in again.' };

  const sh = sheet_(SHEET_NAMES.USERS);
  const users = readAll_(SHEET_NAMES.USERS);
  const user = users.find(u => u.Username === session.username);
  if (!user) return { ok: false, error: 'User not found.' };

  const oldHash = hashPassword_(body.oldPassword || '', user.Salt);
  if (oldHash !== user.PasswordHash) return { ok: false, error: 'Current password is incorrect.' };
  if (!body.newPassword || String(body.newPassword).length < 6) {
    return { ok: false, error: 'New password must be at least 6 characters.' };
  }

  const newSalt = makeSalt_();
  const newHash = hashPassword_(body.newPassword, newSalt);
  const headers = USERS_HEADERS;
  sh.getRange(user._row, headers.indexOf('PasswordHash') + 1).setValue(newHash);
  sh.getRange(user._row, headers.indexOf('Salt') + 1).setValue(newSalt);
  return { ok: true };
}

/** action=addUser  { token, username, password, fullName, role, outlet, email } — Admin only */
function apiAddUser_(body) {
  const session = getSession_(body.token);
  if (!session || session.role !== 'Admin') return { ok: false, error: 'Admin access required.' };

  const users = readAll_(SHEET_NAMES.USERS);
  if (users.some(u => String(u.Username).toLowerCase() === String(body.username).toLowerCase())) {
    return { ok: false, error: 'That username already exists.' };
  }
  if (!body.username || !body.password || body.password.length < 6) {
    return { ok: false, error: 'Username and a password of 6+ characters are required.' };
  }
  createUser_(body.username, body.password, body.fullName || '', body.role || 'Staff', body.outlet || 'All', body.email || '');
  return { ok: true };
}

/** action=setUserActive { token, username, active } — Admin only, used to disable/enable accounts */
function apiSetUserActive_(body) {
  const session = getSession_(body.token);
  if (!session || session.role !== 'Admin') return { ok: false, error: 'Admin access required.' };
  const sh = sheet_(SHEET_NAMES.USERS);
  const users = readAll_(SHEET_NAMES.USERS);
  const user = users.find(u => u.Username === body.username);
  if (!user) return { ok: false, error: 'User not found.' };
  sh.getRange(user._row, USERS_HEADERS.indexOf('Active') + 1).setValue(body.active ? 'Yes' : 'No');
  return { ok: true };
}
