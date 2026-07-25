"use client";

export function AskTrigger({ pill = false }: { pill?: boolean }) {
  return (
    <button
      className={pill ? "searchPill" : "cmdk"}
      onClick={() => window.dispatchEvent(new Event("ask:open"))}
      data-testid="ask-trigger"
    >
      {pill ? (
        <>
          Ask <kbd style={{ font: "inherit", opacity: 0.7 }}>⌘K</kbd>
        </>
      ) : (
        <>
          Ask the well anything… <kbd>⌘K</kbd>
        </>
      )}
    </button>
  );
}
