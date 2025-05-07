import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import BuildSystemPrompt from "../utils/prompt.js";
import { MCPTool, MessageContent } from "../types/mcp-sseclient";
import { SSEConnection } from "../types/mcp-sseclient";
import OpenAI from 'openai';

class MCPClient {
    private openAI: any;

    private chatHistory: MessageContent[] = [];
    private mcpConnections: SSEConnection[] = [];

    constructor(
        // Accept an object or array of objects with URL and custom headers
        mcpUrls: (URL | { url: URL, headers?: Record<string, string>, name?: string }) | (URL | { url: URL, headers?: Record<string, string>, name?: string })[],
        openAIConfig?: {
            baseUrl?: string,
            apiKey?: string,
            model?: string,
        }
    ) {
        // Handle single URL/config object or array
        const urlConfigArray = Array.isArray(mcpUrls) ? mcpUrls : [mcpUrls];

        // Convert different input formats to unified connection configuration array
        this.mcpConnections = urlConfigArray.map((item, index) => {
            if (item instanceof URL) {
                // If it's a direct URL object
                return {
                    url: item,
                    client: new Client({
                        name: `sse-client-${index}`,
                        version: '1.0.0'
                    }),
                    name: item.hostname // Use hostname as default name
                };
            } else {
                // If it's a configuration object
                return {
                    url: item.url,
                    headers: item.headers || {}, // Store custom headers
                    client: new Client({
                        name: `sse-client-${index}`,
                        version: '1.0.0'
                    }),
                    name: item.name || item.url.hostname // Use provided name or default to hostname
                };
            }
        });

        this.chatHistory = []; // Initialize empty chat history

        // Initialize OpenAI client if API key is provided
        if (openAIConfig?.baseUrl && openAIConfig?.apiKey) {
            this.openAI = new OpenAI({
                apiKey: openAIConfig.apiKey,
                baseURL: openAIConfig.baseUrl,
                dangerouslyAllowBrowser: true
            });
            this.openAI.apiModel = openAIConfig.model || "gpt-3.5-turbo";
        }
    }
    /**
     * Connect to all configured SSE services
     * @returns Results of connection attempts
     */
    async connect() {
        const connectionPromises = this.mcpConnections.map(async (conn) => {
            try {
                // Create SSEClientTransport instance with custom HTTP headers
                const transport = new SSEClientTransport(conn.url, {
                    requestInit: {
                        headers: conn.headers || {}
                    }
                });
                await conn.client.connect(transport);
                return true;
            } catch (error) {
                console.error(`Failed to connect to SSE service at ${conn.url}:`, error);
                return false;
            }
        });

        // Wait for all connections to complete
        const results = await Promise.all(connectionPromises);

        // Check if at least one connection succeeded
        if (!results.some(result => result)) {
            throw new Error("Failed to connect to any SSE service");
        }

        return results;
    }

    /**
     * List all tools from connected services
     * @returns Merged list of tools, each with source service identification
     */
    async listTools() {
        const toolsPromises = this.mcpConnections.map(async (conn) => {
            try {
                const response = await conn.client.listTools();
                // Add source identification for each tool
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
     * Clear chat history to start a new conversation
     */
    clearChatHistory(): void {
        this.chatHistory = [];
    }

    /**
     * Get current chat history
     */
    getChatHistory(): MessageContent[] {
        return [...this.chatHistory]; // Return a copy to prevent external modification
    }

    /**
     * Process user query and interact with LLM
     * @param query User's current query
     * @param useHistory Whether to use and update chat history, defaults to true
     * @param maxTokens Maximum number of tokens to generate in the completion
     * @param topP Nucleus sampling parameter (0.0 to 1.0)
     * @param temperature Sampling temperature (0.0 to 2.0)
     * @returns Response from the language model
     */
    async processQuery(
        userSystemPrompt: string,
        query: string,
        useHistory: boolean = true,
        maxTokens?: number,
        topP?: number,
        temperature?: number
    ): Promise<string> {
        if (!this.openAI) {
            throw new Error("OpenAI API key not provided. Cannot process query.");
        }

        // User system prompt
        userSystemPrompt = userSystemPrompt || "";

        // Get tool list from all services
        const response = await this.listTools();

        // Build system prompt with tools from all services
        const systemPrompt = BuildSystemPrompt(userSystemPrompt, response.tools as unknown as MCPTool[]);

        let messages: MessageContent[];

        if (!useHistory || this.chatHistory.length === 0) {
            // Create new session if not using history or history is empty
            messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: query }
            ];
        } else {
            // Use existing history
            messages = [...this.chatHistory];

            // Update system prompt (if first message is system prompt)
            if (messages.length > 0 && messages[0].role === "system") {
                messages[0].content = systemPrompt;
            } else {
                // Add system prompt if not present
                messages.unshift({ role: "system", content: systemPrompt });
            }

            // Add user's new query
            messages.push({ role: "user", content: query });
        }

        while (true) {
            // console.log(`[Calling LLM with query ${JSON.stringify({
            //     model: this.openAI.apiModel,
            //     messages: messages
            // })}]\n\n`);

            const completion = await this.openAI.chat.completions.create({
                model: this.openAI.apiModel,
                messages: messages as any,
                max_tokens: maxTokens,
                top_p: topP,
                temperature: temperature,
                tools: [],
            });

            const assistantMessage = completion.choices[0].message.content || '';

            // console.log(`[LLM response: ${assistantMessage}]\n\n`);

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
                    this.chatHistory = messages; // Update instance chat history
                }
                return assistantMessage;
            }

            // console.log(`[Found ${toolUseList.length} tool uses]\n\n`);

            // Process each tool call
            for (const toolUse of toolUseList) {
                const toolName = toolUse.name;
                const toolArgs = toolUse.arguments;

                if (!toolName) {
                    continue;
                }

                // console.log(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]\n\n`);

                try {
                    // Find client that provides this tool
                    const clientForTool = await this.findClientForTool(toolName);

                    if (!clientForTool) {
                        throw new Error(`No service provides tool: ${toolName}`);
                    }

                    // Execute tool call
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
                                    result.content[0]?.text : result) + "\n\n"
                            }
                        ]
                    });
                } catch (error) {
                    // Log error and add error message to messages
                    console.log(`[Error calling tool ${toolName}: ${error}]\n\n`);

                    messages.push({
                        role: "user",
                        content: `The tool call to ${toolName} failed with error: ${error}`
                    });
                }
            }
        }
    }

    /**
     * Process user query and interact with LLM in streaming mode
     * @param query User's current query
     * @param useHistory Whether to use and update chat history, defaults to true
     * @param onChunk Callback function to receive each text chunk
     * @param maxTokens Maximum number of tokens to generate in the completion
     * @param topP Nucleus sampling parameter (0.0 to 1.0)
     * @param temperature Sampling temperature (0.0 to 2.0)
     * @returns Complete response from the language model
    */
    async processQueryStream(
        userSystemPrompt: string,
        query: string,
        useHistory: boolean = true,
        onChunk: (chunk: string) => void,
        maxTokens?: number,
        topP?: number,
        temperature?: number
    ): Promise<string> {
        if (!this.openAI) {
            throw new Error("OpenAI API key not provided. Cannot process query.");
        }

        // User system prompt
        userSystemPrompt = userSystemPrompt || "";

        // Get tool list from all services
        const response = await this.listTools();

        // Build system prompt with tools from all services
        const systemPrompt = BuildSystemPrompt(userSystemPrompt, response.tools as unknown as MCPTool[]);

        // console.log(`[System prompt: ${systemPrompt}]\n\n`);

        let messages: MessageContent[];

        if (!useHistory || this.chatHistory.length === 0) {
            // Create new session if not using history or history is empty
            messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: query }
            ];
        } else {
            // Use existing history
            messages = [...this.chatHistory];

            // Update system prompt (if first message is system prompt)
            if (messages.length > 0 && messages[0].role === "system") {
                messages[0].content = systemPrompt;
            } else {
                // Add system prompt if not present
                messages.unshift({ role: "system", content: systemPrompt });
            }

            // Add user's new query
            messages.push({ role: "user", content: query });
        }

        let fullResponse = '';
        let currentAssistantMessage = '';

        while (true) {
            // console.log(`[Calling LLM with query ${JSON.stringify({
            //     model: this.openAI.apiModel,
            //     messages: messages,
            //     stream: true
            // })}]\n\n`);

            // Use OpenAI SDK's streaming API
            currentAssistantMessage = '';
            const stream = await this.openAI.chat.completions.create({
                model: this.openAI.apiModel,
                messages: messages as any,
                stream: true,
                max_tokens: maxTokens,
                top_p: topP,
                temperature: temperature,
                tools: [],
            });

            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || '';
                if (content) {
                    currentAssistantMessage += content;
                    onChunk(content); // Pass each chunk to callback
                }
            }

            // console.log(`[LLM stream response completed: ${currentAssistantMessage}]\n\n`);

            // Add assistant's response to message history
            messages.push({
                role: "assistant",
                content: currentAssistantMessage
            });

            // Parse tool calls
            const toolUseList = this.extractToolUses(currentAssistantMessage);

            // If no tool calls, update history and return result
            if (!toolUseList || toolUseList.length === 0) {
                if (useHistory) {
                    this.chatHistory = messages; // Update instance chat history
                }
                fullResponse = currentAssistantMessage;
                return fullResponse;
            }

            // console.log(`[Found ${toolUseList.length} tool uses]\n\n`);

            // Process each tool call
            for (const toolUse of toolUseList) {
                const toolName = toolUse.name;
                const toolArgs = toolUse.arguments;

                if (!toolName) {
                    continue;
                }

                // console.log(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]\n\n`);

                try {
                    // Find client that provides this tool
                    const clientForTool = await this.findClientForTool(toolName);

                    if (!clientForTool) {
                        throw new Error(`No service provides tool: ${toolName}`);
                    }

                    // Execute tool call
                    const result = await clientForTool.callTool({
                        name: toolName,
                        arguments: toolArgs
                    });

                    // Add tool result to messages
                    const resultMessage: MessageContent = {
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
                    };
                    messages.push(resultMessage);

                    // Notify user that tool call is completed
                    const toolCallInfo = "\n\n```json\n" + JSON.stringify(resultMessage) + "\n```\n\n";
                    onChunk(toolCallInfo);
                    // fullResponse += toolCallInfo;

                } catch (error) {
                    // Log error and add error message to messages
                    console.log(`[Error calling tool ${toolName}: ${error}]\n\n`);

                    messages.push({
                        role: "user",
                        content: `The tool call to ${toolName} failed with error: ${error}`
                    });

                    // Notify user of tool call failure
                    const errorInfo = "\n\n```json\n" + JSON.stringify({
                        role: "user",
                        content: `The tool call to ${toolName} failed with error: ${error}`
                    }) + "\n```\n\n";
                    onChunk(errorInfo);
                    fullResponse += errorInfo;
                }
            }
        }
    }

    /**
     * Find a client that provides the specified tool
     * @param toolName Tool name
     * @returns Client that provides the tool, or null if not found
     */
    private async findClientForTool(toolName: string): Promise<Client | null> {
        for (const conn of this.mcpConnections) {
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

        // Regular expressions to match different tool call formats

        // Format 1: Standard single-line tool calls
        const pattern1 = /<tool_use>\s*<name>(.*?)<\/name>\s*<arguments>(.*?)<\/arguments>\s*<\/tool_use>/gs;
        let matches = [...text.matchAll(pattern1)];

        // If no matches, try format 2
        if (matches.length === 0) {
            const pattern2 = /<tool_use>[\s\n]*<name>(.*?)<\/name>[\s\n]*<arguments>(.*?)<\/arguments>[\s\n]*<\/tool_use>/gs;
            matches = [...text.matchAll(pattern2)];
        }

        // Format 3: More lenient pattern
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
        const disconnectionPromises = this.mcpConnections.map(async (conn) => {
            try {
                if (conn.client) {
                    await conn.client.close();
                }
                return true;
            } catch (error) {
                console.error(`Error disconnecting from ${conn.name || conn.url.toString()}:`, error);
                return false;
            }
        });

        await Promise.all(disconnectionPromises);

        this.chatHistory = [];

        if (this.openAI) {
            this.openAI = null;
        }
    }

}

export { MCPClient };