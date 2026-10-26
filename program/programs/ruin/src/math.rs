use crate::{error::RuinError, state::*};
use anchor_lang::prelude::*;
use solana_sysvar::slot_hashes::PodSlotHashes;

pub fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| error!(RuinError::Overflow))
}
pub fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or_else(|| error!(RuinError::Overflow))
}
pub fn mul(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b).ok_or_else(|| error!(RuinError::Overflow))
}
pub fn narrow(a: u128) -> Result<u64> {
    u64::try_from(a).map_err(|_| error!(RuinError::Overflow))
}
pub fn lock(stake: u64, free: u64, rate: u64) -> Result<u64> {
    if stake <= free {
        return Ok(0);
    }
    require!(rate != 0, RuinError::StakeOverFree);
    narrow(
        u128::from(stake)
            .checked_mul(u128::from(rate))
            .and_then(|x| x.checked_add(999_999))
            .ok_or(RuinError::Overflow)?
            / 1_000_000,
    )
}
pub fn check_lock(h: &House) -> Result<()> {
    require!(
        h.ruin_locked >= lock(h.stake, h.free_stake, h.ruin_per_usd)?,
        RuinError::LockShort
    );
    Ok(())
}
pub fn claim(m: u64, k: u8, e: u16) -> Result<u128> {
    u128::from(m)
        .checked_mul(
            10_000u128
                .checked_add(
                    u128::from(k)
                        .checked_mul(
                            10_000u128
                                .checked_sub(u128::from(e))
                                .ok_or(RuinError::Overflow)?,
                        )
                        .ok_or(RuinError::Overflow)?,
                )
                .ok_or(RuinError::Overflow)?,
        )
        .ok_or_else(|| error!(RuinError::Overflow))
}
pub fn check_capacity(t: &Table, p0: u64) -> Result<()> {
    claim(t.m, t.k, t.e_bps)?
        .checked_mul(
            u128::from(p0)
                .checked_mul(add(1, u64::from(t.k))?.into())
                .ok_or(RuinError::Overflow)?,
        )
        .ok_or(RuinError::Overflow)?;
    Ok(())
}
pub struct Split {
    pub a: u64,
    pub b: u64,
    pub f_e9: u64,
    pub line: Option<End>,
}
pub fn split(side: Side, lev: u16, m: u64, k: u8, e: u16, p0: u64, p: u64) -> Result<Split> {
    require!(p0 > 0, RuinError::InvalidValue);
    let movement = i128::from(p)
        .checked_sub(i128::from(p0))
        .and_then(|v| v.checked_mul(i128::from(lev)))
        .ok_or(RuinError::Overflow)?;
    let num = match side {
        Side::Long => i128::from(p0).checked_add(movement),
        Side::Short => i128::from(p0).checked_sub(movement),
    }
    .ok_or(RuinError::Overflow)?;
    let den = i128::from(p0)
        .checked_mul(i128::from(k).checked_add(1).ok_or(RuinError::Overflow)?)
        .ok_or(RuinError::Overflow)?;
    let c = claim(m, k, e)?;
    let clamped = num.clamp(0, den) as u128;
    let a = if num >= den {
        narrow(c / 10_000)?
    } else {
        narrow(
            c.checked_mul(clamped).ok_or(RuinError::Overflow)?
                / (den as u128)
                    .checked_mul(10_000)
                    .ok_or(RuinError::Overflow)?,
        )?
    };
    Ok(Split {
        a,
        b: sub(mul(add(1, k.into())?, m)?, a)?,
        f_e9: narrow(
            clamped
                .checked_mul(1_000_000_000)
                .ok_or(RuinError::Overflow)?
                / den as u128,
        )?,
        line: if num <= 0 {
            Some(End::TraderLine)
        } else if num >= den {
            Some(End::HouseLine)
        } else {
            None
        },
    })
}
pub fn delay(slot: u64, min: u16, max: u16) -> Result<u64> {
    let hashes = PodSlotHashes::fetch()?;
    let hash = hashes
        .get(&slot)?
        .ok_or(RuinError::SlotHashMissing)?
        .to_bytes();
    let v = u64::from_le_bytes(
        hash[..8]
            .try_into()
            .map_err(|_| RuinError::SlotHashMissing)?,
    );
    add(min.into(), v % add(sub(max.into(), min.into())?, 1)?)
}
pub fn window(slot: u64, requested: u64, d: u64, width: u16) -> Result<()> {
    let start = add(requested, d)?;
    require!(slot >= start, RuinError::BeforeWindow);
    require!(slot <= add(start, width.into())?, RuinError::AfterWindow);
    Ok(())
}
pub fn passed(slot: u64, requested: u64, max: u16, width: u16) -> Result<()> {
    require!(
        slot > add(add(requested, max.into())?, width.into())?,
        RuinError::WindowNotPassed
    );
    Ok(())
}
