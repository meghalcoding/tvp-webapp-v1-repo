import type { ReactNode } from "react";
import "./Card.css";

export function Card({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {(title || action) && (
        <div className="card-head">
          {title && <h2 className="card-title">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
