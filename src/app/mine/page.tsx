import { listAllCells } from "@/lib/chain";
import { prisma } from "@/lib/db";
import { YourWishes, type SerializedCell } from "./YourWishes";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your wishes · Votive",
  description: "The wishes you deposit to, guard, or benefit from: parked funds, fees, and clocks.",
};

export default async function MinePage() {
  let cells: SerializedCell[] = [];
  let chainError: string | undefined;
  try {
    const raw = await listAllCells();
    const stories = await prisma.story
      .findMany({ where: { cell: { not: null } } })
      .catch(() => []);
    const byCell = new Map(
      stories.map((s) => [
        s.cell!.toLowerCase(),
        (s.parsed as { capability?: { summary?: string } })?.capability?.summary ?? "",
      ]),
    );

    cells = raw.map((c) => ({
      address: c.address,
      state: c.state,
      stateName: c.stateName,
      kindName: c.kindName,
      wisher: c.wisher,
      guardian: c.guardian,
      beneficiary: c.beneficiary,
      capabilityId: c.capabilityId,
      principalWei: c.principal.toString(),
      balanceWei: c.balance.toString(),
      parkedWei: c.parked.toString(),
      feesWei: (c.feesAccrued + c.pendingFees).toString(),
      assetIsNative: c.assetIsNative,
      assetDecimals: c.assetDecimals,
      assetSymbol: c.assetSymbol,
      positioned: c.positioned,
      payee: c.payee,
      lastWisherActivity: Number(c.lastWisherActivity),
      amendAfter: Number(c.timeouts.amendAfter),
      escheatAfter: Number(c.timeouts.escheatAfter),
      summary: byCell.get(c.address.toLowerCase()) ?? "",
    }));
  } catch (e) {
    chainError = (e as Error).message;
  }

  return (
    <main>
      <SectionNav section="wishes" />
      <PageHead
        title="Your wishes"
        description="Every wish your wallet deposits, guards or benefits from, plus anything funded from this browser without a wallet."
      />
      {chainError ? (
        <p className="error">Chain unreachable: {chainError}</p>
      ) : (
        <YourWishes cells={cells} />
      )}
    </main>
  );
}
