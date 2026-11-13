/* Triton desktop shell. A thin Electron window around the live site, so the
   Windows app updates whenever the site is deployed — same as the phones. */
const { app, BrowserWindow, shell, Menu } = require("electron");

const SITE = process.env.TRITON_SITE || "https://mis2ibaadatenterprises.github.io/triton-bookings/";

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: "#f4f6f5",
    title: "Triton",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  win.loadURL(SITE);

  /* Links to other sites open in the real browser, not inside the app. */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(SITE)) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });

  /* If the lift lobby wifi drops, show something instead of a blank window. */
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    if (code === -3) return;
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      '<body style="font:15px system-ui;padding:40px;background:#f4f6f5;color:#15211f">' +
      "<h2 style='margin:0 0 8px'>Triton could not reach the server</h2>" +
      "<p style='color:#5b6866'>" + desc + ". Check the internet connection and reopen the app.</p></body>"
    ));
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Triton", submenu: [
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => win.reload() },
      { type: "separator" },
      { role: "quit" }
    ] }
  ]));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
