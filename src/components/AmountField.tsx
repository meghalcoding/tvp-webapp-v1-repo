import { useId } from "react";
import "./Fields.css";

interface AmountFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  helperText?: string;
  errorText?: string;
  required?: boolean;
  autoFocus?: boolean;
}

/**
 * Every rupee amount in the app goes through this component so behavior
 * (numeric keypad, tabular figures, 2-decimal formatting on blur) is
 * identical on the sales, purchase, and expense forms.
 */
export function AmountField({
  label, value, onChange, placeholder = "0.00", helperText, errorText, required, autoFocus,
}: AmountFieldProps) {
  const id = useId();
  const invalid = !!errorText;

  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}{required && <span className="field-required"> *</span>}
      </label>
      <div className={`field-amount-shell ${invalid ? "field-invalid" : ""}`}>
        <span className="field-amount-prefix">₹</span>
        <input
          id={id}
          className="field-amount-input tnum"
          inputMode="decimal"
          pattern="[0-9]*\.?[0-9]*"
          placeholder={placeholder}
          value={value}
          autoFocus={autoFocus}
          aria-invalid={invalid}
          aria-describedby={helperText || errorText ? `${id}-help` : undefined}
          onChange={(e) => {
            const next = e.target.value.replace(/[^0-9.]/g, "");
            onChange(next);
          }}
        />
      </div>
      {(helperText || errorText) && (
        <p id={`${id}-help`} className={`field-help ${invalid ? "field-help-error" : ""}`}>
          {errorText || helperText}
        </p>
      )}
    </div>
  );
}
