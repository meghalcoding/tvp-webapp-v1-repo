import "./Stepper.css";

interface StepperProps {
  label: string;
  value: number;
  unit: string;
  step?: number;
  min?: number;
  onChange: (value: number) => void;
}

/**
 * "Direct manipulation, minimal typing" — for purchase/expense line-item
 * quantities. Tap +/- for the common case (whole units); tap the number
 * itself to type an exact value (e.g. 2.5 kg) when the stepper is too coarse.
 */
export function Stepper({ label, value, unit, step = 1, min = 0, onChange }: StepperProps) {
  const clamp = (n: number) => Math.max(min, Math.round(n * 1000) / 1000);

  return (
    <div className="stepper-row">
      <span className="stepper-label">{label}</span>
      <div className="stepper-control">
        <button
          type="button"
          className="stepper-btn"
          aria-label={`Decrease ${label}`}
          onClick={() => onChange(clamp(value - step))}
          disabled={value <= min}
        >
          −
        </button>
        <input
          className="stepper-value tnum"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^0-9.]/g, ""));
            onChange(Number.isNaN(n) ? min : clamp(n));
          }}
          aria-label={label}
        />
        <span className="stepper-unit">{unit}</span>
        <button
          type="button"
          className="stepper-btn"
          aria-label={`Increase ${label}`}
          onClick={() => onChange(clamp(value + step))}
        >
          +
        </button>
      </div>
    </div>
  );
}
