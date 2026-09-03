import { timingSafeEqual } from "node:crypto";

export function equalTokens(received: string | null, expected: string): boolean {
  if (received === null) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function bearerToken(authorization: string | undefined): string | null {
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
}
