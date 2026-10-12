//! One wallet directory = one seed, one account, one network.
//!
//! Files in the directory:
//! - `wallet.json`: network and server (no secrets)
//! - `seed.txt`: the recovery phrase, readable by the owner only; absent for view-only wallets
//! - `data.sqlite`: what the wallet has seen on chain

use std::{
  collections::BTreeSet,
  fs,
  os::unix::fs::{OpenOptionsExt, PermissionsExt},
  path::{Path, PathBuf},
  str::FromStr,
};

use anyhow::{Context, anyhow, bail};
use bip0039::{Count, English, Mnemonic};
use rand::rngs::OsRng;
use secrecy::{ExposeSecret, SecretVec};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tonic::{
  Code,
  transport::{Channel, ClientTlsConfig},
};
use zcash_address::ZcashAddress;
use zcash_client_backend::{
  data_api::{
    Account, AccountBirthday, AccountPurpose, TransactionDataRequest, TransactionStatus,
    WalletRead, WalletWrite,
    error::Error as WalletError,
    wallet::{
      ConfirmationsPolicy, SpendingKeys, create_proposed_transactions,
      decrypt_and_store_transaction,
      input_selection::{GreedyInputSelector, GreedyInputSelectorError, SpendPolicy},
      propose_transfer,
    },
  },
  fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule, standard::MultiOutputChangeStrategy},
  proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
  wallet::OvkPolicy,
};
use zcash_client_sqlite::{
  ReceivedNoteId, WalletDb,
  error::SqliteClientError,
  util::SystemClock,
  wallet::{commitment_tree, init::init_wallet_db},
};
use zcash_keys::{
  address::Address,
  keys::{UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey},
};
use zcash_primitives::transaction::{Transaction, fees::zip317};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
  ShieldedPool,
  consensus::{BlockHeight, BranchId, Network},
  memo::{Memo, MemoBytes},
  value::Zatoshis,
};
use zip321::{Payment, TransactionRequest};

use crate::cache::MemCache;

const BATCH_SIZE: u32 = 10_000;
/// How far behind the chain tip a new wallet starts scanning.
const BIRTHDAY_MARGIN: u32 = 100;

type Db = WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;
type Client = CompactTxStreamerClient<Channel>;
type SendError = WalletError<
  SqliteClientError,
  commitment_tree::Error,
  GreedyInputSelectorError,
  zip317::FeeError,
  zip317::FeeError,
  ReceivedNoteId,
>;

#[derive(Serialize, Deserialize)]
struct Config {
  network: String,
  server: String,
}

pub struct Wallet {
  dir: PathBuf,
  params: Network,
  server: String,
}

#[derive(Serialize)]
pub struct Info {
  pub network: String,
  pub address: String,
  pub viewing_key: String,
  /// SHA-256 of the viewing key text. Published when a market opens, so the key shown at
  /// close can be checked against it.
  pub viewing_key_fingerprint: String,
  pub can_spend: bool,
}

#[derive(Serialize)]
pub struct Received {
  pub txid: String,
  pub mined_height: Option<u32>,
  pub zats: u64,
  pub memo: Option<String>,
}

/// A payment the wallet made to someone else.
#[derive(Serialize)]
pub struct Sent {
  pub txid: String,
  pub mined_height: Option<u32>,
  pub to: Option<String>,
  pub zats: u64,
  pub memo: Option<String>,
}

#[derive(Deserialize)]
pub struct Outgoing {
  pub to: String,
  pub zats: u64,
  pub memo: Option<String>,
}

#[derive(Serialize)]
pub struct Balance {
  pub spendable_zats: u64,
  pub pending_zats: u64,
  pub chain_tip: Option<u32>,
}

fn parse_network(name: &str) -> anyhow::Result<Network> {
  match name {
    "main" => Ok(Network::MainNetwork),
    "test" => Ok(Network::TestNetwork),
    other => bail!("unknown network `{other}`; expected `main` or `test`"),
  }
}

fn default_server(params: Network) -> &'static str {
  match params {
    Network::MainNetwork => "zec.rocks:443",
    Network::TestNetwork => "testnet.zec.rocks:443",
  }
}

pub fn fingerprint(viewing_key: &str) -> String {
  hex::encode(Sha256::digest(viewing_key.as_bytes()))
}

impl Wallet {
  pub fn open(dir: &Path) -> anyhow::Result<Self> {
    let raw = fs::read_to_string(dir.join("wallet.json"))
      .with_context(|| format!("no wallet in {}; run `init` first", dir.display()))?;
    let config: Config = serde_json::from_str(&raw)?;
    Ok(Self {
      dir: dir.to_owned(),
      params: parse_network(&config.network)?,
      server: config.server,
    })
  }

  fn db(&self) -> anyhow::Result<Db> {
    Ok(WalletDb::for_path(
      self.dir.join("data.sqlite"),
      self.params,
      SystemClock,
      OsRng,
    )?)
  }

  async fn connect(&self) -> anyhow::Result<Client> {
    connect(&self.server).await
  }

  fn write_config(dir: &Path, network: &str, server: &str) -> anyhow::Result<()> {
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    if dir.join("wallet.json").exists() {
      bail!("a wallet already exists in {}", dir.display());
    }
    let config = Config {
      network: network.to_owned(),
      server: server.to_owned(),
    };
    fs::write(
      dir.join("wallet.json"),
      serde_json::to_string_pretty(&config)?,
    )?;
    Ok(())
  }

  /// Creates a wallet with a fresh recovery phrase. The phrase is written to `seed.txt` and
  /// never printed.
  pub async fn init(dir: &Path, network: &str, server: Option<String>) -> anyhow::Result<Self> {
    let params = parse_network(network)?;
    let server = server.unwrap_or_else(|| default_server(params).to_owned());
    let mut client = connect(&server).await?;
    let birthday = birthday(&mut client, None).await?;
    Self::write_config(dir, network, &server)?;

    let mnemonic = <Mnemonic<English>>::generate(Count::Words24);
    {
      use std::io::Write;
      let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(dir.join("seed.txt"))?;
      writeln!(f, "{}", mnemonic.phrase())?;
    }
    let seed = SecretVec::new(mnemonic.to_seed("").to_vec());

    let wallet = Self {
      dir: dir.to_owned(),
      params,
      server,
    };
    let mut db = wallet.db()?;
    init_wallet_db(&mut db, None).map_err(|e| anyhow!("{e:?}"))?;
    db.create_account("zloop", &seed, &birthday, None)?;
    Ok(wallet)
  }

  /// Creates a view-only wallet from a published viewing key. This is what an auditor runs.
  pub async fn init_view_only(
    dir: &Path,
    network: &str,
    server: Option<String>,
    viewing_key: &str,
    birthday_height: Option<u32>,
  ) -> anyhow::Result<Self> {
    let params = parse_network(network)?;
    let server = server.unwrap_or_else(|| default_server(params).to_owned());
    let ufvk = UnifiedFullViewingKey::decode(&params, viewing_key)
      .map_err(|e| anyhow!("invalid viewing key: {e}"))?;
    let mut client = connect(&server).await?;
    let birthday = birthday(&mut client, birthday_height).await?;
    Self::write_config(dir, network, &server)?;

    let wallet = Self {
      dir: dir.to_owned(),
      params,
      server,
    };
    let mut db = wallet.db()?;
    init_wallet_db(&mut db, None).map_err(|e| anyhow!("{e:?}"))?;
    db.import_account_ufvk(
      "zloop-view",
      &ufvk,
      &birthday,
      AccountPurpose::ViewOnly,
      None,
    )?;
    Ok(wallet)
  }

  pub fn info(&self) -> anyhow::Result<Info> {
    let db = self.db()?;
    let account = only_account(&db)?;
    let (address, _) = account
      .uivk()
      .default_address(UnifiedAddressRequest::AllAvailableKeys)?;
    let viewing_key = account
      .ufvk()
      .ok_or(anyhow!("account has no full viewing key"))?
      .encode(&self.params);
    Ok(Info {
      network: match self.params {
        Network::MainNetwork => "main",
        Network::TestNetwork => "test",
      }
      .to_owned(),
      address: address.encode(&self.params),
      viewing_key_fingerprint: fingerprint(&viewing_key),
      viewing_key,
      can_spend: self.dir.join("seed.txt").exists(),
    })
  }

  /// Scans new blocks, then fetches the full transactions the wallet is part of, which is
  /// where the memos are.
  pub async fn sync(&self) -> anyhow::Result<u32> {
    let mut client = self.connect().await?;
    let mut db = self.db()?;
    let cache = MemCache::default();
    zcash_client_backend::sync::run(&mut client, &self.params, &cache, &mut db, BATCH_SIZE)
      .await
      .map_err(|e| anyhow!("sync failed: {e}"))?;

    let chain_tip = db
      .chain_height()?
      .ok_or(anyhow!("chain height unknown after sync"))?;

    let mut done = BTreeSet::new();
    loop {
      let mut progressed = false;
      for request in db.transaction_data_requests()? {
        if !done.insert(request.clone()) {
          continue;
        }
        progressed = true;
        match &request {
          TransactionDataRequest::GetStatus(txid) => {
            let status = match self.fetch_tx(&mut client, chain_tip, txid.as_ref()).await? {
              None => TransactionStatus::TxidNotRecognized,
              Some((_, None)) => TransactionStatus::NotInMainChain,
              Some((_, Some(h))) => TransactionStatus::Mined(h),
            };
            db.set_transaction_status(*txid, status)?;
          }
          TransactionDataRequest::Enhancement(txid) => {
            match self.fetch_tx(&mut client, chain_tip, txid.as_ref()).await? {
              None => db.set_transaction_status(*txid, TransactionStatus::TxidNotRecognized)?,
              Some((tx, mined_height)) => {
                decrypt_and_store_transaction(&self.params, &mut db, &tx, mined_height)?
              }
            }
          }
        }
      }
      if !progressed {
        break;
      }
    }
    Ok(u32::from(chain_tip))
  }

  async fn fetch_tx(
    &self,
    client: &mut Client,
    chain_tip: BlockHeight,
    txid: &[u8; 32],
  ) -> anyhow::Result<Option<(Transaction, Option<BlockHeight>)>> {
    let request = service::TxFilter {
      hash: txid.to_vec(),
      ..Default::default()
    };
    let raw = match client.get_transaction(request).await {
      Ok(response) => response.into_inner(),
      Err(status) if status.code() == Code::NotFound => return Ok(None),
      Err(status) => return Err(status.into()),
    };
    let mined_height = (raw.height > 0 && raw.height <= u64::from(u32::MAX))
      .then(|| BlockHeight::from_u32(raw.height as u32));
    let tx = Transaction::read(
      &raw.data[..],
      BranchId::for_height(&self.params, mined_height.unwrap_or(chain_tip)),
    )?;
    Ok(Some((tx, mined_height)))
  }

  /// Payments received from outside the wallet, oldest first. Change is left out.
  pub fn received(&self) -> anyhow::Result<Vec<Received>> {
    let conn = rusqlite::Connection::open(self.dir.join("data.sqlite"))?;
    let mut stmt = conn.prepare(
      "SELECT o.txid, t.mined_height, o.value, o.memo
             FROM v_tx_outputs o
             JOIN v_transactions t ON t.txid = o.txid
             WHERE o.to_account_uuid IS NOT NULL
               AND o.from_account_uuid IS NULL
               AND o.is_change = 0
             GROUP BY o.txid, o.output_pool, o.output_index
             ORDER BY t.mined_height IS NULL, t.mined_height, o.output_index",
    )?;
    let rows = stmt.query_map([], |row| {
      let mut txid: Vec<u8> = row.get(0)?;
      // Transaction ids are shown in the reverse of their stored byte order.
      txid.reverse();
      Ok(Received {
        txid: hex::encode(txid),
        mined_height: row.get(1)?,
        zats: row.get::<_, i64>(2)? as u64,
        memo: row
          .get::<_, Option<Vec<u8>>>(3)?
          .and_then(|m| memo_text(&m)),
      })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
  }

  /// Payments made to addresses outside the wallet, oldest first. A view-only wallet sees
  /// these too, which is what lets an auditor check payouts.
  pub fn sent(&self) -> anyhow::Result<Vec<Sent>> {
    let conn = rusqlite::Connection::open(self.dir.join("data.sqlite"))?;
    let mut stmt = conn.prepare(
      "SELECT o.txid, t.mined_height, o.to_address, o.value, o.memo
             FROM v_tx_outputs o
             JOIN v_transactions t ON t.txid = o.txid
             WHERE o.from_account_uuid IS NOT NULL
               AND o.to_account_uuid IS NULL
               AND o.is_change = 0
             GROUP BY o.txid, o.output_pool, o.output_index
             ORDER BY t.mined_height IS NULL, t.mined_height, o.output_index",
    )?;
    let rows = stmt.query_map([], |row| {
      let mut txid: Vec<u8> = row.get(0)?;
      txid.reverse();
      Ok(Sent {
        txid: hex::encode(txid),
        mined_height: row.get(1)?,
        to: row.get(2)?,
        zats: row.get::<_, i64>(3)? as u64,
        memo: row
          .get::<_, Option<Vec<u8>>>(4)?
          .and_then(|m| memo_text(&m)),
      })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
  }

  /// Whether `address` is valid on this network and can receive a shielded payment with a memo.
  pub fn accepts_memo(&self, address: &str) -> bool {
    match Address::decode(&self.params, address) {
      Some(Address::Sapling(_)) => true,
      Some(Address::Unified(ua)) => ua.has_orchard() || ua.has_sapling(),
      _ => false,
    }
  }

  pub fn balance(&self) -> anyhow::Result<Balance> {
    let db = self.db()?;
    let account = only_account(&db)?;
    let chain_tip = db.chain_height()?.map(u32::from);
    let Some(summary) = db.get_wallet_summary(ConfirmationsPolicy::default())? else {
      return Ok(Balance {
        spendable_zats: 0,
        pending_zats: 0,
        chain_tip,
      });
    };
    let balance = summary
      .account_balances()
      .get(&account.id())
      .ok_or(anyhow!("no balance for the account"))?;
    Ok(Balance {
      spendable_zats: balance.spendable_value().into_u64(),
      pending_zats: (balance.change_pending_confirmation() + balance.value_pending_spendability())
        .map_or(0, |z| z.into_u64()),
      chain_tip,
    })
  }

  /// Sends every payment in one shielded transaction and returns its id. Call `sync` first.
  pub async fn send(&self, payments: &[Outgoing]) -> anyhow::Result<String> {
    let phrase = fs::read_to_string(self.dir.join("seed.txt"))
      .context("this wallet is view-only: it has no seed.txt")?;
    let mnemonic = <Mnemonic<English>>::from_phrase(phrase.trim())?;
    let seed = SecretVec::new(mnemonic.to_seed("").to_vec());

    let mut db = self.db()?;
    let account = only_account(&db)?;
    let derivation = account
      .source()
      .key_derivation()
      .ok_or(anyhow!("cannot spend from a view-only account"))?;
    let usk = UnifiedSpendingKey::from_seed(
      &self.params,
      seed.expose_secret(),
      derivation.account_index(),
    )
    .map_err(|e| anyhow!("{e:?}"))?;

    let payments = payments
      .iter()
      .map(|p| {
        Payment::new(
          ZcashAddress::from_str(&p.to)
            .map_err(|_| anyhow!("invalid recipient address: {}", p.to))?,
          Some(Zatoshis::from_u64(p.zats).map_err(|_| anyhow!("invalid amount"))?),
          p.memo
            .as_deref()
            .map(Memo::from_str)
            .transpose()
            .map_err(|_| anyhow!("memo is too long or not valid text"))?
            .map(MemoBytes::from),
          None,
          None,
          vec![],
        )
        .map_err(|e| anyhow!("{e:?}"))
      })
      .collect::<anyhow::Result<Vec<_>>>()?;
    let request = TransactionRequest::new(payments).map_err(|e| anyhow!("{e:?}"))?;

    let change_strategy = MultiOutputChangeStrategy::new(
      StandardFeeRule::Zip317,
      None,
      ShieldedPool::Orchard,
      DustOutputPolicy::default(),
      SplitPolicy::single_output(),
    );
    let proposal = propose_transfer(
      &mut db,
      &self.params,
      account.id(),
      &GreedyInputSelector::new(),
      &change_strategy,
      request,
      ConfirmationsPolicy::default(),
      &SpendPolicy::default(),
      None,
      None,
    )
    .map_err(|e: SendError| anyhow!("could not build the payment: {e}"))?;

    let prover = LocalTxProver::bundled();
    let txids = create_proposed_transactions(
      &mut db,
      &self.params,
      &prover,
      &prover,
      &SpendingKeys::from_unified_spending_key(usk),
      OvkPolicy::Sender,
      &proposal,
      None,
    )
    .map_err(|e: SendError| anyhow!("could not create the transaction: {e}"))?;
    if txids.len() > 1 {
      bail!("the payment needs more than one transaction, which is not supported");
    }

    let tx = db
      .get_transaction(*txids.first())?
      .ok_or(anyhow!("created transaction not found"))?;
    let mut raw = service::RawTransaction::default();
    tx.write(&mut raw.data)?;
    let mut client = self.connect().await?;
    let response = client.send_transaction(raw).await?.into_inner();
    if response.error_code != 0 {
      bail!(
        "the network rejected the transaction ({}): {}",
        response.error_code,
        response.error_message
      );
    }
    Ok(tx.txid().to_string())
  }
}

async fn connect(server: &str) -> anyhow::Result<Client> {
  let host = server.split(':').next().unwrap_or(server);
  let tls = ClientTlsConfig::new()
    .domain_name(host.to_owned())
    .assume_http2(true)
    .with_webpki_roots();
  let channel = Channel::from_shared(format!("https://{server}"))?
    .tls_config(tls)?
    .connect()
    .await
    .with_context(|| format!("cannot reach {server}"))?;
  Ok(CompactTxStreamerClient::new(channel))
}

async fn birthday(client: &mut Client, height: Option<u32>) -> anyhow::Result<AccountBirthday> {
  let height = match height {
    Some(h) => h,
    None => {
      let tip = client
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner()
        .height;
      (tip as u32).saturating_sub(BIRTHDAY_MARGIN)
    }
  };
  let treestate = client
    .get_tree_state(service::BlockId {
      height: u64::from(height) - 1,
      ..Default::default()
    })
    .await?
    .into_inner();
  AccountBirthday::from_treestate(treestate, None).map_err(|_| anyhow!("invalid tree state"))
}

fn only_account(db: &Db) -> anyhow::Result<<Db as WalletRead>::Account> {
  let ids = db.get_account_ids()?;
  let [id] = ids[..] else {
    bail!("expected exactly one account, found {}", ids.len());
  };
  db.get_account(id)?.ok_or(anyhow!("account not found"))
}

/// A memo is 512 bytes; text memos start with a byte below 0xF5 and are padded with zeros.
fn memo_text(bytes: &[u8]) -> Option<String> {
  let first = *bytes.first()?;
  if first >= 0xF5 {
    return None;
  }
  let end = bytes.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
  let text = std::str::from_utf8(&bytes[..end]).ok()?;
  (!text.is_empty()).then(|| text.to_owned())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn memo_text_strips_padding() {
    let mut bytes = b"bet:v1 id=abc".to_vec();
    bytes.resize(512, 0);
    assert_eq!(memo_text(&bytes).as_deref(), Some("bet:v1 id=abc"));
  }

  #[test]
  fn memo_text_ignores_empty_and_binary_memos() {
    let mut empty = vec![0xF6];
    empty.resize(512, 0);
    assert_eq!(memo_text(&empty), None);
    assert_eq!(memo_text(&[0u8; 512]), None);
  }

  #[test]
  fn fingerprint_is_stable() {
    assert_eq!(
      fingerprint("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  }
}
