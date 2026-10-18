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

export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER === "localnet" ? "custom&customUrl=" + encodeURIComponent(RPC_URL) : CLUSTER}`}`;
export const explorerAddr = (a: string) =>
  `https://explorer.solana.com/address/${a}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER === "localnet" ? "custom&customUrl=" + encodeURIComponent(RPC_URL) : CLUSTER}`}`;

/* ---------- discriminators (verified by `cargo test`) ---------- */

const BILL_DISC = Uint8Array.from([0x46, 0x4c, 0xfb, 0xaf, 0xd4, 0xe3, 0xd4, 0xb3]);
const IX_CREATE = Uint8Array.from([0x1c, 0xf1, 0xb4, 0xa1, 0x6d, 0xff, 0xdc, 0x2c]);
const IX_PAY = Uint8Array.from([0xfa, 0xea, 0xbc, 0x6e, 0x1f, 0xb9, 0x22, 0x05]);
const IX_CLOSE = Uint8Array.from([0xed, 0x6c, 0x97, 0x43, 0xf9, 0x53, 0xf7, 0xfa]);

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

/* ---------- decode ---------- */

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
  opts: { creator?: PublicKey } = {},
): Promise<Bill[]> {
  const filters: { dataSize: number }[] | any[] = [
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
