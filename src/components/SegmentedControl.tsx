import "./SegmentedControl.css";

interface Option { value: string; label: string; }

export function SegmentedControl({
  label, options, value, onChange,
}: { label: string; options: Option[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            className={`segmented-item ${value === opt.value ? "segmented-item-active" : ""}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
