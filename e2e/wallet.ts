import type { Page } from "@playwright/test";

/**
 * A real wallet, injected the way MetaMask injects itself.
 *
 * **Why not the MetaMask extension.** Driving the extension needs a headful
 * browser, a profile, and a scripted click-through of its onboarding and of every
 * confirmation dialog. That machinery tests MetaMask's UI far more than it tests
 * ours, and it is the part of a suite that breaks on somebody else's release.
 *
 * What actually matters is that the app talks to a wallet over EIP-1193 and gets
 * real transactions onto a real chain. So this injects a provider at
 * `window.ethereum` — which is exactly the interface MetaMask provides and
 * exactly what wagmi's `injected()` connector looks for — backed by a genuine
 * private key signing genuine transactions against Base Sepolia. Every wagmi
 * hook, every `writeContract`, and every receipt wait in the app runs unchanged.
 *
 * The one thing this does not exercise is a human clicking "Confirm". That is a
 * deliberate trade, and it is stated here rather than left to be discovered.
 */
export interface InjectedWalletOptions {
  privateKey: `0x${string}`;
  address: `0x${string}`;
  rpcUrl: string;
  chainId: number;
}

export async function injectWallet(page: Page, options: InjectedWalletOptions): Promise<void> {
  await page.addInitScript(
    ({ privateKey, address, rpcUrl, chainId }: InjectedWalletOptions) => {
      const hexChainId = `0x${chainId.toString(16)}`;
      let nextId = 1;

      const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        });
        const body = await response.json();
        if (body.error) throw Object.assign(new Error(body.error.message), body.error);
        return body.result;
      };

      // Signing happens in the page, so the key has to be reachable from here.
      // It is a throwaway testnet key and this only ever runs under Playwright.
      (window as unknown as Record<string, unknown>).__TEST_PK__ = privateKey;

      const provider = {
        isMetaMask: true,
        // wagmi checks these before deciding it has found a wallet.
        _metamask: { isUnlocked: async () => true },

        async request({ method, params = [] }: { method: string; params?: unknown[] }) {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [address];
            case "eth_chainId":
              return hexChainId;
            case "net_version":
              return String(chainId);
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":
              return null;
            case "eth_sendTransaction": {
              // Signed here rather than forwarded, because a public node holds no
              // keys. Everything else is proxied straight through.
              const tx = (params[0] ?? {}) as Record<string, string>;
              const signed = await (
                window as unknown as {
                  __signTx__: (tx: Record<string, string>) => Promise<`0x${string}`>;
                }
              ).__signTx__(tx);
              return rpc("eth_sendRawTransaction", [signed]);
            }
            default:
              return rpc(method, params);
          }
        },

        on() {
          /* no events are emitted: the account and chain never change mid-test */
        },
        removeListener() {},
      };

      Object.defineProperty(window, "ethereum", {
        value: provider,
        writable: false,
        configurable: true,
      });

      // Announce over EIP-6963 as well.
      //
      // wagmi's `injected()` connector discovers wallets by listening for this
      // event and only falls back to `window.ethereum` when nothing answers. A
      // provider that sets the global and stays quiet is therefore invisible to a
      // modern connect button — which is exactly how the first version of this
      // fixture failed, with a page that looked right and a wallet nothing could
      // see.
      const info = {
        uuid: "11111111-2222-3333-4444-555555555555",
        name: "Votive Test Wallet",
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
        rdns: "io.votive.test",
      };
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: Object.freeze({ info, provider }),
          }),
        );
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    options,
  );

  // The signer is added separately so viem can be bundled into the page context
  // rather than hand-rolling transaction serialisation and secp256k1 in the
  // init script — the one place where getting it subtly wrong would be silent.
  await page.addInitScript(`
    window.__signTx__ = async (tx) => {
      const { privateKeyToAccount } = await import("https://esm.sh/viem@2/accounts");
      const account = privateKeyToAccount(window.__TEST_PK__);
      // Never go backwards. Public testnet RPCs are load-balanced, so a node
      // asked for "pending" moments after a send can still answer with the
      // count from before it — and signing that nonce again fails with
      // "nonce too low", which reads like a broken button rather than a lagging
      // node. Any flow that sends twice in a row (approve, then swap) hits this.
      const fetched = Number(BigInt(await window.ethereum.request({
        method: "eth_getTransactionCount", params: [account.address, "pending"],
      })));
      const floor = window.__NEXT_NONCE__ ?? 0;
      const nonce = Math.max(fetched, floor);
      window.__NEXT_NONCE__ = nonce + 1;
      const gas = tx.gas ?? await window.ethereum.request({
        method: "eth_estimateGas", params: [tx],
      });
      const fees = await window.ethereum.request({ method: "eth_gasPrice", params: [] });
      return account.signTransaction({
        to: tx.to ?? null,
        data: tx.data ?? "0x",
        value: BigInt(tx.value ?? "0x0"),
        gas: BigInt(gas),
        maxFeePerGas: BigInt(fees) * 2n,
        maxPriorityFeePerGas: BigInt(fees),
        nonce: Number(BigInt(nonce)),
        chainId: ${options.chainId},
        type: "eip1559",
      });
    };
  `);
}
