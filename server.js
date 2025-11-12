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

// ⚠️ Temporary in-memory token storage (use DB for multiple users)
// Key: Session ID, Value: { tokens: { access_token, refresh_token, expiry_date }, email: string }
let userTokens = {}; 

// ===============================
// 3️⃣ GMAIL AUTH ROUTES
// ===============================

// Step 1: Redirect to Google for consent
app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/gmail.send", // Scope needed to send emails
      "https://www.googleapis.com/auth/userinfo.email" // To get the user's email
    ],
    // State is used to track the user session (in a real app)
    state: 'default-session-id', 
  });
  res.redirect(authUrl);
});

// Step 2: Handle the callback from Google
app.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get the user's email
    const people = google.people({ version: 'v1', auth: oauth2Client });
    const profile = await people.people.get({
        resourceName: 'people/me',
        personFields: 'emailAddresses',
    });
    const email = profile.data.emailAddresses[0].value;
    
    // Store tokens and email
    userTokens[state || 'default-session-id'] = { tokens, email };
    
    // Send a message back to the frontend (which is running the widget)
    // In a real app, this would redirect back to the widget URL.
    res.send(`
      <script>
        // This script runs in the callback window and tells the main widget window the status.
        if (window.opener) {
            window.opener.postMessage({ 
                type: 'AUTH_SUCCESS', 
                isConnected: true,
                email: '${email}' 
            }, '*'); // Replace '*' with your actual widget origin in production
            window.close();
        } else {
            document.body.innerHTML = 'Authentication successful! You can close this window now.';
        }
      </script>
    `);
  } catch (error) {
    console.error("Auth callback error:", error);
    res.status(500).send("Authentication failed.");
  }
});

// Route to check if the user is connected
app.get("/auth/status", (req, res) => {
    // Check if the default session has tokens
    const sessionData = userTokens['default-session-id'];
    res.json({ 
        isConnected: !!sessionData,
        email: sessionData ? sessionData.email : null
    });
});

// ===============================
// 4️⃣ GMAIL TOOL DEFINITION
// ===============================

// Tool definition for the AI
const emailToolDefinition = {
    type: "function",
    function: {
        name: "send_email",
        description: "Sends an email to a specified recipient with a subject and body. Only call this tool if the user explicitly asks to send an email.",
        parameters: {
            type: "object",
            properties: {
                recipient_email: {
                    type: "string",
                    description: "The full email address of the recipient (e.g., john@example.com)."
                },
                subject: {
                    type: "string",
                    description: "The subject line of the email."
                },
                body: {
                    type: "string",
                    description: "The full content of the email body."
                }
            },
            required: ["recipient_email", "subject", "body"]
        }
    }
};

// ===============================
// 5️⃣ EMAIL SENDING ENDPOINT
// ===============================

app.post("/email/send", async (req, res) => {
  // Use the tokens from the default session
  const sessionData = userTokens['default-session-id'];

  if (!sessionData) {
    return res.status(401).json({ success: false, message: "User is not authenticated with Gmail." });
  }

  const { recipient_email, subject, body } = req.body;
  const { tokens, email: senderEmail } = sessionData;

  // Set credentials for the current request
  oauth2Client.setCredentials(tokens);

  try {
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Create the raw email content
    const raw = [
      `To: ${recipient_email}`,
      `From: ${senderEmail}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].join("\n");

    // Base64 encode the email, replacing specific characters
    const encodedMail = Buffer.from(raw)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedMail,
      },
    });

    res.json({ success: true, message: "Email sent successfully." });
  } catch (error) {
    console.error("Email send error:", error);
    res.status(500).json({ success: false, message: "❌ Failed to send email." });
  }
});

// ===============================
// 6️⃣ ASSISTLY CHATBOT ENDPOINT
// ===============================
app.post("/chat", async (req, res) => {
  try {
    const { message, isGmailConnected, currentChat } = req.body;
    
    // Construct the chat history for context
    const chatHistory = currentChat.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text
    }));
    
    // Add the current user message to the history
    chatHistory.push({ role: 'user', content: message });
    
    // System instruction updated to discourage headings (#)
    const systemInstruction = 
      "You are Assistly, a helpful and knowledgeable personal AI assistant chatbot. Respond using clean, simple Markdown. DO NOT use markdown headings (H1, H2, H3, etc., starting with #). Use **bold text** and bullet lists where relevant for formatting.";

    const payload = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemInstruction },
        ...chatHistory, // Use full history
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

// ===============================
// 7️⃣ TITLE GENERATION ENDPOINT
// ===============================
app.post("/title", async (req, res) => {
    try {
        const { message } = req.body;
        
        const titlePayload = {
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are a concise title generator. Based on the user's first message, provide a very short, 2-5 word title for the chat. Respond with ONLY the title text and nothing else. Do not use quotation marks."
                },
                { role: "user", content: message }
            ],
            max_tokens: 15, // Keep it short
        };

        const response = await fetch(OPENAI_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify(titlePayload),
        });

        const data = await response.json();
        const aiResponse = data.choices?.[0]?.message?.content?.trim() || "New Chat";

        res.json({ title: aiResponse });
    } catch (error) {
        console.error("Title generation error:", error);
        res.status(500).json({ error: "Failed to generate title." });
    }
});


// ===============================
// 8️⃣ SERVER START
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});






