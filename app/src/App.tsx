import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  BILL_ACCOUNT_SIZE,
  HANDLE_MAX,
  MIN_CONTRIB,
  NAME_MAX,
  RECEIPT_ACCOUNT_SIZE,
  SUPPORTER_ACCOUNT_SIZE,
  CLUSTER,
  NOTE_MAX,
  PROGRAM_ID,
  TITLE_MAX,
  byteLen,
  closeBillIx,
  closeReceiptIx,
  closeSupporterIx,
  deriveSupporter,
  fetchReceipt,
  fetchReceiptsForBill,
  fetchReceipts,
  fetchSupporter,
  fetchSupporters,
  listSupporterRefs,
  rankAllTime,
  rankIfPaying,
  rankToday,
  secondsToReset,
  utcDay,
  setSupporterIx,
  createBillIx,
  explorerAddr,
  explorerTx,
  FEE_BPS,
  feeFor,
  fetchBill,
  fetchBills,
  fetchBillsById,
  fetchBillsByAddress,
  listBillRefs,
  fetchSolUsd,
  lamportsToSol,
  payBillIx,
  randomId,
  solToLamports,
} from "./chain";
import type { Bill, BillRef, Receipt, Supporter, SupporterRef } from "./chain";
import { billLink, billPath, fmtDuration, fmtSol, fmtUsd, friendlyError, parseAmount, parseBillParam, short, timeAgo } from "./lib";

const REPO_URL = "https://github.com/nicolaschacal/paymybill";

/* ---------------------------------------------------------------- toast */

const ToastCtx = createContext<(msg: string, href?: string) => void>(() => {});
const useToast = () => useContext(ToastCtx);

function ToastHost({ toast }: { toast: { msg: string; href?: string } | null }) {
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      {toast.msg}
      {toast.href && (
        <>
          {" "}
          <a href={toast.href} target="_blank" rel="noreferrer">
            View tx ↗
          </a>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- hooks */

function useRoute(): string[] {
  const read = () => location.pathname.split("/").filter(Boolean);
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => {
      setR(read());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("popstate", on);
    window.addEventListener("pmb:nav", on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener("pmb:nav", on);
    };
  }, []);
  return r;
}
const go = (path: string) => {
  history.pushState(null, "", path);
  window.dispatchEvent(new Event("pmb:nav"));
};

// Old links looked like /#/b/<address>: turn them into /b/<address> before the first render.
if (location.hash.startsWith("#/")) history.replaceState(null, "", location.hash.slice(1));

function useSolUsd(): number | null {
  const [p, setP] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    fetchSolUsd().then((v) => live && setP(v));
    return () => {
      live = false;
    };
  }, []);
  return p;
}

const PAGE = 20;

/** Feed of bills with one status: a cheap index first, then full bills 20 at a time. */
function usePagedBills(status: 0 | 1, enabled: boolean) {
  const { connection } = useConnection();
  const [index, setIndex] = useState<BillRef[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [bills, setBills] = useState<Bill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const started = useRef(false);

  const reload = useCallback(async () => {
    setError(null);
    setIndex(null);
    setBills([]);
    setCursor(0);
    try {
      const idx = await listBillRefs(connection, status);
      setIndex(idx);
      setBills(await fetchBillsByAddress(connection, idx.slice(0, PAGE).map((r) => r.address)));
      setCursor(Math.min(PAGE, idx.length));
    } catch (e) {
      setError(friendlyError(e));
      setIndex((i) => i ?? []);
    }
  }, [connection, status]);

  useEffect(() => {
    if (enabled && !started.current) {
      started.current = true;
      reload();
    }
  }, [enabled, reload]);

  const loadMore = useCallback(async () => {
    if (!index) return;
    setLoadingMore(true);
    try {
      const next = await fetchBillsByAddress(
        connection,
        index.slice(cursor, cursor + PAGE).map((r) => r.address),
      );
      setBills((b) => [...b, ...next]);
      setCursor((c) => Math.min(c + PAGE, index.length));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoadingMore(false);
    }
  }, [connection, index, cursor]);

  return {
    bills,
    total: index ? index.length : null,
    loading: started.current && index === null,
    hasMore: !!index && cursor < index.length,
    loadingMore,
    error,
    reload,
    loadMore,
  };
}

// Everyone's totals, shared by the leaderboard and the pay page (cached for a few seconds).
let boardCache: { at: number; p: Promise<SupporterRef[]> } | null = null;
function invalidateBoard() {
  boardCache = null;
}
function useBoardRefs() {
  const { connection } = useConnection();
  const [refs, setRefs] = useState<SupporterRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!boardCache || Date.now() - boardCache.at > 15_000) {
      const p = listSupporterRefs(connection);
      boardCache = { at: Date.now(), p };
      p.catch(() => {
        if (boardCache?.p === p) boardCache = null;
      });
    }
    boardCache.p.then(
      (r) => {
        setError(null);
        setRefs(r);
      },
      (e) => {
        setError(friendlyError(e));
        setRefs((r) => r ?? []);
      },
    );
  }, [connection]);
  useEffect(load, [load]);
  const reload = useCallback(() => {
    invalidateBoard();
    load();
  }, [load]);
  return { refs, error, reload };
}

/** Bills the wallet posted, plus receipts for bills it paid (two filtered queries). */
function useMyBills(user?: PublicKey) {
  const { connection } = useConnection();
  const [data, setData] = useState<{ made: Bill[]; receipts: Receipt[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = user?.toBase58() ?? "none";
  const reload = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const [made, receipts] = await Promise.all([
        fetchBills(connection, { creator: user }),
        fetchReceipts(connection, user),
      ]);
      setData({ made, receipts });
    } catch (e) {
      setError(friendlyError(e));
      setData((d) => d ?? { made: [], receipts: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, key]);
  useEffect(() => {
    setData(null);
    reload();
  }, [reload]);
  return { data, error, reload };
}

function useSender() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  return useCallback(
    async (ixs: TransactionInstruction[]): Promise<string> => {
      if (!publicKey) throw new Error("Connect your wallet first.");
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
      const signature = await sendTransaction(tx, connection);
      const res = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (res.value.err) throw new Error("Transaction failed: " + JSON.stringify(res.value.err));
      return signature;
    },
    [connection, publicKey, sendTransaction],
  );
}

/* ---------------------------------------------------------------- icons */

const Check = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M3 8.5l3.2 3L13 4.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Logo = () => (
  <svg width="30" height="30" viewBox="0 0 64 64" aria-hidden>
    <rect width="64" height="64" rx="17" fill="var(--red)" />
    <path d="M20 17h24v31l-6-4.2-6 4.2-6-4.2-6 4.2z" fill="var(--panel)" />
    <path d="M28.5 26h.5M35 26h.5M26 31.5Q32 36.5 38 31.5" stroke="var(--red)" strokeWidth="3" strokeLinecap="round" fill="none" />
  </svg>
);

/* ---------------------------------------------------------------- theme */

function applyTheme(dark: boolean) {
  if (dark) document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#262624" : "#f5ede0");
}

function storedTheme(): "dark" | "light" | null {
  try {
    const t = localStorage.getItem("theme");
    return t === "dark" || t === "light" ? t : null;
  } catch {
    return null;
  }
}

/** Follows the system theme until the person picks one with the toggle. */
function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.getAttribute("data-theme") === "dark");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => {
      if (storedTheme()) return;
      applyTheme(mq.matches);
      setDark(mq.matches);
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const flip = () => {
    const next = !dark;
    setDark(next);
    applyTheme(next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* storage can be blocked; the toggle still works for this visit */
    }
  };
  return (
    <button className="theme" onClick={flip} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} title={dark ? "Light mode" : "Dark mode"}>
      {dark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

/* ---------------------------------------------------------------- wallet */

function WalletChip() {
  const { wallets, select, disconnect, connected, connecting, publicKey } = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const on = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, []);

  const detected = wallets.filter(
    (w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable,
  );

  return (
    <div className="chip-wrap" ref={ref}>
      <button className="chip" onClick={() => setOpen((o) => !o)} aria-haspopup="menu">
        <span className={"dot" + (connected ? " on" : "")} />
        {connected && publicKey ? short(publicKey) : connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {open && (
        <div className="menu" role="menu">
          {connected ? (
            <>
              <button
                className="menu-item"
                onClick={() => {
                  navigator.clipboard?.writeText(publicKey!.toBase58());
                  setOpen(false);
                }}
              >
                Copy address
              </button>
              <a className="menu-item" href="/mine" onClick={() => setOpen(false)}>
                My bills
              </a>
              <button
                className="menu-item"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </>
          ) : detected.length ? (
            detected.map((w) => (
              <button
                key={w.adapter.name}
                className="menu-item"
                onClick={() => {
                  select(w.adapter.name);
                  setOpen(false);
                }}
              >
                <img src={w.adapter.icon} alt="" width={20} height={20} />
                {w.adapter.name}
              </button>
            ))
          ) : (
            <div className="menu-empty">
              No Solana wallet found.
              <br />
              <a href="https://phantom.com/download" target="_blank" rel="noreferrer">
                Get Phantom ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- cards */

function Amount({ lamports, usd, big }: { lamports: bigint; usd: number | null; big?: boolean }) {
  return (
    <div className={"amount" + (big ? " big" : "")}>
      <div className="amt">
        {fmtSol(lamports)} <small>SOL</small>
      </div>
      {usd && <div className="usd">≈ {fmtUsd(lamportsToSol(lamports) * usd)}</div>}
    </div>
  );
}

function BillCard({ bill, usd, mine, byAddress }: { bill: Bill; usd: number | null; mine: boolean; byAddress?: boolean }) {
  return (
    <a className={"card" + (bill.paid ? " paid" : "")} href={byAddress ? `/b/${bill.address.toBase58()}` : billPath(bill)}>
      <div className="card-main">
        <div className="card-title">{bill.title}</div>
        {bill.note && <div className="card-note">{bill.note}</div>}
        <div className="card-meta">
          <span className="pill">{short(bill.creator)}</span>
          {mine && <span className="pill dark">yours</span>}
          <span>{timeAgo(bill.createdAt)}</span>
        </div>
        {!bill.paid && bill.raised > 0n && <Progress bill={bill} />}
      </div>
      <div className="card-side">
        <Amount lamports={bill.lamports} usd={usd} />
        {bill.paid ? (
          <span className="badge">
            <Check /> Paid
          </span>
        ) : (
          <span className="btn red sm">{mine ? "Share" : "Pay"}</span>
        )}
      </div>
    </a>
  );
}

function Progress({ bill }: { bill: Bill }) {
  const pct = Number((bill.raised * 1000n) / bill.lamports) / 10;
  return (
    <div className="progress">
      <div className="bar">
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span>
        {fmtSol(bill.raised)} of {fmtSol(bill.lamports)} SOL
      </span>
    </div>
  );
}

function ReceiptCard({ r, usd }: { r: Receipt; usd: number | null }) {
  return (
    <a className="card paid" href={`/r/${r.address.toBase58()}`}>
      <div className="card-main">
        <div className="card-title">{r.title}</div>
        {r.note && <div className="card-note">{r.note}</div>}
        <div className="card-meta">
          <span className="pill">{short(r.creator)}</span>
          <span className="pill dark">you paid</span>
          <span>{timeAgo(r.paidAt)}</span>
        </div>
      </div>
      <div className="card-side">
        <Amount lamports={r.lamports} usd={usd} />
        <span className="badge">
          <Check /> Receipt
        </span>
      </div>
    </a>
  );
}

function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children}
    </div>
  );
}

function Skeletons() {
  return (
    <div className="list">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card skel" />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- pages */

const whoLabel = (s: Supporter | undefined, owner: PublicKey) => (s?.name ? s.name : short(owner));

function Handle({ handle }: { handle: string }) {
  if (!handle) return null;
  return (
    <a className="handle" href={`https://x.com/${handle}`} target="_blank" rel="noreferrer">
      @{handle}
    </a>
  );
}

function Leaderboard() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { refs, error } = useBoardRefs();
  const [kind, setKind] = useState<"all" | "today">("all");
  const [people, setPeople] = useState<Map<string, Supporter>>(new Map());

  const ranked = useMemo(() => (refs ? (kind === "all" ? rankAllTime(refs) : rankToday(refs)) : null), [refs, kind]);
  const top = ranked?.slice(0, 5) ?? [];
  const topKey = top.map((r) => r.address.toBase58()).join(",");

  useEffect(() => {
    if (!top.length) return;
    let live = true;
    fetchSupporters(connection, top.map((r) => r.address))
      .then((list) => {
        if (live)
          setPeople((m) => {
            const n = new Map(m);
            list.forEach((x) => n.set(x.address.toBase58(), x));
            return n;
          });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, topKey]);

  const myIdx = ranked && publicKey ? ranked.findIndex((r) => r.owner.equals(publicKey)) : -1;
  const value = (r: SupporterRef) => (kind === "all" ? r.total : r.dayTotal);

  return (
    <section className="board" aria-label="Top supporters">
      <div className="board-head">
        <h2>Top supporters</h2>
        <div className="seg">
          <button className={kind === "all" ? "on" : ""} onClick={() => setKind("all")}>
            All time
          </button>
          <button className={kind === "today" ? "on" : ""} onClick={() => setKind("today")}>
            Today
          </button>
        </div>
      </div>
      <div className="fine">
        {kind === "all"
          ? "Who has paid the most towards other people’s bills."
          : `Resets at 00:00 UTC, in ${fmtDuration(secondsToReset())}.`}
      </div>
      {error && <div className="notice">Couldn’t load the ranking: {error}</div>}
      {ranked === null ? (
        <div className="board-rows">
          {[0, 1, 2].map((i) => (
            <div key={i} className="board-row skel" />
          ))}
        </div>
      ) : top.length === 0 ? (
        <div className="board-empty">
          {kind === "all" ? "Nobody yet." : "Nobody yet today."} Pay a bill and take the first spot.
        </div>
      ) : (
        <div className="board-rows">
          {top.map((r, i) => {
            const person = people.get(r.address.toBase58());
            const me = !!publicKey && r.owner.equals(publicKey);
            return (
              <div key={r.address.toBase58()} className={"board-row" + (i === 0 ? " first" : "")}>
                <span className="rank">{i + 1}</span>
                <span className="who">
                  <b title={r.owner.toBase58()}>{whoLabel(person, r.owner)}</b>
                  {me && <span className="pill dark">you</span>}
                  {person && <Handle handle={person.handle} />}
                </span>
                <span className="amt sm">
                  {fmtSol(value(r))} <small>SOL</small>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {myIdx >= 5 && <div className="fine">You’re #{myIdx + 1}.</div>}
    </section>
  );
}

function Explore() {
  const { publicKey } = useWallet();
  const usd = useSolUsd();
  const [tab, setTab] = useState<"open" | "paid">("open");
  const open = usePagedBills(0, true);
  const paid = usePagedBills(1, tab === "paid"); // only fetched once the Paid tab is opened
  const cur = tab === "open" ? open : paid;

  return (
    <>
      <section className="hero">
        <h1>
          Post a bill.
          <br />
          <span className="red">A stranger pays it.</span>
        </h1>
        <p>Wallet to wallet on Solana. No servers, no middlemen, no custody.</p>
        <div className="hero-actions">
          <a className="btn red lg" href="/new">
            Post a bill
          </a>
          <a className="btn ghost lg" href="#how">
            How it works
          </a>
        </div>
      </section>

      <Leaderboard />

      <div className="tabs" role="tablist">
        <button className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>
          Open {open.total !== null && <span>{open.total}</span>}
        </button>
        <button className={tab === "paid" ? "on" : ""} onClick={() => setTab("paid")}>
          Paid {paid.total !== null && <span>{paid.total}</span>}
        </button>
        <button className="refresh" onClick={cur.reload} aria-label="Refresh">
          ↻
        </button>
      </div>

      {cur.error && <div className="notice">Couldn’t load bills: {cur.error}</div>}
      {cur.loading || cur.total === null ? (
        <Skeletons />
      ) : cur.bills.length === 0 ? (
        tab === "open" ? (
          <Empty title="No open bills right now">
            <a className="btn red" href="/new">
              Be the first to post one
            </a>
          </Empty>
        ) : (
          <Empty title="Nothing paid yet" />
        )
      ) : (
        <>
          <div className="list">
            {cur.bills.map((b) => (
              <BillCard key={b.address.toBase58()} bill={b} usd={usd} mine={!!publicKey && b.creator.equals(publicKey)} />
            ))}
          </div>
          {cur.hasMore && (
            <div className="more">
              <button className="btn" onClick={cur.loadMore} disabled={cur.loadingMore}>
                {cur.loadingMore ? "Loading…" : "Show more"}
              </button>
            </div>
          )}
        </>
      )}

      <section className="how" id="how">
        <h2>How it works</h2>
        <ol>
          <li>
            <b>Post.</b> Connect a wallet, name the bill and the amount. It’s stored on Solana.
          </li>
          <li>
            <b>Share.</b> Send the link anywhere, or let people find it here.
          </li>
          <li>
            <b>Get paid.</b> When someone pays, the SOL goes straight to your wallet and the bill flips to paid.
          </li>
        </ol>
      </section>
    </>
  );
}

function NewBill() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const send = useSender();
  const toast = useToast();
  const usdRate = useSolUsd();

  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [cur, setCur] = useState<"SOL" | "USD">("SOL");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [rent, setRent] = useState<number | null>(null);
  const [cover, setCover] = useState(false);

  useEffect(() => {
    connection
      .getMinimumBalanceForRentExemption(BILL_ACCOUNT_SIZE)
      .then((l) => setRent(l / 1e9))
      .catch(() => {});
  }, [connection]);

  const n = parseAmount(amt);
  const sol = useMemo(() => {
    if (!Number.isFinite(n) || n <= 0) return NaN;
    if (cur === "SOL") return n;
    if (!usdRate) return NaN;
    return Math.max(0.0001, Math.round((n / usdRate) * 1e4) / 1e4);
  }, [n, cur, usdRate]);

  const tBytes = byteLen(title);
  const nBytes = byteLen(note);
  // What gets posted (and asked from the payer). With "cover", the amount is
  // grossed up so the creator nets the typed amount after the fee.
  const typed = Number.isFinite(sol) && sol > 0 ? solToLamports(sol) : 0n;
  const posted = cover ? (typed * 10_000n + (10_000n - FEE_BPS) - 1n) / (10_000n - FEE_BPS) : typed;
  const net = posted - feeFor(posted);
  const valid = title.trim().length > 0 && tBytes <= TITLE_MAX && nBytes <= NOTE_MAX && posted > 0n;

  async function submit() {
    if (!publicKey || !valid) return;
    setBusy(true);
    try {
      const id = randomId();
      const { ix } = createBillIx(publicKey, id, posted, title.trim(), note.trim());
      const sig = await send([ix]);
      toast("Bill posted. Share the link!", explorerTx(sig));
      go(billPath({ title: title.trim(), id }));
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel form">
      <h2>Post a bill</h2>
      <p className="sub">Say what you need covered. Anyone can choose to pay it.</p>

      <label>
        <span className="lbl">
          What is it? <em className={tBytes > TITLE_MAX ? "bad" : ""}>{tBytes}/{TITLE_MAX}</em>
        </span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Electricity bill, October" autoFocus />
      </label>

      <label>
        <span className="lbl">How much?</span>
        <div className="amount-row">
          <input
            inputMode="decimal"
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
            placeholder={cur === "SOL" ? "0.5" : "10"}
          />
          <div className="seg">
            <button type="button" className={cur === "SOL" ? "on" : ""} onClick={() => setCur("SOL")}>
              SOL
            </button>
            <button
              type="button"
              className={cur === "USD" ? "on" : ""}
              onClick={() => setCur("USD")}
              disabled={!usdRate}
              title={usdRate ? "" : "USD rate unavailable"}
            >
              USD
            </button>
          </div>
        </div>
        {Number.isFinite(sol) && (
          <span className="hint">
            {cur === "USD" ? (
              <>Locks in at <b>{fmtSol(solToLamports(sol), 4)} SOL</b> at today’s rate. The bill itself is priced in SOL.</>
            ) : usdRate ? (
              <>≈ {fmtUsd(sol * usdRate)} at today’s rate.</>
            ) : null}
          </span>
        )}
      </label>

      <label className="check">
        <input type="checkbox" checked={cover} onChange={(e) => setCover(e.target.checked)} />
        <span>Add the 3% fee on top so I receive the full amount</span>
      </label>
      {posted > 0n && (
        <div className="summary">
          <div>
            <span>People are asked for</span>
            <b>{fmtSol(posted, 5)} SOL</b>
          </div>
          <div>
            <span>You receive (after 3% fee)</span>
            <b>{fmtSol(net, 5)} SOL</b>
          </div>
        </div>
      )}

      <label>
        <span className="lbl">
          Note <i>(optional)</i> <em className={nBytes > NOTE_MAX ? "bad" : ""}>{nBytes}/{NOTE_MAX}</em>
        </span>
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Short context so people know what they’re helping with."
        />
      </label>

      <div className="fine">
        paymybill.fun keeps 3% of each paid bill. Posting reserves a small refundable deposit{rent ? ` (~${rent.toFixed(4)} SOL)` : ""} on Solana. You get it back
        when you close the bill.
      </div>

      {publicKey ? (
        <button className="btn red lg block" disabled={!valid || busy} onClick={submit}>
          {busy ? "Posting…" : "Post bill"}
        </button>
      ) : (
        <div className="notice">Connect your wallet (top right) to post.</div>
      )}
    </div>
  );
}

function SupporterCard({ owner }: { owner: PublicKey }) {
  const { connection } = useConnection();
  const send = useSender();
  const toast = useToast();
  const [card, setCard] = useState<Supporter | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [rent, setRent] = useState<bigint>(1_800_000n);

  const load = useCallback(async () => {
    try {
      const c = await fetchSupporter(connection, owner);
      setCard(c);
      setName(c?.name ?? "");
      setHandle(c?.handle ?? "");
    } catch {
      setCard(null);
    }
  }, [connection, owner]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    connection
      .getMinimumBalanceForRentExemption(SUPPORTER_ACCOUNT_SIZE)
      .then((l) => setRent(BigInt(l)))
      .catch(() => {});
  }, [connection]);

  const nameOk = byteLen(name.trim()) <= NAME_MAX;
  const changed = card ? name.trim() !== card.name || handle !== card.handle : name.trim() !== "" || handle !== "";

  async function save() {
    setBusy(true);
    try {
      const sig = await send([setSupporterIx(owner, name.trim(), handle)]);
      toast(card ? "Card updated." : "Card created.", explorerTx(sig));
      invalidateBoard();
      await load();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      const sig = await send([closeSupporterIx(owner)]);
      toast("Card removed. Deposit refunded.", explorerTx(sig));
      invalidateBoard();
      setConfirm(false);
      await load();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (card === undefined) return null;
  return (
    <section className="mycard">
      <h3 className="sec-title">Supporter card</h3>
      <div className="fine">
        {card
          ? `You’ve paid ${fmtSol(card.total)} SOL across ${card.billsHelped} bill${card.billsHelped === 1 ? "" : "s"}${card.day === utcDay() ? `, ${fmtSol(card.dayTotal)} SOL today` : ""}.`
          : "Pay a bill and you’ll show up on the leaderboard. You can pick the name and X handle people see here."}
      </div>
      <div className="mycard-form">
        <input value={name} maxLength={40} placeholder="Name (optional)" onChange={(e) => setName(e.target.value.replace(/[\u0000-\u001f\u007f]/g, ""))} />
        <input
          value={handle}
          placeholder="X handle (optional)"
          onChange={(e) => setHandle(e.target.value.replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, HANDLE_MAX))}
        />
        <button className="btn red sm" disabled={busy || !nameOk || !changed} onClick={save}>
          {busy ? "…" : card ? "Save" : "Create card"}
        </button>
      </div>
      {!nameOk && <div className="fine bad">Name is too long (max {NAME_MAX} bytes).</div>}
      {!card && <div className="fine">Creating a card holds a refundable deposit of ≈ {fmtSol(rent, 4)} SOL.</div>}
      {card &&
        (confirm ? (
          <span className="confirm">
            Remove card, lose your ranking and get the deposit back?
            <button className="link danger" disabled={busy} onClick={remove}>
              Yes
            </button>
            <button className="link" onClick={() => setConfirm(false)}>
              No
            </button>
          </span>
        ) : (
          <button className="link danger" onClick={() => setConfirm(true)}>
            Remove card
          </button>
        ))}
    </section>
  );
}

function Mine() {
  const { publicKey } = useWallet();
  const usd = useSolUsd();
  const { data, error, reload } = useMyBills(publicKey ?? undefined);
  const send = useSender();
  const toast = useToast();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!publicKey) return <Empty title="Connect your wallet to see your bills" />;

  async function remove(address: PublicKey, kind: "bill" | "receipt") {
    const k = address.toBase58();
    setBusy(k);
    try {
      const ix = kind === "bill" ? closeBillIx(publicKey!, address) : closeReceiptIx(publicKey!, address);
      const sig = await send([ix]);
      toast(kind === "bill" ? "Bill closed. Deposit refunded." : "Receipt removed. Deposit refunded.", explorerTx(sig));
      setConfirming(null);
      await reload();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  function Actions({ k, address, kind, label, prompt, link }: { k: string; address: PublicKey; kind: "bill" | "receipt"; label: string; prompt: string; link?: string }) {
    return (
      <div className="mine-actions">
        {link && (
          <button
            className="link"
            onClick={() => {
              navigator.clipboard?.writeText(link);
              toast("Link copied");
            }}
          >
            Copy link
          </button>
        )}
        {confirming === k ? (
          <span className="confirm">
            {prompt}
            <button className="link danger" disabled={busy === k} onClick={() => remove(address, kind)}>
              {busy === k ? "Closing…" : "Yes"}
            </button>
            <button className="link" onClick={() => setConfirming(null)}>
              No
            </button>
          </span>
        ) : (
          <button className="link danger" onClick={() => setConfirming(k)}>
            {label}
          </button>
        )}
      </div>
    );
  }

  const made = data?.made ?? [];
  const receipts = data?.receipts ?? [];

  return (
    <>
      <div className="page-head">
        <h2>My bills</h2>
        <a className="btn red sm" href="/new">
          New bill
        </a>
      </div>
      <SupporterCard owner={publicKey} />
      {error && <div className="notice">Couldn’t load bills: {error}</div>}
      {data === null ? (
        <Skeletons />
      ) : made.length === 0 && receipts.length === 0 ? (
        <Empty title="No bills yet">
          <a className="btn red" href="/new">
            Post your first bill
          </a>
        </Empty>
      ) : (
        <>
          <h3 className="sec-title">
            Bills I posted <span>{made.length}</span>
          </h3>
          {made.length === 0 ? (
            <div className="sec-empty">Nothing here yet.</div>
          ) : (
            <div className="list">
              {made.map((b) => {
                const k = b.address.toBase58();
                return (
                  <div key={k} className="mine-row">
                    <BillCard bill={b} usd={usd} mine />
                    <Actions
                      k={k}
                      address={b.address}
                      kind="bill"
                      link={billLink(b)}
                      label={b.paid ? "Remove" : "Cancel bill"}
                      prompt={b.paid ? "Remove bill and refund deposit?" : "Cancel this bill?"}
                    />
                  </div>
                );
              })}
            </div>
          )}
          <h3 className="sec-title">
            Receipts for bills I paid <span>{receipts.length}</span>
          </h3>
          {receipts.length === 0 ? (
            <div className="sec-empty">Nothing here yet.</div>
          ) : (
            <div className="list">
              {receipts.map((r) => {
                const k = r.address.toBase58();
                return (
                  <div key={k} className="mine-row">
                    <ReceiptCard r={r} usd={usd} />
                    <Actions
                      k={k}
                      address={r.address}
                      kind="receipt"
                      label="Remove receipt"
                      prompt="Remove receipt and refund deposit?"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}

function ReceiptPage({ addr }: { addr: string }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const send = useSender();
  const toast = useToast();
  const usd = useSolUsd();
  const [r, setR] = useState<Receipt | null | undefined>(undefined);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const pk = new PublicKey(addr);
        const got = await fetchReceipt(connection, pk);
        if (live) setR(got);
      } catch {
        if (live) setR(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [connection, addr]);

  if (r === undefined) return <div className="panel skel tall" />;
  if (!r) {
    return (
      <Empty title="Receipt not found">
        It may have been removed or the link is wrong.
        <a className="btn" href="/mine">
          My bills
        </a>
      </Empty>
    );
  }
  const mine = !!publicKey && r.payer.equals(publicKey);
  const fee = feeFor(r.lamports);

  async function remove() {
    setBusy(true);
    try {
      const sig = await send([closeReceiptIx(publicKey!, r!.address)]);
      toast("Receipt removed. Deposit refunded.", explorerTx(sig));
      go("/mine");
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel detail">
      <a className="back" href="/mine">
        ← My bills
      </a>
      <div className="detail-top">
        <div>
          <h2>{r.title}</h2>
          <div className="card-meta">
            <span>Paid to</span>
            <a className="pill" href={explorerAddr(r.creator.toBase58())} target="_blank" rel="noreferrer" title={r.creator.toBase58()}>
              {short(r.creator, 5)}
            </a>
            <span>{timeAgo(r.paidAt)}</span>
          </div>
        </div>
        <Amount lamports={r.lamports} usd={usd} big />
      </div>
      {r.note && <p className="note">{r.note}</p>}
      <div className="receipt">
        <div className="badge big">
          <Check /> Receipt
        </div>
        <div className="breakdown">
          <div>
            <span>To the creator</span>
            <span>{fmtSol(r.lamports - fee, 6)} SOL</span>
          </div>
          <div>
            <span>Service fee (3%)</span>
            <span>{fmtSol(fee, 6)} SOL</span>
          </div>
          <div>
            <span>Paid by</span>
            <a href={explorerAddr(r.payer.toBase58())} target="_blank" rel="noreferrer">
              {short(r.payer, 5)}
            </a>
          </div>
        </div>
        <div className="fine">
          This receipt is your own copy, stored on Solana. It stays even if the creator closes the bill.
        </div>
        {mine &&
          (confirm ? (
            <div className="row">
              <button className="btn ghost" onClick={() => setConfirm(false)} disabled={busy}>
                Keep it
              </button>
              <button className="btn red grow" onClick={remove} disabled={busy}>
                {busy ? "Confirm in your wallet…" : "Remove and refund deposit"}
              </button>
            </div>
          ) : (
            <button className="link danger" onClick={() => setConfirm(true)}>
              Remove receipt
            </button>
          ))}
      </div>
    </div>
  );
}

type Backer = { r: Receipt; s?: Supporter };

function BillPage({ addr }: { addr: string }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const send = useSender();
  const toast = useToast();
  const usd = useSolUsd();
  const board = useBoardRefs();

  const pk = useMemo(() => {
    try {
      return new PublicKey(addr);
    } catch {
      return null;
    }
  }, [addr]);

  const [bill, setBill] = useState<Bill | null | undefined>(undefined);
  const [backers, setBackers] = useState<Backer[] | null>(null);
  const [me, setMe] = useState<Supporter | null | undefined>(undefined);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [rent, setRent] = useState<{ receipt: bigint; card: bigint }>({ receipt: 3_300_000n, card: 1_800_000n });
  const [step, setStep] = useState<"view" | "confirm">("view");
  const [pick, setPick] = useState<"rest" | "half" | "quarter" | "custom">("rest");
  const [custom, setCustom] = useState("");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [showId, setShowId] = useState(false);
  const [busy, setBusy] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!pk) return setBill(null);
    try {
      const b = await fetchBill(connection, pk);
      setBill(b);
      if (b) {
        const rs = await fetchReceiptsForBill(connection, pk);
        const sup = await fetchSupporters(connection, rs.map((r) => deriveSupporter(r.payer))).catch(() => []);
        const byOwner = new Map(sup.map((x) => [x.owner.toBase58(), x]));
        setBackers(
          rs
            .sort((x, y) => (x.lamports === y.lamports ? 0 : x.lamports > y.lamports ? -1 : 1))
            .map((r) => ({ r, s: byOwner.get(r.payer.toBase58()) })),
        );
      }
    } catch {
      setBill(null);
    }
  }, [connection, pk]);

  useEffect(() => {
    setBill(undefined);
    setBackers(null);
    load();
  }, [load]);

  useEffect(() => {
    Promise.all([
      connection.getMinimumBalanceForRentExemption(RECEIPT_ACCOUNT_SIZE),
      connection.getMinimumBalanceForRentExemption(SUPPORTER_ACCOUNT_SIZE),
    ])
      .then(([receipt, card]) => setRent({ receipt: BigInt(receipt), card: BigInt(card) }))
      .catch(() => {});
  }, [connection]);

  const loadMe = useCallback(async () => {
    if (!publicKey) return setMe(undefined);
    try {
      const c = await fetchSupporter(connection, publicKey);
      setMe(c);
      setName(c?.name ?? "");
      setHandle(c?.handle ?? "");
    } catch {
      setMe(null);
    }
  }, [connection, publicKey]);
  useEffect(() => {
    loadMe();
  }, [loadMe]);

  useEffect(() => {
    if (!publicKey) return setBalance(null);
    connection
      .getBalance(publicKey, "confirmed")
      .then((l) => setBalance(BigInt(l)))
      .catch(() => {});
  }, [connection, publicKey, bill?.raised]);

  if (bill === undefined) return <div className="panel skel tall" />;
  if (!bill) {
    return (
      <Empty title="Bill not found">
        It may have been cancelled or the link is wrong.
        <a className="btn" href="/">
          Back to bills
        </a>
      </Empty>
    );
  }

  const mine = !!publicKey && bill.creator.equals(publicKey);
  const short_ = short(bill.creator, 5);
  const remaining = bill.lamports - bill.raised;
  const contrib: bigint | null =
    pick === "rest"
      ? remaining
      : pick === "half"
        ? remaining / 2n
        : pick === "quarter"
          ? remaining / 4n
          : Number.isFinite(parseAmount(custom)) && parseAmount(custom) > 0
            ? solToLamports(parseAmount(custom))
            : null;
  const tooSmall = contrib !== null && contrib < MIN_CONTRIB && contrib !== remaining;
  const tooBig = contrib !== null && contrib > remaining;
  const nameOk = byteLen(name.trim()) <= NAME_MAX;
  const valid = contrib !== null && contrib > 0n && !tooSmall && !tooBig && nameOk;
  const fee = valid ? feeFor(contrib!) : 0n;
  const toCreator = valid ? contrib! - fee : 0n;

  const iPaid = !!publicKey && !!backers?.some((x) => x.r.payer.equals(publicKey));
  const deposits = (iPaid ? 0n : rent.receipt) + (me ? 0n : rent.card);
  const enough = balance === null || !valid || balance >= contrib! + deposits + 20_000n;

  const rankAll = valid && board.refs ? rankIfPaying(board.refs, publicKey, contrib!, "all") : null;
  const rankDay = valid && board.refs ? rankIfPaying(board.refs, publicKey, contrib!, "today") : null;

  async function pay() {
    if (!publicKey || !bill || !valid) return;
    setBusy(true);
    try {
      const sig = await send([payBillIx(publicKey, bill, contrib!, name.trim(), handle)]);
      setTxSig(sig);
      toast(contrib === remaining ? "Bill paid. Thank you!" : "Thanks for chipping in!", explorerTx(sig));
      setStep("view");
      setPick("rest");
      setCustom("");
      board.reload();
      await Promise.all([load(), loadMe()]);
    } catch (e) {
      toast(friendlyError(e));
      await load();
    } finally {
      setBusy(false);
    }
  }

  const chip = (id: typeof pick, label: string, amount: bigint) => {
    const ok = amount >= MIN_CONTRIB || amount === remaining;
    return (
      <button key={id} className={"chip-btn" + (pick === id ? " on" : "")} disabled={!ok || amount <= 0n} onClick={() => setPick(id)}>
        {label}
        <small>{fmtSol(amount)} SOL</small>
      </button>
    );
  };

  const shareText = encodeURIComponent(`I just helped pay "${bill.title}" on paymybill.fun`);
  const shareHref = `https://x.com/intent/post?text=${shareText}&url=${encodeURIComponent(billLink(bill))}`;

  return (
    <div className="panel detail">
      <a className="back" href="/">
        ← All bills
      </a>
      <div className="detail-top">
        <div>
          <h2>{bill.title}</h2>
          <div className="card-meta">
            <span>Posted by</span>
            <a className="pill" href={explorerAddr(bill.creator.toBase58())} target="_blank" rel="noreferrer" title={bill.creator.toBase58()}>
              {short_}
            </a>
            {mine && <span className="pill dark">you</span>}
            <span>{timeAgo(bill.createdAt)}</span>
          </div>
        </div>
        <Amount lamports={bill.lamports} usd={usd} big />
      </div>

      {bill.note && <p className="note">{bill.note}</p>}

      {!bill.paid && bill.raised > 0n && (
        <div className="progress-box">
          <Progress bill={bill} />
          <div className="fine">
            {bill.backers} {bill.backers === 1 ? "person has" : "people have"} chipped in. {fmtSol(remaining)} SOL left.
          </div>
        </div>
      )}

      {bill.paid ? (
        <div className="receipt">
          <div className="badge big">
            <Check /> Paid in full
          </div>
          <div className="fine">
            {bill.backers} {bill.backers === 1 ? "supporter" : "supporters"} · {timeAgo(bill.paidAt)}
            {txSig && (
              <>
                {" "}
                ·{" "}
                <a href={explorerTx(txSig)} target="_blank" rel="noreferrer">
                  View tx ↗
                </a>
              </>
            )}
          </div>
          {txSig && (
            <a className="link" href={shareHref} target="_blank" rel="noreferrer">
              Share on X ↗
            </a>
          )}
        </div>
      ) : mine ? (
        <div className="pay-box">
          <div className="fine">This is your bill. Share it so people can chip in.</div>
          <div className="share">
            <input readOnly value={billLink(bill)} onFocus={(e) => e.currentTarget.select()} />
            <button
              className="btn red"
              onClick={() => {
                navigator.clipboard?.writeText(billLink(bill));
                toast("Link copied");
              }}
            >
              Copy
            </button>
          </div>
        </div>
      ) : !publicKey ? (
        <div className="pay-box">
          <div className="notice">Connect your wallet (top right) to pay this bill.</div>
        </div>
      ) : step === "view" ? (
        <div className="pay-box">
          {iPaid && <div className="fine">You already put money into this bill. You can add more.</div>}
          <div className="lbl">
            <span>How much do you want to pay?</span>
          </div>
          <div className="chips">
            {chip("rest", "All", remaining)}
            {chip("half", "Half", remaining / 2n)}
            {chip("quarter", "Quarter", remaining / 4n)}
            <label className={"chip-btn input" + (pick === "custom" ? " on" : "")}>
              <input
                inputMode="decimal"
                placeholder="Other"
                value={custom}
                onFocus={() => setPick("custom")}
                onChange={(e) => {
                  setPick("custom");
                  setCustom(e.target.value);
                }}
              />
              <small>SOL</small>
            </label>
          </div>
          {tooSmall && <div className="fine bad">The minimum is {fmtSol(MIN_CONTRIB, 3)} SOL, unless you pay what’s left.</div>}
          {tooBig && <div className="fine bad">Only {fmtSol(remaining)} SOL is left on this bill.</div>}
          {valid && rankAll !== null && rankDay !== null && (
            <div className="teaser">
              {rankAll === 1 ? "You’d take #1 all-time" : `You’d be #${rankAll} all-time`} · {rankDay === 1 ? "#1" : `#${rankDay}`} today
            </div>
          )}
          {showId ? (
            <div className="idfields">
              <input value={name} maxLength={40} placeholder="Name on the leaderboard (optional)" onChange={(e) => setName(e.target.value.replace(/[\u0000-\u001f\u007f]/g, ""))} />
              <input
                value={handle}
                placeholder="X handle (optional)"
                onChange={(e) => setHandle(e.target.value.replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, HANDLE_MAX))}
              />
              {!nameOk && <div className="fine bad">Name is too long (max {NAME_MAX} bytes).</div>}
            </div>
          ) : (
            <button className="link" onClick={() => setShowId(true)}>
              {me?.name || me?.handle ? "Edit the name shown on the leaderboard" : "Add my name and X handle to the leaderboard"}
            </button>
          )}
          <button className="btn red lg block" disabled={!valid} onClick={() => setStep("confirm")}>
            Pay {valid ? fmtSol(contrib!, 4) : "…"} SOL
          </button>
          <div className="fine">Anyone can post a bill, so only pay people you want to help.</div>
        </div>
      ) : (
        <div className="pay-box confirm-box">
          <div className="sum">
            <div>
              You send
              <b>{fmtSol(contrib!, 4)} SOL</b>
            </div>
            <div>
              To
              <b title={bill.creator.toBase58()}>{short_}</b>
            </div>
          </div>
          <div className="breakdown">
            <div>
              <span>To the creator</span>
              <span>{fmtSol(toCreator, 6)} SOL</span>
            </div>
            <div>
              <span>Service fee (3%)</span>
              <span>{fmtSol(fee, 6)} SOL</span>
            </div>
            {deposits > 0n && (
              <div>
                <span>Refundable deposit</span>
                <span>≈ {fmtSol(deposits, 4)} SOL</span>
              </div>
            )}
          </div>
          {!enough && <div className="notice warn">Your wallet doesn’t have enough SOL ({fmtSol(balance ?? 0n)} available).</div>}
          <div className="fine">
            You pay exactly {fmtSol(contrib!, 4)} SOL: 97% goes straight to the creator and 3% to paymybill.fun.
            {deposits > 0n && " The deposit pays for your receipt and leaderboard card on Solana, and you get it back if you remove them."}{" "}
            Payments are final.
          </div>
          <div className="row">
            <button className="btn ghost" onClick={() => setStep("view")} disabled={busy}>
              Back
            </button>
            <button className="btn red grow" onClick={pay} disabled={busy || !enough}>
              {busy ? "Confirm in your wallet…" : "Confirm and pay"}
            </button>
          </div>
        </div>
      )}

      {backers && backers.length > 0 && (
        <div className="backers">
          <h3 className="sec-title">
            Supporters <span>{backers.length}</span>
          </h3>
          {backers.slice(0, 8).map(({ r, s }) => (
            <div key={r.address.toBase58()} className="backer">
              <span className="who">
                <b title={r.payer.toBase58()}>{whoLabel(s, r.payer)}</b>
                {!!publicKey && r.payer.equals(publicKey) && <span className="pill dark">you</span>}
                {s && <Handle handle={s.handle} />}
              </span>
              <span>{fmtSol(r.lamports, 4)} SOL</span>
            </div>
          ))}
          {backers.length > 8 && <div className="fine">and {backers.length - 8} more</div>}
        </div>
      )}
    </div>
  );
}

function BillRoute({ param }: { param: string }) {
  const { connection } = useConnection();
  const parsed = useMemo(() => parseBillParam(param), [param]);
  const [matches, setMatches] = useState<Bill[] | null | undefined>(undefined);
  const usd = useSolUsd();

  useEffect(() => {
    if (!parsed || parsed.kind !== "id") return;
    let live = true;
    setMatches(undefined);
    fetchBillsById(connection, parsed.id)
      .then((m) => live && setMatches(m))
      .catch(() => live && setMatches(null));
    return () => {
      live = false;
    };
  }, [connection, parsed]);

  const notFound = (
    <Empty title="Bill not found">
      It may have been cancelled or the link is wrong.
      <a className="btn" href="/">
        Back to bills
      </a>
    </Empty>
  );
  if (!parsed) return notFound;
  if (parsed.kind === "address") return <BillPage addr={parsed.address} key={parsed.address} />;
  if (matches === undefined) return <div className="panel skel tall" />;
  if (!matches || matches.length === 0) return notFound;
  if (matches.length === 1) return <BillPage addr={matches[0].address.toBase58()} key={matches[0].address.toBase58()} />;
  return (
    <>
      <div className="notice warn">
        More than one bill uses this link. Check who posted each one (the address) before paying.
      </div>
      <div className="list">
        {matches.map((b) => (
          <BillCard key={b.address.toBase58()} bill={b} usd={usd} mine={false} byAddress />
        ))}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- shell */

export function App() {
  const route = useRoute();
  useEffect(() => {
    // in-app links navigate without a page reload (the wallet stays connected)
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element).closest?.("a");
      const href = a?.getAttribute("href");
      if (!a || !href || !href.startsWith("/") || a.target === "_blank") return;
      e.preventDefault();
      go(href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  const [toast, setToast] = useState<{ msg: string; href?: string } | null>(null);
  const timer = useRef<number>();
  const notify = useCallback((msg: string, href?: string) => {
    setToast({ msg, href });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  const page =
    route[0] === "new" ? <NewBill /> : route[0] === "mine" ? <Mine /> : route[0] === "b" && route[1] ? <BillRoute param={route[1]} key={route[1]} /> : route[0] === "r" && route[1] ? <ReceiptPage addr={route[1]} key={route[1]} /> : <Explore />;

  return (
    <ToastCtx.Provider value={notify}>
      <header className="top">
        <div className="wrap top-in">
          <a className="brand" href="/">
            <Logo />
            <span>
              paymybill<span className="red">.fun</span>
            </span>
          </a>
          <nav className="nav">
            <a href="/" className={!route[0] ? "on" : ""}>
              Explore
            </a>
            <a href="/mine" className={route[0] === "mine" ? "on" : ""}>
              My bills
            </a>
          </nav>
          <ThemeToggle />
          <WalletChip />
        </div>
      </header>

      <main className="wrap">{page}</main>

      <footer className="wrap foot">
        <span>No servers. Everything lives on Solana.</span>
        <span className="foot-links">
          {CLUSTER !== "mainnet-beta" && <span className="pill dark">{CLUSTER}</span>}
          <a href={explorerAddr(PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">
            Program ↗
          </a>
          <a href="/agents.md" target="_blank" rel="noreferrer">
            For agents ↗
          </a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Code ↗
          </a>
        </span>
      </footer>
      <ToastHost toast={toast} />
    </ToastCtx.Provider>
  );
}
