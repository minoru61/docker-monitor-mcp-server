import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpServer } from './mcp.js';

// Load from local .env files
dotenv.config({ path: ['development.env', '.env.local', '.env'] });

const app = express();
const PORT = process.env.PORT || 8081;
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_for_development';

// Parse scopes from environment
let clientScopes: Record<string, { secret: string, tools: string[] }> = {};
try {
    if (process.env.MCP_CLIENT_SCOPES) {
        clientScopes = JSON.parse(process.env.MCP_CLIENT_SCOPES);
    }
} catch (e) {
    console.error("[OAuth] Failed to parse MCP_CLIENT_SCOPES JSON", e);
}

// CORS configuration
app.use(cors({
    origin: true,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

const transports = new Map<string, SSEServerTransport>();

const authorizeMcp = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    let token: string | null = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token as string;
    } else if (req.query.access_token) {
        token = req.query.access_token as string;
    }

    if (!token) return res.status(401).json({ error: 'Unauthorized: Missing or invalid Bearer token' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        (req as any).mcpClient = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};

// --- OAuth 2.0 Token Endpoint (Client Credentials Flow) ---
app.post('/oauth/token', express.json(), express.urlencoded({ extended: true }), (req: express.Request, res: express.Response) => {
    const body = req.body || {};
    let grantType = body.grant_type || req.query.grant_type;
    let clientId = body.client_id || req.query.client_id;
    let clientSecret = body.client_secret || req.query.client_secret;

    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Basic ')) {
        try {
            const b64auth = authHeader.split(' ')[1];
            const [bClientId, bClientSecret] = Buffer.from(b64auth, 'base64').toString().split(':');
            if (bClientId) clientId = bClientId;
            if (bClientSecret) clientSecret = bClientSecret;
        } catch (e: any) {
            console.warn('[OAuth] Failed to parse Basic Auth header:', e.message);
        }
    }

    if (grantType !== 'client_credentials') {
        return res.status(400).json({ error: 'unsupported_grant_type' });
    }

    if (!clientId || !clientScopes[clientId] || clientSecret !== clientScopes[clientId].secret) {
        return res.status(401).json({ error: 'invalid_client' });
    }

    try {
        const token = jwt.sign(
            { 
                email: `${clientId}@m2m.local`, 
                issuer: clientId,
                allowedTools: clientScopes[clientId].tools
            },
            JWT_SECRET,
            { expiresIn: '1y' }
        );

        return res.json({ access_token: token, token_type: 'Bearer', expires_in: 31536000 });
    } catch (error) {
        console.error('[OAuth] Error generating token:', error);
        return res.status(500).json({ error: 'internal_server_error' });
    }
});

// GET /mcp (SSE Transport Initialization)
app.get('/mcp', authorizeMcp, async (req: express.Request, res: express.Response) => {
    const client = (req as any).mcpClient;
    console.log(`[MCP] Establishing SSE connection for client: ${client.issuer}`);
    
    const pathPrefix = process.env.PATH_PREFIX || '';
    const transport = new SSEServerTransport(`${pathPrefix}/mcp/messages`, res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    // Build specific server for this client's scope
    const scopedServer = createMcpServer(client.allowedTools || []);
    await scopedServer.connect(transport);

    res.on('close', () => {
        transports.delete(sessionId);
    });
});

// POST /mcp/messages (Receive commands from client)
app.post('/mcp/messages', authorizeMcp, express.json(), async (req: express.Request, res: express.Response) => {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    console.log(`[MCP] POST /messages looking for session ${sessionId}, available sessions: ${Array.from(transports.keys()).join(", ")}`);

    const transport = transports.get(sessionId);
    if (!transport) {
        return res.status(400).json({ error: 'SSE session not found or disconnected.' });
    }
    
    await transport.handlePostMessage(req, res, req.body);
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', service: 'docker-monitor-mcp-server' });
});

app.listen(PORT, () => {
    console.log(`Docker Monitor MCP Server is listening on port ${PORT}`);
});
