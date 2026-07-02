/**
 * Single entry point for the whole API. The static frontend (GitHub Pages,
 * or any static host) POSTs a JSON body with an `action` field, e.g.:
 *
 *   fetch(API_URL, {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
 *     body: JSON.stringify({ action: 'login', username, password })
 *   })
 *
 * GET requests are supported too (action passed as a query param) for
 * simple read-only calls like `?action=lookups`.
 */

function doGet(e) {
  try {
    const action = e.parameter.action;
    const body = e.parameter; // GET params double as the "body" for read-only calls
    return respond_(route_(action, body));
  } catch (err) {
    return respond_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    return respond_(route_(body.action, body));
  } catch (err) {
    return respond_({ ok: false, error: String(err) });
  }
}

function route_(action, body) {
  switch (action) {
    case 'lookups': return apiLookups_();
    case 'login': return apiLogin_(body);
    case 'logout': return apiLogout_(body);
    case 'changePassword': return apiChangePassword_(body);
    case 'submitEntry': return apiSubmitEntry_(body);
    case 'entries': return apiGetEntries_(body);
    case 'updateEntry': return apiUpdateEntry_(body);
    case 'deleteEntry': return apiDeleteEntry_(body);
    case 'addUser': return apiAddUser_(body);
    case 'setUserActive': return apiSetUserActive_(body);
    case 'listUsers': return apiListUsers_(body);
    case 'addLookup': return apiAddLookup_(body);
    default: return { ok: false, error: 'Unknown action: ' + action };
  }
}

function apiListUsers_(body) {
  const session = getSession_(body.token);
  if (!session || session.role !== 'Admin') return { ok: false, error: 'Admin access required.' };
  const users = readAll_(SHEET_NAMES.USERS).map(u => ({
    username: u.Username, fullName: u.FullName, role: u.Role, outlet: u.Outlet, email: u.Email, active: u.Active
  }));
  return { ok: true, users };
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
