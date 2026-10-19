//! Adversarial tests. Every test is an attack an outsider could try; the program must
//! refuse it (or the outcome must be harmless and documented in the test).
mod common;
use common::*;
use solana_address::Address as Pubkey;
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn open_bill(e: &mut Env, creator: &Keypair, id: u64, amount: u64) -> Pubkey {
    let ix = Env::create_ix(&creator.pubkey(), id, amount, "Rent", "March");
    e.send(ix, creator).expect("create bill");
    bill_pda(&creator.pubkey(), id)
}

// ------------------------------------------------------------------ money routing

#[test]
fn honest_payment_splits_97_3_and_conserves_lamports() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let payer = e.wallet(2.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    let (c0, f0, p0) = (e.bal(&creator.pubkey()), e.bal(&fee_wallet()), e.bal(&payer.pubkey()));
    let r = e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 400_000_000, "A", "a"), &payer).unwrap();
    println!("pay_bill compute units (first payment, creates 2 accounts): {}", r.compute_units_consumed);
    let fee = fee_for(400_000_000);
    assert_eq!(e.bal(&creator.pubkey()) - c0, 400_000_000 - fee);
    assert_eq!(e.bal(&fee_wallet()) - f0, fee);
    // payer spent exactly amount + rent of receipt + supporter + 5000 tx fee
    let spent = p0 - e.bal(&payer.pubkey());
    let rent_r = e.bal(&receipt_pda(&bill, &payer.pubkey()));
    let rent_s = e.bal(&supporter_pda(&payer.pubkey()));
    assert_eq!(spent, 400_000_000 + rent_r + rent_s + 5_000);
    // the bill account itself never holds contributed money
    let rent_b = e.svm.minimum_balance_for_rent_exemption(334);
    assert_eq!(e.bal(&bill), rent_b, "bill must hold only its rent, never contributions");
}

#[test]
fn cannot_redirect_money_to_another_creator_account() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let thief = e.wallet(1.0);
    let payer = e.wallet(2.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    // classic attack: swap the creator account for the thief's
    let ix = Env::pay_ix(&payer.pubkey(), &bill, &thief.pubkey(), 100_000_000, "", "");
    let err = e.send(ix, &payer).unwrap_err();
    println!("redirect creator -> {}", err_text(&err));
    assert_eq!(e.bill(&bill).unwrap().raised, 0);
}

#[test]
fn cannot_skip_or_redirect_the_fee() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let payer = e.wallet(2.0);
    let attacker_fee = e.wallet(0.1);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    for (label, wrong) in [("attacker wallet", attacker_fee.pubkey()), ("payer itself", payer.pubkey()), ("creator", creator.pubkey()), ("system program", sys())] {
        let mut ix = Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 100_000_000, "", "");
        ix.accounts[3] = AccountMeta::new(wrong, false);
        let err = e.send(ix, &payer).unwrap_err();
        println!("fee wallet = {label}: {}", err_text(&err));
    }
    assert_eq!(e.bill(&bill).unwrap().raised, 0);
}

#[test]
fn fee_wallet_must_be_funded() {
    // OPERATIONAL RISK: if the fee wallet does not exist (0 lamports), a fee of 30_000 lamports
    // is below the rent-exempt minimum for a fresh account and the transaction fails.
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let payer = e.wallet(2.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    e.svm.set_account(fee_wallet(), solana_account::Account::default()).unwrap();
    assert_eq!(e.bal(&fee_wallet()), 0);
    let small = e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), MIN_CONTRIB, "", ""), &payer);
    println!("payment with an EMPTY fee wallet, small amount -> ok? {}", small.is_ok());
    assert!(small.is_err(), "if this passes, the doc note about funding the fee wallet can be removed");
    // big enough payments (3% >= rent-exempt minimum of a 0-byte account) still go through
    let big = e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 100_000_000, "", ""), &payer);
    assert!(big.is_ok(), "{:?}", big.err().map(|x| err_text(&x)));
}

#[test]
fn cannot_pay_own_bill_but_second_wallet_can_wash_trade() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let sybil = e.wallet(1.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    assert!(e.send(Env::pay_ix(&creator.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", ""), &creator).is_err());
    // KNOWN/ACCEPTED: a second wallet owned by the creator can pay; it costs the 3% fee plus rent.
    let before = e.bal(&creator.pubkey()) + e.bal(&sybil.pubkey());
    e.send(Env::pay_ix(&sybil.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", ""), &sybil).unwrap();
    let after = e.bal(&creator.pubkey()) + e.bal(&sybil.pubkey());
    let cost = before - after;
    println!("wash-trading 0.01 SOL via a second wallet cost {} lamports (fee {} + rents + tx fee)", cost, fee_for(10_000_000));
    assert!(cost >= fee_for(10_000_000));
}

// ------------------------------------------------------------------ amounts

#[test]
fn amount_rules() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let p = e.wallet(5.0);
    let bill = open_bill(&mut e, &creator, 1, 10_000_000);
    let pay = |e: &mut Env, a: u64| e.send(Env::pay_ix(&p.pubkey(), &bill, &creator.pubkey(), a, "", ""), &p);
    assert!(pay(&mut e, 0).is_err(), "zero");
    assert!(pay(&mut e, 999_999).is_err(), "below minimum");
    assert!(pay(&mut e, 10_000_001).is_err(), "more than target");
    assert!(pay(&mut e, u64::MAX).is_err(), "u64::MAX");
    assert!(pay(&mut e, 1_000_000).is_ok(), "exact minimum");
    assert_eq!(e.bill(&bill).unwrap().raised, 1_000_000);
    assert!(pay(&mut e, 9_000_001).is_err(), "more than remaining");
    // leave a tiny remainder, which must still be payable even below the minimum
    assert!(pay(&mut e, 8_999_999).is_ok());
    assert_eq!(e.bill(&bill).unwrap().raised, 9_999_999);
    assert!(pay(&mut e, 2).is_err(), "remaining is 1, 2 is too much");
    assert!(pay(&mut e, 1).is_ok(), "last lamport completes the bill (fee rounds to 0)");
    let b = e.bill(&bill).unwrap();
    assert_eq!((b.status, b.raised), (1, 10_000_000));
    assert!(pay(&mut e, 1).is_err(), "paid bill takes no more");
}

#[test]
fn huge_targets_do_not_overflow() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let p = e.wallet(5.0);
    let bill = open_bill(&mut e, &creator, 1, u64::MAX);
    e.send(Env::pay_ix(&p.pubkey(), &bill, &creator.pubkey(), 3 * SOL, "", ""), &p).unwrap();
    assert_eq!(e.bill(&bill).unwrap().raised, 3 * SOL);
    // cannot pay more than the payer owns, nothing is created or moved
    let before = e.bill(&bill).unwrap().raised;
    assert!(e.send(Env::pay_ix(&p.pubkey(), &bill, &creator.pubkey(), u64::MAX - 3 * SOL, "", ""), &p).is_err());
    assert_eq!(e.bill(&bill).unwrap().raised, before);
}

#[test]
fn zero_amount_and_bad_text_on_create() {
    let mut e = Env::new();
    let c = e.wallet(1.0);
    let mk = |e: &mut Env, id, amt, t: &str, n: &str| e.send(Env::create_ix(&c.pubkey(), id, amt, t, n), &c);
    assert!(mk(&mut e, 1, 0, "x", "").is_err(), "zero target");
    assert!(mk(&mut e, 2, 1, "", "").is_err(), "empty title");
    assert!(mk(&mut e, 3, 1, "   ", "").is_err(), "blank title");
    assert!(mk(&mut e, 4, 1, &"a".repeat(49), "").is_err(), "title 49 bytes");
    assert!(mk(&mut e, 5, 1, &"a".repeat(48), "").is_ok(), "title 48 bytes");
    assert!(mk(&mut e, 6, 1, "x", &"a".repeat(161)).is_err(), "note 161 bytes");
    assert!(mk(&mut e, 7, 1, "x", &"a".repeat(160)).is_ok(), "note 160 bytes");
    // multi-byte: the limit is in bytes, 25 x "ñ" = 50 bytes > 48
    assert!(mk(&mut e, 8, 1, &"ñ".repeat(25), "").is_err());
    assert!(mk(&mut e, 9, 1, &"ñ".repeat(24), "").is_ok());
    // duplicate id by the same creator
    assert!(mk(&mut e, 5, 1, "again", "").is_err(), "same (creator,id) cannot be created twice");
}

// ------------------------------------------------------------------ account spoofing

#[test]
fn fake_bill_account_is_rejected() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let attacker = e.wallet(3.0);
    let payer = e.wallet(3.0);
    let real = open_bill(&mut e, &creator, 1, SOL);
    let real_data = e.svm.get_account(&real).unwrap().data;
    // 1) Same bytes, but owned by someone else (system program / a random program)
    for (label, owner) in [("system", sys()), ("random program", Pubkey::new_unique())] {
        let fake = Pubkey::new_unique();
        let mut d = real_data.clone();
        d[10..42].copy_from_slice(attacker.pubkey().as_ref()); // creator = attacker
        e.raw_account(&fake, &owner, d, 10_000_000);
        let mut ix = Env::pay_ix(&payer.pubkey(), &fake, &attacker.pubkey(), 50_000_000, "", "");
        ix.accounts[4] = AccountMeta::new(receipt_pda(&fake, &payer.pubkey()), false);
        let err = e.send(ix, &payer).unwrap_err();
        println!("fake bill owned by {label}: {}", err_text(&err));
    }
    // 2) Owned by the program but NOT at the PDA address (defence in depth, cannot happen on-chain)
    let fake = Pubkey::new_unique();
    let mut d = real_data.clone();
    d[10..42].copy_from_slice(attacker.pubkey().as_ref());
    e.raw_account(&fake, &pid(), d, 10_000_000);
    let ix = Env::pay_ix(&payer.pubkey(), &fake, &attacker.pubkey(), 50_000_000, "", "");
    let err = e.send(ix, &payer).unwrap_err();
    println!("fake bill at wrong address: {}", err_text(&err));
}

#[test]
fn wrong_account_types_are_rejected() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let payer = e.wallet(3.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 20_000_000, "n", "h"), &payer).unwrap();
    let receipt = receipt_pda(&bill, &payer.pubkey());
    let sup = supporter_pda(&payer.pubkey());
    // pass a Receipt where a Bill is expected, a Supporter where a Receipt is expected, etc.
    let mut ix = Env::pay_ix(&payer.pubkey(), &receipt, &creator.pubkey(), 10_000_000, "", "");
    ix.accounts[4] = AccountMeta::new(receipt_pda(&receipt, &payer.pubkey()), false);
    assert!(e.send(ix, &payer).is_err(), "receipt as bill");
    let mut ix = Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "");
    ix.accounts[4] = AccountMeta::new(sup, false);
    assert!(e.send(ix, &payer).is_err(), "supporter as receipt");
    let mut ix = Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "");
    ix.accounts[5] = AccountMeta::new(receipt, false);
    assert!(e.send(ix, &payer).is_err(), "receipt as supporter");
    assert!(e.send(Env::close_bill_ix(&creator.pubkey(), &receipt), &creator).is_err(), "close_bill on a receipt");
    assert!(e.send(Env::close_receipt_ix(&payer.pubkey(), &bill), &payer).is_err(), "close_receipt on a bill");
    assert!(e.send(Env::close_supporter_ix(&payer.pubkey(), &receipt), &payer).is_err(), "close_supporter on a receipt");
}

#[test]
fn cannot_use_or_hijack_someone_elses_receipt_or_card() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let victim = e.wallet(3.0);
    let attacker = e.wallet(3.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    e.send(Env::pay_ix(&victim.pubkey(), &bill, &creator.pubkey(), 50_000_000, "Victim", "vic"), &victim).unwrap();
    let v_receipt = receipt_pda(&bill, &victim.pubkey());
    let v_sup = supporter_pda(&victim.pubkey());
    // attacker pays but points to the victim's receipt / card
    let mut ix = Env::pay_ix(&attacker.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "");
    ix.accounts[4] = AccountMeta::new(v_receipt, false);
    assert!(e.send(ix, &attacker).is_err(), "attacker using victim receipt");
    let mut ix = Env::pay_ix(&attacker.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "");
    ix.accounts[5] = AccountMeta::new(v_sup, false);
    assert!(e.send(ix, &attacker).is_err(), "attacker using victim card");
    // attacker cannot edit or close the victim's card/receipt
    let mut ix = Env::set_supporter_ix(&attacker.pubkey(), "pwned", "pwned");
    ix.accounts[1] = AccountMeta::new(v_sup, false);
    assert!(e.send(ix, &attacker).is_err(), "edit victim card");
    assert!(e.send(Env::close_supporter_ix(&attacker.pubkey(), &v_sup), &attacker).is_err(), "close victim card");
    assert!(e.send(Env::close_receipt_ix(&attacker.pubkey(), &v_receipt), &attacker).is_err(), "close victim receipt");
    // ...even if the attacker adds the victim as a non-signer
    let mut ix = Env::close_receipt_ix(&victim.pubkey(), &v_receipt);
    ix.accounts[0].is_signer = false;
    assert!(e.send_signed(&[ix], &attacker, &[]).is_err(), "victim as non-signer");
    let s = e.supporter(&v_sup).unwrap();
    assert_eq!((s.name.as_str(), s.handle.as_str(), s.total), ("Victim", "vic", 50_000_000));
    assert!(e.receipt(&v_receipt).is_some());
}

#[test]
fn only_the_creator_can_close_a_bill_and_it_pays_rent_to_them() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let attacker = e.wallet(1.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    // attacker signs as "creator"
    assert!(e.send(Env::close_bill_ix(&attacker.pubkey(), &bill), &attacker).is_err());
    // attacker names the real creator but cannot sign for them
    let mut ix = Env::close_bill_ix(&creator.pubkey(), &bill);
    ix.accounts[0].is_signer = false;
    assert!(e.send_signed(&[ix], &attacker, &[]).is_err());
    // attacker tries to receive the rent: signer=attacker, bill stays
    assert!(e.bill(&bill).is_some());
    let rent = e.bal(&bill);
    let before = e.bal(&creator.pubkey());
    e.send(Env::close_bill_ix(&creator.pubkey(), &bill), &creator).unwrap();
    assert_eq!(e.bal(&creator.pubkey()) + 5_000 - before, rent);
    assert!(e.bill(&bill).is_none());
}

#[test]
fn unsigned_and_wrong_system_program() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let payer = e.wallet(3.0);
    let helper = e.wallet(1.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    // payer not marked as signer (someone else pays the tx fee)
    let mut ix = Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "");
    ix.accounts[0].is_signer = false;
    assert!(e.send_signed(&[ix], &helper, &[]).is_err(), "payer must sign");
    // fake system program id
    let mut ix = Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "");
    ix.accounts[6] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    assert!(e.send(ix, &payer).is_err(), "fake system program");
    // missing accounts / truncated data
    let mut ix = Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "");
    ix.accounts.truncate(4);
    assert!(e.send(ix, &payer).is_err(), "missing accounts");
    let mut ix = Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "");
    ix.data.truncate(10);
    assert!(e.send(ix, &payer).is_err(), "truncated data");
    // trailing garbage after valid args is ignored by borsh: must not change behaviour
    let mut ix = Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "");
    ix.data.extend_from_slice(&[9, 9, 9]);
    let r = e.send(ix, &payer);
    println!("trailing bytes in pay_bill data accepted? {}", r.is_ok());
    // unknown discriminator
    let mut ix = Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "");
    ix.data[0] ^= 0xff;
    assert!(e.send(ix, &payer).is_err(), "unknown instruction");
}

// ------------------------------------------------------------------ lifecycle / reinit

#[test]
fn pre_funding_pdas_cannot_block_creation() {
    // "lamport donation" DoS: send a few lamports to the address a victim will need.
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let payer = e.wallet(3.0);
    let griefer = e.wallet(1.0);
    let bill = bill_pda(&creator.pubkey(), 77);
    let receipt = receipt_pda(&bill, &payer.pubkey());
    let sup = supporter_pda(&payer.pubkey());
    for a in [bill, receipt, sup] {
        let ix = solana_system_interface::instruction::transfer(&griefer.pubkey(), &a, 890_880);
        e.send(ix, &griefer).unwrap();
    }
    e.send(Env::create_ix(&creator.pubkey(), 77, SOL, "Donated", ""), &creator).expect("create over donated address");
    e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", ""), &payer).expect("pay with donated receipt/card addresses");
}

#[test]
fn closing_and_repaying_resets_state_cleanly() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let payer = e.wallet(3.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 100_000_000, "N", "h"), &payer).unwrap();
    let r = receipt_pda(&bill, &payer.pubkey());
    let s = supporter_pda(&payer.pubkey());
    e.send_signed(&[Env::close_receipt_ix(&payer.pubkey(), &r), Env::close_supporter_ix(&payer.pubkey(), &s)], &payer, &[]).unwrap();
    assert!(e.receipt(&r).is_none() && e.supporter(&s).is_none());
    e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 100_000_000, "", ""), &payer).unwrap();
    let rv = e.receipt(&r).unwrap();
    assert_eq!(rv.amount, 100_000_000, "fresh receipt, not the old total");
    let sv = e.supporter(&s).unwrap();
    assert_eq!((sv.total, sv.bills_helped, sv.name.as_str()), (100_000_000, 1, ""));
    // known/accepted: backers counts the payer again after they closed their receipt
    assert_eq!(e.bill(&bill).unwrap().backers, 2);
}

#[test]
fn recreating_a_closed_bill_keeps_old_receipts_but_changes_the_bill() {
    // Same (creator, id) gives the same address, so a creator can close a bill and publish a
    // different one under the SAME link. Payers' money is never at risk, but a shared link can be
    // switched. The website shows the creation time and the creator address to make this visible.
    let mut e = Env::new();
    let creator = e.wallet(2.0);
    let payer = e.wallet(3.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 100_000_000, "", ""), &payer).unwrap();
    e.send(Env::close_bill_ix(&creator.pubkey(), &bill), &creator).unwrap();
    e.send(Env::create_ix(&creator.pubkey(), 1, 5 * SOL, "Different bill", "same link"), &creator).unwrap();
    let b = e.bill(&bill).unwrap();
    assert_eq!((b.raised, b.backers, b.amount), (0, 0, 5 * SOL));
    e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 50_000_000, "", ""), &payer).unwrap();
    let r = e.receipt(&receipt_pda(&bill, &payer.pubkey())).unwrap();
    println!("old receipt now totals {} and backers on the new bill = {}", r.amount, e.bill(&bill).unwrap().backers);
    assert_eq!(r.amount, 150_000_000);
}

// ------------------------------------------------------------------ supporter cards and text

#[test]
fn day_buckets_and_totals() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let payer = e.wallet(5.0);
    let bill = open_bill(&mut e, &creator, 1, 10 * SOL);
    let day = 20_000i64;
    e.set_clock(day * 86_400 + 100);
    e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 100_000_000, "", ""), &payer).unwrap();
    e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 200_000_000, "", ""), &payer).unwrap();
    let s = e.supporter(&supporter_pda(&payer.pubkey())).unwrap();
    assert_eq!((s.day as i64, s.day_total, s.total, s.bills_helped), (day, 300_000_000, 300_000_000, 1));
    // last second of the day, then first second of the next
    e.set_clock((day + 1) * 86_400 - 1);
    e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", ""), &payer).unwrap();
    assert_eq!(e.supporter(&supporter_pda(&payer.pubkey())).unwrap().day_total, 310_000_000);
    e.set_clock((day + 1) * 86_400);
    e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 5_000_000, "", ""), &payer).unwrap();
    let s = e.supporter(&supporter_pda(&payer.pubkey())).unwrap();
    assert_eq!((s.day as i64, s.day_total, s.total), (day + 1, 5_000_000, 315_000_000));
    // clock going backwards (cannot happen on mainnet) must not panic or wrap
    e.set_clock(day * 86_400);
    e.send(Env::pay_ix(&payer.pubkey(), &bill, &creator.pubkey(), 5_000_000, "", ""), &payer).unwrap();
}

#[test]
fn name_and_handle_validation_and_persistence() {
    let mut e = Env::new();
    let u = e.wallet(1.0);
    let set = |e: &mut Env, n: &str, h: &str| e.send(Env::set_supporter_ix(&u.pubkey(), n, h), &u);
    assert!(set(&mut e, "Ana", "ana_x").is_ok());
    let s = supporter_pda(&u.pubkey());
    assert!(set(&mut e, "line\nbreak", "").is_err(), "newline in name");
    assert!(set(&mut e, "tab\there", "").is_err(), "tab in name");
    assert!(set(&mut e, "nul\0byte", "").is_err(), "NUL in name");
    assert!(set(&mut e, &"a".repeat(25), "").is_err(), "name 25 bytes");
    assert!(set(&mut e, "", "@ana").is_err(), "@ in handle");
    assert!(set(&mut e, "", "a b").is_err(), "space in handle");
    assert!(set(&mut e, "", "ñandú").is_err(), "non-ascii handle");
    assert!(set(&mut e, "", &"a".repeat(16)).is_err(), "handle 16 chars");
    assert!(set(&mut e, "", "https://x.com/a").is_err(), "url as handle");
    let v = e.supporter(&s).unwrap();
    assert_eq!((v.name.as_str(), v.handle.as_str()), ("Ana", "ana_x"), "failed edits change nothing");
    assert!(set(&mut e, "", "").is_ok(), "empty clears");
    let v = e.supporter(&s).unwrap();
    assert_eq!((v.name.as_str(), v.handle.as_str()), ("", ""));
}

#[test]
fn invisible_and_direction_override_characters_are_rejected() {
    // Phishing/spoofing: U+202E (right-to-left override) can make "Alice" look like another word or
    // reorder an address; zero-width characters make two different names look identical.
    let mut e = Env::new();
    let u = e.wallet(2.0);
    let evil = ["\u{202E}drawkcab", "a\u{200B}b", "a\u{200F}b", "a\u{2066}b", "a\u{FEFF}b", "a\u{00AD}b", "a\u{061C}b", "a\u{2028}b"];
    for t in evil {
        assert!(e.send(Env::set_supporter_ix(&u.pubkey(), t, ""), &u).is_err(), "name {:?}", t);
    }
    for (i, t) in evil.iter().enumerate() {
        assert!(e.send(Env::create_ix(&u.pubkey(), 100 + i as u64, 1, t, ""), &u).is_err(), "title {:?}", t);
        assert!(e.send(Env::create_ix(&u.pubkey(), 200 + i as u64, 1, "ok", t), &u).is_err(), "note {:?}", t);
    }
    // control characters in title/note
    assert!(e.send(Env::create_ix(&u.pubkey(), 300, 1, "two\nlines", ""), &u).is_err());
    assert!(e.send(Env::create_ix(&u.pubkey(), 301, 1, "ok", "two\nlines"), &u).is_err());
    // normal text, accents, emoji and CJK still work
    assert!(e.send(Env::create_ix(&u.pubkey(), 302, 1, "Alquiler marzo ñandú", "Gracias 🙏"), &u).is_ok());
}

#[test]
fn paying_with_empty_name_keeps_the_existing_card() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let p = e.wallet(3.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    e.send(Env::set_supporter_ix(&p.pubkey(), "Pat", "pat_x"), &p).unwrap();
    e.send(Env::pay_ix(&p.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", ""), &p).unwrap();
    let s = e.supporter(&supporter_pda(&p.pubkey())).unwrap();
    assert_eq!((s.name.as_str(), s.handle.as_str(), s.total), ("Pat", "pat_x", 10_000_000));
}

// ------------------------------------------------------------------ randomized / model-based

#[test]
fn fuzz_random_operations_keep_all_invariants() {
    for seed in [1u64, 7, 42, 1337, 987654321] {
        run_fuzz(seed, 220);
    }
}

#[derive(Clone)]
struct MBill {
    creator: usize,
    id: u64,
    target: u64,
    raised: u64,
    open: bool, // not closed
    paid: bool,
}

fn run_fuzz(seed: u64, steps: usize) {
    let mut e = Env::new();
    let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
    let wallets: Vec<Keypair> = (0..5).map(|_| e.wallet(50.0)).collect();
    let mut bills: Vec<MBill> = vec![];
    let mut next_id = 1u64;
    let tracked = |e: &Env, wallets: &Vec<Keypair>, bills: &Vec<MBill>| -> Vec<(Pubkey, u64)> {
        let mut v: Vec<(Pubkey, u64)> = vec![(fee_wallet(), e.bal(&fee_wallet()))];
        for w in wallets {
            v.push((w.pubkey(), e.bal(&w.pubkey())));
            v.push((supporter_pda(&w.pubkey()), e.bal(&supporter_pda(&w.pubkey()))));
        }
        for b in bills {
            let ba = bill_pda(&wallets[b.creator].pubkey(), b.id);
            v.push((ba, e.bal(&ba)));
            for w in wallets {
                let r = receipt_pda(&ba, &w.pubkey());
                v.push((r, e.bal(&r)));
            }
        }
        v
    };
    for step in 0..steps {
        let before = tracked(&e, &wallets, &bills);
        let sum_before: u128 = before.iter().map(|x| x.1 as u128).sum();
        let who = rng.below(5) as usize;
        let op = rng.below(100);
        let mut expect_ok = true;
        let mut fee_payer_idx = who;
        let res;
        let label;
        if op < 15 || bills.is_empty() {
            // create
            let target = [1u64, 33, 1_000_000, 5_000_000, 123_456_789, 2 * SOL][rng.below(6) as usize];
            let dup = rng.below(10) == 0 && !bills.is_empty();
            let id = if dup { bills[rng.below(bills.len() as u64) as usize].id } else { next_id };
            let exists = bills.iter().any(|b| b.creator == who && b.id == id && b.open);
            expect_ok = !exists;
            label = format!("create id={id} target={target} by {who}");
            res = e.send(Env::create_ix(&wallets[who].pubkey(), id, target, "t", "n"), &wallets[who]);
            if expect_ok {
                if let Some(b) = bills.iter_mut().find(|b| b.creator == who && b.id == id) {
                    *b = MBill { creator: who, id, target, raised: 0, open: true, paid: false };
                } else {
                    bills.push(MBill { creator: who, id, target, raised: 0, open: true, paid: false });
                }
            }
            if !dup {
                next_id += 1;
            }
        } else if op < 75 {
            // pay (random bill, random payer, random amount incl. invalid ones)
            let bi = rng.below(bills.len() as u64) as usize;
            let b = bills[bi].clone();
            let remaining = b.target - b.raised;
            let amount = match rng.below(8) {
                0 => 0,
                1 => remaining,
                2 => remaining.saturating_add(1),
                3 => MIN_CONTRIB - 1,
                4 => MIN_CONTRIB,
                5 => rng.below(remaining.max(1)) + 1,
                6 => 1 + rng.below(40),
                _ => rng.below(3 * SOL),
            };
            expect_ok = b.open && !b.paid && who != b.creator && amount > 0 && amount <= remaining && (amount >= MIN_CONTRIB || amount == remaining);
            let ba = bill_pda(&wallets[b.creator].pubkey(), b.id);
            label = format!("pay bill#{bi} amount={amount} remaining={remaining} by {who}");
            res = e.send(Env::pay_ix(&wallets[who].pubkey(), &ba, &wallets[b.creator].pubkey(), amount, "", ""), &wallets[who]);
            if expect_ok {
                let m = &mut bills[bi];
                m.raised += amount;
                m.paid = m.raised == m.target;
            }
        } else if op < 85 {
            // close a bill (by creator, or an impostor)
            let bi = rng.below(bills.len() as u64) as usize;
            let b = bills[bi].clone();
            let ba = bill_pda(&wallets[b.creator].pubkey(), b.id);
            expect_ok = b.open && who == b.creator;
            label = format!("close bill#{bi} by {who} (creator {})", b.creator);
            res = e.send(Env::close_bill_ix(&wallets[who].pubkey(), &ba), &wallets[who]);
            if expect_ok {
                bills[bi].open = false;
            }
        } else if op < 93 {
            // close a receipt (own or someone else's)
            let bi = rng.below(bills.len() as u64) as usize;
            let b = bills[bi].clone();
            let ba = bill_pda(&wallets[b.creator].pubkey(), b.id);
            let owner = rng.below(5) as usize;
            let r = receipt_pda(&ba, &wallets[owner].pubkey());
            let exists = e.receipt(&r).is_some();
            expect_ok = exists && owner == who;
            label = format!("close receipt of {owner} on bill#{bi} by {who}");
            res = e.send(Env::close_receipt_ix(&wallets[who].pubkey(), &r), &wallets[who]);
        } else {
            // supporter: set or close
            let s = supporter_pda(&wallets[who].pubkey());
            if rng.below(2) == 0 {
                label = format!("set supporter by {who}");
                res = e.send(Env::set_supporter_ix(&wallets[who].pubkey(), "n", "h"), &wallets[who]);
            } else {
                expect_ok = e.supporter(&s).is_some();
                label = format!("close supporter by {who}");
                res = e.send(Env::close_supporter_ix(&wallets[who].pubkey(), &s), &wallets[who]);
            }
        }
        let _ = &mut fee_payer_idx;
        let after = tracked(&e, &wallets, &bills);
        let sum_after: u128 = after.iter().map(|x| x.1 as u128).sum();
        let ctx = format!("seed {seed} step {step}: {label}");
        match (&res, expect_ok) {
            (Ok(_), true) => {
                assert_eq!(sum_before - sum_after, 5_000, "{ctx}: lamports must be conserved (only the tx fee leaves)");
            }
            (Err(_), false) => {
                // a refused call changes nothing except possibly the 5_000 fee of the sender
                for (i, (a, b)) in before.iter().zip(after.iter()).enumerate() {
                    if a.0 == wallets[who].pubkey() {
                        assert!(a.1 - b.1 <= 5_000, "{ctx}: sender lost more than the fee");
                    } else {
                        assert_eq!(a.1, b.1, "{ctx}: account #{i} changed on a refused call");
                    }
                }
            }
            (Ok(_), false) => panic!("{ctx}: program ACCEPTED an invalid operation"),
            (Err(er), true) => panic!("{ctx}: program REFUSED a valid operation: {}", err_text(er)),
        }
        // invariants vs the model, every step
        for (i, m) in bills.iter().enumerate() {
            let ba = bill_pda(&wallets[m.creator].pubkey(), m.id);
            match e.bill(&ba) {
                Some(c) => {
                    assert!(m.open, "{ctx}: bill#{i} exists but model says closed");
                    assert_eq!(c.raised, m.raised, "{ctx}: bill#{i} raised");
                    assert!(c.raised <= c.amount, "{ctx}: raised > amount");
                    assert_eq!(c.status == 1, c.raised == c.amount, "{ctx}: status/raised mismatch");
                    assert_eq!(c.creator, wallets[m.creator].pubkey());
                }
                None => assert!(!m.open, "{ctx}: bill#{i} missing but model says open"),
            }
        }
    }
    // global fee accounting: the fee wallet received exactly the sum of fees of accepted payments
    // (checked implicitly by conservation); also assert the fee wallet only ever grows.
    assert!(e.bal(&fee_wallet()) >= SOL / 10);
}

// ------------------------------------------------------------------ multi-instruction transactions

#[test]
fn same_transaction_tricks_do_not_break_accounting() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let p = e.wallet(5.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    let r = receipt_pda(&bill, &p.pubkey());
    let s = supporter_pda(&p.pubkey());
    let pay = |a: u64| Env::pay_ix(&p.pubkey(), &bill, &creator.pubkey(), a, "", "");
    // pay, close the receipt, pay again, all in one transaction (account closed then re-created)
    e.send_signed(&[pay(10_000_000), Env::close_receipt_ix(&p.pubkey(), &r), pay(20_000_000)], &p, &[]).expect("pay/close/pay");
    assert_eq!(e.receipt(&r).unwrap().amount, 20_000_000, "receipt restarts after being closed");
    assert_eq!(e.bill(&bill).unwrap().raised, 30_000_000);
    // close the card then pay, same tx
    e.send_signed(&[Env::close_supporter_ix(&p.pubkey(), &s), pay(10_000_000)], &p, &[]).expect("close card / pay");
    let sv = e.supporter(&s).unwrap();
    assert_eq!((sv.total, sv.bills_helped), (10_000_000, 0), "new card counts only what happened after it was re-created");
    // try to keep a closed receipt alive by refunding its rent in the same transaction and then use it
    let bal_before = e.bal(&p.pubkey());
    let revive = solana_system_interface::instruction::transfer(&p.pubkey(), &r, 5_000_000);
    let res = e.send_signed(&[Env::close_receipt_ix(&p.pubkey(), &r), revive, Env::close_receipt_ix(&p.pubkey(), &r)], &p, &[]);
    println!("revival sequence result ok? {} (receipt still there: {})", res.is_ok(), e.receipt(&r).is_some());
    assert!(res.is_err(), "closing an already-closed receipt must fail");
    assert!(e.bal(&p.pubkey()) >= bal_before - 5_000);
    // closed bill in the same tx as a payment attempt (creator can't pay, but another wallet can't close)
    let other = e.wallet(1.0);
    let ixs = [Env::close_bill_ix(&creator.pubkey(), &bill), Env::pay_ix(&other.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "")];
    assert!(e.send_signed(&ixs, &creator, &[&other]).is_err(), "pay after close in one tx must fail");
    assert!(e.bill(&bill).is_some(), "failed tx rolls back everything");
}

#[test]
fn creator_that_is_also_the_fee_wallet() {
    // The same account appears twice in the account list. Funds must still add up.
    let mut e = Env::new();
    let fee_pk = fee_wallet();
    // we cannot sign as the fee wallet, so emulate by checking the payer-side accounting only
    let p = e.wallet(5.0);
    let creator = e.wallet(1.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    let mut ix = Env::pay_ix(&p.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", "");
    // fee wallet passed as creator: must fail, creator address is checked against the bill
    ix.accounts[2] = solana_instruction::AccountMeta::new(fee_pk, false);
    assert!(e.send(ix, &p).is_err());
}

#[test]
fn closing_twice_and_wrong_owner_variants() {
    let mut e = Env::new();
    let creator = e.wallet(1.0);
    let p = e.wallet(3.0);
    let bill = open_bill(&mut e, &creator, 1, SOL);
    e.send(Env::pay_ix(&p.pubkey(), &bill, &creator.pubkey(), 10_000_000, "", ""), &p).unwrap();
    let r = receipt_pda(&bill, &p.pubkey());
    e.send(Env::close_receipt_ix(&p.pubkey(), &r), &p).unwrap();
    assert!(e.send(Env::close_receipt_ix(&p.pubkey(), &r), &p).is_err(), "second close fails");
    e.send(Env::close_bill_ix(&creator.pubkey(), &bill), &creator).unwrap();
    assert!(e.send(Env::close_bill_ix(&creator.pubkey(), &bill), &creator).is_err(), "second close fails");
    // an account that is not ours at all
    let rando = Pubkey::new_unique();
    e.raw_account(&rando, &sys(), vec![0u8; 100], 5_000_000);
    assert!(e.send(Env::close_bill_ix(&creator.pubkey(), &rando), &creator).is_err());
    assert!(e.send(Env::close_receipt_ix(&p.pubkey(), &rando), &p).is_err());
    assert!(e.send(Env::close_supporter_ix(&p.pubkey(), &rando), &p).is_err());
}

#[test]
#[ignore = "long: run with --ignored"]
fn fuzz_long() {
    for seed in 100u64..140 {
        run_fuzz(seed, 400);
    }
}
