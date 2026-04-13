"use client";

import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { DevBadge } from "./dev-badge";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">{children}</main>
      <DevBadge />
    </div>
  );
}
