"""Zulfidraw — an Excalidraw-style whiteboard locked to an isometric grid.

Flask + SQLite backend. The canvas itself is client-side SVG (static/js/iso.js);
htmx drives the drawing-management UI (list / create / rename / delete).
"""

import json
import os
import sqlite3
import time
import uuid

from flask import Flask, abort, g, redirect, render_template, request, url_for

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("ZULFIDRAW_DB") or os.path.join(HERE, "zulfidraw.db")
MAX_DOC_BYTES = 4 * 1024 * 1024
REVISION_EVERY = 60.0      # seconds between routine document snapshots
KEEP_REVISIONS = 12
DESTRUCTIVE_RATIO = 0.5    # a save keeping ≤ half the shapes always snapshots first

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True  # edit a template, hit refresh — no restart


# --- db ---------------------------------------------------------------

def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS drawings (
               id         TEXT PRIMARY KEY,
               name       TEXT NOT NULL,
               data       TEXT NOT NULL DEFAULT '{"shapes":[]}',
               created_at REAL NOT NULL,
               updated_at REAL NOT NULL
           )"""
    )
    # Autosave overwrites the document within a second of any change, so a bad
    # client state can destroy work with no user action. Snapshots make that
    # recoverable: throttled to one every REVISION_EVERY seconds, newest N kept.
    conn.execute(
        """CREATE TABLE IF NOT EXISTS revisions (
               id       INTEGER PRIMARY KEY AUTOINCREMENT,
               drawing  TEXT NOT NULL,
               data     TEXT NOT NULL,
               shapes   INTEGER NOT NULL,
               saved_at REAL NOT NULL
           )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS rev_drawing ON revisions (drawing, saved_at DESC)")
    conn.commit()
    conn.close()


def snapshot(did, old_data, now, new_n=None):
    """Record the pre-save document, keeping the newest KEEP_REVISIONS.

    Throttled to one snapshot per REVISION_EVERY seconds, EXCEPT when the
    incoming save destroys most of the document — that is precisely the write
    worth being able to undo, so it always gets a snapshot of what it replaced.
    """
    try:
        n = len(json.loads(old_data).get("shapes", []))
    except ValueError:
        return
    if n == 0:
        return  # nothing worth keeping
    destructive = new_n is not None and new_n <= n * DESTRUCTIVE_RATIO
    last = db().execute(
        "SELECT saved_at FROM revisions WHERE drawing=? ORDER BY saved_at DESC LIMIT 1", (did,)
    ).fetchone()
    if last and now - last["saved_at"] < REVISION_EVERY and not destructive:
        return
    db().execute(
        "INSERT INTO revisions (drawing, data, shapes, saved_at) VALUES (?,?,?,?)",
        (did, old_data, n, now),
    )
    db().execute(
        """DELETE FROM revisions WHERE drawing=? AND id NOT IN
           (SELECT id FROM revisions WHERE drawing=? ORDER BY saved_at DESC LIMIT ?)""",
        (did, did, KEEP_REVISIONS),
    )


def get_drawing(did):
    row = db().execute("SELECT * FROM drawings WHERE id=?", (did,)).fetchone()
    if row is None:
        abort(404)
    return row


def all_drawings():
    return db().execute(
        "SELECT id, name, updated_at FROM drawings ORDER BY updated_at DESC"
    ).fetchall()


def create_drawing(name=None):
    did = uuid.uuid4().hex[:10]
    now = time.time()
    n = db().execute("SELECT COUNT(*) FROM drawings").fetchone()[0]
    name = name or f"Untitled {n + 1}"
    db().execute(
        "INSERT INTO drawings (id, name, created_at, updated_at) VALUES (?,?,?,?)",
        (did, name, now, now),
    )
    db().commit()
    return did


# --- pages ------------------------------------------------------------

@app.get("/")
def home():
    row = db().execute(
        "SELECT id FROM drawings ORDER BY updated_at DESC LIMIT 1"
    ).fetchone()
    did = row["id"] if row else create_drawing()
    return redirect(url_for("editor", did=did))


@app.get("/d/<did>")
def editor(did):
    d = get_drawing(did)
    return render_template("index.html", drawing=d, doc=d["data"])


# --- htmx: drawing management ------------------------------------------

@app.get("/partials/drawings")
def drawings_partial():
    return render_template(
        "_drawings.html", drawings=all_drawings(), current=request.args.get("current")
    )


@app.post("/drawings")
def new_drawing():
    did = create_drawing()
    resp = app.make_response("")
    resp.headers["HX-Redirect"] = url_for("editor", did=did)
    return resp


@app.post("/d/<did>/rename")
def rename(did):
    get_drawing(did)
    name = (request.form.get("name") or "").strip() or "Untitled"
    db().execute(
        "UPDATE drawings SET name=?, updated_at=? WHERE id=?", (name[:80], time.time(), did)
    )
    db().commit()
    resp = app.make_response(name[:80])
    resp.headers["HX-Trigger"] = "drawingsChanged"
    return resp


@app.delete("/d/<did>")
def delete(did):
    get_drawing(did)
    db().execute("DELETE FROM drawings WHERE id=?", (did,))
    db().commit()
    resp = app.make_response("")
    if request.args.get("current") == did:
        resp.headers["HX-Redirect"] = url_for("home")
    else:
        resp.headers["HX-Trigger"] = "drawingsChanged"
    return resp


# --- json api: document persistence ------------------------------------

@app.put("/api/d/<did>/data")
def save_data(did):
    row = get_drawing(did)
    raw = request.get_data()
    if len(raw) > MAX_DOC_BYTES:
        return {"ok": False, "error": "document too large"}, 413
    try:
        doc = json.loads(raw)
        assert isinstance(doc.get("shapes"), list)
    except (ValueError, AssertionError):
        return {"ok": False, "error": "bad payload"}, 400
    now = time.time()
    snapshot(did, row["data"], now, new_n=len(doc["shapes"]))
    db().execute(
        "UPDATE drawings SET data=?, updated_at=? WHERE id=?",
        (json.dumps(doc, separators=(",", ":")), now, did),
    )
    db().commit()
    return {"ok": True}


# --- version history ----------------------------------------------------

@app.get("/partials/history/<did>")
def history_partial(did):
    get_drawing(did)
    revs = db().execute(
        "SELECT id, shapes, saved_at FROM revisions WHERE drawing=? ORDER BY saved_at DESC", (did,)
    ).fetchall()
    return render_template("_history.html", revs=revs, did=did, now=time.time())


@app.post("/d/<did>/restore/<int:rev>")
def restore(did, rev):
    get_drawing(did)
    r = db().execute(
        "SELECT data FROM revisions WHERE id=? AND drawing=?", (rev, did)
    ).fetchone()
    if r is None:
        abort(404)
    now = time.time()
    snapshot(did, get_drawing(did)["data"], now)  # the state we're leaving is recoverable too
    db().execute("UPDATE drawings SET data=?, updated_at=? WHERE id=?", (r["data"], now, did))
    db().commit()
    resp = app.make_response("")
    resp.headers["HX-Refresh"] = "true"
    return resp


init_db()

if __name__ == "__main__":
    from waitress import serve

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    print(f"zulfidraw on http://{host}:{port}  (db: {DB_PATH})")
    serve(app, host=host, port=port, threads=8)
