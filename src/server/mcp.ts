import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import Docker from "dockerode";

// Connect to the local Docker socket
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

export function createMcpServer(allowedTools: string[] = []) {
    // Initialize the MCP Server
    const server = new McpServer({
        name: "docker-monitor-mcp-server",
        version: "1.0.0",
    });

    const isAllowed = (toolName: string) => allowedTools.includes("*") || allowedTools.includes(toolName);

    if (isAllowed("list_containers")) {
        server.tool("list_containers", "List Docker containers", {
            all: z.boolean().optional().describe("Return all containers (default: false, only running)"),
        }, async ({ all }) => {
            try {
                const containers = await docker.listContainers({ all: all ?? false });
                const formatted = containers.map(c => ({
                    Id: c.Id.substring(0, 12),
                    Names: c.Names.join(", "),
                    Image: c.Image,
                    State: c.State,
                    Status: c.Status,
                    Ports: c.Ports.map(p => `${p.PublicPort || ''}->${p.PrivatePort}/${p.Type}`).filter(p => !p.startsWith('->')).join(', ')
                }));
                return { content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }] };
            } catch (error: any) {
                return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
            }
        });
    }

    if (isAllowed("get_container_logs")) {
        server.tool("get_container_logs", "Get logs for a specific container", {
            id: z.string().describe("Container ID or Name"),
            tail: z.number().optional().describe("Number of lines to show from the end of the logs (default: 100)"),
        }, async ({ id, tail }) => {
            try {
                const container = docker.getContainer(id);
                const logs = await container.logs({ stdout: true, stderr: true, tail: tail ?? 100, timestamps: true });
                let logText = "";
                let offset = 0;
                while (offset < logs.length) {
                    if (offset + 8 > logs.length) { logText += logs.subarray(offset).toString('utf8'); break; }
                    const streamType = logs[offset];
                    const size = logs.readUInt32BE(offset + 4);
                    if (streamType > 2) { logText = logs.toString('utf8'); break; }
                    offset += 8;
                    if (offset + size > logs.length) { logText += logs.subarray(offset).toString('utf8'); break; }
                    logText += logs.subarray(offset, offset + size).toString('utf8');
                    offset += size;
                }
                return { content: [{ type: "text", text: logText || "No logs available." }] };
            } catch (error: any) {
                return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
            }
        });
    }

    if (isAllowed("start_container")) {
        server.tool("start_container", "Start a container", { id: z.string().describe("Container ID or Name") }, async ({ id }) => {
            try { await docker.getContainer(id).start(); return { content: [{ type: "text", text: `Container ${id} started successfully.` }] }; }
            catch (error: any) { return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true }; }
        });
    }

    if (isAllowed("stop_container")) {
        server.tool("stop_container", "Stop a container", { id: z.string().describe("Container ID or Name") }, async ({ id }) => {
            try { await docker.getContainer(id).stop(); return { content: [{ type: "text", text: `Container ${id} stopped successfully.` }] }; }
            catch (error: any) { return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true }; }
        });
    }

    if (isAllowed("restart_container")) {
        server.tool("restart_container", "Restart a container", { id: z.string().describe("Container ID or Name") }, async ({ id }) => {
            try { await docker.getContainer(id).restart(); return { content: [{ type: "text", text: `Container ${id} restarted successfully.` }] }; }
            catch (error: any) { return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true }; }
        });
    }

    if (isAllowed("inspect_container")) {
        server.tool("inspect_container", "Get detailed information about a container", { id: z.string().describe("Container ID or Name") }, async ({ id }) => {
            try { const data = await docker.getContainer(id).inspect(); return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }; }
            catch (error: any) { return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true }; }
        });
    }

    if (isAllowed("list_images")) {
        server.tool("list_images", "List Docker images", {}, async () => {
            try {
                const images = await docker.listImages();
                const formatted = images.map(img => ({
                    Id: img.Id.substring(7, 19),
                    RepoTags: img.RepoTags?.join(", ") || "<none>",
                    Size: `${(img.Size / 1024 / 1024).toFixed(2)} MB`,
                    Created: new Date(img.Created * 1000).toISOString()
                }));
                return { content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }] };
            } catch (error: any) {
                return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
            }
        });
    }

    return server;
}
