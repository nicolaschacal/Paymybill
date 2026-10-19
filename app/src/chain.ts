import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";

/* ---------- config ---------- */

const env = import.meta.env;
export const CLUSTER: string = env.VITE_CLUSTER || "devnet";
export const RPC_URL: string =
  env.VITE_RPC_URL ||
  (CLUSTER === "mainnet-beta"
    ? "https://api.mainnet-beta.solana.com"
    : CLUSTER === "localnet"
      ? "http://127.0.0.1:8899"
      : "https://api.devnet.solana.com");
export const PROGRAM_ID = new PublicKey(
  env.VITE_PROGRAM_ID || "6LgTZEVfPX2a3ouR9suAaozexXNjyJ8S4EqNRYFKX8x3",
);

/** Service fee, deducted from what the creator receives. Must match the program. */
export const FEE_BPS = 300n;
export const FEE_WALLET = new PublicKey("AQfKYtAVyZARgKxSt6ZpqwLAtDNeE1LF8Jk5FYWteqbv");
export const feeFor = (lamports: bigint): bigint => (lamports * FEE_BPS) / 10_000n;

export const TITLE_MAX = 48;
export const NOTE_MAX = 160;
export const BILL_ACCOUNT_SIZE = 322; // 8 + InitSpace (checked by a Rust test)
export const RECEIPT_ACCOUNT_SIZE = 337;

export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER === "localnet" ? "custom&customUrl=" + encodeURIComponent(RPC_URL) : CLUSTER}`}`;
export const explorerAddr = (a: string) =>
  `https://explorer.solana.com/address/${a}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER === "localnet" ? "custom&customUrl=" + encodeURIComponent(RPC_URL) : CLUSTER}`}`;

/* ---------- discriminators (verified by `cargo test`) ---------- */

const BILL_DISC = Uint8Array.from([0x46, 0x4c, 0xfb, 0xaf, 0xd4, 0xe3, 0xd4, 0xb3]);
const IX_CREATE = Uint8Array.from([0x1c, 0xf1, 0xb4, 0xa1, 0x6d, 0xff, 0xdc, 0x2c]);
const IX_PAY = Uint8Array.from([0xfa, 0xea, 0xbc, 0x6e, 0x1f, 0xb9, 0x22, 0x05]);
const IX_CLOSE = Uint8Array.from([0xed, 0x6c, 0x97, 0x43, 0xf9, 0x53, 0xf7, 0xfa]);
const RECEIPT_DISC = Uint8Array.from([0x27, 0x9a, 0x49, 0x6a, 0x50, 0x66, 0x91, 0x99]);
const IX_CLOSE_RECEIPT = Uint8Array.from([0x7e, 0xfe, 0xf4, 0xcb, 0x7c, 0xa4, 0x86, 0x59]);

/* ---------- model ---------- */

export interface Bill {
  address: PublicKey;
  paid: boolean;
  creator: PublicKey;
  id: bigint;
  lamports: bigint;
  createdAt: number; // unix seconds
  paidAt: number;
  payer: PublicKey | null;
  title: string;
  note: string;
}

/** The payer's copy of a paid bill. Survives if the creator closes the bill. */
export interface Receipt {
  address: PublicKey;
  payer: PublicKey;
  creator: PublicKey;
  bill: PublicKey;
  lamports: bigint;
  paidAt: number;
  title: string;
  note: string;
  /** true for bills paid before receipts existed (no receipt account, can't be removed) */
  legacy?: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const byteLen = (s: string) => enc.encode(s).length;

export const solToLamports = (sol: number) => BigInt(Math.round(sol * LAMPORTS_PER_SOL));
export const lamportsToSol = (l: bigint) => Number(l) / LAMPORTS_PER_SOL;

export function deriveBill(creator: PublicKey, id: bigint): PublicKey {
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, id, true);
  return PublicKey.findProgramAddressSync(
    [enc.encode("bill"), creator.toBytes(), idBytes],
    PROGRAM_ID,
  )[0];
}

export function randomId(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return new DataView(b.buffer).getBigUint64(0, true);
}

export function deriveReceipt(bill: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("receipt"), bill.toBytes()], PROGRAM_ID)[0];
}

/* ---------- decode ---------- */

export function decodeReceipt(address: PublicKey, data: Uint8Array): Receipt | null {
  if (data.length < 133) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== RECEIPT_DISC[i]) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 121;
  const tl = v.getUint32(o, true);
  o += 4;
  const title = dec.decode(data.subarray(o, o + tl));
  o += tl;
  const nl = v.getUint32(o, true);
  o += 4;
  const note = dec.decode(data.subarray(o, o + nl));
  return {
    address,
    payer: new PublicKey(data.subarray(9, 41)),
    creator: new PublicKey(data.subarray(41, 73)),
    bill: new PublicKey(data.subarray(73, 105)),
    lamports: v.getBigUint64(105, true),
    paidAt: Number(v.getBigInt64(113, true)),
    title,
    note,
  };
}

/** Pseudo-receipt for a bill paid before receipts existed. */
export const legacyReceipt = (b: Bill): Receipt => ({
  address: b.address,
  payer: b.payer!,
  creator: b.creator,
  bill: b.address,
  lamports: b.lamports,
  paidAt: b.paidAt,
  title: b.title,
  note: b.note,
  legacy: true,
});

export function decodeBill(address: PublicKey, data: Uint8Array): Bill | null {
  if (data.length < 110) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== BILL_DISC[i]) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const creator = new PublicKey(data.subarray(10, 42));
  const payer = new PublicKey(data.subarray(74, 106));
  let o = 106;
  const tl = v.getUint32(o, true);
  o += 4;
  const title = dec.decode(data.subarray(o, o + tl));
  o += tl;
  const nl = v.getUint32(o, true);
  o += 4;
  const note = dec.decode(data.subarray(o, o + nl));
  return {
    address,
    paid: data[8] === 1,
    creator,
    id: v.getBigUint64(42, true),
    lamports: v.getBigUint64(50, true),
    createdAt: Number(v.getBigInt64(58, true)),
    paidAt: Number(v.getBigInt64(66, true)),
    payer: payer.equals(PublicKey.default) ? null : payer,
    title,
    note,
  };
}

/* ---------- reads ---------- */

export async function fetchBills(
  conn: Connection,
  opts: { creator?: PublicKey; payer?: PublicKey } = {},
): Promise<Bill[]> {
  const filters: { dataSize: number }[] | any[] = [
    { dataSize: BILL_ACCOUNT_SIZE },
    { memcmp: { offset: 0, bytes: bs58.encode(BILL_DISC) } },
  ];
  if (opts.creator) filters.push({ memcmp: { offset: 10, bytes: opts.creator.toBase58() } });
  if (opts.payer) filters.push({ memcmp: { offset: 74, bytes: opts.payer.toBase58() } });
  const accts = await conn.getProgramAccounts(PROGRAM_ID, { filters, commitment: "confirmed" });
  const out: Bill[] = [];
  for (const a of accts) {
    const b = decodeBill(a.pubkey, a.account.data);
    if (b) out.push(b);
  }
  return out.sort((x, y) => y.createdAt - x.createdAt);
}

export async function fetchReceipts(conn: Connection, payer: PublicKey): Promise<Receipt[]> {
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: RECEIPT_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: bs58.encode(RECEIPT_DISC) } },
      { memcmp: { offset: 9, bytes: payer.toBase58() } },
    ],
    commitment: "confirmed",
  });
  const out: Receipt[] = [];
  for (const a of accts) {
    const r = decodeReceipt(a.pubkey, a.account.data);
    if (r) out.push(r);
  }
  return out.sort((x, y) => y.paidAt - x.paidAt);
}

export async function fetchReceipt(conn: Connection, address: PublicKey): Promise<Receipt | null> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info || !info.owner.equals(PROGRAM_ID)) return null;
  return decodeReceipt(address, info.data);
}

/** Lightweight listing: just the addresses of bills with this status, newest first.
 *  Uses a data slice, so each account costs ~40 bytes on the wire instead of 322. */
export interface BillRef {
  address: PublicKey;
  at: number; // createdAt for open bills, paidAt for paid ones
}

export async function listBillRefs(conn: Connection, status: 0 | 1): Promise<BillRef[]> {
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: BILL_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: bs58.encode(BILL_DISC) } },
      { memcmp: { offset: 8, bytes: bs58.encode(Uint8Array.of(status)) } },
    ],
    dataSlice: { offset: 58, length: 16 }, // created_at (i64) + paid_at (i64)
    commitment: "confirmed",
  });
  const refs = accts.map((a) => {
    const v = new DataView(a.account.data.buffer, a.account.data.byteOffset, a.account.data.byteLength);
    return { address: a.pubkey, at: Number(v.getBigInt64(status === 1 ? 8 : 0, true)) };
  });
  return refs.sort((x, y) => y.at - x.at);
}

/** Full bills for a handful of addresses (closed ones are skipped). */
export async function fetchBillsByAddress(conn: Connection, addrs: PublicKey[]): Promise<Bill[]> {
  const out: Bill[] = [];
  for (let i = 0; i < addrs.length; i += 100) {
    const chunk = addrs.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk, "confirmed");
    infos.forEach((info, j) => {
      if (!info || !info.owner.equals(PROGRAM_ID)) return;
      const b = decodeBill(chunk[j], info.data);
      if (b) out.push(b);
    });
  }
  return out;
}

export async function fetchBill(conn: Connection, address: PublicKey): Promise<Bill | null> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info || !info.owner.equals(PROGRAM_ID)) return null;
  return decodeBill(address, info.data);
}

/* ---------- instructions ---------- */

function u64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
function str(s: string): Uint8Array {
  const bytes = enc.encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}
function concat(...parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts);
}

export function createBillIx(
  creator: PublicKey,
  id: bigint,
  lamports: bigint,
  title: string,
  note: string,
): { ix: TransactionInstruction; bill: PublicKey } {
  const bill = deriveBill(creator, id);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: bill, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: concat(IX_CREATE, u64(id), u64(lamports), str(title), str(note)),
  });
  return { ix, bill };
}

export function payBillIx(payer: PublicKey, bill: Bill): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: bill.address, isSigner: false, isWritable: true },
      { pubkey: bill.creator, isSigner: false, isWritable: true },
      { pubkey: FEE_WALLET, isSigner: false, isWritable: true },
      { pubkey: deriveReceipt(bill.address), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_PAY),
  });
}

export function closeBillIx(creator: PublicKey, bill: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: bill, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(IX_CLOSE),
  });
}

export function closeReceiptIx(payer: PublicKey, receipt: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: receipt, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(IX_CLOSE_RECEIPT),
  });
}

/* ---------- optional SOL/USD hint (never required) ---------- */

export async function fetchSolUsd(): Promise<number | null> {
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot");
    const j = await r.json();
    const p = Number(j?.data?.amount);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}
