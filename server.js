const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { execFile } = require("child_process");
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
        engine: "yt-dlp + token streaming"
    });
});


// ============================================================
// RUN YT-DLP
// ============================================================

function runYtDlp(videoUrl, useImpersonation = true, signal = null) {
    return new Promise((resolve, reject) => {

        const args = [
            "--no-playlist",
            "--dump-single-json",
            "--no-warnings"
        ];

        if (useImpersonation) {
            args.push(
                "--extractor-args",
                "generic:impersonate"
            );
        }

        args.push(videoUrl);

        execFile(
            "yt-dlp",
            args,
            {
                maxBuffer: 50 * 1024 * 1024,
                windowsHide: true,
                timeout: 70000,
                signal: signal || undefined
            },
            (error, stdout, stderr) => {

                if (error) {
                    return reject(
                        new Error(
                            stderr?.trim() ||
                            error.message ||
                            "yt-dlp failed"
                        )
                    );
                }

                try {
                    const data = JSON.parse(stdout);
                    resolve(data);
                } catch {
                    reject(
                        new Error(
                            "Could not understand yt-dlp response."
                        )
                    );
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

        console.log(
            `Extraction attempt ${attempt}/2...`
        );

        try {

            return await runYtDlp(
                videoUrl,
                true,
                signal
            );

        } catch (error) {

            lastError = error;

            if (signal.aborted) {
                throw new Error("CANCELLED");
            }
        

            console.error(
                `Attempt ${attempt} failed:`
            );

            console.error(
                error.message
            );

            if (attempt < 2) {

                console.log(
                    "Retrying extraction..."
                );

                await new Promise(resolve =>
                    setTimeout(resolve, 1500)
                );
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
        .filter(format =>
            format.url &&
            format.vcodec &&
            format.vcodec !== "none" &&
            format.acodec &&
            format.acodec !== "none"
        )
        .sort((a, b) => {

            const heightDifference =
                (b.height || 0) -
                (a.height || 0);

            if (heightDifference !== 0) {
                return heightDifference;
            }

            return (
                (b.tbr || 0) -
                (a.tbr || 0)
            );
        });


    if (combined.length > 0) {
        return combined[0];
    }


    // Generic/direct media sites often return the media
    // information on the root object itself.
    if (data.url) {

        return {
            url: data.url,

            ext:
                data.ext ||
                "mp4",

            width:
                data.width ||
                null,

            height:
                data.height ||
                null,

            filesize:
                data.filesize ||
                data.filesize_approx ||
                null,

            http_headers:
                data.http_headers ||
                {}
        };
    }


    return null;
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

    const controller =
    new AbortController();

res.on("close", () => {

    if (!res.writableEnded) {

        console.log(
            "Resolve cancelled by user."
        );

        controller.abort();
    }
});

    const videoUrl =
        String(req.body.url || "").trim();


    if (!videoUrl) {
        return res.status(400).json({
            success: false,
            error: "Please paste a video URL."
        });
    }


    try {

        const parsed = new URL(videoUrl);

        if (
            parsed.protocol !== "http:" &&
            parsed.protocol !== "https:"
        ) {
            throw new Error();
        }

    } catch {

        return res.status(400).json({
            success: false,
            error: "Please enter a valid HTTP/HTTPS URL."
        });
    }


    console.log("");
    console.log("========================================");
    console.log("RESOLVE REQUEST");
    console.log(videoUrl);
    console.log("========================================");


    try {

        const data =
    await resolveWithRetry(
        videoUrl,
        controller.signal
    );


        const format =
            findBestCombinedFormat(data);


        if (!format || !format.url) {

            return res.status(404).json({
                success: false,
                error:
                    "The video was found, but no directly streamable video+audio format was available."
            });
        }


        const token =
            crypto.randomUUID();


            let extension =
            String(format.ext || data.ext || "mp4")
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "");
        
        if (!extension) {
            extension = "mp4";
        }


        const filename =
            `${safeFilename(data.title)}.${extension}`;


        // Preserve yt-dlp's media-request headers.
        const sourceHeaders = {
            ...(data.http_headers || {}),
            ...(format.http_headers || {})
        };


        downloadTokens.set(token, {

            mediaUrl:
                format.url,

            originalUrl:
                videoUrl,

                filename,

                extension,
                
                title:
                    safeFilename(data.title || "Video"),

            thumbnail:
                data.thumbnail ||
                null,

            duration:
                data.duration ||
                null,

            resolution:
                format.height
                    ? `${format.height}p`
                    : null,

            expectedSize:
                format.filesize ||
                format.filesize_approx ||
                null,

            sourceHeaders,

            createdAt:
                Date.now()
        });


        console.log("");
        console.log("RESOLVE SUCCESS");
        console.log(
            "Title:",
            data.title
        );
        console.log(
            "Format:",
            extension
        );
        console.log(
            "Resolution:",
            format.height
                ? `${format.height}p`
                : "Unknown"
        );
        console.log(
            "Source:",
            new URL(format.url).hostname
        );
        console.log(
            "Token:",
            token
        );
        console.log("========================================");


        return res.json({

            success: true,

            video: {
                title:
    safeFilename(data.title || "Video"),

                thumbnail:
                    data.thumbnail ||
                    null,

                duration:
                    data.duration ||
                    null,

                resolution:
                    format.height
                        ? `${format.height}p`
                        : null,

                fileSize:
                    format.filesize ||
                    format.filesize_approx ||
                    null
            },

            downloadUrl:
                `http://localhost:${PORT}/stream/${token}`
        });


    } catch (error) {

        console.error("");
        console.error("RESOLVE FAILED");
        console.error(error.message);


        return res.status(500).json({
            success: false,
            error:
                "Could not extract this video. The source site did not respond correctly after retrying."
        });
    }
});


// ============================================================
// STREAM ENDPOINT
// ============================================================

app.get("/stream/:token", async (req, res) => {

    const token =
        req.params.token;


    const item =
        downloadTokens.get(token);


    if (!item) {

        return res.status(404).send(
            "Download link expired or does not exist."
        );
    }


    if (
        Date.now() - item.createdAt >
        TOKEN_LIFETIME
    ) {

        downloadTokens.delete(token);

        return res.status(410).send(
            "Download link expired. Please resolve the video again."
        );
    }


    console.log("");
    console.log("========================================");
    console.log("STREAM REQUEST");
    console.log(
        "Title:",
        item.title
    );
    console.log("========================================");


    try {

        const headers = {
            ...item.sourceHeaders
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
            headers.Range =
                req.headers.range;
        }


        const sourceResponse =
            await axios({

                method: "GET",

                url: item.mediaUrl,

                responseType: "stream",

                headers,

                maxRedirects: 10,

                timeout: 60000,

                validateStatus: status =>
                    status >= 200 &&
                    status < 400
            });


        const sourceType =
            sourceResponse.headers[
                "content-type"
            ] ||
            "application/octet-stream";


        const sourceLength =
            sourceResponse.headers[
                "content-length"
            ];


        const contentRange =
            sourceResponse.headers[
                "content-range"
            ];


        const acceptRanges =
            sourceResponse.headers[
                "accept-ranges"
            ];


        if (sourceResponse.status === 206) {
            res.status(206);
        }


        res.setHeader(
            "Content-Type",
            sourceType
        );


        const asciiFilename = safeFilename(item.title)
    .replace(/[^\x20-\x7E]/g, "")
    .trim() || "video";

const finalFilename =
    `${asciiFilename}.${item.extension || "mp4"}`;

res.setHeader(
    "Content-Disposition",
    `attachment; filename="${finalFilename}"; filename*=UTF-8''${encodeURIComponent(finalFilename)}`
);


        if (sourceLength) {
            res.setHeader(
                "Content-Length",
                sourceLength
            );
        }


        if (contentRange) {
            res.setHeader(
                "Content-Range",
                contentRange
            );
        }


        if (acceptRanges) {
            res.setHeader(
                "Accept-Ranges",
                acceptRanges
            );
        }


        res.setHeader(
            "Cache-Control",
            "no-store"
        );


        console.log("STREAM STARTED");


        if (sourceLength) {

            console.log(
                "Transfer size:",
                (
                    Number(sourceLength) /
                    1024 /
                    1024
                ).toFixed(2),
                "MB"
            );
        }


        sourceResponse.data.pipe(res);


        sourceResponse.data.on(
            "end",
            () => {

                console.log(
                    "STREAM COMPLETE"
                );

                // One successful transfer is enough for now.
                downloadTokens.delete(token);
            }
        );


        sourceResponse.data.on(
            "error",
            error => {

                console.error(
                    "UPSTREAM STREAM ERROR:",
                    error.message
                );

                if (!res.destroyed) {
                    res.destroy(error);
                }
            }
        );


        // Correct cancellation signal: outgoing response.
        res.on(
            "close",
            () => {

                if (
                    !res.writableEnded &&
                    !sourceResponse.data.destroyed
                ) {

                    console.log(
                        "Browser cancelled download."
                    );

                    sourceResponse.data.destroy();
                }
            }
        );


    } catch (error) {

        console.error(
            "STREAM FAILED:",
            error.message
        );


        if (!res.headersSent) {

            return res.status(502).send(
                "Could not connect to the video source."
            );
        }


        res.destroy();
    }
});


// ============================================================
// TOKEN CLEANUP
// ============================================================

setInterval(() => {

    const now =
        Date.now();


    for (
        const [token, item]
        of downloadTokens.entries()
    ) {

        if (
            now - item.createdAt >
            TOKEN_LIFETIME
        ) {

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
    console.log(
        ` Server : http://localhost:${PORT}`
    );
    console.log(
        " Engine : yt-dlp + token streaming"
    );
    console.log(
        " Mode   : Native Chrome download"
    );
    console.log(
        " Status : READY"
    );
    console.log("========================================");
    console.log("");
});