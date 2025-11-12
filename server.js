// ===============================
// Assistly Server (Syncing Endpoints)
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
// The REDIRECT_BASE_URL MUST be set as an environment variable in Render 
// and MUST match the base URL registered in your Google Cloud Console.
const REDIRECT_BASE_URL = process.env.REDIRECT_BASE_URL || "http://localhost:3000";
const REDIRECT_URI = `${REDIRECT_BASE_URL}/auth/google/callback`;

console.log("Using REDIRECT_URI:", REDIRECT_URI);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// ⚠️ Temporary in-memory token storage (use DB for multiple users)
let userTokens = {}; // Stores { credentials: { access_token, refresh_token, expiry_date, ... } }
let userEmail = null;

// ===============================
// 3️⃣ GMAIL AUTH ROUTES
// ===============================

// Step 1: Redirect to Google for consent
app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // To get a refresh token
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly", // Added for reading emails
      "https://www.googleapis.com/auth/userinfo.email" // To get the user's email
    ],
    prompt: "consent", // Force consent screen to ensure refresh token is returned
  });
  res.redirect(authUrl);
});

// Step 2: Handle the callback from Google
app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    userTokens.credentials = tokens;

    // Get the user's email for display
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    userEmail = userInfo.data.email;

    // Redirect back to the frontend (e.g., the chat widget page)
    // Note: The frontend must handle this redirect closing the window/modal
    res.send('<html><script>window.opener.postMessage("gmail_auth_success", "*"); window.close();</script></html>');
  } catch (error) {
    console.error("Error retrieving tokens:", error);
    res.status(500).send("Authentication failed.");
  }
});

// Endpoint to check current Gmail connection status
app.get("/auth/status", (req, res) => {
  const isConnected = !!userTokens.credentials?.access_token;
  res.json({ isConnected, email: userEmail });
});

// Endpoint to log out and clear tokens
app.post("/auth/logout", (req, res) => {
    userTokens = {};
    userEmail = null;
    res.json({ success: true, message: "Gmail disconnected." });
});

// ===============================
// 4️⃣ GMAIL SEND ENDPOINT
// ===============================
app.post("/email/send", async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    const credentials = userTokens.credentials;

    if (!credentials || !credentials.access_token) {
      return res.status(401).json({ success: false, message: "❌ Gmail not connected. Please connect your Gmail account first." });
    }

    // Set the client credentials
    oauth2Client.setCredentials(credentials);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Construct the email message in RFC 2822 format
    const message = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].join("\n");

    const base64Email = Buffer.from(message).toString("base64url");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: base64Email,
      },
    });

    res.json({ success: true, message: `✅ Email sent successfully to ${to}.` });
  } catch (error) {
    console.error("Email send error:", error);
    // Google API error response includes a data object
    const errorMessage = error.response?.data?.error?.message || "❌ Failed to send email.";
    res.status(500).json({ success: false, message: errorMessage });
  }
});

// Function to decode and clean Gmail message snippet
const decodeSnippet = (snippet) => {
    // Gmail snippets often use an encoding where characters like &amp; are present
    return snippet.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
};

// ===============================
// 5️⃣ GMAIL LIST ENDPOINT (FIXED: Guesses the source of the `map` error)
// ===============================
app.get("/emails/list", async (req, res) => {
  try {
    const credentials = userTokens.credentials;
    if (!credentials || !credentials.access_token) {
      return res.status(401).json({ error: "Gmail not connected." });
    }

    // Set the client credentials
    oauth2Client.setCredentials(credentials);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Fetch the last 5 messages from the inbox
    const listRes = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
      labelIds: ["INBOX"],
    });

    // --- FIX FOR 'Cannot read properties of undefined (reading 'map')' ---
    // listRes.data.messages is undefined when the inbox is empty or on certain API errors.
    // We default it to an empty array [] to prevent the .map() error.
    const messageIds = listRes.data.messages || [];

    if (messageIds.length === 0) {
      return res.json({ emails: [] });
    }

    // Use Promise.all to fetch details of all messages concurrently
    const emailPromises = messageIds.map(async (message) => {
      const getRes = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "metadata",
        metadataHeaders: ['From', 'Subject', 'Date'], // Request only necessary headers
      });

      const headers = getRes.data.payload.headers;
      const getHeader = (name) => headers.find(h => h.name === name)?.value || 'N/A';

      return {
        id: getRes.data.id,
        threadId: getRes.data.threadId,
        snippet: decodeSnippet(getRes.data.snippet),
        from: getHeader('From'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
      };
    });

    const emails = await Promise.all(emailPromises);

    res.json({ emails });
  } catch (error) {
    console.error("Error fetching email list:", error);
    // Log details of the error to help with debugging
    if (error.response && error.response.data) {
        console.error("Gmail API Error Data:", error.response.data);
    }
    // Return a 500 status with an error message
    res.status(500).json({ error: "Failed to fetch emails from Gmail." });
  }
});

// ===============================
// 6️⃣ CHATBOT ENDPOINT (Renumbered)
// ===============================
// The function definition for the AI to use
const emailToolDefinition = {
  type: "function",
  function: {
    name: "send_email",
    description: "Sends an email via the user's connected Gmail account. ONLY use this tool when the user explicitly asks to send an email.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "The recipient's email address.",
        },
        subject: {
          type: "string",
          description: "The subject line of the email.",
        },
        body: {
          type: "string",
          description: "The main content of the email.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
};

app.post("/chat", async (req, res) => {
  try {
    const { message, chatHistory } = req.body; // chatHistory is passed from frontend

    // Check if the user is connected to Gmail
    const isGmailConnected = !!userTokens.credentials?.access_token;
    
    // System message adjusted for current connection status
    const systemContent = isGmailConnected
      ? "You are Assistly, a helpful and knowledgeable personal AI assistant chatbot. Use the send_email tool only when the user explicitly asks you to send an email. Format your answers cleanly with bold key points and bullet lists where relevant."
      : "You are Assistly, a helpful and knowledgeable personal AI assistant chatbot. You do not have access to send emails. Format your answers cleanly with bold key points and bullet lists where relevant.";

    // Construct the payload for the OpenAI API
    const payload = {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemContent,
        },
        ...(chatHistory || []), // Ensure chatHistory is an array, default to empty
        { role: "user", content: message },
      ],
      // Only provide the tool definition if the user has confirmed the user is authenticated
      tools: isGmailConnected ? [emailToolDefinition] : undefined, 
      tool_choice: "auto", 
    };

    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    const candidate = data.choices?.[0]?.message;

    // Check if the AI decided to call a function/tool
    if (candidate && candidate.tool_calls && candidate.tool_calls.length > 0) {
      const toolCall = candidate.tool_calls[0];
      if (toolCall.function.name === "send_email") {
        const args = JSON.parse(toolCall.function.arguments);
        // Return the function call arguments directly to the frontend for execution
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

// ===============================
// 7️⃣ SERVER START
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});



