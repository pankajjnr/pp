# PRD — Ledger Book (Imported from GitHub)

## Origin
- Repository: https://github.com/purwarharsh10315-ui/eMERGENT.git
- Imported into `/app` on 2026-01-03.

## Problem Statement
Import project from the above GitHub repo into workspace and make it runnable.

## App Overview
"Ledger Book" — a personal/family/business double-entry style ledger web app with:
- FastAPI backend (`/app/backend/server.py`) — auth (JWT + bcrypt), entries CRUD, CSV/PDF export.
- React 19 frontend (`/app/frontend`) with Radix UI + Tailwind + craco.
- MongoDB storage (motor async driver).
- Default admin: `admin@ledger.app` / `admin123` (seeded on startup).

## Setup Completed (2026-01-03)
- Cloned repo into `/app` (preserved `.git`, `.emergent`, and `.env` files).
- Installed backend deps from `requirements.txt` (excluding `emergentintegrations`/`litellm` — not used by server.py; caused conflict).
- Installed frontend deps via `yarn`.
- Added missing `JWT_SECRET` to `/app/backend/.env` (generated cryptographically-random 48-byte urlsafe token).
- Restarted supervisor services; both backend (port 8001) and frontend (port 3000) running.
- Verified: `GET /api/` returns healthy, `POST /api/auth/login` returns JWT for seeded admin.

## Backlog / Next Actions
- P1: Explore full feature set (entries list, filters, exports) and validate via testing agent when user requests.
- P2: Re-add `emergentintegrations` if any AI-driven feature is planned later.

## Notes
- Auth uses HS256 JWT, 12h expiry, brute-force lockout after 5 failed attempts for 15 minutes.
- Currency displayed as INR (₹).
