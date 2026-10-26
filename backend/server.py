from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import re
import logging
import uuid
import bcrypt
import jwt
from datetime import datetime, timezone, date, timedelta
from zoneinfo import ZoneInfo
from typing import List, Optional, Literal

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Response, UploadFile, File
from fastapi.responses import StreamingResponse
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from pymongo.errors import OperationFailure, ConfigurationError, DuplicateKeyError
from xml.sax.saxutils import escape as xml_escape
import certifi
from pydantic import BaseModel, Field, EmailStr, ConfigDict
import io
import csv
import json
import zipfile
from bson import ObjectId
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, KeepTogether
from reportlab.pdfgen.canvas import Canvas


BUSINESS_NAME = "Pankaj Purwar"
BUSINESS_TAGLINE = "ACCOUNTS · LEDGER BOOK"
MUDDAT_CLIENT_NAME = "Muddat"


# =========================================================================
# Shared PDF helpers — one consistent letterhead + footer for all exports.
# =========================================================================

class _NumberedCanvas(Canvas):
    """Two-pass canvas — renders footer with "Page X of Y" once total is known."""

    def __init__(self, *args, footer_left: str = "", **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_pages: list = []
        self._footer_left = footer_left

    def showPage(self):
        self._saved_pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved_pages)
        for page_state in self._saved_pages:
            self.__dict__.update(page_state)
            self._draw_footer(total)
            super().showPage()
        super().save()

    def _draw_footer(self, total_pages: int):
        self.setFont("Helvetica", 8)
        self.setFillColor(colors.HexColor("#78716C"))
        self.drawString(18 * mm, 10 * mm, self._footer_left)
        right = self._pagesize[0] - 18 * mm  # 192mm on portrait A4, wider on landscape
        self.drawRightString(
            right, 10 * mm, f"Page {self.getPageNumber()} of {total_pages}"
        )
        self.setStrokeColor(colors.HexColor("#E7E5E4"))
        self.setLineWidth(0.4)
        self.line(18 * mm, 12 * mm, right, 12 * mm)


def _pdf_letterhead_flowables(doc_title: str, meta_lines: list[str]) -> list:
    """Header flowables inserted at the top of the first page (and once at top of story).
    Reportlab will repeat the on-page letterhead via _draw_letterhead per-page."""
    styles = getSampleStyleSheet()
    biz = ParagraphStyle("biz", parent=styles["Title"], fontName="Times-Bold",
                         fontSize=22, textColor=colors.HexColor("#1C1917"),
                         alignment=0, leading=24, spaceAfter=1)
    tag = ParagraphStyle("tag", parent=styles["Normal"], fontName="Helvetica-Bold",
                         fontSize=8, textColor=colors.HexColor("#B45309"),
                         alignment=0, leading=10, spaceAfter=4)
    title = ParagraphStyle("doct", parent=styles["Heading1"], fontName="Times-Bold",
                           fontSize=18, textColor=colors.HexColor("#1C1917"),
                           spaceBefore=6, spaceAfter=4)
    meta = ParagraphStyle("meta", parent=styles["Normal"], fontName="Helvetica",
                          fontSize=9, textColor=colors.HexColor("#57534E"),
                          leading=12, spaceAfter=2)
    flows: list = [
        Paragraph(BUSINESS_NAME, biz),
        Paragraph(BUSINESS_TAGLINE, tag),
        HRFlowable(width="100%", thickness=0.8, color=colors.HexColor("#292524"), spaceBefore=2, spaceAfter=8),
        Paragraph(doc_title, title),
    ]
    for m in meta_lines:
        flows.append(Paragraph(m, meta))
    flows.append(Spacer(1, 6))
    return flows


def _pdf_stream(story: list, filename: str, pagesize=A4) -> StreamingResponse:
    """Build a PDF with shared margins + numbered footer canvas, return StreamingResponse."""
    footer_left = (
        f"Generated {datetime.now(timezone.utc).strftime('%d %b %Y %H:%M UTC')} "
        f"· System-generated document · {BUSINESS_NAME}"
    )
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=pagesize,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=18 * mm, bottomMargin=18 * mm,
        title=BUSINESS_NAME,
    )

    def canvas_maker(*args, **kwargs):
        return _NumberedCanvas(*args, footer_left=footer_left, **kwargs)

    doc.build(story, canvasmaker=canvas_maker)
    return StreamingResponse(
        io.BytesIO(buf.getvalue()),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ----- Config -----
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 12  # 12 hours
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_MINUTES = 15

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url, tlsCAFile=certifi.where())
db = client[os.environ['DB_NAME']]

app = FastAPI(title="Ledger Book API")

# Compresses JSON responses over ~500 bytes before sending them over the
# network — meaningfully smaller payloads, especially useful on Render's
# free tier where bandwidth/CPU is limited.
app.add_middleware(GZipMiddleware, minimum_size=500)

api_router = APIRouter(prefix="/api")


@app.api_route("/", methods=["GET", "HEAD"])  # HEAD too: UptimeRobot pings with HEAD
async def root_health_check():
    """Plain, unauthenticated health check at the domain root.
    Uptime monitors (UptimeRobot, cron-job.org, etc.) ping '/' by default —
    without this route they'd get a 404 and wrongly report the service as
    down, even though the app and all /api routes are working fine."""
    return {"status": "ok", "service": "Ledger Book API"}


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


# Business "today" is decided in the business's own timezone (default IST), NOT
# the server's UTC clock — otherwise between 00:00 and 05:30 IST the server's
# "today" is still yesterday and rejects entries the browser calls "today".
APP_TIMEZONE = ZoneInfo(os.environ.get("APP_TIMEZONE", "Asia/Kolkata"))


def today_local_date() -> date:
    return datetime.now(APP_TIMEZONE).date()


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
    settlement_id: Optional[str] = None  # set when created by / consumed into a settlement


class PaymentUpdate(BaseModel):
    direction: Optional[Literal["in", "out"]] = None
    amount: Optional[float] = Field(default=None, gt=0)
    description: Optional[str] = Field(default=None, max_length=500)
    entry_date: Optional[str] = None


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
        secure=True,
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
    clients = await db.clients.find({}, {"_id": 0}).sort("name_lower", 1).to_list(None)

    # Single aggregate over all payments, grouped by client + direction, instead
    # of one aggregate query per client (which was N+1 and slowed this page down
    # more as clients were added). Totals per client are identical to before —
    # just computed in one round trip instead of many.
    pipeline = [
        {"$group": {"_id": {"client_id": "$client_id", "direction": "$direction"}, "total": {"$sum": "$amount"}}},
    ]
    agg = await db.payments.aggregate(pipeline).to_list(None)
    totals: dict = {}
    for row in agg:
        cid = row["_id"]["client_id"]
        bucket = totals.setdefault(cid, {"in": 0.0, "out": 0.0})
        direction = row["_id"]["direction"]
        if direction in ("in", "out"):
            bucket[direction] = float(row["total"])

    result: List[ClientOut] = []
    for c in clients:
        t = totals.get(c["id"], {"in": 0.0, "out": 0.0})
        incoming, outgoing = t["in"], t["out"]
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
    if c.get("name_lower") == MUDDAT_CLIENT_NAME.lower():
        raise HTTPException(
            status_code=400,
            detail="Muddat is a system account (it collects settlement deductions) and cannot be deleted.",
        )
    # Remove everything that belongs to this client so nothing is left orphaned.
    pay_res = await db.payments.delete_many({"client_id": client_id})
    proc_res = await db.procurement_entries.delete_many({"client_id": client_id})
    set_res = await db.procurement_settlements.delete_many({"client_id": client_id})
    await db.clients.delete_one({"id": client_id})
    return {
        "ok": True,
        "deleted_payments": pay_res.deleted_count,
        "deleted_procurement_entries": proc_res.deleted_count,
        "deleted_settlements": set_res.deleted_count,
        "client_name": c["name"],
    }


@api_router.get("/clients/{client_id}/ledger")
async def client_ledger(client_id: str, _user: dict = Depends(get_current_user)):
    c = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")
    payments = await db.payments.find({"client_id": client_id}, {"_id": 0}).sort("entry_date", -1).to_list(None)
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
    return f"{raw} Ji"


@api_router.get("/clients/{client_id}/export")
async def export_client_ledger(client_id: str, format: str = "csv", _user: dict = Depends(get_current_user)):
    fmt = format.lower()
    if fmt not in ("csv", "pdf"):
        raise HTTPException(status_code=400, detail="format must be csv or pdf")
    c = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")
    display_name = _display_client_name(c["name"])
    payments = await db.payments.find({"client_id": client_id}, {"_id": 0}).sort("entry_date", -1).to_list(None)
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

    # PDF — use shared letterhead + footer helper
    styles = getSampleStyleSheet()
    name_style = ParagraphStyle("clientname", parent=styles["Title"], fontName="Times-Bold",
                                fontSize=28, textColor=colors.HexColor("#1C1917"),
                                spaceAfter=4, leading=32, alignment=0)
    section_style = ParagraphStyle("section", parent=styles["Heading2"], fontName="Helvetica-Bold",
                                   fontSize=11, textColor=colors.HexColor("#1C1917"),
                                   spaceBefore=14, spaceAfter=8)

    story = _pdf_letterhead_flowables(
        "Client Statement",
        [f"<b>Client:</b> {display_name}"],
    )
    story.append(Paragraph(display_name, name_style))
    story.append(Spacer(1, 6))

    net_color = colors.HexColor("#B45309") if net >= 0 else colors.HexColor("#9F1D1D")
    summary_data = [
        ["Total Payment Received", _fmt_inr(incoming_total)],
        ["Total Payment Given", _fmt_inr(outgoing_total)],
        ["Net Balance", _fmt_inr(net)],
    ]
    t = Table(summary_data, colWidths=[90 * mm, 76 * mm])
    t.setStyle(TableStyle([
        ("FONT", (0, 0), (0, -1), "Helvetica", 10),
        ("FONT", (1, 0), (1, -1), "Helvetica-Bold", 12),
        ("TEXTCOLOR", (1, 0), (1, 0), colors.HexColor("#B45309")),
        ("TEXTCOLOR", (1, 1), (1, 1), colors.HexColor("#9F1D1D")),
        ("TEXTCOLOR", (1, 2), (1, 2), net_color),
        ("FONT", (1, 2), (1, 2), "Helvetica-Bold", 16),
        ("BACKGROUND", (0, 2), (-1, 2), colors.HexColor("#FEF3C7") if net >= 0 else colors.HexColor("#FEE2E2")),
        ("LINEABOVE", (0, 2), (-1, 2), 0.8, net_color),
        ("LINEBELOW", (0, 2), (-1, 2), 0.8, net_color),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, 1), 0.3, colors.HexColor("#E7E5E4")),
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

    def _table(rows, color, row_tint):
        tbl = Table(rows, colWidths=[30 * mm, 40 * mm, 96 * mm], repeatRows=1)
        tbl.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 10),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#78716C")),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F5F4F0")),
            ("BACKGROUND", (0, 1), (-1, -1), row_tint),
            ("TEXTCOLOR", (1, 1), (1, -1), color),
            ("LINEBELOW", (0, 0), (-1, 0), 0.7, colors.HexColor("#78716C")),
            ("LINEBELOW", (0, 1), (-1, -1), 0.2, colors.HexColor("#E7E5E4")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ]))
        return tbl

    story.append(Paragraph("PAYMENT RECEIVED", section_style))
    story.append(_table(_rows_for("in"), colors.HexColor("#B45309"), colors.HexColor("#FEFCE8")))
    story.append(Paragraph("PAYMENT GIVEN", section_style))
    story.append(_table(_rows_for("out"), colors.HexColor("#9F1D1D"), colors.HexColor("#FEF7F5")))

    # Signature block
    story.append(Spacer(1, 20))
    sig = Table([["Received by: _______________________", "Date: _______________________"]],
                colWidths=[85 * mm, 85 * mm])
    sig.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), "Helvetica", 10),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#57534E")),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(sig)

    return _pdf_stream(story, f"ledger_{safe_name}.pdf")


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


@api_router.put("/payments/{payment_id}", response_model=PaymentOut)
async def update_payment(payment_id: str, payload: PaymentUpdate, _user: dict = Depends(get_current_user)):
    p = await db.payments.find_one({"id": payment_id}, {"_id": 0})
    if not p:
        raise HTTPException(status_code=404, detail="Payment not found")
    if p.get("settlement_id"):
        raise HTTPException(
            status_code=400,
            detail="This payment was created by (or applied to) a settlement. Undo the settlement instead.",
        )
    changes: dict = {}
    if payload.direction is not None:
        changes["direction"] = payload.direction
    if payload.amount is not None:
        changes["amount"] = float(payload.amount)
    if payload.description is not None:
        changes["description"] = payload.description.strip() or None
    if payload.entry_date is not None:
        try:
            datetime.strptime(payload.entry_date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid entry_date, expected YYYY-MM-DD")
        changes["entry_date"] = payload.entry_date
    if changes:
        await db.payments.update_one({"id": payment_id}, {"$set": changes})
        p.update(changes)
    return PaymentOut(**p)


@api_router.delete("/payments/{payment_id}")
async def delete_payment(payment_id: str, _user: dict = Depends(get_current_user)):
    p = await db.payments.find_one({"id": payment_id}, {"_id": 0})
    if not p:
        raise HTTPException(status_code=404, detail="Payment not found")
    if p.get("settlement_id"):
        raise HTTPException(
            status_code=400,
            detail="This payment was created by (or applied to) a settlement. Undo the settlement instead.",
        )
    await db.payments.delete_one({"id": payment_id})
    return {"ok": True}


@api_router.get("/payments/by-date", response_model=List[PaymentOut])
async def payments_by_date(date_str: str, _user: dict = Depends(get_current_user)):
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date, expected YYYY-MM-DD")
    payments = await db.payments.find({"entry_date": date_str}, {"_id": 0}).sort("created_at", -1).to_list(None)
    return [PaymentOut(**p) for p in payments]


@api_router.get("/payments/today", response_model=List[PaymentOut])
async def payments_today(_user: dict = Depends(get_current_user)):
    d = today_local_date().isoformat()
    payments = await db.payments.find({"entry_date": d}, {"_id": 0}).sort("created_at", -1).to_list(None)
    return [PaymentOut(**p) for p in payments]


@api_router.get("/payments/yesterday", response_model=List[PaymentOut])
async def payments_yesterday(_user: dict = Depends(get_current_user)):
    d = (today_local_date() - timedelta(days=1)).isoformat()
    payments = await db.payments.find({"entry_date": d}, {"_id": 0}).sort("created_at", -1).to_list(None)
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
    ).to_list(None)
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


class ProcurementBatchCreate(BaseModel):
    entries: List[ProcurementCreate] = Field(min_length=1, max_length=200)


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
    is_settled: bool = False


class ProcurementUpdate(BaseModel):
    entry_date: Optional[str] = None
    client_id: Optional[str] = None
    product_id: Optional[str] = None
    weight: Optional[float] = Field(default=None, gt=0)
    rate: Optional[float] = Field(default=None, gt=0)


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
    in_proc = await db.procurement_entries.count_documents({"product_id": product_id})
    in_sales = await db.sales_entries.count_documents({"product_id": product_id})
    if in_proc or in_sales:
        raise HTTPException(
            status_code=400,
            detail=f"This product is used in {in_proc} procurement and {in_sales} sales entries and cannot be deleted.",
        )
    res = await db.master_products.delete_one({"id": product_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Product not found")
    return {"ok": True}


# --- Procurement entries ---
def _allowed_entry_dates() -> set[str]:
    """Procurement entries may only be logged for today or yesterday."""
    today = today_local_date()
    return {today.isoformat(), (today - timedelta(days=1)).isoformat()}


async def _validate_and_build_procurement_doc(
    payload: ProcurementCreate,
    clients_by_id: dict,
    products_by_id: dict,
    index: int | None = None,
) -> dict:
    """Validate one procurement entry payload and build its DB doc.

    `clients_by_id` / `products_by_id` are pre-fetched lookup maps so batch
    calls don't hit the DB once per entry. `index` is used only to make
    error messages identify which row in a batch failed.
    """
    label = f"Entry {index + 1}: " if index is not None else ""
    try:
        datetime.strptime(payload.entry_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{label}Invalid entry_date (YYYY-MM-DD)")

    allowed = _allowed_entry_dates()
    if payload.entry_date not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"{label}Procurement entries can only be logged for today or yesterday.",
        )

    c = clients_by_id.get(payload.client_id)
    if not c:
        raise HTTPException(status_code=404, detail=f"{label}Client not found")
    p = products_by_id.get(payload.product_id)
    if not p:
        raise HTTPException(status_code=404, detail=f"{label}Product not found")

    total_amount = round(float(payload.weight) * float(payload.rate), 2)
    return {
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


def _out_fields(doc: dict) -> dict:
    return {k: doc[k] for k in [
        "id", "entry_date", "client_id", "client_name", "product_id",
        "product_name", "weight", "rate", "total_amount", "created_at"
    ]}


@api_router.post("/procurement/entries", response_model=ProcurementOut)
async def create_procurement(payload: ProcurementCreate, _user: dict = Depends(get_current_user)):
    c = await db.clients.find_one({"id": payload.client_id}, {"_id": 0})
    p = await db.master_products.find_one({"id": payload.product_id}, {"_id": 0})
    doc = await _validate_and_build_procurement_doc(
        payload,
        clients_by_id={payload.client_id: c} if c else {},
        products_by_id={payload.product_id: p} if p else {},
    )
    await db.procurement_entries.insert_one(doc)
    return ProcurementOut(**_out_fields(doc))


@api_router.post("/procurement/entries/batch", response_model=List[ProcurementOut])
async def create_procurement_batch(payload: ProcurementBatchCreate, _user: dict = Depends(get_current_user)):
    """Accountant builds up several entries client-side, reviews the whole
    list, then this saves them all together in one go. Every entry is
    validated up front — if any one of them is invalid, nothing is saved."""
    client_ids = {e.client_id for e in payload.entries}
    product_ids = {e.product_id for e in payload.entries}

    clients = await db.clients.find({"id": {"$in": list(client_ids)}}, {"_id": 0}).to_list(len(client_ids) or 1)
    products = await db.master_products.find({"id": {"$in": list(product_ids)}}, {"_id": 0}).to_list(len(product_ids) or 1)
    clients_by_id = {c["id"]: c for c in clients}
    products_by_id = {p["id"]: p for p in products}

    docs = []
    for i, entry in enumerate(payload.entries):
        doc = await _validate_and_build_procurement_doc(entry, clients_by_id, products_by_id, index=i)
        docs.append(doc)

    if docs:
        await db.procurement_entries.insert_many(docs)
    return [ProcurementOut(**_out_fields(d)) for d in docs]


@api_router.put("/procurement/entries/{entry_id}", response_model=ProcurementOut)
async def update_procurement(entry_id: str, payload: ProcurementUpdate, _user: dict = Depends(get_current_user)):
    doc = await db.procurement_entries.find_one({"id": entry_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Entry not found")
    if doc.get("is_settled"):
        raise HTTPException(status_code=400, detail="This entry is already settled. Undo the settlement first.")
    changes: dict = {}
    if payload.entry_date is not None and payload.entry_date != doc["entry_date"]:
        try:
            datetime.strptime(payload.entry_date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid entry_date (YYYY-MM-DD)")
        if payload.entry_date not in _allowed_entry_dates():
            raise HTTPException(status_code=400, detail="Date can only be changed to today or yesterday.")
        changes["entry_date"] = payload.entry_date
    if payload.client_id is not None and payload.client_id != doc["client_id"]:
        c = await db.clients.find_one({"id": payload.client_id}, {"_id": 0})
        if not c:
            raise HTTPException(status_code=404, detail="Client not found")
        changes["client_id"] = c["id"]
        changes["client_name"] = c["name"]
    if payload.product_id is not None and payload.product_id != doc["product_id"]:
        p = await db.master_products.find_one({"id": payload.product_id}, {"_id": 0})
        if not p:
            raise HTTPException(status_code=404, detail="Product not found")
        changes["product_id"] = p["id"]
        changes["product_name"] = p["name"]
    if payload.weight is not None:
        changes["weight"] = float(payload.weight)
    if payload.rate is not None:
        changes["rate"] = float(payload.rate)
    if changes:
        doc.update(changes)
        doc["total_amount"] = round(float(doc["weight"]) * float(doc["rate"]), 2)
        changes["total_amount"] = doc["total_amount"]
        await db.procurement_entries.update_one(
            {"id": entry_id, "is_settled": {"$ne": True}}, {"$set": changes}
        )
    return ProcurementOut(**{**_out_fields(doc), "is_settled": False})


@api_router.delete("/procurement/entries/{entry_id}")
async def delete_procurement(entry_id: str, _user: dict = Depends(get_current_user)):
    doc = await db.procurement_entries.find_one({"id": entry_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Entry not found")
    if doc.get("is_settled"):
        raise HTTPException(status_code=400, detail="This entry is already settled. Undo the settlement first.")
    res = await db.procurement_entries.delete_one({"id": entry_id, "is_settled": {"$ne": True}})
    if res.deleted_count == 0:
        raise HTTPException(status_code=409, detail="Entry was settled in the meantime. Undo the settlement first.")
    return {"ok": True}


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
    rows = await db.procurement_entries.find(q, {"_id": 0}).sort("created_at", -1).to_list(None)
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

    rows = await db.procurement_entries.find(q, {"_id": 0}).sort([("entry_date", -1), ("created_at", -1)]).to_list(None)
    total_weight = sum(float(r.get("weight", 0)) for r in rows)
    total_cost = sum(float(r.get("total_amount", 0)) for r in rows)
    wavg = (total_cost / total_weight) if total_weight > 0 else 0.0

    styles = getSampleStyleSheet()
    section_style = ParagraphStyle("section", parent=styles["Heading2"], fontName="Helvetica-Bold",
                                   fontSize=10, textColor=colors.HexColor("#1C1917"),
                                   spaceBefore=12, spaceAfter=6)

    story = _pdf_letterhead_flowables(
        "Procurement Log",
        [f"<b>Scope:</b> {scope_label}"],
    )

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

    filename = f"procurement_{scope_label.replace(' ', '_')}.pdf"
    return _pdf_stream(story, filename)


@api_router.get("/procurement/clients/{client_id}/export")
async def export_client_procurement(
    client_id: str,
    from_date: str,
    to_date: str,
    product_id: Optional[str] = None,
    _user: dict = Depends(get_current_user),
):
    """Client-scoped procurement export, grouped by product.
    Filters: client_id (required), entry_date in [from_date, to_date],
    optional product_id for single-product export."""
    for d, name in [(from_date, "from_date"), (to_date, "to_date")]:
        try:
            datetime.strptime(d, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid {name} (YYYY-MM-DD)")
    if from_date > to_date:
        raise HTTPException(status_code=400, detail="from_date cannot be after to_date")

    c = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")

    q: dict = {"client_id": client_id, "entry_date": {"$gte": from_date, "$lte": to_date}}
    product_name_filter: Optional[str] = None
    if product_id:
        p = await db.master_products.find_one({"id": product_id}, {"_id": 0})
        if not p:
            raise HTTPException(status_code=404, detail="Product not found")
        q["product_id"] = product_id
        product_name_filter = p["name"]

    rows = await db.procurement_entries.find(q, {"_id": 0}).sort("entry_date", 1).to_list(None)

    # Group by product
    groups: dict[str, dict] = {}
    for r in rows:
        pid = r.get("product_id", "")
        if pid not in groups:
            groups[pid] = {
                "product_id": pid,
                "product_name": r.get("product_name", ""),
                "entries": [],
                "total_weight": 0.0,
                "total_amount": 0.0,
            }
        groups[pid]["entries"].append(r)
        groups[pid]["total_weight"] += float(r.get("weight", 0))
        groups[pid]["total_amount"] += float(r.get("total_amount", 0))
    ordered_groups = sorted(groups.values(), key=lambda g: g["product_name"].lower())

    grand_weight = sum(g["total_weight"] for g in ordered_groups)
    grand_amount = sum(g["total_amount"] for g in ordered_groups)

    styles = getSampleStyleSheet()
    section_style = ParagraphStyle("section", parent=styles["Heading2"], fontName="Helvetica-Bold",
                                   fontSize=11, textColor=colors.HexColor("#1C1917"),
                                   spaceBefore=14, spaceAfter=6)

    product_scope = product_name_filter or "All products"
    story = _pdf_letterhead_flowables(
        f"Client Subledger — {_display_client_name(c['name'])}",
        [
            f"<b>Range:</b> {from_date} &rarr; {to_date}",
            f"<b>Products:</b> {product_scope}",
        ],
    )

    # Summary
    summary_rows = [
        ["Products", str(len(ordered_groups))],
        ["Total Entries", str(len(rows))],
        ["Total Weight (Quintal)", f"{grand_weight:,.2f}"],
        ["Grand Total", _fmt_inr(grand_amount)],
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

    if not rows:
        story.append(Paragraph("No entries in this range.", section_style))
    else:
        for g in ordered_groups:
            story.append(Paragraph(
                f"{g['product_name'].upper()} &nbsp;·&nbsp; {len(g['entries'])} entries",
                section_style,
            ))
            header = ["Date", "Weight (Qtl)", "Rate", "Amount"]
            data = [header]
            for r in g["entries"]:
                data.append([
                    r["entry_date"],
                    f"{float(r.get('weight', 0)):,.2f}",
                    _fmt_inr(float(r.get("rate", 0))),
                    _fmt_inr(float(r.get("total_amount", 0))),
                ])
            data.append([
                "Subtotal",
                f"{g['total_weight']:,.2f}",
                "",
                _fmt_inr(g["total_amount"]),
            ])
            tbl = Table(data, colWidths=[36 * mm, 40 * mm, 40 * mm, 44 * mm], repeatRows=1)
            last = len(data) - 1
            tbl.setStyle(TableStyle([
                ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.5),
                ("FONT", (0, 1), (-1, last - 1), "Helvetica", 9),
                ("FONT", (0, last), (-1, last), "Helvetica-Bold", 9.5),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#78716C")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F5F4F0")),
                ("BACKGROUND", (0, last), (-1, last), colors.HexColor("#FAF9F5")),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#78716C")),
                ("LINEBELOW", (0, 1), (-1, last - 1), 0.2, colors.HexColor("#E7E5E4")),
                ("LINEABOVE", (0, last), (-1, last), 0.6, colors.HexColor("#78716C")),
                ("ALIGN", (1, 0), (3, -1), "RIGHT"),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]))
            story.append(tbl)

        story.append(Paragraph("GRAND TOTAL", section_style))
        gt = Table([[
            f"Total Weight: {grand_weight:,.2f} Qtl",
            f"Grand Total: {_fmt_inr(grand_amount)}",
        ]], colWidths=[80 * mm, 80 * mm])
        gt.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, -1), "Helvetica-Bold", 12),
            ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#1C1917")),
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FEF3C7")),  # amber accent
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 10),
            ("LINEABOVE", (0, 0), (-1, -1), 1.0, colors.HexColor("#B45309")),
            ("LINEBELOW", (0, 0), (-1, -1), 1.0, colors.HexColor("#B45309")),
        ]))
        story.append(gt)

        # Signature line
        story.append(Spacer(1, 20))
        sig = Table([["Received by: _______________________", "Date: _______________________"]],
                    colWidths=[85 * mm, 85 * mm])
        sig.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, -1), "Helvetica", 10),
            ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#57534E")),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
        ]))
        story.append(sig)

    safe_client = "".join(ch for ch in c["name"] if ch.isalnum() or ch in "-_") or "client"
    filename = f"procurement_{safe_client}_{from_date}_{to_date}.pdf"
    return _pdf_stream(story, filename)


DEFAULT_PRODUCTS = ["Maize", "Wheat", "Bajra"]


# =========================================================================
# PROCUREMENT PAYMENT SETTLEMENT (date-range based, auto-posts to ledger)
# =========================================================================

class SettlementCreate(BaseModel):
    client_id: str
    from_date: str  # YYYY-MM-DD (inclusive)
    to_date: str    # YYYY-MM-DD (inclusive)
    deduction_percent: float = Field(ge=0, le=100)
    advance_payment_ids: List[str] = Field(default_factory=list)


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
    net_paid: float  # gross − muddat deduction (owed before advances are applied)
    advance_total: float = 0.0  # sum of advance payments applied to this settlement
    amount_paid_now: float = 0.0  # net_paid − advance_total (what actually gets posted/paid out)
    advance_payment_ids: List[str] = []
    linked_payment_id: Optional[str] = None
    muddat_payment_id: Optional[str] = None
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


class AdvancePaymentOut(BaseModel):
    """A regular 'out' payment to this client that hasn't been consumed by
    any settlement yet — eligible to be applied as an advance deduction."""
    id: str
    amount: float
    description: Optional[str] = None
    entry_date: str
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
    }, {"_id": 0}).sort("entry_date", 1).to_list(None)
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


@api_router.get(
    "/procurement/clients/{client_id}/advances",
    response_model=List[AdvancePaymentOut],
)
async def list_advance_payments(client_id: str, _user: dict = Depends(get_current_user)):
    """Regular 'money going out' payments to this client that are NOT tied to
    any settlement — i.e. advances that haven't been applied yet. A payment
    only ever gets a `settlement_id` when it's generated BY a settlement or
    consumed as an advance INTO one, so `$exists: False` correctly isolates
    plain manually-entered payments here."""
    c = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")
    rows = await db.payments.find(
        {
            "client_id": client_id,
            "direction": "out",
            "settlement_id": {"$exists": False},
        },
        {"_id": 0},
    ).sort("entry_date", 1).to_list(None)
    return [
        AdvancePaymentOut(
            id=r["id"],
            amount=float(r["amount"]),
            description=r.get("description"),
            entry_date=r["entry_date"],
            created_at=r["created_at"],
        )
        for r in rows
    ]


def _txn_unsupported(exc: Exception) -> bool:
    """True when the error just means 'this MongoDB can't do transactions'."""
    if isinstance(exc, ConfigurationError):
        return True
    if isinstance(exc, OperationFailure):
        msg = str(exc)
        return exc.code == 20 or "replica set" in msg or "Transaction numbers" in msg
    return False


async def _with_optional_txn(fn):
    """Run `await fn(session)` inside a MongoDB transaction (Atlas supports
    them). If the deployment can't do transactions, run `fn(None)` instead —
    fn is responsible for its own manual rollback in that case."""
    try:
        async with await client.start_session() as session:
            async with session.start_transaction():
                return await fn(session)
    except (ConfigurationError, OperationFailure) as exc:
        if not _txn_unsupported(exc):
            raise
    return await fn(None)


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
    # Muddat is always cut on the FULL gross amount — advances never reduce
    # what the deduction is calculated on, only what gets paid out today.
    deduction = round(gross * ded_pct / 100.0, 2)
    net = round(gross - deduction, 2)

    # --- Resolve & validate selected advance payments -----------------
    advance_ids = list(dict.fromkeys(payload.advance_payment_ids or []))  # dedupe, keep order
    advance_rows: List[dict] = []
    if advance_ids:
        advance_rows = await db.payments.find(
            {
                "id": {"$in": advance_ids},
                "client_id": payload.client_id,
                "direction": "out",
                "settlement_id": {"$exists": False},
            },
            {"_id": 0},
        ).to_list(len(advance_ids))
        found_ids = {r["id"] for r in advance_rows}
        missing = [aid for aid in advance_ids if aid not in found_ids]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=(
                    "One or more selected advance payments are no longer available "
                    "(already applied elsewhere, deleted, or don't belong to this client)."
                ),
            )

    advance_total = round(sum(float(r["amount"]) for r in advance_rows), 2)
    amount_paid_now = round(net - advance_total, 2)
    if amount_paid_now < 0:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Selected advances (₹{advance_total}) exceed the net payable "
                f"amount (₹{net}) after Muddat. Deselect some advances."
            ),
        )

    settlement_id = str(uuid.uuid4())
    payment_id = str(uuid.uuid4())
    muddat_payment_id = str(uuid.uuid4())
    entry_ids = [r["id"] for r in rows]
    today_iso = today_local_date().isoformat()
    created_ts = now_iso()

    # Ensure Muddat system account exists (idempotent)
    muddat_client_id = await seed_muddat_account()

    # Only post a fresh outgoing payment if there's actually anything left
    # to pay out today — if advances fully cover it, there's nothing more
    # to hand over, so no zero-amount payment gets created.
    payment_doc = None
    if amount_paid_now > 0:
        payment_doc = {
            "id": payment_id,
            "client_id": payload.client_id,
            "client_name": c["name"],
            "direction": "out",
            "amount": amount_paid_now,
            "description": (
                f"Procurement settlement — material dated {payload.from_date} "
                f"to {payload.to_date} (deduction {ded_pct}%)"
                + (f", after ₹{advance_total} advance applied" if advance_total else "")
            ),
            "entry_date": today_iso,
            "created_at": created_ts,
            "settlement_id": settlement_id,
        }

    muddat_payment_doc = None
    if deduction > 0:
        muddat_payment_doc = {
            "id": muddat_payment_id,
            "client_id": muddat_client_id,
            "client_name": MUDDAT_CLIENT_NAME,
            "direction": "in",
            "amount": deduction,
            "description": (
                f"Deduction from {c['name']} settlement — material dated "
                f"{payload.from_date} to {payload.to_date} ({ded_pct}%)"
            ),
            "entry_date": today_iso,
            "created_at": created_ts,
            "settlement_id": settlement_id,
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
        "advance_total": advance_total,
        "amount_paid_now": amount_paid_now,
        "advance_payment_ids": [r["id"] for r in advance_rows],
        "linked_payment_id": payment_id if payment_doc else None,
        "muddat_payment_id": muddat_payment_id if muddat_payment_doc else None,
        "entry_ids": entry_ids,
        "created_at": created_ts,
    }

    async def _write_settlement(session):
        """All the writes that make up one settlement. With a session they run
        inside one MongoDB transaction (all-or-nothing, handled by the DB). If
        the database can't do transactions (e.g. standalone local Mongo), the
        same writes run without one and are undone by hand on failure."""
        kw = {"session": session} if session is not None else {}
        done = {"flagged": False, "payment": False, "muddat": False,
                "advances": False, "settlement": False}
        try:
            upd = await db.procurement_entries.update_many(
                {"id": {"$in": entry_ids}, "is_settled": {"$ne": True}},
                {"$set": {"is_settled": True, "settlement_id": settlement_id}},
                **kw,
            )
            if upd.modified_count != len(entry_ids):
                raise RuntimeError("Entry count mismatch — concurrent settlement suspected")
            done["flagged"] = True

            if payment_doc is not None:
                await db.payments.insert_one(dict(payment_doc), **kw)
                done["payment"] = True

            if muddat_payment_doc is not None:
                await db.payments.insert_one(dict(muddat_payment_doc), **kw)
                done["muddat"] = True

            if advance_rows:
                # Guard with settlement_id $exists:False again to prevent a race
                # where the same advance got consumed by a concurrent settlement
                # between the initial fetch and this write.
                adv_upd = await db.payments.update_many(
                    {
                        "id": {"$in": [r["id"] for r in advance_rows]},
                        "settlement_id": {"$exists": False},
                    },
                    {"$set": {"settlement_id": settlement_id, "consumed_as_advance_in": settlement_id}},
                    **kw,
                )
                if adv_upd.modified_count != len(advance_rows):
                    raise RuntimeError(
                        "One or more advance payments were already applied elsewhere — concurrent settlement suspected"
                    )
                done["advances"] = True

            await db.procurement_settlements.insert_one(dict(settlement_doc), **kw)
            done["settlement"] = True
        except Exception:
            if session is None:
                # No transaction to abort — undo what was written, newest first.
                if done["settlement"]:
                    await db.procurement_settlements.delete_one({"id": settlement_id})
                if done["advances"]:
                    await db.payments.update_many(
                        {"id": {"$in": [r["id"] for r in advance_rows]}, "settlement_id": settlement_id},
                        {"$unset": {"settlement_id": "", "consumed_as_advance_in": ""}},
                    )
                if done["muddat"]:
                    await db.payments.delete_one({"id": muddat_payment_id})
                if done["payment"]:
                    await db.payments.delete_one({"id": payment_id})
                if done["flagged"]:
                    await db.procurement_entries.update_many(
                        {"settlement_id": settlement_id},
                        {"$set": {"is_settled": False}, "$unset": {"settlement_id": ""}},
                    )
            raise

    try:
        await _with_optional_txn(_write_settlement)
    except HTTPException:
        raise
    except Exception as exc:
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
        advance_total=advance_total,
        amount_paid_now=amount_paid_now,
        advance_payment_ids=[r["id"] for r in advance_rows],
        linked_payment_id=payment_id if payment_doc else None,
        muddat_payment_id=muddat_payment_id if muddat_payment_doc else None,
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
    rows = await db.procurement_settlements.find(q, {"_id": 0}).sort([("to_date", -1), ("created_at", -1)]).to_list(None)
    out = []
    for r in rows:
        # Older settlements (pre-advance-payments) won't have these fields —
        # default to "no advances applied", i.e. the full net was paid out.
        out.append(SettlementOut(
            id=r["id"], client_id=r["client_id"], client_name=r["client_name"],
            from_date=r["from_date"], to_date=r["to_date"],
            entry_count=r["entry_count"], gross_amount=r["gross_amount"],
            deduction_percent=r["deduction_percent"], deduction_amount=r["deduction_amount"],
            net_paid=r["net_paid"],
            advance_total=r.get("advance_total", 0.0),
            amount_paid_now=r.get("amount_paid_now", r["net_paid"]),
            advance_payment_ids=r.get("advance_payment_ids", []),
            linked_payment_id=r.get("linked_payment_id"),
            muddat_payment_id=r.get("muddat_payment_id"),
            created_at=r["created_at"],
        ))
    return out


@api_router.get("/procurement/settlements/{settlement_id}", response_model=SettlementDetailOut)
async def get_settlement(settlement_id: str, _user: dict = Depends(get_current_user)):
    r = await db.procurement_settlements.find_one({"id": settlement_id, "from_date": {"$exists": True}}, {"_id": 0})
    if not r:
        raise HTTPException(status_code=404, detail="Settlement not found")
    entry_ids = r.get("entry_ids") or []
    entries = await db.procurement_entries.find({"id": {"$in": entry_ids}}, {"_id": 0}).sort("entry_date", 1).to_list(None)
    return SettlementDetailOut(
        id=r["id"], client_id=r["client_id"], client_name=r["client_name"],
        from_date=r["from_date"], to_date=r["to_date"],
        entry_count=r["entry_count"], gross_amount=r["gross_amount"],
        deduction_percent=r["deduction_percent"], deduction_amount=r["deduction_amount"],
        net_paid=r["net_paid"],
        advance_total=r.get("advance_total", 0.0),
        amount_paid_now=r.get("amount_paid_now", r["net_paid"]),
        advance_payment_ids=r.get("advance_payment_ids", []),
        linked_payment_id=r.get("linked_payment_id"),
        muddat_payment_id=r.get("muddat_payment_id"),
        created_at=r["created_at"],
        entries=_to_entry_refs(entries),
        subtotals=_compute_subtotals(entries),
    )


@api_router.delete("/procurement/settlements/{settlement_id}")
async def undo_settlement(settlement_id: str, user: dict = Depends(get_current_user)):
    """Reverse a settlement: entries become unsettled again, the payment it
    posted and the Muddat deduction are removed, and any advances it consumed
    are released so they can be applied again."""
    _require_admin(user)
    r = await db.procurement_settlements.find_one({"id": settlement_id, "from_date": {"$exists": True}}, {"_id": 0})
    if not r:
        raise HTTPException(status_code=404, detail="Settlement not found")

    result: dict = {}

    async def _undo(session):
        kw = {"session": session} if session is not None else {}
        ent = await db.procurement_entries.update_many(
            {"settlement_id": settlement_id},
            {"$set": {"is_settled": False}, "$unset": {"settlement_id": ""}},
            **kw,
        )
        # 1) release advances this settlement consumed (they keep existing)
        await db.payments.update_many(
            {"consumed_as_advance_in": settlement_id},
            {"$unset": {"settlement_id": "", "consumed_as_advance_in": ""}},
            **kw,
        )
        # 2) what's left tagged with this settlement are the payments it created
        pay = await db.payments.delete_many({"settlement_id": settlement_id}, **kw)
        await db.procurement_settlements.delete_one({"id": settlement_id}, **kw)
        result["entries_released"] = ent.modified_count
        result["payments_removed"] = pay.deleted_count

    try:
        await _with_optional_txn(_undo)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not undo settlement: {exc}")
    return {"ok": True, **result}


# =========================================================================
# SALES ENTRY MODULE — outgoing stock sold to mills, dispatched by truck.
# Standalone (like procurement): not linked to the payment ledger.
# =========================================================================

class SaleBase(BaseModel):
    product_id: str
    buyer_name: str = Field(min_length=1, max_length=120)
    dalal_name: Optional[str] = Field(default=None, max_length=120)  # broker, optional
    quantity: float = Field(gt=0)  # quintals
    rate: float = Field(gt=0)      # ₹ per quintal
    transport_company: str = Field(min_length=1, max_length=120)
    driver_name: str = Field(min_length=1, max_length=120)
    driver_phone: Optional[str] = Field(default=None, max_length=20)
    truck_number: str = Field(min_length=1, max_length=20)
    dispatch_date: str  # YYYY-MM-DD


class SaleCreate(SaleBase):
    pass


class SaleOut(BaseModel):
    id: str
    product_id: str
    product_name: str
    buyer_name: str
    dalal_name: Optional[str] = None
    quantity: float
    rate: float
    total_amount: float
    transport_company: str
    driver_name: str
    driver_phone: Optional[str] = None
    truck_number: str
    dispatch_date: str
    entered_by: str
    bill_no: Optional[str] = None
    created_at: str


def _clean_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    v = " ".join(value.split())
    return v or None


def _clean_upper(value: Optional[str]) -> Optional[str]:
    """Trim, collapse spaces and force CAPITALS (names are stored uppercase so
    'Krishna Mills' and 'krishna mills' can never become two different names)."""
    v = _clean_text(value)
    return v.upper() if v else None


def _normalize_truck(value: str) -> str:
    return " ".join(value.upper().split())


def _normalize_phone(value: Optional[str]) -> Optional[str]:
    """Optional. If given it must be exactly 10 digits — nothing else is accepted."""
    v = _clean_text(value)
    if not v:
        return None
    if not re.fullmatch(r"[0-9]{10}", v):
        raise HTTPException(status_code=400, detail="Driver phone must be exactly 10 digits")
    return v


async def _build_sale_doc(payload: SaleBase, exclude_id: Optional[str] = None) -> dict:
    try:
        d = datetime.strptime(payload.dispatch_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid dispatch_date (YYYY-MM-DD)")
    if d > today_local_date():
        raise HTTPException(status_code=400, detail="Dispatch date cannot be in the future")

    p = await db.master_products.find_one({"id": payload.product_id}, {"_id": 0})
    if not p:
        raise HTTPException(status_code=404, detail="Product not found")

    buyer = _clean_upper(payload.buyer_name)
    company = _clean_upper(payload.transport_company)
    driver = _clean_upper(payload.driver_name)
    truck = _normalize_truck(payload.truck_number)
    if not (buyer and company and driver and truck):
        raise HTTPException(status_code=400, detail="Required fields cannot be blank")

    # One grain per company: a company can only be sold the grain(s) it already
    # has (older data with several grains keeps working). A brand-new company
    # takes whatever grain its first truck has. The sale being edited is ignored,
    # so the only truck of a company can still change grain.
    others = await db.sales_entries.find(
        {"buyer_name": {"$in": await _buyer_variants(_norm_name(buyer))}},
        {"_id": 0, "id": 1, "product_id": 1, "product_name": 1},
    ).to_list(None)
    allowed = {o["product_id"]: o.get("product_name") for o in others if o["id"] != exclude_id}
    if allowed and p["id"] not in allowed:
        names = ", ".join(sorted({str(n) for n in allowed.values() if n}))
        raise HTTPException(status_code=400, detail=f"{buyer} buys only {names}. A company can be sold only one grain.")

    return {
        "product_id": p["id"],
        "product_name": p["name"],
        "buyer_name": buyer,
        "dalal_name": _clean_upper(payload.dalal_name),
        "quantity": float(payload.quantity),
        "rate": float(payload.rate),
        "total_amount": round(float(payload.quantity) * float(payload.rate), 2),
        "transport_company": company,
        "driver_name": driver,
        "driver_phone": _normalize_phone(payload.driver_phone),
        "truck_number": truck,
        "dispatch_date": payload.dispatch_date,
    }


@api_router.post("/sales", response_model=SaleOut)
async def create_sale(payload: SaleCreate, user: dict = Depends(get_current_user)):
    doc = await _build_sale_doc(payload)
    doc.update({
        "id": str(uuid.uuid4()),
        "bill_no": await _next_bill_no(doc["dispatch_date"]),
        "entered_by": user.get("name", "Accountant"),
        "entered_by_id": user["id"],
        "created_at": now_iso(),
    })
    await db.sales_entries.insert_one(doc)
    return SaleOut(**doc)


@api_router.get("/sales", response_model=List[SaleOut])
async def list_sales(
    dispatch_date: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    product_id: Optional[str] = None,
    buyer_name: Optional[str] = None,
    dalal_name: Optional[str] = None,
    limit: int = 200,
    _user: dict = Depends(get_current_user),
):
    q: dict = {}
    for label, val in (("dispatch_date", dispatch_date), ("from_date", from_date), ("to_date", to_date)):
        if val:
            try:
                datetime.strptime(val, "%Y-%m-%d")
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid {label} (YYYY-MM-DD)")
    if dispatch_date:
        q["dispatch_date"] = dispatch_date
    elif from_date or to_date:
        rng: dict = {}
        if from_date:
            rng["$gte"] = from_date
        if to_date:
            rng["$lte"] = to_date
        q["dispatch_date"] = rng
    if product_id:
        q["product_id"] = product_id
    if buyer_name:
        q["buyer_name"] = buyer_name
    if dalal_name:
        q["dalal_name"] = dalal_name
    limit = max(1, min(limit, 1000))
    rows = (
        await db.sales_entries.find(q, {"_id": 0})
        .sort([("dispatch_date", -1), ("created_at", -1)])
        .to_list(limit)
    )
    return [SaleOut(**r) for r in rows]


@api_router.get("/sales/suggestions")
async def sale_suggestions(_user: dict = Depends(get_current_user)):
    """Distinct buyer / dalal / transport names used before — powers autocomplete."""
    async def distinct(field: str) -> list:
        vals = await db.sales_entries.distinct(field)
        # Upper-case + de-duplicate, so older mixed-case entries show once.
        return sorted({" ".join(v.split()).upper() for v in vals if v and v.strip()})

    rows = await db.sales_entries.find(
        {}, {"_id": 0, "buyer_name": 1, "product_id": 1, "product_name": 1}
    ).to_list(None)
    grains: dict = {}
    trucks: dict = {}
    for r in rows:
        k = _norm_name(r.get("buyer_name"))
        if not k:
            continue
        grains.setdefault(k, {})[r["product_id"]] = r.get("product_name")
        trucks[k] = trucks.get(k, 0) + 1
    return {
        "buyers": await distinct("buyer_name"),
        "dalals": await distinct("dalal_name"),
        "transport_companies": await distinct("transport_company"),
        "buyer_products": {
            k: [{"product_id": i, "product_name": n} for i, n in v.items()] for k, v in grains.items()
        },
        "buyer_trucks": trucks,
    }


@api_router.put("/sales/{sale_id}", response_model=SaleOut)
async def update_sale(sale_id: str, payload: SaleCreate, _user: dict = Depends(get_current_user)):
    existing = await db.sales_entries.find_one({"id": sale_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Sale not found")
    changes = await _build_sale_doc(payload, exclude_id=sale_id)
    await db.sales_entries.update_one({"id": sale_id}, {"$set": changes})
    existing.update(changes)
    return SaleOut(**existing)


@api_router.delete("/sales/{sale_id}")
async def delete_sale(sale_id: str, _user: dict = Depends(get_current_user)):
    res = await db.sales_entries.delete_one({"id": sale_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Sale not found")
    await db.sale_settlements.delete_many({"sale_id": sale_id})
    return {"ok": True}


# ----- Bills (auto-generated from a sale entry) -----
BILL_PREFIX = os.environ.get("BILL_PREFIX", "INV")
BUSINESS_ADDRESS = os.environ.get("BUSINESS_ADDRESS", "")
BUSINESS_PHONE = os.environ.get("BUSINESS_PHONE", "")
BUSINESS_GSTIN = os.environ.get("BUSINESS_GSTIN", "")

_ONES = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
    "Eighteen", "Nineteen",
]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _words_below_1000(n: int) -> str:
    parts = []
    if n >= 100:
        parts.append(_ONES[n // 100] + " Hundred")
        n %= 100
    if n >= 20:
        parts.append((_TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else "")).strip())
    elif n > 0:
        parts.append(_ONES[n])
    return " ".join(parts)


def _num_words(n: int) -> str:
    """Indian numbering: crore / lakh / thousand."""
    if n == 0:
        return "Zero"
    out = []
    for div, name in ((10 ** 7, "Crore"), (10 ** 5, "Lakh"), (1000, "Thousand")):
        if n >= div:
            out.append(_num_words(n // div) + " " + name)
            n %= div
    if n:
        out.append(_words_below_1000(n))
    return " ".join(out)


def _rupees_in_words(amount: float) -> str:
    rupees = int(amount)
    paise = int(round((amount - rupees) * 100))
    if paise == 100:
        rupees, paise = rupees + 1, 0
    text = "Rupees " + _num_words(rupees)
    if paise:
        text += " and " + _num_words(paise) + " Paise"
    return text + " Only"


def _financial_year(date_str: str) -> str:
    """Indian financial year (Apr–Mar) a date falls in, e.g. '2026-27'."""
    d = datetime.strptime(date_str, "%Y-%m-%d").date()
    start = d.year if d.month >= 4 else d.year - 1
    return f"{start}-{str(start + 1)[2:]}"


async def _next_bill_no(date_str: str) -> str:
    """Atomically allocate the next bill number for the financial year of
    `date_str`, e.g. INV/2026-27/0001. The counter lives in `bill_counters`
    (included in backups), and a candidate is skipped if a sale already
    carries it — so a restored/older counter can never produce a duplicate."""
    fy = _financial_year(date_str)
    key = f"bill-{fy}"
    for _ in range(50):
        try:
            rec = await db.bill_counters.find_one_and_update(
                {"id": key},
                {"$inc": {"seq": 1}},
                upsert=True,
                return_document=ReturnDocument.AFTER,
                projection={"_id": 0},
            )
        except DuplicateKeyError:
            continue  # two first-ever requests raced on the upsert; retry
        candidate = f"{BILL_PREFIX}/{fy}/{int(rec['seq']):04d}"
        if not await db.sales_entries.find_one({"bill_no": candidate}, {"_id": 1}):
            return candidate
    raise HTTPException(status_code=500, detail="Could not allocate a bill number")


def _build_bill_story(s: dict) -> list:
    styles = getSampleStyleSheet()
    ink, muted, line = colors.HexColor("#1C1917"), colors.HexColor("#57534E"), colors.HexColor("#E7E5E4")
    biz = ParagraphStyle("bbiz", parent=styles["Title"], fontName="Times-Bold", fontSize=22,
                         textColor=ink, alignment=0, leading=24, spaceAfter=2)
    small = ParagraphStyle("bsmall", parent=styles["Normal"], fontName="Helvetica", fontSize=8.5,
                           textColor=muted, leading=11)
    label = ParagraphStyle("blabel", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=7.5,
                           textColor=colors.HexColor("#78716C"), leading=10)
    val = ParagraphStyle("bval", parent=styles["Normal"], fontName="Helvetica", fontSize=10,
                         textColor=ink, leading=13)
    val_b = ParagraphStyle("bvalb", parent=val, fontName="Helvetica-Bold")
    title = ParagraphStyle("btitle", parent=styles["Heading1"], fontName="Times-Bold", fontSize=17,
                           textColor=ink, spaceBefore=8, spaceAfter=8)
    esc = lambda x: xml_escape(str(x)) if x else ""  # noqa: E731

    story: list = [Paragraph(esc(BUSINESS_NAME), biz)]
    for txt in (BUSINESS_ADDRESS,
                f"Phone: {BUSINESS_PHONE}" if BUSINESS_PHONE else "",
                f"GSTIN: {BUSINESS_GSTIN}" if BUSINESS_GSTIN else ""):
        if txt:
            story.append(Paragraph(esc(txt), small))
    story += [
        HRFlowable(width="100%", thickness=0.8, color=colors.HexColor("#292524"), spaceBefore=6, spaceAfter=4),
        Paragraph("SALE BILL", title),
    ]

    # Billed-to (left) + bill meta (right)
    left = [Paragraph("BILLED TO", label), Paragraph(esc(s["buyer_name"]), val_b)]
    right_rows = [
        [Paragraph("BILL NO.", label), Paragraph(esc(s["bill_no"]), val_b)],
        [Paragraph("BILL DATE", label), Paragraph(esc(s["dispatch_date"]), val)],
    ]
    if s.get("dalal_name"):
        right_rows.append([Paragraph("BROKER (DALAL)", label), Paragraph(esc(s["dalal_name"]), val)])
    right = Table(right_rows, colWidths=[32 * mm, 52 * mm])
    right.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                               ("BOTTOMPADDING", (0, 0), (-1, -1), 3), ("TOPPADDING", (0, 0), (-1, -1), 0)]))
    head = Table([[left, right]], colWidths=[90 * mm, 84 * mm])
    head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story += [head, Spacer(1, 12)]

    # Item table
    qty, rate, total = float(s["quantity"]), float(s["rate"]), float(s["total_amount"])
    items = Table(
        [
            ["#", "Description", "Qty (Qtl)", "Rate (Rs./Qtl)", "Amount"],
            ["1", s["product_name"], f"{qty:,.2f}", _fmt_inr(rate), _fmt_inr(total)],
            ["", "", "", "Total", _fmt_inr(total)],
        ],
        colWidths=[12 * mm, 62 * mm, 30 * mm, 34 * mm, 36 * mm],
    )
    items.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.5),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#78716C")),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F5F4F0")),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#78716C")),
        ("FONT", (0, 1), (-1, 1), "Helvetica", 10),
        ("LINEBELOW", (0, 1), (-1, 1), 0.3, line),
        ("FONT", (3, 2), (-1, 2), "Helvetica-Bold", 11),
        ("LINEABOVE", (3, 2), (-1, 2), 0.8, colors.HexColor("#292524")),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story += [items, Spacer(1, 8)]
    story.append(Paragraph(f"<b>Amount in words:</b> {esc(_rupees_in_words(total))}", val))
    story.append(Spacer(1, 16))

    # Transport details
    def kv(k, v):
        return [Paragraph(k, label), Paragraph(esc(v) or "—", val)]
    t_rows = [
        kv("TRANSPORT COMPANY", s.get("transport_company")) + kv("TRUCK NO.", s.get("truck_number")),
        kv("DRIVER", s.get("driver_name")) + kv("DRIVER PHONE", s.get("driver_phone")),
        kv("DISPATCH DATE", s.get("dispatch_date")) + [Paragraph("", val), Paragraph("", val)],
    ]
    story.append(Paragraph("TRANSPORT DETAILS", label))
    story.append(Spacer(1, 4))
    tt = Table(t_rows, colWidths=[38 * mm, 49 * mm, 28 * mm, 59 * mm])
    tt.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 0.4, line), ("LINEBELOW", (0, 0), (-1, -1), 0.3, line),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [tt, Spacer(1, 40)]

    # Signatures
    sig = Table(
        [[Paragraph("Received by (Buyer)", small), Paragraph(f"For {esc(BUSINESS_NAME)}", ParagraphStyle(
            "sigr", parent=small, alignment=2))],
         [Spacer(1, 28), Spacer(1, 28)],
         [Paragraph("Signature", small), Paragraph("Authorised Signatory", ParagraphStyle(
             "sigr2", parent=small, alignment=2))]],
        colWidths=[87 * mm, 87 * mm],
    )
    sig.setStyle(TableStyle([("LINEABOVE", (0, 2), (0, 2), 0.5, muted), ("LINEABOVE", (1, 2), (1, 2), 0.5, muted),
                             ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story.append(sig)
    return story


@api_router.get("/sales/{sale_id}/bill")
async def sale_bill(sale_id: str, _user: dict = Depends(get_current_user)):
    s = await db.sales_entries.find_one({"id": sale_id}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=404, detail="Sale not found")
    if not s.get("bill_no"):
        # Sale recorded before bills existed — number it now, once.
        number = await _next_bill_no(s["dispatch_date"])
        await db.sales_entries.update_one({"id": sale_id, "bill_no": None}, {"$set": {"bill_no": number}})
        s = await db.sales_entries.find_one({"id": sale_id}, {"_id": 0})
    filename = f"bill_{s['bill_no'].replace('/', '-')}.pdf"
    return _pdf_stream(_build_bill_story(s), filename)


# =========================================================================
# SALES BY COMPANY — statement of every sale to a company, payments received
# from it, and the running balance (what it still owes).
# Balance = total sold − payments received. Positive = due from the company;
# negative = advance received.
# =========================================================================

class SalePaymentCreate(BaseModel):
    buyer_name: str = Field(min_length=1, max_length=120)
    amount: float = Field(gt=0)
    payment_date: str  # YYYY-MM-DD
    mode: Literal["cash", "bank", "upi", "cheque", "other"] = "cash"
    note: Optional[str] = Field(default=None, max_length=200)


class SalePaymentOut(BaseModel):
    id: str
    buyer_name: str
    amount: float
    payment_date: str
    mode: str
    note: Optional[str] = None
    entered_by: str
    created_at: str


def _norm_name(value: Optional[str]) -> str:
    """Canonical company key: trimmed, single-spaced, CAPITALS."""
    return " ".join((value or "").split()).upper()


async def _buyer_variants(norm: str) -> list:
    """Every stored spelling of one company (older entries may be mixed-case)."""
    names = await db.sales_entries.distinct("buyer_name")
    return [n for n in names if _norm_name(n) == norm]


def _check_ymd(value: Optional[str], label: str) -> None:
    if not value:
        return
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid {label} (YYYY-MM-DD)")


@api_router.post("/sales/payments", response_model=SalePaymentOut)
async def create_sale_payment(payload: SalePaymentCreate, user: dict = Depends(get_current_user)):
    buyer = _norm_name(payload.buyer_name)
    if not buyer:
        raise HTTPException(status_code=400, detail="Company name is required")
    _check_ymd(payload.payment_date, "payment_date")
    if datetime.strptime(payload.payment_date, "%Y-%m-%d").date() > today_local_date():
        raise HTTPException(status_code=400, detail="Payment date cannot be in the future")
    if not await _buyer_variants(buyer):
        raise HTTPException(status_code=404, detail="No sales recorded for this company")
    doc = {
        "id": str(uuid.uuid4()),
        "buyer_name": buyer,
        "amount": round(float(payload.amount), 2),
        "payment_date": payload.payment_date,
        "mode": payload.mode,
        "note": _clean_text(payload.note),
        "entered_by": user.get("name", "Accountant"),
        "entered_by_id": user["id"],
        "created_at": now_iso(),
    }
    await db.sale_payments.insert_one(doc)
    return SalePaymentOut(**doc)


@api_router.delete("/sales/payments/{payment_id}")
async def delete_sale_payment(payment_id: str, _user: dict = Depends(get_current_user)):
    doc = await db.sale_payments.find_one({"id": payment_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Payment not found")
    # Money already assigned to trucks must stay backed by received payments.
    state = await _company_money_state(doc["buyer_name"])
    if state["unassigned"] - float(doc["amount"]) < -SETTLE_EPS:
        raise HTTPException(
            status_code=400,
            detail="This money is already assigned to trucks. Undo those trucks first, then delete the payment.",
        )
    await db.sale_payments.delete_one({"id": payment_id})
    return {"ok": True}


# ----- Truck-wise settlement -----------------------------------------------
# A bulk payment is first saved on the company (balance drops at once). Later,
# each truck can be "settled": part of the received money is assigned to it
# (paid) and/or the company's deduction is recorded (cut).
#   truck due        = truck amount - paid - cut
#   company balance  = total sold - payments received - cuts
#   not yet assigned = payments received - sum of paid on trucks
SETTLE_EPS = 0.01


class SettleCreate(BaseModel):
    sale_id: str
    paid: float = Field(default=0, ge=0)
    cut: float = Field(default=0, ge=0)
    date: str  # YYYY-MM-DD
    note: Optional[str] = Field(default=None, max_length=200)


class SettleOut(BaseModel):
    id: str
    sale_id: str
    buyer_name: str
    truck_number: Optional[str] = None
    paid: float
    cut: float
    date: str
    note: Optional[str] = None
    created_at: str


class AutoSettleRequest(BaseModel):
    buyer_name: str = Field(min_length=1, max_length=120)


def _inr2(n: float) -> str:
    return f"₹{n:,.2f}"


async def _company_money_state(norm: str) -> dict:
    """Sales, truck settlements and received/assigned money of one company."""
    variants = await _buyer_variants(norm)
    sales = (
        await db.sales_entries.find({"buyer_name": {"$in": variants}}, {"_id": 0}).to_list(None)
        if variants else []
    )
    ids = [s["id"] for s in sales]
    sets = (
        await db.sale_settlements.find({"sale_id": {"$in": ids}}, {"_id": 0}).to_list(None)
        if ids else []
    )
    pays = await db.sale_payments.find({"buyer_name": norm}, {"_id": 0, "amount": 1}).to_list(None)
    per_sale: dict = {}
    for x in sets:
        d = per_sale.setdefault(x["sale_id"], {"paid": 0.0, "cut": 0.0})
        d["paid"] += float(x.get("paid", 0))
        d["cut"] += float(x.get("cut", 0))
    received = round(sum(float(p["amount"]) for p in pays), 2)
    assigned = round(sum(v["paid"] for v in per_sale.values()), 2)
    return {
        "sales": sales, "settlements": sets, "per_sale": per_sale,
        "received": received, "assigned": assigned,
        "unassigned": round(received - assigned, 2),
        "cuts": round(sum(v["cut"] for v in per_sale.values()), 2),
    }


@api_router.post("/sales/settlements", response_model=SettleOut)
async def create_truck_settlement(payload: SettleCreate, user: dict = Depends(get_current_user)):
    sale = await db.sales_entries.find_one({"id": payload.sale_id}, {"_id": 0})
    if not sale:
        raise HTTPException(status_code=404, detail="Truck entry not found")
    _check_ymd(payload.date, "date")
    if datetime.strptime(payload.date, "%Y-%m-%d").date() > today_local_date():
        raise HTTPException(status_code=400, detail="Date cannot be in the future")
    paid = round(float(payload.paid), 2)
    cut = round(float(payload.cut), 2)
    if paid + cut <= 0:
        raise HTTPException(status_code=400, detail="Enter the paid amount or the cut")
    norm = _norm_name(sale.get("buyer_name"))
    state = await _company_money_state(norm)
    ss = state["per_sale"].get(sale["id"], {"paid": 0.0, "cut": 0.0})
    due = round(float(sale["total_amount"]) - ss["paid"] - ss["cut"], 2)
    if paid + cut > due + SETTLE_EPS:
        raise HTTPException(status_code=400, detail=f"This truck has only {_inr2(max(due, 0))} due")
    if paid > state["unassigned"] + SETTLE_EPS:
        raise HTTPException(
            status_code=400,
            detail=f"Only {_inr2(max(state['unassigned'], 0))} of the received money is not yet assigned to trucks",
        )
    doc = {
        "id": str(uuid.uuid4()),
        "sale_id": sale["id"],
        "buyer_name": norm,
        "truck_number": sale.get("truck_number"),
        "bill_no": sale.get("bill_no"),
        "paid": paid,
        "cut": cut,
        "date": payload.date,
        "note": _clean_text(payload.note),
        "entered_by": user.get("name", "Accountant"),
        "created_at": now_iso(),
    }
    await db.sale_settlements.insert_one(doc)
    return SettleOut(**doc)


@api_router.delete("/sales/settlements/by-sale/{sale_id}")
async def undo_truck_settlement(sale_id: str, _user: dict = Depends(get_current_user)):
    """Undo: puts the truck back to unsettled (money returns to 'not yet assigned')."""
    res = await db.sale_settlements.delete_many({"sale_id": sale_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Nothing to undo for this truck")
    return {"ok": True, "removed": res.deleted_count}


@api_router.post("/sales/companies/auto-settle")
async def auto_settle_company(payload: AutoSettleRequest, user: dict = Depends(get_current_user)):
    """Assign the not-yet-assigned money to the oldest unpaid trucks, no typing."""
    norm = _norm_name(payload.buyer_name)
    if not await _buyer_variants(norm):
        raise HTTPException(status_code=404, detail="No sales recorded for this company")
    state = await _company_money_state(norm)
    left = state["unassigned"]
    if left <= SETTLE_EPS:
        raise HTTPException(status_code=400, detail="No received money is waiting to be assigned")
    today = today_local_date().isoformat()
    trucks = sorted(state["sales"], key=lambda s: (s.get("dispatch_date", ""), s.get("created_at", "")))
    done = 0
    assigned = 0.0
    for s in trucks:
        ss = state["per_sale"].get(s["id"], {"paid": 0.0, "cut": 0.0})
        due = round(float(s["total_amount"]) - ss["paid"] - ss["cut"], 2)
        if due <= SETTLE_EPS:
            continue
        take = round(min(due, left), 2)
        if take <= SETTLE_EPS:
            break
        await db.sale_settlements.insert_one({
            "id": str(uuid.uuid4()), "sale_id": s["id"], "buyer_name": norm,
            "truck_number": s.get("truck_number"), "bill_no": s.get("bill_no"),
            "paid": take, "cut": 0.0, "date": today, "note": "Auto-settled",
            "entered_by": user.get("name", "Accountant"), "created_at": now_iso(),
        })
        left = round(left - take, 2)
        assigned += take
        done += 1
        if left <= SETTLE_EPS:
            break
    if done == 0:
        raise HTTPException(status_code=400, detail="No trucks with money due")
    return {"ok": True, "trucks": done, "assigned": round(assigned, 2), "unassigned": max(left, 0.0)}


@api_router.get("/sales/payments/by-date")
async def sale_payments_by_date(date_str: str, _user: dict = Depends(get_current_user)):
    """Payments received from sales companies on one day (for the Dashboard)."""
    _check_ymd(date_str, "date_str")
    pays = await db.sale_payments.find({"payment_date": date_str}, {"_id": 0}).to_list(None)
    pays.sort(key=lambda p: p.get("created_at", ""), reverse=True)
    rows = await db.sales_entries.find({}, {"_id": 0, "buyer_name": 1, "product_name": 1}).to_list(None)
    grains: dict = {}
    for r in rows:
        if r.get("product_name"):
            grains.setdefault(_norm_name(r.get("buyer_name")), set()).add(r["product_name"])
    return [
        {
            "id": p["id"], "buyer_name": p["buyer_name"], "amount": float(p["amount"]),
            "mode": p.get("mode"), "note": p.get("note"), "payment_date": p["payment_date"],
            "created_at": p.get("created_at", ""), "entered_by": p.get("entered_by"),
            "product_names": sorted(grains.get(_norm_name(p["buyer_name"]), [])),
        }
        for p in pays
    ]


@api_router.get("/sales/dashboard-summary")
async def sales_dashboard_summary(user: dict = Depends(get_current_user)):
    """Total still due from all sales companies (after payments and cuts)."""
    companies = await list_sale_companies(user)
    return {
        "due_total": round(sum(c["balance"] for c in companies), 2),
        "companies_with_due": sum(1 for c in companies if c["balance"] > SETTLE_EPS),
    }


@api_router.get("/sales/companies")
async def list_sale_companies(_user: dict = Depends(get_current_user)):
    """One row per company: trucks, quantity, sold, received, balance, last dates."""
    sales = await db.sales_entries.find(
        {}, {"_id": 0, "id": 1, "buyer_name": 1, "product_name": 1, "quantity": 1, "total_amount": 1, "dispatch_date": 1}
    ).to_list(None)
    pays = await db.sale_payments.find(
        {}, {"_id": 0, "buyer_name": 1, "amount": 1, "payment_date": 1}
    ).to_list(None)
    sets = await db.sale_settlements.find({}, {"_id": 0, "sale_id": 1, "cut": 1}).to_list(None)
    sale_owner = {s["id"]: _norm_name(s.get("buyer_name")) for s in sales if s.get("id")}

    agg: dict = {}
    for s in sales:
        key = _norm_name(s.get("buyer_name"))
        if not key:
            continue
        a = agg.setdefault(key, {"buyer_name": key, "trucks": 0, "total_quantity": 0.0, "total_amount": 0.0,
                                 "total_paid": 0.0, "total_cuts": 0.0, "last_sale_date": None, "last_payment_date": None,
                                 "_prods": set()})
        a["trucks"] += 1
        if s.get("product_name"):
            a["_prods"].add(s["product_name"])
        a["total_quantity"] += float(s.get("quantity", 0))
        a["total_amount"] += float(s.get("total_amount", 0))
        d = s.get("dispatch_date")
        if d and (a["last_sale_date"] is None or d > a["last_sale_date"]):
            a["last_sale_date"] = d
    for p in pays:
        a = agg.get(_norm_name(p.get("buyer_name")))
        if a is None:
            continue
        a["total_paid"] += float(p.get("amount", 0))
        d = p.get("payment_date")
        if d and (a["last_payment_date"] is None or d > a["last_payment_date"]):
            a["last_payment_date"] = d

    for x in sets:
        a = agg.get(sale_owner.get(x.get("sale_id"), ""))
        if a is not None:
            a["total_cuts"] += float(x.get("cut", 0))

    out = []
    for a in agg.values():
        a["product_names"] = sorted(a.pop("_prods"))
        a["total_cuts"] = round(a["total_cuts"], 2)
        a["total_quantity"] = round(a["total_quantity"], 2)
        a["total_amount"] = round(a["total_amount"], 2)
        a["total_paid"] = round(a["total_paid"], 2)
        a["balance"] = round(a["total_amount"] - a["total_paid"] - a["total_cuts"], 2)
        out.append(a)
    out.sort(key=lambda r: r["buyer_name"])
    return out


async def _build_statement(
    buyer_name: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    product_id: Optional[str] = None,
) -> dict:
    norm = _norm_name(buyer_name)
    if not norm:
        raise HTTPException(status_code=400, detail="Company name is required")
    _check_ymd(from_date, "from_date")
    _check_ymd(to_date, "to_date")
    if from_date and to_date and from_date > to_date:
        raise HTTPException(status_code=400, detail="from_date cannot be after to_date")

    variants = await _buyer_variants(norm)
    if not variants:
        raise HTTPException(status_code=404, detail="No sales recorded for this company")

    q: dict = {"buyer_name": {"$in": variants}}
    if product_id:
        q["product_id"] = product_id
    sales = await db.sales_entries.find(q, {"_id": 0}).to_list(None)
    money_state = await _company_money_state(norm)
    per_sale = money_state["per_sale"]

    # Payments aren't tied to a product, so a balance only makes sense for the
    # whole company. With a product filter we list sales only.
    with_payments = not product_id
    payments = (
        await db.sale_payments.find({"buyer_name": norm}, {"_id": 0}).to_list(None)
        if with_payments else []
    )
    cut_rows = (
        [c for c in money_state["settlements"] if float(c.get("cut", 0)) > 0]
        if with_payments else []
    )

    def in_range(d: str) -> bool:
        return (not from_date or d >= from_date) and (not to_date or d <= to_date)

    opening = 0.0
    if with_payments and from_date:
        opening = (
            sum(float(s["total_amount"]) for s in sales if s["dispatch_date"] < from_date)
            - sum(float(p["amount"]) for p in payments if p["payment_date"] < from_date)
            - sum(float(c["cut"]) for c in cut_rows if c["date"] < from_date)
        )

    events = (
        [("sale", s["dispatch_date"], 0, s.get("created_at", ""), s) for s in sales if in_range(s["dispatch_date"])]
        + [("payment", p["payment_date"], 1, p.get("created_at", ""), p) for p in payments if in_range(p["payment_date"])]
        + [("cut", c["date"], 2, c.get("created_at", ""), c) for c in cut_rows if in_range(c["date"])]
    )
    events.sort(key=lambda e: (e[1], e[2], e[3]))

    running = opening
    rows: list = []
    sold_amount = sold_qty = paid_total = cuts_total = 0.0
    trucks = 0
    by_product: dict = {}
    for kind, d, _order, _created, x in events:
        if kind == "sale":
            amt = float(x["total_amount"])
            running += amt
            sold_amount += amt
            sold_qty += float(x["quantity"])
            trucks += 1
            bp = by_product.setdefault(x["product_name"], {"product_name": x["product_name"], "trucks": 0, "quantity": 0.0, "amount": 0.0})
            bp["trucks"] += 1
            bp["quantity"] += float(x["quantity"])
            bp["amount"] += amt
            ss = per_sale.get(x["id"], {"paid": 0.0, "cut": 0.0})
            due = round(amt - ss["paid"] - ss["cut"], 2)
            status = "settled" if due <= SETTLE_EPS else ("part" if (ss["paid"] + ss["cut"]) > 0 else "due")
            rows.append({
                "type": "sale", "id": x["id"], "date": d, "bill_no": x.get("bill_no"),
                "product_name": x["product_name"], "quantity": float(x["quantity"]), "rate": float(x["rate"]),
                "amount": amt, "dalal_name": x.get("dalal_name"), "truck_number": x.get("truck_number"),
                "driver_name": x.get("driver_name"), "driver_phone": x.get("driver_phone"),
                "transport_company": x.get("transport_company"),
                "settled_paid": round(ss["paid"], 2), "settled_cut": round(ss["cut"], 2),
                "due": max(due, 0.0), "status": status,
                "running_balance": round(running, 2) if with_payments else None,
            })
        elif kind == "payment":
            amt = float(x["amount"])
            running -= amt
            paid_total += amt
            rows.append({
                "type": "payment", "id": x["id"], "date": d, "amount": amt,
                "mode": x.get("mode"), "note": x.get("note"), "entered_by": x.get("entered_by"),
                "running_balance": round(running, 2),
            })
        else:  # a cut (deduction) recorded while settling a truck
            amt = float(x["cut"])
            running -= amt
            cuts_total += amt
            rows.append({
                "type": "cut", "id": x["id"], "date": d, "amount": amt,
                "truck_number": x.get("truck_number"), "bill_no": x.get("bill_no"),
                "note": x.get("note"), "sale_id": x.get("sale_id"),
                "running_balance": round(running, 2),
            })

    return {
        "buyer_name": norm,
        "product_names": sorted({x.get("product_name") for x in money_state["sales"] if x.get("product_name")}),
        "from_date": from_date,
        "to_date": to_date,
        "product_id": product_id,
        "with_payments": with_payments,
        "opening_balance": round(opening, 2) if with_payments else None,
        "rows": rows,
        "summary": {
            "received_all": money_state["received"],
            "assigned_all": money_state["assigned"],
            "unassigned": money_state["unassigned"],
            "cuts_all": money_state["cuts"],
        },
        "totals": {
            "trucks": trucks,
            "quantity": round(sold_qty, 2),
            "sales_amount": round(sold_amount, 2),
            "payments_total": round(paid_total, 2),
            "cuts_total": round(cuts_total, 2),
            "closing_balance": round(opening + sold_amount - paid_total - cuts_total, 2) if with_payments else None,
            "avg_rate": round(sold_amount / sold_qty, 2) if sold_qty > 0 else None,
        },
        "product_subtotals": [
            {**v, "quantity": round(v["quantity"], 2), "amount": round(v["amount"], 2)}
            for v in sorted(by_product.values(), key=lambda v: v["product_name"])
        ],
    }


@api_router.get("/sales/companies/statement")
async def company_statement(
    buyer_name: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    product_id: Optional[str] = None,
    _user: dict = Depends(get_current_user),
):
    return await _build_statement(buyer_name, from_date, to_date, product_id)


def _statement_csv(st: dict) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([f"{BUSINESS_NAME} - Sales Statement"])
    w.writerow(["Company", st["buyer_name"]])
    w.writerow(["Period", f"{st['from_date'] or 'Start'} to {st['to_date'] or 'Today'}"])
    w.writerow([])
    w.writerow(["Date", "Type", "Bill No", "Product", "Quantity (Qtl)", "Rate (Rs./Qtl)", "Amount (Rs.)",
                "Received (Rs.)", "Cut (Rs.)", "Balance (Rs.)", "Dalal", "Truck", "Driver", "Driver Phone",
                "Transport Company", "Payment Mode", "Note", "Truck Status", "Truck Due (Rs.)"])
    if st["with_payments"] and st["from_date"]:
        w.writerow([st["from_date"], "Opening balance", "", "", "", "", "", "", "", f"{st['opening_balance']:.2f}"])
    status_text = {"settled": "Settled", "part": "Part settled", "due": "Due"}
    for r in st["rows"]:
        bal = "" if r["running_balance"] is None else f"{r['running_balance']:.2f}"
        if r["type"] == "sale":
            w.writerow([r["date"], "Sale", r.get("bill_no") or "", r["product_name"], f"{r['quantity']:.2f}",
                        f"{r['rate']:.2f}", f"{r['amount']:.2f}", "", "", bal, r.get("dalal_name") or "",
                        r.get("truck_number") or "", r.get("driver_name") or "", r.get("driver_phone") or "",
                        r.get("transport_company") or "", "", "",
                        status_text.get(r.get("status"), ""), f"{r.get('due', 0):.2f}"])
        elif r["type"] == "payment":
            w.writerow([r["date"], "Payment", "", "", "", "", "", f"{r['amount']:.2f}", "", bal, "", "", "", "", "",
                        (r.get("mode") or "").upper(), r.get("note") or ""])
        else:
            w.writerow([r["date"], "Cut", r.get("bill_no") or "", "", "", "", "", "", f"{r['amount']:.2f}", bal,
                        "", r.get("truck_number") or "", "", "", "", "", r.get("note") or ""])
    t = st["totals"]
    w.writerow([])
    w.writerow(["TOTAL", "", "", "", f"{t['quantity']:.2f}", f"{t['avg_rate'] or 0:.2f}",
                f"{t['sales_amount']:.2f}", f"{t['payments_total']:.2f}", f"{t['cuts_total']:.2f}",
                "" if t["closing_balance"] is None else f"{t['closing_balance']:.2f}"])
    w.writerow(["Trucks", t["trucks"]])
    sm = st.get("summary") or {}
    if st["with_payments"]:
        w.writerow(["Received money not yet assigned to trucks", f"{sm.get('unassigned', 0):.2f}"])
    if len(st["product_subtotals"]) > 1:
        w.writerow([])
        w.writerow(["Product", "Trucks", "Quantity (Qtl)", "Amount (Rs.)"])
        for p in st["product_subtotals"]:
            w.writerow([p["product_name"], p["trucks"], f"{p['quantity']:.2f}", f"{p['amount']:.2f}"])
    return buf.getvalue().encode("utf-8-sig")  # BOM so Excel opens it cleanly


def _statement_story(st: dict) -> list:
    esc = lambda x: xml_escape(str(x)) if x else ""  # noqa: E731
    styles = getSampleStyleSheet()
    cell = ParagraphStyle("sc_cell", parent=styles["Normal"], fontName="Helvetica", fontSize=8, leading=10)
    cell_b = ParagraphStyle("sc_cellb", parent=cell, fontName="Helvetica-Bold")
    muted = ParagraphStyle("sc_muted", parent=cell, textColor=colors.HexColor("#78716C"), fontSize=7.5)
    section = ParagraphStyle("sc_section", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=10,
                             textColor=colors.HexColor("#1C1917"), spaceBefore=12, spaceAfter=6)
    t = st["totals"]
    period = f"{st['from_date'] or 'Start'} to {st['to_date'] or 'Today'}"
    story = _pdf_letterhead_flowables(
        "Sales Statement",
        [f"<b>Company:</b> {esc(st['buyer_name'])}", f"<b>Period:</b> {period}"],
    )

    def money(n):
        return _fmt_inr(float(n))

    wp = st["with_payments"]
    summary = [[
        "Trucks", "Quantity (Qtl)", "Total Sold", "Received" if wp else "", "Cuts" if wp else "",
        "Balance Due" if wp else "",
    ], [
        str(t["trucks"]), f"{t['quantity']:,.2f}", money(t["sales_amount"]),
        money(t["payments_total"]) if wp else "", money(t["cuts_total"]) if wp else "",
        money(t["closing_balance"]) if wp else "",
    ]]
    sm = Table(summary, colWidths=[30 * mm, 40 * mm, 45 * mm, 45 * mm, 45 * mm, 50 * mm])
    sm.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8), ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#78716C")),
        ("FONT", (0, 1), (-1, 1), "Helvetica-Bold", 12), ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F5F4F0")),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 1), (-1, 1), 0.6, colors.HexColor("#78716C")),
    ]))
    story.append(sm)
    if not wp:
        story.append(Paragraph("Product filter applied: payments and balance are not shown.", muted))

    story.append(Paragraph("SALES &amp; PAYMENTS", section))
    header = ["Date", "Bill No", "Product", "Qty (Qtl)", "Rate", "Amount", "Received", "Cut", "Balance", "Dalal", "Truck / Driver / Transport"]
    data: list = [header]
    pay_rows: list = []
    cut_pdf_rows: list = []
    if wp and st["from_date"]:
        data.append([st["from_date"], Paragraph("<b>Opening balance</b>", cell), "", "", "", "", "", "",
                     money(st["opening_balance"]), "", ""])
    for r in st["rows"]:
        bal = "" if r["running_balance"] is None else money(r["running_balance"])
        if r["type"] == "sale":
            detail = f"<b>{esc(r.get('truck_number'))}</b><br/>{esc(r.get('driver_name'))}"
            if r.get("driver_phone"):
                detail += f" ({esc(r['driver_phone'])})"
            detail += f"<br/>{esc(r.get('transport_company'))}"
            if r.get("status") == "settled":
                detail += "<br/><b>Settled</b>" + (f" (cut {money(r['settled_cut'])})" if r.get("settled_cut") else "")
            elif r.get("status") == "part":
                detail += f"<br/><b>Part settled</b>, due {money(r['due'])}"
            data.append([r["date"], Paragraph(esc(r.get("bill_no")), cell), Paragraph(esc(r["product_name"]), cell),
                         f"{r['quantity']:,.2f}", money(r["rate"]), money(r["amount"]), "", "", bal,
                         Paragraph(esc(r.get("dalal_name")) or "-", cell), Paragraph(detail, cell)])
        elif r["type"] == "payment":
            pay_rows.append(len(data))
            note = f" - {esc(r['note'])}" if r.get("note") else ""
            data.append([r["date"], Paragraph(f"<b>PAYMENT</b> ({esc((r.get('mode') or '').upper())})", cell), "",
                         "", "", "", money(r["amount"]), "", bal, "", Paragraph(f"Received{note}", cell)])
        else:  # cut
            cut_pdf_rows.append(len(data))
            note = f" - {esc(r['note'])}" if r.get("note") else ""
            data.append([r["date"], Paragraph(f"<b>CUT</b> {esc(r.get('bill_no'))}", cell), "",
                         "", "", "", "", money(r["amount"]), bal, "",
                         Paragraph(f"Deduction, truck {esc(r.get('truck_number'))}{note}", cell)])
    if not st["rows"]:
        data.append(["-", "No sales or payments in this period", "", "", "", "", "", "", "", "", ""])
    data.append(["", Paragraph("<b>TOTAL</b> (avg rate)", cell), "", f"{t['quantity']:,.2f}", money(t["avg_rate"] or 0),
                 money(t["sales_amount"]), money(t["payments_total"]) if wp else "",
                 money(t["cuts_total"]) if wp else "",
                 money(t["closing_balance"]) if wp else "", "", ""])

    widths = [21, 27, 21, 16, 21, 24, 23, 19, 24, 20, 45]  # mm — 261mm usable on landscape A4
    tbl = Table(data, colWidths=[w * mm for w in widths], repeatRows=1)
    style = [
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8), ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#78716C")),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F5F4F0")),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#78716C")),
        ("FONT", (0, 1), (-1, -1), "Helvetica", 8),
        ("LINEBELOW", (0, 1), (-1, -2), 0.2, colors.HexColor("#E7E5E4")),
        ("ALIGN", (3, 0), (8, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("FONT", (0, -1), (-1, -1), "Helvetica-Bold", 8.5),
        ("LINEABOVE", (0, -1), (-1, -1), 0.8, colors.HexColor("#292524")),
    ]
    for i in pay_rows:
        style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#EEF6EE")))
    for i in cut_pdf_rows:
        style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#FEF3E2")))
    tbl.setStyle(TableStyle(style))
    story.append(tbl)

    if len(st["product_subtotals"]) > 1:
        pdata = [["Product", "Trucks", "Quantity (Qtl)", "Amount"]] + [
            [p["product_name"], str(p["trucks"]), f"{p['quantity']:,.2f}", money(p["amount"])]
            for p in st["product_subtotals"]
        ]
        pt = Table(pdata, colWidths=[70 * mm, 30 * mm, 45 * mm, 50 * mm])
        pt.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8), ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#78716C")),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F5F4F0")),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 9), ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ("LINEBELOW", (0, 1), (-1, -1), 0.2, colors.HexColor("#E7E5E4")),
            ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        pt.hAlign = "LEFT"
        story.append(KeepTogether([Paragraph("PRODUCT-WISE TOTALS", section), pt]))
    if wp:
        story.append(Spacer(1, 8))
        story.append(Paragraph(
            "Balance = total sold - payments received - cuts. A positive balance is due from the company; "
            "a negative balance is an advance received.", muted))
        un = (st.get("summary") or {}).get("unassigned", 0)
        if un > 0.01:
            story.append(Paragraph(
                f"Received money not yet assigned to trucks: {money(un)}", muted))
    return story


@api_router.get("/sales/companies/statement/export")
async def export_company_statement(
    buyer_name: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    product_id: Optional[str] = None,
    file_format: str = "pdf",
    _user: dict = Depends(get_current_user),
):
    st = await _build_statement(buyer_name, from_date, to_date, product_id)
    safe = re.sub(r"[^A-Za-z0-9]+", "_", st["buyer_name"]).strip("_") or "company"
    if file_format == "csv":
        return StreamingResponse(
            io.BytesIO(_statement_csv(st)),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="sales_{safe}.csv"'},
        )
    if file_format != "pdf":
        raise HTTPException(status_code=400, detail="file_format must be pdf or csv")
    return _pdf_stream(_statement_story(st), f"sales_{safe}.pdf", pagesize=landscape(A4))


async def seed_products():
    for name in DEFAULT_PRODUCTS:
        if not await db.master_products.find_one({"name_lower": name.lower()}):
            await db.master_products.insert_one({
                "id": str(uuid.uuid4()),
                "name": name,
                "name_lower": name.lower(),
                "created_at": now_iso(),
            })


async def seed_muddat_account() -> str:
    """Special system client that accumulates settlement deductions.
    Idempotent — creates only if missing, returns the client id either way."""
    existing = await db.clients.find_one(
        {"name_lower": MUDDAT_CLIENT_NAME.lower()}, {"_id": 0, "id": 1}
    )
    if existing:
        return existing["id"]
    doc = {
        "id": str(uuid.uuid4()),
        "name": MUDDAT_CLIENT_NAME,
        "name_lower": MUDDAT_CLIENT_NAME.lower(),
        "note": "System account — accumulated settlement deductions",
        "created_at": now_iso(),
    }
    await db.clients.insert_one(doc)
    return doc["id"]


# =========================================================================
# BACKUP · RESTORE · REMINDER
# =========================================================================

BACKUP_REMINDER_DAYS = int(os.environ.get("BACKUP_REMINDER_DAYS", "7"))
BACKUP_COLLECTIONS = [
    "master_products",
    "clients",
    "procurement_entries",
    "payments",
    "procurement_settlements",
    "sales_entries",
    "bill_counters",
    "sale_payments",
    "sale_settlements",
    "stock_adjustments",
    "users",
]


def _require_admin(user: dict) -> None:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")


def _jsonable(value):
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    return value


async def _touch_backup_meta():
    await db.system_settings.update_one(
        {"key": "backup_meta"},
        {"$set": {"key": "backup_meta", "last_backup_at": now_iso()}},
        upsert=True,
    )


@api_router.get("/admin/backup/status")
async def backup_status(user: dict = Depends(get_current_user)):
    _require_admin(user)
    rec = await db.system_settings.find_one({"key": "backup_meta"}, {"_id": 0})
    last = rec.get("last_backup_at") if rec else None
    days = None
    overdue = True
    if last:
        try:
            last_dt = datetime.fromisoformat(last)
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            days = (datetime.now(timezone.utc) - last_dt).days
            overdue = days >= BACKUP_REMINDER_DAYS
        except ValueError:
            pass
    return {
        "last_backup_at": last,
        "days_since_last_backup": days,
        "is_overdue": overdue,
        "reminder_threshold_days": BACKUP_REMINDER_DAYS,
    }


@api_router.get("/admin/backup/export")
async def backup_export(user: dict = Depends(get_current_user)):
    _require_admin(user)
    stamp = datetime.now(timezone.utc)
    manifest = {
        "generated_at": stamp.isoformat(),
        "app": BUSINESS_NAME,
        "schema_version": 1,
        "collections": {},
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for coll in BACKUP_COLLECTIONS:
            docs = await db[coll].find({}, {"_id": 0}).to_list(None)
            clean = [_jsonable(d) for d in docs]
            zf.writestr(
                f"{coll}.json",
                json.dumps(clean, ensure_ascii=False, indent=2, default=str),
            )
            manifest["collections"][coll] = len(clean)
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    await _touch_backup_meta()

    filename = f"backup_{stamp.strftime('%Y-%m-%d_%H%M')}.zip"
    return StreamingResponse(
        io.BytesIO(buf.getvalue()),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@api_router.post("/admin/backup/restore")
async def backup_restore(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    _require_admin(user)
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        zf = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Not a valid zip file")

    names = set(zf.namelist())
    if "manifest.json" not in names:
        raise HTTPException(
            status_code=400,
            detail="Missing manifest.json — this doesn't look like a backup produced by this app.",
        )

    try:
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Corrupt manifest.json: {exc}")

    expected = manifest.get("collections") or {}
    if not isinstance(expected, dict) or not expected:
        raise HTTPException(status_code=400, detail="Manifest lists no collections.")
    for coll in expected.keys():
        if f"{coll}.json" not in names:
            raise HTTPException(
                status_code=400,
                detail=f"Missing {coll}.json — backup file is incomplete.",
            )

    # Restore in dependency-sensible order (masters first, then transactions)
    order = [c for c in BACKUP_COLLECTIONS if c in expected]
    for c in expected.keys():
        if c not in order:
            order.append(c)

    summary: dict = {}
    for coll in order:
        try:
            docs = json.loads(zf.read(f"{coll}.json").decode("utf-8"))
        except Exception as exc:
            summary[coll] = {"inserted": 0, "updated": 0, "failed": 0, "error": str(exc)}
            continue
        if not isinstance(docs, list):
            summary[coll] = {"inserted": 0, "updated": 0, "failed": 0, "error": "not a list"}
            continue

        inserted = 0
        updated = 0
        failed: list = []
        for doc in docs:
            doc_id = doc.get("id")
            if not doc_id:
                failed.append({"reason": "no `id` field", "doc": doc})
                continue
            try:
                existing = await db[coll].find_one({"id": doc_id}, {"_id": 1})
                await db[coll].replace_one({"id": doc_id}, doc, upsert=True)
                if existing:
                    updated += 1
                else:
                    inserted += 1
            except Exception as exc:
                failed.append({"id": doc_id, "reason": str(exc)})

        summary[coll] = {
            "expected": expected.get(coll),
            "inserted": inserted,
            "updated": updated,
            "failed": len(failed),
            "failures": failed[:20],  # cap for response size
        }

    return {
        "ok": True,
        "manifest": {
            "generated_at": manifest.get("generated_at"),
            "app": manifest.get("app"),
        },
        "summary": summary,
    }


# ----- Stock balance per grain ---------------------------------------------
# Stock (quintals) = bought (procurement weight) - sold (sales quantity)
#                    + adjustments (opening stock, wastage, corrections; +/-).
STOCK_ROW_LIMIT = 3000


class StockAdjustCreate(BaseModel):
    product_id: str
    quantity: float  # + adds stock, - removes stock (quintals)
    date: str  # YYYY-MM-DD
    note: Optional[str] = Field(default=None, max_length=200)


async def _sum_by_product(coll: str, field: str, date_field: str, upto: Optional[str] = None,
                          before: Optional[str] = None, product_id: Optional[str] = None) -> dict:
    """{product_id: (total, product_name)} summed inside the database."""
    match: dict = {}
    rng: dict = {}
    if upto:
        rng["$lte"] = upto
    if before:
        rng["$lt"] = before
    if rng:
        match[date_field] = rng
    if product_id:
        match["product_id"] = product_id
    pipe: list = [{"$match": match}] if match else []
    pipe.append({"$group": {"_id": "$product_id", "total": {"$sum": f"${field}"},
                            "name": {"$first": "$product_name"}}})
    rows = await db[coll].aggregate(pipe).to_list(None)
    return {r["_id"]: (float(r["total"] or 0), r.get("name")) for r in rows}


async def _stock_totals(upto: Optional[str] = None, before: Optional[str] = None,
                        product_id: Optional[str] = None) -> dict:
    bought = await _sum_by_product("procurement_entries", "weight", "entry_date", upto, before, product_id)
    sold = await _sum_by_product("sales_entries", "quantity", "dispatch_date", upto, before, product_id)
    adj = await _sum_by_product("stock_adjustments", "quantity", "date", upto, before, product_id)
    out: dict = {}
    for pid in set(bought) | set(sold) | set(adj):
        b, s_, a = bought.get(pid), sold.get(pid), adj.get(pid)
        out[pid] = {
            "bought": round(b[0], 2) if b else 0.0,
            "sold": round(s_[0], 2) if s_ else 0.0,
            "adjusted": round(a[0], 2) if a else 0.0,
            "name": next((x[1] for x in (b, s_, a) if x and x[1]), None),
        }
        out[pid]["balance"] = round(out[pid]["bought"] - out[pid]["sold"] + out[pid]["adjusted"], 2)
    return out


@api_router.get("/owner/profit-summary")
async def owner_profit_summary(user: dict = Depends(get_current_user)):
    """Owner-only all-time crop-wise profit estimate using weighted-average purchase cost.

    Expenses are intentionally excluded until the future expense module is implemented.
    Firm-wise profit is not available because the current procurement/sales schemas do not
    store a firm on each transaction.
    """
    _require_admin(user)

    products = await db.master_products.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(None)
    procurement = await db.procurement_entries.find(
        {}, {"_id": 0, "product_id": 1, "weight": 1, "rate": 1, "total_amount": 1}
    ).to_list(None)
    sales = await db.sales_entries.find(
        {}, {"_id": 0, "product_id": 1, "quantity": 1, "rate": 1, "total_amount": 1}
    ).to_list(None)
    adjustments = await db.stock_adjustments.find(
        {}, {"_id": 0, "product_id": 1, "quantity": 1}
    ).to_list(None)

    rows_by_id = {
        p["id"]: {
            "product_id": p["id"], "product_name": p["name"],
            "purchased_quantity": 0.0, "purchase_value": 0.0,
            "sold_quantity": 0.0, "sales_revenue": 0.0,
            "stock_adjustment_quantity": 0.0,
        }
        for p in products
    }

    def row_for(product_id: str) -> dict:
        if product_id not in rows_by_id:
            rows_by_id[product_id] = {
                "product_id": product_id, "product_name": "Unknown product",
                "purchased_quantity": 0.0, "purchase_value": 0.0,
                "sold_quantity": 0.0, "sales_revenue": 0.0,
                "stock_adjustment_quantity": 0.0,
            }
        return rows_by_id[product_id]

    for entry in procurement:
        row = row_for(entry.get("product_id", ""))
        qty = float(entry.get("weight") or 0)
        amount = float(entry.get("total_amount") or (qty * float(entry.get("rate") or 0)))
        row["purchased_quantity"] += qty
        row["purchase_value"] += amount

    for sale in sales:
        row = row_for(sale.get("product_id", ""))
        qty = float(sale.get("quantity") or 0)
        amount = float(sale.get("total_amount") or (qty * float(sale.get("rate") or 0)))
        row["sold_quantity"] += qty
        row["sales_revenue"] += amount

    for adjustment in adjustments:
        row = row_for(adjustment.get("product_id", ""))
        row["stock_adjustment_quantity"] += float(adjustment.get("quantity") or 0)

    rows = []
    for row in rows_by_id.values():
        bought_qty = row["purchased_quantity"]
        purchase_value = row["purchase_value"]
        sold_qty = row["sold_quantity"]
        revenue = row["sales_revenue"]
        average_cost = purchase_value / bought_qty if bought_qty > 0 else 0.0
        cost_of_goods_sold = sold_qty * average_cost
        remaining = bought_qty - sold_qty + row["stock_adjustment_quantity"]
        row.update({
            "purchased_quantity": round(bought_qty, 2),
            "purchase_value": round(purchase_value, 2),
            "sold_quantity": round(sold_qty, 2),
            "sales_revenue": round(revenue, 2),
            "average_purchase_rate": round(average_cost, 2),
            "cost_of_goods_sold": round(cost_of_goods_sold, 2),
            "gross_profit": round(revenue - cost_of_goods_sold, 2),
            "remaining_stock": round(remaining, 2),
            "stock_adjustment_quantity": round(row["stock_adjustment_quantity"], 2),
        })
        rows.append(row)

    rows.sort(key=lambda r: r["product_name"].lower())
    totals = {
        "purchased_quantity": round(sum(r["purchased_quantity"] for r in rows), 2),
        "purchase_value": round(sum(r["purchase_value"] for r in rows), 2),
        "sold_quantity": round(sum(r["sold_quantity"] for r in rows), 2),
        "sales_revenue": round(sum(r["sales_revenue"] for r in rows), 2),
        "cost_of_goods_sold": round(sum(r["cost_of_goods_sold"] for r in rows), 2),
        "gross_profit": round(sum(r["gross_profit"] for r in rows), 2),
        "remaining_stock": round(sum(r["remaining_stock"] for r in rows), 2),
        "expenses": 0.0,
        "net_profit": round(sum(r["gross_profit"] for r in rows), 2),
    }
    return {
        "rows": rows,
        "totals": totals,
        "expenses_module": "reserved_for_future",
        "calculation_method": "weighted_average_purchase_cost",
        "notes": [
            "Profit is an estimate based on weighted-average recorded procurement cost.",
            "Expenses are not deducted yet; the Expenses section is reserved for later.",
            "Firm-wise profit is unavailable until transactions record the firm name.",
            "Stock adjustments affect remaining quantity but do not have a cost value.",
        ],
    }


@api_router.get("/stock/summary")
async def stock_summary(as_on: Optional[str] = None, _user: dict = Depends(get_current_user)):
    as_on = as_on or today_local_date().isoformat()
    _check_ymd(as_on, "as_on")
    totals = await _stock_totals(upto=as_on)
    names = {p["id"]: p["name"] for p in await db.master_products.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(None)}
    rows = [
        {"product_id": pid, "product_name": names.get(pid) or v["name"] or "?",
         "bought": v["bought"], "sold": v["sold"], "adjusted": v["adjusted"], "balance": v["balance"]}
        for pid, v in totals.items()
    ]
    rows.sort(key=lambda r: r["product_name"].lower())
    return {
        "as_on": as_on,
        "rows": rows,
        "totals": {
            "bought": round(sum(r["bought"] for r in rows), 2),
            "sold": round(sum(r["sold"] for r in rows), 2),
            "adjusted": round(sum(r["adjusted"] for r in rows), 2),
            "balance": round(sum(r["balance"] for r in rows), 2),
        },
    }


@api_router.get("/stock/movements")
async def stock_movements(product_id: str, as_on: Optional[str] = None, from_date: Optional[str] = None,
                          _user: dict = Depends(get_current_user)):
    """Every purchase, truck sold and adjustment of one grain, with a running balance."""
    as_on = as_on or today_local_date().isoformat()
    _check_ymd(as_on, "as_on")
    if from_date:
        _check_ymd(from_date, "from_date")
    else:
        from_date = (datetime.strptime(as_on, "%Y-%m-%d").date() - timedelta(days=6)).isoformat()
    if from_date > as_on:
        raise HTTPException(status_code=400, detail="From date cannot be after the 'as on' date")

    product = await db.master_products.find_one({"id": product_id}, {"_id": 0})
    before = (await _stock_totals(before=from_date, product_id=product_id)).get(product_id)
    upto = (await _stock_totals(upto=as_on, product_id=product_id)).get(product_id)
    opening = before["balance"] if before else 0.0
    closing = upto["balance"] if upto else 0.0

    lim = STOCK_ROW_LIMIT + 1
    proc = await db.procurement_entries.find(
        {"product_id": product_id, "entry_date": {"$gte": from_date, "$lte": as_on}}, {"_id": 0}
    ).to_list(lim)
    sales = await db.sales_entries.find(
        {"product_id": product_id, "dispatch_date": {"$gte": from_date, "$lte": as_on}}, {"_id": 0}
    ).to_list(lim)
    adjs = await db.stock_adjustments.find(
        {"product_id": product_id, "date": {"$gte": from_date, "$lte": as_on}}, {"_id": 0}
    ).to_list(lim)

    events = (
        [(e["entry_date"], e.get("created_at", ""), {
            "id": e["id"], "type": "bought", "date": e["entry_date"], "qty": float(e["weight"]),
            "label": e.get("client_name") or "", "extra": None}) for e in proc]
        + [(e["dispatch_date"], e.get("created_at", ""), {
            "id": e["id"], "type": "sold", "date": e["dispatch_date"], "qty": -float(e["quantity"]),
            "label": e.get("buyer_name") or "", "extra": e.get("truck_number")}) for e in sales]
        + [(e["date"], e.get("created_at", ""), {
            "id": e["id"], "type": "adjust", "date": e["date"], "qty": float(e["quantity"]),
            "label": e.get("note") or "", "extra": None}) for e in adjs]
    )
    events.sort(key=lambda x: (x[0], x[1]))
    truncated = len(events) > STOCK_ROW_LIMIT
    events = events[:STOCK_ROW_LIMIT]
    running = opening
    rows = []
    for _d, _c, row in events:
        running += row["qty"]
        row["qty"] = round(row["qty"], 2)
        row["running"] = round(running, 2)
        rows.append(row)
    return {
        "product_id": product_id,
        "product_name": (product or {}).get("name") or (upto or before or {}).get("name") or "?",
        "from_date": from_date, "as_on": as_on,
        "opening": round(opening, 2), "closing": round(closing, 2),
        "rows": rows, "truncated": truncated,
    }


@api_router.post("/stock/adjustments")
async def create_stock_adjustment(payload: StockAdjustCreate, user: dict = Depends(get_current_user)):
    product = await db.master_products.find_one({"id": payload.product_id}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Grain not found")
    _check_ymd(payload.date, "date")
    if datetime.strptime(payload.date, "%Y-%m-%d").date() > today_local_date():
        raise HTTPException(status_code=400, detail="Date cannot be in the future")
    q = float(payload.quantity)
    if q != q or abs(q) > 10_000_000 or round(q, 2) == 0:
        raise HTTPException(status_code=400, detail="Enter a quantity greater than 0")
    doc = {
        "id": str(uuid.uuid4()),
        "product_id": product["id"],
        "product_name": product["name"],
        "quantity": round(q, 2),
        "date": payload.date,
        "note": _clean_text(payload.note),
        "entered_by": user.get("name", "Accountant"),
        "created_at": now_iso(),
    }
    await db.stock_adjustments.insert_one(dict(doc))
    return doc


@api_router.delete("/stock/adjustments/{adjustment_id}")
async def delete_stock_adjustment(adjustment_id: str, _user: dict = Depends(get_current_user)):
    res = await db.stock_adjustments.delete_one({"id": adjustment_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Adjustment not found")
    return {"ok": True}


# ----- Health / Root -----
@api_router.api_route("/", methods=["GET", "HEAD"])  # HEAD too: uptime monitors ping with HEAD
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
    # Matches the advance-payments lookup (client_id + direction together)
    # and the client ledger view, instead of relying on two separate
    # single-field indexes for a two-field filter.
    await db.payments.create_index([("client_id", 1), ("direction", 1)])
    await db.login_attempts.create_index("identifier", unique=True)
    await db.master_products.create_index("name_lower", unique=True)
    await db.procurement_entries.create_index("entry_date")
    await db.procurement_entries.create_index("client_id")
    await db.procurement_entries.create_index("product_id")
    # Matches the settlement eligible-entries lookup (client_id + entry_date
    # range, filtered by is_settled) — this is the query that runs every
    # time a settlement preview or subledger is loaded.
    await db.procurement_entries.create_index([("client_id", 1), ("entry_date", 1)])
    await db.procurement_settlements.create_index([("client_id", 1), ("to_date", -1)])
    await db.sales_entries.create_index([("dispatch_date", -1), ("created_at", -1)])
    await db.sales_entries.create_index("buyer_name")
    await db.sales_entries.create_index("dalal_name")
    await db.sales_entries.create_index("bill_no")
    await db.bill_counters.create_index("id", unique=True)
    await db.sale_payments.create_index([("buyer_name", 1), ("payment_date", -1)])
    await db.sale_settlements.create_index([("sale_id", 1)])
    await db.stock_adjustments.create_index([("product_id", 1), ("date", 1)])
    await db.procurement_entries.create_index([("product_id", 1), ("entry_date", 1)])
    await db.sales_entries.create_index([("product_id", 1), ("dispatch_date", 1)])
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
    await seed_muddat_account()


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
