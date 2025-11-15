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
// 1️⃣ API KEY CONFIG (UPDATED FOR GEMINI)
// ===============================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
// Base URL for the Gemini API (for 2.5 Flash)
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

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
  res.json({ authUrl }); // Changed from redirect to json response for frontend to open popup
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

    // Send a message to the opener window to confirm success
    res.send(`
      <script>
        window.opener.postMessage({
          type: 'AUTH_SUCCESS',
          userId: '${req.query.state}', // Using state to pass userId from client to callback for matching
          email: '${userTokens.email}'
        }, '*');
        window.close();
      </script>
    `);
  } catch (error) {
    console.error("Authentication error:", error);
    // The error is often related to the redirect URI mismatch, which causes the token exchange to fail.
    res.status(500).send("Authentication failed. Check your logs and Google Cloud Console Redirect URIs.");
  }
});

// Step 3 (Added): Disconnect endpoint
app.post("/auth/disconnect", (req, res) => {
    // Clear the in-memory store for the user's tokens
    userTokens = {};
    res.json({ success: true, message: "Successfully disconnected." });
});


// ===============================
// 4️⃣ GMAIL STATUS CHECK ENDPOINT
// ===============================
// The frontend calls this to update the UI status.
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
app.post("/tool/execute", async (req, res) => {
    const { userId, toolCall } = req.body;
    
    if (toolCall.name !== 'send_email') {
        return res.status(400).json({ tool_result: `Error: Unknown tool ${toolCall.name} requested.` });
    }

    const { recipient_email: to, subject, body } = toolCall.args;

    if (!userTokens.access_token) {
        return res.json({ 
            tool_result: "🚫 Error: Gmail not connected. Please connect your Gmail account first to send emails."
        });
    }

    // Set credentials from stored tokens
    oauth2Client.setCredentials(userTokens);
    
    try {
        // 1. Explicitly refresh the token before use. 
        const { credentials } = await oauth2Client.refreshAccessToken(); 
        userTokens.access_token = credentials.access_token; 
        userTokens.expiry_date = credentials.expiry_date; 
        
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

        // 4. Return success message as tool result
        const toolResult = `✅ Email successfully sent to **${to}** with subject: "${subject}". The recipient is ${to}.`;
        res.json({ tool_result: toolResult });

    } catch (error) {
        console.error("Email send error:", error);
        
        // ⚠️ Check for common token failure messages 
        if (error.code === 401 || error.message.includes('invalid_grant') || error.message.includes('invalid_token')) {
            userTokens = {}; // Clear tokens to force a full re-auth
            console.log("Access token is invalid. Cleared userTokens.");
            const toolResult = "❌ Failed to send email. The Gmail connection is no longer valid. Please click 'Connect Gmail' to re-authenticate.";
            return res.json({ tool_result: toolResult });
        }

        const toolResult = `❌ Failed to send email due to a server error. Details: ${error.message}`;
        res.json({ tool_result: toolResult });
    }
});


// ===============================
// 6️⃣ ASSISTLY CHATBOT ENDPOINT (UPDATED FOR GEMINI)
// ===============================

// The function definition for the AI to use (Gemini format)
const emailToolDefinition = {
    function: {
        name: "send_email",
        description: "Sends an email to a specified recipient with a subject and body. Only use this function when the user explicitly asks to send an email.",
        parameters: {
            type: "object",
            properties: {
                recipient_email: { 
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

// Helper function to convert frontend history to Gemini-style contents
function toGeminiContent(history) {
    const contents = [];
    history.forEach(msg => {
        let role = msg.role === 'assistant' ? 'model' : msg.role;
        
        // Handle tool responses (from the loop in the frontend)
        if (msg.role === 'tool') {
            contents.push({
                role: 'tool',
                parts: [{
                    functionResponse: {
                        name: 'send_email', // Hardcoded as only one tool is available
                        response: { result: msg.content },
                    }
                }]
            });
        } 
        // Handle tool calls (which should only come from the model)
        else if (msg.role === 'assistant' && msg.tool_calls) {
            const functionCalls = msg.tool_calls.map(tc => ({
                functionCall: {
                    name: tc.function.name,
                    args: JSON.parse(tc.function.arguments) 
                }
            }));
            
            contents.push({
                role: 'model',
                parts: functionCalls
            });
        }
        // Handle regular text messages
        else if (msg.content) {
             contents.push({
                role: role,
                parts: [{ text: msg.content }]
            });
        }
    });
    return contents;
}


app.post("/chat", async (req, res) => {
  try {
    const { history, isGmailConnected } = req.body;
    
    // 1. Build the System Instruction
    const systemInstruction = 
        "You are Assistly, a helpful and knowledgeable personal AI assistant chatbot. " +
        "Format your answers cleanly with bold key points and bullet lists where relevant. " +
        "You have the ability to send emails via the `send_email` tool. " +
        (isGmailConnected 
            ? "The Gmail service is currently **connected**. Use the `send_email` tool when the user's intent is clearly to send an email."
            : "The Gmail service is currently **not connected**. If the user asks to send an email, politely inform them that they must connect their Gmail account first.")
    ;
    
    // 2. Convert history to Gemini contents format
    const contents = toGeminiContent(history);

    // 3. Build the function declarations (tools) for the Gemini API
    const functionDeclarations = isGmailConnected ? [emailToolDefinition.function] : [];

    const payload = {
      // Configuration for Gemini API
      config: {
        systemInstruction: systemInstruction,
      },
      contents: contents,
      // Tools for Gemini API
      tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
    };

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    
    // ⚠️ Check for API error response first
    if (data.error) {
        console.error("Gemini API Error:", data.error.message);
        throw new Error(data.error.message || "Gemini API returned an unknown error.");
    }
    
    const candidate = data.candidates?.[0]?.content?.parts?.[0];

    // Check if the AI decided to call a function/tool
    if (candidate && candidate.functionCall) {
      const toolCall = candidate.functionCall;
      if (toolCall.name === "send_email") {
        // Return the function call arguments directly to the frontend for execution
        return res.json({ 
            tool_call: { 
                name: "send_email", 
                // Gemini API returns args as an object, not a string, which the frontend expects
                args: toolCall.args 
            } 
        });
      }
    }

    // If no function call, return the standard text reply
    const aiResponse = candidate?.text || "No response.";
    res.json({ reply: aiResponse });

  } catch (error) {
    console.error("Chatbot error:", error.message);
    // Send a 500 error back with the error message
    res.status(500).json({ reply: `An error occurred: ${error.message}` });
  }
});


// ===============================
// 7️⃣ START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
