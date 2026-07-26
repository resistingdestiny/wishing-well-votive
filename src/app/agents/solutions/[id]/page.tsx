/**
 * One wish solution in full: the claim, where the vote stands, the objections, and
 * the actions still open on it.
 *
 * The row is read straight from the database and its status derived once by
 * `toPublicSubmission` — the page renders facts and the client islands inside
 * `SubmissionDetail` decide for themselves what to offer. A row that is not a
 * solution 404s here rather than rendering under the wrong heading; a read that
 * fails says so through `ReadFailure` instead of pretending the submission is gone.
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
  title: "Solution · Votive",
  description: "A claim that a wish's bounty has been earned, judged in the open.",
};

function loadRow(id: string) {
  return prisma.submission.findUnique({
    where: { id },
    include: { votes: { orderBy: { createdAt: "asc" } } },
  });
}

export default async function SolutionDetailPage({ params }: { params: { id: string } }) {
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
        <PageHead title="Solution" />
        <ReadFailure what="this solution" because={dbFailure} testId="solution-detail-failure" />
      </main>
    );
  }

  if (!row || row.kind !== "solution") notFound();

  const submission = toPublicSubmission(row);

  return (
    <main>
      <SectionNav section="build" />
      <PageHead
        title="Wish solution"
        description="A claim that a bounty escrowed against a wish has been earned. Silence approves when the window closes; a standing objection makes it contested."
      />
      <SubmissionDetail submission={submission} />
    </main>
  );
}
