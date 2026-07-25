import { assuranceTierMeta } from "@/lib/humanBacked";

export function HumanBadge({ label }: { label: string }) {
  const meta = assuranceTierMeta(label);
  return (
    <span className={`badge humanTier ${meta.key}`} title={meta.note}>
      <span className="humanTierDot" aria-hidden="true" />
      {meta.name}
    </span>
  );
}
