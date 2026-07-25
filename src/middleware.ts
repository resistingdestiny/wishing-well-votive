import { NextResponse, type NextRequest } from "next/server";
import { isGeofenced, countryOf, geoDecision } from "@/lib/geofence";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!isGeofenced(pathname)) return NextResponse.next();

  const country = countryOf(req.headers, req.nextUrl);
  const decision = geoDecision(country);
  if (!decision.blocked) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "geofenced", reason: decision.reason, country: decision.country },
      { status: 403 },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = "/blocked";
  url.search = decision.country ? `?country=${decision.country}` : "";
  return NextResponse.redirect(url);
}

export const config = {

  matcher: ["/fund/:path*", "/claim/:path*", "/api/fund/:path*", "/api/claim/:path*"],
};
