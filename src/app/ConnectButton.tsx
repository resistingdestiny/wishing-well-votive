"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { shortAddr } from "@/lib/format";

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const connected = mounted && isConnected && !!address;

  return (
    <div className="bell" data-testid="connect-button" ref={ref}>
      <button
        className="pill"
        onClick={() => setOpen((o) => !o)}
        aria-label={connected ? `Wallet ${shortAddr(address!)}` : "Connect wallet"}
      >
        {connected ? (
          <>
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: "var(--good)",
                display: "inline-block",
              }}
            />
            <span className="mono">{shortAddr(address!)}</span>
          </>
        ) : (
          "Connect"
        )}
      </button>

      {open ? (
        <div className="bellDropdown">
          {connected ? (
            <div className="stack" style={{ gap: "0.5rem" }}>
              <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
                Connected as
              </p>
              <p className="mono" style={{ margin: 0, wordBreak: "break-all", fontSize: "0.8rem" }}>
                {address}
              </p>
              <button
                className="secondary"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="stack" style={{ gap: "0.5rem" }}>
              <p className="muted" style={{ margin: 0 }}>
                Connect a wallet (Base Sepolia) to make, fund, and track wishes.
              </p>
              {connectors.map((c) => (
                <button
                  key={c.uid}
                  className="secondary"
                  onClick={() => {
                    connect({ connector: c });
                    setOpen(false);
                  }}
                >
                  Connect {c.name === "Injected" ? "browser wallet" : c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
