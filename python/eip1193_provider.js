// ---------------------------------------------------------------------------
// Mock EIP-1193 provider injected into the page BEFORE any dApp script runs.
//
// It impersonates a MetaMask-style wallet extension whose selected account is
// an anvil-unlocked address connected to our local fork. Every JSON-RPC call is
// proxied straight to the Anvil endpoint; because the account is unlocked on the
// fork, `eth_sendTransaction` is signed by anvil itself — no key handling in the
// browser. Placeholders __RPC__ / __ACCOUNT__ / __CHAINID__ are substituted by
// the Python launcher at injection time.
// ---------------------------------------------------------------------------
(() => {
  const RPC = '__RPC__';
  const ACCOUNT = '__ACCOUNT__'.toLowerCase();
  const CHAIN_ID = '__CHAINID__'; // hex string, e.g. "0x1"
  let rpcId = 0;

  async function rawRpc(method, params) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: params || [] }),
    });
    const json = await res.json();
    if (json.error) {
      const err = new Error(json.error.message || 'RPC error');
      err.code = json.error.code;
      throw err;
    }
    return json.result;
  }

  const listeners = {};
  const provider = {
    isMetaMask: true,
    isConnected: () => true,
    chainId: CHAIN_ID,
    selectedAddress: ACCOUNT,

    request: async ({ method, params }) => {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [ACCOUNT];
        case 'eth_chainId':
          return CHAIN_ID;
        case 'net_version':
          return String(parseInt(CHAIN_ID, 16));
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null; // already on the fork
        default:
          return rawRpc(method, params);
      }
    },

    // Legacy shims some dApps still probe for.
    enable: async () => [ACCOUNT],
    send: (m, p) => provider.request({ method: m, params: p }),
    sendAsync: (payload, cb) => {
      provider
        .request(payload)
        .then((result) => cb(null, { id: payload.id, jsonrpc: '2.0', result }))
        .catch((error) => cb(error, null));
    },
    on: (event, handler) => {
      (listeners[event] = listeners[event] || []).push(handler);
    },
    removeListener: (event, handler) => {
      listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
    },
  };

  Object.defineProperty(window, 'ethereum', { value: provider, configurable: true });

  // EIP-6963 multi-wallet announcement, so modern dApp connect buttons find us.
  const info = {
    uuid: '00000000-0000-0000-0000-0000000000fe',
    name: 'Sandbox Wallet',
    icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    rdns: 'sandbox.honeypot.local',
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }),
    );
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  // Diagnostic marker: proves this code executed in the page's MAIN world
  // (the DOM is shared, so the automation can read it back).
  try {
    document.documentElement.setAttribute('data-bp-wallet', window.ethereum ? 'installed' : 'noeth');
  } catch (e) { /* ignore */ }
})();
