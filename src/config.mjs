import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR =
  process.env.EVM_WALLET_DIR || path.join(os.homedir(), ".config", "evm-wallet");

export const FILES = {
  keystore: path.join(CONFIG_DIR, "keystore.json"),
  password: path.join(CONFIG_DIR, "password.txt"),
  mnemonic: path.join(CONFIG_DIR, "mnemonic.txt"),
  meta: path.join(CONFIG_DIR, "meta.json"),
  wcConfig: path.join(CONFIG_DIR, "wc.json"),
  wcStorage: path.join(CONFIG_DIR, "wc-storage"),
  auditLog: path.join(CONFIG_DIR, "audit.log"),
};

export const CHAINS = {
  ethereum: { chainId: 1, rpc: "https://ethereum-rpc.publicnode.com", symbol: "ETH" },
  bsc: { chainId: 56, rpc: "https://bsc-dataseed.binance.org", symbol: "BNB" },
  polygon: { chainId: 137, rpc: "https://polygon-rpc.com", symbol: "POL" },
  arbitrum: { chainId: 42161, rpc: "https://arb1.arbitrum.io/rpc", symbol: "ETH" },
  base: { chainId: 8453, rpc: "https://mainnet.base.org", symbol: "ETH" },
  optimism: { chainId: 10, rpc: "https://mainnet.optimism.io", symbol: "ETH" },
  sepolia: { chainId: 11155111, rpc: "https://ethereum-sepolia-rpc.publicnode.com", symbol: "ETH" },
};

export const SUPPORTED_WC_CHAIN_IDS = Object.values(CHAINS).map((c) => c.chainId);

export function resolveChain(nameOrId) {
  if (nameOrId === undefined || nameOrId === null || nameOrId === "") return CHAINS.bsc;
  const byName = CHAINS[String(nameOrId).toLowerCase()];
  if (byName) return byName;
  const id = Number(nameOrId);
  const byId = Object.values(CHAINS).find((c) => c.chainId === id);
  if (byId) return byId;
  throw new Error(`Unknown chain "${nameOrId}". Known: ${Object.keys(CHAINS).join(", ")} or a chainId.`);
}

export function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {}
}

export function writeSecretFile(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

export function audit(action, details = {}) {
  try {
    ensureConfigDir();
    const line = JSON.stringify({ t: new Date().toISOString(), action, ...details }) + "\n";
    fs.appendFileSync(FILES.auditLog, line, { mode: 0o600 });
  } catch {}
}
