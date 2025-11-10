<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Assistly Chatbot</title>
  <style>
    :root {
      --bg-dark: #0f172a;
      --bg-light: #1e293b;
      --accent: #22d3ee;
      --text: #f1f5f9;
      --bot-bg: #1e293b;
      --user-bg: #334155;
      --green: #4ade80;
    }

    body {
      margin: 0;
      font-family: "Inter", sans-serif;
      background-color: var(--bg-dark);
      color: var(--text);
      display: flex;
      height: 100vh;
      overflow: hidden;
    }

    /* Sidebar */
    #sidebar {
      width: 260px;
      background: var(--bg-light);
      padding: 16px;
      display: flex;
      flex-direction: column;
      transition: transform 0.3s ease;
    }

    #sidebar.hidden {
      transform: translateX(-100%);
    }

    #sidebar h2 {
      margin-top: 0;
      color: var(--accent);
      text-align: center;
    }

    #chat-list {
      flex: 1;
      overflow-y: auto;
    }

    .chat-item {
      background: #334155;
      margin: 8px 0;
      padding: 12px;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: relative;
      transition: background 0.2s ease;
    }

    .chat-item:hover {
      background: #475569;
    }

    .chat-item span {
      flex: 1;
      cursor: pointer;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-right: 6px;
    }

    .menu-btn {
      background: none;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 18px;
      padding: 4px;
    }

    .dropdown {
      position: absolute;
      top: 40px;
      right: 10px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      display: none;
      flex-direction: column;
      z-index: 10;
      min-width: 140px;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.4);
    }

    .dropdown button {
      background: none;
      border: none;
      color: #f1f5f9;
      text-align: left;
      padding: 10px;
      cursor: pointer;
      font-size: 14px;
    }

    .dropdown button:hover {
      background: #334155;
    }

    /* Chat area */
    #chat-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: var(--bg-dark);
      position: relative;
    }

    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
    }

    .message {
      margin: 10px 0;
      padding: 14px 18px;
      border-radius: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
    }

    .user {
      background: var(--user-bg);
      align-self: flex-end;
    }

    .bot {
      background: var(--bot-bg);
      align-self: flex-start;
    }

    /* Typing dots */
    .typing {
      display: inline-flex;
      gap: 4px;
    }

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      animation: blink 1.4s infinite both;
    }

    .dot:nth-child(2) {
      animation-delay: 0.2s;
    }

    .dot:nth-child(3) {
      animation-delay: 0.4s;
    }

    @keyframes blink {
      0%, 80%, 100% { opacity: 0; }
      40% { opacity: 1; }
    }

    /* Input area */
    #input-area {
      display: flex;
      padding: 16px;
      border-top: 1px solid #334155;
      background: var(--bg-light);
    }

    #user-input {
      flex: 1;
      padding: 12px;
      border: none;
      border-radius: 8px;
      background: #334155;
      color: var(--text);
    }

    #send-btn {
      margin-left: 8px;
      background: var(--accent);
      border: none;
      border-radius: 8px;
      padding: 0 18px;
      cursor: pointer;
      color: var(--bg-dark);
      font-weight: bold;
    }

    /* Gmail button */
    #connect-gmail {
      background: #ea4335;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 10px 16px;
      cursor: pointer;
      margin: 8px 0;
      font-weight: 600;
      transition: 0.2s;
    }

    #connect-gmail:hover {
      background: #d93025;
    }

    /* Mobile overlay */
    #overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 5;
    }

    @media (max-width: 768px) {
      #sidebar {
        position: fixed;
        top: 0;
        bottom: 0;
        left: 0;
        z-index: 10;
      }
      #overlay {
        display: block;
      }
      #menu-toggle {
        display: block;
      }
    }

    #menu-toggle {
      display: none;
      position: absolute;
      top: 16px;
      left: 16px;
      background: none;
      border: none;
      font-size: 24px;
      color: var(--text);
      z-index: 20;
    }
  </style>
</head>
<body>
  <div id="overlay" class="hidden"></div>

  <aside id="sidebar">
    <h2>Assistly</h2>
    <button id="connect-gmail">📧 Connect Gmail</button>
    <div id="chat-list"></div>
    <button id="new-chat">+ New Chat</button>
  </aside>

  <button id="menu-toggle">☰</button>

  <main id="chat-container">
    <div id="messages"></div>
    <div id="input-area">
      <input type="text" id="user-input" placeholder="Type your message..." />
      <button id="send-btn">Send</button>
    </div>
  </main>

  <script>
    const messagesDiv = document.getElementById("messages");
    const userInput = document.getElementById("user-input");
    const sendBtn = document.getElementById("send-btn");
    const chatList = document.getElementById("chat-list");
    const newChatBtn = document.getElementById("new-chat");
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("overlay");
    const menuToggle = document.getElementById("menu-toggle");
    const connectGmailBtn = document.getElementById("connect-gmail");

    let chats = JSON.parse(localStorage.getItem("assistlyChats")) || {};
    let currentChatId = Object.keys(chats)[0] || createNewChat();

    renderChatList();
    loadChat(currentChatId);

    connectGmailBtn.onclick = () => {
      alert("Gmail connection feature coming soon!");
    };

    function createNewChat() {
      const id = Date.now().toString();
      chats[id] = { name: "New Chat", messages: [] };
      localStorage.setItem("assistlyChats", JSON.stringify(chats));
      renderChatList();
      return id;
    }

    function renderChatList() {
      chatList.innerHTML = "";
      Object.keys(chats).forEach((id) => {
        const div = document.createElement("div");
        div.className = "chat-item";
        const title = document.createElement("span");
        title.textContent = chats[id].name || "New Chat";
        title.onclick = () => {
          currentChatId = id;
          loadChat(id);
        };

        const menuBtn = document.createElement("button");
        menuBtn.className = "menu-btn";
        menuBtn.textContent = "⋮";

        const dropdown = document.createElement("div");
        dropdown.className = "dropdown";

        const clearBtn = document.createElement("button");
        clearBtn.textContent = "🧹 Clear Chat";
        clearBtn.onclick = () => {
          chats[id].messages = [];
          localStorage.setItem("assistlyChats", JSON.stringify(chats));
          if (currentChatId === id) loadChat(id);
          dropdown.style.display = "none";
        };

        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "🗑 Delete Chat";
        deleteBtn.onclick = () => {
          delete chats[id];
          localStorage.setItem("assistlyChats", JSON.stringify(chats));
          renderChatList();
          if (Object.keys(chats).length === 0) {
            currentChatId = createNewChat();
          } else {
            currentChatId = Object.keys(chats)[0];
            loadChat(currentChatId);
          }
        };

        dropdown.append(clearBtn, deleteBtn);
        div.append(title, menuBtn, dropdown);
        chatList.appendChild(div);

        menuBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          document.querySelectorAll(".dropdown").forEach((d) => (d.style.display = "none"));
          dropdown.style.display = "flex";
        });
      });

      document.addEventListener("click", () => {
        document.querySelectorAll(".dropdown").forEach((d) => (d.style.display = "none"));
      });
    }

    function loadChat(id) {
      messagesDiv.innerHTML = "";
      chats[id].messages.forEach((msg) => addMessage(msg.text, msg.sender));
    }

    function addMessage(text, sender) {
      const div = document.createElement("div");
      div.className = `message ${sender}`;

      const formatted = text
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/^- (.*?)$/gm, "• $1");

      div.innerHTML = formatted;
      messagesDiv.appendChild(div);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    async function sendMessage() {
      const text = userInput.value.trim();
      if (!text) return;

      addMessage(text, "user");
      chats[currentChatId].messages.push({ text, sender: "user" });
      userInput.value = "";

      const typingDiv = document.createElement("div");
      typingDiv.className = "message bot";
      typingDiv.innerHTML = `<div class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
      messagesDiv.appendChild(typingDiv);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;

      try {
        const response = await fetch("https://art-chatbot.onrender.com/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        const data = await response.json();

        typingDiv.remove();
        addMessage(data.reply, "bot");
        chats[currentChatId].messages.push({ text: data.reply, sender: "bot" });

        // 🧠 Generate chat title based on first user message
        if (chats[currentChatId].name === "New Chat" && chats[currentChatId].messages.length === 2) {
          const titleRes = await fetch("https://art-chatbot.onrender.com/title", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: text }),
          });
          const titleData = await titleRes.json();
          chats[currentChatId].name = titleData.title || text.slice(0, 30);
          renderChatList();
        }

        localStorage.setItem("assistlyChats", JSON.stringify(chats));
      } catch (err) {
        typingDiv.remove();
        addMessage("⚠️ Error connecting to Assistly.", "bot");
      }
    }

    sendBtn.onclick = sendMessage;
    userInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") sendMessage();
    });

    newChatBtn.onclick = () => {
      currentChatId = createNewChat();
      loadChat(currentChatId);
    };

    menuToggle.onclick = () => {
      sidebar.classList.toggle("hidden");
      overlay.classList.toggle("hidden");
    };

    overlay.onclick = () => {
      sidebar.classList.add("hidden");
      overlay.classList.add("hidden");
    };
  </script>
</body>
</html>








