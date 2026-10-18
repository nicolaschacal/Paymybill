import { Buffer } from "buffer";

// @solana/web3.js expects a global Buffer in the browser.
(globalThis as any).Buffer ??= Buffer;
