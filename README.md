# Santiano shop

An online shop (think Jumia or Temu, but yours): customers browse, add to cart and pay with Paystack. **You** add the products from an admin page, and they are stored in **Supabase**.

Node.js 22.13+. Run `npm install` once (it installs `pg`, the Postgres driver).

## Set up in 10 minutes

1. **Supabase.** Create a project at supabase.com. Open **SQL Editor**, paste all of `sql/supabase.sql` and press **Run**. It creates the `products` table, a public `product-images` bucket for photos, a stock function, and the shop tables (users, orders, order items, reviews, discount codes, notifications, support requests, settings and the accounting tables).
2. **Keys.** In Supabase go to **Settings → API** and copy the project URL and the **service_role** key.
3. **Database URL.** In Supabase click **Connect**, choose **Session pooler**, and copy the connection string (replace `[YOUR-PASSWORD]` with your database password; if it has special characters such as `@` or `#`, URL-encode them). This is what keeps users and orders permanently in Supabase.
4. **Config.** `npm install`, then `cp .env.example .env` and fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `APP_SECRET`.
5. **Run.** `npm start`, then open http://localhost:3000. Sign in at **/admin-login.html** with your admin email (buyers use `/login.html`). Forgot it? Run `npm run reset-admin -- you@example.com "new-password"`.

Without a Paystack key the shop runs in **demo payment mode**: orders are marked paid without charging anyone. Add `PAYSTACK_SECRET_KEY` before going live (and add `YOUR_URL/api/webhooks/paystack` as the webhook in Paystack).

## Adding products

* **Admin page → Products → Add product.** Name, category, price, old price (shows a discount badge), stock, sizes, colours, description and up to 8 photos. Photos are resized in your browser and stored in Supabase Storage.
* **Or straight in Supabase.** Table editor → `products` → insert a row. Arrays (`sizes`, `colours`, `images`) take values like `{38,39,40}`. New rows show in the shop within about 15 seconds.
* Leave **stock** empty if you do not track it (the item is always available). Untick **Show in the shop** (or set `active = false`) to hide an item without deleting it.

## What the admin page does

Overview (sales, low stock, setup status) · **Accounts** (see below) · Products (add, edit, hide, delete, photos) · Orders (mark preparing / on the way / delivered, refund through Paystack and restock) · Customers · Support requests · Discount codes · Settings (shop name, delivery fee, free-delivery threshold, pickup, returns policy, password) · Activity log.

## Accounts (profit & loss, balance sheet, downloads)

Admin page → **Accounts**. It keeps proper double-entry books, rebuilt from your orders, refunds and the records you enter, so every report agrees with every other one and the trial balance always balances.

**Reports** (any period: this month, last month, quarter, year, financial year, all time, or custom dates):
Summary (key numbers, break-even, month-by-month) · Profit & loss · Balance sheet · Cash flow · Trial balance · Profit by product and category · Stock value · Journal (every transaction) · VAT summary.

**Records you enter:** Expenses (rent, salaries, ads, packaging…) · Owner & stock (money you put in or took out, loans, stock bought, opening stock) · Equipment (depreciated monthly) · Cost prices (what each product costs you) · Tax & settings (VAT, income-tax rate, Paystack fee formula, financial-year start).

**Download:** one Excel workbook with every report on its own sheet, a CSV of the report you are looking at, or a print-ready page you can save as PDF. Downloads are written to the activity log.

First-time setup, in this order: (1) Cost prices, (2) Owner & stock → money you started with and any stock you already owned, (3) Tax & settings. The Summary page warns you about anything that makes the figures unreliable (demo payments on, products sold with no cost, books vs. real stock mismatch).

Notes: sales are dated in Nigerian time (UTC+1). Payment fees are *calculated* from your settings, so compare them with your Paystack statement. Tax figures are estimates; check the rates that apply to you with an accountant. Cost prices are stored in the `product_costs` table in your database.

## How it works

* **Products and photos** live in Supabase. The server reads them with the service-role key (which never reaches the browser), caches them in memory for 15 seconds and keeps serving the cache if Supabase has a short outage.
* **Customers, orders, reviews, discount codes, notifications, support requests, settings and accounting records** are stored in Supabase Postgres (set `DATABASE_URL`), so they survive restarts and redeploys on any host. Carts live in the shopper's browser and become an order at checkout. Supabase has its own backups; check your plan. If `DATABASE_URL` is empty the shop falls back to a local SQLite file (`data/shop.db`), which is only suitable for development.
* **Checkout** re-prices everything on the server, checks stock live in Supabase, and only marks an order paid after Paystack confirms the amount (return page or signed webhook). Paid orders take stock out in Supabase; refunds put it back.
* There are no subscriptions, plans or seller accounts. There is one shop and one admin.

## Layout

```
server/  accounting.js (double-entry engine) · xlsx.js (Excel writer) · index.js · http.js · config.js · db.js (Supabase Postgres, or SQLite when DATABASE_URL is empty) · supa.js (Supabase REST + Storage) · catalog.js (product cache, search)
         auth.js · paystack.js · mail.js · bootstrap.js · routes/{public,market,shop,admin,accounting}.js
public/  index.html + js/store.js, store2.js (shop)   admin.html + js/admin.js   login.html / register.html + js/auth.js
         css/styles.css, store.css, cirra.css          js/fx.js (animations)
sql/     supabase.sql  (run once in Supabase)
scripts/ e2e.js + accounting-test.js (npm test: 65 + 45 checks against a mock Supabase) · mock-supabase.js (run it to develop without a project)
```

## Developing without Supabase

`node scripts/mock-supabase.js` starts a stand-in on port 54321. Then: `SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_ROLE_KEY=mock-key npm start`. Data is in memory only.

## Before launch

* HTTPS, a long random `APP_SECRET`, a strong `ADMIN_PASSWORD`, `PAYSTACK_SECRET_KEY` set (use an `sk_test_` key first).
* Set `RESEND_API_KEY` for order emails, otherwise they are only logged.
* Paystack and Supabase calls are verified here against mocks only, not the live services. Do one real test order and one real photo upload before announcing.
