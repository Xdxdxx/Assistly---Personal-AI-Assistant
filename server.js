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
// Allowing all origins for easy development and deployment
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
const REDIRECT_BASE_URL = process.env.REDIRECT_BASE_URL || "http://localhost:3000"; // Changed default for local testing
const REDIRECT_URI = `${REDIRECT_BASE_URL}/auth/google/callback`;

console.log("Using REDIRECT_URI:", REDIRECT_URI);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// Map to store tokens by a session ID or user identifier
// NOTE: For a production app, use a persistent database (like Firestore or Redis)
const userTokens = new Map();

// ===============================
// 3️⃣ GMAIL TOOL DEFINITION
// ===============================

// Define the tool function structure for the AI model
const emailToolDefinition = {
  type: "function",
  function: {
    name: "send_email",
    description: "Sends an email to a recipient on behalf of the user. Use this only when the user explicitly requests to send an email and provides the recipient, subject, and body.",
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
          description: "The main content/body of the email.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
};

// ===============================
// 4️⃣ GMAIL API CALLS (Run on Server)
// ===============================

/**
 * Sends an email using the Gmail API.
 * This is called by the frontend after receiving the tool_call from the AI.
 * @param {string} userId - The unique user ID to fetch the tokens.
 * @param {object} emailData - The email data (to, subject, body).
 */
async function executeSendEmail(userId, { to, subject, body }) {
  const tokens = userTokens.get(userId);
  if (!tokens || !tokens.access_token) {
    throw new Error("User not authenticated for Gmail.");
  }

  // Set the credentials to the OAuth client
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // Create the raw email message
  const raw = Buffer.from(
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    "Content-Type: text/plain; charset=\"UTF-8\"\r\n" +
    "Content-Transfer-Encoding: base64\r\n\r\n" +
    `${body}`
  ).toString("base64")
   .replace(/\+/g, "-") // URL safe encoding
   .replace(/\//g, "_")
   .replace(/=+$/, "");

  // Send the email
  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: raw,
    },
  });

  return response.data;
}


// ===============================
// 5️⃣ SERVER ENDPOINTS
// ===============================

// Root endpoint just for health checks (Render requires this)
app.get("/", (req, res) => {
  res.send("Assistly AI Chatbot Server is running.");
});

// -------------------------------
// A. Google Auth Flow Endpoints
// -------------------------------

// Initiates the OAuth flow
app.get("/auth/google", (req, res) => {
  const userId = req.query.userId; // Pass a unique ID from the frontend
  if (!userId) {
    return res.status(400).send("Missing userId.");
  }

  // Set the user ID in a state parameter to retrieve it later in the callback
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.send", "email", "profile"],
    state: userId,
    prompt: "consent", // Force re-consent to get a new refresh token
  });
  res.json({ authUrl });
});

// The Google callback endpoint
app.get("/auth/google/callback", async (req, res) => {
  const { code, state: userId } = req.query;

  if (!code || !userId) {
    return res.status(400).send("Authentication failed: Missing code or state.");
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    // Fetch user info to get the email address
    oauth2Client.setCredentials(tokens);
    const userInfo = await google.oauth2("v2").userinfo.get({ auth: oauth2Client });
    const userEmail = userInfo.data.email;

    // Store tokens and email
    userTokens.set(userId, { ...tokens, email: userEmail });
    console.log(`Successfully received and stored tokens for user: ${userId}`);

    // Redirect the user back to the frontend, indicating success
    // The frontend should listen for this message.
    const successPage = `
      <script>
        window.opener.postMessage({ type: 'AUTH_SUCCESS', userId: '${userId}', email: '${userEmail}' }, '${REDIRECT_BASE_URL}');
        window.close();
      </script>
      <h1>Gmail Connected!</h1>
      <p>You can now close this window and use the email feature in the chat widget.</p>
    `;
    res.send(successPage);

  } catch (error) {
    console.error("Error retrieving access token:", error);
    res.status(500).send("Error during authentication process.");
  }
});

// Check connection status
app.get("/auth/status", (req, res) => {
    const userId = req.query.userId;
    const tokens = userTokens.get(userId);
    const isConnected = !!tokens;
    const email = tokens ? tokens.email : null;
    res.json({ isConnected, email });
});

// Disconnect/Logout
app.post("/auth/disconnect", (req, res) => {
    const userId = req.body.userId;
    if (userTokens.has(userId)) {
        userTokens.delete(userId);
        return res.json({ success: true, message: "Gmail disconnected." });
    }
    res.json({ success: false, message: "User not found or already disconnected." });
});

// -------------------------------
// B. Gmail Tool Execution Endpoint
// -------------------------------

// Executes the tool function requested by the AI
app.post("/tool/execute", async (req, res) => {
    const { userId, toolCall } = req.body;
    const { name, args } = toolCall;

    if (!userId) {
        return res.status(400).json({ error: "Missing userId." });
    }

    try {
        if (name === "send_email") {
            const result = await executeSendEmail(userId, args);
            // Return a status message that the AI can use to confirm to the user
            return res.json({ 
                tool_result: `Email successfully sent to ${args.to} with subject: "${args.subject}". Gmail API response ID: ${result.id}` 
            });
        }
        
        return res.status(400).json({ error: `Unknown tool: ${name}` });

    } catch (error) {
        console.error(`Error executing ${name} for user ${userId}:`, error.message);
        // Return a detailed error message for the AI to communicate to the user
        return res.status(500).json({ 
            tool_result: `Failed to send email. Error: ${error.message}. Please ask the user to verify their Gmail connection.`
        });
    }
});


// -------------------------------
// C. Main Chat Endpoint
// -------------------------------

app.post("/chat", async (req, res) => {
  try {
    const { history, userId, isGmailConnected } = req.body;

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not set.");
      return res.status(500).json({ reply: "Configuration error: Missing AI service key." });
    }
    if (!history || history.length === 0) {
      return res.status(400).json({ reply: "Message history is empty." });
    }

    const payload = {
      model: "gpt-4o-mini", // A capable and cost-effective model for this task
      messages: [
        {
          role: "system",
          content: "You are Assistly, a helpful and friendly personal assistant. Your role is to assist the user with tasks and information. You are capable of sending emails if the user asks you to, but only if they have connected their Gmail account. Your response must be conversational and concise. If the user asks you to send an email, use the 'send_email' function call. Do NOT invent the recipient, subject, or body; only use the exact details provided by the user.",
        },
        // Spread the user's message history (this must already include system/tool messages if applicable)
        ...history, 
      ],
      // Only provide the email tool if the user is connected
      tools: isGmailConnected ? [emailToolDefinition] : undefined,
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

    // Attempt to parse the response JSON
    const data = await response.json();

    // ⚠️ CRITICAL FIX: Enhanced Error Handling (Solves the "No response" issue)
    // -----------------------------------------------------------------------
    if (data.error) {
        console.error("OpenAI API Error:", data.error);
        const errorMessage = `❌ API Error: ${data.error.message || 'Unknown error.'}`;
        // Return detailed error status to the frontend for display
        return res.status(500).json({ reply: errorMessage });
    }
    
    // Check if choices array is missing/empty
    if (!data.choices || data.choices.length === 0) {
        console.error("OpenAI response contained no choices:", data);
        return res.status(500).json({ reply: "❌ Internal Error: AI returned an empty response. Check server logs." });
    }
    // -----------------------------------------------------------------------
    
    const candidate = data.choices[0].message;

    // Check if the AI decided to call a function/tool
    if (candidate && candidate.tool_calls && candidate.tool_calls.length > 0) {
      const toolCall = candidate.tool_calls[0];
      if (toolCall.function.name === "send_email") {
        try {
            const args = JSON.parse(toolCall.function.arguments);
            // Return the function call arguments directly to the frontend for execution
            return res.json({ tool_call: { name: "send_email", args: args } });
        } catch(e) {
            console.error("Error parsing function arguments:", e);
            return res.json({ reply: "I tried to call the email function but received invalid arguments. Please ensure you provided the recipient, subject, and body clearly." });
        }
      }
    }

    // If no function call, return the standard text reply
    const aiResponse = candidate?.content || "No response.";
    res.json({ reply: aiResponse });

  } catch (error) {
    console.error("Chatbot internal error:", error);
    res.status(500).json({ reply: "Failed to connect to AI service due to a server error." });
  }
});

// ===============================
// 6️⃣ START SERVER
// ===============================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Frontend can access API at ${REDIRECT_BASE_URL}`);
});


