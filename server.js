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

// ⚠️ Temporary in-memory token storage (use DB for multiple users)
let userTokens = {}; // key: email, value: tokens

// ===============================
// 3️⃣ GMAIL AUTH ROUTES
// ===============================

// Utility function to get the current user's email
async function getUserEmail(tokens) {
  if (!tokens || !tokens.access_token) return null;
  
  const userInfoClient = new google.auth.OAuth2();
  userInfoClient.setCredentials(tokens);
  
  const people = google.people({ version: 'v1', auth: userInfoClient });
  try {
    const res = await people.people.get({
      resourceName: 'people/me',
      personFields: 'emailAddresses',
    });
    return res.data.emailAddresses[0].value;
  } catch (error) {
    console.error("Error fetching user email:", error);
    return null;
  }
}

// Step 1: Redirect to Google for consent
app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    prompt: "consent", // Force refresh token
  });
  res.redirect(authUrl);
});

// Step 2: Handle callback and exchange code for tokens
app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    // Get the user's email to use as the storage key
    const email = await getUserEmail(tokens);

    if (email) {
        userTokens[email] = tokens;
        console.log(`Tokens stored for ${email}.`);
        
        // Respond to the client window with success message
        res.send(`
            <script>
                // Send a message back to the originating window (the widget)
                window.opener.postMessage({ 
                    type: 'AUTH_SUCCESS', 
                    isConnected: true, 
                    email: '${email}' 
                }, '*'); // Replace '*' with the widget's actual origin in production
                window.close();
            </script>
        `);
    } else {
        throw new Error("Could not retrieve user email.");
    }
  } catch (error) {
    console.error("Error during authentication callback:", error);
    res.status(500).send("Authentication failed. Please check server logs.");
  }
});

// Endpoint to check connection status (for widget load)
app.get("/auth/status", async (req, res) => {
    // In a single-user demo, we just check if we have any tokens stored.
    // In a multi-user app, you would check tokens based on a session ID.
    const emails = Object.keys(userTokens);
    if (emails.length > 0) {
        const email = emails[0];
        // Optional: check if the token is still valid (not implemented here)
        return res.json({ isConnected: true, email: email });
    }
    res.json({ isConnected: false, email: "" });
});


// ===============================
// 4️⃣ GMAIL API (TOOL EXECUTION)
// ===============================

// Utility function to send the email
async function sendGmail(recipient_email, subject, body, senderEmail) {
    const tokens = userTokens[senderEmail];
    if (!tokens) {
        throw new Error("User tokens not found. Please connect Gmail.");
    }

    // Set credentials for the current user
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Construct the email message
    const raw = [
        `To: ${recipient_email}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'MIME-Version: 1.0',
        '',
        body,
    ].join('\n');

    const encodedMessage = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    // Send the email
    const result = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
            raw: encodedMessage,
        },
    });

    return result.data;
}

// Endpoint called by the widget to execute the email send
app.post("/email/send", async (req, res) => {
  try {
    const { recipient_email, subject, body } = req.body;
    
    // In a real app, the sender email would come from session data
    const senderEmail = Object.keys(userTokens)[0]; 

    if (!senderEmail) {
        return res.status(401).json({ success: false, message: "❌ Gmail not connected. Cannot send email." });
    }
    
    // Execute the send
    const result = await sendGmail(recipient_email, subject, body, senderEmail);
    
    console.log("Email sent successfully:", result);
    res.json({ success: true, message: "✅ Email sent successfully." });
  } catch (error) {
    console.error("Email send error:", error);
    // Try to provide a more specific error if possible
    let errorMessage = "❌ Failed to send email.";
    if (error.code === 401) {
        errorMessage += " (Authentication required or token expired.)";
    }
    res.status(500).json({ success: false, message: errorMessage });
  }
});


// ===============================
// 5️⃣ AI TOOL DEFINITION
// ===============================
const emailToolDefinition = {
  type: "function",
  function: {
    name: "send_email",
    description: "Sends an email to a specified recipient with a subject and plain text body. Use this when the user explicitly asks to draft or send an email.",
    parameters: {
      type: "object",
      properties: {
        recipient_email: {
          type: "string",
          description: "The complete email address of the recipient (e.g., jane.doe@example.com).",
        },
        subject: {
          type: "string",
          description: "The subject line of the email.",
        },
        body: {
          type: "string",
          description: "The plain text body content of the email. Do not include HTML.",
        },
      },
      required: ["recipient_email", "subject", "body"],
    },
  },
};

// ===============================
// 6️⃣ ASSISTLY CHATBOT ENDPOINT
// ===============================
app.post("/chat", async (req, res) => {
  try {
    // ⚠️ FIX: Destructure the correct properties from the body
    const { currentChat, isGmailConnected } = req.body; 

    if (!currentChat || currentChat.length === 0) {
        return res.status(400).json({ error: "Missing chat history." });
    }

    // ⚠️ FIX: Construct the message history array in OpenAI format
    const formattedHistory = currentChat.map(msg => ({
        // Map 'user' to 'user' role, and 'bot' to 'assistant' role
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.text,
    }));
    
    // System instruction is always first
    const systemInstruction = {
        role: "system",
        content: `You are Assistly, a helpful and knowledgeable personal AI assistant chatbot. Format your answers cleanly with bold key points and bullet lists where relevant.
        ${isGmailConnected ? 'The user is currently connected to their Gmail account. Use the `send_email` tool when they ask to draft or send a new email.' : 'The user is NOT connected to their Gmail account. Do not offer or use the `send_email` tool.'}`,
    };
    
    // Construct the final payload for OpenAI
    const payload = {
      model: "gpt-4o-mini",
      messages: [systemInstruction, ...formattedHistory], // Use the full history
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

    // Check for OpenAI API errors (e.g., invalid key, rate limit)
    if (data.error) {
        console.error("OpenAI API Error:", data.error);
        return res.status(502).json({ error: data.error.message || "OpenAI API returned an error." });
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
    const aiResponse = candidate?.content || "No response. (AI content missing)";
    res.json({ reply: aiResponse });

  } catch (error) {
    console.log("Request Body:", req.body); // Log request body for debugging
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
        const prompt = `Based on this first message from a user, generate a very brief, title-case summary (max 5 words, no punctuation) that can be used as a chat title. Example: 'Help with my project' -> 'Project Assistance'. Message: "${message}"`;
        
        const response = await fetch(OPENAI_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
            }),
        });

        const data = await response.json();
        const title = data.choices?.[0]?.message?.content?.trim() || "New Chat";

        res.json({ title: title.replace(/['".]/g, '') }); // Clean up punctuation
    } catch (error) {
        console.error("Title generation error:", error);
        res.status(500).json({ error: "Failed to generate title." });
    }
});


// ===============================
// 8️⃣ START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Frontend URL for OAuth: http://localhost:3000`);
});





