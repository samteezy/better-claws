import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { BetterClawsError } from "../types.js";

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB

/**
 * Read the full body of an HTTP request as a UTF-8 string.
 * Destroys the request and rejects if the body exceeds `maxBytes`.
 */
export function readBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new BetterClawsError("Request body too large", "http", "BODY_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", reject);
  });
}

/**
 * Validate a Bearer token from the Authorization header using
 * timing-safe comparison.  Returns `true` if no token is configured
 * (open access) or the token matches.
 */
export function authenticateBearer(
  req: IncomingMessage,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return true;

  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return false;

  const token = header.slice(7);
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expectedToken);

  if (tokenBuf.byteLength !== expectedBuf.byteLength) return false;
  return timingSafeEqual(tokenBuf, expectedBuf);
}
