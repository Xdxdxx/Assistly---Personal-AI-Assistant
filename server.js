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
const REDIRECT_BASE_URL = process.env.REDIRECT_BASE_URL || "https://art-chatbot.onrender.com";
const REDIRECT_URI = `${REDIRECT_BASE_URL}/auth/google/callback`;

console.log("Using REDIRECT_URI:", REDIRECT_URI);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// Map to store user tokens securely
// NOTE: In a production environment, this should use a persistent database (e.g., MongoDB, Redis).
const userTokens = new Map();

// Scopes required for Gmail access
const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/userinfo.email"];

// ===============================
// 3️⃣ TOOL DEFINITIONS
// ===============================

// Define the tool/function the AI can use
const emailToolDefinition = {
  type: "function",
  function: {
    name: "send_email",
    description: "Sends a professionally formatted email to a specified recipient.",
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
          description: "The main content of the email, written in a clear, professional tone.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
};

// ===============================
// 4️⃣ OAUTH ENDPOINTS
// ===============================

// Endpoint to initiate the Google OAuth flow
app.get("/auth/google", (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: "Missing userId" });
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // To get a refresh token
    scope: SCOPES,
    state: userId, // Use state to pass the userId securely
  });
  res.json({ authUrl });
});

// OAuth callback endpoint (Google redirects here)
app.get("/auth/google/callback", async (req, res) => {
  const { code, state: userId } = req.query;

  if (!code || !userId) {
    return res.status(400).send("Error: Missing code or user ID.");
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user email
    const people = google.people({ version: "v1", auth: oauth2Client });
    const profile = await people.people.get({
      resourceName: "people/me",
      personFields: "emailAddresses",
    });
    const email = profile.data.emailAddresses[0].value;

    // Store tokens and email
    userTokens.set(userId, { tokens, email });
    console.log(`User ${userId} successfully authenticated as ${email}`);

    // Script to close the popup and notify the parent window
    res.send(`
      <script>
        window.opener.postMessage({ 
          type: 'AUTH_SUCCESS', 
          userId: '${userId}', 
          email: '${email}' 
        }, '*');
        window.close();
      </script>
    `);
  } catch (error) {
    console.error("Error retrieving access token:", error);
    res.status(500).send("Authentication failed. Please check server logs.");
  }
});

// Endpoint to check connection status
app.get("/auth/status", (req, res) => {
    const userId = req.query.userId;
    const tokens = userTokens.get(userId);

    if (tokens && tokens.email) {
        res.json({ isConnected: true, email: tokens.email });
    } else {
        res.json({ isConnected: false, email: null });
    }
});

// Endpoint to disconnect Gmail
app.post("/auth/disconnect", (req, res) => {
    const { userId } = req.body;
    if (userTokens.has(userId)) {
        userTokens.delete(userId);
        return res.json({ success: true, message: "Gmail disconnected." });
    }
    res.json({ success: false, message: "User was not connected." });
});


// ===============================
// 5️⃣ CHAT ENDPOINT
// ===============================

app.post("/chat", async (req, res) => {
  const { history, userId, isGmailConnected } = req.body;
  if (!history || !userId) {
    return res.status(400).json({ error: "Missing chat history or user ID." });
  }

  // Map client roles ('assistant') to API roles ('assistant') and structure messages
  const currentHistory = history.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  try {
    const systemPrompt = `You are Assistly, a helpful, friendly, and professional AI assistant.
When asked to send an email, use the 'send_email' tool. Only use the tool if the user explicitly asks you to send an email and provides the recipient, subject, and body.
Do not make up email details. If an email is requested but you are not connected, inform the user you need Gmail connection.
If you use a tool, you must follow up with a friendly conversational response explaining the outcome.
The current date and time is ${new Date().toISOString()}.`;

    // 1. Base payload setup
    const payload = {
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        ...currentHistory,
      ],
      // Ensure streaming is disabled as we are running tool execution loops on the server
      stream: false, 
    };

    // 2. Conditionally add tools and tool_choice (FIX for "Invalid value for 'tool_choice'")
    if (isGmailConnected) {
      // Check if we have tokens (client claims connected, but server might have lost state)
      const hasTokens = userTokens.has(userId);
      if (hasTokens) {
          payload.tools = [emailToolDefinition];
          payload.tool_choice = "auto";
      } else {
          // If client claims connected but server doesn't have tokens, treat as disconnected
          console.warn(`User ${userId} claimed connected, but tokens missing on server.`);
          // Continue without tools, AI will be prompted to ask for connection if needed.
      }
    }

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
    
    // Check for API-level errors
    if (data.error) {
        throw new Error(data.error.message || "Unknown API Error");
    }

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
    res.status(500).json({ reply: `Error: ❌ API Error: ${error.message}` });
  }
});

// ===============================
// 6️⃣ TOOL EXECUTION ENDPOINT
// ===============================

// This endpoint is called by the frontend when the AI requests a tool execution.
app.post("/tool/execute", async (req, res) => {
  const { userId, toolCall } = req.body;
  const { name, args } = toolCall;

  if (name === "send_email") {
    try {
      const tokens = userTokens.get(userId);
      if (!tokens) {
        return res.json({ tool_result: "Error: Gmail not connected. Cannot send email." });
      }

      oauth2Client.setCredentials(tokens.tokens);
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });

      const emailLines = [
        `To: ${args.to}`,
        `Subject: ${args.subject}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        args.body,
      ];
      const raw = Buffer.from(emailLines.join("\n"))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

      await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: raw,
        },
      });

      return res.json({ tool_result: `Email successfully sent to ${args.to} with subject "${args.subject}".` });
    } catch (error) {
      console.error("Error sending email:", error);
      // Return a structured error message for the AI to process and explain to the user
      return res.json({ tool_result: `Error: Failed to send email. Check recipient address and permissions. Detailed error: ${error.message}` });
    }
  }

  // Handle unknown tool
  res.status(400).json({ error: "Unknown tool requested." });
});

// ===============================
// 7️⃣ SERVER START
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
