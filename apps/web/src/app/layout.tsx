import "./globals.css";
import type { ReactNode } from "react";
import type { Viewport } from "next";
import { Providers } from "./providers";
import { AppShell } from "../components/app-shell";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
