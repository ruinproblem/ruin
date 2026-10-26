use crate::{error::RuinError, state::Config};
use anchor_lang::prelude::*;
pub const DOVES: Pubkey = pubkey!("DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e");
pub const ASSETS: [Pubkey; 3] = [
    pubkey!("So11111111111111111111111111111111111111112"),
    pubkey!("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"),
    pubkey!("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"),
];
pub const DISC: [u8; 8] = [0x70, 0xf9, 0x8b, 0xd9, 0xd7, 0xd0, 0xf9, 0x36];
pub struct Price {
    pub price: u64,
    pub publish_ts: i64,
}
pub fn read(a: &AccountInfo<'_>, market: u8, asset: Pubkey, now: i64, stale: u32) -> Result<Price> {
    require!(market < 3, RuinError::InvalidValue);
    let mut owner_ok = *a.owner == DOVES;
    #[cfg(feature = "devnet")]
    {
        owner_ok |= *a.owner == crate::ID
            && a.key() == Pubkey::find_program_address(&[b"dev_feed", &[market]], &crate::ID).0;
    }
    // Keep both feature builds warning-free.
    let _ = &mut owner_ok;
    require!(owner_ok, RuinError::FeedInvalid);
    let d = a.try_borrow_data()?;
    require!(
        d.len() == 394 && d[..8] == DISC && d[176] == 248,
        RuinError::FeedInvalid
    );
    require!(d[8..40] == asset.to_bytes(), RuinError::FeedAssetMismatch);
    let price = u64::from_le_bytes(d[168..176].try_into().map_err(|_| RuinError::FeedInvalid)?);
    let publish_ts =
        i64::from_le_bytes(d[177..185].try_into().map_err(|_| RuinError::FeedInvalid)?);
    require!(price > 0, RuinError::FeedInvalid);
    require!(
        i128::from(now) - i128::from(publish_ts) <= i128::from(stale),
        RuinError::FeedStale
    );
    Ok(Price { price, publish_ts })
}
pub fn configured(
    c: &Config,
    a: &AccountInfo<'_>,
    market: u8,
    now: i64,
    stale: u32,
) -> Result<Price> {
    let m = c
        .markets
        .get(usize::from(market))
        .ok_or(RuinError::InvalidValue)?;
    require_keys_eq!(a.key(), m.feed, RuinError::FeedNotConfig);
    read(a, market, m.asset, now, stale)
}
