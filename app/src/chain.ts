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

// import.meta.env only exists under Vite; the agent CLI and e2e script run this file in Node.
const env: Record<string, string | undefined> = (import.meta as any).env ?? {};
const nodeEnv: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};
const pick = (k: string) => env[k] || nodeEnv[k];

export const CLUSTER: string = pick("VITE_CLUSTER") || "devnet";
export const RPC_URL: string =
  pick("VITE_RPC_URL") ||
  (CLUSTER === "mainnet-beta"
    ? "https://api.mainnet-beta.solana.com"
    : CLUSTER === "localnet"
      ? "http://127.0.0.1:8899"
      : "https://api.devnet.solana.com");
export const PROGRAM_ID = new PublicKey(
  pick("VITE_PROGRAM_ID") || "6LgTZEVfPX2a3ouR9suAaozexXNjyJ8S4EqNRYFKX8x3",
);

/** Service fee, deducted from what the creator receives. Must match the program. */
export const FEE_BPS = 300n;
export const FEE_WALLET = new PublicKey("AQfKYtAVyZARgKxSt6ZpqwLAtDNeE1LF8Jk5FYWteqbv");
export const feeFor = (lamports: bigint): bigint => (lamports * FEE_BPS) / 10_000n;

export const TITLE_MAX = 48;
export const NOTE_MAX = 160;
export const NAME_MAX = 24;
export const HANDLE_MAX = 15;
/** Smallest contribution (0.001 SOL) unless it finishes the bill. Must match the program. */
export const MIN_CONTRIB = 1_000_000n;
export const BILL_ACCOUNT_SIZE = 334; // 8 + InitSpace (checked by a Rust test)
export const RECEIPT_ACCOUNT_SIZE = 337;
export const SUPPORTER_ACCOUNT_SIZE = 120;

export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER === "localnet" ? "custom&customUrl=" + encodeURIComponent(RPC_URL) : CLUSTER}`}`;
export const explorerAddr = (a: string) =>
  `https://explorer.solana.com/address/${a}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER === "localnet" ? "custom&customUrl=" + encodeURIComponent(RPC_URL) : CLUSTER}`}`;

/* ---------- discriminators (verified by `cargo test`) ---------- */

const BILL_DISC = Uint8Array.from([0x46, 0x4c, 0xfb, 0xaf, 0xd4, 0xe3, 0xd4, 0xb3]);
const RECEIPT_DISC = Uint8Array.from([0x27, 0x9a, 0x49, 0x6a, 0x50, 0x66, 0x91, 0x99]);
const SUPPORTER_DISC = Uint8Array.from([0xc6, 0x7d, 0x49, 0x5e, 0x48, 0x28, 0xe9, 0x9f]);
const IX_CREATE = Uint8Array.from([0x1c, 0xf1, 0xb4, 0xa1, 0x6d, 0xff, 0xdc, 0x2c]);
const IX_PAY = Uint8Array.from([0xfa, 0xea, 0xbc, 0x6e, 0x1f, 0xb9, 0x22, 0x05]);
const IX_CLOSE = Uint8Array.from([0xed, 0x6c, 0x97, 0x43, 0xf9, 0x53, 0xf7, 0xfa]);
const IX_CLOSE_RECEIPT = Uint8Array.from([0x7e, 0xfe, 0xf4, 0xcb, 0x7c, 0xa4, 0x86, 0x59]);
const IX_SET_SUPPORTER = Uint8Array.from([0x6f, 0x3e, 0xb9, 0x06, 0x2c, 0xef, 0x96, 0x79]);
const IX_CLOSE_SUPPORTER = Uint8Array.from([0x1c, 0xc8, 0x42, 0x02, 0x62, 0x94, 0xdf, 0x7f]);

/* ---------- model ---------- */

export interface Bill {
  address: PublicKey;
  paid: boolean;
  creator: PublicKey;
  id: bigint;
  /** Target, in lamports. */
  lamports: bigint;
  /** Gross lamports contributed so far. */
  raised: bigint;
  /** Number of different wallets that contributed. */
  backers: number;
  createdAt: number; // unix seconds
  paidAt: number;
  /** Most recent contributor. */
  payer: PublicKey | null;
  title: string;
  note: string;
}

/** The payer's copy of a bill: what they put in, kept even if the creator closes the bill. */
export interface Receipt {
  address: PublicKey;
  payer: PublicKey;
  creator: PublicKey;
  bill: PublicKey;
  lamports: bigint;
  paidAt: number;
  title: string;
  note: string;
}

/** A payer's public card, behind the leaderboards. */
export interface Supporter {
  address: PublicKey;
  owner: PublicKey;
  total: bigint;
  dayTotal: bigint;
  lastPaidAt: number;
  billsHelped: number;
  day: number; // UTC day number that dayTotal belongs to
  name: string;
  handle: string;
}

/** The light version used to rank everyone without downloading whole accounts. */
export interface SupporterRef {
  address: PublicKey;
  owner: PublicKey;
  total: bigint;
  dayTotal: bigint;
  lastPaidAt: number;
  billsHelped: number;
  day: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const byteLen = (s: string) => enc.encode(s).length;

export const solToLamports = (sol: number) => BigInt(Math.round(sol * LAMPORTS_PER_SOL));
export const lamportsToSol = (l: bigint) => Number(l) / LAMPORTS_PER_SOL;

export const utcDay = (unixSeconds = Math.floor(Date.now() / 1000)) => Math.floor(unixSeconds / 86_400);
/** Seconds until the "today" leaderboard resets (00:00 UTC). */
export const secondsToReset = (unixSeconds = Math.floor(Date.now() / 1000)) =>
  (utcDay(unixSeconds) + 1) * 86_400 - unixSeconds;

export function deriveBill(creator: PublicKey, id: bigint): PublicKey {
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, id, true);
  return PublicKey.findProgramAddressSync(
    [enc.encode("bill"), creator.toBytes(), idBytes],
    PROGRAM_ID,
  )[0];
}

export function deriveReceipt(bill: PublicKey, payer: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("receipt"), bill.toBytes(), payer.toBytes()],
    PROGRAM_ID,
  )[0];
}

export function deriveSupporter(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("supporter"), owner.toBytes()], PROGRAM_ID)[0];
}

export function randomId(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return new DataView(b.buffer).getBigUint64(0, true);
}

/* ---------- decode ---------- */

function readStr(data: Uint8Array, v: DataView, o: number): [string, number] {
  const len = v.getUint32(o, true);
  o += 4;
  return [dec.decode(data.subarray(o, o + len)), o + len];
}

const hasDisc = (data: Uint8Array, disc: Uint8Array) => {
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return false;
  return true;
};

export function decodeBill(address: PublicKey, data: Uint8Array): Bill | null {
  if (data.length < 126 || !hasDisc(data, BILL_DISC)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const creator = new PublicKey(data.subarray(10, 42));
  const payer = new PublicKey(data.subarray(74, 106));
  const [title, o] = readStr(data, v, 118);
  const [note] = readStr(data, v, o);
  return {
    address,
    paid: data[8] === 1,
    creator,
    id: v.getBigUint64(42, true),
    lamports: v.getBigUint64(50, true),
    raised: v.getBigUint64(106, true),
    backers: v.getUint32(114, true),
    createdAt: Number(v.getBigInt64(58, true)),
    paidAt: Number(v.getBigInt64(66, true)),
    payer: payer.equals(PublicKey.default) ? null : payer,
    title,
    note,
  };
}

export function decodeReceipt(address: PublicKey, data: Uint8Array): Receipt | null {
  if (data.length < 133 || !hasDisc(data, RECEIPT_DISC)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const [title, o] = readStr(data, v, 121);
  const [note] = readStr(data, v, o);
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

function refFields(address: PublicKey, owner: Uint8Array, v: DataView, o: number) {
  return {
    address,
    owner: new PublicKey(owner),
    total: v.getBigUint64(o, true),
    dayTotal: v.getBigUint64(o + 8, true),
    lastPaidAt: Number(v.getBigInt64(o + 16, true)),
    billsHelped: v.getUint32(o + 24, true),
    day: v.getUint32(o + 28, true),
  };
}

export function decodeSupporter(address: PublicKey, data: Uint8Array): Supporter | null {
  if (data.length < 81 || !hasDisc(data, SUPPORTER_DISC)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const [name, o] = readStr(data, v, 73);
  const [handle] = readStr(data, v, o);
  return { ...refFields(address, data.subarray(9, 41), v, 41), name, handle };
}

/* ---------- reads ---------- */

export async function fetchBills(
  conn: Connection,
  opts: { creator?: PublicKey } = {},
): Promise<Bill[]> {
  const filters: any[] = [
    { dataSize: BILL_ACCOUNT_SIZE },
    { memcmp: { offset: 0, bytes: bs58.encode(BILL_DISC) } },
  ];
  if (opts.creator) filters.push({ memcmp: { offset: 10, bytes: opts.creator.toBase58() } });
  const accts = await conn.getProgramAccounts(PROGRAM_ID, { filters, commitment: "confirmed" });
  const out: Bill[] = [];
  for (const a of accts) {
    const b = decodeBill(a.pubkey, a.account.data);
    if (b) out.push(b);
  }
  return out.sort((x, y) => y.createdAt - x.createdAt);
}

/** Lightweight listing: just the addresses of bills with this status, newest first.
 *  Uses a data slice, so each account costs ~40 bytes on the wire instead of 334. */
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

/** Bills with this random id (normally exactly one; more only if someone copied an id). */
export async function fetchBillsById(conn: Connection, id: bigint): Promise<Bill[]> {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, id, true);
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: BILL_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: bs58.encode(BILL_DISC) } },
      { memcmp: { offset: 42, bytes: bs58.encode(b) } },
    ],
    commitment: "confirmed",
  });
  const out: Bill[] = [];
  for (const a of accts) {
    const bill = decodeBill(a.pubkey, a.account.data);
    if (bill) out.push(bill);
  }
  return out.sort((x, y) => x.createdAt - y.createdAt);
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

export async function fetchReceipts(conn: Connection, payer: PublicKey): Promise<Receipt[]> {
  return receiptsWhere(conn, 9, payer);
}

/** Everyone who chipped in on a bill. */
export async function fetchReceiptsForBill(conn: Connection, bill: PublicKey): Promise<Receipt[]> {
  return receiptsWhere(conn, 73, bill);
}

async function receiptsWhere(conn: Connection, offset: number, key: PublicKey): Promise<Receipt[]> {
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: RECEIPT_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: bs58.encode(RECEIPT_DISC) } },
      { memcmp: { offset, bytes: key.toBase58() } },
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

/** Everyone's totals, without names: ~70 bytes per supporter on the wire. */
export async function listSupporterRefs(conn: Connection): Promise<SupporterRef[]> {
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: SUPPORTER_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: bs58.encode(SUPPORTER_DISC) } },
    ],
    dataSlice: { offset: 9, length: 64 }, // owner .. day
    commitment: "confirmed",
  });
  return accts.map((a) => {
    const d = a.account.data;
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return refFields(a.pubkey, d.subarray(0, 32), v, 32);
  });
}

/** Highest first. Ties go to whoever got there first. */
export function rankAllTime(refs: SupporterRef[]): SupporterRef[] {
  return refs
    .filter((r) => r.total > 0n)
    .sort((a, b) => (a.total === b.total ? a.lastPaidAt - b.lastPaidAt : a.total > b.total ? -1 : 1));
}

/** Today's board (UTC day). Supporters whose last payment was on an earlier day count as 0. */
export function rankToday(refs: SupporterRef[], day = utcDay()): SupporterRef[] {
  return refs
    .filter((r) => r.day === day && r.dayTotal > 0n)
    .sort((a, b) =>
      a.dayTotal === b.dayTotal ? a.lastPaidAt - b.lastPaidAt : a.dayTotal > b.dayTotal ? -1 : 1,
    );
}

/** The puesto someone would hold after adding `extra` to their current number. Ties go to the incumbent. */
export function rankIfPaying(
  refs: SupporterRef[],
  me: PublicKey | null,
  extra: bigint,
  kind: "all" | "today",
): number {
  const day = utcDay();
  const val = (r: SupporterRef) => (kind === "all" ? r.total : r.day === day ? r.dayTotal : 0n);
  const mine = me ? refs.find((r) => r.owner.equals(me)) : undefined;
  const newVal = (mine ? val(mine) : 0n) + extra;
  const ahead = refs.filter((r) => !(me && r.owner.equals(me)) && val(r) >= newVal && val(r) > 0n).length;
  return ahead + 1;
}

export async function fetchSupporters(conn: Connection, addrs: PublicKey[]): Promise<Supporter[]> {
  const out: Supporter[] = [];
  for (let i = 0; i < addrs.length; i += 100) {
    const chunk = addrs.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk, "confirmed");
    infos.forEach((info, j) => {
      if (!info || !info.owner.equals(PROGRAM_ID)) return;
      const s = decodeSupporter(chunk[j], info.data);
      if (s) out.push(s);
    });
  }
  return out;
}

export async function fetchSupporter(conn: Connection, owner: PublicKey): Promise<Supporter | null> {
  const address = deriveSupporter(owner);
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info || !info.owner.equals(PROGRAM_ID)) return null;
  return decodeSupporter(address, info.data);
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

/** Chip in `lamports` towards a bill. `name` and `handle` ("" keeps what the card has). */
export function payBillIx(
  payer: PublicKey,
  bill: Bill,
  lamports: bigint,
  name = "",
  handle = "",
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: bill.address, isSigner: false, isWritable: true },
      { pubkey: bill.creator, isSigner: false, isWritable: true },
      { pubkey: FEE_WALLET, isSigner: false, isWritable: true },
      { pubkey: deriveReceipt(bill.address, payer), isSigner: false, isWritable: true },
      { pubkey: deriveSupporter(payer), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: concat(IX_PAY, u64(lamports), str(name), str(handle)),
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

/** Create or edit your supporter card. Empty strings clear a field. */
export function setSupporterIx(owner: PublicKey, name: string, handle: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: deriveSupporter(owner), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: concat(IX_SET_SUPPORTER, str(name), str(handle)),
  });
}

export function closeSupporterIx(owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: deriveSupporter(owner), isSigner: false, isWritable: true },
    ],
    data: Buffer.from(IX_CLOSE_SUPPORTER),
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
