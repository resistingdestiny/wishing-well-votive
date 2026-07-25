import Link from "next/link";
import { PageHead } from "@/app/ui/PageHead";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Not available in your region · Votive",
};

export default async function BlockedPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string }>;
}) {
  const { country } = await searchParams;
  return (
    <main>
      <PageHead
        title="Not available in your region"
        description={`Votive is geofenced here: funding and claiming a wish ${
          country ? `from ${country} ` : ""
        }isn't available in your jurisdiction, but the read-only links below still work.`}
      />
      <div className="panel">
        <p className="muted" style={{ margin: 0 }}>
          This is a testnet demonstration; the geofence blocks sanctioned and
          unsupported corridors before any value moves. The read-only surfaces stay
          open. You can still watch the board and read every wish.
        </p>
      </div>
      <div className="row" style={{ marginTop: "1.5rem" }}>
        <Link href="/board" className="pill pillPrimary">
          Watch the board
        </Link>
        <Link href="/explore" className="pill">
          Read every wish
        </Link>
        <Link href="/" className="pill">
          Back to Votive
        </Link>
      </div>
    </main>
  );
}
