import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "127.0.0.1";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const absolute = normalize(join(ROOT, relative));
  if (absolute !== ROOT && !absolute.startsWith(ROOT + sep)) return null;
  return absolute;
}

async function resolveFile(urlPath) {
  const requested = safePath(urlPath);
  if (!requested) return null;

  try {
    const stat = await fs.stat(requested);
    if (stat.isFile()) return requested;
  } catch {}

  // The application is currently a static single-page app. Fall back to
  // index.html for browser routes while still serving real assets directly.
  if (!extname(requested)) {
    const indexPath = join(ROOT, "index.html");
    try {
      await fs.access(indexPath);
      return indexPath;
    } catch {}
  }

  return null;
}

const server = createServer(async (req, res) => {
  try {
    const filePath = await resolveFile(req.url || "/");
    if (!filePath) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const extension = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache"
    });

    createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Tasty Vadapav local server: http://${HOST}:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});
