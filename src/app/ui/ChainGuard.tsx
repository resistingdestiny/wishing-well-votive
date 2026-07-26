"use client";

import type { ReactNode } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";

/**
 * Refuse to offer a transaction the connected wallet cannot send.
 *
 * When a wallet sits on a different network than the contract, asking it to
 * write does not fail in a way anybody can act on. It comes back as
 * "Requested resource not available" with `chain: undefined` attached — a
 * JSON-RPC resource-unavailable code, surfaced verbatim, describing nothing the
 * person did wrong. The button looks broken. The wallet is simply elsewhere.
 *
 * This app makes that easy to hit on purpose: the payments rail is on Hedera and
 * everything else is on Base Sepolia, so a visitor is *invited* to switch
 * networks halfway through the demo and then finds the faucet, the commons and
 * the trade panel all failing with a message that mentions none of it.
 *
 * The wish page's owner controls and the create flow already guarded for this.
 * The panels added since did not, which is the whole reason this is one shared
 * component rather than a fifth copy of the same six lines.
 */
export function ChainGuard({
  chainId,
  chainName,
  children,
  /** What the person is being stopped from doing, e.g. "draw from the faucet". */
  action,
}: {
  chainId: number;
  chainName: string;
  children: ReactNode;
  action?: string;
}) {
  const { isConnected } = useAccount();
  const connectedTo = useChainId();
  const { switchChain, isPending } = useSwitchChain();

  // Only a *connected* wallet can be on the wrong network. Disconnected is not
  // wrong, it is just disconnected, and the panels say so themselves.
  const wrong = isConnected && connectedTo !== undefined && connectedTo !== chainId;
  if (!wrong) return <>{children}</>;

  return (
    <div className="row" style={{ gap: "0.6rem", alignItems: "center" }} data-testid="wrong-chain">
      <span className="muted">
        Your wallet is on another network, so it cannot{" "}
        {action ?? "send this transaction"}.
      </span>
      <button
        className="secondary"
        onClick={() => switchChain({ chainId })}
        disabled={isPending}
        data-testid="switch-chain"
      >
        {isPending ? "Switching…" : `Switch to ${chainName}`}
      </button>
    </div>
  );
}
