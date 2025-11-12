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
const REDIRECT_BASE_URL = process.env.REDIRECT_BASE_URL || "https://art-chatbot.onrender.com";
const REDIRECT_URI = `${REDIRECT_BASE_URL}/auth/google/callback`;

console.log("Using REDIRECT_URI:", REDIRECT_URI);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// ⚠️ Temporary in-memory token storage (use a DB for multiple users)
let userTokens = {};

// ===============================
// 3️⃣ GMAIL AUTH ROUTES
// ===============================

// Step 1: Redirect to Google for consent
app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    // ⚠️ IMPORTANT: prompt: 'consent' forces Google to issue a new refresh token every time.
    prompt: "consent", 
    scope: [
      "https://www.googleapis.com/auth/gmail.send", 
      "https://www.googleapis.com/auth/userinfo.email", 
    ],
    state: Date.now().toString(), 
  });
  res.redirect(authUrl);
});

// Step 2: Handle the callback from Google
app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    // Store ALL tokens (including refresh_token)
    userTokens = tokens; 
    
    oauth2Client.setCredentials(tokens);
    
    // Use the token to fetch the connected user's email address
    const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    const profile = await response.json();
    userTokens.email = profile.email;
    
    // Log for debugging: confirm refresh token exists
    console.log("Authentication successful. Refresh Token received:", !!userTokens.refresh_token);

    // Close the pop-up window in the frontend
    res.send('<script>window.close();</script>');
  } catch (error) {
    console.error("Authentication error:", error);
    // The error is often related to the redirect URI mismatch, which causes the token exchange to fail.
    res.status(500).send("Authentication failed. Check your logs and Google Cloud Console Redirect URIs.");
  }
});

// ===============================
// 4️⃣ GMAIL STATUS CHECK ENDPOINT
// ===============================
// The frontend calls this to update the UI status. (Changed from /gmail-status to /auth/status to match client)
app.get("/auth/status", (req, res) => {
    // Check for refresh_token as well, as that's what keeps the session alive long-term
    if (userTokens.access_token && userTokens.email && userTokens.refresh_token) {
        res.json({ isConnected: true, email: userTokens.email });
    } else {
        res.json({ isConnected: false, email: null });
    }
});


// ===============================
// 5️⃣ GMAIL EMAIL SEND ENDPOINT (Tool Execution)
// ===============================
// The frontend calls this when the AI requests the 'send_email' tool. (Changed from /send-email to /email/send to match client)
app.post("/email/send", async (req, res) => {
  const { recipient_email: to, subject, body } = req.body;

  if (!userTokens.access_token) {
    return res.status(401).json({ 
        success: false, 
        message: "🚫 Error: Gmail not connected. Please connect your Gmail account first." 
    });
  }

  // Set credentials from stored tokens
  oauth2Client.setCredentials(userTokens);
  
  try {
    // 1. Explicitly refresh the token before use. 
    // This handles expiry and updates userTokens if successful.
    const { credentials } = await oauth2Client.refreshAccessToken(); 
    // Update the in-memory token store with the new access token
    userTokens.access_token = credentials.access_token; 
    userTokens.expiry_date = credentials.expiry_date; 
    
    console.log("Token successfully refreshed. Proceeding with email send.");

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
    
    // ⚠️ CRITICAL: Check for common token failure messages (e.g., Google or JWT errors)
    if (error.code === 401 || error.message.includes('invalid_grant') || error.message.includes('invalid_token')) {
         userTokens = {}; // Clear tokens to force a full re-auth
         console.log("Access token is invalid. Cleared userTokens.");
         return res.status(401).json({ 
            success: false, 
            message: "❌ Failed to send email. The Gmail connection is no longer valid. Please click 'Connect Gmail' to re-authenticate." 
        });
    }

    res.status(500).json({ success: false, message: "❌ Failed to send email. A server error occurred." });
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
                recipient_email: { // Changed key name to match client's expectation
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
            required: ["recipient_email", "subject", "body"],
        },
    },
};

app.post("/chat", async (req, res) => {
  try {
    const { message, isGmailConnected, currentChat } = req.body;
    
    // Construct chat history for context
    let messages = [{ role: "system", content: 
        "You are Assistly, a helpful and knowledgeable personal AI assistant chatbot. " +
        "Format your answers cleanly with bold key points and bullet lists where relevant. " +
        "You have the ability to send emails via the `send_email` tool. " +
        (isGmailConnected 
            ? "The Gmail service is currently **connected**. Use the `send_email` tool when the user's intent is clearly to send an email."
            : "The Gmail service is currently **not connected**. If the user asks to send an email, politely inform them that they must connect their Gmail account first.")
    }];

    // Add previous messages (currentChat from frontend is the history)
    if (Array.isArray(currentChat)) {
        currentChat.forEach(msg => {
            if (msg.sender === 'user') {
                messages.push({ role: 'user', content: msg.text });
            } else if (msg.sender === 'bot' && !msg.text.includes('Email Confirmation')) {
                // Do not include tool call confirmations in history sent to AI
                messages.push({ role: 'assistant', content: msg.text });
            }
        });
    }
    
    // Add the latest user message
    messages.push({ role: "user", content: message });


    const payload = {
      model: "gpt-4o-mini", 
      messages: messages,
      // Only provide the tool if the frontend has confirmed the user is authenticated
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






