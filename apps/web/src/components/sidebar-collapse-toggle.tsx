"use client";

import { useSidebarLayout } from "../context/sidebar-layout";

export function SidebarCollapseToggle() {
  const { collapsed, toggleSidebar } = useSidebarLayout();

  return (
    <button
      type="button"
      className="sidebar-collapse-toggle"
      onClick={toggleSidebar}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      <span className="sidebar-collapse-toggle-icon">{collapsed ? "»" : "«"}</span>
    </button>
  );
}
