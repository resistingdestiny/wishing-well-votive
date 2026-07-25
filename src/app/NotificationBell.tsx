"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount, useConnect } from "wagmi";
import { PushToggle } from "@/app/PushToggle";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";

interface Notif {
  id: string;
  kind: string;
  title: string;
  body: string;
  cell: string | null;
  capabilityId: string | null;
  read: boolean;
  createdAt: string;
}

async function fetchInbox(subscriber: string): Promise<{ notifications: Notif[]; unread: number }> {
  const res = await fetch(`/api/notifications?subscriber=${subscriber}`);
  if (!res.ok) throw new Error(`inbox ${res.status}`);
  return res.json();
}

export function NotificationBell() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const subscriber = address?.toLowerCase();

  const { data, isError, isPending } = useQuery({
    queryKey: ["inbox", subscriber],
    queryFn: () => fetchInbox(subscriber!),
    enabled: !!subscriber,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  const unread = data?.unread ?? 0;
  const items = data?.notifications ?? [];

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

  async function markAll() {
    if (!subscriber) return;
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscriber, all: true }),
    });
    qc.invalidateQueries({ queryKey: ["inbox", subscriber] });
  }

  return (
    <div className="bell" data-testid="notification-bell" ref={ref}>
      <button
        className="bellButton"
        aria-label="Notifications"
        onClick={() => setOpen((o) => !o)}
      >
        <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 ? <span className="bellBadge">{unread > 9 ? "9+" : unread}</span> : null}
      </button>

      {open ? (
        <div className="bellDropdown">
          {!isConnected ? (
            <div className="stack" style={{ gap: "0.5rem" }}>
              <p className="muted" style={{ margin: 0 }}>
                Connect your wallet to see when a model passes the check your wish is
                waiting on.
              </p>
              {connectors.map((c) => (
                <button key={c.uid} className="secondary" onClick={() => connect({ connector: c })}>
                  Connect {c.name === "Injected" ? "browser wallet" : c.name}
                </button>
              ))}
            </div>
          ) : isPending ? (
            <p className="muted" style={{ margin: 0 }}>Loading…</p>
          ) : isError ? (
            <p className="error" style={{ margin: 0 }}>Couldn&rsquo;t load notifications. Retrying.</p>
          ) : items.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No notifications yet. When a model unlocks a wish you own or watch, it
              lands here.
            </p>
          ) : (
            <div className="stack" style={{ gap: "0.4rem" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong style={{ fontSize: "0.85rem" }}>Notifications</strong>
                {unread > 0 ? (
                  <button className="linkish" onClick={markAll}>
                    Mark all read
                  </button>
                ) : null}
              </div>
              <ul className="bellList">
                {items.map((n) => {
                  const inner = (
                    <>
                      <div className="bellTitle">
                        {!n.read ? <span className="bellDot" aria-hidden /> : null}
                        {n.title}
                      </div>
                      <div className="muted bellBody">{n.body}</div>
                    </>
                  );
                  return (
                    <li key={n.id} className={n.read ? "" : "bellUnread"}>
                      {n.cell ? (
                        <Link href={`/wish/${n.cell}`} onClick={() => setOpen(false)}>
                          {inner}
                        </Link>
                      ) : (
                        inner
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {isConnected ? (
            <div
              className="row"
              style={{
                justifyContent: "flex-end",
                marginTop: "0.5rem",
                paddingTop: "0.5rem",
                borderTop: "1px solid var(--border)",
              }}
            >
              <PushToggle />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
