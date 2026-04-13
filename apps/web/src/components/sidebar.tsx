"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useGateway } from "../context/gateway";
import { useSidebarLayout } from "../context/sidebar-layout";
import { SidebarCollapseToggle } from "./sidebar-collapse-toggle";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/jobs/new", label: "New Task" },
  { href: "/jobs", label: "Districts" },
  { href: "/bridges", label: "Bridges" },
  { href: "/approvals", label: "Approvals" },
  { href: "/activity", label: "Activity Log" },
  { href: "/ai-history", label: "AI History" },
  { href: "/chat", label: "Chat" },
  { href: "/flowers", label: "Flowers" },
  { href: "/settings", label: "Settings" },
];

export function Sidebar() {
  const pathname = usePathname();
  const { connected } = useGateway();
  const { collapsed } = useSidebarLayout();

  return (
    <aside className={`app-sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-top">
        <div className="sidebar-brand-block">
          <div className="sidebar-logo">
            <div className="sidebar-logo-text-wrap">
              <strong className="sidebar-logo-text">beebridge</strong>
            </div>
            <div className="sidebar-status-wrap">
              <span className={`sidebar-status ${connected ? "online" : "offline"}`}>
                {connected ? "Connected" : "Disconnected"}
              </span>
            </div>
          </div>
        </div>
        <SidebarCollapseToggle />
      </div>
      <nav className="sidebar-nav" aria-label="Main">
        <ul className="sidebar-nav-list">
          {NAV_ITEMS.map((item) => {
            const active =
              item.href === "/jobs/new"
                ? pathname === "/jobs/new"
                : item.href === "/jobs"
                  ? pathname === "/jobs" || (pathname.startsWith("/jobs/") && pathname !== "/jobs/new")
                  : pathname.startsWith(item.href);
            return (
              <li key={item.href} className="sidebar-nav-item">
                <Link
                  href={item.href}
                  className={`sidebar-link ${active ? "active" : ""}`}
                  title={collapsed ? item.label : undefined}
                >
                  <span className="sidebar-label">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
