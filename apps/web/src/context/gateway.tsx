"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

/** Parse response body; tolerate trailing garbage after one JSON value (e.g. double-writes, debug suffix). */
export function parseGatewayJsonBody(text: string, pathForError: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  const start = trimmed.search(/[\[{]/);
  if (start < 0) {
    throw new Error(`Gateway returned non-JSON (${pathForError}): ${trimmed.slice(0, 160)}`);
  }

  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (c === "{" || c === "[") {
      stack.push(c);
    } else if (c === "}") {
      if (stack.length === 0 || stack.pop() !== "{") {
        throw new Error(`Gateway returned invalid JSON (${pathForError}): ${trimmed.slice(0, 160)}`);
      }
    } else if (c === "]") {
      if (stack.length === 0 || stack.pop() !== "[") {
        throw new Error(`Gateway returned invalid JSON (${pathForError}): ${trimmed.slice(0, 160)}`);
      }
    } else {
      continue;
    }

    if (stack.length === 0) {
      const slice = trimmed.slice(start, i + 1);
      try {
        return JSON.parse(slice);
      } catch {
        throw new Error(`Gateway returned invalid JSON (${pathForError}): ${trimmed.slice(0, 160)}`);
      }
    }
  }

  throw new Error(`Gateway returned invalid JSON (${pathForError}): ${trimmed.slice(0, 160)}`);
}

/** Used when `url` is empty: browser hits same-origin `/api` (Next rewrite → gateway). WS still connects here. */
export const FALLBACK_GATEWAY_ORIGIN =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_GATEWAY_ORIGIN
    ? process.env.NEXT_PUBLIC_GATEWAY_ORIGIN.replace(/\/$/, "")
    : "http://127.0.0.1:4321";

function httpBaseForFetch(urlState: string): string {
  const trimmed = urlState.trim().replace(/\/$/, "");
  if (trimmed !== "") return trimmed;
  if (typeof window === "undefined") {
    return (process.env.INTERNAL_GATEWAY_ORIGIN ?? FALLBACK_GATEWAY_ORIGIN).replace(/\/$/, "");
  }
  return "";
}

export function gatewayFetchUrl(urlState: string, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = httpBaseForFetch(urlState);
  return base ? `${base}${p}` : p;
}

export function gatewayHealthUrl(urlState: string): string {
  const base = httpBaseForFetch(urlState);
  return base ? `${base}/health` : "/health";
}

export function gatewayWsUrl(urlState: string, token: string): string {
  const trimmed = urlState.trim();
  if (trimmed) {
    const base = trimmed.replace(/\/$/, "");
    const ws = base.replace(/^https/, "wss").replace(/^http/, "ws");
    return `${ws}/ws?token=${encodeURIComponent(token)}`;
  }
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const port = process.env.NEXT_PUBLIC_GATEWAY_WS_PORT ?? "4321";
    return `${proto}://${host}:${port}/ws?token=${encodeURIComponent(token)}`;
  }
  const base = FALLBACK_GATEWAY_ORIGIN.replace(/\/$/, "");
  const ws = base.replace(/^https/, "wss").replace(/^http/, "ws");
  return `${ws}/ws?token=${encodeURIComponent(token)}`;
}

interface GatewayContextValue {
  url: string;
  token: string;
  connected: boolean;
  setUrl: (url: string) => void;
  setToken: (token: string) => void;
  setConnected: (v: boolean) => void;
  apiFetch: (path: string, init?: RequestInit) => Promise<any>;
}

const GatewayContext = createContext<GatewayContextValue | null>(null);

export function GatewayProvider({ children }: { children: ReactNode }) {
  /** Empty = same-origin `/api` + `/health` via Next rewrites → gateway (see next.config.ts). */
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("dev-token");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(gatewayHealthUrl(url), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!cancelled) setConnected(r.ok);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => { cancelled = true; };
  }, [url, token]);

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      let res: Response;
      try {
        res = await fetch(gatewayFetchUrl(url, path), {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...(init?.headers ?? {}),
          },
        });
      } catch {
        setConnected(false);
        throw new Error("Network error: could not reach the gateway");
      }
      const text = await res.text();
      if (!res.ok) {
        // Gateway responded — not a network failure; keep "Connected" (health reflects reachability).
        throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
      }
      setConnected(true);
      if (res.status === 204) return {};
      try {
        return parseGatewayJsonBody(text, path);
      } catch (parseErr) {
        throw parseErr;
      }
    },
    [url, token],
  );

  return (
    <GatewayContext.Provider value={{ url, token, connected, setUrl, setToken, setConnected, apiFetch }}>
      {children}
    </GatewayContext.Provider>
  );
}

export function useGateway(): GatewayContextValue {
  const ctx = useContext(GatewayContext);
  if (!ctx) throw new Error("useGateway must be used within GatewayProvider");
  return ctx;
}
