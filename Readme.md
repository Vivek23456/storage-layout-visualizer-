Storage Layout Visualizer
=========================

A small CLI tool that reads a compiled contract storage layout JSON and queries on-chain
storage to present human-readable variable values for a deployed contract.

Use-cases:
- Audit & debug storage packing issues
- Verify migrations / upgrades (compare storage across addresses)
- Educational: see how high-level variables map to storage slots

Supported decoding:
- elementary types: address, uint/int (<=256), bool, bytesN (N<=32)
- fixed-size arrays (elements of supported elementary types)
- simple structs with elementary fields (packed across slots)
- prints raw slot data for dynamic types, mappings, and unsupported/complex fields

Requirements:
- Node 18+, yarn or npm
- An RPC URL (ENV: RPC_URL)
- A `storage-layout.json` file produced by Forge/solc/Hardhat containing variable slot layout

Quickstart:
1. Clone repo
2. `yarn install`
3. `export RPC_URL=https://mainnet.infura.io/v3/<KEY>` (or use .env)
4. `node dist/index.js --address 0x... --layout examples/StubLayout.json`

See full README in repo for details and examples.

Limitations:
- Does NOT fully decode mappings or dynamic arrays (prints keccak keys)
- Complex nested structs/arrays partially supported (best-effort)
- Works best with storage layout JSON produced by `forge inspect <Contract> storage-layout` or a Hardhat artifact's `storageLayout`.

Contributions welcome.
