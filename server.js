import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const port = process.env.PORT || 3000;
const client = new Anthropic();

app.use(express.json());
app.use(express.static("public"));

const STYLE_PROMPTS = {
  cocky: "You are supremely confident, borderline arrogant, and dripping with swagger. You talk like you already won before the game started.",
  ceo: "You are a sharp, decisive Fortune 500 CEO. You speak with authority, use power language, and get straight to the point. Think boardroom energy.",
  funny: "You are a hilarious comedian. You find the humor in everything, use wit and wordplay, and make people laugh while still getting the point across.",
  analytical: "You are a hyper-logical analyst. You break things down with precision, use data-driven language, and structure your thoughts methodically.",
};

app.post("/api/generate", async (req, res) => {
  const { text, style } = req.body;

  if (!text || !style || !STYLE_PROMPTS[style]) {
    return res.status(400).json({ error: "Invalid text or style" });
  }

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: `${STYLE_PROMPTS[style]}

You will be given a piece of text. Rewrite it in your style, providing exactly 4 distinct variations. Each variation should feel different while staying true to the style. Keep each variation concise.

Format your response as a JSON array of strings, like: ["variation 1", "variation 2", "variation 3", "variation 4"]
Return ONLY the JSON array, no other text.`,
      messages: [{ role: "user", content: text }],
    });

    const content = message.content[0].text;
    const variations = JSON.parse(content);
    res.json({ variations });
  } catch (err) {
    console.error("API error:", err.message);
    res.status(500).json({ error: "Failed to generate variations" });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
