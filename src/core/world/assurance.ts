export type AssuranceTier = "none" | "device" | "selfie" | "orb";

export const ASSURANCE_CODE: Record<AssuranceTier, number> = {
  none: 0,
  device: 1,
  selfie: 2,
  orb: 3,
};

const CODE_TO_TIER: AssuranceTier[] = ["none", "device", "selfie", "orb"];

export function tierFromCode(code: number): AssuranceTier {
  return CODE_TO_TIER[code] ?? "none";
}

export function isAssuranceTier(v: string): v is AssuranceTier {
  return v === "none" || v === "device" || v === "selfie" || v === "orb";
}

export const ASSURANCE_FACTOR: Record<AssuranceTier, number> = {
  none: 0,
  device: 0.5,
  selfie: 1,
  orb: 2,
};

export function assuranceFactor(tier: AssuranceTier): number {
  return ASSURANCE_FACTOR[tier];
}

export function meetsStepUp(tier: AssuranceTier, amountUsd: number, stepUpUsd: number): boolean {
  if (stepUpUsd <= 0) return assuranceFactor(tier) > 0;
  if (amountUsd <= stepUpUsd) return assuranceFactor(tier) > 0;
  return tier === "orb";
}
