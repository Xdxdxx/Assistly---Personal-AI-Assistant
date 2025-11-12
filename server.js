// ===============================
// Assistly Server (UPDATED)
// ===============================
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { google } from "googleapis";

dotenv.config();
const app = express();
// Enable JSON parsing and CORS for the widget.
app.use(express.json());
app.use(cors());

// ===============================
// 1️⃣ API KEY CONFIG
// ===============================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Base URL for the OpenAI API
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// ===============================
// 2️⃣ GOOGLE OAUTH CONFIG
// ===============================
// The redirect URI MUST match the one set in your Google Cloud Console.
// Change "http://localhost:3000/auth/google/callback" to your actual
// Render/Netlify backend URL (e.g., https://your-backend.onrender.com/auth/google/callback)
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:3000/auth/google/callback";

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// ⚠️ Temporary in-memory token storage.
// In a production multi-user environment, this MUST be replaced with a database.
// Stored as: { unique_user_id: { accessToken, refreshToken, expiryDate, email } }
let userTokens = {};
const USER_ID = "default_user"; // Use a single, temporary ID for this example

// Utility function to convert email content to Base64 MIME format
function toBase64Url(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ===============================
// 3️⃣ GMAIL AUTH ROUTES
// ===============================

// Step 1: Redirect to Google for consent
app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // Essential for getting a refresh token
    prompt: "consent", // Essential to force re-consent and get a new refresh token if needed
    scope: [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/gmail.send", // Scope to allow sending emails
    ],
    state: USER_ID, // Use state to pass user context (optional for this single-user example)
  });
  res.redirect(authUrl);
});

// Step 2: Google redirects back here with the authorization code
app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).send("Authorization code missing.");
    }

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get the user's email to display a connection status
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const userEmail = profile.data.emailAddress;

    // Store tokens and expiry
    userTokens[USER_ID] = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: new Date(tokens.expiry_date).getTime(),
      email: userEmail,
    };

    // Redirect the user back to the chatbot widget (or a success message page)
    // The query parameter is how the widget knows the login succeeded.
    res.send('<html><body><script>window.opener.postMessage("gmail_auth_success", "*"); window.close();</script></body></html>');
  } catch (error) {
    console.error("Error during Google Auth Callback:", error);
    res.status(500).send("Authentication failed. Check server logs.");
  }
});

// ===============================
// 4️⃣ GMAIL STATUS & SEND ENDPOINTS
// ===============================

// Endpoint to check if Gmail is connected and get the user's email
app.get("/gmail-status", (req, res) => {
  const tokenData = userTokens[USER_ID];
  if (tokenData && tokenData.email) {
    return res.json({ connected: true, email: tokenData.email });
  }
  res.json({ connected: false });
});

// Endpoint to send the email (called by the frontend based on AI instruction)
app.post("/send-email", async (req, res) => {
  const { to, subject, body } = req.body;
  const tokenData = userTokens[USER_ID];

  if (!tokenData) {
    return res.status(401).json({ success: false, message: "❌ Gmail not connected." });
  }

  // Set credentials for the current request
  oauth2Client.setCredentials({
    access_token: tokenData.accessToken,
    refresh_token: tokenData.refreshToken,
    expiry_date: tokenData.expiryDate,
  });

  try {
    // Check if the token needs refreshing
    if (Date.now() >= tokenData.expiryDate) {
        // Automatically refresh the access token if needed
        const newTokens = await oauth2Client.refreshAccessToken();
        tokenData.accessToken = newTokens.credentials.access_token;
        tokenData.expiryDate = newTokens.credentials.expiry_date;
        userTokens[USER_ID] = tokenData; // Update the stored token
        oauth2Client.setCredentials(newTokens.credentials); // Set the new credentials
        console.log("Access token refreshed.");
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Construct the email MIME content
    const raw = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `MIME-Version: 1.0`,
      "",
      body,
    ].join("\n");

    const base64EncodedEmail = toBase64Url(raw);

    const emailRes = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: base64EncodedEmail,
      },
    });

    if (emailRes.data && emailRes.data.id) {
        res.json({ success: true, message: `✅ Email sent successfully to ${to}!` });
    } else {
        res.status(500).json({ success: false, message: "❌ Failed to send email via Gmail API." });
    }
  } catch (error) {
    // Specific check for failed refresh or expired token
    if (error.response && error.response.status === 401) {
        delete userTokens[USER_ID]; // Clear the invalid token
        res.status(401).json({ success: false, message: "❌ Authentication expired. Please reconnect Gmail." });
    } else {
        console.error("Email send error:", error);
        res.status(500).json({ success: false, message: "❌ Failed to send email." });
    }
  }
});

// ===============================
// 5️⃣ ASSISTLY CHATBOT ENDPOINT (UPDATED FOR FUNCTION CALLING)
// ===============================

// Tool definition for the AI
const emailToolDefinition = {
  type: "function",
  function: {
    name: "send_email",
    description: "Sends an email on behalf of the user. Only call this tool if the user explicitly asks to send an email and provides the recipient, subject, and body.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "The recipient's email address." },
        subject: { type: "string", description: "The subject line of the email." },
        body: { type: "string", description: "The main content/body of the email." },
      },
      required: ["to", "subject", "body"],
    },
  },
};

app.post("/chat", async (req, res) => {
  try {
    const { message, isGmailConnected } = req.body;

    // System instruction tells the AI to use the tool when appropriate.
    const systemContent = `
        You are Assistly, a helpful and knowledgeable personal AI assistant chatbot.
        Your primary goal is to help the user.
        
        Tool Status:
        - Gmail is currently ${isGmailConnected ? 'CONNECTED' : 'NOT CONNECTED'}.
        
        If Gmail is connected and the user asks to send an email, use the 'send_email' tool.
        If Gmail is NOT connected and the user asks to send an email, politely explain that they need to connect their Gmail account first.
        Otherwise, answer the user's questions conversationally.
        `;

    const payload = {
      model: "gpt-4o-mini", // Use a model that supports function calling
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: message },
      ],
      tools: isGmailConnected ? [emailToolDefinition] : undefined, // Only provide the tool if connected
      tool_choice: "auto",
    };

    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    const candidate = data.choices?.[0]?.message;

    // Check if the AI decided to call a function/tool
    if (candidate && candidate.tool_calls && candidate.tool_calls.length > 0) {
      const toolCall = candidate.tool_calls[0];
      if (toolCall.function.name === "send_email") {
        const args = JSON.parse(toolCall.function.arguments);
        // Return the function call arguments directly to the frontend
        return res.json({ tool_call: { name: "send_email", args: args } });
      }
    }

    // If no function call, return the standard text reply
    const aiResponse = candidate?.content || "No response.";
    res.json({ reply: aiResponse });

  } catch (error) {
    console.error("Chatbot error:", error);
    res.status(500).json({ error: "Failed to connect to AI service." });
  }
});

// Set the server to listen on the correct port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});







