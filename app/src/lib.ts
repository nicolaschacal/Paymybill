import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export const short = (a: { toBase58(): string } | string, n = 4) => {
  const s = typeof a === "string" ? a : a.toBase58();
  return `${s.slice(0, n)}…${s.slice(-n)}`;
};

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fmtSol(lamports: bigint | number, max = 4): string {
  const sol = Number(lamports) / LAMPORTS_PER_SOL;
  if (sol === 0) return "0";
  if (sol < 0.0001) return "<0.0001";
  return sol.toLocaleString(undefined, { maximumFractionDigits: max });
}

export function fmtUsd(usd: number): string {
  return usd.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: usd < 10 ? 2 : 0,
  });
}

/** Parse a decimal string like "0.5" or "1,25" to a number, or NaN. */
export function parseAmount(s: string): number {
  const n = Number(s.replace(",", ".").trim());
  return Number.isFinite(n) ? n : NaN;
}

/* ---------- friendly bill links ----------
 * /b/my-dog-vet-4xKp2mQ9vRt : a readable slug of the title + the bill's random u64 id
 * in base58 (≤ 11 chars). /b/<44-char address> keeps working too. The slug is cosmetic. */

export function idToCode(id: bigint): string {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, id, true);
  return bs58.encode(b);
}

export function idBytes(id: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, id, true);
  return b;
}

const slugify = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");

export function billPath(b: { title: string; id: bigint }): string {
  const slug = slugify(b.title);
  return `/b/${slug ? slug + "-" : ""}${idToCode(b.id)}`;
}

export const billLink = (b: { title: string; id: bigint }) => location.origin + billPath(b);

export type BillParam = { kind: "address"; address: string } | { kind: "id"; id: bigint };

export function parseBillParam(param: string): BillParam | null {
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(param)) {
    try {
      const pk = new PublicKey(param);
      return { kind: "address", address: pk.toBase58() };
    } catch {
      /* not an address, fall through */
    }
  }
  const code = param.slice(param.lastIndexOf("-") + 1);
  if (!/^[1-9A-HJ-NP-Za-km-z]{1,11}$/.test(code)) return null;
  try {
    const bytes = bs58.decode(code);
    if (bytes.length !== 8) return null;
    return { kind: "id", id: new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true) };
  } catch {
    return null;
  }
}

export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel/i.test(msg)) return "Cancelled in your wallet.";
  if (/insufficient|0x1\b/i.test(msg)) return "Not enough SOL in your wallet.";
  if (/AlreadyPaid|already been paid/i.test(msg)) return "Someone just paid this bill.";
  if (/SelfPay|your own bill/i.test(msg)) return "You can't pay your own bill.";
  if (/blockhash/i.test(msg)) return "Network was slow. Try again.";
  return msg.length > 140 ? msg.slice(0, 140) + "…" : msg;
}
