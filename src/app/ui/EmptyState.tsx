import type { ReactNode } from "react";

export function EmptyState({
  title,
  body,
  action,
  testId,
}: {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="panel emptyState" data-testid={testId}>
      <h3>{title}</h3>
      {body ? (
        <p className="muted" style={{ margin: 0, maxWidth: "52ch" }}>
          {body}
        </p>
      ) : null}
      {action ? <div className="row" style={{ justifyContent: "center" }}>{action}</div> : null}
    </div>
  );
}
