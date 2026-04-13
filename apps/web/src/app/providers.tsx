"use client";

import type { ReactNode } from "react";
import { GatewayProvider } from "../context/gateway";
import { SidebarLayoutProvider } from "../context/sidebar-layout";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <GatewayProvider>
      <SidebarLayoutProvider>{children}</SidebarLayoutProvider>
    </GatewayProvider>
  );
}
