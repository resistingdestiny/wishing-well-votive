"use client";

/**
 * Tell the server a transaction happened.
 *
 * Fire-and-forget by design. It is called after the write has already landed, so
 * a failure here costs a line on a demo page and must never be allowed to look
 * like a failure of the thing the user actually did.
 */
export type TxKind =
  | "wish-opened"
  | "wish-topped-up"
  | "wish-redirected"
  | "wish-heartbeat"
  | "wish-escheated"
  | "share-claimed"
  | "deferred-claimed"
  | "human-attested"
  | "faucet-drawn"
  | "commons-drawn"
  | "resource-granted"
  | "conduct-reported"
  | "aqua-position-opened"
  | "aqua-position-closed"
  | "aqua-position-filled"
  | "capability-attested"
  | "condition-attested"
  | "attempt-begun"
  | "wish-fulfilled"
  | "bounty-posted"
  | "milestone-released"
  | "earnings-withdrawn";

export function noteTx(
  kind: TxKind,
  txHash: string,
  options: { detail?: string; contract?: string; subject?: string; chain?: string } = {},
): void {
  void fetch("/api/tx", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind,
      chain: options.chain ?? "base-sepolia",
      txHash,
      detail: options.detail,
      contract: options.contract,
      subject: options.subject,
    }),
  }).catch(() => {
    // See above: never surfaced.
  });
}
