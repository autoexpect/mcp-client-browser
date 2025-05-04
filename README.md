
# MCP-CLIENT-BROSWER

**mcp-client-browser** is a TypeScript library that brings MCP (Model Control Protocol) support to the browser. It enables seamless interaction with large language models (LLMs) through an MCP server, leveraging [Cherry Studio](https://github.com/CherryHQ/cherry-studio)'s prompt templates and communication logic.

## ✨ Features

- 🌐 Runs entirely in the browser (no backend required)
- ⚡ Communicates with MCP-compatible servers
- 🧠 Built-in support for Cherry Studio's MCP prompt format
- 🛠️ Simple, extendable, and TypeScript-friendly API
- 📦 Designed for easy integration into modern web apps

## 🚀 Getting Started

### Installation

```bash
npm i @autoexpect/mcp-sseclient-browser
```

### Usage

```javascript
let mcpClient = new MCPClient(
  [
    {
      url: new URL('/api/mcps/sse', window.location.origin)
    }
  ],
  {
    baseUrl: window.location.origin + "/v1",
    apiKey: "sk-default",
    model: "deepseek-v3",
  }
);
await mcpClient.connect();
await mcpClient.processQueryStream(
  "System Prompt",
  "User Prompt",
  true,
  (chunk) => {
  },
  (fullResponse) => {
  }
);
```

> ✅ Make sure your MCP server supports CORS and the Cherry prompt specification.

## 💡 Use Cases

- AI chatbots powered by LLMs directly in the browser
- Embedding customizable prompt workflows into frontend apps
- Creating interactive educational or creative writing tools

## 🧩 Integrations

- [Cherry Studio](https://github.com/CherryHQ/cherry-studio): Easily plug in Cherry-style prompt templates
- Compatible with most OpenAI-compatible or custom MCP servers

## 🛡️ Security & Privacy

This library does **not** store user data. All interactions happen directly between the browser and the configured MCP server.

## 📄 License

MIT License