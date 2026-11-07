import crypto from "node:crypto";
import fs from "node:fs";
import { ethers } from "ethers";
import { CONFIG_DIR, FILES, ensureConfigDir, writeSecretFile, resolveChain } from "./config.mjs";

export function walletExists() {
  return fs.existsSync(FILES.keystore) && fs.existsSync(FILES.password);
}

export async function createWallet(label = "hunt") {
  ensureConfigDir();
  if (walletExists()) {
    const meta = JSON.parse(fs.readFileSync(FILES.meta, "utf8"));
    return { address: meta.address, created: false };
  }
  const wallet = ethers.Wallet.createRandom();
  const address = wallet.address;
  const password = crypto.randomBytes(32).toString("hex");
  const keystore = await wallet.encrypt(password);

  writeSecretFile(FILES.password, password);
  writeSecretFile(FILES.keystore, keystore);
  if (wallet.mnemonic?.phrase) {
    // Recovery phrase is stored ONLY in this 600-permission file. It is never printed.
    writeSecretFile(FILES.mnemonic, wallet.mnemonic.phrase + "\n");
  }
  const meta = {
    address,
    label,
    category: "hunt",
    createdAt: new Date().toISOString(),
    note: "Dedicated EVM wallet operated via ~/workspace/evm-wallet. Independent from Binance Agentic Wallet (poeroro.ai).",
  };
  writeSecretFile(FILES.meta, JSON.stringify(meta, null, 2));
  return { address, created: true };
}

export async function loadWallet() {
  if (!walletExists()) {
    throw new Error("Wallet not initialised yet. Run: evm-wallet init");
  }
  const keystore = fs.readFileSync(FILES.keystore, "utf8");
  const password = fs.readFileSync(FILES.password, "utf8").trim();
  const wallet = await ethers.Wallet.fromEncryptedJson(keystore, password);
  return wallet;
}

export function readMeta() {
  if (!fs.existsSync(FILES.meta)) return null;
  return JSON.parse(fs.readFileSync(FILES.meta, "utf8"));
}

// --- Import a user-owned wallet from a private key in an env file ----------
// The key is read from a local env file the user fills in themselves
// (EVM_PRIVATE_KEY=0x...). It is never printed or logged. On success the key
// is stored only as an encrypted keystore, the previous wallet (if any) is
// backed up inside the config dir, and the env file is wiped.
export function readPrivateKeyFromEnvFile(envFile) {
  if (!fs.existsSync(envFile)) {
    throw new Error(`Env file not found: ${envFile}`);
  }
  const text = fs.readFileSync(envFile, "utf8");
  let raw = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*EVM_PRIVATE_KEY\s*=\s*(.*)\s*$/);
    if (m) raw = m[1];
  }
  if (raw === null) throw new Error("Env file has no EVM_PRIVATE_KEY line.");
  const key = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!key || key.includes("ISI") || key.includes("<")) {
    throw new Error("EVM_PRIVATE_KEY is still empty / placeholder in the env file.");
  }
  const hex = key.startsWith("0x") || key.startsWith("0X") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("EVM_PRIVATE_KEY must be 64 hex characters (with or without 0x).");
  }
  return "0x" + hex.toLowerCase();
}

function wipeFile(file) {
  try {
    const len = fs.statSync(file).size;
    if (len > 0) {
      fs.writeFileSync(file, crypto.randomBytes(len));
    }
    fs.writeFileSync(file, "EVM_PRIVATE_KEY=\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {}
}

export async function importFromEnvFile(envFile, { expectedAddress = null, label = "user-wallet", force = false } = {}) {
  ensureConfigDir();
  const privateKey = readPrivateKeyFromEnvFile(envFile);
  const wallet = new ethers.Wallet(privateKey);
  const address = wallet.address;

  if (expectedAddress && address.toLowerCase() !== String(expectedAddress).toLowerCase()) {
    // Abort without touching the current wallet or the env file.
    throw new Error(
      `Address mismatch: key in env file is for ${address}, expected ${expectedAddress}. Nothing was changed.`
    );
  }

  let backupDir = null;
  if (walletExists()) {
    if (!force) {
      throw new Error(
        "A wallet already exists in this programme. Re-run with --force to back it up and replace it with the imported wallet."
      );
    }
    const oldMeta = fs.existsSync(FILES.meta) ? JSON.parse(fs.readFileSync(FILES.meta, "utf8")) : null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupDir = `${CONFIG_DIR}/backup-${oldMeta?.address || "unknown"}-${stamp}`;
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    for (const f of [FILES.keystore, FILES.password, FILES.mnemonic, FILES.meta]) {
      if (fs.existsSync(f)) fs.copyFileSync(f, `${backupDir}/${f.split("/").pop()}`);
    }
  }

  const password = crypto.randomBytes(32).toString("hex");
  const keystore = await wallet.encrypt(password);
  writeSecretFile(FILES.password, password);
  writeSecretFile(FILES.keystore, keystore);
  // An imported private-key wallet has no recovery phrase in this programme.
  if (fs.existsSync(FILES.mnemonic)) fs.rmSync(FILES.mnemonic);
  const meta = {
    address,
    label,
    category: "user-owned",
    createdAt: new Date().toISOString(),
    importedFrom: "private-key-env",
    note: "User-owned wallet imported via env file so the evm-wallet programme can sign and transact as this address. Key stored only as an encrypted keystore; the env file was wiped after import.",
  };
  writeSecretFile(FILES.meta, JSON.stringify(meta, null, 2));

  // Verify the stored keystore reloads to the same address before wiping.
  const reloaded = await loadWallet();
  if (reloaded.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error("Post-import verification failed: reloaded address differs. Env file was NOT wiped.");
  }
  wipeFile(envFile);
  return { address, imported: true, backupDir, envFileWiped: true };
}

export function getProvider(chainNameOrId) {
  const chain = resolveChain(chainNameOrId);
  const rpc = process.env[`EVM_RPC_${chain.chainId}`] || chain.rpc;
  return { chain, provider: new ethers.JsonRpcProvider(rpc, chain.chainId) };
}
