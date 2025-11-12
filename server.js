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
const REDIRECT_BASE_URL = process.env.REDIRECT_BASE_URL || "http://localhost:3000"; // Use localhost for local dev
const REDIRECT_URI = `${REDIRECT_BASE_URL}/auth/google/callback`;

console.log("Using REDIRECT_URI:", REDIRECT_URI);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// ⚠️ Temporary in-memory token storage (use DB for multiple users)
let userTokens = {};
let userEmail = null;

// ===============================
// 3️⃣ GMAIL AUTH ROUTES
// ===============================

// Step 1: Redirect to Google for consent
app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  });
  res.redirect(authUrl);
});

// Step 2: Handle callback from Google
app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    userTokens = tokens; 

    // Get user email
    const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
    const userInfo = await oauth2.userinfo.get();
    userEmail = userInfo.data.email;

    // Send success message to the parent window (widget)
    res.send(`
        <script>
            window.opener.postMessage({ 
                type: 'AUTH_SUCCESS', 
                isConnected: true, 
                email: '${userEmail}' 
            }, '${REDIRECT_BASE_URL}');
            window.close();
        </script>
    `);
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(500).send("Authentication failed. Please check server logs.");
  }
});

// Endpoint to check connection status
app.get("/auth/status", (req, res) => {
    const isConnected = !!userTokens.access_token;
    res.json({ isConnected: isConnected, email: userEmail });
});


// ===============================
// 4️⃣ TOOL DEFINITION (send_email)
// ===============================
const emailToolDefinition = {
  type: "function",
  function: {
    name: "send_email",
    description: "Sends an email on behalf of the user. Only use this when the user explicitly asks to send an email and provides the recipient, subject, and body.",
    parameters: {
      type: "object",
      properties: {
        recipient_email: {
          type: "string",
          description: "The full email address of the recipient, e.g., 'jane.doe@example.com'.",
        },
        subject: {
          type: "string",
          description: "The subject line of the email.",
        },
        body: {
          type: "string",
          description: "The full body content of the email, formatted as plain text.",
        },
      },
      required: ["recipient_email", "subject", "body"],
    },
  },
};

// ===============================
// 5️⃣ GMAIL EMAIL SEND ENDPOINT
// ===============================

// Helper function to create the raw email content
function createEmail(to, subject, body) {
  const email = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    body,
  ].join('\n');

  // Base64 encode the email content
  const base64EncodedEmail = Buffer.from(email).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  
  return base64EncodedEmail;
}

app.post("/email/send", async (req, res) => {
  try {
    const { recipient_email, subject, body } = req.body;

    if (!userTokens.access_token) {
      return res.status(401).json({ success: false, message: "Gmail not connected. Cannot send email." });
    }

    // Set credentials for the current request
    oauth2Client.setCredentials(userTokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    
    const rawEmail = createEmail(recipient_email, subject, body);

    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: rawEmail,
      },
    });

    res.json({ success: true, message: "✅ Email sent successfully." });
  } catch (error) {
    console.error("Email send error:", error);
    res.status(500).json({ success: false, message: "❌ Failed to send email. Check recipient address and server logs." });
  }
});


// ===============================
// 6️⃣ ASSISTLY CHATBOT ENDPOINT
// ===============================
app.post("/chat", async (req, res) => {
  try {
    // 1. Extract data sent from the client
    const { isGmailConnected, currentChat } = req.body;
    
    // 2. Define the System Instruction (updated with connection status)
    const systemInstructionContent = `You are Assistly, a helpful and knowledgeable personal AI assistant chatbot. Your primary goal is to answer user questions, summarize information, and act as a conversational partner.
    You have access to the 'send_email' tool, which you MUST only use if the user explicitly asks you to draft or send an email and provides the necessary details (recipient, subject, body).
    Current Gmail connection status: ${isGmailConnected ? 'CONNECTED' : 'NOT CONNECTED'}. If the user asks to send an email but the status is NOT CONNECTED, inform them that the tool is unavailable until they connect their Gmail.
    Format your answers cleanly with bold key points and bullet lists where relevant.`;

    // 3. Construct the Message History
    // Map the client's simple message format to the OpenAI API format (role: user/assistant, content: text)
    // The client's currentChat array contains all messages including the latest user message.
    const messages = [
        {
          role: "system",
          content: systemInstructionContent,
        },
        ...currentChat
            .filter(msg => msg.text) // Filter out any empty messages
            .map(msg => ({
                role: msg.sender === 'user' ? 'user' : 'assistant',
                content: msg.text,
            })),
    ];
    
    // 4. Construct the OpenAI API Payload
    const payload = {
      model: "gpt-4o-mini",
      messages: messages, // Now includes history!
      // Only provide the tool definition if the user is connected
      tools: isGmailConnected ? [emailToolDefinition] : undefined, 
      tool_choice: "auto", 
    };

    // 5. Call OpenAI API
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

    // 6. Handle Tool Call or Text Reply
    
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
// 7️⃣ CHAT TITLE ENDPOINT
// ===============================
app.post("/title", async (req, res) => {
  try {
    const { message } = req.body;
    
    const payload = {
        model: "gpt-3.5-turbo",
        messages: [
            {
                role: "system",
                content: "You are a professional chat summary generator. Your sole job is to create a concise, 4-5 word summary title for the user's initial message. Only output the title string.",
            },
            { role: "user", content: `Generate a short title for this message: "${message}"` },
        ],
        temperature: 0.1,
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
    const title = data.choices?.[0]?.message?.content || "New Chat";

    res.json({ title: title.trim().replace(/['"“”]/g, '') }); // Remove surrounding quotes
  } catch (error) {
    console.error("Title generation error:", error);
    res.status(500).json({ error: "Failed to generate title." });
  }
});

// ===============================
// 8️⃣ SERVER STARTUP
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});





