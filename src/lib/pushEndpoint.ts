const ALLOWED_SUFFIXES = [

  ".googleapis.com",
  "fcm.googleapis.com",

  ".push.services.mozilla.com",

  ".push.apple.com",

  ".notify.windows.com",
  ".push.microsoft.com",
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;

  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
  return ALLOWED_SUFFIXES.some((s) => host === s.replace(/^\./, "") || host.endsWith(s));
}
