"use client";

import { useState } from "react";
import styles from "./landing.module.css";

export function Estimator({ startFund = 2.4 }: { startFund?: number }) {
  const [m, setM] = useState(startFund);
  const [r, setR] = useState(1.5);
  const f = (n: number) => {
    let s = n.toFixed(3);
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  };
  const wait = m * 0.02;
  const kept = r * 0.92;

  return (
    <div className={styles.estCard} data-reveal="80">
      <div className={styles.estHead}>
        <span className={styles.estLabel}>Estimate a wish</span>
        <button
          type="button"
          className={styles.estPreset}
          onClick={() => {
            setM(5);
            setR(1.5);
          }}
        >
          ◆ the bug-hunt wish
        </button>
      </div>

      <div className={styles.estSliderRow}>
        <span className={styles.estSliderLabel}>fund</span>
        <input
          type="range"
          min={0.1}
          max={20}
          step={0.1}
          value={m}
          onChange={(e) => setM(parseFloat(e.target.value))}
          aria-label="Fund amount in ETH"
        />
        <span className={styles.estSliderVal}>
          {f(m)} <span className={styles.estValueSmall}>eth</span>
        </span>
      </div>
      <div className={styles.estSliderRow}>
        <span className={styles.estSliderLabel}>might earn / yr</span>
        <input
          type="range"
          min={0.1}
          max={10}
          step={0.1}
          value={r}
          onChange={(e) => setR(parseFloat(e.target.value))}
          aria-label="Expected yearly earnings if granted, in ETH"
        />
        <span className={styles.estSliderVal}>
          {f(r)} <span className={styles.estValueSmall}>eth</span>
        </span>
      </div>

      <div className={styles.estRows}>
        <div className={styles.estGroup}>the wait</div>
        <div className={styles.estRow}>
          <span className={styles.estRowLabel}>parked</span>
          <span>{f(m)} eth</span>
        </div>
        <div className={styles.estRow}>
          <span className={styles.estRowLabel}>cost / year&nbsp;&nbsp;(2%)</span>
          <span>{f(wait)} eth</span>
        </div>
        <div className={styles.estGroup}>if granted</div>
        <div className={styles.estRow}>
          <span className={styles.estRowLabel}>earns / year</span>
          <span>{f(r)} eth</span>
        </div>
        <div className={styles.estRow}>
          <span className={styles.estRowLabel}>after the 8%</span>
          <span className={styles.estRowValGood}>{f(kept)} eth / yr</span>
        </div>
      </div>
      <p className={styles.estNote}>
        The 2% comes out of the cell each year, so you never have to top up to
        cover it. The 8% is taken only if your wish is granted, and only out of
        what it earns. The returns here are illustrative: a wish pays out what
        it earns, never a promised rate.
      </p>
    </div>
  );
}
