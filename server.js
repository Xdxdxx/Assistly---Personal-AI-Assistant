// ===============================
// Assistly Server (Syncing Endpoints)
// ===================================
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { google } from "googleapis";
import { fileURLToPath } from 'url';
import path from 'path';

// Helper to get __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// ⚠️ Temporary in-memory token storage (Use DB for multiple users and persistence!)
// Key is a session ID (simulated), Value is the token object
let userTokens = {}; 

// Tool Definition for OpenAI
const emailToolDefinition = {
  type: "function",
  function: {
    name: "send_email",
    description: "Sends an email to a specified recipient with a given subject and body.",
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
          description: "The full content/body of the email.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
};

// ===============================
// 3️⃣ GMAIL AUTH ROUTES
// ===============================

// Step 1: Redirect to Google for consent
app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // Get a refresh token
    scope: [
      "https://www.googleapis.com/auth/gmail.send", // Scope to send emails
      "https://www.googleapis.com/auth/userinfo.email", // Scope to get user email
    ],
    prompt: "consent", // Force re-consent to get a new refresh token
    state: req.query.sessionId || "default-session", // Pass session ID (optional)
  });
  res.redirect(authUrl);
});

// Step 2: Handle the callback from Google
app.get("/auth/google/callback", async (req, res) => {
  const { code, state: sessionId } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    // Store tokens against the session ID
    userTokens[sessionId] = tokens; 

    // Get user email
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
    const userInfo = await oauth2.userinfo.get();
    
    // Store email along with tokens
    userTokens[sessionId].email = userInfo.data.email;

    // Send a response back to the client widget 
    // This script closes the popup and passes connection success back to the main window
    res.send(`
      <script>
        window.opener.postMessage({ type: 'GMAIL_AUTH_SUCCESS', sessionId: '${sessionId}', email: '${userInfo.data.email}' }, '*');
        window.close();
      </script>
    `);
  } catch (error) {
    console.error("Token exchange failed:", error);
    res.status(500).send(`
        <script>
            window.opener.postMessage({ type: 'GMAIL_AUTH_FAILURE' }, '*');
            window.close();
        </script>
    `);
  }
});

// Endpoint to check connection status
app.get("/auth/status", (req, res) => {
  const sessionId = req.query.sessionId || "default-session";
  const tokens = userTokens[sessionId];
  
  if (tokens && tokens.access_token) {
    res.json({ isConnected: true, email: tokens.email });
  } else {
    res.json({ isConnected: false, email: null });
  }
});

// Endpoint to disconnect
app.post("/auth/disconnect", (req, res) => {
  const sessionId = req.body.sessionId || "default-session";
  delete userTokens[sessionId];
  res.json({ success: true, isConnected: false });
});

// =============================
// 4️⃣ GMAIL SEND ENDPOINT
// =============================
function createMail(to, subject, body) {
  const emailLines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ];
  const email = emailLines.join('\r\n');
  
  // Encode the email message in base64 URL safe format
  return Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

app.post("/send-email", async (req, res) => {
  const { to, subject, body, sessionId } = req.body;
  const tokens = userTokens[sessionId];

  if (!tokens || !tokens.access_token) {
    return res.status(401).json({ success: false, message: "❌ Gmail not authenticated. Please connect your account." });
  }

  try {
    // Refresh the access token if it's expired
    oauth2Client.setCredentials(tokens);
    const refreshedTokens = await oauth2Client.refreshAccessToken();
    userTokens[sessionId] = { ...tokens, ...refreshedTokens.credentials };

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    
    const raw = createMail(to, subject, body);

    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: raw,
      },
    });

    res.json({ success: true, message: "✅ Email sent successfully!" });
  } catch (error) {
    console.error("Email send error:", error);
    // Note: A 401 error here often means the refresh token failed, so we should log out the user
    if (error.code === 401) {
         delete userTokens[sessionId]; // Clear invalid tokens
         return res.status(401).json({ success: false, message: "❌ Authentication expired. Please reconnect Gmail." });
    }
    res.status(500).json({ success: false, message: "❌ Failed to send email." });
  }
});

// ===================================
// 5️⃣ CHATBOT ENDPOINT (TOOL-ENABLED)
// ===================================

app.post("/chat", async (req, res) => {
  try {
    const { message, sessionId, history } = req.body;
    const tokens = userTokens[sessionId];
    const isGmailConnected = !!tokens;

    // The system prompt should reflect the availability of the tool
    const toolStatus = isGmailConnected
      ? "You have access to the `send_email` tool. Use it whenever the user asks to send an email."
      : "The `send_email` tool is NOT available. Inform the user they need to connect their Gmail account to send emails, and offer to redirect them to connect.";

    const systemPrompt = `You are Assistly, a helpful and knowledgeable personal AI assistant chatbot. ${toolStatus} Format your answers cleanly with bold key points and bullet lists where relevant.`;

    // Map the stored history (user/bot) to the OpenAI message format (user/assistant)
    const chatHistoryContent = history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant', 
        content: msg.content
    }));

    // Construct the base payload without tool parameters
    let payload = {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        ...chatHistoryContent,
        { role: "user", content: message },
      ],
    };

    // ONLY add tools and tool_choice if Gmail is connected
    if (isGmailConnected) {
        payload.tools = [emailToolDefinition];
        payload.tool_choice = "auto";
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

    // Handle API error case (e.g., the 400 error the user saw)
    if (data.error) {
        console.error("OpenAI API Error:", data.error.message);
        return res.status(500).json({ error: `AI Service Error: ${data.error.message}` });
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
    res.status(500).json({ error: "Failed to connect to AI service." });
  }
});

// =============================
// 6️⃣ TITLE GENERATION ENDPOINT
// =============================
app.post("/generate-title", async (req, res) => {
    try {
        const { message } = req.body;

        const systemPrompt = "You are a chat title generator. Based on the first user message, provide a very concise, three-word title. Do not include quotes or any other punctuation. Respond only with the title.";
        
        const payload = {
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: message }
            ],
            temperature: 0.1,
            max_tokens: 10,
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
        const aiResponse = data.choices?.[0]?.message?.content?.trim() || "New Chat Topic";
        
        // Handle API error case (optional, but good practice)
        if (data.error) {
            console.error("OpenAI Title API Error:", data.error.message);
            return res.status(500).json({ title: "New Chat Topic" });
        }

        res.json({ title: aiResponse });

    } catch (error) {
        console.error("Title Generation error:", error);
        res.status(500).json({ title: "New Chat Topic" });
    }
});


// =============================
// 7️⃣ SERVER START
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));


