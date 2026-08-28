#!/usr/bin/env python3
"""Render the CalBlue platform design diagrams.

Dependency-free apart from matplotlib, matching the spirit of the rest of the
repo. Run:  python3 docs/design/diagrams/render.py
Outputs PNGs next to this file.
"""

import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Rectangle

OUT = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- brand
NAVY  = "#071b3f"
INK   = "#0b1730"
MUTED = "#5b6b83"
LINE  = "#c9d6ea"
PAPER = "#ffffff"
WASH  = "#f4f7fc"
GREY  = "#8aa0bd"

IDENTITY = "#1268e8"   # blue   — the club crest blue
PARTICIP = "#d97706"   # amber
EVENTS   = "#0e9384"   # teal
MONEY    = "#7c3aed"   # violet
PLATFORM = "#64748b"   # slate
DANGER   = "#b91c1c"

# Helvetica for the prose, DejaVu as a per-glyph fallback for arrows/sigma.
plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["font.sans-serif"] = ["Helvetica Neue", "Helvetica", "Arial",
                                   "DejaVu Sans"]
plt.rcParams["font.monospace"] = ["Menlo", "DejaVu Sans Mono", "monospace"]
plt.rcParams["font.size"] = 9


# ---------------------------------------------------------------- helpers
def canvas(w, h):
    fig, ax = plt.subplots(figsize=(w, h))
    ax.set_xlim(0, w)
    ax.set_ylim(0, h)
    ax.axis("off")
    ax.patch.set_visible(False)          # so bbox_inches='tight' crops to artists
    fig.patch.set_facecolor(PAPER)
    return fig, ax


def title(ax, x, y, text, sub=None):
    ax.text(x, y, text, fontsize=17, fontweight="bold", color=NAVY, va="top")
    if sub:
        ax.text(x, y - 0.42, sub, fontsize=9.5, color=MUTED, va="top")


def panel(ax, x, y, w, h, label, color):
    ax.add_patch(FancyBboxPatch((x, y), w, h,
                 boxstyle="round,pad=0,rounding_size=0.16",
                 fc=WASH, ec=LINE, lw=1.0, zorder=1))
    ax.add_patch(Rectangle((x, y + h - 0.055), w, 0.055, fc=color, ec="none",
                           zorder=2, alpha=0.9))
    ax.text(x + 0.22, y + h - 0.36, label.upper(), fontsize=8.5,
            fontweight="bold", color=color, va="center", zorder=3)


HDR, ROW = 0.44, 0.265


def entity(ax, x, top, w, name, fields, color, note=None):
    """Entity card; (x, top) is the top-left corner."""
    h = HDR + ROW * len(fields) + 0.18
    y = top - h
    ax.add_patch(FancyBboxPatch((x, y), w, h,
                 boxstyle="round,pad=0,rounding_size=0.12",
                 fc=PAPER, ec=color, lw=1.3, zorder=4))
    ax.add_patch(FancyBboxPatch((x, top - HDR), w, HDR,
                 boxstyle="round,pad=0,rounding_size=0.12",
                 fc=color, ec=color, lw=1.3, zorder=5))
    ax.add_patch(Rectangle((x, top - HDR), w, 0.14, fc=color, ec="none", zorder=5))
    ax.text(x + w / 2, top - HDR / 2, name, fontsize=10.5, fontweight="bold",
            color="white", ha="center", va="center", zorder=6)
    for i, f in enumerate(fields):
        ax.text(x + 0.17, top - HDR - 0.16 - i * ROW, f, fontsize=8.0,
                color=INK, va="top", zorder=6)
    if note:
        ax.text(x + w / 2, y - 0.16, note, fontsize=7.4, color=MUTED,
                ha="center", va="top", style="italic", zorder=6)
    return {"x": x, "y": y, "w": w, "h": h, "top": top,
            "l": (x, y + h / 2), "r": (x + w, y + h / 2),
            "t": (x + w / 2, top), "b": (x + w / 2, y),
            "cx": x + w / 2, "cy": y + h / 2}


def edge(ax, a, b, label=None, style="arc3,rad=0", color=None, lw=1.25,
         ls="-", lpos=0.5, dx=0.0, dy=0.0):
    color = color or GREY
    ax.add_patch(FancyArrowPatch(a, b, connectionstyle=style, arrowstyle="-|>",
                 mutation_scale=11, lw=lw, color=color, linestyle=ls,
                 zorder=3, shrinkA=2, shrinkB=2))
    if label:
        ax.text(a[0] + (b[0] - a[0]) * lpos + dx,
                a[1] + (b[1] - a[1]) * lpos + dy, label, fontsize=7.3,
                color=MUTED, ha="center", va="center", zorder=7,
                bbox=dict(fc=PAPER, ec="none", pad=1.4))


def route(ax, pts, label=None, color=None, lw=1.25, ls="-", lxy=None):
    """Orthogonal polyline with an arrowhead on the final segment."""
    color = color or GREY
    ax.plot([p[0] for p in pts], [p[1] for p in pts], color=color, lw=lw,
            ls=ls, zorder=3, solid_capstyle="round")
    ax.add_patch(FancyArrowPatch(pts[-2], pts[-1], arrowstyle="-|>",
                 mutation_scale=11, lw=lw, color=color, linestyle=ls,
                 zorder=3, shrinkA=0, shrinkB=0))
    if label and lxy:
        ax.text(lxy[0], lxy[1], label, fontsize=7.3, color=MUTED, ha="center",
                va="center", zorder=7, bbox=dict(fc=PAPER, ec="none", pad=1.4))


def trim(fig, ax, w, y0, y1):
    """Crop unused canvas below the content, keeping the 1-unit-per-inch scale."""
    ax.set_ylim(y0, y1)
    fig.set_size_inches(w, y1 - y0)


def save(fig, name):
    path = os.path.join(OUT, name)
    fig.savefig(path, dpi=200, bbox_inches="tight", pad_inches=0.30,
                facecolor=PAPER)
    plt.close(fig)
    print(path)


# =============================================================== 1. entities
def fig_erd():
    W, H = 17.6, 11.3
    fig, ax = canvas(W, H)
    title(ax, 0.3, H - 0.15, "CalBlue platform — entity map",
          "One account holds many player identities · one games table covers league, tournament and pickup · "
          "attendance is what produces money")

    top, bot = H - 1.05, 4.55
    panel(ax, 0.30, bot, 4.35, top - bot, "Identity & access", IDENTITY)
    panel(ax, 4.95, bot, 4.15, top - bot, "Participation", PARTICIP)
    panel(ax, 9.40, bot, 7.90, top - bot, "Events & schedule", EVENTS)
    panel(ax, 0.30, 0.20, 17.00, 4.15, "Money & billing", MONEY)

    # identity ------------------------------------------------------------
    prof = entity(ax, 0.92, 9.73, 3.45, "profiles  (account)", [
        "id = auth.users.id",
        "email · display_name · phone",
        "role: user | admin | developer"], IDENTITY)
    play = entity(ax, 0.92, 7.85, 3.45, "players", [
        "account_id -> profiles  (nullable)",
        "guardian_account_id",
        "default_positions[] · pref_number",
        "verification · is_public"], IDENTITY,
        note="null account = guest / unclaimed identity")
    staff = entity(ax, 0.92, 5.75, 3.45, "staff_assignments", [
        "account_id · scope: competition | game",
        "staff_role: manager | captain"], IDENTITY)

    # participation --------------------------------------------------------
    creg = entity(ax, 5.25, 9.73, 3.55, "competition_registrations", [
        "competition_id · player_id",
        "status: pending -> approved",
        "season jersey_number · positions[]"], PARTICIP,
        note="season eligibility")
    greg = entity(ax, 5.25, 7.85, 3.55, "game_registrations", [
        "game_id · player_id",
        "status: registered | waitlisted | cancelled",
        "participation: player | keeper | staff",
        "jersey_number · positions[]",
        "attendance: unknown|present|absent|excused"], PARTICIP,
        note="the per-game slot — and the billing source of truth")

    # events ---------------------------------------------------------------
    comp = entity(ax, 9.70, 9.73, 3.55, "competitions", [
        "kind: league | tournament | cup",
        "season_label · start / end date",
        "status · default fee"], EVENTS)
    team = entity(ax, 13.65, 9.73, 3.45, "teams", [
        "club_id -> clubs · name · short_name",
        "CalBlue squads today, every club later"], EVENTS)
    venue = entity(ax, 13.65, 7.85, 3.45, "venues", [
        "name · address · map_url",
        "surface · timezone"], EVENTS)
    game = entity(ax, 9.70, 7.85, 3.55, "games", [
        "competition_id  (null for pickup)",
        "game_type · opponent · home_away",
        "venue_id · field_label · team_id",
        "gather_time · start_time · end_time",
        "capacity · registration_closes_at",
        "status · fee_override"], EVENTS)

    # money ----------------------------------------------------------------
    fees = entity(ax, 0.70, 3.68, 3.10, "fee_schedules", [
        "scope: game_type | competition",
        "amount · effective range"], MONEY)
    chg = entity(ax, 4.35, 3.68, 3.60, "charges", [
        "player_id · account_id · game_id",
        "kind: game_fee | dues | penalty | credit",
        "amount  (snapshot, immutable)"], MONEY,
        note="one line item per billable event")
    pay = entity(ax, 8.35, 3.68, 3.20, "payments", [
        "account_id · amount · method",
        "paid_at · recorded_by · external_ref"], MONEY)
    per = entity(ax, 12.00, 3.68, 2.90, "billing_periods", [
        "label '2026-Q1' · start · end",
        "status: open | preview | closed"], MONEY)
    summ = entity(ax, 5.60, 1.85, 5.20, "period_summaries", [
        "per player and per paying account: attendance counts,",
        "opening balance · charges · payments · closing balance"], MONEY,
        note="written once, when the admin closes the quarter")

    # edges ----------------------------------------------------------------
    edge(ax, prof["b"], play["t"], "1 : N")
    route(ax, [(0.92, prof["cy"]), (0.55, prof["cy"]),
               (0.55, staff["cy"]), (0.92, staff["cy"])], ls=(0, (3, 3)))
    ax.text(0.55, 7.45, "grants", fontsize=7.3, color=MUTED, ha="center",
            va="center", rotation=90, zorder=7,
            bbox=dict(fc=PAPER, ec="none", pad=1.4))

    edge(ax, (4.37, 7.30), creg["l"], "plays as", style="arc3,rad=0.10")
    edge(ax, (4.37, 6.75), greg["l"], style="arc3,rad=-0.04")
    edge(ax, creg["r"], comp["l"], "roster of")
    edge(ax, greg["r"], game["l"], "slot in")
    edge(ax, comp["b"], game["t"], "1 : N")
    route(ax, [(13.65, venue["cy"]), (13.45, venue["cy"]),
               (13.45, 6.40), (13.25, 6.40)])
    route(ax, [(13.65, team["cy"]), (13.35, team["cy"]),
               (13.35, 7.35), (13.25, 7.35)])

    edge(ax, (7.00, greg["y"]), (6.30, chg["top"]),
         "attendance = present\ngenerates a charge", color=MONEY, lw=1.6,
         style="arc3,rad=0.06", dx=1.55, dy=0.10)
    edge(ax, fees["r"], chg["l"], "resolves", color=MONEY)
    edge(ax, (7.45, chg["y"]), (7.80, summ["top"]), color=MONEY, lw=1.5)
    edge(ax, (9.55, pay["y"]), (9.10, summ["top"]), color=MONEY, lw=1.5)
    route(ax, [(13.45, per["y"]), (13.45, summ["cy"]), (10.80, summ["cy"])],
          "scopes, then freezes on close", lxy=(12.60, summ["cy"] + 0.22),
          color=MONEY, lw=1.5)
    edge(ax, chg["r"], pay["l"], "settled by", color=MONEY, ls=(0, (3, 3)),
         dy=0.30)

    ax.text(0.70, 0.45,
            "Account balance  =  Σ charges  −  Σ payments,\n"
            "computed over all time, so an unpaid quarter\n"
            "carries forward instead of vanishing at close.",
            fontsize=8.6, color=MONEY, va="bottom", fontweight="bold")
    save(fig, "01-entity-map.png")


# ============================================================ 2. permissions
def fig_permissions():
    cols = ["Public", "User", "Player", "Captain†", "Admin", "Developer‡"]
    rows = [
        ("Published pages, schedule, results",      ["R", "R", "R", "R", "RW", "R"]),
        ("Own account profile",                     ["–", "RW", "RW", "RW", "RW", "R"]),
        ("Other members' contact / PII",            ["–", "–", "–", "–", "RW", "B"]),
        ("Own player identities",                   ["–", "RW", "RW", "RW", "RW", "R"]),
        ("Player verification status",              ["–", "R", "R", "–", "RW", "–"]),
        ("Emergency / medical fields",              ["–", "RW", "RW", "R", "RW", "B"]),
        ("Venues, teams",                           ["R", "R", "R", "R", "RW", "R"]),
        ("Competitions",                            ["R", "R", "R", "RW", "RW", "R"]),
        ("Games (create, schedule, cancel)",        ["R", "R", "R", "RW", "RW", "R"]),
        ("Season roster registrations",             ["–", "R", "RW", "RW", "RW", "R"]),
        ("Own game registrations",                  ["–", "R", "RW", "RW", "RW", "R"]),
        ("Others' registrations, waitlist order",   ["–", "–", "–", "RW", "RW", "R"]),
        ("Attendance / check-in",                   ["–", "R", "R", "RW", "RW", "R"]),
        ("Fee schedules",                           ["R", "R", "R", "R", "RW", "R"]),
        ("Own charges, payments, statement",        ["–", "R", "R", "R", "RW", "R"]),
        ("Everyone's charges and payments",         ["–", "–", "–", "–", "RW", "B"]),
        ("Billing period close / lock",             ["–", "–", "–", "–", "RW", "–"]),
        ("Audit log",                               ["–", "–", "–", "–", "R", "R"]),
        ("Schema, secrets, deploys",                ["–", "–", "–", "–", "–", "RW"]),
    ]
    key = {"–":  ("#eef2f7", "#9fb0c6", "no access"),
           "R":  ("#dcebff", "#0b4fa8", "read"),
           "RW": ("#1268e8", "#ffffff", "read + write"),
           "B":  ("#fde8d5", "#9a4a06", "break-glass, audited")}

    rh, ch, x0, y0 = 0.40, 1.78, 6.15, 0.62
    W = x0 + ch * len(cols) + 0.4
    H = y0 + rh * len(rows) + 1.45
    fig, ax = canvas(W, H)
    title(ax, 0.3, H - 0.15, "Roles, accessibility & permissions",
          "The global role lives on profiles.role · captain is a scoped grant, not a global role · "
          "every cell is enforced by Postgres row-level security, not only by the UI")

    ytop = y0 + rh * len(rows)
    for j, c in enumerate(cols):
        ax.add_patch(FancyBboxPatch((x0 + ch * j + 0.05, ytop + 0.08), ch - 0.1,
                     0.52, boxstyle="round,pad=0,rounding_size=0.10",
                     fc=NAVY, ec="none"))
        ax.text(x0 + ch * j + ch / 2, ytop + 0.34, c, fontsize=9.5,
                fontweight="bold", color="white", ha="center", va="center")

    for i, (label, vals) in enumerate(rows):
        y = ytop - rh * (i + 1)
        if i % 2 == 0:
            ax.add_patch(Rectangle((0.3, y), W - 0.7, rh, fc=WASH, ec="none"))
        ax.text(0.45, y + rh / 2, label, fontsize=8.8, color=INK, va="center")
        for j, v in enumerate(vals):
            fc, tc, _ = key[v]
            ax.add_patch(FancyBboxPatch((x0 + ch * j + 0.30, y + 0.055),
                         ch - 0.60, rh - 0.11,
                         boxstyle="round,pad=0,rounding_size=0.07",
                         fc=fc, ec="none"))
            ax.text(x0 + ch * j + ch / 2, y + rh / 2, v, fontsize=8.4,
                    fontweight="bold" if v == "RW" else "normal",
                    color=tc, ha="center", va="center")

    lx = 0.45
    for k, (fc, tc, desc) in key.items():
        ax.add_patch(FancyBboxPatch((lx, 0.16), 0.44, 0.30,
                     boxstyle="round,pad=0,rounding_size=0.07", fc=fc, ec="none"))
        ax.text(lx + 0.22, 0.31, k, fontsize=8, color=tc, ha="center",
                va="center", fontweight="bold")
        ax.text(lx + 0.56, 0.31, desc, fontsize=8, color=MUTED, va="center")
        lx += 0.62 + 0.075 * len(desc) * 1.55
    ax.text(W - 0.3, 0.31,
            "† scoped to one competition or game    ‡ platform role, not a business role",
            fontsize=7.8, color=MUTED, ha="right", va="center")
    save(fig, "02-permissions.png")


# ============================================================= 3. lifecycles
def fig_lifecycles():
    W, H = 16.8, 11.0
    fig, ax = canvas(W, H)
    title(ax, 0.3, H - 0.15, "Lifecycle state machines",
          "Every status column in the schema is one of these · white boxes are terminal states")

    def state(x, y, label, color, w=1.72, h=0.56, terminal=False):
        ax.add_patch(FancyBboxPatch((x, y), w, h,
                     boxstyle="round,pad=0,rounding_size=0.16",
                     fc=PAPER if terminal else color,
                     ec=NAVY if terminal else color,
                     lw=1.6 if terminal else 1.2, zorder=4))
        ax.text(x + w / 2, y + h / 2, label, fontsize=8.6, ha="center",
                va="center", color=NAVY if terminal else "white",
                fontweight="bold", zorder=5)
        return {"l": (x, y + h / 2), "r": (x + w, y + h / 2),
                "t": (x + w / 2, y + h), "b": (x + w / 2, y),
                "cx": x + w / 2, "cy": y + h / 2}

    def head(y, name, color, sub):
        ax.text(0.35, y, name, fontsize=10.5, fontweight="bold", color=color)
        ax.text(0.35, y - 0.30, sub, fontsize=7.9, color=MUTED)

    def rule(y):
        ax.add_patch(Rectangle((0.3, y), W - 0.6, 0.035, fc=LINE, ec="none"))

    def note(x, y, lines, color=MUTED):
        for i, ln in enumerate(lines):
            ax.text(x, y - i * 0.28, ln, fontsize=8.0, color=color)

    xs = [3.0, 5.2, 7.4, 9.6, 11.8]
    RIGHT = 10.5

    # -- competition -------------------------------------------------------
    head(9.85, "Competition", EVENTS, "a league, tournament or cup — it groups games")
    s1 = [state(xs[0], 8.95, "draft", EVENTS),
          state(xs[1], 8.95, "published", EVENTS),
          state(xs[2], 8.95, "in_progress", EVENTS),
          state(xs[3], 8.95, "completed", EVENTS, terminal=True),
          state(xs[4], 8.95, "archived", EVENTS, terminal=True)]
    for a, b in zip(s1, s1[1:]):
        edge(ax, a["r"], b["l"])
    canc = state(14.3, 8.95, "cancelled", DANGER, terminal=True)
    edge(ax, s1[1]["t"], canc["t"], style="arc3,rad=-0.12", ls=(0, (3, 3)),
         color="#d59a9a")
    ax.text(10.6, 10.10, "from any state before completed", fontsize=7.4,
            color=MUTED, ha="center",
            bbox=dict(fc=PAPER, ec="none", pad=1.4))
    rule(8.45)

    # -- game --------------------------------------------------------------
    head(8.05, "Game", EVENTS, "identical states for a league fixture and for a pickup")
    s2 = [state(xs[0], 7.15, "draft", EVENTS),
          state(xs[1], 7.15, "published", EVENTS),
          state(xs[2], 7.15, "reg_closed", EVENTS),
          state(xs[3], 7.15, "completed", EVENTS),
          state(xs[4], 7.15, "locked", EVENTS, terminal=True)]
    for a, b in zip(s2, s2[1:]):
        edge(ax, a["r"], b["l"])
    canc = state(14.3, 7.15, "cancelled", DANGER, terminal=True)
    edge(ax, s2[1]["t"], canc["t"], style="arc3,rad=-0.12", ls=(0, (3, 3)),
         color="#d59a9a")
    ax.text(6.30, 6.88, "registration open", fontsize=7.6, color=MUTED,
            ha="center", va="top")
    ax.text(11.55, 6.88, "attendance finalised, charges written, then frozen",
            fontsize=7.6, color=MONEY, ha="center", va="top")
    ax.text(15.16, 6.88, "no attendance, no charges", fontsize=7.6,
            color=MUTED, ha="center", va="top")
    rule(6.35)

    # -- registration ------------------------------------------------------
    head(5.95, "Game registration", PARTICIP,
         "the slot a player holds — and, separately, what actually happened")
    w1 = state(3.0, 4.95, "waitlisted", PARTICIP)
    r1 = state(5.2, 4.95, "registered", PARTICIP)
    c1 = state(8.2, 4.95, "cancelled", PARTICIP, terminal=True)
    edge(ax, w1["t"], r1["t"], "a slot frees up — auto-promoted\nby registration time",
         style="arc3,rad=-0.32", dy=0.62)
    edge(ax, r1["b"], w1["b"], "game full", style="arc3,rad=-0.32", dy=-0.44)
    edge(ax, r1["r"], c1["l"], "player cancels", dy=0.26)
    note(RIGHT, 5.37, ["status is what the player intends;",
                       "attendance below is what the captain recorded."])
    ax.text(3.0, 4.32, "attendance", fontsize=8.0, color=MUTED, va="bottom")
    for i, (lbl, col) in enumerate([("unknown", PLATFORM), ("present", EVENTS),
                                    ("absent", DANGER), ("excused", PLATFORM)]):
        state(3.0 + i * 1.62, 3.60, lbl, col, w=1.42)
    note(RIGHT, 3.88, ["only present is billable · absent = no-show",
                       "and may carry a late-cancel or no-show penalty"])
    rule(3.05)

    # -- billing period ----------------------------------------------------
    head(2.65, "Billing period", MONEY,
         "a calendar quarter, or any custom date range the club prefers")
    o = state(3.0, 1.65, "open", MONEY)
    pv = state(5.72, 1.65, "preview", MONEY)
    cl = state(8.44, 1.65, "closed", MONEY, terminal=True)
    edge(ax, o["r"], pv["l"], "generate", dy=0.30)
    edge(ax, pv["b"], o["b"], "regenerate freely", style="arc3,rad=-0.45", dy=-0.46)
    edge(ax, pv["r"], cl["l"], "admin locks", dy=0.30)
    note(RIGHT, 2.30, ["Closing writes an immutable snapshot.",
                       "A correction after close is never a re-open: it becomes",
                       "a credit or adjustment dated into the following period."])
    trim(fig, ax, W, 1.05, H)
    save(fig, "03-lifecycles.png")


# ================================================================== 4. flows
def fig_flow():
    W, H = 18.2, 9.0
    fig, ax = canvas(W, H)
    title(ax, 0.3, H - 0.15, "End-to-end flow, by actor",
          "Everything in the System lane is a Postgres function, so the UI, the CSV export and a "
          "player's own statement can never disagree")

    lanes = [("Admin", IDENTITY, 6.95), ("Captain", PARTICIP, 5.45),
             ("Player / member", EVENTS, 3.95), ("System", PLATFORM, 2.15)]
    for name, color, y in lanes:
        ax.add_patch(Rectangle((0.3, y - 0.34), 17.25, 1.28,
                     fc="#f8f5ff" if name == "System" else WASH, ec="none"))
        ax.text(0.42, y + 0.30, name, fontsize=9.5, fontweight="bold", color=color)
    ax.plot([0.3, 17.55], [3.42, 3.42], ls=(0, (4, 4)), color=LINE, lw=1.2)

    phases = [("1 · Set up", 2.55), ("2 · Join the club", 5.85),
              ("3 · Register to play", 9.15), ("4 · Game day", 12.45),
              ("5 · Close the quarter", 15.75)]
    for label, x in phases:
        ax.text(x, 8.05, label, fontsize=10, fontweight="bold", color=NAVY,
                ha="center")
    for x in (4.15, 7.45, 10.75, 14.05):
        ax.plot([x, x], [1.75, 7.90], ls=(0, (2, 4)), color=LINE, lw=1.0)

    def step(x, y, text, color, w=3.0):
        ax.add_patch(FancyBboxPatch((x, y - 0.26), w, 1.10,
                     boxstyle="round,pad=0,rounding_size=0.14",
                     fc=PAPER, ec=color, lw=1.3, zorder=4))
        ax.text(x + w / 2, y + 0.29, text, fontsize=8.3, ha="center",
                va="center", color=INK, zorder=5)
        return {"l": (x, y + 0.29), "r": (x + w, y + 0.29),
                "b": (x + w / 2, y - 0.26), "t": (x + w / 2, y + 0.84),
                "x": x, "w": w}

    a1 = step(1.05, 6.95, "Create venue, competition\nand fee schedule, publish", IDENTITY)
    c1 = step(1.05, 5.45, "Or just open a pickup game\n(no competition needed)", PARTICIP)
    a2 = step(4.35, 6.95, "Verify the player,\napprove the season roster", IDENTITY)
    p2 = step(4.35, 3.95, "Sign up, create a player\nidentity, ask to join", EVENTS)
    p3 = step(7.65, 3.95, "Register for a game:\njersey number, position", EVENTS)
    s3 = step(7.65, 2.15, "Eligibility + capacity check:\nregistered or waitlisted", PLATFORM)
    c4 = step(10.95, 5.45, "Check in at the field,\nmark present / absent", PARTICIP)
    s4 = step(10.95, 2.15, "Game completes: attendance\nfinalised, charges written", PLATFORM)
    s5 = step(14.25, 2.15, "Roll up charges − payments\nper player and per payer", PLATFORM)
    a5 = step(14.25, 6.95, "Review, record payments,\nclose and lock the quarter", IDENTITY)
    p5 = step(14.25, 3.95, "See own statement\nand running balance", EVENTS)

    edge(ax, a1["r"], a2["l"])
    edge(ax, a2["b"], p2["t"])
    edge(ax, p2["r"], p3["l"])
    edge(ax, c1["r"], p3["l"], "pickup skips\nthe roster step",
         style="arc3,rad=-0.16", lpos=0.42, dy=0.38)
    edge(ax, p3["b"], s3["t"])
    edge(ax, p3["r"], c4["l"], style="arc3,rad=-0.14")
    edge(ax, c4["b"], s4["t"])
    edge(ax, s4["r"], s5["l"], color=MONEY, lw=1.5)
    edge(ax, s5["t"], p5["b"], color=MONEY, lw=1.5)
    route(ax, [(17.25, 2.44), (17.75, 2.44), (17.75, 7.24), (17.25, 7.24)],
          color=MONEY, lw=1.5)

    ax.text(0.42, 1.42,
            "Registration, waitlist promotion, attendance finalisation and the quarterly roll-up all run in the database.\n"
            "Admins and captains approve and correct; they never hand-total anything.",
            fontsize=8.4, color=MUTED, va="top")
    trim(fig, ax, W, 0.85, H)
    save(fig, "04-flow.png")


# ================================================================ 5. billing
def fig_billing():
    W, H = 15.4, 8.5
    fig, ax = canvas(W, H)
    title(ax, 0.3, H - 0.15, "How a quarter's bill is built",
          "Attendance is the only input · each attended game leaves an immutable line item · "
          "the quarter total is a sum, never a re-computation")

    def card(x, bottom, w, head, lines, color):
        h = 0.46 + len(lines) * 0.30 + 0.34
        ax.add_patch(FancyBboxPatch((x, bottom), w, h,
                     boxstyle="round,pad=0,rounding_size=0.14",
                     fc=PAPER, ec=color, lw=1.3, zorder=4))
        ax.add_patch(FancyBboxPatch((x, bottom + h - 0.46), w, 0.46,
                     boxstyle="round,pad=0,rounding_size=0.14",
                     fc=color, ec=color, zorder=5))
        ax.add_patch(Rectangle((x, bottom + h - 0.46), w, 0.14, fc=color,
                               ec="none", zorder=5))
        ax.text(x + w / 2, bottom + h - 0.23, head, fontsize=9.8,
                fontweight="bold", color="white", ha="center", va="center",
                zorder=6)
        for i, ln in enumerate(lines):
            bold = ln.startswith("**")
            ln = ln.replace("**", "")
            prose = ln.startswith("~")
            ln = ln.lstrip("~")
            ax.text(x + 0.20, bottom + h - 0.78 - i * 0.30, ln,
                    fontsize=8.5 if prose else 8.2,
                    color=NAVY if bold else INK, va="top", zorder=6,
                    fontweight="bold" if bold else "normal",
                    family=None if prose else "monospace")
        return {"r": (x + w, bottom + h / 2), "l": (x, bottom + h / 2),
                "b": (x + w / 2, bottom), "t": (x + w / 2, bottom + h),
                "x": x, "w": w, "top": bottom + h}

    a = card(0.35, 4.45, 4.30, "1 · Resolve the fee", [
        "**~for each attended game, in order:**",
        "~games.fee_override",
        "~  else competitions.default_fee",
        "~  else the matching fee_schedule",
        "~  else 0.00",
        "",
        "**~resolved once, then frozen**"], MONEY)
    b = card(5.10, 4.45, 5.00, "2 · charges  (line items)", [
        "**Sheng Qin — 2026-Q1**",
        "Jan 12  league   Kylin Cup      25.00",
        "Jan 26  league   Kylin Cup      25.00",
        "Feb 08  pickup   Sat pickup     10.00",
        "Feb 22  penalty  late cancel     5.00",
        "Mar 15  credit   reffed a match −10.00",
        "**                    charges  55.00**"], MONEY)
    c = card(10.55, 4.45, 4.50, "3 · payments", [
        "**recorded by an admin**",
        "Feb 01  venmo            40.00",
        "Mar 20  cash              5.00",
        "**              payments  45.00**",
        "",
        "~no card data is ever stored —",
        "~the money moves outside the system"], MONEY)
    d = card(2.20, 0.80, 11.00,
             "4 · period_summaries — frozen when the admin closes the quarter", [
        "**player              games  league  pickup  no-show   opening  charges  payments  balance**",
        "Sheng Qin               12       9       3        1     15.00    55.00     45.00    25.00",
        "Justin Wang             14      10       4        0      0.00    70.00     70.00     0.00",
        "Li Wei (pays for 2)      —       —       —        —      0.00   130.00    100.00    30.00",
        "",
        "**~balance = opening_balance + charges − payments** — an unpaid amount carries into the next quarter.",
        "~Exported as CSV per player and per paying account; every row drills back to the line items above."], MONEY)

    edge(ax, a["r"], b["l"], color=MONEY, lw=1.6)
    edge(ax, b["r"], c["l"], color=MONEY, lw=1.6, ls=(0, (4, 3)))
    edge(ax, (b["x"] + 1.6, 4.45), (d["x"] + 2.4, d["top"]), color=MONEY, lw=1.6)
    edge(ax, (c["x"] + 2.0, 4.45), (d["x"] + 7.2, d["top"]), color=MONEY, lw=1.6)
    trim(fig, ax, W, 0.62, H)
    save(fig, "05-billing.png")



# ========================================================= 6. hosting
HOST = "#be185d"


def fig_hosting():
    W, H = 17.4, 10.4
    fig, ax = canvas(W, H)
    title(ax, 0.3, H - 0.15, "Stretch goal — hosting our own tournament",
          "The Kylin Cup run on our platform: visiting clubs enter their own teams, submit their own rosters and "
          "confirm their own results")

    xs = [0.35, 3.18, 6.01, 8.84, 11.67, 14.50]
    SW = 2.55
    steps = [
        ("Admin", IDENTITY, "Create the tournament",
         "competitions.hosting_mode\n= 'host'",
         ["competitions +"]),
        ("Visiting club", HOST, "Clubs enter teams",
         "entry window, entry fee,\nmax teams",
         ["clubs", "teams", "tournament_entries"]),
        ("Admin", IDENTITY, "Approve and draw",
         "accept entries, seed them\ninto groups",
         ["competition_groups", "tournament_entries", "games  (fixtures)"]),
        ("Visiting club", HOST, "Submit the roster",
         "names, numbers,\neligibility",
         ["entry_roster", "players  (no login)"]),
        ("Captain / referee", PARTICIP, "Play and record",
         "score confirmed by\nboth teams",
         ["game_results", "game_events"]),
        ("System", PLATFORM, "Publish and settle",
         "tables, top scorers,\nentry-fee invoices",
         ["v_standings", "v_scorers", "charges  (entry_fee)"]),
    ]

    for (actor, acol, head, body, chips), x in zip(steps, xs):
        ax.text(x + SW / 2, 9.42, actor.upper(), fontsize=7.4, fontweight="bold",
                color=acol, ha="center", va="center")
        ax.add_patch(FancyBboxPatch((x, 7.85), SW, 1.42,
                     boxstyle="round,pad=0,rounding_size=0.14",
                     fc=PAPER, ec=acol, lw=1.4, zorder=4))
        ax.text(x + SW / 2, 8.92, head, fontsize=9.2, fontweight="bold",
                color=NAVY, ha="center", va="center", zorder=5)
        ax.text(x + SW / 2, 8.32, body, fontsize=7.8, color=MUTED,
                ha="center", va="center", zorder=5)
        for i, c in enumerate(chips):
            cy = 7.18 - i * 0.60
            is_new = not c.endswith("+")
            ax.add_patch(FancyBboxPatch((x + 0.10, cy), SW - 0.20, 0.46,
                         boxstyle="round,pad=0,rounding_size=0.10",
                         fc="#fdf2f7" if is_new else WASH,
                         ec=HOST if is_new else LINE,
                         lw=1.1, ls="-" if is_new else (0, (3, 2)), zorder=4))
            ax.text(x + SW / 2, cy + 0.23, c.rstrip(" +"), fontsize=7.9,
                    color=HOST if is_new else MUTED, ha="center", va="center",
                    zorder=5, family="monospace")

    for x in xs[:-1]:
        edge(ax, (x + SW, 8.56), (x + SW + 0.28, 8.56), color=GREY, lw=1.1)

    ax.add_patch(FancyBboxPatch((0.35, 5.47), 0.34, 0.30,
                 boxstyle="round,pad=0,rounding_size=0.08",
                 fc="#fdf2f7", ec=HOST, lw=1.1))
    ax.text(0.90, 5.62, "new table", fontsize=7.8, color=MUTED, va="center")
    ax.add_patch(FancyBboxPatch((2.55, 5.47), 0.34, 0.30,
                 boxstyle="round,pad=0,rounding_size=0.08",
                 fc=WASH, ec=LINE, lw=1.1, ls=(0, (3, 2))))
    ax.text(3.10, 5.62, "existing table, new columns only", fontsize=7.8,
            color=MUTED, va="center")
    ax.text(W - 0.3, 5.62,
            "Nothing in the member-facing model is replaced — the pickup on Saturday works exactly as before.",
            fontsize=7.8, color=MUTED, va="center", ha="right")
    ax.add_patch(Rectangle((0.3, 5.10), W - 0.6, 0.035, fc=LINE, ec="none"))

    cols = [
        ("A visiting club's manager CAN", HOST, [
            "create an account like anyone else",
            "enter one or more teams into the tournament",
            "edit their entry until the window closes",
            "submit and amend their own squad list",
            "see their own fixtures, times and pitch",
            "confirm the score of their own matches",
            "see and pay their own entry-fee invoice",
        ]),
        ("…and CANNOT", DANGER, [
            "see another club's roster or contact details",
            "see any CalBlue member's profile or phone",
            "see anybody's charges, payments or balance",
            "edit a fixture, a result they are not in,",
            "  or their own approval status",
            "reach anything outside this one tournament",
        ]),
        ("What this costs the v1 model", PLATFORM, [
            "three forward-compatible columns now:",
            "  teams.club_id, games.home/away_team_id,",
            "  charges.entry_id (player_id becomes nullable)",
            "everything else is a self-contained module",
            "that can land a year later without a",
            "single migration of attendance or billing",
        ]),
    ]
    for (head, color, lines), x in zip(cols, (0.35, 6.05, 11.75)):
        ax.text(x, 4.62, head, fontsize=9.4, fontweight="bold", color=color)
        for i, ln in enumerate(lines):
            ax.text(x, 4.20 - i * 0.34, ("•  " if not ln.startswith(" ") else "    ") + ln.strip(),
                    fontsize=8.4, color=INK if not ln.startswith(" ") else MUTED)
    trim(fig, ax, W, 1.75, H)
    save(fig, "06-hosting.png")



# ============================================================ 7. clients
APP = "#0369a1"


def fig_clients():
    W, H = 16.6, 10.7
    fig, ax = canvas(W, H)
    title(ax, 0.3, H - 0.15, "Stretch goal — a phone app on the same backend",
          "The app is another client, not another system. It gets exactly the permissions the member "
          "already has, because the database is what enforces them.")

    # ---- clients
    clients = [
        ("Member — phone", APP, "the 80% case", [
            "what am I playing next",
            "register / cancel, pick a number",
            "my statement and balance",
        ]),
        ("Captain — phone at the pitch", PARTICIP, "must work with no signal", [
            "today's squad list",
            "tap present / absent",
            "finalise when back in range",
        ]),
        ("Admin — browser", IDENTITY, "stays on a big screen", [
            "competitions, fixtures, fees",
            "verification and approvals",
            "close and export the quarter",
        ]),
    ]
    cw = 5.03
    for (name, color, tag, bullets), x in zip(clients, (0.4, 5.78, 11.16)):
        ax.add_patch(FancyBboxPatch((x, 7.55), cw, 2.05,
                     boxstyle="round,pad=0,rounding_size=0.16",
                     fc=PAPER, ec=color, lw=1.5, zorder=4))
        ax.text(x + 0.28, 9.25, name, fontsize=10.4, fontweight="bold",
                color=color, va="center", zorder=5)
        ax.text(x + cw - 0.28, 9.25, tag, fontsize=7.6, color=MUTED,
                ha="right", va="center", style="italic", zorder=5)
        for i, b in enumerate(bullets):
            ax.text(x + 0.28, 8.72 - i * 0.34, "•  " + b, fontsize=8.5,
                    color=INK, va="center", zorder=5)
        edge(ax, (x + cw / 2, 7.55), (x + cw / 2, 7.02), color=color, lw=1.4)

    # ---- the one door
    ax.add_patch(FancyBboxPatch((0.4, 6.28), W - 0.8, 0.74,
                 boxstyle="round,pad=0,rounding_size=0.16",
                 fc=NAVY, ec=NAVY, zorder=4))
    ax.text(W / 2, 6.65, "One API · one set of Postgres row-level security policies · one definition of who may see what",
            fontsize=10.2, fontweight="bold", color="white", ha="center",
            va="center", zorder=5)
    edge(ax, (W / 2, 6.28), (W / 2, 5.80), color=NAVY, lw=1.4)

    # ---- the model, unchanged
    panel(ax, 0.4, 4.05, W - 0.8, 1.75, "The model in sections 5–11 — unchanged", PLATFORM)
    groups = [("Identity & access", IDENTITY), ("Events & schedule", EVENTS),
              ("Participation", PARTICIP), ("Money & billing", MONEY)]
    gw = 3.62
    for (label, color), x in zip(groups, (0.72, 4.62, 8.52, 12.42)):
        ax.add_patch(FancyBboxPatch((x, 4.32), gw, 0.72,
                     boxstyle="round,pad=0,rounding_size=0.12",
                     fc=PAPER, ec=color, lw=1.3, zorder=4))
        ax.text(x + gw / 2, 4.68, label, fontsize=9.2, fontweight="bold",
                color=color, ha="center", va="center", zorder=5)

    # ---- what the app actually adds
    panel(ax, 0.4, 0.28, 7.55, 3.42, "What a phone app adds", APP)
    dev = entity(ax, 0.75, 3.00, 6.85, "devices", [
        "account_id · platform · push_token",
        "last_seen_at · app_version"], APP)
    entity(ax, 0.75, dev["y"] - 0.30, 6.85, "notifications  (outbox)", [
        "account_id · kind · payload · scheduled_for",
        "sent_at · read_at   — one row per thing we tell somebody"], APP)

    # ---- offline
    panel(ax, 8.25, 0.35, 7.95, 3.35, "Check-in has to survive a dead signal", PARTICIP)
    steps = [
        "Captain taps present / absent\nwith no bars at the field",
        "Queued on the device, stamped\nwith the phone's own clock",
        "On reconnect: upsert keyed on\n(game_id, player_id) — idempotent",
        "Server keeps the latest\ncheck-in; replays are harmless",
    ]
    for i, stx in enumerate(steps):
        y = 2.90 - i * 0.72
        ax.add_patch(FancyBboxPatch((8.60, y - 0.30), 7.25, 0.60,
                     boxstyle="round,pad=0,rounding_size=0.12",
                     fc=PAPER, ec=PARTICIP, lw=1.2, zorder=4))
        ax.text(8.82, y, str(i + 1), fontsize=9, fontweight="bold",
                color=PARTICIP, ha="center", va="center", zorder=5)
        ax.text(9.15, y, stx, fontsize=8.3, color=INK, va="center", zorder=5)
        if i < 3:
            edge(ax, (9.0, y - 0.30), (9.0, y - 0.42), color=PARTICIP, lw=1.1)

    ax.text(W / 2, -0.10,
            "The app bundle never contains the service key. An attacker who unpacks the app finds a client with a member's permissions — and nothing more.",
            fontsize=8.6, color=NAVY, ha="center", va="bottom", fontweight="bold")
    trim(fig, ax, W, -0.32, H)
    save(fig, "07-clients.png")


if __name__ == "__main__":
    fig_erd()
    fig_permissions()
    fig_lifecycles()
    fig_flow()
    fig_billing()
    fig_hosting()
    fig_clients()
