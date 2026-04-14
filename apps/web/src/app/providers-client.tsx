"use client";

import type { ReactNode } from "react";
import { GatewayProvider } from "../context/gateway";
import { SidebarLayoutProvider } from "../context/sidebar-layout";

export function ProvidersClient({
  children,
  initialGatewayToken,
}: {
  children: ReactNode;
  initialGatewayToken?: string;
}) {
  return (
    <GatewayProvider initialToken={initialGatewayToken}>
      <SidebarLayoutProvider>{children}</SidebarLayoutProvider>
    </GatewayProvider>
  );
}
