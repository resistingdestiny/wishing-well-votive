import type { Metadata } from "next";
import FundFlow from "./FundFlow";
import { PageHead } from "@/app/ui/PageHead";

export const metadata: Metadata = {
  title: "Fund a wish · Votive",
  description: "Fund a wish with ordinary money: bank transfer or card. No wallet, no seed phrase.",
};

export default function FundPage() {
  return (
    <main>
      <div className="stack">
        <PageHead
          title="Fund with money"
          description="Bank transfer or card. The money lands as USDC in its own segregated cell and your wish is created for you. No wallet, no seed phrase."
        />
        <FundFlow />
      </div>
    </main>
  );
}
