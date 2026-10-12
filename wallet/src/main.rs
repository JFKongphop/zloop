//! `zloop-wallet`: every command prints one JSON object or array, so the market server can
//! call it and parse the result.

mod cache;
mod wallet;

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use serde_json::json;

use wallet::{Outgoing, Wallet};

#[derive(Parser)]
#[command(version, about)]
struct Cli {
  /// Wallet directory. Keep it outside the repository: it holds the recovery phrase.
  #[arg(long)]
  dir: PathBuf,

  #[command(subcommand)]
  command: Command,
}

#[derive(Subcommand)]
enum Command {
  /// Create a wallet with a new recovery phrase
  Init {
    /// `main` or `test`
    #[arg(long)]
    network: String,
    /// Server as host:port; defaults to a public server for the network
    #[arg(long)]
    server: Option<String>,
  },
  /// Create a view-only wallet from a viewing key, to audit a market
  Watch {
    #[arg(long)]
    network: String,
    #[arg(long)]
    server: Option<String>,
    #[arg(long)]
    viewing_key: String,
    /// Block height to start scanning from; defaults to just before the chain tip
    #[arg(long)]
    birthday: Option<u32>,
  },
  /// Show the address, the viewing key and its fingerprint
  Info,
  /// Catch up with the chain and read memos
  Sync,
  /// List payments received from outside, with their memos
  Received,
  /// Show the balance as of the last sync
  Balance,
  /// List payments made to others, with their memos
  Sent,
  /// Check that an address can receive a shielded payment with a memo
  Check {
    #[arg(long)]
    address: String,
  },
  /// Send a shielded payment
  Send {
    #[arg(long)]
    to: String,
    /// Amount in zatoshis (1 ZEC = 100,000,000)
    #[arg(long)]
    zats: u64,
    #[arg(long)]
    memo: Option<String>,
  },
  /// Send several payments in one transaction
  Pay {
    /// JSON array of `{"to", "zats", "memo"}`
    #[arg(long)]
    payments: String,
  },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
  let cli = Cli::parse();
  // Both TLS backends end up in the dependency tree, so one has to be chosen explicitly.
  let _ = rustls::crypto::ring::default_provider().install_default();
  let out = match cli.command {
    Command::Init { network, server } => {
      let wallet = Wallet::init(&cli.dir, &network, server).await?;
      serde_json::to_value(wallet.info()?)?
    }
    Command::Watch {
      network,
      server,
      viewing_key,
      birthday,
    } => {
      let wallet =
        Wallet::init_view_only(&cli.dir, &network, server, &viewing_key, birthday).await?;
      serde_json::to_value(wallet.info()?)?
    }
    Command::Info => serde_json::to_value(Wallet::open(&cli.dir)?.info()?)?,
    Command::Sync => json!({ "chain_tip": Wallet::open(&cli.dir)?.sync().await? }),
    Command::Received => serde_json::to_value(Wallet::open(&cli.dir)?.received()?)?,
    Command::Balance => serde_json::to_value(Wallet::open(&cli.dir)?.balance()?)?,
    Command::Sent => serde_json::to_value(Wallet::open(&cli.dir)?.sent()?)?,
    Command::Check { address } => {
      json!({ "accepts_memo": Wallet::open(&cli.dir)?.accepts_memo(&address) })
    }
    Command::Send { to, zats, memo } => {
      let txid = Wallet::open(&cli.dir)?
        .send(&[Outgoing { to, zats, memo }])
        .await?;
      json!({ "txid": txid })
    }
    Command::Pay { payments } => {
      let payments: Vec<Outgoing> = serde_json::from_str(&payments)?;
      json!({ "txid": Wallet::open(&cli.dir)?.send(&payments).await? })
    }
  };
  println!("{out}");
  Ok(())
}
