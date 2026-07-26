/**
 * What a page shows when it could not read something.
 *
 * The alternative — and the thing this exists to stop — is rendering a zero, an
 * empty list, or a "no results" heading over a read that never returned. Both
 * `toolbelt/page.tsx` and `agents/page.tsx` swallow their errors into an empty
 * `catch {}` today and then state, confidently, that there is nothing there.
 * `CommonsDrawPanel` gets it right and says why: rendering zeros "would read as
 * 'you may draw nothing', which is a statement about the operator rather than
 * about the node."
 *
 * So this says three things and no more: what we were trying to read, that we
 * could not, and the reason we were given. It never guesses, never retries
 * silently, and never softens the failure into an empty state.
 */
export function ReadFailure({
  what,
  because,
  testId,
}: {
  what: string;
  because: string;
  testId?: string;
}) {
  return (
    <div className="panel" data-testid={testId ?? "read-failure"}>
      <h3 style={{ margin: "0 0 0.35rem" }}>Could not read {what}</h3>
      <p className="muted" style={{ margin: "0 0 0.5rem", maxWidth: "60ch" }}>
        Nothing is shown here because nothing was read — not because there is
        nothing to show. Treat this section as unknown.
      </p>
      <p className="mono error" style={{ margin: 0, fontSize: "0.8rem", wordBreak: "break-word" }}>
        {because}
      </p>
    </div>
  );
}
