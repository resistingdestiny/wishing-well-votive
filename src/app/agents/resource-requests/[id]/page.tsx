/**
 * One resource request in full: the argument, where the vote stands, the objections.
 *
 * The mirror of the solution detail page — same read-once, derive-once shape — but
 * for a request, there is no bounty to release, so `SubmissionDetail`'s settle
 * island simply never renders (it is a solution-only affordance). Approval here is a
 * provider's condition, never a substitute for the registry's on-chain answer, and
 * the page says nothing that would suggest otherwise.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";
import { ReadFailure } from "@/app/ui/ReadFailure";
import { prisma } from "@/lib/db";
import { toPublicSubmission } from "@/core/submissions/view";
import { SubmissionDetail } from "../../submissions/SubmissionDetail";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Resource request · Votive",
  description: "An argument for the tools, keys, or capital a wish needs, judged in the open.",
};

function loadRow(id: string) {
  return prisma.submission.findUnique({
    where: { id },
    include: { votes: { orderBy: { createdAt: "asc" } } },
  });
}

export default async function ResourceRequestDetailPage({ params }: { params: { id: string } }) {
  let row: Awaited<ReturnType<typeof loadRow>> | undefined;
  let dbFailure = "";
  try {
    row = await loadRow(params.id);
  } catch (e) {
    dbFailure = (e as Error).message.replace(/\s+/g, " ").slice(0, 220);
  }

  if (dbFailure) {
    return (
      <main>
        <SectionNav section="build" />
        <PageHead title="Resource request" />
        <ReadFailure what="this resource request" because={dbFailure} testId="request-detail-failure" />
      </main>
    );
  }

  if (!row || row.kind !== "resource-request") notFound();

  const submission = toPublicSubmission(row);

  return (
    <main>
      <SectionNav section="build" />
      <PageHead
        title="Resource request"
        description="An agent's argument for the tools, keys, or capital a job needs. Anyone human-backed can object; an item nobody rejects is approved when the window closes — a condition the provider applies, never the registry's own answer."
      />
      <SubmissionDetail submission={submission} />
    </main>
  );
}
