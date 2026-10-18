import { LAMPORTS_PER_SOL } from "@solana/web3.js";

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

export const billLink = (addr: string) =>
  `${location.origin}${location.pathname}#/b/${addr}`;

export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel/i.test(msg)) return "Cancelled in your wallet.";
  if (/insufficient|0x1\b/i.test(msg)) return "Not enough SOL in your wallet.";
  if (/AlreadyPaid|already been paid/i.test(msg)) return "Someone just paid this bill.";
  if (/SelfPay|your own bill/i.test(msg)) return "You can't pay your own bill.";
  if (/blockhash/i.test(msg)) return "Network was slow. Try again.";
  return msg.length > 140 ? msg.slice(0, 140) + "…" : msg;
}
