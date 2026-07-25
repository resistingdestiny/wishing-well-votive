"use client";

import { useEffect, useRef } from "react";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "spline-viewer": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { url?: string; background?: string },
        HTMLElement
      >;
    }
  }
}

let splineLoader: Promise<void> | null = null;
function loadSpline(): Promise<void> {
  if (!splineLoader) {
    splineLoader = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/vendor/spline-viewer.js";
      s.type = "module";
      s.onload = () => resolve();
      s.onerror = () => {
        splineLoader = null;
        reject(new Error("spline-viewer failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return splineLoader;
}

export function LiquidCube({ className }: { className?: string }) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const clear = () => {
      const sv = ref.current;
      if (!sv) return;
      try {
        const anySv = sv as unknown as {
          _spline?: { setBackgroundColor?: (c: string) => void };
          application?: { setBackgroundColor?: (c: string) => void };
          shadowRoot:
            | (ShadowRoot & { _spline?: { setBackgroundColor?: (c: string) => void } })
            | null;
        };
        const app = anySv._spline ?? anySv.application ?? anySv.shadowRoot?._spline;
        app?.setBackgroundColor?.("transparent");
      } catch {

      }
      try {
        const sr = sv.shadowRoot;
        const logo = sr?.querySelector<HTMLElement>('#logo, a[href*="spline"]');
        if (logo) logo.style.display = "none";
      } catch {

      }
    };

    loadSpline()
      .then(() => {
        if (!alive) return;
        ref.current?.addEventListener("load", clear);
        [500, 1400, 2800, 4500].forEach((t) => timers.push(setTimeout(clear, t)));
      })
      .catch(() => {

      });

    return () => {
      alive = false;
      timers.forEach(clearTimeout);
      ref.current?.removeEventListener("load", clear);
    };
  }, []);

  return (
    <spline-viewer
      ref={ref as React.RefObject<HTMLElement>}
      className={className}
      background="transparent"
      url="/vendor/scene.splinecode"
    />
  );
}
