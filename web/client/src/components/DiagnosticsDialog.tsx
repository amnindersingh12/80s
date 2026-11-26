import { useEffect, useRef, useState } from "react";
import type { DoctorResponse } from "../../../shared/api";
import { api, describeError } from "../api";
import { Icon, Spinner } from "./Icons";

/** Runs `GET /api/doctor` and shows the same report `npm run doctor` prints. */
export function DiagnosticsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<DoctorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => () => abort.current?.abort(), []);

  const run = async () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRunning(true);
    setError(null);
    try {
      setReport(await api.doctor(query.trim() || undefined, ctrl.signal));
    } catch (err) {
      if (!ctrl.signal.aborted) setError(describeError(err).message);
    } finally {
      if (abort.current === ctrl) setRunning(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog dialog-wide" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="diag-title">
      <header className="dialog-header">
        <h2 id="diag-title">
          <Icon name="wrench" /> Diagnostics
        </h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <p className="diag-intro">
        Checks the server's live configuration: env vars (masked), media-server auth, one sample search with the raw JSON
        keys next to the <code>MEDIA_*</code> field mappings, and the recommendation sources.
      </p>
      <form
        className="diag-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input className="diag-query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Sample search (default: love)" maxLength={100} aria-label="Sample search query" />
        <button className="btn" type="submit" disabled={running}>
          {running ? <Spinner size={14} /> : <Icon name="retry" size={16} />} {report ? "Run again" : "Run checks"}
        </button>
      </form>
      {error && <p className="diag-error">{error}</p>}
      {report && (
        <>
          <p className={`diag-summary ${report.ok ? "ok" : "fail"}`}>
            {report.ok ? "All checks passed" : `Failed: ${report.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", ")}`}
            <span> · {(report.durationMs / 1000).toFixed(1)} s</span>
          </p>
          <pre className="diag-output">
            {report.lines.map((line, i) => {
              const t = line.trimStart();
              const cls = t.startsWith("✓") ? "ok" : t.startsWith("✗") ? "fail" : t.startsWith("!") ? "warn" : undefined;
              return (
                <span key={i} className={cls}>
                  {line}
                  {"\n"}
                </span>
              );
            })}
          </pre>
        </>
      )}
    </dialog>
  );
}
