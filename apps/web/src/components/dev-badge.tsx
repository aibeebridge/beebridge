"use client";

import { useState, useRef, useEffect } from "react";
import {
  useGateway,
  parseGatewayJsonBody,
  gatewayHealthUrl,
  fetchWithGatewayTimeout,
  GATEWAY_HEALTH_TIMEOUT_MS,
} from "../context/gateway";

export function DevBadge() {
  const isProdBuild = process.env.NODE_ENV === "production";
  const buildLabel = isProdBuild ? "prod" : "dev";
  const envLabel = isProdBuild ? "production" : "development";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { url, token, connected, reachable, authenticated, authRequired } = useGateway();
  const [info, setInfo] = useState<{ uptime?: string; version?: string; authenticated?: boolean; authRequired?: boolean } | null>(null);

  useEffect(() => {
    if (!open || !reachable) return;
    fetchWithGatewayTimeout(gatewayHealthUrl(url), {
      headers: { Authorization: `Bearer ${token}` },
    }, GATEWAY_HEALTH_TIMEOUT_MS)
      .then((r) => r.text())
      .then((t) => {
        try {
          setInfo(parseGatewayJsonBody(t, "/health") as { uptime?: string; version?: string });
        } catch {
          setInfo(null);
        }
      })
      .catch(() => setInfo(null));
  }, [open, reachable, url, token]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="dev-badge-wrapper">
      {open && (
        <div className="dev-badge-panel">
          <div className="dev-badge-panel-header">
            <strong>beebridge</strong>
            <span className="dev-badge-version">{info?.version ?? buildLabel}</span>
          </div>
          <div className="dev-badge-panel-rows">
            <div className="dev-badge-row">
              <span className="dev-badge-label">Gateway</span>
              <span className={`dev-badge-dot ${reachable ? "on" : "off"}`} />
              <span>{reachable ? "Reachable" : "Offline"}</span>
            </div>
            <div className="dev-badge-row">
              <span className="dev-badge-label">Auth</span>
              <span className={`dev-badge-dot ${connected ? "on" : "off"}`} />
              <span>{authRequired ? (authenticated ? "Authenticated" : "Required") : "Disabled"}</span>
            </div>
            <div className="dev-badge-row">
              <span className="dev-badge-label">URL</span>
              <code>{url}</code>
            </div>
            {info?.uptime && (
              <div className="dev-badge-row">
                <span className="dev-badge-label">Uptime</span>
                <span>{info.uptime}</span>
              </div>
            )}
            <div className="dev-badge-row">
              <span className="dev-badge-label">Env</span>
              <span>{envLabel}</span>
            </div>
          </div>
        </div>
      )}
      <button
        type="button"
        className={`dev-badge ${open ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dev-badge-letter">B</span>
      </button>
    </div>
  );
}
