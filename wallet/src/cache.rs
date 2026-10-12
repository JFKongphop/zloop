//! Compact blocks held in memory between download and scan. A sync run only keeps the range it
//! is working on, so nothing needs to reach disk.

use std::{convert::Infallible, sync::Mutex};

use async_trait::async_trait;
use zcash_client_backend::{
  data_api::{
    chain::{BlockCache, BlockSource, error},
    scanning::ScanRange,
  },
  proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

#[derive(Default)]
pub struct MemCache(Mutex<Vec<CompactBlock>>);

fn height(block: &CompactBlock) -> BlockHeight {
  BlockHeight::from_u32(block.height as u32)
}

impl BlockSource for MemCache {
  type Error = Infallible;

  fn with_blocks<F, WalletErrT>(
    &self,
    from_height: Option<BlockHeight>,
    limit: Option<usize>,
    mut with_block: F,
  ) -> Result<(), error::Error<WalletErrT, Self::Error>>
  where
    F: FnMut(CompactBlock) -> Result<(), error::Error<WalletErrT, Self::Error>>,
  {
    let mut blocks: Vec<CompactBlock> = self
      .0
      .lock()
      .unwrap()
      .iter()
      .filter(|b| from_height.is_none_or(|h| height(b) >= h))
      .cloned()
      .collect();
    blocks.sort_by_key(|b| b.height);
    for block in blocks.into_iter().take(limit.unwrap_or(usize::MAX)) {
      with_block(block)?;
    }
    Ok(())
  }
}

#[async_trait]
impl BlockCache for MemCache {
  fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
    Ok(
      self
        .0
        .lock()
        .unwrap()
        .iter()
        .map(height)
        .filter(|h| range.is_none_or(|r| r.block_range().contains(h)))
        .max(),
    )
  }

  async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
    Ok(
      self
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|b| range.block_range().contains(&height(b)))
        .cloned()
        .collect(),
    )
  }

  async fn insert(&self, mut compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
    self.0.lock().unwrap().append(&mut compact_blocks);
    Ok(())
  }

  async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
    self
      .0
      .lock()
      .unwrap()
      .retain(|b| !range.block_range().contains(&height(b)));
    Ok(())
  }
}
