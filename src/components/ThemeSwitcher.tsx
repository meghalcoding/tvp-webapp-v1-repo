import "./ThemeSwitcher.css";

const THEMES = [
  { key: "vadapav", label: "Vadapav", swatch: "#8A3128" },
  { key: "midnight", label: "Midnight Gold", swatch: "#17130E" },
  { key: "neutral", label: "Neutral", swatch: "#2A2723" },
  { key: "daylight", label: "Daylight", swatch: "#96331F" },
];

export function ThemeSwitcher({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="theme-switcher">
      {THEMES.map((t) => (
        <button
          key={t.key}
          className={`theme-swatch ${value === t.key ? "theme-swatch-active" : ""}`}
          style={{ background: t.swatch }}
          onClick={() => onChange(t.key)}
          aria-label={t.label}
          title={t.label}
        />
      ))}
    </div>
  );
}
