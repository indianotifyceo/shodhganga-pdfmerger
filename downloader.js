const fs = require("fs");
const os = require("os");
const dns = require("dns").promises;
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const PDFMerger = require("pdf-merger-js").default;

const BASE_URL = "https://shodhganga.inflibnet.ac.in";

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

let ACTIVE_CONTROLLER = null;
let CANCELLED = false;

// =====================================================
// STOP DOWNLOAD
// =====================================================
function stopDownload() {
  CANCELLED = true;

  if (ACTIVE_CONTROLLER) {
    ACTIVE_CONTROLLER.abort();
  }
}

// =====================================================
// SANITIZE
// =====================================================
function sanitize(name) {
  return (name || "Unknown_thesis")
    .replace(/[<>:"/\\|?*]/g, "")
    .trim()
    .slice(0, 200);
}

// =====================================================
// SLEEP
// =====================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================================================
// INTERNET CHECK
// =====================================================

async function hasInternet() {
  try {
    await dns.lookup("google.com");
    return true;
  } catch {
    return false;
  }
}

// =====================================================
// FETCH PAGE
// =====================================================

async function fetchPage(url) {
  try {
    const res = await axios.get(url, {
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
      validateStatus: (s) => s >= 200 && s < 300,
    });

    return {
      ok: true,
      page: res.data,
    };
  } catch (err) {
    // =========================================
    // CHECK REAL INTERNET STATUS
    // =========================================

    const internet = await hasInternet();

    if (!internet) {
      return {
        ok: false,
        internet: false,
        message: "No internet connectivity",
        error: err.message,
      };
    }

    // =========================================
    // OTHER ERRORS
    // =========================================

    return {
      ok: false,
      internet: true,
      message: "Request failed",
      error: err.message,
    };
  }
}
// =====================================================
// EXTRACT METADATA
// =====================================================
function extractTableData($) {
  const data = {};

  $("table.itemDisplayTable tr").each((_, row) => {
    const label = $(row)
      .find("td.metadataFieldLabel")
      .text()
      .replace(/:/g, "")
      .toLowerCase()
      .trim();

    const valueCell = $(row).find("td.metadataFieldValue");

    if (!label || !valueCell.length) return;

    const links = valueCell.find("a");

    let value = "";

    if (links.length && label === "uri") {
      value = $(links[0]).attr("href") || "";
    } else if (links.length) {
      value = links
        .map((_, a) => $(a).text().trim())
        .get()
        .join(", ");
    } else {
      value = valueCell.text().trim();
    }

    data[label] = value;
  });

  return data;
}

// =====================================================
// EXTRACT PDF LINKS
// =====================================================
function extractPdfLinks($) {
  const links = new Set();

  $("a").each((_, a) => {
    const href = $(a).attr("href");

    if (
      href &&
      href.includes("/bitstream/") &&
      href.toLowerCase().endsWith(".pdf")
    ) {
      links.add(new URL(href, BASE_URL).href);
    }
  });

  return [...links];
}

// =====================================================
// CREATE FOLDER
// =====================================================
function createFolder(meta) {
  const title = meta["title"] || "Unknown_thesis";

  const folder = path.join(
    os.homedir(),
    "Downloads",
    "Shodhganga",
    sanitize(title),
  );

  if (fs.existsSync(folder)) {
    fs.rmSync(folder, {
      recursive: true,
      force: true,
    });
  }

  fs.mkdirSync(folder, {
    recursive: true,
  });

  return folder;
}

// =====================================================
// GENERATE BIB
// =====================================================
function generateBib(meta, folder, emit) {
  const title = meta["title"] || "Unknown Title";
  const author = meta["researcher"] || "Unknown Author";
  const school = meta["university"] || "Unknown University";
  const year = meta["completed date"] || "n.d.";
  const uri = meta["uri"] || "";

  const citeKey = (author + year + title)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();

  const bib = `@phdthesis{${citeKey},
    title   = {${title}},
    author  = {${author}},
    year    = {${year}},
    school  = {${school}},
    type    = {PhD thesis},
    note    = {Available at \\url{${uri}}}
  }`;

  const safeTitle = sanitize(title);

  const bibPath = path.join(folder, `${safeTitle}.bib`);

  fs.writeFileSync(bibPath, bib, "utf8");

  emit({
    type: "bib",
    filename: `${safeTitle}.bib`,
    status: "Generated ✓",
    percent: 100,
  });

  return bibPath;
}

// =====================================================
// MERGE PDFS
// =====================================================
async function mergePDFs(folderPath, outputFile) {
  const merger = new PDFMerger();

  let files = fs.readdirSync(folderPath);

  files = files.filter((f) => f.endsWith(".pdf"));

  files.sort((a, b) => parseInt(a) - parseInt(b));

  for (const file of files) {
    if (CANCELLED) {
      throw new Error("Cancelled");
    }

    const filePath = path.join(folderPath, file);

    await merger.add(filePath);
  }

  await merger.save(outputFile);
}

// =====================================================
// DOWNLOAD PDF
// =====================================================
async function downloadPdfOnce(url, output) {
  ACTIVE_CONTROLLER = new AbortController();

  const res = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 30000,
    signal: ACTIVE_CONTROLLER.signal,
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: BASE_URL,
    },
    validateStatus: (s) => s < 500,
  });

  const writer = fs.createWriteStream(output);

  let checked = false;

  await new Promise((resolve, reject) => {
    res.data.on("data", (chunk) => {
      if (!checked) {
        checked = true;

        const firstBytes = chunk.slice(0, 5).toString();

        const asText = chunk.slice(0, 100).toString().toLowerCase();

        // LOGIN / HTML PAGE
        if (asText.includes("<html") || asText.includes("<!doctype")) {
          res.data.destroy();

          writer.close();

          if (fs.existsSync(output)) {
            fs.unlinkSync(output);
          }

          reject(new Error("HTML page returned instead of PDF"));

          return;
        }

        // INVALID PDF HEADER
        if (firstBytes !== "%PDF-") {
          res.data.destroy();

          writer.close();

          if (fs.existsSync(output)) {
            fs.unlinkSync(output);
          }

          reject(new Error("Invalid PDF signature"));

          return;
        }
      }
    });

    res.data.pipe(writer);

    writer.on("finish", resolve);

    writer.on("error", reject);

    res.data.on("error", reject);
  });

  ACTIVE_CONTROLLER = null;
}

// =====================================================
// DOWNLOAD PDF WITH RETRY
// =====================================================
async function downloadPdfWithRetry(url, output, filename, emit) {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (CANCELLED) {
      throw new Error("Cancelled");
    }

    try {
      if (attempt > 1) {
        emit({
          type: "progress",
          filename,
          status: `Retrying... (${attempt}/${RETRY_ATTEMPTS})`,
          percent: 20 * attempt,
        });

        await sleep(RETRY_DELAY_MS * attempt);
      }

      await downloadPdfOnce(url, output);

      return {
        success: true,
      };
    } catch (err) {
      if (fs.existsSync(output)) {
        try {
          fs.unlinkSync(output);
        } catch (_) {}
      }

      if (CANCELLED) {
        return {
          success: false,
          error: "Cancelled",
        };
      }

      if (attempt === RETRY_ATTEMPTS) {
        return {
          success: false,
          error: err.message,
        };
      }
    }
  }
}

// =====================================================
// MAIN
// =====================================================
async function startDownload(url, emit) {
  CANCELLED = false;

  const FAILED_FILES = [];
  const result = await fetchPage(url);

  if (!result.ok) {
    // =========================================
    // NO INTERNET
    // =========================================

    if (!result.internet) {
      emit({
        type: "no-internet",
        error: result.error,
      });

      return;
    }

    // =========================================
    // OTHER ERRORS
    // =========================================

    emit({
      type: "no-response",
      error: result.error,
    });

    return;
  }

  const $ = cheerio.load(result.page);

  if (CANCELLED) {
    return;
  }

  const meta = extractTableData($);

  const title = meta["title"] || "Unknown Title";

  const safeTitle = sanitize(title);

  const folder = createFolder(meta);

  generateBib(meta, folder, emit);

  const pdfs = extractPdfLinks($);

  emit({
    type: "all-files",
    files: [
      {
        filename: `${safeTitle}.bib`,
        success: true,
      },

      {
        filename: `${safeTitle}.pdf`,
        success: false,
      },

      ...pdfs.map((p) => ({
        filename: decodeURIComponent(p.split("/").pop()),
        success: false,
      })),
    ],
  });

  for (const link of pdfs) {
    if (CANCELLED) {
      emit({
        type: "stopped",
        status: "Download stopped",
      });

      break;
    }

    const filename = decodeURIComponent(link.split("/").pop());

    const out = path.join(folder, filename);

    emit({
      type: "progress",
      filename,
      status: "Downloading...",
      percent: 30,
    });

    const result = await downloadPdfWithRetry(link, out, filename, emit);

    if (result.success) {
      emit({
        type: "progress",
        filename,
        status: "Completed ✓",
        percent: 100,
      });
    } else {
      FAILED_FILES.push({
        filename,
        url: link,
        error: result.error,
      });

      emit({
        type: "progress",
        filename,
        status: `Failed ✗`,
        percent: 100,
      });

      emit({
        type: "failed",
        filename,
        url: link,
        error: result.error,
      });
    }
  }

  if (!CANCELLED && FAILED_FILES.length === 0) {
    try {

      const mergedPdfPath = path.join(folder, `${safeTitle}.pdf`);

      await mergePDFs(folder, mergedPdfPath);

      emit({
        type: "merged",
        filename: `${safeTitle}.pdf`,
        status: "Merged PDF created ✓",
        percent: 100,
      });

    } catch (err) {
      
      emit({
        type: "merged-failed",
        filename: `${safeTitle}.pdf`,
        status: err.message,
        percent: 0,
      });

    }
  }

  emit({
    type: "done",
    folder,
    failed: FAILED_FILES,
  });

  return {
    folder,
    failed: FAILED_FILES,
  };
  
}

module.exports = {
  startDownload,
  stopDownload,
};
