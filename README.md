# WasteFlow — Multi-Outlet Waste Management System

A mobile waste-logging form for staff + a role-based admin dashboard, backed entirely
by a Google Sheet. No database, no server to maintain — Google Sheets *is* the database,
Google Apps Script is the API, and the frontend is static HTML/JS you can host anywhere
(GitHub Pages is the easiest option and what these instructions assume).

```
staff on their phone → index.html → Apps Script Web App (API) → Google Sheet
admin on the dashboard → admin.html ────────────┘
```

Your master item list (400 items, deduplicated and auto-categorized from the file you
shared) is already built into the system as the seed for the **Items** tab — see
`apps-script/ItemSeedData.gs`.

---

## 1. What's in this folder

```
wasteflow/
├── apps-script/            Backend — paste into Google Apps Script (bound to your Sheet)
│   ├── appsscript.json      Manifest (web app access settings)
│   ├── Code.gs               Config, sheet setup/seeding, onOpen menu
│   ├── ItemSeedData.gs       Your 400-item master catalog (auto-categorized)
│   ├── Api_Auth.gs           Login, password hashing, sessions
│   ├── Api_Data.gs           Waste entry CRUD, role-scoped reads, photo upload
│   ├── Api_Router.gs         doGet/doPost — the single API entry point
│   └── Alerts.gs             Daily threshold + weekly summary emails
├── web/                     Frontend — host as a static site (e.g. GitHub Pages)
│   ├── index.html             Staff mobile submission form
│   ├── admin.html             Admin/manager dashboard
│   └── assets/
│       ├── config.js           ← put your Apps Script URL + Sheet URL here
│       ├── styles.css          Shared design system
│       ├── api.js              API client, session, toast, theme, offline queue
│       ├── staff.js            Staff form logic
│       └── admin.js            Dashboard logic
└── data/
    └── items_master.csv       Reference copy of the cleaned item list (for your records)
```

---

## 2. Set up the Google Sheet backend (10 minutes)

1. Open your Google Sheet: `https://docs.google.com/spreadsheets/d/1DHSast77Nz7KcjLztIrqQJOwkXYZN2V4NpxgNxucxV0/edit`
   (or a fresh Sheet — the system builds its own tabs, it doesn't need your existing layout).
2. **Extensions → Apps Script**. Delete the default empty `Code.gs` content.
3. Create each file listed under `apps-script/` above as its own script file (use the
   **+** next to "Files" and match the names exactly, including the `.gs` files as
   Script files). Paste in the matching content from this project.
4. Also replace the contents of `appsscript.json` (click the gear icon → "Show
   `appsscript.json`" if it's not visible) with the one in this project.
5. In the Apps Script toolbar, select the function **`initializeWasteFlow`** and click
   **Run**. The first run will ask you to authorize the script (it needs to read/write
   your Sheet, create a Drive folder for photos, and send email) — approve it.
6. This creates every tab (`WasteLog`, `Items`, `Outlets`, `Departments`, `Categories`,
   `Reasons`, `Users`, `Settings`), seeds your 400-item catalog, seeds your 5 outlets
   (Louvre, ARC, DGE, Al Qana, Khalidya), and creates one login:
   ```
   username: admin
   password: admin123
   ```
   **Change this password immediately** after your first login (Dashboard → your name
   isn't clickable yet in v1 — for now, change it directly: Users tab is not where
   passwords live; use the `changePassword` API or simplest, edit the `Users` sheet
   row and re-hash by re-running `createUser_('admin', 'newpassword', ...)` once from
   the Apps Script editor, or just add a new Admin user from the dashboard and disable
   the default one).
7. Reload the Sheet — you'll now see a **WasteFlow** menu with "Initialize / Repair
   System", "Re-seed Items Catalog", and "Send Test Daily Alert". Re-running
   Initialize is always safe — it never duplicates existing rows.

### Deploy the Web App (this is your API URL)

1. In Apps Script: **Deploy → New deployment**.
2. Type: **Web app**.
3. Execute as: **Me**. Who has access: **Anyone**.
4. Click **Deploy**, authorize again if asked, and copy the URL — it ends in `/exec`.
5. Paste it into `web/assets/config.js` as `API_URL`.

Whenever you edit the `.gs` files later, you must **Deploy → Manage deployments → edit
(pencil) → New version** for changes to go live — Apps Script web apps don't auto-update
on save.

---

## 3. Host the frontend (GitHub Pages, ~2 minutes)

1. Push the `web/` folder to a GitHub repo (root of the repo, or a `/docs` folder).
2. Repo **Settings → Pages** → set the source branch/folder → Save.
3. Your staff form will be live at `https://<you>.github.io/<repo>/index.html` and the
   dashboard at `.../admin.html`.
4. Before pushing, double check `web/assets/config.js` has your real `API_URL` and
   `SHEET_URL` — the Settings page links out to the Sheet for alert configuration.

You can also just open `index.html`/`admin.html` locally or host them on any static
file host (Netlify, Vercel, Firebase Hosting, a plain S3 bucket) — nothing here depends
on GitHub specifically.

---

## 4. Data structure (the Sheet tabs)

| Tab | Purpose | Key columns |
|---|---|---|
| **WasteLog** | Every waste entry (the real "database") | EntryID, Date, Outlet, Department, Category, ItemName, Quantity, Unit, EstimatedCost, Reason, StaffName, PhotoURL, Remarks, SubmittedBy, Status |
| **Items** | Master catalog powering the mobile item picker | ItemName, Category, DefaultUnit, DefaultCostPerUnit |
| **Outlets** | Louvre, ARC, DGE, Al Qana, Khalidya + any you add | OutletName, Active |
| **Departments** | Kitchen, Pastry/Bakery, Front of House, Bar/Beverage, Store/Warehouse | DepartmentName, Active |
| **Categories** | Auto-derived from Items; drives the category filter | CategoryName |
| **Reasons** | Dropdown options for "Reason for waste" | ReasonName |
| **Users** | Login accounts | Username, PasswordHash, Salt, FullName, Role, Outlet, Email, Active |
| **Settings** | CompanyName, DailyAlertThresholdAED, AlertEmail, CurrencySymbol | Key, Value |

**Adding a new outlet is a one-row edit** — either type it directly into the `Outlets`
tab, or use Admin → Settings in the dashboard, which does the same thing through the API.

**About the Items catalog**: the categorization and default units were assigned
automatically from your raw product list using keyword matching, so it's a solid
starting point but not perfect — a few entries landed in "Other / Uncategorized" or
got a guessed unit. Spend 15 minutes reviewing the `Items` tab once, fix any
miscategorized rows and fill in `DefaultCostPerUnit` where you know it (this makes the
mobile form auto-suggest Estimated Cost when staff enter a quantity). Re-running
"Re-seed Items Catalog" from the menu will only *add* missing items — it never
overwrites your corrections.

---

## 5. User roles

| Role | Can do |
|---|---|
| **Admin** | Everything: all outlets, edit/delete any entry, manage users, add outlets/departments/reasons, reports |
| **Outlet Manager** | Submit entries, view only their outlet's data, edit/delete only *today's* entries for their outlet |
| **Staff** | Submit entries, view only their own past submissions |

Roles are enforced **server-side** in `Api_Data.gs` (not just hidden in the UI), so a
Manager account can never pull another outlet's data even by calling the API directly.

The mobile form (`index.html`) does **not** require login — anyone at the outlet can
type their name and submit (kiosk-style, common for shared tablets). If a staff member
signs in first, their name and outlet auto-fill and lock in.

---

## 6. Alerts

- **Daily threshold alert**: fires automatically the moment a submission pushes an
  outlet's same-day total over `DailyAlertThresholdAED` (set in the `Settings` tab).
  Off by default until you fill in `AlertEmail`.
- **Weekly summary**: `sendWeeklySummary()` in `Alerts.gs` is written but not
  auto-scheduled. To enable it: Apps Script editor → clock icon (Triggers) → **Add
  Trigger** → function `sendWeeklySummary` → Time-driven → Week timer.
- **Dashboard alerts**: the Overview page's "Insights" panel flags unusually
  high-cost entries directly in the UI (statistical outliers vs. their category's
  norm) — no email needed for this one.

---

## 7. What's built vs. what's a next step

**Built and working:** mobile form with searchable 400-item catalog, offline queue with
auto-sync, photo upload to Drive, role-based login, KPI cards, outlet leaderboard, 8
charts, sortable/searchable/paginated records table with inline edit/delete, CSV/Excel/PDF
export, 5 report types with print/PDF output, user management, growable
outlets/departments/reasons, dark mode, daily + weekly email alerts, basic anomaly
detection.

**Intentionally left as a next step** (flagged rather than half-built):
- **Barcode scanning** — would need a camera-based barcode library (e.g. `quaggaJS`)
  wired to match against the Items catalog by SKU; the catalog doesn't currently carry
  SKUs.
- **Forecasting** — a real forecast needs more history than a fresh system has; once
  you have a few months of data, a simple moving-average or linear trend per outlet/item
  is a reasonable first version.
- **True enterprise SSO** — current auth is username/password suited to an internal
  tool. For stronger guarantees, restrict the Web App deployment to your Google
  Workspace domain, or swap `Api_Auth.gs` for verifying Google Sign-In ID tokens.

---

## 8. Local testing without deploying

You can preview the UI without a live backend — `config.js`'s placeholder API_URL will
show clear "not connected" errors instead of failing silently. Once you've deployed the
Apps Script Web App and pasted the URL in, everything connects immediately — no rebuild
step, since this is plain HTML/JS.
