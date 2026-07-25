"use client";

import { FiatFundForm } from "./FiatFundForm";

export default function FundFlow() {
  return (
    <div className="stack">
      <FiatFundForm />
      <p className="faint">
        Blocked jurisdictions are screened at this step (geofence + sanctions). Provider contracts &amp; licences
        needed before real money flows are listed in the project&apos;s FINAL.md.
      </p>
    </div>
  );
}
