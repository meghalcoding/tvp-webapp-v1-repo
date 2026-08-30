import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./Button.css";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

/**
 * One button component, four meanings.
 * - primary: the one action this screen exists for (gold). There should be
 *   exactly one visible per screen/section — that's the "one primary action"
 *   rule enforced structurally, not just by convention.
 * - secondary: a real alternative action (outline, same weight as primary).
 * - ghost: low-emphasis, e.g. "Cancel" next to a sheet's primary action.
 * - destructive: irreversible/undo-worthy actions only (reverse, delete).
 */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = false,
  icon,
  children,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant} btn-${size} ${fullWidth ? "btn-full" : ""} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading}
      {...rest}
    >
      {loading ? <span className="btn-spinner" aria-hidden="true" /> : icon}
      <span>{children}</span>
    </button>
  );
}
