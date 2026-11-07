# evm-wallet

A local EVM wallet that **simek can operate directly** — independent from the Binance
Agentic Wallet. Built for events and sites that require a wallet connection or a
wallet signature but do **not** offer Binance Agentic Wallet (e.g. "Connect Wallet"
dialogues that list MetaMask / WalletConnect, and SIWE sign-in flows).

## Why it exists

Binance Agentic Wallet (`baw`) can only sign EIP-712 typed data — it rejects
`personal_sign` (EIP-191), which many sign-in flows (SIWE) require. This wallet
signs EIP-191, EIP-712, and raw transactions, and can act as a WalletConnect v2
wallet for sites whose connect dialogue offers WalletConnect.

## Security model

- A **dedicated, separate wallet** (category: hunt). It is not the user's main
  wallet and shares nothing with the Binance Agentic Wallet.
- Private key is stored as an **ethers-encrypted keystore**; the keystore
  password and the recovery phrase live only in 600-permission files under
  `~/.config/evm-wallet/`. Secrets are **never printed** by any command.
- The wallet starts **empty**. Fund it per chain with small gas amounts only,
  as needed for a specific event.
- Every signature/transaction is still gated by the operator workflow: preview
  first, explicit user confirmation in chat, then execution. `tx-send`
  additionally refuses to run without `--confirm SEND`; WalletConnect
  `eth_sendTransaction` responses are blocked unless `--allow-tx` is passed.

## Usage

```bash
cd ~/workspace/evm-wallet
node bin/evm-wallet.mjs help
node bin/evm-wallet.mjs address
node bin/evm-wallet.mjs balance bsc
node bin/evm-wallet.mjs sign-message "squeekchain.com wants you to sign in ..."
node bin/evm-wallet.mjs sign-typed --file typed.json
node bin/evm-wallet.mjs tx-preview --chain bsc --to 0x... --value 0 --data 0x...
```

Supported chains: ethereum (1), bsc (56), polygon (137), arbitrum (42161),
base (8453), optimism (10), sepolia (11155111). Override an RPC with
`EVM_RPC_<chainId>=<url>`.

## Importing the user's own wallet (so the programme can transact as it)

```bash
# 1. The user fills ~/workspace/evm-wallet/import.env themselves (600):
#    EVM_PRIVATE_KEY=<64 hex chars, 0x prefix optional>
#    The key must never be sent via chat.
# 2. Import (with the user's public address as a safety check):
node bin/evm-wallet.mjs import-env --file import.env --expected-address 0x... --force
```

Behaviour: derives the address from the key and aborts (changing nothing) if
it does not match `--expected-address`; backs up any existing wallet into
`~/.config/evm-wallet/backup-<oldAddress>-<timestamp>/`; stores the imported
key only as an encrypted keystore with a fresh password; verifies the stored
keystore reloads to the same address; then **wipes the env file**. An imported
wallet has no recovery phrase in this programme. A public address alone can
only watch and prepare transactions — signing requires the key, which is what
this import provides.

## WalletConnect flow (sites that offer WalletConnect)

1. Get a free **projectId** at https://cloud.walletconnect.com (it is a public
   identifier, not a secret), then: `node bin/evm-wallet.mjs wc-set-project-id <projectId>`
2. On the site's connect dialogue choose **WalletConnect** and copy the `wc:...` URI.
3. `node bin/evm-wallet.mjs wc-pair --uri "wc:..."` — prints who is asking and what
   chains/methods they want. Nothing is approved automatically.
4. `node bin/evm-wallet.mjs wc-approve <proposalId>` after review/confirmation.
5. While interacting: `node bin/evm-wallet.mjs wc-serve --seconds 300` prints
   incoming signature/transaction requests as JSON lines; answer each with
   `wc-respond --id N --topic T --approve` (add `--allow-tx` only for a reviewed
   transaction) or `--reject`.

## Limitations

- It cannot inject itself as "MetaMask" into arbitrary web pages (browser
  extensions cannot be installed in the agent browser). For sites that offer
  **only** an injected MetaMask connection and no WalletConnect/API route, the
  user still connects from their own browser; this wallet covers the
  WalletConnect route and all API/prompt-driven signature flows (like
  Squeekchain's SIWE-over-API).
- WalletConnect requires the projectId above before `wc-*` commands work.
