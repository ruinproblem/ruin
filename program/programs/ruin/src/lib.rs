use anchor_lang::prelude::*;
use anchor_spl::{token, token_interface};
pub mod contexts;
pub mod error;
pub mod events;
pub mod math;
pub mod mint;
pub mod oracle;
pub mod state;
use contexts::*;
use error::RuinError;
use events::*;
use math::*;
use state::*;

declare_id!("Ho2q71TyPF3ywjq5mwm8PoPZBT2bVk5jJsKWsrffeamw");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "ruin",
    project_url: "https://ruin.live",
    contacts: "email:admin@ruin.live",
    policy: "https://github.com/ruinproblem/ruin/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/ruinproblem/ruin"
}

#[program]
pub mod ruin {
    use super::*;

    pub fn init(ctx: Context<Init>, args: InitArgs) -> Result<()> {
        args.validate()?;
        let params = args.params();
        let q = ctx.accounts.quote_mint.to_account_info();
        let d = q.try_borrow_data()?;
        require!(
            *q.owner == token::ID && d.len() == 82 && d[44] == 6 && d[45] == 1,
            RuinError::QuoteMintInvalid
        );
        let clock = Clock::get()?;
        let mut markets = [Market::default(); 3];
        for (i, a) in [
            &ctx.accounts.sol_feed,
            &ctx.accounts.btc_feed,
            &ctx.accounts.eth_feed,
        ]
        .iter()
        .enumerate()
        {
            let data = a.try_borrow_data()?;
            require!(
                data.len() == 394 && data[8..40] == oracle::ASSETS[i].to_bytes(),
                RuinError::FeedInvalid
            );
            drop(data);
            oracle::read(
                &a.to_account_info(),
                i as u8,
                oracle::ASSETS[i],
                clock.unix_timestamp,
                params.stale_secs,
            )?;
            markets[i] = Market {
                feed: a.key(),
                asset: oracle::ASSETS[i],
            };
        }
        let c = &mut ctx.accounts.config;
        c.set_inner(Config {
            admin: args.admin,
            quote_mint: q.key(),
            ruin_mint: None,
            ruin_token_program: None,
            markets,
            lev_min: args.lev_min,
            lev_max: args.lev_max,
            k_min: args.k_min,
            k_max: args.k_max,
            e_min_bps: args.e_min_bps,
            e_max_bps: args.e_max_bps,
            expiry_secs: args.expiry_secs,
            m_min: 0,
            free_stake: 0,
            ruin_per_usd: 0,
            delay_min: 0,
            delay_max: 0,
            fill_window: 0,
            close_window: 0,
            stale_secs: 0,
            next_house_id: 0,
            bump: ctx.bumps.config,
        });
        c.apply(params);
        emit_cpi!(Initialized {
            admin: c.admin,
            quote_mint: c.quote_mint,
            markets,
            lev_min: c.lev_min,
            lev_max: c.lev_max,
            k_min: c.k_min,
            k_max: c.k_max,
            e_min_bps: c.e_min_bps,
            e_max_bps: c.e_max_bps,
            expiry_secs: c.expiry_secs,
            m_min: params.m_min,
            free_stake: params.free_stake,
            ruin_per_usd: params.ruin_per_usd,
            delay_min: params.delay_min,
            delay_max: params.delay_max,
            fill_window: params.fill_window,
            close_window: params.close_window,
            stale_secs: params.stale_secs
        });
        Ok(())
    }

    pub fn set_ruin(ctx: Context<SetRuin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(c.ruin_mint.is_none(), RuinError::RuinAlreadySet);
        let a = ctx.accounts.ruin_mint.to_account_info();
        mint::validate_mint(&a)?;
        let d = a.try_borrow_data()?;
        token_interface::Mint::try_deserialize(&mut &d[..])?;
        c.ruin_mint = Some(a.key());
        c.ruin_token_program = Some(*a.owner);
        emit_cpi!(RuinSet {
            ruin_mint: a.key(),
            ruin_token_program: *a.owner
        });
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn set_params(
        ctx: Context<SetParams>,
        m_min: u64,
        free_stake: u64,
        ruin_per_usd: u64,
        delay_min: u16,
        delay_max: u16,
        fill_window: u16,
        close_window: u16,
        stale_secs: u32,
    ) -> Result<()> {
        let params = Params {
            m_min,
            free_stake,
            ruin_per_usd,
            delay_min,
            delay_max,
            fill_window,
            close_window,
            stale_secs,
        };
        params.validate()?;
        ctx.accounts.config.apply(params);
        emit_cpi!(ParamsSet {
            m_min,
            free_stake,
            ruin_per_usd,
            delay_min,
            delay_max,
            fill_window,
            close_window,
            stale_secs
        });
        Ok(())
    }
    pub fn set_feed(ctx: Context<SetFeed>, market: u8) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let stale_secs = c.stale_secs;
        let m = c
            .markets
            .get_mut(usize::from(market))
            .ok_or(RuinError::InvalidValue)?;
        oracle::read(
            &ctx.accounts.feed.to_account_info(),
            market,
            m.asset,
            Clock::get()?.unix_timestamp,
            stale_secs,
        )?;
        let old_feed = m.feed;
        m.feed = ctx.accounts.feed.key();
        emit_cpi!(FeedSet {
            market,
            old_feed,
            new_feed: m.feed
        });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn post_house(
        ctx: Context<PostHouse>,
        id: u64,
        market: u8,
        sides: u8,
        k: u8,
        e_bps: u16,
        stake: u64,
        ruin_amount: u64,
    ) -> Result<()> {
        let c = &mut ctx.accounts.guard.config;
        require!(
            market < 3
                && (1..=3).contains(&sides)
                && (c.k_min..=c.k_max).contains(&k)
                && (c.e_min_bps..=c.e_max_bps).contains(&e_bps)
                && stake > 0,
            RuinError::InvalidValue
        );
        let rate = if c.ruin_mint.is_some() {
            c.ruin_per_usd
        } else {
            0
        };
        if ruin_amount > 0 {
            require!(c.ruin_mint.is_some(), RuinError::RuinNotSet);
            require!(rate > 0, RuinError::RuinNotEnabled);
        }
        let h = &mut ctx.accounts.house;
        h.set_inner(House {
            id,
            owner: ctx.accounts.owner.key(),
            market,
            sides,
            k,
            e_bps,
            stake,
            free_stake: c.free_stake,
            ruin_per_usd: rate,
            ruin_locked: ruin_amount,
            accepting: true,
            state: HouseState::Idle,
            next_seq: 0,
            current_seq: 0,
            bump: ctx.bumps.house,
            vault_bump: ctx.bumps.vault,
            // An absent vault uses a noncanonical bump, including when the canonical bump is zero.
            lock_vault_bump: ctx.bumps.lock_vault.unwrap_or_else(|| {
                Pubkey::find_program_address(&[b"lock_vault", h.key().as_ref()], &crate::ID).1 ^ 1
            }),
        });
        check_lock(h)?;
        let before = ctx.accounts.vault.amount;
        transfer(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.source.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            stake,
            6,
            &[],
            true,
        )?;
        ctx.accounts.vault.reload()?;
        require_eq!(
            sub(ctx.accounts.vault.amount, before)?,
            stake,
            RuinError::DepositMismatch
        );
        deposit_ruin(
            &ctx.accounts.ruin_mint,
            &ctx.accounts.ruin_token_program,
            &mut ctx.accounts.lock_vault,
            &ctx.accounts.ruin_account,
            &ctx.accounts.owner,
            ruin_amount,
        )?;
        c.next_house_id = add(c.next_house_id, 1)?;
        emit_cpi!(HousePosted {
            house: h.key(),
            id,
            owner: h.owner,
            market,
            sides,
            k,
            e_bps,
            stake,
            free_stake: h.free_stake,
            ruin_per_usd: h.ruin_per_usd,
            ruin_locked: h.ruin_locked
        });
        Ok(())
    }

    pub fn top_up(ctx: Context<TopUp>, quote_amount: u64, ruin_amount: u64) -> Result<()> {
        let h = &mut ctx.accounts.guard.house;
        require_keys_eq!(h.owner, ctx.accounts.owner.key(), RuinError::NotOwner);
        require!(quote_amount > 0 || ruin_amount > 0, RuinError::InvalidValue);
        if ruin_amount > 0 {
            require!(h.ruin_per_usd > 0, RuinError::RuinNotEnabled);
        }
        h.stake = add(h.stake, quote_amount)?;
        h.ruin_locked = add(h.ruin_locked, ruin_amount)?;
        check_lock(h)?;
        let before = ctx.accounts.vault.amount;
        if quote_amount > 0 {
            transfer(
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.source.to_account_info(),
                ctx.accounts.quote_mint.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                quote_amount,
                6,
                &[],
                true,
            )?;
            ctx.accounts.vault.reload()?;
            require_eq!(
                sub(ctx.accounts.vault.amount, before)?,
                quote_amount,
                RuinError::DepositMismatch
            );
        }
        deposit_ruin(
            &ctx.accounts.ruin_mint,
            &ctx.accounts.ruin_token_program,
            &mut ctx.accounts.lock_vault,
            &ctx.accounts.ruin_account,
            &ctx.accounts.owner,
            ruin_amount,
        )?;
        if let Some(b) = ctx.bumps.lock_vault {
            h.lock_vault_bump = b;
        }
        emit_cpi!(HouseFunded {
            house: h.key(),
            quote_in: quote_amount,
            ruin_in: ruin_amount,
            quote_out: 0,
            ruin_out: 0,
            stake: h.stake,
            ruin_locked: h.ruin_locked
        });
        Ok(())
    }
    pub fn withdraw(ctx: Context<Withdraw>, quote_amount: u64, ruin_amount: u64) -> Result<()> {
        let h = &mut ctx.accounts.house;
        require_keys_eq!(h.owner, ctx.accounts.owner.key(), RuinError::NotOwner);
        require!(h.state == HouseState::Idle, RuinError::NotIdle);
        require!(quote_amount > 0 || ruin_amount > 0, RuinError::InvalidValue);
        h.stake = sub(h.stake, quote_amount)?;
        h.ruin_locked = sub(h.ruin_locked, ruin_amount)?;
        check_lock(h)?;
        let id = h.id.to_le_bytes();
        let bump = [h.bump];
        let seeds: &[&[u8]] = &[b"house", &id, &bump];
        if quote_amount > 0 {
            transfer(
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.quote_mint.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                h.to_account_info(),
                quote_amount,
                6,
                &[seeds],
                true,
            )?;
        }
        send_ruin(
            &ctx.accounts.ruin_mint,
            &ctx.accounts.ruin_token_program,
            &ctx.accounts.lock_vault,
            &ctx.accounts.ruin_account,
            h.to_account_info(),
            ruin_amount,
            &[seeds],
        )?;
        emit_cpi!(HouseFunded {
            house: h.key(),
            quote_in: 0,
            ruin_in: 0,
            quote_out: quote_amount,
            ruin_out: ruin_amount,
            stake: h.stake,
            ruin_locked: h.ruin_locked
        });
        Ok(())
    }
    pub fn set_accepting(ctx: Context<SetAccepting>, accepting: bool) -> Result<()> {
        let h = &mut ctx.accounts.house;
        require_keys_eq!(h.owner, ctx.accounts.owner.key(), RuinError::NotOwner);
        h.accepting = accepting;
        emit_cpi!(HouseAccepting {
            house: h.key(),
            accepting
        });
        Ok(())
    }
    pub fn close_house(ctx: Context<CloseHouse>) -> Result<()> {
        let h = &ctx.accounts.house;
        require_keys_eq!(h.owner, ctx.accounts.owner.key(), RuinError::NotOwner);
        require!(h.state == HouseState::Idle, RuinError::NotIdle);
        // A vault may exist with only donated tokens, or with a zero balance.
        let (lock_address, lock_bump) =
            Pubkey::find_program_address(&[b"lock_vault", h.key().as_ref()], &crate::ID);
        if h.lock_vault_bump == lock_bump || h.ruin_locked > 0 {
            require!(
                ctx.accounts
                    .lock_vault
                    .as_ref()
                    .is_some_and(|v| v.key() == lock_address),
                RuinError::RuinNotSet
            );
        }
        let id = h.id.to_le_bytes();
        let bump = [h.bump];
        let seeds: &[&[u8]] = &[b"house", &id, &bump];
        let quote_returned = ctx.accounts.vault.amount;
        let ruin_returned = ctx.accounts.lock_vault.as_ref().map_or(0, |v| v.amount);
        if quote_returned > 0 {
            transfer(
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.quote_mint.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                h.to_account_info(),
                quote_returned,
                6,
                &[seeds],
                true,
            )?;
        }
        send_ruin(
            &ctx.accounts.ruin_mint,
            &ctx.accounts.ruin_token_program,
            &ctx.accounts.lock_vault,
            &ctx.accounts.ruin_account,
            h.to_account_info(),
            ruin_returned,
            &[seeds],
        )?;
        close_token(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            h.to_account_info(),
            &[seeds],
        )?;
        if let Some(v) = &ctx.accounts.lock_vault {
            close_token(
                ctx.accounts
                    .ruin_token_program
                    .as_ref()
                    .ok_or(RuinError::RuinNotSet)?
                    .to_account_info(),
                v.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                h.to_account_info(),
                &[seeds],
            )?;
        }
        emit_cpi!(HouseClosed {
            house: h.key(),
            owner: h.owner,
            quote_returned,
            ruin_returned
        });
        Ok(())
    }

    pub fn request_open(ctx: Context<RequestOpen>, side: Side, lev: u16, m: u64) -> Result<()> {
        let c = &ctx.accounts.guard.config;
        let h = &mut ctx.accounts.guard.house;
        require!(h.accepting, RuinError::NotAccepting);
        let mask = match side {
            Side::Long => 1,
            Side::Short => 2,
        };
        require!(h.sides & mask != 0, RuinError::SideNotAllowed);
        require!(
            (c.lev_min..=c.lev_max).contains(&lev),
            RuinError::LeverageOutOfRange
        );
        require!(m >= c.m_min, RuinError::MarginTooSmall);
        require!(mul(h.k.into(), m)? <= h.stake, RuinError::HouseTooSmall);
        check_lock(h)?;
        let clock = Clock::get()?;
        let p = oracle::configured(
            c,
            &ctx.accounts.feed.to_account_info(),
            h.market,
            clock.unix_timestamp,
            c.stale_secs,
        )?;
        let before = ctx.accounts.vault.amount;
        transfer(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.source.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.trader.to_account_info(),
            m,
            6,
            &[],
            true,
        )?;
        ctx.accounts.vault.reload()?;
        require_eq!(
            sub(ctx.accounts.vault.amount, before)?,
            m,
            RuinError::DepositMismatch
        );
        let t = &mut ctx.accounts.table;
        t.set_inner(Table {
            house: h.key(),
            seq: h.next_seq,
            trader: ctx.accounts.trader.key(),
            market: h.market,
            side,
            lev,
            m,
            k: h.k,
            e_bps: h.e_bps,
            delay_min: c.delay_min,
            delay_max: c.delay_max,
            fill_window: c.fill_window,
            close_window: c.close_window,
            stale_secs: c.stale_secs,
            expiry_secs: c.expiry_secs,
            state: TableState::Requested,
            request_slot: clock.slot,
            request_publish_ts: p.publish_ts,
            p0: 0,
            fill_slot: 0,
            fill_publish_ts: 0,
            fill_ts: 0,
            close_request_slot: 0,
            close_publish_ts: 0,
            bump: ctx.bumps.table,
        });
        h.current_seq = t.seq;
        h.next_seq = add(h.next_seq, 1)?;
        h.state = HouseState::Busy;
        emit_cpi!(OpenRequested {
            table: t.key(),
            house: h.key(),
            seq: t.seq,
            trader: t.trader,
            owner: h.owner,
            market: t.market,
            side,
            lev,
            m,
            k: t.k,
            e_bps: t.e_bps,
            request_slot: t.request_slot,
            request_publish_ts: t.request_publish_ts,
            request_price: p.price
        });
        Ok(())
    }
    pub fn fill_open(ctx: Context<FillOpen>) -> Result<()> {
        let t = &mut ctx.accounts.table;
        require!(t.state == TableState::Requested, RuinError::NotRequested);
        let clock = Clock::get()?;
        let d = delay(t.request_slot, t.delay_min, t.delay_max)?;
        window(clock.slot, t.request_slot, d, t.fill_window)?;
        let p = oracle::configured(
            &ctx.accounts.config,
            &ctx.accounts.feed.to_account_info(),
            t.market,
            clock.unix_timestamp,
            t.stale_secs,
        )?;
        require!(p.publish_ts > t.request_publish_ts, RuinError::FeedNotNewer);
        check_capacity(t, p.price)?;
        t.p0 = p.price;
        t.fill_slot = clock.slot;
        t.fill_publish_ts = p.publish_ts;
        t.fill_ts = clock.unix_timestamp;
        t.state = TableState::Open;
        emit_cpi!(Opened {
            table: t.key(),
            house: t.house,
            seq: t.seq,
            delay: d,
            p0: t.p0,
            fill_slot: t.fill_slot,
            fill_publish_ts: t.fill_publish_ts,
            fill_ts: t.fill_ts
        });
        Ok(())
    }
    pub fn refund_open(ctx: Context<RefundOpen>) -> Result<()> {
        let t = &ctx.accounts.table;
        let h = &mut ctx.accounts.house;
        require!(t.state == TableState::Requested, RuinError::NotRequested);
        let clock = Clock::get()?;
        passed(clock.slot, t.request_slot, t.delay_max, t.fill_window)?;
        let id = h.id.to_le_bytes();
        let bump = [h.bump];
        let seeds: &[&[u8]] = &[b"house", &id, &bump];
        transfer(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            h.to_account_info(),
            t.m,
            6,
            &[seeds],
            true,
        )?;
        h.state = HouseState::Idle;
        emit_cpi!(OpenRefunded {
            table: t.key(),
            house: t.house,
            seq: t.seq,
            trader: t.trader,
            m: t.m,
            slot: clock.slot
        });
        Ok(())
    }
    pub fn request_close(ctx: Context<RequestClose>) -> Result<()> {
        let t = &mut ctx.accounts.table;
        let clock = Clock::get()?;
        require_keys_eq!(ctx.accounts.trader.key(), t.trader, RuinError::NotTrader);
        require!(t.state != TableState::Requested, RuinError::NotLive);
        if t.state == TableState::CloseRequested {
            passed(
                clock.slot,
                t.close_request_slot,
                t.delay_max,
                t.close_window,
            )?;
        }
        let p = oracle::configured(
            &ctx.accounts.config,
            &ctx.accounts.feed.to_account_info(),
            t.market,
            clock.unix_timestamp,
            t.stale_secs,
        )?;
        t.state = TableState::CloseRequested;
        t.close_request_slot = clock.slot;
        t.close_publish_ts = p.publish_ts;
        emit_cpi!(CloseRequested {
            table: t.key(),
            house: t.house,
            seq: t.seq,
            close_request_slot: clock.slot,
            close_publish_ts: p.publish_ts,
            price: p.price
        });
        Ok(())
    }
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let t = &ctx.accounts.table;
        let h = &mut ctx.accounts.house;
        let clock = Clock::get()?;
        require!(t.state != TableState::Requested, RuinError::NotLive);
        let p = oracle::configured(
            &ctx.accounts.config,
            &ctx.accounts.feed.to_account_info(),
            t.market,
            clock.unix_timestamp,
            t.stale_secs,
        )?;
        require!(p.publish_ts >= t.fill_publish_ts, RuinError::FeedNotNewer);
        let s = split(t.side, t.lev, t.m, t.k, t.e_bps, t.p0, p.price)?;
        let end = if let Some(line) = s.line {
            line
        } else {
            let mut stop = false;
            if t.state == TableState::CloseRequested
                && p.publish_ts > t.close_publish_ts
                && clock.slot >= add(t.close_request_slot, t.delay_min.into())?
                && clock.slot
                    <= add(
                        add(t.close_request_slot, t.delay_max.into())?,
                        t.close_window.into(),
                    )?
            {
                let d = delay(t.close_request_slot, t.delay_min, t.delay_max)?;
                stop = window(clock.slot, t.close_request_slot, d, t.close_window).is_ok();
            }
            if stop {
                End::Stop
            } else if i128::from(clock.unix_timestamp)
                >= i128::from(t.fill_ts) + i128::from(t.expiry_secs)
            {
                End::Expiry
            } else {
                return err!(RuinError::NothingToSettle);
            }
        };
        if s.a > 0 {
            let destination = ctx
                .accounts
                .destination
                .as_ref()
                .ok_or(RuinError::MissingTraderAccount)?;
            let id = h.id.to_le_bytes();
            let bump = [h.bump];
            let seeds: &[&[u8]] = &[b"house", &id, &bump];
            transfer(
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.quote_mint.to_account_info(),
                destination.to_account_info(),
                h.to_account_info(),
                s.a,
                6,
                &[seeds],
                true,
            )?;
        }
        // Use a wide intermediate: a valid final stake can fit even if stake + m does not.
        h.stake = narrow(
            u128::from(h.stake)
                .checked_add(u128::from(t.m))
                .and_then(|x| x.checked_sub(u128::from(s.a)))
                .ok_or(RuinError::Overflow)?,
        )?;
        h.state = HouseState::Idle;
        emit_cpi!(Settled {
            table: t.key(),
            house: t.house,
            seq: t.seq,
            trader: t.trader,
            owner: h.owner,
            market: t.market,
            side: t.side,
            lev: t.lev,
            m: t.m,
            k: t.k,
            e_bps: t.e_bps,
            p0: t.p0,
            fill_slot: t.fill_slot,
            fill_publish_ts: t.fill_publish_ts,
            fill_ts: t.fill_ts,
            end,
            p_end: p.price,
            end_publish_ts: p.publish_ts,
            end_slot: clock.slot,
            end_ts: clock.unix_timestamp,
            f_e9: s.f_e9,
            a: s.a,
            b: s.b,
            stake_after: h.stake
        });
        Ok(())
    }

    #[cfg(feature = "devnet")]
    pub fn dev_feed_init(ctx: Context<DevFeedInit>, market: u8) -> Result<()> {
        let asset = oracle::ASSETS
            .get(usize::from(market))
            .ok_or(RuinError::InvalidValue)?;
        let mut d = ctx.accounts.feed.try_borrow_mut_data()?;
        d[..8].copy_from_slice(&oracle::DISC);
        d[8..40].copy_from_slice(asset.as_ref());
        d[168..176].copy_from_slice(&1u64.to_le_bytes());
        d[176] = 248;
        d[177..185].copy_from_slice(&Clock::get()?.unix_timestamp.to_le_bytes());
        drop(d);
        emit_cpi!(DevFeedUpdated {
            market,
            price: 1,
            publish_ts: Clock::get()?.unix_timestamp
        });
        Ok(())
    }
    #[cfg(feature = "devnet")]
    pub fn dev_feed_write(
        ctx: Context<DevFeedWrite>,
        market: u8,
        price: u64,
        publish_ts: i64,
    ) -> Result<()> {
        require!(market < 3 && price > 0, RuinError::InvalidValue);
        let mut d = ctx.accounts.feed.try_borrow_mut_data()?;
        d[168..176].copy_from_slice(&price.to_le_bytes());
        d[177..185].copy_from_slice(&publish_ts.to_le_bytes());
        drop(d);
        emit_cpi!(DevFeedUpdated {
            market,
            price,
            publish_ts
        });
        Ok(())
    }
}

#[cfg(feature = "devnet")]
#[event]
pub struct DevFeedUpdated {
    pub market: u8,
    pub price: u64,
    pub publish_ts: i64,
}

#[allow(clippy::too_many_arguments)]
fn transfer<'info>(
    program: AccountInfo<'info>,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    seeds: &[&[&[u8]]],
    quote: bool,
) -> Result<()> {
    if quote {
        token::transfer_checked(
            CpiContext::new_with_signer(
                program.key(),
                token::TransferChecked {
                    from,
                    mint,
                    to,
                    authority,
                },
                seeds,
            ),
            amount,
            decimals,
        )
    } else {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                program.key(),
                token_interface::TransferChecked {
                    from,
                    mint,
                    to,
                    authority,
                },
                seeds,
            ),
            amount,
            decimals,
        )
    }
}
fn close_token<'info>(
    program: AccountInfo<'info>,
    account: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    token_interface::close_account(
        CpiContext::new(
            program.key(),
            token_interface::CloseAccount {
                account,
                destination,
                authority,
            },
        )
        .with_signer(seeds),
    )
}
fn deposit_ruin<'info>(
    mint: &Option<Box<InterfaceAccount<'info, token_interface::Mint>>>,
    program: &Option<Interface<'info, token_interface::TokenInterface>>,
    vault: &mut Option<Box<InterfaceAccount<'info, token_interface::TokenAccount>>>,
    source: &Option<Box<InterfaceAccount<'info, token_interface::TokenAccount>>>,
    owner: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let mint = mint.as_ref().ok_or(RuinError::RuinNotSet)?;
    let program = program.as_ref().ok_or(RuinError::RuinNotSet)?;
    let vault = vault.as_mut().ok_or(RuinError::RuinNotSet)?;
    let source = source.as_ref().ok_or(RuinError::RuinNotSet)?;
    let before = vault.amount;
    transfer(
        program.to_account_info(),
        source.to_account_info(),
        mint.to_account_info(),
        vault.to_account_info(),
        owner.to_account_info(),
        amount,
        mint.decimals,
        &[],
        false,
    )?;
    vault.reload()?;
    require_eq!(
        sub(vault.amount, before)?,
        amount,
        RuinError::DepositMismatch
    );
    Ok(())
}
fn send_ruin<'info>(
    mint: &Option<Box<InterfaceAccount<'info, token_interface::Mint>>>,
    program: &Option<Interface<'info, token_interface::TokenInterface>>,
    vault: &Option<Box<InterfaceAccount<'info, token_interface::TokenAccount>>>,
    destination: &Option<Box<InterfaceAccount<'info, token_interface::TokenAccount>>>,
    authority: AccountInfo<'info>,
    amount: u64,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let mint = mint.as_ref().ok_or(RuinError::RuinNotSet)?;
    let program = program.as_ref().ok_or(RuinError::RuinNotSet)?;
    let vault = vault.as_ref().ok_or(RuinError::RuinNotSet)?;
    let to = destination.as_ref().ok_or(RuinError::RuinNotSet)?;
    transfer(
        program.to_account_info(),
        vault.to_account_info(),
        mint.to_account_info(),
        to.to_account_info(),
        authority,
        amount,
        mint.decimals,
        seeds,
        false,
    )
}
