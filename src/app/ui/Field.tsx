import type { ReactNode } from "react";

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className={`field${error ? " hasError" : ""}`}>
      <span className="label">{label}</span>
      {children}
      {error ? (
        <span className="fieldError">{error}</span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </label>
  );
}
