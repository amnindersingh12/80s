import { useState, type FormEvent } from "react";
import { api, describeError } from "../api";
import { Icon, Spinner } from "./Icons";

export function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      await api.unlock(key);
      onUnlocked();
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="unlock">
      <form className="unlock-card" onSubmit={submit}>
        <div className="unlock-icon">
          <Icon name="lock" size={28} />
        </div>
        <h1>This player is locked</h1>
        <p className="dim">Enter the access key configured as <code>APP_ACCESS_KEY</code> on the server.</p>
        <label className="sr-only" htmlFor="access-key">
          Access key
        </label>
        <input
          id="access-key"
          className="text-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Access key"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "unlock-error" : undefined}
        />
        {error ? (
          <p id="unlock-error" className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !key}>
          {busy ? <Spinner size={16} /> : null} Unlock
        </button>
      </form>
    </main>
  );
}
