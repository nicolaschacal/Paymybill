import "./polyfill";
import React from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { App } from "./App";
import { RPC_URL } from "./chain";
import "./styles.css";

// Wallet Standard wallets (Phantom, Solflare, Backpack, …) are auto-detected,
// so no per-wallet adapter packages are needed.
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={[]} autoConnect>
        <App />
      </WalletProvider>
    </ConnectionProvider>
  </React.StrictMode>,
);
