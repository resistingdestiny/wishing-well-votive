import {
  BaseError,
  ContractFunctionRevertedError,
  ResourceUnavailableRpcError,
  UserRejectedRequestError,
} from "viem";

/**
 * Turn a wallet or RPC failure into something the person can act on.
 *
 * Every panel here used to do `message.slice(0, 300)`. viem's full message for a
 * refused send is around 545 characters and ends with the only line that says
 * what happened:
 *
 *   Details: Request of type 'eth_sendTransaction' already pending for origin
 *   http://127.0.0.1:3100. Please wait.
 *
 * The slice lands at roughly `function: f` — cutting that line off entirely. What
 * survives is a wall of request arguments and `chain: undefined (id: 84532)`,
 * which reads like a chain misconfiguration and is not one: wagmi passes
 * `chain: { id }` with no `name`, so viem prints `undefined` for the name on
 * *every* write, including the ones that succeed.
 *
 * That cost real debugging time on a faucet that was working perfectly. The
 * wallet simply had an unactioned popup from a previous click, and said so in
 * the sentence we were cutting off.
 */
export function walletError(e: unknown): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) {
      return "You rejected the request in your wallet.";
    }
    if (e.walk((x) => x instanceof ResourceUnavailableRpcError)) {
      return (
        "Your wallet already has a request waiting. Open it, confirm or dismiss " +
        "the one that is pending, then try again."
      );
    }
    // A contract that reverted with a named error is telling you something
    // specific; keep the name rather than burying it in the request dump.
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as
      | ContractFunctionRevertedError
      | null;
    if (reverted?.data?.errorName) {
      return `The contract refused this: ${reverted.data.errorName}.`;
    }
    // `shortMessage` is the one-line summary; `details` is where the wallet's own
    // words end up. Neither is the request dump.
    return [e.shortMessage, e.details].filter(Boolean).join(" ").slice(0, 400);
  }
  return (e as Error)?.message?.slice(0, 300) ?? "Something went wrong.";
}
