const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();

// CORS - Permitir qualquer origem
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Armazena clientes conectados (agentes)
const clients = new Map();

// Armazena dashboards conectados
const dashboards = new Set();

// WebSocket connection
wss.on('connection', (ws) => {
    console.log('Nova conexão WebSocket');
    
    // Enviar info inicial
    ws.send(JSON.stringify({
        action: 'welcome',
        message: 'Conectado ao servidor Atritelecom',
        clients: clients.size
    }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // Ping/Pong para medir latência (dashboard)
            if (data.type === 'ping') {
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: data.timestamp,
                    clients: clients.size
                }));
                return;
            }
            
            // Autenticação do agente
            if (data.action === 'auth') {
                clients.set(data.cliente_id, {
                    ws: ws,
                    info: data.info || {},
                    last_ping: Date.now()
                });
                ws.cliente_id = data.cliente_id;
                ws.isAgent = true;
                console.log(`Agente ${data.cliente_id} autenticado`);
                
                ws.send(JSON.stringify({
                    action: 'auth_success',
                    message: 'Autenticado com sucesso'
                }));
                
                // Notificar dashboards
                notifyDashboards({
                    action: 'client_connected',
                    cliente_id: data.cliente_id,
                    info: data.info,
                    clients: clients.size
                });
                return;
            }
            
            // Status update do agente
            if (data.action === 'status_update') {
                if (ws.cliente_id && clients.has(ws.cliente_id)) {
                    const client = clients.get(ws.cliente_id);
                    client.info = data.info || client.info;
                    client.last_ping = Date.now();
                    console.log(`Status atualizado: ${ws.cliente_id}`);
                }
                return;
            }
            
            // Resposta de comando do agente
            if (data.request_id) {
                console.log(`Resposta para request ${data.request_id}`);
                // Notificar dashboards sobre a resposta
                notifyDashboards({
                    action: 'command_response',
                    request_id: data.request_id,
                    cliente_id: ws.cliente_id,
                    data: data
                });
            }
            
        } catch (error) {
            console.error('Erro ao processar mensagem:', error);
        }
    });
    
    ws.on('close', () => {
        if (ws.cliente_id) {
            clients.delete(ws.cliente_id);
            console.log(`Agente ${ws.cliente_id} desconectado`);
            
            // Notificar dashboards
            notifyDashboards({
                action: 'client_disconnected',
                cliente_id: ws.cliente_id,
                clients: clients.size
            });
        }
        dashboards.delete(ws);
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
});

// Notificar todos os dashboards conectados
function notifyDashboards(data) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && !client.isAgent) {
            client.send(JSON.stringify(data));
        }
    });
}

// ========== ENDPOINTS HTTP ==========

// Página inicial / Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok',
        service: 'Atritelecom WebSocket Server',
        version: '1.0.0',
        clients: clients.size,
        timestamp: Date.now()
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        clients: clients.size,
        timestamp: Date.now()
    });
});

// Lista todos os clientes online
app.get('/clients', (req, res) => {
    const list = [];
    clients.forEach((value, key) => {
        list.push({
            cliente_id: key,
            info: value.info,
            last_ping: value.last_ping
        });
    });
    res.json({ clients: list, total: clients.size });
});

// Status de um cliente específico
app.get('/status/:cliente_id', (req, res) => {
    const cliente_id = req.params.cliente_id;
    const client = clients.get(cliente_id);
    
    if (client) {
        res.json({
            cliente_id,
            online: true,
            info: client.info,
            last_ping: client.last_ping,
            timestamp: Date.now()
        });
    } else {
        res.json({
            cliente_id,
            online: false,
            info: null,
            last_ping: null,
            timestamp: Date.now()
        });
    }
});

// Enviar comando pro agente
app.post('/command/:cliente_id', (req, res) => {
    const cliente_id = req.params.cliente_id;
    const client = clients.get(cliente_id);
    
    if (!client) {
        return res.status(404).json({ error: 'Cliente offline', online: false });
    }
    
    const command = {
        ...req.body,
        request_id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
    
    try {
        client.ws.send(JSON.stringify(command));
        res.json({ success: true, request_id: command.request_id });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao enviar comando', message: e.message });
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log('========================================');
    console.log('  Atritelecom WebSocket Server v1.0.0');
    console.log('========================================');
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log(`HTTP: http://localhost:${PORT}`);
    console.log('========================================');
});
