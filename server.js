import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

const app = express();
const port = process.env.PORT || 3000;
const client = new Anthropic();

app.use(express.json());
app.use(express.static("public"));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in a few minutes." },
});

const STYLE_PROMPTS = {
  cocky: "cocky (confident, swagger, bold)",
  ceo: "ceo (authoritative, decisive, power language)",
  funny: "funny (witty, humorous, playful)",
  analytical: "analytical (precise, logical, structured)",
};

app.post("/api/generate", apiLimiter, async (req, res) => {
  const { text, style, intensity } = req.body;

  if (!text || !style || !STYLE_PROMPTS[style]) {
    return res.status(400).json({ error: "Invalid text or style" });
  }

  const level = Math.max(1, Math.min(5, Math.round(intensity || 3)));

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      temperature: 0.8,
      system: `You are a translation engine. You translate text from "neutral tone" into a target tone. Like any translator, you preserve the EXACT meaning — you only change how it sounds, never what it says. A question stays a question. A statement stays a statement. You never reply to the text, you only translate it. Intensity: ${level}/5. Return 4 translations as a JSON array.`,
      messages: [
        {
          role: "user",
          content: `Translate to cocky tone: "How are you?"`,
        },
        {
          role: "assistant",
          content: `["You keeping up okay over there?", "How you holding up in my presence?", "Still functioning around all this greatness?", "You good, or just starstruck?"]`,
        },
        {
          role: "user",
          content: `Translate to cocky tone: "Wie geht es dir?"`,
        },
        {
          role: "assistant",
          content: `["Na, kommst du klar?", "Wie schlägt sich jemand wie du so?", "Und, hältst du mit?", "Alles fit bei dir, oder überwältigt?"]`,
        },
        {
          role: "user",
          content: `Translate to funny tone: "I need to finish this report by Friday"`,
        },
        {
          role: "assistant",
          content: `["I gotta somehow survive until Friday with this report breathing down my neck", "This report and I have a hot date on Friday and I'm not ready", "Friday wants a report from me, which feels like a personal attack", "Apparently this report won't write itself by Friday, which seems unfair"]`,
        },
        {
          role: "user",
          content: `Translate to analytical tone: "I think we should try a different approach"`,
        },
        {
          role: "assistant",
          content: `["Based on current indicators, a strategic pivot may yield better outcomes", "The data suggests our current methodology warrants reassessment", "A cost-benefit analysis points toward exploring alternative frameworks", "Given the variables at play, recalibrating our approach seems optimal"]`,
        },
        {
          role: "user",
          content: `Translate to ${style} tone: "${text}"\n\nRespond with ONLY the JSON array, like the examples above.`,
        },
      ],
    });

    const content = message.content[0].text;
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array in response");
    const variations = JSON.parse(jsonMatch[0]);
    res.json({ variations });
  } catch (err) {
    console.error("API error:", err.message);
    res.status(500).json({ error: "Failed to generate variations" });
  }
});

// --- Media Download via yt-dlp ---

const DOWNLOADS_DIR = path.join(process.cwd(), ".downloads");
if (!existsSync(DOWNLOADS_DIR)) mkdirSync(DOWNLOADS_DIR);

const SUPPORTED_DOMAINS = /(?:instagram\.com|youtube\.com|youtu\.be|youtube\.com\/shorts)\//;

app.post("/api/media-download", apiLimiter, async (req, res) => {
  const { url } = req.body;

  if (!url || !SUPPORTED_DOMAINS.test(url)) {
    return res.status(400).json({ error: "Please provide a valid Instagram or YouTube URL." });
  }

  try {
    // Get metadata first
    const { stdout } = await exec("yt-dlp", [
      "--dump-json",
      "--no-download",
      "--cookies-from-browser", "firefox",
      url,
    ], { timeout: 30000 });

    const info = JSON.parse(stdout);
    const hasVideo = info.vcodec && info.vcodec !== "none";
    const ext = hasVideo ? "mp4" : (info.ext || "jpg");
    const type = hasVideo ? "video" : "image";
    const prefix = url.includes("instagram.com") ? "ig" : "yt";
    const filename = `${prefix}_${info.id}.${ext}`;
    const filepath = path.join(DOWNLOADS_DIR, filename);

    // Download the file (merge best video+audio for YouTube)
    const dlArgs = ["-o", filepath, "--force-overwrites", "--cookies-from-browser", "firefox"];
    if (hasVideo && prefix === "yt") {
      dlArgs.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best");
      dlArgs.push("--merge-output-format", "mp4");
    }
    dlArgs.push(url);

    await exec("yt-dlp", dlArgs, { timeout: 120000 });

    res.json({
      filename,
      type,
      title: info.title || info.description?.substring(0, 80) || "Media",
      duration: info.duration ? formatDuration(info.duration) : null,
      downloadUrl: `/api/media-file/${filename}`,
    });
  } catch (err) {
    console.error("Download error:", err.message);
    res.status(500).json({
      error: "Failed to download. The content may be private or the URL is invalid.",
    });
  }
});

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Serve downloaded files
app.get("/api/media-file/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (!existsSync(filepath)) {
    return res.status(404).send("File not found");
  }

  const ext = path.extname(filename).toLowerCase();
  const contentTypes = {
    ".mp4": "video/mp4",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };

  res.setHeader("Content-Type", contentTypes[ext] || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.sendFile(filepath);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
