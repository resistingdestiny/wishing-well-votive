import crypto from "node:crypto";

const PREFIX = "enc:v1:";

const DEV_KEY = "dev-only-pii-key-not-for-production";

function key(): Buffer {
  const secret = process.env.WELL_PII_KEY;

  if (!secret) {
    if (process.env.NODE_ENV === "production" && process.env.WELL_ALLOW_DEV_PII_KEY !== "1") {
      throw new Error("WELL_PII_KEY is required in production (refusing the dev fallback key)");
    }
    return crypto.scryptSync(DEV_KEY, "votive-pii-v1", 32);
  }
  return crypto.scryptSync(secret, "votive-pii-v1", 32);
}

export function encryptPii(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptPii(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const [, , ivB64, tagB64, ctB64] = value.split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed encrypted PII value");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
