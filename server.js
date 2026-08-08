
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ============================================================
// TEMPORARY DOWNLOAD TOKENS
// ============================================================

const downloadTokens = new Map();

const TOKEN_LIFETIME = 10 * 60 * 1000;

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Video Downloader API running",
    engine: "yt-dlp + token streaming",
  });
});

// ============================================================
// RUN YT-DLP
// ============================================================

function runYtDlp(videoUrl, useImpersonation = true, signal = null) {
  return new Promise((resolve, reject) => {
    const args = ["--no-playlist", "--dump-single-json", "--no-warnings"];

    if (useImpersonation) {
      args.push("--extractor-args", "generic:impersonate");
    }

    args.push(videoUrl);

    execFile(
      "yt-dlp",
      args,
      {
        maxBuffer: 50 * 1024 * 1024,
        windowsHide: true,
        timeout: 70000,
        signal: signal || undefined,
      },
      (error, stdout, stderr) => {
        if (error) {
          return reject(
            new Error(stderr?.trim() || error.message || "yt-dlp failed")
          );
        }

        try {
          const data = JSON.parse(stdout);
          resolve(data);
        } catch {
          reject(new Error("Could not understand yt-dlp response."));
        }
      }
    );
  });
}

// ============================================================
// RESOLVE WITH RETRY
// ============================================================

async function resolveWithRetry(videoUrl, signal) {
  let lastError;

  // Two attempts with the configuration we already proved works.
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`Extraction attempt ${attempt}/2...`);

    try {
      return await runYtDlp(videoUrl, true, signal);
    } catch (error) {
      lastError = error;

      if (signal.aborted) {
        throw new Error("CANCELLED");
      }

      console.error(`Attempt ${attempt} failed:`);

      console.error(error.message);

      if (attempt < 2) {
        console.log("Retrying extraction...");

        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  throw lastError;
}

// ============================================================
// FIND BEST COMBINED FORMAT
// ============================================================

function findBestCombinedFormat(data) {
  const formats = data.formats || [];

  const combined = formats
    .filter(
      (format) =>
        format.url &&
        format.vcodec &&
        format.vcodec !== "none" &&
        format.acodec &&
        format.acodec !== "none"
    )
    .sort((a, b) => {
      const heightDifference = (b.height || 0) - (a.height || 0);

      if (heightDifference !== 0) {
        return heightDifference;
      }

      return (b.tbr || 0) - (a.tbr || 0);
    });

  if (combined.length > 0) {
    return combined[0];
  }

  // Generic/direct media sites often return the media
  // information on the root object itself.
  if (data.url) {
    return {
      url: data.url,

      ext: data.ext || "mp4",

      width: data.width || null,

      height: data.height || null,

      filesize: data.filesize || data.filesize_approx || null,

      http_headers: data.http_headers || {},
    };
  }

  return null;
}

// ============================================================
// VERIFY REAL VIDEO FILE
// Supported containers:
// MP4 / WebM / MKV / 3GP
// ============================================================

async function verifyVideoFile(format, data, originalUrl, signal) {
  console.log("");
  console.log("VERIFYING MEDIA...");

  const headers = {
    ...(data.http_headers || {}),
    ...(format.http_headers || {}),
  };

  // Axios/Node controls these.
  delete headers["Accept-Encoding"];
  delete headers["accept-encoding"];
  delete headers["Content-Length"];
  delete headers["content-length"];
  delete headers["Host"];
  delete headers["host"];

  // We only need the beginning of the file.
  headers.Range = "bytes=0-65535";

  let response;

  try {
    response = await axios({
      method: "GET",
      url: format.url,
      responseType: "arraybuffer",
      headers,
      maxRedirects: 10,
      timeout: 30000,
      signal,
      validateStatus: (status) => status === 200 || status === 206,
    });
  } catch (error) {
    if (
      error.code === "ERR_CANCELED" ||
      error.name === "CanceledError" ||
      signal?.aborted
    ) {
      throw new Error("CANCELLED");
    }

    console.error("MEDIA VERIFICATION REQUEST FAILED:", error.message);

    return {
      valid: false,
      reason: "Could not verify the returned media source.",
    };
  }

  // ========================================================
  // CONTENT TYPE
  // ========================================================

  const rawContentType = String(
    response.headers["content-type"] || ""
  ).toLowerCase();

  const contentType = rawContentType.split(";")[0].trim();

  // ========================================================
  // HLS PLAYLIST DETECTION
  // ========================================================

  const hlsContentTypes = new Set([
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "audio/mpegurl",
    "audio/x-mpegurl",
  ]);

  if (hlsContentTypes.has(contentType)) {
    const playlistText = Buffer.from(response.data).toString("utf8").trim();

    if (playlistText.startsWith("#EXTM3U")) {
      console.log("Media type: HLS playlist");

      return {
        valid: true,
        type: "hls",
        extension: null,
        contentType,
        size: null,
      };
    }

    return {
      valid: false,
      reason:
        "The source claimed to be HLS but did not return a valid HLS playlist.",
    };
  }

  console.log("Content-Type:", contentType || "Unknown");

  // ========================================================
  // REJECT OBVIOUS NON-VIDEO RESPONSES
  // ========================================================

  const rejectedTypes = [
    "text/html",
    "text/plain",
    "application/json",
    "application/xml",
    "text/xml",
  ];

  if (rejectedTypes.some((type) => contentType === type)) {
    console.log("VERIFICATION FAILED: Non-video response.");

    return {
      valid: false,
      reason: `Source returned ${contentType} instead of a video file.`,
    };
  }

  // ========================================================
  // MIME TYPE DETECTION
  // ========================================================

  let mimeExtension = null;

  if (contentType === "video/mp4") {
    mimeExtension = "mp4";
  } else if (contentType === "video/webm") {
    mimeExtension = "webm";
  } else if (
    contentType === "video/x-matroska" ||
    contentType === "video/matroska"
  ) {
    mimeExtension = "mkv";
  } else if (contentType === "video/3gpp" || contentType === "video/3gp") {
    mimeExtension = "3gp";
  }

  // ========================================================
  // BYTE SIGNATURE DETECTION
  // ========================================================

  const buffer = Buffer.from(response.data);

  if (!buffer.length) {
    console.log("VERIFICATION FAILED: Empty response.");

    return {
      valid: false,
      reason: "The returned media source was empty.",
    };
  }

  let detectedExtension = null;

  // --------------------------------------------------------
  // MP4 / 3GP
  //
  // ISO Base Media File Format:
  // bytes 4-7 normally contain "ftyp".
  // Brand determines MP4 vs 3GP.
  // --------------------------------------------------------

  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12).toLowerCase();

    const threeGpBrands = [
      "3gp1",
      "3gp2",
      "3gp3",
      "3gp4",
      "3gp5",
      "3gp6",
      "3gp7",
      "3gp8",
      "3gp9",
      "3gr6",
      "3gs6",
      "3ge6",
      "3gg6",
    ];

    if (threeGpBrands.includes(brand) || brand.startsWith("3gp")) {
      detectedExtension = "3gp";
    } else {
      detectedExtension = "mp4";
    }
  }

  // --------------------------------------------------------
  // WEBM / MKV
  //
  // Both use EBML:
  // 1A 45 DF A3
  //
  // We inspect the initial metadata for "webm" or "matroska".
  // --------------------------------------------------------

  if (
    !detectedExtension &&
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    const sample = buffer
      .subarray(0, Math.min(buffer.length, 4096))
      .toString("latin1")
      .toLowerCase();

    if (sample.includes("webm")) {
      detectedExtension = "webm";
    } else if (sample.includes("matroska")) {
      detectedExtension = "mkv";
    }
  }

  console.log("Byte signature:", detectedExtension || "Unknown");

  // ========================================================
  // FINAL DECISION
  // ========================================================

  /*
   * Strongest evidence:
   * actual container bytes.
   *
   * If bytes identify the file, use them rather than trusting
   * the website's extension.
   */

  let extension = detectedExtension || mimeExtension;

  const allowedExtensions = new Set(["mp4", "webm", "mkv", "3gp"]);

  if (!extension || !allowedExtensions.has(extension)) {
    console.log("");
    console.log("VERIFICATION FAILED");

    console.log("Reason: Unsupported or unidentified media.");

    return {
      valid: false,
      reason:
        "The source did not return a verified MP4, WebM, MKV or 3GP video.",
    };
  }

  // If both MIME and bytes identify the container but disagree,
  // trust the actual bytes and record the mismatch.

  if (
    detectedExtension &&
    mimeExtension &&
    detectedExtension !== mimeExtension
  ) {
    console.log("WARNING: MIME/container mismatch.");

    console.log("MIME says:", mimeExtension);

    console.log("Bytes say:", detectedExtension);

    extension = detectedExtension;
  }

  // ========================================================
  // SIZE
  // ========================================================

  let size = null;

  const contentRange = response.headers["content-range"];

  if (contentRange) {
    const match = String(contentRange).match(/\/(\d+)$/);

    if (match) {
      size = Number(match[1]);
    }
  }

  if (!size && response.status === 200) {
    const contentLength = Number(response.headers["content-length"]);

    if (Number.isFinite(contentLength) && contentLength > 0) {
      size = contentLength;
    }
  }

  console.log("");
  console.log("MEDIA VERIFIED");
  console.log("Container:", extension.toUpperCase());

  if (size) {
    console.log("Size:", (size / 1024 / 1024).toFixed(2), "MB");
  }

  console.log("========================================");

  return {
    valid: true,
    type: "direct",
    extension,
    contentType,
    size,
  };
}

// ============================================================
// TEMP HLS DIRECTORY
// ============================================================

const TEMP_DIRECTORY =
  path.join(__dirname, "temp");

if (!fs.existsSync(TEMP_DIRECTORY)) {
  fs.mkdirSync(TEMP_DIRECTORY, {
    recursive: true
  });
}


// ============================================================
// PREPARE HLS VIDEO
// ============================================================

function prepareHlsVideo(videoUrl, token, signal) {

  return new Promise((resolve, reject) => {

    const outputTemplate =
      path.join(
        TEMP_DIRECTORY,
        `${token}.%(ext)s`
      );

    const args = [
      "--no-playlist",
      "--extractor-args",
      "generic:impersonate",

      "-f",
      "bestvideo*+bestaudio/best",

      "--merge-output-format",
      "mp4",

      "--remux-video",
      "mp4",

      "-o",
      outputTemplate,

      videoUrl
    ];


    console.log("");
    console.log("PREPARING HLS VIDEO...");


    const child =
      execFile(
        "yt-dlp",
        args,
        {
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024
        },
        (error, stdout, stderr) => {

          if (error) {

            if (signal?.aborted) {
              return reject(
                new Error("CANCELLED")
              );
            }

            console.error(
              stderr || error.message
            );

            return reject(
              new Error(
                "Could not prepare HLS video."
              )
            );
          }


          const files =
            fs.readdirSync(TEMP_DIRECTORY)
              .filter(file =>
                file.startsWith(`${token}.`)
              );


          const finalFile =
            files.find(file =>
              file.toLowerCase().endsWith(".mp4")
            );


          if (!finalFile) {
            return reject(
              new Error(
                "HLS processing finished but no MP4 file was created."
              )
            );
          }


          const filePath =
            path.join(
              TEMP_DIRECTORY,
              finalFile
            );


          const stats =
            fs.statSync(filePath);


          console.log("");
          console.log("HLS VIDEO READY");
          console.log(
            "File:",
            finalFile
          );
          console.log(
            "Size:",
            (stats.size / 1024 / 1024).toFixed(2),
            "MB"
          );


          resolve({
            filePath,
            extension: "mp4",
            size: stats.size
          });
        }
      );


    if (signal) {

      signal.addEventListener(
        "abort",
        () => {

          if (!child.killed) {
            child.kill();
          }

        },
        {
          once: true
        }
      );
    }
  });
}

// ============================================================
// SAFE FILE NAME
// ============================================================

function safeFilename(title) {
  let name = (title || "video")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) {
    name = "video";
  }

  return name.substring(0, 120);
}

// ============================================================
// RESOLVE ENDPOINT
// ============================================================

app.post("/resolve", async (req, res) => {
  const controller = new AbortController();

  // ========================================================
  // CANCEL ONLY WHEN CLIENT ACTUALLY ABORTS THE REQUEST
  // ========================================================

  req.on("aborted", () => {
    console.log("Resolve request aborted by client.");

    if (!controller.signal.aborted) {
      controller.abort();
    }
  });
  const videoUrl = String(req.body.url || "").trim();

  if (!videoUrl) {
    return res.status(400).json({
      success: false,
      error: "Please paste a video URL.",
    });
  }

  try {
    const parsed = new URL(videoUrl);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    return res.status(400).json({
      success: false,
      error: "Please enter a valid HTTP/HTTPS URL.",
    });
  }

  console.log("");
  console.log("========================================");
  console.log("RESOLVE REQUEST");
  console.log(videoUrl);
  console.log("========================================");

  try {
    const data = await resolveWithRetry(videoUrl, controller.signal);

    const format = findBestCombinedFormat(data);

    if (!format || !format.url) {
      return res.status(404).json({
        success: false,
        error:
          "The video was found, but no directly streamable video+audio format was available.",
      });
    }

    // ========================================================
    // VERIFY THAT THE RESOLVED URL IS ACTUALLY A VIDEO
    // ========================================================

    const verification = await verifyVideoFile(
      format,
      data,
      videoUrl,
      controller.signal
    );

    if (!verification.valid) {
      console.log("");
      console.log("RESOLVE REJECTED");
      console.log(verification.reason);
      console.log("========================================");

      return res.status(422).json({
        success: false,
        error: "No valid downloadable video file was found.",
      });
    }

    // ========================================================
    // VERIFIED — NOW CREATE DOWNLOAD TOKEN
    // ========================================================

    // ========================================================
    // CREATE DOWNLOAD TOKEN
    // ========================================================

    const token = crypto.randomUUID();

    let extension;
    let downloadType;
    let expectedSize = null;
    let localFilePath = null;
    

    // ========================================================
    // DIRECT VIDEO
    // MP4 / WEBM / MKV / 3GP
    // ========================================================

    if (verification.type === "direct") {
      console.log("");
      console.log("DOWNLOAD MODE: DIRECT");

      downloadType = "direct";

      extension = verification.extension;

      expectedSize =
        verification.size || format.filesize || format.filesize_approx || null;
    }

    // ========================================================
    // HLS VIDEO
    // STREAM DIRECTLY TO CHROME — NO TEMP FILE
    // ========================================================

    else if (verification.type === "hls") {

        console.log("");
        console.log("DOWNLOAD MODE: HLS");
      
        console.log(
          "Preparing final MP4..."
        );
      
      
        const prepared =
          await prepareHlsVideo(
            videoUrl,
            token,
            controller.signal
          );
      
      
        downloadType =
          "local";
      
        extension =
          "mp4";
      
        localFilePath =
          prepared.filePath;
      
        expectedSize =
          prepared.size;
      
      
        console.log("");
        console.log(
          "HLS PREPARATION COMPLETE"
        );
      }
  
      // ========================================================
      // UNKNOWN TYPE
      // ========================================================
  
      else {
  
        throw new Error(
          "Unsupported video delivery type."
        );
      } 

    const filename = `${safeFilename(data.title)}.${extension}`;

    // Preserve yt-dlp's media-request headers.
    const sourceHeaders = {
      ...(data.http_headers || {}),
      ...(format.http_headers || {}),
    };

    downloadTokens.set(token, {

        type:
          downloadType,
      
        mediaUrl:
          format.url,
      
        originalUrl:
          videoUrl,
      
        filePath:
          localFilePath,
      
        title:
          safeFilename(
            data.title || "video"
          ),
      
        extension,
      
        filename:
          `${safeFilename(data.title || "video")}.${extension}`,
      
        expectedSize,
      
        sourceHeaders: {
          ...(data.http_headers || {}),
          ...(format.http_headers || {})
        },
      
        createdAt:
          Date.now()
      });

    console.log("");
    console.log("RESOLVE SUCCESS");
    console.log("Title:", data.title);
    console.log("Format:", extension);
    console.log("Resolution:", format.height ? `${format.height}p` : "Unknown");
    console.log("Source:", new URL(format.url).hostname);
    console.log("Token:", token);
    console.log("========================================");

    return res.json({
      success: true,

      video: {
        title: safeFilename(data.title || "Video"),

        thumbnail: data.thumbnail || null,

        duration: data.duration || null,

        resolution: format.height ? `${format.height}p` : null,

        fileSize: expectedSize || null,
      },

      downloadUrl: `http://localhost:${PORT}/stream/${token}`,
    });
  } catch (error) {
    // ========================================================
    // USER CANCELLED
    // ========================================================

    if (error.message === "CANCELLED" || controller.signal.aborted) {
      console.log("");
      console.log("RESOLVE CANCELLED");

      // Client may already have disconnected.
      if (!res.headersSent) {
        return res.status(499).json({
          success: false,
          cancelled: true,
          error: "Request cancelled.",
        });
      }

      return;
    }

    // ========================================================
    // ACTUAL FAILURE
    // ========================================================

    console.error("");
    console.error("RESOLVE FAILED");
    console.error(error.message);

    return res.status(500).json({
      success: false,
      error:
        "Could not extract this video. The source site did not respond correctly after retrying.",
    });
  }
});

// ============================================================
// STREAM ENDPOINT
// ============================================================

app.get("/stream/:token", async (req, res) => {
  const token = req.params.token;

  const item = downloadTokens.get(token);

  if (!item) {
    return res.status(404).send("Download link expired or does not exist.");
  }

  if (Date.now() - item.createdAt > TOKEN_LIFETIME) {
    downloadTokens.delete(token);

    return res
      .status(410)
      .send("Download link expired. Please resolve the video again.");
  }

// ========================================================
// PREPARED HLS MP4 -> CHROME
// ========================================================

if (item.type === "local") {

    const filePath =
      item.filePath;
  
  
    if (
      !filePath ||
      !fs.existsSync(filePath)
    ) {
  
      downloadTokens.delete(token);
  
      return res
        .status(404)
        .send(
          "Prepared video file was not found."
        );
    }
  
  
    const stats =
      fs.statSync(filePath);
  
  
    res.status(200);
  
    res.setHeader(
      "Content-Type",
      "video/mp4"
    );
  
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(
        item.filename
      )}`
    );
  
    res.setHeader(
      "Content-Length",
      stats.size
    );
  
    res.setHeader(
      "Cache-Control",
      "no-store"
    );
  
  
    console.log("");
    console.log("========================================");
    console.log("LOCAL STREAM REQUEST");
    console.log("File:", item.filename);
    console.log(
      "Size:",
      (stats.size / 1024 / 1024).toFixed(2),
      "MB"
    );
    console.log("========================================");
  
  
    const fileStream =
      fs.createReadStream(filePath);
  
  
    let cleaned =
      false;
  
  
    function cleanup() {
  
      if (cleaned) {
        return;
      }
  
      cleaned =
        true;
  
  
      downloadTokens.delete(
        token
      );
  
  
      setTimeout(() => {
  
        try {
  
          if (
            fs.existsSync(filePath)
          ) {
  
            fs.unlinkSync(
              filePath
            );
  
            console.log(
              "Temporary HLS file deleted."
            );
          }
  
        } catch (error) {
  
          console.error(
            "TEMP CLEANUP ERROR:",
            error.message
          );
        }
  
      }, 1500);
    }
  
  
    fileStream.on(
      "end",
      () => {
  
        console.log(
          "LOCAL STREAM COMPLETE"
        );
  
        cleanup();
      }
    );
  
  
    fileStream.on(
      "error",
      error => {
  
        console.error(
          "LOCAL STREAM ERROR:",
          error.message
        );
  
        cleanup();
  
        if (!res.destroyed) {
          res.destroy(error);
        }
      }
    );
  
  
    fileStream.pipe(res);
  
  
    return;
  }

  console.log("");
  console.log("========================================");
  console.log("STREAM REQUEST");
  console.log("Title:", item.title);
  console.log("========================================");

  try {
    const headers = {
      ...item.sourceHeaders,
    };

    // Remove headers that Axios/Node should determine.
    delete headers["Accept-Encoding"];
    delete headers["accept-encoding"];
    delete headers["Content-Length"];
    delete headers["content-length"];
    delete headers["Host"];
    delete headers["host"];

    // Forward Chrome Range requests if present.
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const sourceResponse = await axios({
      method: "GET",

      url: item.mediaUrl,

      responseType: "stream",

      headers,

      maxRedirects: 10,

      timeout: 60000,

      validateStatus: (status) => status >= 200 && status < 400,
    });

    const sourceType =
      sourceResponse.headers["content-type"] || "application/octet-stream";

    const normalizedSourceType = String(sourceType)
      .split(";")[0]
      .trim()
      .toLowerCase();

    const dangerousResponseTypes = new Set([
      "text/html",
      "text/plain",
      "application/json",
      "application/xml",
      "text/xml",
    ]);

    if (dangerousResponseTypes.has(normalizedSourceType)) {
      console.error(
        "STREAM BLOCKED:",
        "Source changed to",
        normalizedSourceType
      );

      sourceResponse.data.destroy();

      downloadTokens.delete(token);

      return res
        .status(502)
        .send("The video source no longer returned a valid video file.");
    }

    const sourceLength = sourceResponse.headers["content-length"];

    const contentRange = sourceResponse.headers["content-range"];

    const acceptRanges = sourceResponse.headers["accept-ranges"];

    if (sourceResponse.status === 206) {
      res.status(206);
    }

    res.setHeader("Content-Type", sourceType);

    const asciiFilename =
      safeFilename(item.title)
        .replace(/[^\x20-\x7E]/g, "")
        .trim() || "video";

    const finalFilename = `${asciiFilename}.${item.extension || "mp4"}`;

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${finalFilename}"; filename*=UTF-8''${encodeURIComponent(
        finalFilename
      )}`
    );

    if (sourceLength) {
      res.setHeader("Content-Length", sourceLength);
    }

    if (contentRange) {
      res.setHeader("Content-Range", contentRange);
    }

    if (acceptRanges) {
      res.setHeader("Accept-Ranges", acceptRanges);
    }

    res.setHeader("Cache-Control", "no-store");

    console.log("STREAM STARTED");

    if (sourceLength) {
      console.log(
        "Transfer size:",
        (Number(sourceLength) / 1024 / 1024).toFixed(2),
        "MB"
      );
    }

    sourceResponse.data.pipe(res);

    sourceResponse.data.on("end", () => {
      console.log("STREAM COMPLETE");

      // One successful transfer is enough for now.
      downloadTokens.delete(token);
    });

    sourceResponse.data.on("error", (error) => {
      console.error("UPSTREAM STREAM ERROR:", error.message);

      if (!res.destroyed) {
        res.destroy(error);
      }
    });

    // Correct cancellation signal: outgoing response.
    res.on("close", () => {
      if (!res.writableEnded && !sourceResponse.data.destroyed) {
        console.log("Browser cancelled download.");

        sourceResponse.data.destroy();
      }
    });
  } catch (error) {
    console.error("STREAM FAILED:", error.message);

    if (!res.headersSent) {
      return res.status(502).send("Could not connect to the video source.");
    }

    res.destroy();
  }
});

setInterval(() => {

    const now = Date.now();
  
    for (const [token, item] of downloadTokens.entries()) {
  
      if (now - item.createdAt > TOKEN_LIFETIME) {
  
        downloadTokens.delete(token);
  
      }
    }
  
  }, 60 * 1000);
// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log("");
  console.log("========================================");
  console.log(" VIDEO DOWNLOADER");
  console.log("========================================");
  console.log(` Server : http://localhost:${PORT}`);
  console.log(" Engine : yt-dlp + token streaming");
  console.log(" Mode   : Native Chrome download");
  console.log(" Status : READY");
  console.log("========================================");
  console.log("");
});
