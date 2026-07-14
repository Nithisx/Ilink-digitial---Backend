import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";

const app = express();
// Automatically parse JSON request bodies (important for incoming POST requests)
app.use(express.json()); 

// Middleware to handle JSON parsing errors gracefully and log them
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error(`[Express] JSON parsing error:`, err.message);
    return res.status(400).json({ error: 'Invalid JSON request body' });
  }
  next();
});

const port = process.env.PORT || 3000;

// 1. Helper function to create a new MCP Server instance per connection
function createMcpServer() {
  const mcpServer = new Server(
    { name: "tavily-search-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Define the tool
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

  // Handle execution logic
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

  return mcpServer;
}

// --- HTTP ENDPOINTS FOR CLOUD HOSTING ---

// Store active transports mapped by sessionId to handle multiple client sessions correctly
const transports = new Map();

// Endpoint 1: The Agent Builder connects via GET to establish the connection stream
app.get("/sse", async (req, res) => {
  console.log(`[SSE GET] New connection request from ${req.ip}`);
  console.log(`[SSE GET] Request Headers:`, JSON.stringify(req.headers, null, 2));

  try {
    const mcpServer = createMcpServer();
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    
    transports.set(sessionId, transport);
    console.log(`[SSE GET] Created transport session: ${sessionId}`);

    transport.onclose = () => {
      console.log(`[SSE] Transport session closed: ${sessionId}`);
      transports.delete(sessionId);
    };

    transport.onerror = (error) => {
      console.error(`[SSE] Transport session error for ${sessionId}:`, error);
    };

    await mcpServer.connect(transport);
    console.log(`[SSE GET] Connected MCP server to transport session: ${sessionId}`);
  } catch (error) {
    console.error("[SSE GET] Failed to establish SSE transport connection:", error);
    if (!res.headersSent) {
      res.status(500).send("Failed to establish SSE connection");
    }
  }
});

// Endpoint 2: The Agent Builder sends request commands via POST
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  console.log(`[POST Message] Received message request for sessionId: ${sessionId}`);
  console.log(`[POST Message] Request body:`, JSON.stringify(req.body, null, 2));

  if (!sessionId) {
    console.warn(`[POST Message] Missing sessionId in query parameters`);
    res.status(400).send("Missing sessionId query parameter");
    return;
  }

  const transport = transports.get(sessionId);
  if (transport) {
    try {
      // Forward the parsed request body to the correct transport instance
      await transport.handlePostMessage(req, res, req.body);
      console.log(`[POST Message] Successfully processed message for sessionId: ${sessionId}`);
    } catch (error) {
      console.error(`[POST Message] Error handling message for sessionId ${sessionId}:`, error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error handling message");
      }
    }
  } else {
    console.warn(`[POST Message] Active transport not found for sessionId: ${sessionId}`);
    res.status(400).send(`No active SSE session found for sessionId: ${sessionId}`);
  }
});

app.get('/health', (req, res) => {
  res.status(200).send('Server is running 2');
});

app.listen(port, () => {
  console.log(`Server live on port ${port}`);
});