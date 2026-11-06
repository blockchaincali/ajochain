// Placeholder until `npm run deploy:mezo` writes the real AjoManager/AjoBadge
// addresses here. MUSD, MEZO and StabilityPool are Mezo's own testnet contracts.
export const CONFIG = {
  "chainId": 31611,
  "chainName": "Mezo Testnet",
  "rpcUrl": "https://rpc.test.mezo.org",
  "nativeSymbol": "BTC",
  "explorer": "https://explorer.test.mezo.org",
  "gasFaucet": "https://faucet.test.mezo.org",
  "musdHelp": "https://testnet.mezo.org",
  "tokens": [
    { "symbol": "MUSD", "address": "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503", "yield": true },
    { "symbol": "MEZO", "address": "0x7b7c000000000000000000000000000000000001", "yield": false }
  ],
  "contracts": {
    "AjoManager": "",
    "AjoBadge": "",
    "StabilityPool": "0x1CCA7E410eE41739792eA0A24e00349Dd247680e"
  }
};
