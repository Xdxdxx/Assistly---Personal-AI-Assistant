// ==============================
// Assistly Server
// ==============================
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { google } from "googleapis";

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

// ==============================
// 1️⃣ OpenAI API CONFIG
// ==============================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// ==============================
// 2️⃣ GOOGLE OAUTH CONFIG
// ==============================
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "http://localhost:3000/auth/google/callback" // ⚠️ Change this to your Render frontend URL in production
);

// Temporary in-memory token storage (use DB for multiple users)
let userTokens = {};

// ==============================
// 3️⃣ GMAIL AUTH ROUTES
// ==============================

// Step 1: Redirect to Google for consent
app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  });
  res.redirect(authUrl);
});

// Step 2: Handle callback and save tokens
app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    userTokens = tokens;
    res.send("✅ Gmail connected successfully! You can close this tab.");
  } catch (error) {
    console.error("❌ Error retrieving tokens:", error);
    res.status(500).send("Authentication failed.");
  }
});

// ==============================
// 4️⃣ GMAIL - READ EMAILS
// ==============================
app.get("/gmail/messages", async (req, res) => {
  try {
    if (!userTokens.access_token) {
      return res.status(401).json({ error: "User not authenticated." });
    }

    oauth2Client.setCredentials(userTokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const response = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
    });

    const messages = await Promise.all(
      (response.data.messages || []).map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
        });

        const headers = detail.data.payload.headers;
        const from = headers.find((h) => h.name === "From")?.value || "Unknown";
        const subject =
          headers.find((h) => h.name === "Subject")?.value || "No Subject";
        const snippet = detail.data.snippet;

        return { from, subject, snippet };
      })
    );

    res.json(messages);
  } catch (error) {
    console.error("Gmail fetch error:", error);
    res.status(500).json({ error: "Failed to fetch Gmail messages." });
  }
});

// ==============================
// 5️⃣ GMAIL - SEND EMAILS
// ==============================
app.post("/gmail/send", async (req, res) => {
  const { to, subject, message } = req.body;

  try {
    if (!userTokens.access_token) {
      return res.status(401).json({ error: "User not authenticated." });
    }

    oauth2Client.setCredentials(userTokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const rawMessage = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      message,
    ].join("\n");

    const encodedMessage = Buffer.from(rawMessage)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedMessage,
      },
    });

    res.json({ success: true, message: "✅ Email sent successfully!" });
  } catch (error) {
    console.error("Email send error:", error);
    res.status(500).json({ success: false, message: "❌ Failed to send email." });
  }
});

// ==============================
// 6️⃣ ASSISTLY CHATBOT ENDPOINT
// ==============================
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are Assistly, a helpful and knowledgeable personal AI assistant chatbot. Format your answers cleanly with bold key points and bullet lists where relevant.",
          },
          { role: "user", content: message },
        ],
      }),
    });

    const data = await response.json();
    const aiResponse = data.choices?.[0]?.message?.content || "No response.";
    res.json({ reply: aiResponse });
  } catch (error) {
    console.error("Chatbot error:", error);
    res.status(500).json({ error: "Failed to connect to AI service." });
  }
});

// ==============================
// 7️⃣ SERVER START
// ==============================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Assistly backend running on port ${PORT}`));










