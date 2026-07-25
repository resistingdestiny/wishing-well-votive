import type { Metadata } from "next";
import Link from "next/link";
import { formatEther } from "viem";
import { resolveClaimToken } from "@/lib/claims";
import { cellNumber } from "@/lib/chain";
import { formatUsdc } from "@/core/providers/types";
import ClaimPortal, { type Invitation } from "./ClaimPortal";
import { PageHead } from "@/app/ui/PageHead";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Claim your share · Votive",
  description: "Claim your share of a resolved wish. Prove who you are; choose a bank account or a wallet.",
};

const USD_PER_ETH = 2000n;

function usdLabel(slice: bigint, native: boolean): string {
  return native ? formatUsdc((slice * USD_PER_ETH * 1_000_000n) / 10n ** 18n) : formatUsdc(slice);
}

export default async function ClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const target = await resolveClaimToken(token);

  if (!target) {
    return (
      <main>
        <div className="panel stack">
          <PageHead
            title="No live claim for this invitation"
            description="This invitation link doesn&rsquo;t match a wish that&rsquo;s currently open for claims. It may have been claimed already, or its claim window may have closed."
          />
          <Link href="/explore" className="pill pillPrimary">
            Explore the well
          </Link>
        </div>
      </main>
    );
  }

  const wishNumber = await cellNumber(target.cell).catch(() => 0);
  const invitation: Invitation = {
    token,
    cell: target.cell,
    wishNumber,
    fullName: target.fullName,
    relationship: target.relationship,
    assetSymbol: target.assetIsNative ? "ETH" : target.view.assetSymbol,
    assetIsNative: target.assetIsNative,
    sliceNativeLabel: target.assetIsNative ? `${formatEther(target.slice)} ETH` : formatUsdc(target.slice),
    sliceUsdLabel: usdLabel(target.slice, target.assetIsNative),
    claimDeadline: target.view.claimDeadline.toString(),
    alreadyClaimed: target.view.claimClaimed >= target.view.claimTotal || target.slice === 0n,
  };

  return (
    <main>
      <ClaimPortal invitation={invitation} />
    </main>
  );
}
