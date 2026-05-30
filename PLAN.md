Act as a Principal Web3 Infrastructure Engineer. I need to build the foundation of a dynamic, headless sandbox for smart contract reverse-engineering and honeypot detection.

The sandbox is built in Node.js (TypeScript) for high-speed local blockchain forking, EVM state diffing, and transaction execution.

Please build the complete boilerplate structure and the core integration scripts for this sandbox. Implement the following components:

### 1. Node.js/TypeScript Core Service
- Use 'viem' and 'foundry-anvil' (or spawn an 'anvil' child process via Node) to programmatically spin up an instantaneous, isolated local mainnet fork when a target contract address is provided.
- Create an execution script that:
  a. Funds a mock retail testing wallet with local ETH.
  b. Pre-approves the target token contract.
  c. Records a snapshot of the exact EVM state/storage slots and wallet balances before an interaction.
  d. Executes a real buy → sell round-trip as the mock wallet.
  e. Performs a strict "State Diff" after execution (comparing expected token balances vs actual token balances received in the wallet to detect hidden sell taxes or honeypots).

### 2. Inter-Process Orchestration
- Create a simple HTTP/IPC layer that exposes the pipeline:
  [Start Anvil Fork] -> [Node State Snapshot] -> [Execute buy→sell round-trip] -> [Node Captures Transaction & Diffs State] -> [Output Clean JSON Report of Balance Changes].

Please ensure the code is modular, type-safe, handles errors cleanly (e.g., if a transaction reverts on the fork), and contains detailed inline comments explaining how the state diffing catches malicious smart contract anomalies. Write production-ready scripts.
