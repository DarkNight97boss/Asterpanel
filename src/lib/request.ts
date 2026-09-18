import "server-only";
import { headers } from "next/headers";

/** Client IP and user agent of the current request (behind a trusted proxy). */
export async function requestMeta() {
  const h = await headers();
  return {
    ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "",
    userAgent: (h.get("user-agent") ?? "").slice(0, 255),
  };
}
