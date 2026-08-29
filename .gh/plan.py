"""The build plan: sequence, hard dependencies, and the waves derived from them.

Single source of truth for ordering. `.gh/status.py` reads this and regenerates the status table in
tracking issue #58, so the plan lives in one place rather than being retyped into issue bodies.

A dependency belongs here only if the work genuinely cannot be done or verified without the other
thing merged — a schema object, a module, or a screen it builds on. "It would be tidier to do X
first" is not a dependency and must not be listed, because a false dependency serialises work that
could have run in parallel.
"""

TRACKING_ISSUE = 58
BASE_PR = 56

# issue number -> hard dependencies (issue numbers)
HARD = {
    23: [], 24: [], 25: [],
    26: [25], 27: [25, 26], 28: [25, 26], 29: [23, 24],
    30: [24, 27, 29], 31: [25, 30], 32: [27, 30],
    33: [25, 29, 30], 34: [25, 29], 35: [31, 34], 36: [35], 37: [35], 38: [26, 37],
    39: [25, 29, 30], 40: [39], 41: [33, 39], 42: [40, 41],
    43: [26, 29, 30], 44: [26, 29, 30], 45: [26, 38, 44], 46: [26, 29, 30], 47: [45],
    48: [26, 30], 49: [37, 48], 50: [26], 51: [26, 27, 29, 30],
    52: [25, 29, 30], 53: [26, 45, 52], 54: [53], 55: [54],
}

# issue number -> sequence position (1..33), the order we intend to work in
SEQUENCE = {n: i + 1 for i, n in enumerate([
    23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    33, 34, 35, 36, 37, 38,
    39, 40, 41, 42,
    43, 44, 45, 46, 47,
    48, 49, 50, 51,
    52, 53, 54, 55,
])}

MILESTONE_OF = {}
for _n in range(23, 33):
    MILESTONE_OF[_n] = "M1 — Foundations"
for _n in range(33, 39):
    MILESTONE_OF[_n] = "M2 — Pickup end to end"
for _n in range(39, 43):
    MILESTONE_OF[_n] = "M3 — Competitions"
for _n in range(43, 48):
    MILESTONE_OF[_n] = "M4 — Money"
for _n in range(48, 52):
    MILESTONE_OF[_n] = "M5 — Polish and the installable app"
for _n in range(52, 56):
    MILESTONE_OF[_n] = "M6 — Hosted tournaments"

# Issues that cannot be finished by an agent alone, and what they need from a human.
NEEDS_HUMAN = {
    24: "a Supabase login to provision the project; downstream work runs against placeholders "
        "until then, so this blocks nothing in practice",
}


def waves(hard=None):
    """Topological waves. Everything in a wave is mutually independent."""
    hard = hard or HARD
    remaining, placed, out = dict(hard), set(), []
    while remaining:
        ready = sorted(n for n, deps in remaining.items() if all(d in placed for d in deps))
        if not ready:
            raise RuntimeError(f"dependency cycle among {sorted(remaining)}")
        out.append(ready)
        placed |= set(ready)
        remaining = {n: d for n, d in remaining.items() if n not in placed}
    return out


def wave_of():
    return {n: i + 1 for i, ns in enumerate(waves()) for n in ns}


def blocks():
    return {n: sorted(m for m, deps in HARD.items() if n in deps) for n in HARD}
