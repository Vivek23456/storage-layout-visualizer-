#!/usr/bin/env node
/**
 * storage-layout-visualizer
 *
 * Usage:
 *  RPC_URL=<rpc> node dist/index.js --address 0x... --layout ./examples/StubLayout.json --slots 10
 *
 * Expects storage-layout.json with an array of variables and their slot/offset info.
 * Format assumptions:
 *  storageLayout = {
 *    storage: [
 *      { astId, contract, label, type, slot, offset, bytes }
 *    ],
 *    types: {
 *      "<tRef>": { encoding, label, numberOfBytes, members? }
 *    }
 *  }
 *
 * This format is what `forge inspect <Contract> storage-layout` or solc/hardhat artifact produces.
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import dotenv from "dotenv";
dotenv.config();

type StorageEntry = {
  astId?: number;
  contract?: string;
  label: string;
  type: string; // type reference or type label
  slot: string; // hex or decimal (we'll parse)
  offset?: number; // bit offset in bytes
  bytes?: number; // size in bytes
};

type TypeEntry = {
  encoding?: string; // "inplace", "mapping", ...
  label?: string; // e.g. t_uint256
  numberOfBytes?: number;
  members?: Array<{ label: string; type: string; storageLocation?: string; offset?: number; slot?: string }>;
  key?: string;
  value?: string;
  base?: string;
  length?: number; // for static arrays
};

type StorageLayout = {
  storage: StorageEntry[];
  types?: Record<string, TypeEntry>;
};

function parseSlot(raw: string | number): bigint {
  if (typeof raw === "number") return BigInt(raw);
  if (raw.startsWith("0x")) return BigInt(raw);
  return BigInt(raw);
}

async function readSlot(provider: ethers.Provider, address: string, slot: bigint) {
  const hex = ethers.hexZeroPad(ethers.hexlify(slot), 32);
  // ethers v6 provider.getStorageAt expects slot as 32 byte hex string
  const val = await provider.getStorageAt(address, hex);
  return val; // 0x...
}

function hexToBigInt(h: string) {
  return BigInt(h);
}

function decodeElementary(typeLabel: string, rawHex: string) {
  // rawHex is 0x... length 32 bytes
  // We support uint, int, bool, address, bytesN (N<=32)
  const label = typeLabel.toLowerCase();
  const raw = rawHex.startsWith("0x") ? rawHex.slice(2) : rawHex;
  if (label.startsWith("t_address")) {
    // right-most 20 bytes = last 40 hex chars
    const addrHex = raw.slice(24 * 2); // 20 bytes -> 40 hex chars
    return ethers.getAddress("0x" + addrHex);
  }
  if (label.startsWith("t_uint")) {
    // unsigned big-endian integer
    return BigInt("0x" + raw).toString();
  }
  if (label.startsWith("t_int")) {
    // two's complement for signed - best-effort: treat as unsigned
    return BigInt("0x" + raw).toString();
  }
  if (label === "t_bool") {
    const bn = BigInt("0x" + raw);
    return bn === BigInt(1) ? "true" : "false";
  }
  if (label.startsWith("t_bytes")) {
    // t_bytesN where N <=32
    const m = label.match(/^t_bytes(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      // take left-most n bytes or right-most? For bytesN, value is left-aligned in slot
      // Solidity packs bytesN in lower-order bytes (right-aligned) for storage? We'll attempt right-most
      const bytesHex = raw.slice(64 - n * 2);
      return "0x" + bytesHex;
    }
  }
  // fallback
  return rawHex;
}

function prettySlotIndex(b: bigint) {
  return "0x" + b.toString(16);
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("address", { type: "string", demandOption: true, describe: "Contract address to inspect" })
    .option("layout", { type: "string", demandOption: true, describe: "Path to storage-layout.json" })
    .option("rpc", { type: "string", describe: "RPC URL (or set RPC_URL env var)" })
    .option("slots", { type: "number", default: 1, describe: "Extra slots to dump after each variable for context" })
    .argv as any;

  const rpc = argv.rpc || process.env.RPC_URL;
  if (!rpc) {
    console.error("RPC URL missing. Provide --rpc or set RPC_URL in environment.");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpc);

  const address = ethers.getAddress(argv.address);
  const layoutPath = path.resolve(process.cwd(), argv.layout);
  if (!fs.existsSync(layoutPath)) {
    console.error("Layout file not found:", layoutPath);
    process.exit(1);
  }
  const layoutRaw = JSON.parse(fs.readFileSync(layoutPath, "utf8")) as StorageLayout;
  const storage = layoutRaw.storage || [];
  const types = layoutRaw.types || {};

  console.log(`Inspecting contract ${address}`);
  console.log(`Using RPC: ${rpc}`);
  console.log("");

  // Build table rows
  const results: Array<any> = [];

  for (const entry of storage) {
    // parse slot
    const slotNum = parseSlot(entry.slot);
    // Offsets in some formats are bit offsets; many use 'offset' bytes
    const offset = entry.offset ?? 0;
    const bytes = entry.bytes ?? 32;

    // read the primary slot and optional subsequent slots
    const rawSlots: string[] = [];
    for (let i = 0; i < Math.max(1, argv.slots); i++) {
      const s = await readSlot(provider, address, slotNum + BigInt(i));
      rawSlots.push(s);
    }

    const typeRef = entry.type;
    const typeInfo = types && (types as any)[typeRef];

    // decode based on typeInfo.encoding or entry.type label
    let decoded = "";
    if (typeInfo) {
      if (typeInfo.encoding === "inplace") {
        // if numberOfBytes <= 32 and members missing, decode as elementary
        if (!typeInfo.members || typeInfo.members.length === 0) {
          decoded = decodeElementary(typeInfo.label || entry.type, rawSlots[0]);
        } else {
          // struct or packed members
          // try to decode members that fit inside the slot (best effort)
          const memberVals: Record<string, any> = {};
          let cursorOffsetBytes = 0;
          // naive approach: iterate members and read whole slot for each member if they occupy full slot
          for (const m of typeInfo.members) {
            const mTypeRef = m.type;
            const mType = (types as any)[mTypeRef];
            if (!mType) {
              memberVals[m.label] = { note: "unknown type", raw: rawSlots[0] };
              continue;
            }
            // if member is elementary and numberOfBytes <=32, attempt decode from main slot or subsequent slots
            if (mType.numberOfBytes && mType.numberOfBytes <= 32) {
              const val = decodeElementary(mType.label || mTypeRef, rawSlots[0]);
              memberVals[m.label] = val;
            } else {
              memberVals[m.label] = { note: "complex type - raw", raw: rawSlots[0] };
            }
          }
          decoded = JSON.stringify(memberVals);
        }
      } else if (typeInfo.encoding === "mapping") {
        decoded = `<mapping or dynamic - keys at keccak(slot + key). raw slot(${prettySlotIndex(slotNum)}) = ${rawSlots[0]}>`;
      } else if (typeInfo.encoding === "dynamic_array") {
        decoded = `<dynamic array - length in slot(${prettySlotIndex(slotNum)}) = ${rawSlots[0]}>`;
      } else {
        decoded = `<unsupported encoding ${typeInfo.encoding} - raw ${rawSlots[0]}>`;
      }
    } else {
      // fallback: try elementary by entry.type label
      decoded = decodeElementary(entry.type || "", rawSlots[0]);
    }

    results.push({
      label: entry.label,
      slot: prettySlotIndex(slotNum),
      offset,
      bytes,
      rawSlots,
      decoded,
      type: typeInfo?.label || entry.type,
    });
  }

  // Print nice table
  console.log("Variable mapping:");
  for (const r of results) {
    console.log("-------------------------------------------------------------");
    console.log(`name: ${r.label}`);
    console.log(`type: ${r.type}`);
    console.log(`slot: ${r.slot} (offset bytes: ${r.offset}, size: ${r.bytes})`);
    console.log(`raw slot[0]: ${r.rawSlots[0]}`);
    if (r.rawSlots.length > 1) {
      for (let i = 1; i < r.rawSlots.length; i++) {
        console.log(`raw slot[+${i}]: ${r.rawSlots[i]}`);
      }
    }
    console.log(`decoded: ${r.decoded}`);
  }
  console.log("-------------------------------------------------------------");
  console.log("");
  console.log("Notes:");
  console.log("- Dynamic arrays, mappings and strings are printed as raw slots; their real location is keccak(slot).");
  console.log("- Complex nested structs / packed smaller-than-32-byte fields are best-effort decoded.");
  console.log("- For highest accuracy, pass the exact storage layout generated by `forge inspect <Contract> storage-layout` or Hardhat artifact.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
