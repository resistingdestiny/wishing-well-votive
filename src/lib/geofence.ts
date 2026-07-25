const DEFAULT_BLOCKED = "IR,KP,SY,CU,RU";

export function blockedJurisdictions(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.NEXT_PUBLIC_WELL_BLOCKED_JURISDICTIONS ?? env.WELL_BLOCKED_JURISDICTIONS ?? DEFAULT_BLOCKED;
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

export const GEOFENCED_PREFIXES = ["/fund", "/claim", "/api/fund", "/api/claim"];

export function isGeofenced(pathname: string): boolean {
  return GEOFENCED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function countryOf(headers: Headers, url?: URL): string | undefined {

  const allowOverride = process.env.WELL_ALLOW_COUNTRY_OVERRIDE === "1";
  const override = allowOverride
    ? headers.get("x-well-country") ?? (url ? url.searchParams.get("__country") : null) ?? undefined
    : undefined;
  const country =
    override ??
    headers.get("x-vercel-ip-country") ??
    headers.get("cf-ipcountry") ??
    undefined;
  return country ? country.trim().toUpperCase() : undefined;
}

export interface GeoDecision {
  blocked: boolean;
  country?: string;
  reason?: string;
}

export function geoDecision(
  country: string | undefined,
  blocked: string[] = blockedJurisdictions(),
): GeoDecision {
  if (country && blocked.includes(country)) {
    return { blocked: true, country, reason: `funding and claims are not available in ${country}` };
  }
  return { blocked: false, country };
}
