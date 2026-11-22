# mp-reader

A local-first EPUB and PDF reader for Windows and Android browsers. User interface is in Hebrew (RTL).

## Current status

**Prototype v0.1 — not yet verified in a browser.** This is a Vite web app, not an installed Windows EXE or Android APK.

- Import local EPUB/PDF files and keep copies in browser IndexedDB
- EPUB page navigation, font-size adjustment, light/dark reading themes and table of contents
- PDF canvas rendering, zoom and page navigation
- Save progress in the same device's browser

No cloud account or server-side uploads. Original file backups are important because browsers may clear site data. DRM-protected books are not supported.

## Start on Windows

Install Node.js 22+ and Git, then use PowerShell:

```powershell
git clone https://github.com/maorprl/mp-reader.git C:\Projects\mp-reader
cd C:\Projects\mp-reader
npm install
npm run dev
```

Open http://localhost:5173

If C:\Projects\mp-reader already exists and is empty, run `git clone https://github.com/maorprl/mp-reader.git .` **from inside that folder** instead.

## Android browser on the same Wi-Fi

Start the Vite development server on the PC, identify the PC's LAN IP address, then open `http://<PC-IP>:5173` in Android Chrome on the same Wi-Fi. You may need a Windows firewall rule. Storage does not sync between devices.

## Build

```powershell
npm run build
```

To distribute independent Windows/Android apps, packaging with Tauri or Capacitor is a later phase.

## Known limitations

- Browser prototype, no EXE/APK, no sync, highlighting or full-text search
- EPUB navigation direction relies on document metadata; Hebrew books may require additional RTL testing
- PDF currently has no selectable text layer
- Not tested against real EPUB and PDF files yet
