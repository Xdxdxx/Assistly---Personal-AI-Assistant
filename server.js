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
// The REDIRECT_BASE_URL MUST be set as an environment variable in Render 
// and MUST match the base URL registered in your Google Cloud Console.
// It defaults to your confirmed Render URL if the ENV var is missing.
const REDIRECT_BASE_URL = process.env.REDIRECT_BASE_URL || "https://art-chatbot.onrender.com";
const REDIRECT_URI = `${REDIRECT_BASE_URL}/auth/google/callback`;

console.log("Using REDIRECT_URI:", REDIRECT_URI);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// ⚠️ Temporary in-memory token storage (use a DB for multiple users)
// This is fine for a single user proof-of-concept.
let userTokens = {};

// ===============================
// 3️⃣ GMAIL AUTH ROUTES
// ===============================

// Step 1: Redirect to Google for consent
app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/gmail.send", // Scope to allow sending emails
      "https://www.googleapis.com/auth/userinfo.email", // Scope to get the connected email address
    ],
    // State parameter is used to protect against CSRF attacks. We'll use a simple timestamp here.
    state: Date.now().toString(), 
  });
  res.redirect(authUrl);
});

// Step 2: Handle the callback from Google
app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Store tokens globally for simplicity (in a real app, store this per user in a DB)
    userTokens = tokens;
    
    // Use the token to fetch the connected user's email address
    const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    const profile = await response.json();
    userTokens.email = profile.email;

    // Close the pop-up window in the frontend
    res.send('<script>window.close();</script>');
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(500).send("Authentication failed. Check your logs and environment variables.");
  }
});

// ===============================
// 4️⃣ GMAIL STATUS CHECK ENDPOINT
// ===============================
// The frontend calls this to update the UI status.
app.get("/gmail-status", (req, res) => {
    if (userTokens.access_token && userTokens.email) {
        // Assume connected if tokens and email exist (tokens may expire, but that's handled during send attempt)
        res.json({ connected: true, email: userTokens.email });
    } else {
        res.json({ connected: false, email: null });
    }
});


// ===============================
// 5️⃣ GMAIL EMAIL SEND ENDPOINT (Tool Execution)
// ===============================
// The frontend calls this when the AI requests the 'send_email' tool.
app.post("/send-email", async (req, res) => {
  const { to, subject, body } = req.body;

  if (!userTokens.access_token) {
    // Return a 401 if the user is not authenticated.
    return res.status(401).json({ 
        success: false, 
        message: "🚫 Error: Gmail not connected. Please connect your Gmail account first." 
    });
  }

  // Set credentials for the current user
  oauth2Client.setCredentials(userTokens);
  
  try {
    // 1. Get a refreshed access token if the current one is expired
    // The googleapis library handles token refreshing automatically if `refresh_token` exists.
    await oauth2Client.getAccessToken(); 
    
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    
    // 2. Format the email as a raw, base64url-encoded string
    const emailContent = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].join("\n");

    const base64Email = Buffer.from(emailContent)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    // 3. Send the email
    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: base64Email,
      },
    });

    res.json({ 
        success: true, 
        message: `✅ Email successfully sent to **${to}** with subject: "${subject}"` 
    });
  } catch (error) {
    console.error("Email send error:", error);
    // If the error indicates token failure, you might want to clear the token state
    if (error.message.includes('invalid_grant') || error.message.includes('Token has been expired')) {
         userTokens = {}; // Clear tokens to force re-auth
    }
    res.status(500).json({ success: false, message: "❌ Failed to send email. You may need to reconnect your Gmail account." });
  }
});

// ===============================
// 6️⃣ ASSISTLY CHATBOT ENDPOINT
// ===============================
// The function definition for the AI to use
const emailToolDefinition = {
    type: "function",
    function: {
        name: "send_email",
        description: "Sends an email to a specified recipient with a subject and body. Only use this function when the user explicitly asks to send an email.",
        parameters: {
            type: "object",
            properties: {
                to: {
                    type: "string",
                    description: "The recipient's full email address (e.g., john.doe@example.com).",
                },
                subject: {
                    type: "string",
                    description: "The subject line of the email.",
                },
                body: {
                    type: "string",
                    description: "The main content or body of the email. Write out the full text of the email here.",
                },
            },
            required: ["to", "subject", "body"],
        },
    },
};

app.post("/chat", async (req, res) => {
  try {
    const { message, isGmailConnected } = req.body;
    
    const systemPrompt = 
        "You are Assistly, a helpful and knowledgeable personal AI assistant chatbot. " +
        "Format your answers cleanly with bold key points and bullet lists where relevant. " +
        "You have the ability to send emails via the `send_email` tool. " +
        (isGmailConnected 
            ? "The Gmail service is currently **connected**. Use the `send_email` tool when the user's intent is clearly to send an email."
            : "The Gmail service is currently **not connected**. If the user asks to send an email, politely inform them that they must connect their Gmail account first.");


    const payload = {
      model: "gpt-4o-mini", // Excellent model for general chat and function calling
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      // Only provide the tool if the frontend has confirmed the user is authenticated
      tools: isGmailConnected ? [emailToolDefinition] : undefined, 
      tool_choice: "auto", // Allow the model to decide whether to call the function or respond normally
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
// 7️⃣ START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});







