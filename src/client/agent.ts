// @ts-nocheck
import { GoogleGenAI } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import dotenv from 'dotenv';
import * as EventSourcePkg from 'eventsource';

// Ensure EventSource is available globally for the MCP SDK
const EventSource = (EventSourcePkg as any).EventSource || (EventSourcePkg as any).default || EventSourcePkg;
(global as any).EventSource = EventSource;

dotenv.config({ path: ['development.env', '.env.local', '.env'] });

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    console.error("Please set GEMINI_API_KEY in .env");
    process.exit(1);
}

// Ensure the SDK doesn't prioritize the global GOOGLE_API_KEY over our GEMINI_API_KEY
delete process.env.GOOGLE_API_KEY;

const MCP_SERVER_URL = "http://localhost:8081";

const ai = new GoogleGenAI({ apiKey: API_KEY });

async function getAccessToken(): Promise<string> {
    const clientId = process.env.MCP_CLIENT_ID || "docker-monitor-client-123";
    const clientSecret = process.env.MCP_CLIENT_SECRET || "docker-monitor-secret-abc";

    const response = await fetch(`${MCP_SERVER_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret
        })
    });

    if (!response.ok) {
        throw new Error(`Failed to get token: ${response.statusText}`);
    }

    const data = await response.json();
    return data.access_token;
}

// Convert MCP tool schema to Gemini tool schema
function mcpToolToGeminiTool(mcpTool: any) {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    if (mcpTool.inputSchema && mcpTool.inputSchema.properties) {
        for (const [key, value] of Object.entries<any>(mcpTool.inputSchema.properties)) {
            // Need to map to Gemini's uppercase Types but 'any' bypasses it in ts-nocheck
            properties[key] = {
                type: value.type === 'integer' ? 'INTEGER' : value.type === 'number' ? 'NUMBER' : value.type === 'boolean' ? 'BOOLEAN' : 'STRING',
                description: value.description || '',
            };
        }
    }
    
    if (mcpTool.inputSchema && Array.isArray(mcpTool.inputSchema.required)) {
        required.push(...mcpTool.inputSchema.required);
    }

    return {
        name: mcpTool.name,
        description: mcpTool.description,
        parameters: {
            type: "OBJECT",
            properties,
            required: required.length > 0 ? required : undefined,
        }
    };
}

async function main() {
    console.log("1. Authenticating with MCP Server...");
    let token: string;
    try {
        token = await getAccessToken();
        console.log("   Token acquired.");
    } catch (e: any) {
        console.error("   Auth failed:", e.message);
        return;
    }

    console.log("2. Connecting to MCP Server via SSE...");
    const url = new URL(`${MCP_SERVER_URL}/mcp`);
    url.searchParams.append("token", token);
    
    const transport = new SSEClientTransport(url, {
        requestInit: {
            headers: {
                "Authorization": `Bearer ${token}`
            }
        }
    });
    const mcpClient = new Client({ name: "test-agent", version: "1.0.0" }, { capabilities: {} });
    
    await mcpClient.connect(transport);
    console.log("   Connected.");

    console.log("3. Fetching tools from MCP Server...");
    const toolsResponse = await mcpClient.listTools();
    const mcpTools = toolsResponse.tools;
    console.log(`   Found ${mcpTools.length} tools.`);

    const geminiFunctionDeclarations = mcpTools.map(mcpToolToGeminiTool);

    console.log("4. Sending prompt to Gemini with CustomTools model...");
    const prompt = "ローカルのDockerで稼働しているコンテナの一覧を教えてください。";
    console.log(`   Prompt: "${prompt}"`);

    const chat = ai.chats.create({
        model: "gemini-3.1-pro-preview-customtools",
        config: {
            tools: [{ functionDeclarations: geminiFunctionDeclarations }],
        }
    });

    try {
        const response = await chat.sendMessage({ message: prompt });
        let currentResponse = response;

        while (currentResponse.functionCalls && currentResponse.functionCalls.length > 0) {
            const functionResponses = [];
            
            for (const call of currentResponse.functionCalls) {
                console.log(`\n   [Gemini requested tool call: ${call.name}]`);
                console.log(`     Args:`, call.args);
                
                try {
                    const result = await mcpClient.callTool({
                        name: call.name,
                        arguments: call.args as Record<string, unknown>
                    });
                    
                    console.log(`   [Tool call successful]`);
                    
                    const textContent = (result.content as any[]).map(c => c.type === 'text' ? c.text : '').join('\n');
                    
                    functionResponses.push({
                        functionResponse: {
                            name: call.name,
                            response: { result: textContent }
                        }
                    });
                } catch (err: any) {
                    console.error(`   [Tool call failed: ${err.message}]`);
                    functionResponses.push({
                        functionResponse: {
                            name: call.name,
                            response: { error: err.message }
                        }
                    });
                }
            }

            console.log("\n5. Sending tool results back to Gemini...");
            currentResponse = await chat.sendMessage({ message: functionResponses });
        }

        console.log("\n=== Final Response from Gemini ===\n");
        console.log(currentResponse.text);

    } catch (e: any) {
        console.error("Error during Gemini interaction:", e);
    } finally {
        await mcpClient.close();
    }
}

main().catch(console.error);
