import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  BILL_ACCOUNT_SIZE,
  RECEIPT_ACCOUNT_SIZE,
  CLUSTER,
  NOTE_MAX,
  PROGRAM_ID,
  TITLE_MAX,
  byteLen,
  closeBillIx,
  closeReceiptIx,
  fetchReceipt,
  fetchReceipts,
  legacyReceipt,
  createBillIx,
  explorerAddr,
  explorerTx,
  FEE_BPS,
  feeFor,
  fetchBill,
  fetchBills,
  fetchSolUsd,
  lamportsToSol,
  payBillIx,
  randomId,
  solToLamports,
} from "./chain";
import type { Bill, Receipt } from "./chain";
import { billLink, fmtSol, fmtUsd, friendlyError, parseAmount, short, timeAgo } from "./lib";

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
  const read = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => {
      setR(read());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}
const go = (path: string) => {
  location.hash = path;
};

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

function useBills(creator?: PublicKey) {
  const { connection } = useConnection();
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = creator?.toBase58() ?? "all";
  const reload = useCallback(async () => {
    setError(null);
    try {
      setBills(await fetchBills(connection, { creator }));
    } catch (e) {
      setError(friendlyError(e));
      setBills((b) => b ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, key]);
  useEffect(() => {
    setBills(null);
    reload();
  }, [reload]);
  return { bills, error, reload };
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
      const [made, receipts, paid] = await Promise.all([
        fetchBills(connection, { creator: user }),
        fetchReceipts(connection, user),
        fetchBills(connection, { payer: user }),
      ]);
      // bills paid before receipts existed still show up, as read-only receipts
      const have = new Set(receipts.map((r) => r.bill.toBase58()));
      const legacy = paid.filter((b) => !have.has(b.address.toBase58())).map(legacyReceipt);
      const all = [...receipts, ...legacy].sort((x, y) => y.paidAt - x.paidAt);
      setData({ made, receipts: all });
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
    <path d="M27 22.5v6M37 22.5v6" stroke="var(--red)" strokeWidth="3.6" strokeLinecap="round" />
    <path d="M26 35h12" stroke="var(--red)" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

/* ---------------------------------------------------------------- theme */

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.getAttribute("data-theme") === "dark");
  const flip = () => {
    const next = !dark;
    setDark(next);
    if (next) document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next ? "#262624" : "#f5ede0");
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
              <a className="menu-item" href={`#/mine`} onClick={() => setOpen(false)}>
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

function BillCard({ bill, usd, mine }: { bill: Bill; usd: number | null; mine: boolean }) {
  return (
    <a className={"card" + (bill.paid ? " paid" : "")} href={`#/b/${bill.address.toBase58()}`}>
      <div className="card-main">
        <div className="card-title">{bill.title}</div>
        {bill.note && <div className="card-note">{bill.note}</div>}
        <div className="card-meta">
          <span className="pill">{short(bill.creator)}</span>
          {mine && <span className="pill dark">yours</span>}
          <span>{timeAgo(bill.createdAt)}</span>
        </div>
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

function ReceiptCard({ r, usd }: { r: Receipt; usd: number | null }) {
  const href = r.legacy ? `#/b/${r.bill.toBase58()}` : `#/r/${r.address.toBase58()}`;
  return (
    <a className="card paid" href={href}>
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

function Explore() {
  const { publicKey } = useWallet();
  const usd = useSolUsd();
  const { bills, error, reload } = useBills();
  const [tab, setTab] = useState<"open" | "paid">("open");
  const open = bills?.filter((b) => !b.paid) ?? [];
  const paid = bills?.filter((b) => b.paid) ?? [];
  const shown = tab === "open" ? open : paid;

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
          <a className="btn red lg" href="#/new">
            Post a bill
          </a>
          <a className="btn ghost lg" href="#how">
            How it works
          </a>
        </div>
      </section>

      <div className="tabs" role="tablist">
        <button className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>
          Open {bills && <span>{open.length}</span>}
        </button>
        <button className={tab === "paid" ? "on" : ""} onClick={() => setTab("paid")}>
          Paid {bills && <span>{paid.length}</span>}
        </button>
        <button className="refresh" onClick={reload} aria-label="Refresh">
          ↻
        </button>
      </div>

      {error && <div className="notice">Couldn’t load bills: {error}</div>}
      {bills === null ? (
        <Skeletons />
      ) : shown.length === 0 ? (
        tab === "open" ? (
          <Empty title="No open bills right now">
            <a className="btn red" href="#/new">
              Be the first to post one
            </a>
          </Empty>
        ) : (
          <Empty title="Nothing paid yet" />
        )
      ) : (
        <div className="list">
          {shown.map((b) => (
            <BillCard key={b.address.toBase58()} bill={b} usd={usd} mine={!!publicKey && b.creator.equals(publicKey)} />
          ))}
        </div>
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
      const { ix, bill } = createBillIx(publicKey, randomId(), posted, title.trim(), note.trim());
      const sig = await send([ix]);
      toast("Bill posted. Share the link!", explorerTx(sig));
      go(`/b/${bill.toBase58()}`);
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
        <a className="btn red sm" href="#/new">
          New bill
        </a>
      </div>
      {error && <div className="notice">Couldn’t load bills: {error}</div>}
      {data === null ? (
        <Skeletons />
      ) : made.length === 0 && receipts.length === 0 ? (
        <Empty title="No bills yet">
          <a className="btn red" href="#/new">
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
                      link={billLink(k)}
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
                    {!r.legacy && (
                      <Actions
                        k={k}
                        address={r.address}
                        kind="receipt"
                        label="Remove receipt"
                        prompt="Remove receipt and refund deposit?"
                      />
                    )}
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
        <a className="btn" href="#/mine">
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
      <a className="back" href="#/mine">
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

function BillPage({ addr }: { addr: string }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const send = useSender();
  const toast = useToast();
  const usd = useSolUsd();

  const pk = useMemo(() => {
    try {
      return new PublicKey(addr);
    } catch {
      return null;
    }
  }, [addr]);

  const [bill, setBill] = useState<Bill | null | undefined>(undefined);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [step, setStep] = useState<"view" | "confirm">("view");
  const [busy, setBusy] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [rcRent, setRcRent] = useState<bigint>(3_000_000n);

  const load = useCallback(async () => {
    if (!pk) return setBill(null);
    try {
      setBill(await fetchBill(connection, pk));
    } catch {
      setBill(null);
    }
  }, [connection, pk]);

  useEffect(() => {
    setBill(undefined);
    load();
  }, [load]);

  useEffect(() => {
    connection
      .getMinimumBalanceForRentExemption(RECEIPT_ACCOUNT_SIZE)
      .then((l) => setRcRent(BigInt(l)))
      .catch(() => {});
  }, [connection]);

  useEffect(() => {
    if (!publicKey) return setBalance(null);
    connection
      .getBalance(publicKey, "confirmed")
      .then((l) => setBalance(BigInt(l)))
      .catch(() => {});
  }, [connection, publicKey, bill?.paid]);

  if (bill === undefined) return <div className="panel skel tall" />;
  if (!bill) {
    return (
      <Empty title="Bill not found">
        It may have been cancelled or the link is wrong.
        <a className="btn" href="#/">
          Back to bills
        </a>
      </Empty>
    );
  }

  const mine = !!publicKey && bill.creator.equals(publicKey);
  const short_ = short(bill.creator, 5);
  const fee = feeFor(bill.lamports);
  const toCreator = bill.lamports - fee;
  const enough = balance === null || balance >= bill.lamports + rcRent + 10_000n;

  async function pay() {
    if (!publicKey || !bill) return;
    setBusy(true);
    try {
      const sig = await send([payBillIx(publicKey, bill)]);
      setTxSig(sig);
      toast("Paid. Thank you!", explorerTx(sig));
      setStep("view");
      await load();
    } catch (e) {
      toast(friendlyError(e));
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel detail">
      <a className="back" href="#/">
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

      {bill.paid ? (
        <div className="receipt">
          <div className="badge big">
            <Check /> Paid in full
          </div>
          <div className="fine">
            {bill.payer && (
              <>
                By{" "}
                <a href={explorerAddr(bill.payer.toBase58())} target="_blank" rel="noreferrer">
                  {short(bill.payer, 5)}
                </a>{" "}
                · {timeAgo(bill.paidAt)}
              </>
            )}
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
        </div>
      ) : mine ? (
        <div className="pay-box">
          <div className="fine">This is your bill. Share it so someone can pay it.</div>
          <div className="share">
            <input readOnly value={billLink(bill.address.toBase58())} onFocus={(e) => e.currentTarget.select()} />
            <button
              className="btn red"
              onClick={() => {
                navigator.clipboard?.writeText(billLink(bill.address.toBase58()));
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
          <button className="btn red lg block" onClick={() => setStep("confirm")}>
            Pay {fmtSol(bill.lamports)} SOL
          </button>
          <div className="fine">
            Anyone can post a bill, so only pay people you want to help.
          </div>
        </div>
      ) : (
        <div className="pay-box confirm-box">
          <div className="sum">
            <div>
              You send
              <b>{fmtSol(bill.lamports)} SOL</b>
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
          </div>
          {!enough && <div className="notice warn">Your wallet doesn’t have enough SOL ({fmtSol(balance ?? 0n)} available, the receipt deposit needs ≈ {fmtSol(rcRent, 4)} more).</div>}
          <div className="fine">
            The bill costs exactly this amount: 97% goes straight to the creator and 3% to paymybill.fun.
            You also get a receipt stored on Solana, with a refundable deposit of ≈ {fmtSol(rcRent, 4)} SOL
            you get back when you remove it. Payments are final.
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
    </div>
  );
}

/* ---------------------------------------------------------------- shell */

export function App() {
  const route = useRoute();
  const [toast, setToast] = useState<{ msg: string; href?: string } | null>(null);
  const timer = useRef<number>();
  const notify = useCallback((msg: string, href?: string) => {
    setToast({ msg, href });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  const page =
    route[0] === "new" ? <NewBill /> : route[0] === "mine" ? <Mine /> : route[0] === "b" && route[1] ? <BillPage addr={route[1]} key={route[1]} /> : route[0] === "r" && route[1] ? <ReceiptPage addr={route[1]} key={route[1]} /> : <Explore />;

  return (
    <ToastCtx.Provider value={notify}>
      <header className="top">
        <div className="wrap top-in">
          <a className="brand" href="#/">
            <Logo />
            <span>
              paymybill<span className="red">.fun</span>
            </span>
          </a>
          <nav className="nav">
            <a href="#/" className={!route[0] ? "on" : ""}>
              Explore
            </a>
            <a href="#/mine" className={route[0] === "mine" ? "on" : ""}>
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
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Code ↗
          </a>
        </span>
      </footer>
      <ToastHost toast={toast} />
    </ToastCtx.Provider>
  );
}
