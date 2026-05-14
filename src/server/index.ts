import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import server from './mcp.js';

// Load from local .env files
dotenv.config({ path: ['development.env', '.env.local', '.env'] });

const app = express();
const PORT = process.env.PORT || 8081;
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_for_development';

// CORS configuration
app.use(cors({
    origin: true,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// --- MCP Server Endpoints ---
let mcpTransport: SSEServerTransport | null = null;

const authorizeMcp = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    let token: string | null = null;

    // 1. Check Authorization header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        // 2. Check query params
        token = req.query.token as string;
    } else if (req.query.access_token) {
        token = req.query.access_token as string;
    }

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid Bearer token' });
    }

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
    let grantType = req.body.grant_type || req.query.grant_type;
    let clientId = req.body.client_id || req.query.client_id;
    let clientSecret = req.body.client_secret || req.query.client_secret;

    // Support Basic Auth Header
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

    // AppRunner Monitor 仕様に合わせた簡易認証：環境変数に定義されたIDとSecretと一致するか確認
    const validClientId = process.env.MCP_CLIENT_ID || 'test-client-id';
    const validClientSecret = process.env.MCP_CLIENT_SECRET || 'test-client-secret';

    if (grantType !== 'client_credentials') {
        return res.status(400).json({ error: 'unsupported_grant_type' });
    }

    if (!clientId || clientId !== validClientId || !clientSecret || clientSecret !== validClientSecret) {
        return res.status(401).json({ error: 'invalid_client' });
    }

    try {
        const token = jwt.sign(
            { email: `${clientId}@m2m.local`, issuer: clientId },
            JWT_SECRET,
            { expiresIn: '1y' } // Token expires in 1 year
        );

        return res.json({
            access_token: token,
            token_type: 'Bearer',
            expires_in: 3600
        });
    } catch (error) {
        console.error('[OAuth] Error generating token:', error);
        return res.status(500).json({ error: 'internal_server_error' });
    }
});

// GET /mcp (SSE Transport Initialization)
app.get('/mcp', authorizeMcp, async (req: express.Request, res: express.Response) => {
    console.log(`[MCP] Establishing SSE connection for client: ${(req as any).mcpClient.issuer}`);
    mcpTransport = new SSEServerTransport("/mcp/messages", res);
    await server.connect(mcpTransport);
});

// POST /mcp/messages (Receive commands from client)
app.post('/mcp/messages', authorizeMcp, express.json(), async (req: express.Request, res: express.Response) => {
    if (!mcpTransport) {
        return res.status(400).json({ error: 'SSE session not initialized. Call GET /mcp first.' });
    }
    await mcpTransport.handlePostMessage(req, res, req.body);
});

// Basic health check
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', service: 'docker-monitor-mcp-server' });
});

app.listen(PORT, () => {
    console.log(`Docker Monitor MCP Server is listening on port ${PORT}`);
});
