import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { endpoints } from "../lib/api";
import { Button } from "../components/ui";

// Jellyfin credential pass-through (§11): posts to Sweeparr, which authenticates
// against Jellyfin and mints a session cookie.
export function Login() {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await endpoints.login(username, password);
      await qc.invalidateQueries();
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form
        onSubmit={submit}
        className="w-[340px] rounded-lg border border-line-subtle bg-bg-raised p-7"
      >
        <div className="mb-1 font-mono text-[15px] font-semibold text-ink-hi">
          ▚ SWEEPARR
        </div>
        <div className="mb-6 text-[12px] text-ink-low">
          Sign in with your local admin or Jellyfin account
        </div>
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-low">
          Username
        </label>
        <input
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mb-4 h-9 w-full rounded border border-line bg-bg px-3 text-[13px] text-ink-hi outline-none focus:border-accent"
        />
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-low">
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-5 h-9 w-full rounded border border-line bg-bg px-3 text-[13px] text-ink-hi outline-none focus:border-accent"
        />
        {error && (
          <div className="mb-4 text-[12px] text-state-scheduled-ink">
            {error}
          </div>
        )}
        <Button variant="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
