/**
 * One submission, read. Public, like the list — the claim and every objection on
 * it are meant to be seen, and `toPublicSubmission` is the only thing that renders
 * them, so the derived status and the stripped-of-secrets shape are computed the
 * same way here as everywhere else.
 */
import { toPublicSubmission } from "@/core/submissions/view";
import { json, fail, loadSubmission } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const row = await loadSubmission(params.id).catch(() => null);
  if (!row) return fail("no such submission", 404);
  return json({ ok: true, submission: toPublicSubmission(row) });
}
