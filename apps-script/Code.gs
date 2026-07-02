/**
 * WASTEFLOW — Waste Management System
 * Backend: Google Apps Script bound to the Google Sheet database.
 *
 * FILE MAP
 *  Code.gs        <- you are here: config, setup, sheet helpers
 *  Api_Auth.gs     <- login, session tokens, password hashing
 *  Api_Data.gs     <- CRUD for waste entries, lookups
 *  Api_Router.gs   <- doGet / doPost entry points
 *  Alerts.gs       <- daily / weekly email alerts (time-driven triggers)
 *
 * SETUP
 *  1. Extensions > Apps Script on your Google Sheet, paste each .gs file in as its own script file.
 *  2. Run `initializeWasteFlow` once from the editor (or use the "WasteFlow" menu after reloading
 *     the sheet) to create all tabs, seed the Items catalog, and create the first Admin user.
 *  3. Deploy > New deployment > Web app.
 *       Execute as:  Me
 *       Who has access: Anyone
 *  4. Copy the deployment URL into web/assets/config.js as API_URL.
 *
 * See README.md at the project root for full deployment instructions.
 */

// ── Configuration ──────────────────────────────────────────────────────────
const SHEET_NAMES = {
  LOG: 'WasteLog',
  ITEMS: 'Items',
  OUTLETS: 'Outlets',
  DEPARTMENTS: 'Departments',
  CATEGORIES: 'Categories',
  REASONS: 'Reasons',
  USERS: 'Users',
  SETTINGS: 'Settings'
};

const LOG_HEADERS = [
  'EntryID', 'Timestamp', 'Date', 'Outlet', 'Department', 'Category',
  'ItemName', 'Quantity', 'Unit', 'EstimatedCost', 'Reason', 'StaffName',
  'PhotoURL', 'Remarks', 'SubmittedBy', 'Status'
];

const ITEMS_HEADERS = ['ItemName', 'Category', 'DefaultUnit', 'DefaultCostPerUnit'];
const OUTLETS_HEADERS = ['OutletName', 'Active'];
const DEPARTMENTS_HEADERS = ['DepartmentName', 'Active'];
const CATEGORIES_HEADERS = ['CategoryName'];
const REASONS_HEADERS = ['ReasonName'];
const USERS_HEADERS = ['Username', 'PasswordHash', 'Salt', 'FullName', 'Role', 'Outlet', 'Email', 'Active'];
const SETTINGS_HEADERS = ['Key', 'Value'];

const DEFAULT_OUTLETS = ['Louvre', 'ARC', 'DGE', 'Al Qana', 'Khalidya'];
const DEFAULT_DEPARTMENTS = ['Kitchen', 'Pastry/Bakery', 'Front of House', 'Bar/Beverage', 'Store/Warehouse'];
const DEFAULT_REASONS = [
  'Expired / Spoiled', 'Overproduction', 'Prep Trim/Waste', 'Customer Return',
  'Order Error', 'Quality Issue', 'Dropped/Damaged', 'Delivery Rejected', 'Other'
];
const DEFAULT_SETTINGS = [
  ['CompanyName', 'Your F&B Group'],
  ['DailyAlertThresholdAED', '1500'],
  ['AlertEmail', ''],
  ['CurrencySymbol', 'AED']
];

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function ensureHeaders_(sh, headers) {
  const range = sh.getRange(1, 1, 1, headers.length);
  const current = range.getValues()[0];
  const needsWrite = headers.some((h, i) => current[i] !== h);
  if (needsWrite) {
    range.setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#16211C').setFontColor('#F6F4EE');
  }
}

/** Reads all data rows of a sheet as an array of objects keyed by header. */
function readAll_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(c => c === '')) continue;
    const obj = {};
    headers.forEach((h, idx) => obj[h] = row[idx]);
    obj._row = i + 1; // 1-indexed sheet row, for updates/deletes
    out.push(obj);
  }
  return out;
}

/** Menu item so non-developers can run setup from the Sheet UI. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('WasteFlow')
    .addItem('Initialize / Repair System', 'initializeWasteFlow')
    .addItem('Re-seed Items Catalog', 'seedItems')
    .addItem('Send Test Daily Alert', 'sendDailyAlertEmail')
    .addToUi();
}

/**
 * One-click setup: creates every tab with the right headers, seeds
 * outlets/departments/categories/reasons/settings, seeds the Items catalog,
 * and creates a default Admin login (admin / admin123 — CHANGE THIS).
 * Safe to re-run; it will not duplicate existing rows.
 */
function initializeWasteFlow() {
  const log = sheet_(SHEET_NAMES.LOG);
  ensureHeaders_(log, LOG_HEADERS);

  const items = sheet_(SHEET_NAMES.ITEMS);
  ensureHeaders_(items, ITEMS_HEADERS);

  const outlets = sheet_(SHEET_NAMES.OUTLETS);
  ensureHeaders_(outlets, OUTLETS_HEADERS);
  seedIfEmpty_(outlets, DEFAULT_OUTLETS.map(o => [o, 'Yes']));

  const depts = sheet_(SHEET_NAMES.DEPARTMENTS);
  ensureHeaders_(depts, DEPARTMENTS_HEADERS);
  seedIfEmpty_(depts, DEFAULT_DEPARTMENTS.map(d => [d, 'Yes']));

  const reasons = sheet_(SHEET_NAMES.REASONS);
  ensureHeaders_(reasons, REASONS_HEADERS);
  seedIfEmpty_(reasons, DEFAULT_REASONS.map(r => [r]));

  const settings = sheet_(SHEET_NAMES.SETTINGS);
  ensureHeaders_(settings, SETTINGS_HEADERS);
  seedIfEmpty_(settings, DEFAULT_SETTINGS);

  const cats = sheet_(SHEET_NAMES.CATEGORIES);
  ensureHeaders_(cats, CATEGORIES_HEADERS);

  seedItems(); // also derives + writes Categories from the items list

  const users = sheet_(SHEET_NAMES.USERS);
  ensureHeaders_(users, USERS_HEADERS);
  if (readAll_(SHEET_NAMES.USERS).length === 0) {
    createUser_('admin', 'admin123', 'System Admin', 'Admin', 'All', '');
  }

  SpreadsheetApp.getUi().alert(
    'WasteFlow initialized.\n\nDefault login:\n  username: admin\n  password: admin123\n\n' +
    'Please log in and change this password immediately from the Admin > Manage Users screen.'
  );
}

function seedIfEmpty_(sh, rows) {
  if (readAll_(sh.getName()).length > 0 || rows.length === 0) return;
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

/**
 * Seeds (or re-seeds) the Items catalog from the client's master item list.
 * Re-running will ADD any items that are missing but will not touch rows
 * that already exist, so it is safe to run after you've edited categories
 * or costs by hand.
 */
function seedItems() {
  const sh = sheet_(SHEET_NAMES.ITEMS);
  ensureHeaders_(sh, ITEMS_HEADERS);
  const existing = readAll_(SHEET_NAMES.ITEMS);
  const existingNames = new Set(existing.map(r => String(r.ItemName).toLowerCase()));

  const toAdd = ITEM_SEED_DATA.filter(r => !existingNames.has(String(r[0]).toLowerCase()));
  if (toAdd.length > 0) {
    sh.getRange(sh.getLastRow() + 1, 1, toAdd.length, ITEMS_HEADERS.length).setValues(toAdd);
  }

  // Keep the Categories tab in sync with whatever categories are in use.
  const all = readAll_(SHEET_NAMES.ITEMS);
  const cats = Array.from(new Set(all.map(r => r.Category).filter(Boolean))).sort();
  const catSh = sheet_(SHEET_NAMES.CATEGORIES);
  ensureHeaders_(catSh, CATEGORIES_HEADERS);
  const existingCats = new Set(readAll_(SHEET_NAMES.CATEGORIES).map(r => r.CategoryName));
  const newCats = cats.filter(c => !existingCats.has(c)).map(c => [c]);
  if (newCats.length > 0) {
    catSh.getRange(catSh.getLastRow() + 1, 1, newCats.length, 1).setValues(newCats);
  }
}
