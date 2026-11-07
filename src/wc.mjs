import fs from "node:fs";
import { ethers } from "ethers";
import { SignClient } from "@walletconnect/sign-client";
import { getSdkError } from "@walletconnect/utils";
import { FILES, SUPPORTED_WC_CHAIN_IDS, writeSecretFile, resolveChain } from "./config.mjs";
import { getProvider } from "./wallet.mjs";

export const DEFAULT_METHODS = [
  "eth_sendTransaction",
  "eth_signTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
];
export const DEFAULT_EVENTS = ["accountsChanged", "chainChanged"];

export function getProjectId() {
  if (process.env.WALLETCONNECT_PROJECT_ID) return process.env.WALLETCONNECT_PROJECT_ID.trim();
  if (fs.existsSync(FILES.wcConfig)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(FILES.wcConfig, "utf8"));
      if (cfg.projectId) return String(cfg.projectId).trim();
    } catch {}
  }
  return null;
}

export function setProjectId(projectId) {
  // A WalletConnect projectId is a public identifier, not a secret key.
  writeSecretFile(FILES.wcConfig, JSON.stringify({ projectId }, null, 2));
}

export async function initClient() {
  const projectId = getProjectId();
  if (!projectId) {
    throw new Error(
      "WalletConnect projectId not set. Get a free one at https://cloud.walletconnect.com, then run: evm-wallet wc-set-project-id <projectId>"
    );
  }
  let storage;
  try {
    const { KeyValueStorage } = await import("@walletconnect/keyvaluestorage");
    storage = new KeyValueStorage({ database: FILES.wcStorage });
  } catch {
    storage = undefined;
  }
  const client = await SignClient.init({
    projectId,
    metadata: {
      name: "simek EVM Wallet",
      description: "Local EVM wallet operated by simek for wallet-connect events and sign-in flows.",
      url: "https://localhost",
      icons: [],
    },
    ...(storage ? { storage } : {}),
  });
  return client;
}

function requestedChainIds(namespaces) {
  const ids = new Set();
  for (const ns of Object.values(namespaces || {})) {
    for (const chain of ns.chains || []) {
      const m = /^eip155:(\d+)$/.exec(chain);
      if (m) ids.add(Number(m[1]));
    }
  }
  return [...ids];
}

export function buildNamespaces(proposalParams, address) {
  const req = proposalParams.requiredNamespaces || {};
  const opt = proposalParams.optionalNamespaces || {};
  let chains = [...new Set([...requestedChainIds(req), ...requestedChainIds(opt)])].filter((id) =>
    SUPPORTED_WC_CHAIN_IDS.includes(id)
  );
  if (chains.length === 0) chains = [56, 1];
  const methods = new Set(DEFAULT_METHODS);
  for (const ns of [...Object.values(req), ...Object.values(opt)]) {
    for (const m of ns.methods || []) methods.add(m);
  }
  const events = new Set(DEFAULT_EVENTS);
  for (const ns of [...Object.values(req), ...Object.values(opt)]) {
    for (const e of ns.events || []) events.add(e);
  }
  return {
    eip155: {
      chains: chains.map((id) => `eip155:${id}`),
      accounts: chains.map((id) => `eip155:${id}:${address}`),
      methods: [...methods],
      events: [...events],
    },
  };
}

export async function approveProposal(client, proposal, address) {
  const namespaces = buildNamespaces(proposal.params, address);
  const { topic } = await client.approve({ id: proposal.id, namespaces });
  return topic;
}

function asBytes(data) {
  if (typeof data === "string" && data.startsWith("0x")) return ethers.getBytes(data);
  return data;
}

function parseTypedData(payload) {
  const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
  const domain = obj.domain;
  const types = { ...(obj.types || {}) };
  delete types.EIP712Domain;
  const value = obj.value || obj.message;
  return { domain, types, value };
}

// Handles one WalletConnect session request with the local wallet.
// Returns the JSON-RPC result. Throws on unsupported methods.
export async function handleRequest(wallet, request, { allowTx = false } = {}) {
  const { method, params } = request.params.request;
  const chainId = Number(String(request.params.chainId || "eip155:56").split(":")[1]);

  switch (method) {
    case "personal_sign": {
      // WalletConnect order: [message, address]
      const data = params[0];
      return await wallet.signMessage(asBytes(data));
    }
    case "eth_sign": {
      // WalletConnect order: [address, message]
      const data = params[1];
      return await wallet.signMessage(asBytes(data));
    }
    case "eth_signTypedData":
    case "eth_signTypedData_v3":
    case "eth_signTypedData_v4": {
      const { domain, types, value } = parseTypedData(params[1]);
      return await wallet.signTypedData(domain, types, value);
    }
    case "eth_signTransaction": {
      const tx = params[0];
      return await wallet.signTransaction({
        to: tx.to,
        value: tx.value ? BigInt(tx.value) : 0n,
        data: tx.data || "0x",
        chainId,
        gasLimit: tx.gas ? BigInt(tx.gas) : undefined,
      });
    }
    case "eth_sendTransaction": {
      if (!allowTx) {
        throw new Error("eth_sendTransaction blocked: re-run with --allow-tx after explicit approval.");
      }
      const tx = params[0];
      const { provider } = getProvider(chainId);
      const connected = wallet.connect(provider);
      const sent = await connected.sendTransaction({
        to: tx.to,
        value: tx.value ? BigInt(tx.value) : 0n,
        data: tx.data || "0x",
        gasLimit: tx.gas ? BigInt(tx.gas) : undefined,
      });
      return sent.hash;
    }
    default:
      throw new Error(`Unsupported method: ${method}`);
  }
}

export async function respondApprove(client, wallet, pending, opts = {}) {
  const result = await handleRequest(wallet, pending, opts);
  await client.respond({
    topic: pending.topic,
    response: { id: pending.id, jsonrpc: "2.0", result },
  });
  return result;
}

export async function respondReject(client, pending) {
  await client.respond({
    topic: pending.topic,
    response: { id: pending.id, jsonrpc: "2.0", error: getSdkError("USER_REJECTED") },
  });
}
