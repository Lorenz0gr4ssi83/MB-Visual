"""Lavori lunghi in background (conversioni video, LibreOffice) con avanzamento interrogabile."""
import threading
import traceback
import uuid

_JOBS: dict[str, dict] = {}
_LOCK = threading.Lock()


def start(fn, *args, **kwargs) -> str:
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "running", "progress": 0.0, "result": None, "error": None, "message": ""}
    with _LOCK:
        _JOBS[jid] = job

    def update(progress=None, message=None):
        if progress is not None:
            job["progress"] = max(0.0, min(1.0, progress))
        if message is not None:
            job["message"] = message

    def run():
        try:
            job["result"] = fn(*args, update=update, **kwargs)
            job["progress"] = 1.0
            job["status"] = "done"
        except Exception as e:  # noqa: BLE001
            job["error"] = str(e) or e.__class__.__name__
            job["trace"] = traceback.format_exc()
            job["status"] = "error"

    threading.Thread(target=run, daemon=True).start()
    return jid


def get(jid: str) -> dict | None:
    job = _JOBS.get(jid)
    if job is None:
        return None
    return {k: v for k, v in job.items() if k != "trace"}
