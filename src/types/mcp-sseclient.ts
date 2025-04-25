import { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface MCPToolInputSchema {
    type: string
    title: string
    description?: string
    required?: string[]
    properties: Record<string, object>
}

export interface MCPTool {
    id: string
    serverId: string
    serverName: string
    name: string
    description?: string
    inputSchema: MCPToolInputSchema
}

export type MessageContent<T = string | Array<{ type: string, text: string }>> = {
    role: "system" | "user" | "assistant";
    content: T;
};

export interface SSEConnection {
    url: URL;
    client: Client;
    name?: string;
}