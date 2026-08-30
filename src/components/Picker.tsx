import { useEffect, useMemo, useRef, useState } from "react";
import "./Picker.css";

export interface PickerItem {
  id: string;
  name: string;
  /** Category names this item belongs to — used for disambiguation (spec §6.5) */
  categories?: string[];
  meta?: string; // e.g. "₹42/kg · Main Raw Material"
}

interface PickerProps {
  label: string;
  placeholder?: string;
  items: PickerItem[];
  value: PickerItem | null;
  onSelect: (item: PickerItem) => void;
  onCreateNew?: (query: string) => void;
  createNewLabel?: string;
}

/**
 * The universal item/category picker described in spec §6:
 *  1. Search-first — works before any category is picked.
 *  2. Typing filters across the *entire* relevant universe.
 *  3. A unique category match can auto-resolve silently (handled by caller
 *     via onSelect — this component only surfaces the match).
 *  4. Multiple valid categories are shown as a small tag per row so the
 *     user disambiguates in the same list, not a second screen.
 *  5. "Add new" is always the last row, never a dead end (spec §7.2).
 *
 * One component, two shells: a full-height sheet from the bottom on touch/
 * narrow viewports (keyboard opens straight into search), an anchored
 * popover on desktop where a mouse and a big screen make a modal unnecessary.
 */
export function Picker({ label, placeholder = "Search…", items, value, onSelect, onCreateNew, createNewLabel }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 860px)").matches);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 860px)");
    const handler = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
      if (!isDesktop) document.body.style.overflow = "hidden";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open, isDesktop]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }, [items, query]);

  const close = () => setOpen(false);
  const pick = (item: PickerItem) => { onSelect(item); close(); };

  return (
    <div className="field picker-anchor">
      <span className="field-label">{label}</span>
      <button type="button" className="picker-trigger" onClick={() => setOpen(true)}>
        <span className={value ? "picker-trigger-value" : "picker-trigger-placeholder"}>
          {value ? value.name : placeholder}
        </span>
        <span className="picker-chevron" aria-hidden="true">⌄</span>
      </button>

      {open && (
        <>
          <div className="picker-scrim" onClick={close} />
          <div className={isDesktop ? "picker-popover" : "picker-sheet"} role="dialog" aria-label={label}>
            {!isDesktop && <div className="picker-grabber" />}
            <div className="picker-search-row">
              <input
                ref={inputRef}
                className="picker-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}`}
                inputMode="search"
              />
              <button type="button" className="picker-cancel" onClick={close}>Cancel</button>
            </div>

            <div className="picker-list">
              {filtered.length === 0 && (
                <p className="picker-empty">No matches for "{query}".</p>
              )}
              {filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="picker-row"
                  onClick={() => pick(item)}
                >
                  <span className="picker-row-name">{item.name}</span>
                  <span className="picker-row-meta">
                    {item.meta}
                    {item.categories && item.categories.length > 1 && (
                      <span className="picker-row-tags">
                        {item.categories.map((c) => <em key={c} className="picker-tag">{c}</em>)}
                      </span>
                    )}
                  </span>
                </button>
              ))}
              {onCreateNew && (
                <button
                  type="button"
                  className="picker-row picker-row-create"
                  onClick={() => { onCreateNew(query); close(); }}
                >
                  + {createNewLabel || `Add "${query || "new"}"`}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
