// Dev-only test page for the assembly browser: /src/assembly/harness.html.
import { createAssemblyBrowser } from './index';

declare global {
  interface Window {
    __asm?: ReturnType<typeof createAssemblyBrowser>;
    __createAsm?: typeof createAssemblyBrowser;
  }
}

// The page lives in /src/assembly/, the bundle at the site root (public/decompiler/).
window.__asm = createAssemblyBrowser({ decompilerBase: new URL('/decompiler/', location.href).href });
window.__createAsm = createAssemblyBrowser;
