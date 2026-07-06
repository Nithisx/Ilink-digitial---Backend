import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";

const app = express();
// Automatically parse JSON request bodies (important for incoming POST requests)
app.use(express.json()); 

const port = process.env.PORT || 3000;

// 1. Initialize the MCP Server instance
const mcpServer = new Server(
  { name: "tavily-search-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// 2. Define the tool (FIXED: Added ListToolsRequestSchema)
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_tool",
        description: "Searches the web using Tavily API.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query." }
          },
          required: ["query"]
        }
      }
    ]
  };
});

// 3. Handle execution logic (FIXED: Added CallToolRequestSchema)
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "search_tool") {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return { isError: true, content: [{ type: "text", text: "Missing API key." }] };
    }

    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query: args.query,
          topic: "general",
          search_depth: "basic"
        })
      });
      const data = await response.json();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }
  throw new Error("Tool not found");
});

// --- HTTP ENDPOINTS FOR CLOUD HOSTING ---
let sseTransport = null;

// Endpoint 1: The Agent Builder connects via GET to establish the connection stream
app.get("/sse", async (req, res) => {
  sseTransport = new SSEServerTransport("/messages", res);
  await mcpServer.connect(sseTransport);
});

// Endpoint 2: The Agent Builder sends request commands via POST
app.post("/messages", async (req, res) => {
  if (sseTransport) {
    await sseTransport.handleMessage(req, res);
  } else {
    res.status(400).send("No active SSE session");
  }
});

app.listen(port, () => {
  console.log(`Server live on port ${port}`);
});