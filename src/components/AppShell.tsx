import type { ReactNode } from "react";
import "./AppShell.css";

const NAV = [
  { key: "home", label: "Home", glyph: "⌂" },
  { key: "sales", label: "Sales", glyph: "₹" },
  { key: "purchases", label: "Purchases", glyph: "▤" },
  { key: "expenses", label: "Expenses", glyph: "◈" },
  { key: "more", label: "More", glyph: "•••" },
];

export function AppShell({
  active, onNavigate, title, primaryAction, children,
}: {
  active: string;
  onNavigate: (key: string) => void;
  title: string;
  primaryAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="shell-rail">
        <div className="shell-rail-brand">Cravory</div>
        <nav className="shell-rail-nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`shell-rail-item ${active === n.key ? "shell-rail-item-active" : ""}`}
              onClick={() => onNavigate(n.key)}
            >
              <span className="shell-rail-glyph">{n.glyph}</span>
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="shell-main">
        <header className="shell-topbar">
          <h1 className="shell-topbar-title">{title}</h1>
          {primaryAction}
        </header>
        <main className="shell-content">{children}</main>
      </div>

      <nav className="shell-tabbar">
        {NAV.map((n) => (
          <button
            key={n.key}
            className={`shell-tab-item ${active === n.key ? "shell-tab-item-active" : ""}`}
            onClick={() => onNavigate(n.key)}
          >
            <span className="shell-tab-glyph">{n.glyph}</span>
            <span className="shell-tab-label">{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
