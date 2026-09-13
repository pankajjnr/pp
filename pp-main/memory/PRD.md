# PRD — Ledger Book + Material Procurement (Imported from GitHub)

## Origin
- Repository: https://github.com/purwarharsh10315-ui/eMERGENT.git
- Imported into `/app` on 2026-01-03.

## Problem Statement
Import project from GitHub, then extend with a standalone **Material Procurement Web Application** — 3 unintegrated modules (Procurement Log, Client Subledger, Product Ledger) — while keeping the existing Ledger Book (payments/clients) untouched.

## App Overview
- **Existing (Ledger Book)** — FastAPI + React + MongoDB app for daily payment tracking; features JWT auth, brute-force lockout, CSV/PDF exports.
- **New (Material Procurement)** — 3 sibling modules sharing the client master; own product master + own transactions collection. **No data integration** between procurement entries and the payment ledger, as required.

## Setup Completed (2026-01-03)
- Cloned repo → `/app` (preserved `.git`, `.emergent`, `.env`).
- Installed backend deps (skipped `emergentintegrations`/`litellm` — unused, resolver conflict).
- Installed frontend deps via `yarn`.
- Added missing `JWT_SECRET` to `backend/.env`.
- Verified admin login (`admin@ledger.app` / `admin123`).

## Material Procurement Module — Delivered
### Backend (`/app/backend/server.py`)
- Collections: `master_products`, `procurement_entries` (both indexed).
- Auto-seed on startup: `Maize`, `Wheat`, `Bajra`.
- Endpoints (all JWT-protected, prefixed `/api/procurement/*`):
  - `GET /procurement/products` — list master products
  - `POST /procurement/products` — add product
  - `DELETE /procurement/products/{id}` — admin only
  - `POST /procurement/entries` — create entry (server computes `total_amount = weight × rate`)
  - `GET /procurement/entries?client_id=&product_id=&entry_date=` — dynamic optimized filter

### Frontend (React + Tailwind + shadcn/ui)
- `/procurement/log` — Procurement Log with dropdowns (client, product), read-only auto-calculated total, and log table.
- `/procurement/client-subledger` — pick a client → chronological table of that client's procurement rows (no balance integration).
- `/procurement/product-ledger` — product buttons + calendar date picker (default = today); "Calculate Summary" and "Weighted Avg Rate" buttons gate results behind `useState` (only show after click). Weighted avg = totalCost ÷ totalWeight.

### Verified with seeded data (2026-07-03, Maize):
- 2 entries: 250.5kg @ ₹22.50 + 100kg @ ₹23.00 → 350.5kg, ₹7,936.25, weighted avg ₹22.64/kg ✓

## Backlog / Next Actions
- P2: Optional master-product management UI (currently seeded + admin API only).
- P2: Multi-day / date-range procurement reports if user wants aggregation across days.
- P2: CSV/PDF export for procurement entries mirroring the existing ledger exports.

## Notes
- Auth uses HS256 JWT, 12h expiry, brute-force lockout after 5 failed attempts for 15 minutes.
- Currency displayed as INR (₹). Client names decorated as "Shree {name} Ji" on display only.
