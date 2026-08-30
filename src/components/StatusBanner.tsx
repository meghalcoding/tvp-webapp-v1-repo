import "./StatusBanner.css";

type Tone = "success" | "danger" | "warning" | "info";

export function StatusBanner({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <div className={`banner banner-${tone}`}>{children}</div>;
}
