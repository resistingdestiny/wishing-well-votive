"use client";

/**
 * The one client-side signing helper the vote and report panels share.
 *
 * It is the same shape `RegisterAgentForm` uses inline: ask the server for the
 * exact words, sign those words, hand back the pair. The message is always the
 * server's and never composed here — if the client built the text it signed, a
 * caller could sign one sentence and present it where another was required, with a
 * valid nonce and the right address on both. Kept as a hook so both panels get that
 * property for free rather than each re-implementing it and one of them drifting.
 */
import { useAccount, useSignMessage } from "wagmi";

export function useSignChallenge() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();

  return async function signChallenge(
    purpose: string,
    extra: Record<string, string> = {},
  ): Promise<{ nonce: string; signature: string }> {
    const wallet = address?.toLowerCase() ?? "";
    if (!wallet) throw new Error("connect a wallet first");
    const res = await fetch("/api/agents/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet, purpose, ...extra }),
    });
    const body = (await res.json()) as { error?: string; nonce?: string; message?: string };
    if (!res.ok || !body.nonce || !body.message) {
      throw new Error(body.error ?? "could not start the signature");
    }
    const signature = await signMessageAsync({ message: body.message });
    return { nonce: body.nonce, signature };
  };
}
