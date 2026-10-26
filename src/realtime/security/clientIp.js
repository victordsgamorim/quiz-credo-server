import { isIP } from "node:net";

// An IPv4 address arrives as IPv6 on a dual-stack socket (::ffff:1.2.3.4): the same address
const normalize = (address) =>
  address?.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;

/**
 * The address of a request's caller: the one a trusted proxy wrote in `header` (a single address,
 * like Cloudflare's CF-Connecting-IP), or the connection's own when there's none
 *
 * @param header - The trusted proxy's header, lowercase; empty when there's no proxy to trust
 * @returns A function from a request to its caller's address
 */
export const createClientIpResolver = (header) => (req) => {
  if (header) {
    const value = req.headers[header];
    if (typeof value === "string" && isIP(value.trim())) return normalize(value.trim());
  }
  return normalize(req.socket?.remoteAddress) || "unknown";
};
