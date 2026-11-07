#!/usr/bin/env node
import fs from "node:fs";
import { ethers } from "ethers";
import { CHAINS, FILES, audit } from "../src/config.mjs";
import { createWallet, loadWallet, readMeta, walletExists, getProvider, importFromEnvFile } from "../src/wallet.mjs";
import {
  getProjectId,
  setProjectId,
  initClient,
  approveProposal,
  respondApprove,
  respondReject,
} from "../src/wc.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}
function hasFlag(name) {
  return rest.includes(`--${name}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function out(obj) {
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

const HELP = `evm-wallet — local EVM wallet (independent from Binance Agentic Wallet)

Wallet:
  init [--label hunt]                 Create the dedicated wallet (once). Prints address only.
  import-env --file <env> [--expected-address 0x..] [--force]
                                      Import a user-owned wallet from EVM_PRIVATE_KEY in an env
                                      file the user filled in. Prints address only; backs up any
                                      existing wallet first (--force), then WIPES the env file.
  address                             Show the wallet address.
  info                                Show metadata + capabilities.
  balance [chain]                     Native balance (default: bsc). Chains: ${Object.keys(CHAINS).join(", ")}
  sign-message <message...>           personal_sign (EIP-191). Use --message-hex 0x.. for hex data.
  verify-message <sig> <message...>   Recover signer of a signature.
  sign-typed --file typed.json        EIP-712 sign. File: {domain, types, value}
  tx-preview --chain bsc --to 0x.. --value 0.0 [--data 0x]
                                      Show cost estimate. Never sends.
  tx-send --chain bsc --to 0x.. --value 0.0 [--data 0x] --confirm SEND
                                      Broadcast a transaction (guarded by --confirm SEND).

WalletConnect v2 (for sites whose connect dialog offers WalletConnect):
  wc-set-project-id <projectId>       Store the public WalletConnect projectId.
  wc-status                           ProjectId set? Active sessions?
  wc-pair --uri "wc:..." [--approve]  Pair with a dapp URI; prints the session proposal.
  wc-approve <proposalId>             Approve a stored proposal.
  wc-sessions                         List active sessions.
  wc-serve [--seconds 60]             Stay online; prints incoming session requests as JSON lines.
  wc-pending                          List pending session requests.
  wc-respond --id N --topic T --approve [--allow-tx] | --reject
                                      Answer a pending request (sign / send / reject).

Secrets live in ${FILES.keystore.replace(/keystore\.json$/, "")} with 600 permissions and are never printed.`;

async function main() {
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      out(HELP);
      return;

    case "init": {
      const label = flag("label") || "hunt";
      const { address, created } = await createWallet(label);
      audit("init", { address, created });
      out({
        address,
        created,
        keystore: FILES.keystore,
        recoveryPhraseFile: FILES.mnemonic,
        note: "Recovery phrase and keystore password are stored in 600-permission files and were NOT printed.",
      });
      return;
    }

    case "import-env": {
      const file = flag("file");
      if (!file) throw new Error("Provide --file <env file containing EVM_PRIVATE_KEY>");
      const result = await importFromEnvFile(file, {
        expectedAddress: flag("expected-address") || null,
        label: flag("label") || "user-wallet",
        force: hasFlag("force"),
      });
      audit("import-env", { address: result.address, backupDir: result.backupDir });
      out({
        ...result,
        note: "Private key was NOT printed. It now lives only in the encrypted keystore; the env file has been wiped.",
      });
      return;
    }

    case "address": {
      const meta = readMeta();
      if (!meta) throw new Error("Wallet not initialised. Run: evm-wallet init");
      out(meta.address);
      return;
    }

    case "info": {
      const meta = readMeta();
      out({
        meta,
        walletInitialised: walletExists(),
        walletConnectProjectIdSet: Boolean(getProjectId()),
        capabilities: [
          "personal_sign (EIP-191) — works for SIWE sign-in flows that Binance Agentic Wallet cannot sign",
          "EIP-712 typed-data signing",
          "Direct contract calls / transactions on EVM chains",
          "WalletConnect v2 wallet (pair via wc: URI) once a projectId is set",
        ],
      });
      return;
    }

    case "balance": {
      const wallet = await loadWallet();
      const { chain, provider } = getProvider(rest[0] || "bsc");
      const bal = await provider.getBalance(wallet.address);
      out({ address: wallet.address, chainId: chain.chainId, symbol: chain.symbol, balance: ethers.formatEther(bal) });
      return;
    }

    case "sign-message": {
      const wallet = await loadWallet();
      const hex = flag("message-hex");
      const message = hex ? ethers.getBytes(hex) : rest.filter((a) => !a.startsWith("--")).join(" ");
      if (!message && !hex) throw new Error("Provide a message or --message-hex 0x..");
      const signature = await wallet.signMessage(message);
      audit("sign-message", { address: wallet.address });
      out({ address: wallet.address, signature });
      return;
    }

    case "verify-message": {
      const signature = rest[0];
      const message = rest.slice(1).join(" ");
      const recovered = ethers.verifyMessage(message, signature);
      out({ recovered });
      return;
    }

    case "sign-typed": {
      const file = flag("file");
      if (!file) throw new Error("Provide --file typed.json");
      const obj = JSON.parse(fs.readFileSync(file, "utf8"));
      const types = { ...(obj.types || {}) };
      delete types.EIP712Domain;
      const value = obj.value || obj.message;
      const wallet = await loadWallet();
      const signature = await wallet.signTypedData(obj.domain, types, value);
      audit("sign-typed", { address: wallet.address, primaryType: obj.types ? Object.keys(obj.types)[0] : null });
      out({ address: wallet.address, signature });
      return;
    }

    case "tx-preview": {
      const wallet = await loadWallet();
      const { chain, provider } = getProvider(flag("chain") || "bsc");
      const to = flag("to");
      if (!to) throw new Error("Provide --to 0x..");
      const value = ethers.parseEther(flag("value") || "0");
      const data = flag("data") || "0x";
      const [balance, feeData, nonce] = await Promise.all([
        provider.getBalance(wallet.address),
        provider.getFeeData(),
        provider.getTransactionCount(wallet.address),
      ]);
      let gas = null;
      let gasError = null;
      try {
        gas = await provider.estimateGas({ from: wallet.address, to, value, data });
      } catch (e) {
        gasError = e.shortMessage || e.message;
      }
      const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 0n;
      out({
        from: wallet.address,
        to,
        chainId: chain.chainId,
        valueWei: value.toString(),
        value: ethers.formatEther(value),
        data,
        nonce,
        balance: ethers.formatEther(balance),
        estimatedGas: gas ? gas.toString() : null,
        gasError,
        estimatedCostWei: gas ? (gas * gasPrice).toString() : null,
        estimatedCost: gas ? ethers.formatEther(gas * gasPrice) : null,
        symbol: chain.symbol,
      });
      return;
    }

    case "tx-send": {
      if (flag("confirm") !== "SEND") {
        throw new Error("Refusing to broadcast. Re-run with --confirm SEND after reviewing tx-preview.");
      }
      const wallet = await loadWallet();
      const { chain, provider } = getProvider(flag("chain") || "bsc");
      const to = flag("to");
      if (!to) throw new Error("Provide --to 0x..");
      const value = ethers.parseEther(flag("value") || "0");
      const data = flag("data") || "0x";
      const connected = wallet.connect(provider);
      const sent = await connected.sendTransaction({ to, value, data });
      audit("tx-send", { address: wallet.address, chainId: chain.chainId, to, hash: sent.hash });
      const receipt = await sent.wait(1);
      out({ hash: sent.hash, blockNumber: receipt.blockNumber, status: receipt.status, chainId: chain.chainId });
      return;
    }

    case "wc-set-project-id": {
      const id = rest[0];
      if (!id) throw new Error("Provide the WalletConnect projectId.");
      setProjectId(id);
      out({ projectIdSet: true });
      return;
    }

    case "wc-status": {
      const projectIdSet = Boolean(getProjectId());
      if (!projectIdSet) {
        out({ projectIdSet, sessions: 0, note: "Set a projectId first: evm-wallet wc-set-project-id <projectId>" });
        return;
      }
      const client = await initClient();
      const sessions = client.session.getAll();
      out({
        projectIdSet,
        sessions: sessions.length,
        peers: sessions.map((s) => ({ topic: s.topic, name: s.peer?.metadata?.name, url: s.peer?.metadata?.url })),
      });
      return;
    }

    case "wc-pair": {
      const uri = flag("uri");
      if (!uri) throw new Error('Provide --uri "wc:..."');
      const wallet = await loadWallet();
      const client = await initClient();
      const proposalPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for session_proposal (90s).")), 90000);
        client.on("session_proposal", (proposal) => {
          clearTimeout(timer);
          resolve(proposal);
        });
      });
      await client.pair({ uri });
      const proposal = await proposalPromise;
      const peer = proposal.params.proposer?.metadata;
      if (hasFlag("approve")) {
        const topic = await approveProposal(client, proposal, wallet.address);
        audit("wc-approve", { address: wallet.address, topic });
        out({ approved: true, topic, peer });
      } else {
        out({
          approved: false,
          proposalId: proposal.id,
          peer,
          requiredNamespaces: proposal.params.requiredNamespaces,
          optionalNamespaces: proposal.params.optionalNamespaces,
          next: `Review, then run: evm-wallet wc-approve ${proposal.id}`,
        });
      }
      return;
    }

    case "wc-approve": {
      const id = Number(rest[0]);
      if (!id) throw new Error("Provide the proposalId.");
      const wallet = await loadWallet();
      const client = await initClient();
      const proposal = client.proposal.get(id);
      if (!proposal) throw new Error(`Proposal ${id} not found (expired or different storage).`);
      const topic = await approveProposal(client, proposal, wallet.address);
      audit("wc-approve", { address: wallet.address, topic });
      out({ approved: true, topic });
      return;
    }

    case "wc-sessions": {
      const client = await initClient();
      const sessions = client.session.getAll();
      out(sessions.map((s) => ({ topic: s.topic, peer: s.peer?.metadata, namespaces: s.namespaces, expiry: s.expiry })));
      return;
    }

    case "wc-serve": {
      const seconds = Number(flag("seconds") || 60);
      const wallet = await loadWallet();
      const client = await initClient();
      out({ serving: true, address: wallet.address, seconds, sessions: client.session.getAll().length });
      client.on("session_proposal", (proposal) => {
        out({ type: "session_proposal", id: proposal.id, peer: proposal.params.proposer?.metadata });
      });
      client.on("session_request", (event) => {
        out({
          type: "session_request",
          id: event.id,
          topic: event.topic,
          chainId: event.params?.chainId,
          method: event.params?.request?.method,
          params: event.params?.request?.params,
          origin: event.verifyContext?.verified?.origin,
        });
      });
      await sleep(seconds * 1000);
      out({ serving: false });
      return;
    }

    case "wc-pending": {
      const client = await initClient();
      const pending = client.getPendingSessionRequests();
      out(
        pending.map((p) => ({
          id: p.id,
          topic: p.topic,
          chainId: p.params?.chainId,
          method: p.params?.request?.method,
          params: p.params?.request?.params,
        }))
      );
      return;
    }

    case "wc-respond": {
      const id = Number(flag("id"));
      const topic = flag("topic");
      if (!id || !topic) throw new Error("Provide --id and --topic.");
      const wallet = await loadWallet();
      const client = await initClient();
      const pending = client.getPendingSessionRequests().find((p) => p.id === id && p.topic === topic);
      if (!pending) throw new Error("Pending request not found (it may have expired, or wc-serve must be running).");
      if (hasFlag("reject")) {
        await respondReject(client, pending);
        audit("wc-reject", { address: wallet.address, id });
        out({ rejected: true, id });
        return;
      }
      if (!hasFlag("approve")) throw new Error("Specify --approve or --reject.");
      const result = await respondApprove(client, wallet, pending, { allowTx: hasFlag("allow-tx") });
      audit("wc-approve-request", { address: wallet.address, id, method: pending.params?.request?.method });
      out({ approved: true, id, result });
      return;
    }

    default:
      throw new Error(`Unknown command "${cmd}". Run: evm-wallet help`);
  }
}

main().catch((e) => {
  console.error("ERROR:", e.shortMessage || e.message);
  process.exit(1);
});
