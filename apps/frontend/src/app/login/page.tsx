"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ApiFailure, api } from "@/lib/api";

/**
 * FA-01 — a username and a password, and nothing else.
 *
 * There is no SSO button and there never will be one: NFR-02 puts
 * authentication on the local directory deliberately, with a separate account
 * from everyday work. The platform binds as the user and stores no password.
 */
export default function LoginPage() {
  const router = useRouter();
  const client = useQueryClient();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.login({ username, password });
      // Everything held about the previous session goes, rather than being
      // merged: FA-02.2 rebuilds the entitlements from the directory at every
      // login, and a cached area list would outlive that.
      client.clear();
      router.replace("/");
    } catch (cause) {
      setError(
        cause instanceof ApiFailure ? cause.message : "Could not sign in. Please try again.",
      );
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-7">
          <h1 className="text-lg font-semibold tracking-tight text-ink">Scriptoria</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            Sign in with your directory account.
          </p>
        </div>

        <form
          onSubmit={(event) => void submit(event)}
          className="rounded-[var(--radius-panel)] border border-line bg-surface p-6"
        >
          <label className="block">
            <span className="text-xs font-medium text-ink">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
              required
              className="mt-1.5 w-full rounded-[var(--radius-control)] border border-line bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint"
            />
          </label>

          <label className="mt-4 block">
            <span className="text-xs font-medium text-ink">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              className="mt-1.5 w-full rounded-[var(--radius-control)] border border-line bg-canvas px-3 py-2 text-[13px] text-ink"
            />
          </label>

          {error ? (
            <p
              role="alert"
              className="mt-4 rounded-[var(--radius-control)] bg-modifies-quiet px-3 py-2 text-xs text-modifies"
            >
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="mt-5 w-full rounded-[var(--radius-control)] bg-accent px-3 py-2 text-[13px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
