"""
Nomni — system flow diagrams using Graphviz.
Generates three diagrams:
  1. uber_flow.png      — Uber Eats webhook → kitchen ticket
  2. doordash_flow.png  — DoorDash webhook → kitchen ticket
  3. status_lifecycle.png — internal order status machine

Requirements:
  pip install graphviz
  Graphviz binaries must be on PATH (https://graphviz.org/download/)
"""

from graphviz import Digraph

# ── shared style ────────────────────────────────────────────────────────────
FONT      = "Helvetica"
BG        = "#FAFAFA"
EDGE_CLR  = "#555555"

def base(name: str, label: str, rankdir: str = "TB") -> Digraph:
    d = Digraph(name, comment=label)
    d.attr(
        rankdir=rankdir,
        bgcolor=BG,
        fontname=FONT,
        fontsize="13",
        pad="0.4",
        splines="ortho",
        nodesep="0.6",
        ranksep="0.7",
    )
    d.attr("node", fontname=FONT, fontsize="12", style="filled", margin="0.2,0.1")
    d.attr("edge", fontname=FONT, fontsize="11", color=EDGE_CLR, arrowsize="0.8")
    return d


# ── 1. Uber Eats flow ────────────────────────────────────────────────────────
def uber_flow() -> Digraph:
    d = base("uber_flow", "Uber Eats Flow")

    # node styles
    ext  = dict(shape="box",       fillcolor="#E8F4FD", color="#2980B9")
    proc = dict(shape="box",       fillcolor="#EBF5EB", color="#27AE60")
    dec  = dict(shape="diamond",   fillcolor="#FEF9E7", color="#F39C12")
    db   = dict(shape="cylinder",  fillcolor="#F5EEF8", color="#8E44AD")
    term = dict(shape="box",       fillcolor="#FDEDEC", color="#E74C3C", style="filled,rounded")
    resp = dict(shape="box",       fillcolor="#D5F5E3", color="#1E8449", style="filled,dashed")

    d.node("uber",      "Uber Eats\nPlatform",                    **ext)
    d.node("post",      "POST /api/webhook\n(thin notification)",  **proc)
    d.node("detect",    "detectProvider()\nevent_type starts 'orders.'\n+ meta.resource_id\n+ resource_href", **dec)
    d.node("auth",      "verifyUber()\nHMAC-SHA256(rawBody,\nUBER_CLIENT_SECRET)\nvs X-Uber-Signature", **proc)
    d.node("auth_fail", "401 Unauthorized",                        **term)
    d.node("resp200",   "HTTP 200 empty body\n(sent immediately)",  **resp)
    d.node("dedup",     "markUberEvent(event_id)\ncheck uber_events table", **dec)
    d.node("skip",      "Skip — already processed",                **term)
    d.node("fetch",     "GET resource_href\nAuthorization: Bearer\nAccept-Encoding: gzip", **proc)
    d.node("dev",       "Dev fallback\nsynthesize minimal\nGet Order object",  **proc)
    d.node("token",     "UBER_ACCESS_TOKEN\nset?",                 **dec)
    d.node("norm",      "fromUberOrder()\nmap fields →\nInternalOrder",        **proc)
    d.node("upsert",    "upsertOrder()\nINSERT … ON CONFLICT\n(provider, external_order_id)\nDO UPDATE",  **db)
    d.node("done",      "Order persisted\nas kitchen ticket",      **resp)

    d.edge("uber",    "post",      "webhook POST")
    d.edge("post",    "detect")
    d.edge("detect",  "auth",      "uber")
    d.edge("detect",  "auth_fail", "unknown\nprovider", style="dashed")
    d.edge("auth",    "auth_fail", "invalid\nsig", style="dashed")
    d.edge("auth",    "resp200",   "valid")
    d.edge("resp200", "dedup",     "process\nasync")
    d.edge("dedup",   "skip",      "seen before", style="dashed")
    d.edge("dedup",   "token",     "new event_id")
    d.edge("token",   "fetch",     "yes")
    d.edge("token",   "dev",       "no (dev)", style="dashed")
    d.edge("fetch",   "norm")
    d.edge("dev",     "norm")
    d.edge("norm",    "upsert")
    d.edge("upsert",  "done")

    return d


# ── 2. DoorDash flow ─────────────────────────────────────────────────────────
def doordash_flow() -> Digraph:
    d = base("doordash_flow", "DoorDash Flow")

    ext  = dict(shape="box",      fillcolor="#FEF5E7", color="#E67E22")
    proc = dict(shape="box",      fillcolor="#EBF5EB", color="#27AE60")
    dec  = dict(shape="diamond",  fillcolor="#FEF9E7", color="#F39C12")
    db   = dict(shape="cylinder", fillcolor="#F5EEF8", color="#8E44AD")
    term = dict(shape="box",      fillcolor="#FDEDEC", color="#E74C3C", style="filled,rounded")
    resp = dict(shape="box",      fillcolor="#D5F5E3", color="#1E8449", style="filled,dashed")

    d.node("dd",       "DoorDash\nPlatform",                         **ext)
    d.node("post",     "POST /api/webhook\n(full order payload)",     **proc)
    d.node("detect",   "detectProvider()\nevent.type === 'OrderCreate'\n+ order object present", **dec)
    d.node("auth",     "verifyDoorDash()\nAuthorization header\nvs DOORDASH_WEBHOOK_AUTH", **proc)
    d.node("auth_fail","401 Unauthorized",                            **term)
    d.node("norm",     "fromDoorDashOrder()\nmap fields →\nInternalOrder\n\nsubtotal + tax → total_cents\nreceipt time → created_at\n'USD' → currency", **proc)
    d.node("upsert",   "upsertOrder()\nINSERT … ON CONFLICT\n(provider, external_order_id)\nDO UPDATE",  **db)
    d.node("resp202",  "HTTP 202\n(async confirm later)",             **resp)
    d.node("done",     "Order persisted\nas kitchen ticket",          **resp)

    d.edge("dd",       "post",      "webhook POST")
    d.edge("post",     "detect")
    d.edge("detect",   "auth",      "doordash")
    d.edge("detect",   "auth_fail", "unknown\nprovider", style="dashed")
    d.edge("auth",     "auth_fail", "invalid\ntoken", style="dashed")
    d.edge("auth",     "norm",      "valid")
    d.edge("norm",     "upsert")
    d.edge("upsert",   "resp202")
    d.edge("resp202",  "done")

    return d


# ── 3. Status lifecycle ───────────────────────────────────────────────────────
def status_lifecycle() -> Digraph:
    d = base("status_lifecycle", "Order Status Lifecycle", rankdir="LR")

    fwd  = dict(shape="box", style="filled,rounded", fillcolor="#D6EAF8", color="#2980B9")
    term = dict(shape="box", style="filled,rounded", fillcolor="#FDEDEC", color="#E74C3C")

    d.node("new",       "new",       **fwd)
    d.node("accepted",  "accepted",  **fwd)
    d.node("ready",     "ready",     **fwd)
    d.node("completed", "completed", **fwd)
    d.node("canceled",  "canceled",  **term)
    d.node("rejected",  "rejected",  **term)

    # forward progression
    d.edge("new",      "accepted",  "kitchen\naccepts")
    d.edge("accepted", "ready",     "food\nready")
    d.edge("ready",    "completed", "picked\nup")

    # terminal exits from any non-terminal state
    for src in ("new", "accepted", "ready"):
        d.edge(src, "canceled", "cancel", style="dashed", color="#E74C3C")
        d.edge(src, "rejected", "reject", style="dashed", color="#C0392B")

    # label
    with d.subgraph(name="cluster_legend") as leg:
        leg.attr(label="Legend", style="dashed", color="#AAAAAA", fontsize="11")
        leg.node("l1", "forward state",  **fwd)
        leg.node("l2", "terminal state", **term)

    return d


# ── render all ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(__file__), "diagrams")
    os.makedirs(out, exist_ok=True)

    for diagram, filename in [
        (uber_flow(),       "uber_flow"),
        (doordash_flow(),   "doordash_flow"),
        (status_lifecycle(),"status_lifecycle"),
    ]:
        path = diagram.render(
            filename=os.path.join(out, filename),
            format="png",
            cleanup=True,
        )
        print(f"Saved: {path}")

    print("\nDone. Open the diagrams/ folder to view the PNG files.")
