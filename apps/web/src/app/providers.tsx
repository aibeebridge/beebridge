import type { ReactNode } from "react";
import { ProvidersClient } from "./providers-client";

export function Providers({ children }: { children: ReactNode }) {
  return <ProvidersClient>{children}</ProvidersClient>;
}
