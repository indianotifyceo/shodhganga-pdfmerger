const {
  app,
  screen,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  dialog,
} = require("electron");

const { startDownload, stopDownload } = require("./downloader");

const path = require("path");

let mainWindow;

// =====================================================
// CREATE WINDOW
// =====================================================
function createWindow() {
  const display = screen.getPrimaryDisplay();

  const { width, height } = display.workAreaSize;

  // =========================
  // SMART SIZE
  // =========================

  let winWidth;
  let winHeight;

  // Small laptops
  if (width <= 1366) {
    winWidth = Math.round(width * 0.92);
    winHeight = Math.round(height * 0.9);
  }

  // 13"+ laptops
  else if (width <= 1920) {
    winWidth = Math.round(width * 0.72);
    winHeight = Math.round(height * 0.78);
  }

  // Large monitors
  else {
    winWidth = Math.round(width * 0.6);
    winHeight = Math.round(height * 0.72);
  }

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,

    minWidth: 900,
    minHeight: 600,

    icon: path.join(__dirname, "assets/icon.png"),

    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.center();

  mainWindow.loadFile("index.html");

  // =====================================================
  // RIGHT CLICK CONTEXT MENU
  // =====================================================
  mainWindow.webContents.on("context-menu", (event, params) => {
    const menu = Menu.buildFromTemplate([
      {
        role: "undo",
      },

      {
        role: "redo",
      },

      {
        type: "separator",
      },

      {
        role: "cut",
        enabled: params.editFlags.canCut,
      },

      {
        role: "copy",
        enabled: params.editFlags.canCopy,
      },

      {
        role: "paste",
        enabled: params.editFlags.canPaste,
      },

      {
        role: "selectAll",
      },
    ]);

    menu.popup();
  });

  // =====================================================
  // EXTEND DEFAULT MENU
  // =====================================================

  const menu = Menu.getApplicationMenu();

  const template = menu
    ? menu.items.map((item) => ({
        label: item.label,

        submenu: item.submenu
          ? item.submenu.items.map((sub) => ({
              label: sub.label,
              role: sub.role,
              accelerator: sub.accelerator,
              click: sub.click,
            }))
          : [],
      }))
    : [];

  // =====================================================
  // ABOUT MENU
  // =====================================================

  template.push({
    label: "About Us",

    submenu: [
      {
        label: "Version",

        click: () => {
          dialog.showMessageBox(mainWindow, {
            type: "info",

            title: "Version",

            message: "PDF Merger",

            detail:
              "Version: 1.0.0\n\n" +
              "Developer: www.indianotify.com\n" +
              "Single PDF Maker\n" +
              "Citation Generator",
          });
        },
      },

      {
        label: "GitHub Repository",

        click: () => {
          shell.openExternal(
            "https://github.com/indianotifyceo/shodhganga-pdfmerger",
          );
        },
      },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// =====================================================
// APP READY
// =====================================================
app.whenReady().then(createWindow);

// =====================================================
// IPC: START DOWNLOAD
// =====================================================
ipcMain.handle("start-download", async (event, url) => {
  return await startDownload(url, (data) => {
    event.sender.send("download-progress", data);
  });
});

// =====================================================
// IPC: STOP DOWNLOAD
// =====================================================
ipcMain.handle("stop-download", async () => {
  stopDownload();

  return true;
});

// =====================================================
// MAC
// =====================================================
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// =====================================================
// CLOSE
// =====================================================
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
