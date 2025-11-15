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
// 1️⃣ API KEY CONFIG (Now using Gemini)
// ===============================
// **IMPORTANT**: You must set GEMINI_API_KEY in your deployment environment variables.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Base URL for the Gemini API (using Flash model)
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

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

// Stores temporary Gmail user tokens. In a production app, use a secure database.
const tokens = {};
// Stores the Gmail user's email address.
const userEmails = {};

// ===============================
// 3️⃣ GEMINI TOOL DEFINITION
// ===============================

// Define the 'send_email' tool using the Gemini FunctionDeclaration structure (JSON Schema)
const emailToolDefinition = {
    functionDeclarations: [{
        name: "send_email",
        description: "Sends an email to a specified recipient with a subject and body. This function must be used any time the user asks to draft, send, or reply to an email.",
        parameters: {
            type: "OBJECT",
            properties: {
                to: {
                    type: "STRING",
                    description: "The email address of the recipient. Must be a valid email format.",
                },
                subject: {
                    type: "STRING",
                    description: "The subject line of the email.",
                },
                body: {
                    type: "STRING",
                    description: "The full content of the email, including salutations and sign-offs.",
                },
            },
            required: ["to", "subject", "body"],
        },
    }],
};

// ===============================
// 4️⃣ OAUTH ENDPOINTS
// ===============================

// Step 1: Redirect to Google's OAuth consent screen
app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline", // Request a refresh token for long-term access
    scope: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/userinfo.email"],
  });
  res.json({ url });
});

// Step 2: Handle the callback from Google
app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;

  try {
    const { tokens: newTokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(newTokens);
    
    // Use the access token to get the user's email
    const { data: { email } } = await google.oauth2("v2").userinfo.get({ auth: oauth2Client });

    // Store tokens and email globally (in a real app, secure these in a database)
    const sessionId = 'current_user'; // Simplification for a single-user widget
    tokens[sessionId] = newTokens;
    userEmails[sessionId] = email;
    
    // Redirect a successful message back to the client widget's origin
    const successHtml = `
      <script>
        window.opener.postMessage({ 
          type: 'GMAIL_AUTH_SUCCESS', 
          email: '${email}' 
        }, window.location.origin);
        window.close();
      </script>
    `;
    res.send(successHtml);

  } catch (error) {
    console.error("Authentication Error:", error);
    const errorHtml = `
      <script>
        window.opener.postMessage({ 
          type: 'GMAIL_AUTH_ERROR', 
          error: 'Authentication failed.' 
        }, window.location.origin);
        window.close();
      </script>
    `;
    res.status(500).send(errorHtml);
  }
});

// Check if the user is connected
app.get("/auth/status", (req, res) => {
    const sessionId = 'current_user';
    const isConnected = !!tokens[sessionId] && !!userEmails[sessionId];
    res.json({ 
        isConnected, 
        email: userEmails[sessionId] || null 
    });
});

// Disconnect/Revoke tokens
app.post("/auth/disconnect", async (req, res) => {
    const sessionId = 'current_user';
    try {
        if (tokens[sessionId]) {
            // Optional: Revoke token from Google
            await oauth2Client.revokeCredentials();
        }
        delete tokens[sessionId];
        delete userEmails[sessionId];
        res.json({ success: true, message: "Disconnected." });
    } catch (error) {
        console.error("Disconnect Error:", error);
        res.status(500).json({ success: false, message: "Failed to disconnect." });
    }
});

// ===============================
// 5️⃣ GMAIL TOOL EXECUTION
// ===============================

// Simulates the actual email sending process
async function executeSendEmailTool(to, subject, body) {
  const sessionId = 'current_user';
  const userToken = tokens[sessionId];

  if (!userToken) {
    return "Error: Gmail not connected. Please connect your Gmail account to send emails.";
  }

  try {
    // 1. Set the credentials for the current user
    oauth2Client.setCredentials(userToken);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // 2. Format the email message
    const raw = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\n');

    // Base64 encode the email content (URL-safe)
    const encodedMessage = Buffer.from(raw).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // 3. Send the email
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    return `Email successfully sent to ${to} with subject "${subject}".`;

  } catch (error) {
    console.error("GMAIL SEND ERROR:", error.message);
    return `Failed to send email. Error details: ${error.message}`;
  }
}

// ===============================
// 6️⃣ CHATBOT ENDPOINT (Gemini Integration)
// ===============================
app.post("/chat", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY environment variable not set." });
  }
    
  const { history, toolResponse } = req.body;
  const sessionId = 'current_user';
  const isGmailConnected = !!tokens[sessionId];
  
  // If the client sent a toolResponse, execute it first
  if (toolResponse && toolResponse.role === "tool") {
    try {
        // Parse the tool response from the client which contains the outcome of the user's Confirm/Cancel action
        const toolRegex = /Tool send_email executed successfully with arguments: (\{.*\})/;
        const match = toolResponse.content.match(toolRegex);
        
        let toolResult = toolResponse.content; // Use raw content for cancelled actions
        
        if (match) {
            // Only execute the Gmail API call if the user confirmed the action
            const args = JSON.parse(match[1]);
            toolResult = await executeSendEmailTool(args.to, args.subject, args.body);
        }

        // Overwrite the toolResponse content with the actual result of the execution
        toolResponse.content = toolResult;

        // The toolResponse will now be added to the contents array below for the next API call.
        // We do not need a separate fetch call here, as the response is handled below.

    } catch (error) {
        console.error("Tool Execution Error:", error);
        return res.status(500).json({ error: "Failed during tool execution." });
    }
  }

  try {
    // 1. Transform client history into Gemini contents structure
    const contents = history.map(msg => {
      // Role mapping: 'user' (user/assistant text) or 'model' (model's previous turn, including tool responses)
      const role = msg.role === 'tool' ? 'model' : 'user';

      const parts = [];
      if (msg.role === 'tool') {
        // Tool responses must be structured with functionResponse for the Gemini API
        parts.push({
            functionResponse: {
                name: 'send_email', // The name of the tool that was executed
                response: {
                    content: msg.content // The result of the tool's execution
                }
            }
        });
      } else {
        // Standard text part
        parts.push({ text: msg.content });
      }

      return { role, parts };
    });

    // 2. Construct the Gemini payload
    const payload = {
        contents: contents,
        config: {
            systemInstruction: {
                parts: [{ text: "You are Assistly, a helpful and efficient assistant with access to the user's Gmail. Use the 'send_email' tool to draft and send emails when the user explicitly asks to do so. Otherwise, provide concise, helpful text responses. If you recommend an email, present the function call immediately and do not provide any preceding or subsequent text, unless the user cancelled the tool. If the user cancels the tool, respond to the cancellation appropriately." }]
            },
            // Include tool definition only if Gmail is connected
            tools: isGmailConnected ? [emailToolDefinition] : undefined,
        }
    };

    // 3. Call the Gemini API
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    const candidate = data.candidates?.[0];

    // Check for API errors or safety blocks
    if (!candidate || data.error) {
        console.error("Gemini API Error Response:", data);
        const errorMsg = data.error?.message || "Gemini API returned no candidates or an unknown error.";
        throw new Error(errorMsg);
    }

    // 4. Check if the AI decided to call a function/tool
    if (candidate.functionCalls && candidate.functionCalls.length > 0) {
      const toolCall = candidate.functionCalls[0];
      if (toolCall.name === "send_email") {
        const args = toolCall.args;
        // Return the function call arguments directly to the frontend for confirmation
        return res.json({ tool_call: { name: "send_email", args: args } });
      }
    }

    // 5. If no function call, return the standard text reply
    const aiResponse = candidate.content?.parts?.[0]?.text || "No response.";
    res.json({ reply: aiResponse });

  } catch (error) {
    console.error("Chatbot error:", error);
    res.status(500).json({ error: `Failed to connect to AI service: ${error.message}` });
  }
});

// ===============================
// 7️⃣ START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
