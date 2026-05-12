import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import Docker from "dockerode";

// Connect to the local Docker socket
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// Initialize the MCP Server
const server = new McpServer({
    name: "docker-monitor-mcp-server",
    version: "1.0.0",
});

// Tool: list_containers
server.tool(
    "list_containers",
    "List Docker containers",
    {
        all: z.boolean().optional().describe("Return all containers (default: false, only running)"),
    },
    async ({ all }) => {
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
            return {
                content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error listing containers: ${error.message}` }],
                isError: true,
            };
        }
    }
);

// Tool: get_container_logs
server.tool(
    "get_container_logs",
    "Get logs for a specific container",
    {
        id: z.string().describe("Container ID or Name"),
        tail: z.number().optional().describe("Number of lines to show from the end of the logs (default: 100)"),
    },
    async ({ id, tail }) => {
        try {
            const container = docker.getContainer(id);
            const logs = await container.logs({
                stdout: true,
                stderr: true,
                tail: tail ?? 100,
                timestamps: true,
            });
            // Logs are returned as a Buffer. Need to parse it depending on output type, but simple toString works mostly.
            // Docker API returns multiplexed streams if no tty is allocated. 
            // We strip out the headers for clean text.
            let logText = "";
            let offset = 0;
            while (offset < logs.length) {
                // Header is 8 bytes: [STREAM_TYPE, 0, 0, 0, SIZE1, SIZE2, SIZE3, SIZE4]
                if (offset + 8 > logs.length) {
                    logText += logs.subarray(offset).toString('utf8');
                    break;
                }
                const streamType = logs[offset]; // 0=stdin, 1=stdout, 2=stderr
                // Size is UInt32BE at offset 4
                const size = logs.readUInt32BE(offset + 4);
                
                // If it doesn't look like a multiplexed header (e.g. if TTY is true), just read as string
                // But dockerode returns multiplexed format if TTY is false (default)
                if (streamType > 2) {
                     logText = logs.toString('utf8');
                     break;
                }

                offset += 8;
                if (offset + size > logs.length) {
                     logText += logs.subarray(offset).toString('utf8');
                     break;
                }

                const chunk = logs.subarray(offset, offset + size);
                logText += chunk.toString('utf8');
                offset += size;
            }

            return {
                content: [{ type: "text", text: logText || "No logs available." }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error getting logs: ${error.message}` }],
                isError: true,
            };
        }
    }
);

// Tool: start_container
server.tool(
    "start_container",
    "Start a container",
    {
        id: z.string().describe("Container ID or Name"),
    },
    async ({ id }) => {
        try {
            const container = docker.getContainer(id);
            await container.start();
            return {
                content: [{ type: "text", text: `Container ${id} started successfully.` }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error starting container: ${error.message}` }],
                isError: true,
            };
        }
    }
);

// Tool: stop_container
server.tool(
    "stop_container",
    "Stop a container",
    {
        id: z.string().describe("Container ID or Name"),
    },
    async ({ id }) => {
        try {
            const container = docker.getContainer(id);
            await container.stop();
            return {
                content: [{ type: "text", text: `Container ${id} stopped successfully.` }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error stopping container: ${error.message}` }],
                isError: true,
            };
        }
    }
);

// Tool: restart_container
server.tool(
    "restart_container",
    "Restart a container",
    {
        id: z.string().describe("Container ID or Name"),
    },
    async ({ id }) => {
        try {
            const container = docker.getContainer(id);
            await container.restart();
            return {
                content: [{ type: "text", text: `Container ${id} restarted successfully.` }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error restarting container: ${error.message}` }],
                isError: true,
            };
        }
    }
);

// Tool: inspect_container
server.tool(
    "inspect_container",
    "Get detailed information about a container",
    {
        id: z.string().describe("Container ID or Name"),
    },
    async ({ id }) => {
        try {
            const container = docker.getContainer(id);
            const data = await container.inspect();
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error inspecting container: ${error.message}` }],
                isError: true,
            };
        }
    }
);

// Tool: list_images
server.tool(
    "list_images",
    "List Docker images",
    {},
    async () => {
        try {
            const images = await docker.listImages();
            const formatted = images.map(img => ({
                Id: img.Id.substring(7, 19), // Remove sha256:
                RepoTags: img.RepoTags?.join(", ") || "<none>",
                Size: `${(img.Size / 1024 / 1024).toFixed(2)} MB`,
                Created: new Date(img.Created * 1000).toISOString()
            }));
            return {
                content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error listing images: ${error.message}` }],
                isError: true,
            };
        }
    }
);

export default server;
