#![allow(dead_code)]
//! Test harness: loads the compiled program into LiteSVM and speaks its wire format by hand,
//! the same way the website does (no IDL, no Anchor client), so we can also send malformed calls.
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

pub const PROGRAM_ID: &str = "6LgTZEVfPX2a3ouR9suAaozexXNjyJ8S4EqNRYFKX8x3";
pub const FEE_WALLET_STR: &str = "AQfKYtAVyZARgKxSt6ZpqwLAtDNeE1LF8Jk5FYWteqbv";
pub const SOL: u64 = 1_000_000_000;
pub const MIN_CONTRIB: u64 = 1_000_000;

pub const D_CREATE: [u8; 8] = [0x1c, 0xf1, 0xb4, 0xa1, 0x6d, 0xff, 0xdc, 0x2c];
pub const D_PAY: [u8; 8] = [0xfa, 0xea, 0xbc, 0x6e, 0x1f, 0xb9, 0x22, 0x05];
pub const D_CLOSE_BILL: [u8; 8] = [0xed, 0x6c, 0x97, 0x43, 0xf9, 0x53, 0xf7, 0xfa];
pub const D_CLOSE_RECEIPT: [u8; 8] = [0x7e, 0xfe, 0xf4, 0xcb, 0x7c, 0xa4, 0x86, 0x59];
pub const D_SET_SUPPORTER: [u8; 8] = [0x6f, 0x3e, 0xb9, 0x06, 0x2c, 0xef, 0x96, 0x79];
pub const D_CLOSE_SUPPORTER: [u8; 8] = [0x1c, 0xc8, 0x42, 0x02, 0x62, 0x94, 0xdf, 0x7f];

pub fn pid() -> Pubkey {
    Pubkey::from_str(PROGRAM_ID).unwrap()
}
pub fn fee_wallet() -> Pubkey {
    Pubkey::from_str(FEE_WALLET_STR).unwrap()
}
pub fn sys() -> Pubkey {
    Pubkey::default()
}
pub fn fee_for(a: u64) -> u64 {
    ((a as u128) * 300 / 10_000) as u64
}

pub fn so_path() -> String {
    std::env::var("PAYMYBILL_SO").unwrap_or_else(|_| "../target/deploy/paymybill.so".to_string())
}

pub struct Env {
    pub svm: LiteSVM,
}

pub fn put_str(v: &mut Vec<u8>, s: &str) {
    v.extend_from_slice(&(s.len() as u32).to_le_bytes());
    v.extend_from_slice(s.as_bytes());
}

pub fn bill_pda(creator: &Pubkey, id: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"bill", creator.as_ref(), &id.to_le_bytes()], &pid()).0
}
pub fn receipt_pda(bill: &Pubkey, payer: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"receipt", bill.as_ref(), payer.as_ref()], &pid()).0
}
pub fn supporter_pda(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"supporter", owner.as_ref()], &pid()).0
}

pub fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
pub fn i64_at(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
pub fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}

#[derive(Debug, Clone)]
pub struct BillV {
    pub status: u8,
    pub creator: Pubkey,
    pub id: u64,
    pub amount: u64,
    pub raised: u64,
    pub backers: u32,
    pub payer: Pubkey,
    pub paid_at: i64,
}
#[derive(Debug, Clone)]
pub struct ReceiptV {
    pub payer: Pubkey,
    pub creator: Pubkey,
    pub bill: Pubkey,
    pub amount: u64,
}
#[derive(Debug, Clone)]
pub struct SupV {
    pub owner: Pubkey,
    pub total: u64,
    pub day_total: u64,
    pub bills_helped: u32,
    pub day: u32,
    pub last_paid_at: i64,
    pub name: String,
    pub handle: String,
}

impl Env {
    pub fn new() -> Env {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(pid(), so_path()).expect("build the program first: cargo build-sbf");
        let mut e = Env { svm };
        // The real fee wallet exists and holds some SOL. (See test fee_wallet_must_be_funded.)
        e.svm.airdrop(&fee_wallet(), SOL / 10).unwrap();
        e
    }
    pub fn wallet(&mut self, sol: f64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), (sol * SOL as f64) as u64).unwrap();
        k
    }
    pub fn bal(&self, k: &Pubkey) -> u64 {
        self.svm.get_balance(k).unwrap_or(0)
    }
    pub fn send_signed(&mut self, ixs: &[Instruction], fee_payer: &Keypair, signers: &[&Keypair]) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let mut all: Vec<&Keypair> = vec![fee_payer];
        for s in signers {
            if s.pubkey() != fee_payer.pubkey() {
                all.push(s);
            }
        }
        let tx = Transaction::new_signed_with_payer(ixs, Some(&fee_payer.pubkey()), &all, self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r
    }
    pub fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.send_signed(&[ix], signer, &[])
    }

    // ---- instruction builders (honest) ----
    pub fn create_ix(creator: &Pubkey, id: u64, amount: u64, title: &str, note: &str) -> Instruction {
        let bill = bill_pda(creator, id);
        let mut data = D_CREATE.to_vec();
        data.extend_from_slice(&id.to_le_bytes());
        data.extend_from_slice(&amount.to_le_bytes());
        put_str(&mut data, title);
        put_str(&mut data, note);
        Instruction {
            program_id: pid(),
            accounts: vec![AccountMeta::new(*creator, true), AccountMeta::new(bill, false), AccountMeta::new_readonly(sys(), false)],
            data,
        }
    }
    pub fn pay_data(amount: u64, name: &str, handle: &str) -> Vec<u8> {
        let mut data = D_PAY.to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        put_str(&mut data, name);
        put_str(&mut data, handle);
        data
    }
    pub fn pay_ix(payer: &Pubkey, bill: &Pubkey, creator: &Pubkey, amount: u64, name: &str, handle: &str) -> Instruction {
        Instruction {
            program_id: pid(),
            accounts: vec![
                AccountMeta::new(*payer, true),
                AccountMeta::new(*bill, false),
                AccountMeta::new(*creator, false),
                AccountMeta::new(fee_wallet(), false),
                AccountMeta::new(receipt_pda(bill, payer), false),
                AccountMeta::new(supporter_pda(payer), false),
                AccountMeta::new_readonly(sys(), false),
            ],
            data: Env::pay_data(amount, name, handle),
        }
    }
    pub fn close_bill_ix(creator: &Pubkey, bill: &Pubkey) -> Instruction {
        Instruction {
            program_id: pid(),
            accounts: vec![AccountMeta::new(*creator, true), AccountMeta::new(*bill, false)],
            data: D_CLOSE_BILL.to_vec(),
        }
    }
    pub fn close_receipt_ix(payer: &Pubkey, receipt: &Pubkey) -> Instruction {
        Instruction {
            program_id: pid(),
            accounts: vec![AccountMeta::new(*payer, true), AccountMeta::new(*receipt, false)],
            data: D_CLOSE_RECEIPT.to_vec(),
        }
    }
    pub fn set_supporter_ix(owner: &Pubkey, name: &str, handle: &str) -> Instruction {
        let mut data = D_SET_SUPPORTER.to_vec();
        put_str(&mut data, name);
        put_str(&mut data, handle);
        Instruction {
            program_id: pid(),
            accounts: vec![AccountMeta::new(*owner, true), AccountMeta::new(supporter_pda(owner), false), AccountMeta::new_readonly(sys(), false)],
            data,
        }
    }
    pub fn close_supporter_ix(owner: &Pubkey, sup: &Pubkey) -> Instruction {
        Instruction {
            program_id: pid(),
            accounts: vec![AccountMeta::new(*owner, true), AccountMeta::new(*sup, false)],
            data: D_CLOSE_SUPPORTER.to_vec(),
        }
    }

    // ---- readers ----
    pub fn bill(&self, a: &Pubkey) -> Option<BillV> {
        let acc = self.svm.get_account(a)?;
        if acc.owner != pid() || acc.data.len() < 120 {
            return None;
        }
        let d = &acc.data;
        Some(BillV {
            status: d[8],
            creator: Pubkey::try_from(&d[10..42]).unwrap(),
            id: u64_at(d, 42),
            amount: u64_at(d, 50),
            paid_at: i64_at(d, 66),
            payer: Pubkey::try_from(&d[74..106]).unwrap(),
            raised: u64_at(d, 106),
            backers: u32_at(d, 114),
        })
    }
    pub fn receipt(&self, a: &Pubkey) -> Option<ReceiptV> {
        let acc = self.svm.get_account(a)?;
        if acc.owner != pid() || acc.data.len() < 113 {
            return None;
        }
        let d = &acc.data;
        Some(ReceiptV {
            payer: Pubkey::try_from(&d[9..41]).unwrap(),
            creator: Pubkey::try_from(&d[41..73]).unwrap(),
            bill: Pubkey::try_from(&d[73..105]).unwrap(),
            amount: u64_at(d, 105),
        })
    }
    pub fn supporter(&self, a: &Pubkey) -> Option<SupV> {
        let acc = self.svm.get_account(a)?;
        if acc.owner != pid() || acc.data.len() < 84 {
            return None;
        }
        let d = &acc.data;
        let nl = u32_at(d, 73) as usize;
        let name = String::from_utf8_lossy(&d[77..77 + nl]).to_string();
        let hl = u32_at(d, 77 + nl) as usize;
        let handle = String::from_utf8_lossy(&d[81 + nl..81 + nl + hl]).to_string();
        Some(SupV {
            owner: Pubkey::try_from(&d[9..41]).unwrap(),
            total: u64_at(d, 41),
            day_total: u64_at(d, 49),
            last_paid_at: i64_at(d, 57),
            bills_helped: u32_at(d, 65),
            day: u32_at(d, 69),
            name,
            handle,
        })
    }
    pub fn set_clock(&mut self, unix: i64) {
        let mut c = self.svm.get_sysvar::<solana_clock::Clock>();
        c.unix_timestamp = unix;
        self.svm.set_sysvar(&c);
    }
    pub fn raw_account(&mut self, addr: &Pubkey, owner: &Pubkey, data: Vec<u8>, lamports: u64) {
        self.svm
            .set_account(*addr, Account { lamports, data, owner: *owner, executable: false, rent_epoch: 0 })
            .unwrap();
    }
}

pub fn err_text(e: &FailedTransactionMetadata) -> String {
    format!("{:?} | {}", e.err, e.meta.logs.iter().filter(|l| l.contains("Error") || l.contains("failed") || l.contains("AnchorError")).cloned().collect::<Vec<_>>().join(" / "))
}

/// A tiny deterministic RNG (xorshift64*), so fuzz failures are reproducible.
pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}
