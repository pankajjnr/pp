from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import logging
import uuid
import bcrypt
import jwt
from datetime import datetime, timezone, date, timedelta
from typing import List, Optional, Literal

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Response
from fastapi.responses import StreamingResponse
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, EmailStr, ConfigDict
import io
import csv
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle


# ----- Config -----
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 12  # 12 hours
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_MINUTES = 15

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI(title="Ledger Book API")
api_router = APIRouter(prefix="/api")


# ----- Utilities -----
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def get_jwt_secret() -> str:
    return os.environ["JWT_SECRET"]


def create_access_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        "type": "access",
    }
    return jwt.encode(payload, get_jwt_secret(), algorithm=JWT_ALGORITHM)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def today_local_date() -> date:
    # Use server date as the "today" reference (Asia/Kolkata approximation is fine for now)
    return datetime.now(timezone.utc).date()


# ----- Models -----
class UserPublic(BaseModel):
    id: str
    email: EmailStr
    name: str
    role: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


class ClientCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    note: Optional[str] = Field(default=None, max_length=500)


class ClientOut(BaseModel):
    id: str
    name: str
    note: Optional[str] = None
    created_at: str
    incoming_total: float = 0
    outgoing_total: float = 0
    net_balance: float = 0  # incoming - outgoing (money we owe them if positive? see docs)


class PaymentCreate(BaseModel):
    client_id: str
    direction: Literal["in", "out"]
    amount: float = Field(gt=0)
    description: Optional[str] = Field(default=None, max_length=500)
    entry_date: Optional[str] = None  # ISO date YYYY-MM-DD; defaults to today


class PaymentOut(BaseModel):
    id: str
    client_id: str
    client_name: str
    direction: Literal["in", "out"]
    amount: float
    description: Optional[str] = None
    entry_date: str  # YYYY-MM-DD
    created_at: str


class TotalsOut(BaseModel):
    total_incoming: float
    total_outgoing: float
    net: float
    count: int


# ----- Auth Dependency -----
async def get_current_user(request: Request) -> dict:
    auth_header = request.headers.get("Authorization", "")
    token = None
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
    if not token:
        token = request.cookies.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
        user = await db.users.find_one({"id": payload["sub"]})
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


def user_to_public(u: dict) -> UserPublic:
    return UserPublic(id=u["id"], email=u["email"], name=u.get("name", "Accountant"), role=u.get("role", "accountant"))


# ----- Brute Force Protection -----
def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def check_lockout(identifier: str) -> None:
    rec = await db.login_attempts.find_one({"identifier": identifier})
    if not rec:
        return
    if rec.get("locked_until"):
        try:
            locked_until = datetime.fromisoformat(rec["locked_until"])
            if locked_until > datetime.now(timezone.utc):
                remaining = int((locked_until - datetime.now(timezone.utc)).total_seconds() / 60) + 1
                raise HTTPException(
                    status_code=429,
                    detail=f"Too many failed attempts. Try again in {remaining} minute(s).",
                )
        except (ValueError, TypeError):
            pass


async def record_failed_attempt(identifier: str) -> int:
    rec = await db.login_attempts.find_one({"identifier": identifier})
    count = (rec.get("count", 0) if rec else 0) + 1
    update: dict = {"count": count, "last_attempt": now_iso()}
    if count >= MAX_FAILED_ATTEMPTS:
        update["locked_until"] = (datetime.now(timezone.utc) + timedelta(minutes=LOCKOUT_MINUTES)).isoformat()
    await db.login_attempts.update_one(
        {"identifier": identifier}, {"$set": update}, upsert=True
    )
    return count


async def clear_failed_attempts(identifier: str) -> None:
    await db.login_attempts.delete_one({"identifier": identifier})


# ----- Auth Routes -----
@api_router.post("/auth/login", response_model=TokenResponse)
async def login(payload: LoginRequest, request: Request, response: Response):
    email = payload.email.lower().strip()
    ip = _client_ip(request)
    identifier = f"{ip}:{email}"

    await check_lockout(identifier)

    user = await db.users.find_one({"email": email})
    if not user or not verify_password(payload.password, user["password_hash"]):
        attempts = await record_failed_attempt(identifier)
        remaining = MAX_FAILED_ATTEMPTS - attempts
        if remaining <= 0:
            raise HTTPException(
                status_code=429,
                detail=f"Too many failed attempts. Locked for {LOCKOUT_MINUTES} minutes.",
            )
        raise HTTPException(
            status_code=401,
            detail=f"Invalid email or password. {remaining} attempt(s) remaining.",
        )

    await clear_failed_attempts(identifier)
    token = create_access_token(user["id"], user["email"])
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
    )
    return TokenResponse(access_token=token, user=user_to_public(user))


@api_router.post("/auth/logout")
async def logout(response: Response, _user: dict = Depends(get_current_user)):
    response.delete_cookie("access_token", path="/")
    return {"ok": True}


@api_router.get("/auth/me", response_model=UserPublic)
async def me(user: dict = Depends(get_current_user)):
    return user_to_public(user)


# ----- Client Routes -----
async def _compute_client_totals(client_id: str) -> tuple[float, float]:
    pipeline = [
        {"$match": {"client_id": client_id}},
        {"$group": {"_id": "$direction", "total": {"$sum": "$amount"}}},
    ]
    agg = await db.payments.aggregate(pipeline).to_list(10)
    incoming = 0.0
    outgoing = 0.0
    for row in agg:
        if row["_id"] == "in":
            incoming = float(row["total"])
        elif row["_id"] == "out":
            outgoing = float(row["total"])
    return incoming, outgoing


@api_router.post("/clients", response_model=ClientOut)
async def create_client(payload: ClientCreate, _user: dict = Depends(get_current_user)):
    name = payload.name.strip()
    existing = await db.clients.find_one({"name_lower": name.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="A client with this name already exists")
    doc = {
        "id": str(uuid.uuid4()),
        "name": name,
        "name_lower": name.lower(),
        "note": (payload.note or "").strip() or None,
        "created_at": now_iso(),
    }
    await db.clients.insert_one(doc)
    return ClientOut(id=doc["id"], name=doc["name"], note=doc["note"], created_at=doc["created_at"])


@api_router.get("/clients", response_model=List[ClientOut])
async def list_clients(_user: dict = Depends(get_current_user)):
    clients = await db.clients.find({}, {"_id": 0}).sort("name_lower", 1).to_list(2000)
    result: List[ClientOut] = []
    for c in clients:
        incoming, outgoing = await _compute_client_totals(c["id"])
        result.append(ClientOut(
            id=c["id"], name=c["name"], note=c.get("note"),
            created_at=c["created_at"],
            incoming_total=incoming, outgoing_total=outgoing,
            net_balance=incoming - outgoing,
        ))
    return result


@api_router.get("/clients/{client_id}", response_model=ClientOut)
async def get_client(client_id: str, _user: dict = Depends(get_current_user)):
    c = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")
    incoming, outgoing = await _compute_client_totals(client_id)
    return ClientOut(
        id=c["id"], name=c["name"], note=c.get("note"),
        created_at=c["created_at"],
        incoming_total=incoming, outgoing_total=outgoing,
        net_balance=incoming - outgoing,
    )


@api_router.post("/clients/bulk")
async def bulk_create_clients(payload: dict, _user: dict = Depends(get_current_user)):
    names = payload.get("names") or []
    created, skipped = [], []
    for raw in names:
        name = (raw or "").strip()
        if not name:
            continue
        if await db.clients.find_one({"name_lower": name.lower()}):
            skipped.append(name); continue
        doc = {"id": str(uuid.uuid4()), "name": name, "name_lower": name.lower(),
               "note": None, "created_at": now_iso()}
        await db.clients.insert_one(doc)
        created.append(name)
    return {"created": created, "skipped": skipped}


@api_router.delete("/clients/{client_id}")
async def delete_client(client_id: str, user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Only admin can delete clients")
    c = await db.clients.find_one({"id": client_id})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")
    pay_res = await db.payments.delete_many({"client_id": client_id})
    await db.clients.delete_one({"id": client_id})
    return {"ok": True, "deleted_payments": pay_res.deleted_count, "client_name": c["name"]}


@api_router.get("/clients/{client_id}/ledger")
async def client_ledger(client_id: str, _user: dict = Depends(get_current_user)):
    c = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")
    payments = await db.payments.find({"client_id": client_id}, {"_id": 0}).sort("entry_date", -1).to_list(5000)
    incoming = [p for p in payments if p["direction"] == "in"]
    outgoing = [p for p in payments if p["direction"] == "out"]
    incoming_total = sum(p["amount"] for p in incoming)
    outgoing_total = sum(p["amount"] for p in outgoing)
    return {
        "client": {"id": c["id"], "name": c["name"], "note": c.get("note"), "created_at": c["created_at"]},
        "incoming": incoming,
        "outgoing": outgoing,
        "incoming_total": incoming_total,
        "outgoing_total": outgoing_total,
        "net_balance": incoming_total - outgoing_total,
    }


def _fmt_inr(n: float) -> str:
    # Indian numbering-system formatter without external deps.
    negative = n < 0
    n = abs(n)
    whole = int(n)
    frac = round(n - whole, 2)
    s = str(whole)
    if len(s) > 3:
        last3 = s[-3:]
        rest = s[:-3]
        # group the rest by 2 from the right
        groups = []
        while len(rest) > 2:
            groups.insert(0, rest[-2:])
            rest = rest[:-2]
        if rest:
            groups.insert(0, rest)
        formatted = ",".join(groups) + "," + last3
    else:
        formatted = s
    if frac > 0:
        formatted += f".{int(round(frac * 100)):02d}"
    return ("-" if negative else "") + "Rs. " + formatted


def _display_client_name(raw: str) -> str:
    if not raw:
        return raw
    return f"Shree {raw} Ji"


@api_router.get("/clients/{client_id}/export")
async def export_client_ledger(client_id: str, format: str = "csv", _user: dict = Depends(get_current_user)):
    fmt = format.lower()
    if fmt not in ("csv", "pdf"):
        raise HTTPException(status_code=400, detail="format must be csv or pdf")
    c = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")
    display_name = _display_client_name(c["name"])
    payments = await db.payments.find({"client_id": client_id}, {"_id": 0}).sort("entry_date", -1).to_list(5000)
    incoming_total = sum(p["amount"] for p in payments if p["direction"] == "in")
    outgoing_total = sum(p["amount"] for p in payments if p["direction"] == "out")
    net = incoming_total - outgoing_total

    safe_name = "".join(ch if ch.isalnum() else "_" for ch in c["name"])[:40]

    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["Client", display_name])
        w.writerow(["Generated", now_iso()])
        w.writerow([])
        w.writerow(["Date", "Direction", "Amount (INR)", "Description"])
        for p in payments:
            w.writerow([
                p["entry_date"],
                "Payment Received" if p["direction"] == "in" else "Payment Given",
                f"{p['amount']:.2f}",
                p.get("description") or "",
            ])
        w.writerow([])
        w.writerow(["Total Payment Received", f"{incoming_total:.2f}"])
        w.writerow(["Total Payment Given", f"{outgoing_total:.2f}"])
        w.writerow(["Net Balance", f"{net:.2f}"])
        data = buf.getvalue().encode("utf-8")
        return StreamingResponse(
            io.BytesIO(data),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="ledger_{safe_name}.csv"'},
        )

    # PDF — clean, focused on client name
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=22 * mm, rightMargin=22 * mm, topMargin=24 * mm, bottomMargin=20 * mm)
    styles = getSampleStyleSheet()
    # Client name is the dominant focal point — huge, bold
    name_style = ParagraphStyle("clientname", parent=styles["Title"], fontName="Times-Bold", fontSize=44, textColor=colors.HexColor("#1C1917"), spaceAfter=8, leading=48, alignment=0)
    meta_style = ParagraphStyle("meta", parent=styles["Normal"], fontName="Helvetica", fontSize=9, textColor=colors.HexColor("#78716C"), spaceAfter=22)
    section_style = ParagraphStyle("section", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=11, textColor=colors.HexColor("#1C1917"), spaceBefore=14, spaceAfter=8, textTransform="uppercase")

    story = []
    # ↓ removed dense "The Ledger Book" branding block
    story.append(Paragraph(display_name, name_style))
    story.append(Paragraph(f"Statement generated {datetime.now(timezone.utc).strftime('%d %b %Y')}", meta_style))

    summary_data = [
        ["Total Payment Received", _fmt_inr(incoming_total)],
        ["Total Payment Given", _fmt_inr(outgoing_total)],
        ["Net Balance", _fmt_inr(net)],
    ]
    t = Table(summary_data, colWidths=[90 * mm, 76 * mm])
    t.setStyle(TableStyle([
        ("FONT", (0, 0), (0, -1), "Helvetica", 10),
        ("FONT", (1, 0), (1, -1), "Helvetica-Bold", 12),
        ("TEXTCOLOR", (1, 0), (1, 0), colors.HexColor("#065F46")),
        ("TEXTCOLOR", (1, 1), (1, 1), colors.HexColor("#9A3412")),
        ("TEXTCOLOR", (1, 2), (1, 2), colors.HexColor("#065F46") if net >= 0 else colors.HexColor("#9A3412")),
        ("FONT", (1, 2), (1, 2), "Helvetica-Bold", 14),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 0), (-1, -1), 0.3, colors.HexColor("#E7E5E4")),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
    ]))
    story.append(t)

    def _rows_for(direction: str):
        rows = [["Date", "Amount", "Description"]]
        for p in payments:
            if p["direction"] != direction:
                continue
            rows.append([p["entry_date"], _fmt_inr(p["amount"]), (p.get("description") or "")[:60]])
        if len(rows) == 1:
            rows.append(["—", "—", "No entries"])
        return rows

    def _table(rows, color):
        tbl = Table(rows, colWidths=[30 * mm, 40 * mm, 96 * mm])
        tbl.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 10),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#78716C")),
            ("TEXTCOLOR", (1, 1), (1, -1), color),
            ("LINEBELOW", (0, 0), (-1, 0), 0.7, colors.HexColor("#78716C")),
            ("LINEBELOW", (0, 1), (-1, -1), 0.2, colors.HexColor("#E7E5E4")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ]))
        return tbl

    story.append(Paragraph("PAYMENT RECEIVED", section_style))
    story.append(_table(_rows_for("in"), colors.HexColor("#065F46")))
    story.append(Paragraph("PAYMENT GIVEN", section_style))
    story.append(_table(_rows_for("out"), colors.HexColor("#9A3412")))

    doc.build(story)
    data = buf.getvalue()
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="ledger_{safe_name}.pdf"'},
    )


# ----- Payment Routes -----
@api_router.post("/payments", response_model=PaymentOut)
async def create_payment(payload: PaymentCreate, _user: dict = Depends(get_current_user)):
    c = await db.clients.find_one({"id": payload.client_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")
    entry_date_str = payload.entry_date or today_local_date().isoformat()
    # validate date format
    try:
        datetime.strptime(entry_date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid entry_date, expected YYYY-MM-DD")

    doc = {
        "id": str(uuid.uuid4()),
        "client_id": payload.client_id,
        "client_name": c["name"],
        "direction": payload.direction,
        "amount": float(payload.amount),
        "description": (payload.description or "").strip() or None,
        "entry_date": entry_date_str,
        "created_at": now_iso(),
    }
    await db.payments.insert_one(doc)
    return PaymentOut(**{k: doc[k] for k in ["id", "client_id", "client_name", "direction", "amount", "description", "entry_date", "created_at"]})


@api_router.get("/payments/by-date", response_model=List[PaymentOut])
async def payments_by_date(date_str: str, _user: dict = Depends(get_current_user)):
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date, expected YYYY-MM-DD")
    payments = await db.payments.find({"entry_date": date_str}, {"_id": 0}).sort("created_at", -1).to_list(5000)
    return [PaymentOut(**p) for p in payments]


@api_router.get("/payments/today", response_model=List[PaymentOut])
async def payments_today(_user: dict = Depends(get_current_user)):
    d = today_local_date().isoformat()
    payments = await db.payments.find({"entry_date": d}, {"_id": 0}).sort("created_at", -1).to_list(5000)
    return [PaymentOut(**p) for p in payments]


@api_router.get("/payments/yesterday", response_model=List[PaymentOut])
async def payments_yesterday(_user: dict = Depends(get_current_user)):
    d = (today_local_date() - timedelta(days=1)).isoformat()
    payments = await db.payments.find({"entry_date": d}, {"_id": 0}).sort("created_at", -1).to_list(5000)
    return [PaymentOut(**p) for p in payments]


@api_router.get("/payments/calendar-summary")
async def payments_calendar_summary(month: str, _user: dict = Depends(get_current_user)):
    """month = YYYY-MM. Returns dict {date: {in, out, count}} for the month."""
    try:
        datetime.strptime(month + "-01", "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid month, expected YYYY-MM")
    start = month + "-01"
    end = month + "-31"
    payments = await db.payments.find(
        {"entry_date": {"$gte": start, "$lte": end}}, {"_id": 0}
    ).to_list(5000)
    summary: dict = {}
    for p in payments:
        d = p["entry_date"]
        if d not in summary:
            summary[d] = {"in": 0.0, "out": 0.0, "count": 0}
        summary[d]["count"] += 1
        if p["direction"] == "in":
            summary[d]["in"] += p["amount"]
        else:
            summary[d]["out"] += p["amount"]
    return summary


# ----- Calculate -----
@api_router.get("/calculate", response_model=TotalsOut)
async def calculate_totals(_user: dict = Depends(get_current_user)):
    pipeline = [{"$group": {"_id": "$direction", "total": {"$sum": "$amount"}, "count": {"$sum": 1}}}]
    agg = await db.payments.aggregate(pipeline).to_list(10)
    incoming = 0.0
    outgoing = 0.0
    count = 0
    for row in agg:
        count += row["count"]
        if row["_id"] == "in":
            incoming = float(row["total"])
        elif row["_id"] == "out":
            outgoing = float(row["total"])
    return TotalsOut(total_incoming=incoming, total_outgoing=outgoing, net=incoming - outgoing, count=count)


# =========================================================================
# MATERIAL PROCUREMENT MODULE (standalone – not integrated with payments)
# =========================================================================

class ProductCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class ProductOut(BaseModel):
    id: str
    name: str
    created_at: str


class ProcurementCreate(BaseModel):
    entry_date: str  # YYYY-MM-DD
    client_id: str
    product_id: str
    weight: float = Field(gt=0)
    rate: float = Field(gt=0)


class ProcurementOut(BaseModel):
    id: str
    entry_date: str
    client_id: str
    client_name: str
    product_id: str
    product_name: str
    weight: float
    rate: float
    total_amount: float
    created_at: str


# --- Product master ---
@api_router.get("/procurement/products", response_model=List[ProductOut])
async def list_products(_user: dict = Depends(get_current_user)):
    docs = await db.master_products.find({}, {"_id": 0}).sort("name_lower", 1).to_list(500)
    return [ProductOut(id=d["id"], name=d["name"], created_at=d["created_at"]) for d in docs]


@api_router.post("/procurement/products", response_model=ProductOut)
async def create_product(payload: ProductCreate, _user: dict = Depends(get_current_user)):
    name = payload.name.strip()
    if await db.master_products.find_one({"name_lower": name.lower()}):
        raise HTTPException(status_code=400, detail="Product already exists")
    doc = {
        "id": str(uuid.uuid4()),
        "name": name,
        "name_lower": name.lower(),
        "created_at": now_iso(),
    }
    await db.master_products.insert_one(doc)
    return ProductOut(id=doc["id"], name=doc["name"], created_at=doc["created_at"])


@api_router.delete("/procurement/products/{product_id}")
async def delete_product(product_id: str, user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Only admin can delete products")
    res = await db.master_products.delete_one({"id": product_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Product not found")
    return {"ok": True}


# --- Procurement entries ---
def _allowed_entry_dates() -> set[str]:
    """Procurement entries may only be logged for today or yesterday."""
    today = today_local_date()
    return {today.isoformat(), (today - timedelta(days=1)).isoformat()}


@api_router.post("/procurement/entries", response_model=ProcurementOut)
async def create_procurement(payload: ProcurementCreate, _user: dict = Depends(get_current_user)):
    try:
        datetime.strptime(payload.entry_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid entry_date (YYYY-MM-DD)")

    allowed = _allowed_entry_dates()
    if payload.entry_date not in allowed:
        raise HTTPException(
            status_code=400,
            detail="Procurement entries can only be logged for today or yesterday.",
        )

    c = await db.clients.find_one({"id": payload.client_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")
    p = await db.master_products.find_one({"id": payload.product_id}, {"_id": 0})
    if not p:
        raise HTTPException(status_code=404, detail="Product not found")

    total_amount = round(float(payload.weight) * float(payload.rate), 2)
    doc = {
        "id": str(uuid.uuid4()),
        "entry_date": payload.entry_date,
        "client_id": payload.client_id,
        "client_name": c["name"],
        "product_id": payload.product_id,
        "product_name": p["name"],
        "weight": float(payload.weight),
        "rate": float(payload.rate),
        "total_amount": total_amount,
        "created_at": now_iso(),
    }
    await db.procurement_entries.insert_one(doc)
    return ProcurementOut(**{k: doc[k] for k in [
        "id", "entry_date", "client_id", "client_name", "product_id",
        "product_name", "weight", "rate", "total_amount", "created_at"
    ]})


@api_router.get("/procurement/entries", response_model=List[ProcurementOut])
async def list_procurement(
    client_id: Optional[str] = None,
    product_id: Optional[str] = None,
    product_name: Optional[str] = None,
    entry_date: Optional[str] = None,
    _user: dict = Depends(get_current_user),
):
    """Dynamically filter procurement entries by any combination of
    client_id, product_id (or product_name), and entry_date."""
    q: dict = {}
    if client_id:
        q["client_id"] = client_id
    if product_id:
        q["product_id"] = product_id
    elif product_name:
        q["product_name"] = product_name
    if entry_date:
        try:
            datetime.strptime(entry_date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid entry_date (YYYY-MM-DD)")
        q["entry_date"] = entry_date
    rows = await db.procurement_entries.find(q, {"_id": 0}).sort("created_at", -1).to_list(5000)
    return [ProcurementOut(**r) for r in rows]


@api_router.get("/procurement/entries/export")
async def export_procurement(
    entry_date: Optional[str] = None,
    _user: dict = Depends(get_current_user),
):
    """Export procurement entries as PDF.
    Optional entry_date=YYYY-MM-DD narrows it to that day; omit for full history.
    """
    q: dict = {}
    scope_label = "Full History"
    if entry_date:
        try:
            datetime.strptime(entry_date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid entry_date (YYYY-MM-DD)")
        q["entry_date"] = entry_date
        scope_label = entry_date

    rows = await db.procurement_entries.find(q, {"_id": 0}).sort("entry_date", -1).sort("created_at", -1).to_list(10000)
    total_weight = sum(float(r.get("weight", 0)) for r in rows)
    total_cost = sum(float(r.get("total_amount", 0)) for r in rows)
    wavg = (total_cost / total_weight) if total_weight > 0 else 0.0

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=20 * mm, bottomMargin=18 * mm)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("title", parent=styles["Title"], fontName="Times-Bold",
                                 fontSize=26, textColor=colors.HexColor("#1C1917"),
                                 spaceAfter=4, leading=30, alignment=0)
    meta_style = ParagraphStyle("meta", parent=styles["Normal"], fontName="Helvetica",
                                fontSize=9, textColor=colors.HexColor("#78716C"), spaceAfter=14)
    section_style = ParagraphStyle("section", parent=styles["Heading2"], fontName="Helvetica-Bold",
                                   fontSize=10, textColor=colors.HexColor("#1C1917"),
                                   spaceBefore=12, spaceAfter=6)

    story = [
        Paragraph("Procurement Log", title_style),
        Paragraph(
            f"Scope: {scope_label} &nbsp;·&nbsp; Generated {datetime.now(timezone.utc).strftime('%d %b %Y %H:%M UTC')}",
            meta_style,
        ),
    ]

    # Summary block
    summary_rows = [
        ["Total Entries", str(len(rows))],
        ["Total Weight (Quintal)", f"{total_weight:,.2f}"],
        ["Total Cost", _fmt_inr(total_cost)],
        ["Weighted Avg Rate (Rs./Quintal)", _fmt_inr(wavg) if total_weight > 0 else "—"],
    ]
    st = Table(summary_rows, colWidths=[90 * mm, 76 * mm])
    st.setStyle(TableStyle([
        ("FONT", (0, 0), (0, -1), "Helvetica", 10),
        ("FONT", (1, 0), (1, -1), "Helvetica-Bold", 11),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#57534E")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LINEBELOW", (0, 0), (-1, -1), 0.3, colors.HexColor("#E7E5E4")),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
    ]))
    story.append(st)

    story.append(Paragraph("ENTRIES", section_style))
    header = ["Date", "Client", "Product", "Weight (Qtl)", "Rate", "Total"]
    data = [header]
    if not rows:
        data.append(["—", "—", "—", "—", "—", "No entries"])
    else:
        for r in rows:
            data.append([
                r["entry_date"],
                _display_client_name(r.get("client_name", "")),
                r.get("product_name", ""),
                f"{float(r.get('weight', 0)):,.2f}",
                _fmt_inr(float(r.get("rate", 0))),
                _fmt_inr(float(r.get("total_amount", 0))),
            ])
    tbl = Table(data, colWidths=[24 * mm, 46 * mm, 26 * mm, 24 * mm, 26 * mm, 28 * mm], repeatRows=1)
    tbl.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.5),
        ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#78716C")),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F5F4F0")),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#78716C")),
        ("LINEBELOW", (0, 1), (-1, -1), 0.2, colors.HexColor("#E7E5E4")),
        ("ALIGN", (3, 0), (5, -1), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(tbl)

    doc.build(story)
    data_bytes = buf.getvalue()
    filename = f"procurement_{scope_label.replace(' ', '_')}.pdf"
    return StreamingResponse(
        io.BytesIO(data_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


DEFAULT_PRODUCTS = ["Maize", "Wheat", "Bajra"]


# =========================================================================
# PROCUREMENT PAYMENT SETTLEMENT (date-range based, auto-posts to ledger)
# =========================================================================

class SettlementCreate(BaseModel):
    client_id: str
    from_date: str  # YYYY-MM-DD (inclusive)
    to_date: str    # YYYY-MM-DD (inclusive)
    deduction_percent: float = Field(ge=0, le=100)


class SettlementEntryRef(BaseModel):
    id: str
    entry_date: str
    product_id: str
    product_name: str
    weight: float
    rate: float
    total_amount: float


class ProductSubtotal(BaseModel):
    product_id: str
    product_name: str
    entry_count: int
    total_weight: float
    total_amount: float


class SettlementOut(BaseModel):
    id: str
    client_id: str
    client_name: str
    from_date: str
    to_date: str
    entry_count: int
    gross_amount: float
    deduction_percent: float
    deduction_amount: float
    net_paid: float
    linked_payment_id: Optional[str] = None
    created_at: str


class SettlementDetailOut(SettlementOut):
    entries: List[SettlementEntryRef] = []
    subtotals: List[ProductSubtotal] = []


class OutstandingPreview(BaseModel):
    client_id: str
    client_name: str
    from_date: str
    to_date: str
    entry_count: int
    gross_amount: float
    entries: List[SettlementEntryRef]
    subtotals: List[ProductSubtotal]


class LastSettlementOut(BaseModel):
    from_date: str
    to_date: str
    created_at: str


def _validate_iso_date(value: str, field: str) -> None:
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid {field} (YYYY-MM-DD)")


async def _fetch_eligible_entries(client_id: str, from_date: str, to_date: str) -> List[dict]:
    """Entries for client, entry_date in [from,to], NOT already settled.
    Missing/absent `is_settled` field is treated as False (unsettled)."""
    rows = await db.procurement_entries.find({
        "client_id": client_id,
        "entry_date": {"$gte": from_date, "$lte": to_date},
        "is_settled": {"$ne": True},
    }, {"_id": 0}).sort("entry_date", 1).to_list(20000)
    return rows


def _compute_subtotals(rows: List[dict]) -> List[ProductSubtotal]:
    agg: dict[str, dict] = {}
    for r in rows:
        pid = r.get("product_id", "")
        if pid not in agg:
            agg[pid] = {
                "product_id": pid,
                "product_name": r.get("product_name", ""),
                "entry_count": 0,
                "total_weight": 0.0,
                "total_amount": 0.0,
            }
        agg[pid]["entry_count"] += 1
        agg[pid]["total_weight"] += float(r.get("weight", 0))
        agg[pid]["total_amount"] += float(r.get("total_amount", 0))
    result = []
    for a in agg.values():
        result.append(ProductSubtotal(
            product_id=a["product_id"],
            product_name=a["product_name"],
            entry_count=a["entry_count"],
            total_weight=round(a["total_weight"], 2),
            total_amount=round(a["total_amount"], 2),
        ))
    result.sort(key=lambda s: s.product_name.lower())
    return result


def _to_entry_refs(rows: List[dict]) -> List[SettlementEntryRef]:
    return [SettlementEntryRef(
        id=r["id"],
        entry_date=r["entry_date"],
        product_id=r.get("product_id", ""),
        product_name=r.get("product_name", ""),
        weight=float(r.get("weight", 0)),
        rate=float(r.get("rate", 0)),
        total_amount=float(r.get("total_amount", 0)),
    ) for r in rows]


@api_router.get(
    "/procurement/clients/{client_id}/last-settlement",
    response_model=Optional[LastSettlementOut],
)
async def last_settlement(client_id: str, _user: dict = Depends(get_current_user)):
    """Purely informational: most recent settlement's window for this client."""
    rec = await db.procurement_settlements.find_one(
        {"client_id": client_id, "from_date": {"$exists": True}},
        {"_id": 0, "from_date": 1, "to_date": 1, "created_at": 1},
        sort=[("to_date", -1), ("created_at", -1)],
    )
    if not rec:
        return None
    return LastSettlementOut(
        from_date=rec["from_date"], to_date=rec["to_date"], created_at=rec["created_at"]
    )


@api_router.get(
    "/procurement/clients/{client_id}/outstanding",
    response_model=OutstandingPreview,
)
async def preview_outstanding(
    client_id: str,
    from_date: str,
    to_date: str,
    _user: dict = Depends(get_current_user),
):
    _validate_iso_date(from_date, "from_date")
    _validate_iso_date(to_date, "to_date")
    if from_date > to_date:
        raise HTTPException(status_code=400, detail="from_date cannot be after to_date")

    c = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")

    rows = await _fetch_eligible_entries(client_id, from_date, to_date)
    gross = round(sum(float(r.get("total_amount", 0)) for r in rows), 2)
    return OutstandingPreview(
        client_id=client_id,
        client_name=c["name"],
        from_date=from_date,
        to_date=to_date,
        entry_count=len(rows),
        gross_amount=gross,
        entries=_to_entry_refs(rows),
        subtotals=_compute_subtotals(rows),
    )


@api_router.post("/procurement/settlements", response_model=SettlementOut)
async def create_settlement(payload: SettlementCreate, _user: dict = Depends(get_current_user)):
    _validate_iso_date(payload.from_date, "from_date")
    _validate_iso_date(payload.to_date, "to_date")
    if payload.from_date > payload.to_date:
        raise HTTPException(status_code=400, detail="from_date cannot be after to_date")

    c = await db.clients.find_one({"id": payload.client_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")

    # Re-fetch server-side — never trust a client-side preview.
    rows = await _fetch_eligible_entries(payload.client_id, payload.from_date, payload.to_date)
    if not rows:
        raise HTTPException(
            status_code=400,
            detail="No unsettled procurement entries in this range — nothing to settle.",
        )

    gross = round(sum(float(r.get("total_amount", 0)) for r in rows), 2)
    ded_pct = float(payload.deduction_percent)
    deduction = round(gross * ded_pct / 100.0, 2)
    net = round(gross - deduction, 2)

    settlement_id = str(uuid.uuid4())
    payment_id = str(uuid.uuid4())
    entry_ids = [r["id"] for r in rows]
    today_iso = today_local_date().isoformat()
    created_ts = now_iso()

    payment_doc = {
        "id": payment_id,
        "client_id": payload.client_id,
        "client_name": c["name"],
        "direction": "out",
        "amount": net,
        "description": (
            f"Procurement settlement — material dated {payload.from_date} "
            f"to {payload.to_date} (deduction {ded_pct}%)"
        ),
        "entry_date": today_iso,
        "created_at": created_ts,
        "settlement_id": settlement_id,  # extra field; ignored by PaymentOut model
    }

    settlement_doc = {
        "id": settlement_id,
        "client_id": payload.client_id,
        "client_name": c["name"],
        "from_date": payload.from_date,
        "to_date": payload.to_date,
        "entry_count": len(rows),
        "gross_amount": gross,
        "deduction_percent": ded_pct,
        "deduction_amount": deduction,
        "net_paid": net,
        "linked_payment_id": payment_id,
        "entry_ids": entry_ids,
        "created_at": created_ts,
    }

    # Best-effort "atomic" sequence — rollback on any failure to avoid
    # ending up with entries flagged settled but no ledger payment / settlement record.
    flagged = False
    payment_inserted = False
    settlement_inserted = False
    try:
        upd = await db.procurement_entries.update_many(
            {"id": {"$in": entry_ids}, "is_settled": {"$ne": True}},
            {"$set": {"is_settled": True, "settlement_id": settlement_id}},
        )
        # Guard: race — someone else settled in between. Roll back everything.
        if upd.modified_count != len(entry_ids):
            raise RuntimeError("Entry count mismatch — concurrent settlement suspected")
        flagged = True

        await db.payments.insert_one(payment_doc)
        payment_inserted = True

        await db.procurement_settlements.insert_one(settlement_doc)
        settlement_inserted = True
    except Exception as exc:
        # Reverse in the opposite order.
        if settlement_inserted:
            await db.procurement_settlements.delete_one({"id": settlement_id})
        if payment_inserted:
            await db.payments.delete_one({"id": payment_id})
        if flagged:
            await db.procurement_entries.update_many(
                {"settlement_id": settlement_id},
                {"$set": {"is_settled": False}, "$unset": {"settlement_id": ""}},
            )
        raise HTTPException(
            status_code=500,
            detail=f"Settlement failed and was rolled back: {exc}",
        )

    return SettlementOut(
        id=settlement_id,
        client_id=payload.client_id,
        client_name=c["name"],
        from_date=payload.from_date,
        to_date=payload.to_date,
        entry_count=len(rows),
        gross_amount=gross,
        deduction_percent=ded_pct,
        deduction_amount=deduction,
        net_paid=net,
        linked_payment_id=payment_id,
        created_at=created_ts,
    )


@api_router.get("/procurement/settlements", response_model=List[SettlementOut])
async def list_settlements(
    client_id: Optional[str] = None,
    _user: dict = Depends(get_current_user),
):
    q: dict = {"from_date": {"$exists": True}}  # ignore any legacy watermark records
    if client_id:
        q["client_id"] = client_id
    rows = await db.procurement_settlements.find(q, {"_id": 0}).sort("to_date", -1).sort("created_at", -1).to_list(5000)
    out = []
    for r in rows:
        out.append(SettlementOut(
            id=r["id"], client_id=r["client_id"], client_name=r["client_name"],
            from_date=r["from_date"], to_date=r["to_date"],
            entry_count=r["entry_count"], gross_amount=r["gross_amount"],
            deduction_percent=r["deduction_percent"], deduction_amount=r["deduction_amount"],
            net_paid=r["net_paid"], linked_payment_id=r.get("linked_payment_id"),
            created_at=r["created_at"],
        ))
    return out


@api_router.get("/procurement/settlements/{settlement_id}", response_model=SettlementDetailOut)
async def get_settlement(settlement_id: str, _user: dict = Depends(get_current_user)):
    r = await db.procurement_settlements.find_one({"id": settlement_id, "from_date": {"$exists": True}}, {"_id": 0})
    if not r:
        raise HTTPException(status_code=404, detail="Settlement not found")
    entry_ids = r.get("entry_ids") or []
    entries = await db.procurement_entries.find({"id": {"$in": entry_ids}}, {"_id": 0}).sort("entry_date", 1).to_list(20000)
    return SettlementDetailOut(
        id=r["id"], client_id=r["client_id"], client_name=r["client_name"],
        from_date=r["from_date"], to_date=r["to_date"],
        entry_count=r["entry_count"], gross_amount=r["gross_amount"],
        deduction_percent=r["deduction_percent"], deduction_amount=r["deduction_amount"],
        net_paid=r["net_paid"], linked_payment_id=r.get("linked_payment_id"),
        created_at=r["created_at"],
        entries=_to_entry_refs(entries),
        subtotals=_compute_subtotals(entries),
    )


async def seed_products():
    for name in DEFAULT_PRODUCTS:
        if not await db.master_products.find_one({"name_lower": name.lower()}):
            await db.master_products.insert_one({
                "id": str(uuid.uuid4()),
                "name": name,
                "name_lower": name.lower(),
                "created_at": now_iso(),
            })


# ----- Health / Root -----
@api_router.get("/")
async def root():
    return {"status": "ok", "service": "ledger-book"}


# ----- Startup: indexes + admin seeding -----
async def seed_admin():
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@ledger.app").lower().strip()
    admin_password = os.environ.get("ADMIN_PASSWORD", "admin123")
    existing = await db.users.find_one({"email": admin_email})
    if existing is None:
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": admin_email,
            "password_hash": hash_password(admin_password),
            "name": "Accountant",
            "role": "admin",
            "created_at": now_iso(),
        })
    else:
        updates = {}
        if not verify_password(admin_password, existing["password_hash"]):
            updates["password_hash"] = hash_password(admin_password)
        if existing.get("role") != "admin":
            updates["role"] = "admin"
        if updates:
            await db.users.update_one({"email": admin_email}, {"$set": updates})


@app.on_event("startup")
async def on_startup():
    await db.users.create_index("email", unique=True)
    await db.clients.create_index("name_lower", unique=True)
    await db.payments.create_index("entry_date")
    await db.payments.create_index("client_id")
    await db.login_attempts.create_index("identifier", unique=True)
    await db.master_products.create_index("name_lower", unique=True)
    await db.procurement_entries.create_index("entry_date")
    await db.procurement_entries.create_index("client_id")
    await db.procurement_entries.create_index("product_id")
    await db.procurement_settlements.create_index([("client_id", 1), ("to_date", -1)])
    # One-time cleanup: drop legacy watermark-style settlement records and
    # clear any lingering is_settled flags that referenced them, so we start
    # the new date-range settlement model from a clean slate.
    legacy = await db.procurement_settlements.delete_many(
        {"from_date": {"$exists": False}}
    )
    if legacy.deleted_count:
        await db.procurement_entries.update_many(
            {"is_settled": True},
            {"$set": {"is_settled": False}, "$unset": {"settlement_id": ""}},
        )
    await seed_admin()
    await seed_products()


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()


# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)
