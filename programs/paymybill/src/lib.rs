//! paymybill.fun: post a bill, let strangers pay it.
//!
//! Design goals:
//!   * No servers: all state lives on Solana.
//!   * Few accounts: one PDA per bill, one receipt PDA per (bill, payer), and one
//!     optional supporter PDA per payer. No global registry, counters or escrow.
//!   * Non-custodial: funds go straight from the payer to the creator's wallet
//!     inside the same transaction that records the payment.
//!   * Partial payments: a bill is a target (`amount`); anyone can chip in any
//!     amount (at least MIN_CONTRIB, or whatever is left) until `raised == amount`.
//!   * Service fee: FEE_BPS (3%) of each contribution is taken out of what the
//!     creator receives and sent to FEE_WALLET. The payer always sends exactly
//!     the contribution.
//!   * Receipt: the payer's own copy of the bill (seeds ["receipt", bill, payer]),
//!     with the total they put into that bill. The payer can close it.
//!   * Supporter: the payer's public card (seeds ["supporter", payer]) with lifetime
//!     and per-UTC-day totals, plus an optional name and X handle. It feeds the
//!     "all time" and "today" leaderboards, which clients build with
//!     `getProgramAccounts`. The owner can close it.
//!
//! A bill PDA is derived from `["bill", creator, id_le_bytes]`, where `id` is a
//! random u64 picked by the client (so no counter account is needed).

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("6LgTZEVfPX2a3ouR9suAaozexXNjyJ8S4EqNRYFKX8x3");

pub const TITLE_MAX: usize = 48;
pub const NOTE_MAX: usize = 160;
pub const NAME_MAX: usize = 24;
pub const HANDLE_MAX: usize = 15; // X handles are at most 15 characters

/// Service fee in basis points (300 = 3%), deducted from what the creator receives.
pub const FEE_BPS: u64 = 300;

/// Smallest contribution (0.001 SOL), unless it completes the bill.
pub const MIN_CONTRIB: u64 = 1_000_000;

pub const SECONDS_PER_DAY: i64 = 86_400;

/// Wallet that receives the service fee. Changing it needs a program upgrade.
pub const FEE_WALLET: Pubkey = pubkey!("AQfKYtAVyZARgKxSt6ZpqwLAtDNeE1LF8Jk5FYWteqbv");

/// Fee owed on a contribution of `amount` lamports (rounded down).
pub fn fee_for(amount: u64) -> u64 {
    ((amount as u128) * (FEE_BPS as u128) / 10_000u128) as u64
}

/// UTC day number of a unix timestamp. Used for the "today" leaderboard.
pub fn day_of(ts: i64) -> u32 {
    (ts.max(0) / SECONDS_PER_DAY) as u32
}

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_PAID: u8 = 1;

fn valid_name(s: &str) -> bool {
    s.len() <= NAME_MAX && !s.chars().any(|c| c.is_control())
}

fn valid_handle(s: &str) -> bool {
    s.len() <= HANDLE_MAX && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

#[program]
pub mod paymybill {
    use super::*;

    /// Publish a bill. The creator funds the (refundable) rent of the bill account.
    pub fn create_bill(
        ctx: Context<CreateBill>,
        id: u64,
        amount: u64,
        title: String,
        note: String,
    ) -> Result<()> {
        require!(amount > 0, BillError::ZeroAmount);
        require!(
            !title.trim().is_empty() && title.len() <= TITLE_MAX,
            BillError::BadTitle
        );
        require!(note.len() <= NOTE_MAX, BillError::NoteTooLong);

        let bill = &mut ctx.accounts.bill;
        bill.status = STATUS_OPEN;
        bill.bump = ctx.bumps.bill;
        bill.creator = ctx.accounts.creator.key();
        bill.id = id;
        bill.amount = amount;
        bill.created_at = Clock::get()?.unix_timestamp;
        bill.paid_at = 0;
        bill.payer = Pubkey::default();
        bill.raised = 0;
        bill.backers = 0;
        bill.title = title;
        bill.note = note;
        Ok(())
    }

    /// Chip in `amount` lamports towards an open bill (the whole remainder pays it
    /// off). The payer sends exactly `amount`: the creator receives `amount - fee`
    /// and FEE_WALLET receives `fee`, atomically. The payer's receipt and supporter
    /// card are created on first use and updated afterwards. `name` and `handle`
    /// are optional: empty strings keep what the supporter card already has.
    pub fn pay_bill(
        ctx: Context<PayBill>,
        amount: u64,
        name: String,
        handle: String,
    ) -> Result<()> {
        require!(valid_name(&name), BillError::BadName);
        require!(valid_handle(&handle), BillError::BadHandle);

        let remaining = ctx.accounts.bill.amount - ctx.accounts.bill.raised;
        require!(amount > 0 && amount <= remaining, BillError::Overpay);
        require!(
            amount >= MIN_CONTRIB || amount == remaining,
            BillError::TooSmall
        );

        let fee = fee_for(amount);
        let to_creator = amount - fee; // fee <= amount always (3%)

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.creator.to_account_info(),
                },
            ),
            to_creator,
        )?;

        if fee > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.fee_wallet.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        let now = Clock::get()?.unix_timestamp;
        let payer_key = ctx.accounts.payer.key();

        // Receipt: the payer's copy of this bill, accumulating what they put in.
        let receipt = &mut ctx.accounts.receipt;
        let first_for_bill = receipt.payer == Pubkey::default();
        let bill = &mut ctx.accounts.bill;
        if first_for_bill {
            receipt.bump = ctx.bumps.receipt;
            receipt.payer = payer_key;
            receipt.creator = bill.creator;
            receipt.bill = bill.key();
            receipt.amount = 0;
            receipt.title = bill.title.clone();
            receipt.note = bill.note.clone();
            bill.backers = bill.backers.saturating_add(1);
        }
        receipt.amount = receipt.amount.saturating_add(amount);
        receipt.paid_at = now;

        // Bill progress.
        bill.raised += amount;
        bill.payer = payer_key;
        if bill.raised == bill.amount {
            bill.status = STATUS_PAID;
            bill.paid_at = now;
        }

        // Supporter card: lifetime and per-UTC-day totals.
        let s = &mut ctx.accounts.supporter;
        if s.owner == Pubkey::default() {
            s.bump = ctx.bumps.supporter;
            s.owner = payer_key;
        }
        let today = day_of(now);
        if s.day != today {
            s.day = today;
            s.day_total = 0;
        }
        s.day_total = s.day_total.saturating_add(amount);
        s.total_paid = s.total_paid.saturating_add(amount);
        s.last_paid_at = now;
        if first_for_bill {
            s.bills_helped = s.bills_helped.saturating_add(1);
        }
        if !name.is_empty() {
            s.name = name;
        }
        if !handle.is_empty() {
            s.handle = handle;
        }
        Ok(())
    }

    /// Creator-only. Cancels an open bill or tidies up a paid one, and gets
    /// the rent back. Money already contributed stays with the creator, and
    /// payers keep their receipts.
    pub fn close_bill(_ctx: Context<CloseBill>) -> Result<()> {
        Ok(())
    }

    /// Payer-only. Removes the receipt and refunds its deposit to the payer.
    pub fn close_receipt(_ctx: Context<CloseReceipt>) -> Result<()> {
        Ok(())
    }

    /// Create or edit your supporter card without paying anything. Empty strings clear the field.
    pub fn set_supporter(ctx: Context<SetSupporter>, name: String, handle: String) -> Result<()> {
        require!(valid_name(&name), BillError::BadName);
        require!(valid_handle(&handle), BillError::BadHandle);
        let s = &mut ctx.accounts.supporter;
        if s.owner == Pubkey::default() {
            s.bump = ctx.bumps.supporter;
            s.owner = ctx.accounts.owner.key();
        }
        s.name = name;
        s.handle = handle;
        Ok(())
    }

    /// Owner-only. Deletes the supporter card (and its leaderboard position) and refunds the deposit.
    pub fn close_supporter(_ctx: Context<CloseSupporter>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateBill<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Bill::INIT_SPACE,
        seeds = [b"bill", creator.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub bill: Account<'info, Bill>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayBill<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"bill", bill.creator.as_ref(), &bill.id.to_le_bytes()],
        bump = bill.bump,
        constraint = bill.status == STATUS_OPEN @ BillError::AlreadyPaid,
        constraint = payer.key() != bill.creator @ BillError::SelfPay,
    )]
    pub bill: Account<'info, Bill>,
    /// CHECK: must equal the creator stored in the bill; it only receives SOL.
    #[account(mut, address = bill.creator)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: must be the hard-coded FEE_WALLET; it only receives SOL.
    #[account(mut, address = FEE_WALLET @ BillError::WrongFeeWallet)]
    pub fee_wallet: UncheckedAccount<'info>,
    /// The payer's receipt for this bill. Rent is paid by the payer the first
    /// time and refunded when the receipt is closed.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Receipt::INIT_SPACE,
        seeds = [b"receipt", bill.key().as_ref(), payer.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    /// The payer's supporter card, created on their first payment.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Supporter::INIT_SPACE,
        seeds = [b"supporter", payer.key().as_ref()],
        bump
    )]
    pub supporter: Account<'info, Supporter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseBill<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, close = creator, has_one = creator)]
    pub bill: Account<'info, Bill>,
}

#[derive(Accounts)]
pub struct CloseReceipt<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, close = payer, has_one = payer)]
    pub receipt: Account<'info, Receipt>,
}

#[derive(Accounts)]
pub struct SetSupporter<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Supporter::INIT_SPACE,
        seeds = [b"supporter", owner.key().as_ref()],
        bump
    )]
    pub supporter: Account<'info, Supporter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseSupporter<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, close = owner, has_one = owner)]
    pub supporter: Account<'info, Supporter>,
}

/// Field order matters: the client reads these at fixed offsets and filters
/// `getProgramAccounts` by `status` (offset 8, right after the discriminator).
/// Everything fixed-size comes before the strings so those offsets never move.
#[account]
#[derive(InitSpace)]
pub struct Bill {
    /// 0 = open, 1 = paid
    pub status: u8,
    pub bump: u8,
    pub creator: Pubkey,
    pub id: u64,
    /// Target in lamports. The bill is paid when `raised` reaches it.
    pub amount: u64,
    pub created_at: i64,
    /// When the last contribution completed the bill (0 while open).
    pub paid_at: i64,
    /// Most recent contributor.
    pub payer: Pubkey,
    /// Gross lamports contributed so far.
    pub raised: u64,
    /// Number of different wallets that contributed.
    pub backers: u32,
    #[max_len(TITLE_MAX)]
    pub title: String,
    #[max_len(NOTE_MAX)]
    pub note: String,
}

/// The payer's copy of a bill. Offsets are read by the client:
/// bump 8, payer 9, creator 41, bill 73, amount 105, paid_at 113, title 121.
#[account]
#[derive(InitSpace)]
pub struct Receipt {
    pub bump: u8,
    pub payer: Pubkey,
    pub creator: Pubkey,
    pub bill: Pubkey,
    /// Total this payer put into the bill (gross, fee included).
    pub amount: u64,
    pub paid_at: i64,
    #[max_len(TITLE_MAX)]
    pub title: String,
    #[max_len(NOTE_MAX)]
    pub note: String,
}

/// A payer's public card. Offsets are read by the client:
/// bump 8, owner 9, total_paid 41, day_total 49, last_paid_at 57,
/// bills_helped 65, day 69, name 73.
#[account]
#[derive(InitSpace)]
pub struct Supporter {
    pub bump: u8,
    pub owner: Pubkey,
    /// Lifetime lamports paid (gross).
    pub total_paid: u64,
    /// Lamports paid during UTC day `day`.
    pub day_total: u64,
    pub last_paid_at: i64,
    pub bills_helped: u32,
    /// UTC day number (unix seconds / 86400) that `day_total` belongs to.
    pub day: u32,
    #[max_len(NAME_MAX)]
    pub name: String,
    #[max_len(HANDLE_MAX)]
    pub handle: String,
}

#[error_code]
pub enum BillError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Title must be 1-48 bytes")]
    BadTitle,
    #[msg("Note must be at most 160 bytes")]
    NoteTooLong,
    #[msg("This bill has already been paid")]
    AlreadyPaid,
    #[msg("You cannot pay your own bill")]
    SelfPay,
    #[msg("Fee wallet account does not match the program's fee wallet")]
    WrongFeeWallet,
    #[msg("Contribution is zero or more than what is left to pay")]
    Overpay,
    #[msg("Contribution is below the minimum (0.001 SOL) and does not finish the bill")]
    TooSmall,
    #[msg("Name must be at most 24 bytes with no control characters")]
    BadName,
    #[msg("X handle must be at most 15 letters, numbers or underscores")]
    BadHandle,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::Discriminator;

    /// These constants are hard-coded in app/src/chain.ts. If this test fails,
    /// the frontend encoding is out of sync with the program.
    #[test]
    fn client_constants_match_program() {
        assert_eq!(Bill::DISCRIMINATOR, &[0x46, 0x4c, 0xfb, 0xaf, 0xd4, 0xe3, 0xd4, 0xb3][..]);
        assert_eq!(
            crate::instruction::CreateBill::DISCRIMINATOR,
            &[0x1c, 0xf1, 0xb4, 0xa1, 0x6d, 0xff, 0xdc, 0x2c][..]
        );
        assert_eq!(
            crate::instruction::PayBill::DISCRIMINATOR,
            &[0xfa, 0xea, 0xbc, 0x6e, 0x1f, 0xb9, 0x22, 0x05][..]
        );
        assert_eq!(
            crate::instruction::CloseBill::DISCRIMINATOR,
            &[0xed, 0x6c, 0x97, 0x43, 0xf9, 0x53, 0xf7, 0xfa][..]
        );
        assert_eq!(Receipt::DISCRIMINATOR, &[0x27, 0x9a, 0x49, 0x6a, 0x50, 0x66, 0x91, 0x99][..]);
        assert_eq!(
            crate::instruction::CloseReceipt::DISCRIMINATOR,
            &[0x7e, 0xfe, 0xf4, 0xcb, 0x7c, 0xa4, 0x86, 0x59][..]
        );
        assert_eq!(Supporter::DISCRIMINATOR, &[0xc6, 0x7d, 0x49, 0x5e, 0x48, 0x28, 0xe9, 0x9f][..]);
        assert_eq!(crate::instruction::SetSupporter::DISCRIMINATOR, &[0x6f, 0x3e, 0xb9, 0x06, 0x2c, 0xef, 0x96, 0x79][..]);
        assert_eq!(crate::instruction::CloseSupporter::DISCRIMINATOR, &[0x1c, 0xc8, 0x42, 0x02, 0x62, 0x94, 0xdf, 0x7f][..]);
        assert_eq!(8 + Bill::INIT_SPACE, 334);
        assert_eq!(8 + Receipt::INIT_SPACE, 337);
        assert_eq!(8 + Supporter::INIT_SPACE, 120);
    }

    #[test]
    fn fee_is_three_percent_rounded_down() {
        assert_eq!(fee_for(1_000_000_000), 30_000_000);
        assert_eq!(fee_for(62_000_000), 1_860_000);
        assert_eq!(fee_for(33), 0);
        assert_eq!(fee_for(34), 1);
        assert_eq!(fee_for(u64::MAX), (u64::MAX as u128 * 300 / 10_000) as u64);
    }

    #[test]
    fn day_buckets_roll_over_at_utc_midnight() {
        assert_eq!(day_of(0), 0);
        assert_eq!(day_of(86_399), 0);
        assert_eq!(day_of(86_400), 1);
        assert_eq!(day_of(1_700_000_000), 19_675);
        assert_eq!(day_of(-5), 0);
    }

    #[test]
    fn name_and_handle_rules() {
        assert!(valid_name(""));
        assert!(valid_name("Ana la mejor"));
        assert!(valid_name(&"a".repeat(24)));
        assert!(!valid_name(&"a".repeat(25)));
        assert!(!valid_name("line\nbreak"));
        assert!(valid_handle(""));
        assert!(valid_handle("nico_chk1"));
        assert!(valid_handle(&"a".repeat(15)));
        assert!(!valid_handle(&"a".repeat(16)));
        assert!(!valid_handle("@nico"));
        assert!(!valid_handle("a b"));
        assert!(!valid_handle("https://x.com/a"));
    }

    #[test]
    fn layout_offsets_match_client() {
        let creator = Pubkey::new_unique();
        let payer = Pubkey::new_unique();
        let bill = Bill {
            status: STATUS_PAID,
            bump: 254,
            creator,
            id: 7,
            amount: 1_000_000_000,
            created_at: 111,
            paid_at: 222,
            payer,
            raised: 600_000_000,
            backers: 3,
            title: "Electric".to_string(),
            note: "March".to_string(),
        };
        let mut data = Vec::new();
        bill.try_serialize(&mut data).unwrap();
        assert_eq!(data[8], STATUS_PAID);
        assert_eq!(data[9], 254);
        assert_eq!(&data[10..42], creator.as_ref());
        assert_eq!(u64::from_le_bytes(data[42..50].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(data[50..58].try_into().unwrap()), 1_000_000_000);
        assert_eq!(i64::from_le_bytes(data[58..66].try_into().unwrap()), 111);
        assert_eq!(i64::from_le_bytes(data[66..74].try_into().unwrap()), 222);
        assert_eq!(&data[74..106], payer.as_ref());
        assert_eq!(u64::from_le_bytes(data[106..114].try_into().unwrap()), 600_000_000);
        assert_eq!(u32::from_le_bytes(data[114..118].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(data[118..122].try_into().unwrap()), 8);
        assert_eq!(&data[122..130], b"Electric");
        // note length follows the title bytes directly (borsh, no padding)
        assert_eq!(u32::from_le_bytes(data[130..134].try_into().unwrap()), 5);
        assert_eq!(&data[134..139], b"March");
    }

    #[test]
    fn receipt_layout_matches_client() {
        let (payer, creator, bill) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let r = Receipt {
            bump: 253,
            payer,
            creator,
            bill,
            amount: 5,
            paid_at: 99,
            title: "Rent".to_string(),
            note: "May".to_string(),
        };
        let mut d = Vec::new();
        r.try_serialize(&mut d).unwrap();
        assert_eq!(d[8], 253);
        assert_eq!(&d[9..41], payer.as_ref());
        assert_eq!(&d[41..73], creator.as_ref());
        assert_eq!(&d[73..105], bill.as_ref());
        assert_eq!(u64::from_le_bytes(d[105..113].try_into().unwrap()), 5);
        assert_eq!(i64::from_le_bytes(d[113..121].try_into().unwrap()), 99);
        assert_eq!(u32::from_le_bytes(d[121..125].try_into().unwrap()), 4);
        assert_eq!(&d[125..129], b"Rent");
        assert_eq!(u32::from_le_bytes(d[129..133].try_into().unwrap()), 3);
        assert_eq!(&d[133..136], b"May");
    }

    #[test]
    fn supporter_layout_matches_client() {
        let owner = Pubkey::new_unique();
        let s = Supporter {
            bump: 252,
            owner,
            total_paid: 5_000_000_000,
            day_total: 700_000_000,
            last_paid_at: 1_700_000_123,
            bills_helped: 9,
            day: 19_675,
            name: "Ana".to_string(),
            handle: "ana_x".to_string(),
        };
        let mut d = Vec::new();
        s.try_serialize(&mut d).unwrap();
        assert_eq!(d[8], 252);
        assert_eq!(&d[9..41], owner.as_ref());
        assert_eq!(u64::from_le_bytes(d[41..49].try_into().unwrap()), 5_000_000_000);
        assert_eq!(u64::from_le_bytes(d[49..57].try_into().unwrap()), 700_000_000);
        assert_eq!(i64::from_le_bytes(d[57..65].try_into().unwrap()), 1_700_000_123);
        assert_eq!(u32::from_le_bytes(d[65..69].try_into().unwrap()), 9);
        assert_eq!(u32::from_le_bytes(d[69..73].try_into().unwrap()), 19_675);
        assert_eq!(u32::from_le_bytes(d[73..77].try_into().unwrap()), 3);
        assert_eq!(&d[77..80], b"Ana");
        assert_eq!(u32::from_le_bytes(d[80..84].try_into().unwrap()), 5);
        assert_eq!(&d[84..89], b"ana_x");
    }
}
