import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import BuildSystemPrompt from "../utils/prompt.js";
import { MCPTool, MessageContent } from "../types/mcp-sseclient.js";
import { SSEConnection } from "../types/mcp-sseclient.js";
import OpenAI from 'openai';

class MCPClient {
    private sseConnections: SSEConnection[] = [];
    private openAI: any;
    private chatHistory: MessageContent[] = [];
    private userSystemPrompt: string = "";

    constructor(
        sseUrls: URL | URL[],
        openAIBaseUrl: string = "",
        openAIApiKey: string = "",
        openAIApiModel: string = "",
        userSystemPrompt: string = ""
    ) {
        const urlArray = Array.isArray(sseUrls) ? sseUrls : [sseUrls];

        // Initialize each connection
        this.sseConnections = urlArray.map((url, index) => ({
            url,
            client: new Client({
                name: `sse-client-${index}`,
                version: '1.0.0'
            }),
            name: url.hostname // Use hostname as the default name
        }));

        this.chatHistory = []; // Initialize empty chat history

        // Store user system prompt
        this.userSystemPrompt = userSystemPrompt;

        // If OpenAI API key is provided, initialize OpenAI client
        if (openAIBaseUrl && openAIApiKey) {
            this.openAI = new OpenAI({
                apiKey: openAIApiKey,
                baseURL: openAIBaseUrl,
                dangerouslyAllowBrowser: true
            });
            this.openAI.apiModel = openAIApiModel;
        }
    }

    /**
     * Connect to all configured SSE services
     */
    async connect() {
        const connectionPromises = this.sseConnections.map(async (conn) => {
            try {
                await conn.client.connect(new SSEClientTransport(conn.url));
                console.log(`Connected to SSE service at ${conn.url}`);
                return true;
            } catch (error) {
                console.error(`Failed to connect to SSE service at ${conn.url}:`, error);
                return false;
            }
        });

        // Wait for all connections to complete
        const results = await Promise.all(connectionPromises);

        // Check if at least one connection was successful
        if (!results.some(result => result)) {
            throw new Error("Failed to connect to any SSE service");
        }

        return results;
    }

    /**
     * List all tools from connected services
     * @returns Merged list of tools, each with a source identifier
     */
    async listTools() {
        const toolsPromises = this.sseConnections.map(async (conn) => {
            try {
                const response = await conn.client.listTools();
                // Add source identifier to each tool
                const tools = response.tools.map((tool: any) => ({
                    ...tool,
                    serviceSource: conn.name || conn.url.toString()
                }));
                return tools;
            } catch (error) {
                console.error(`Failed to list tools from ${conn.url}:`, error);
                return [];
            }
        });

        // Wait for all tool list requests to complete
        const toolsArrays = await Promise.all(toolsPromises);

        // Merge all tool lists
        const allTools = toolsArrays.flat();

        return { tools: allTools };
    }

    /**
     * Clear chat history and start a new conversation
     */
    clearChatHistory(): void {
        this.chatHistory = [];
    }

    /**
     * Get the current chat history
     */
    getChatHistory(): MessageContent[] {
        return [...this.chatHistory]; // Return a copy to prevent external modification
    }

    /**
     * Process user query and interact with LLM
     * @param query The user's current query
     * @param useHistory Whether to use and update chat history, default is true
     * @returns The response from the large language model
     */
    async processQuery(query: string, useHistory: boolean = true): Promise<string> {
        if (!this.openAI) {
            throw new Error("OpenAI API key not provided. Cannot process query.");
        }

        // Get the list of tools from all services
        const response = await this.listTools();

        // Build system prompt including tools from all services
        const systemPrompt = BuildSystemPrompt(this.userSystemPrompt, response.tools as unknown as MCPTool[]);

        let messages: MessageContent[];

        if (!useHistory || this.chatHistory.length === 0) {
            // Create a new session if not using history or history is empty
            messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: query }
            ];
        } else {
            // Use existing history
            messages = [...this.chatHistory];

            // Update system prompt (if the first message is a system prompt)
            if (messages.length > 0 && messages[0].role === "system") {
                messages[0].content = systemPrompt;
            } else {
                // Add a system prompt if none exists
                messages.unshift({ role: "system", content: systemPrompt });
            }

            // Add the user's new query
            messages.push({ role: "user", content: query });
        }

        while (true) {
            console.log(`[Calling LLM with query ${JSON.stringify({
                model: this.openAI.apiModel,
                messages: messages
            })}]\n\n`);

            const completion = await this.openAI.chat.completions.create({
                model: this.openAI.apiModel,
                messages: messages as any
            });

            const assistantMessage = completion.choices[0].message.content || '';

            console.log(`[LLM response: ${assistantMessage}]\n\n`);

            // Parse tool calls
            const toolUseList = this.extractToolUses(assistantMessage);

            // Add assistant's response to message history
            messages.push({
                role: "assistant",
                content: assistantMessage
            });

            // If no tool calls, update history and return result
            if (!toolUseList || toolUseList.length === 0) {
                if (useHistory) {
                    this.chatHistory = messages; // Update instance's chat history
                }
                return assistantMessage;
            }

            console.log(`[Found ${toolUseList.length} tool uses]\n\n`);

            // Handle each tool call
            for (const toolUse of toolUseList) {
                const toolName = toolUse.name;
                const toolArgs = toolUse.arguments;

                if (!toolName) {
                    continue;
                }

                console.log(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]\n\n`);

                try {
                    // Find the client providing this tool
                    const clientForTool = await this.findClientForTool(toolName);

                    if (!clientForTool) {
                        throw new Error(`No service provides tool: ${toolName}`);
                    }

                    // Execute the tool call
                    const result = await clientForTool.callTool({
                        name: toolName,
                        arguments: toolArgs
                    });

                    // Add tool result to messages
                    messages.push({
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "Here is the result of tool call: " + toolName
                            },
                            {
                                type: "text",
                                text: JSON.stringify(result.content && Array.isArray(result.content) ?
                                    result.content[0]?.text : result)
                            }
                        ]
                    });
                } catch (error) {
                    // Log error and add error message to messages
                    const errorMessage = `Error calling tool ${toolName}: ${error}`;
                    console.log(`[${errorMessage}]\n\n`);

                    messages.push({
                        role: "user",
                        content: `The tool call to ${toolName} failed with error: ${error}`
                    });
                }
            }
        }
    }

    /**
     * Find the client providing a specific tool
     * @param toolName The name of the tool
     * @returns The client providing the tool, or null if not found
     */
    private async findClientForTool(toolName: string): Promise<Client | null> {
        for (const conn of this.sseConnections) {
            try {
                const response = await conn.client.listTools();
                const hasTool = response.tools.some((tool: any) => tool.name === toolName);
                if (hasTool) {
                    return conn.client;
                }
            } catch (error) {
                console.error(`Error checking tools in ${conn.url}:`, error);
            }
        }
        return null;
    }

    /**
     * Extract tool calls from text
     */
    extractToolUses(text: string): Array<{ name: string, arguments: any }> {
        const toolUses: Array<{ name: string, arguments: any }> = [];

        // Regular expression to match different formats of tool calls

        // Handle format 1: Standard single-line tool call
        const pattern1 = /<tool_use>\s*<name>(.*?)<\/name>\s*<arguments>(.*?)<\/arguments>\s*<\/tool_use>/gs;
        let matches = [...text.matchAll(pattern1)];

        // If no matches, try format 2
        if (matches.length === 0) {
            const pattern2 = /<tool_use>[\s\n]*<name>(.*?)<\/name>[\s\n]*<arguments>(.*?)<\/arguments>[\s\n]*<\/tool_use>/gs;
            matches = [...text.matchAll(pattern2)];
        }

        // Handle format 3: More relaxed pattern
        if (matches.length === 0) {
            const namePattern = /<name>(.*?)<\/name>/gs;
            const argsPattern = /<arguments>(.*?)<\/arguments>/gs;

            const nameMatches = [...text.matchAll(namePattern)].map(m => m[1].trim());
            const argsMatches = [...text.matchAll(argsPattern)].map(m => m[1].trim());

            if (nameMatches.length > 0 && nameMatches.length === argsMatches.length) {
                for (let i = 0; i < nameMatches.length; i++) {
                    try {
                        const args = JSON.parse(argsMatches[i]);
                        toolUses.push({
                            name: nameMatches[i],
                            arguments: args
                        });
                    } catch (e) {
                        toolUses.push({
                            name: nameMatches[i],
                            arguments: argsMatches[i]
                        });
                    }
                }
                return toolUses;
            }
        }

        // Process matches
        for (const match of matches) {
            const name = match[1].trim();
            const argsStr = match[2].trim();

            try {
                const args = JSON.parse(argsStr);
                toolUses.push({ name, arguments: args });
            } catch (e) {
                toolUses.push({ name, arguments: argsStr });
            }
        }

        return toolUses;
    }

    /**
     * Clean up all resources
     */
    async cleanup(): Promise<void> {

    }
}

export { MCPClient };