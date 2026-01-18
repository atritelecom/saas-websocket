const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Armazena clientes conectados
const clients = new Map();

// WebSocket connection
wss.on('connection', (ws) => {
    console.log('Novo cliente conectado');
    
    // Envia info inicial
    ws.send(JSON.stringify({
        action: 'welcome',
        message: 'Conectado ao servidor',
        clients: clients.size
    }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // Ping/Pong para medir latência
            if (data.type === 'ping') {
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: data.timestamp,
                    clients: clients.size
                }));
                return;
            }
            
            // Autenticação do cliente (agent)
            if (data.action === 'auth') {
                clients.set(data.cliente_id, {
                    ws: ws,
                    info: data.info || {},
                    last_ping: Date.now()
                });
                ws.cliente_id = data.cliente_id;
                console.log(`Cliente ${data.cliente_id} autenticado`);
                
                ws.send(JSON.stringify({
                    action: 'auth_success',
                    message: 'Autenticado com sucesso'
                }));
                
                // Notifica dashboards sobre novo cliente
                broadcastToDashboards({
                    action: 'client_connected',
                    cliente_id: data.cliente_id,
                    clients: clients.size
                });
            }
            
            // Agent enviando status/info
            if (data.action === 'status_update') {
                if (ws.cliente_id && clients.has(ws.cliente_id)) {
                    const client = clients.get(ws.cliente_id);
                    client.info = data.info || client.info;
                    client.last_ping = Date.now();
                }
            }
            
            // Recebe resposta do agent
            if (data.request_id) {
                console.log(`Resposta recebida para request ${data.request_id}`);
            }
            
        } catch (error) {
            console.error('Erro ao processar mensagem:', error);
        }
    });
    
    ws.on('close', () => {
        if (ws.cliente_id) {
            clients.delete(ws.cliente_id);
            console.log(`Cliente ${ws.cliente_id} desconectado`);
            
            // Notifica dashboards
            broadcastToDashboards({
                action: 'client_disconnected',
                cliente_id: ws.cliente_id,
                clients: clients.size
            });
        }
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
});

// Broadcast para conexões que não são agents (dashboards)
function broadcastToDashboards(data) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && !client.cliente_id) {
            client.send(JSON.stringify(data));
        }
    });
}

// ========== ENDPOINTS HTTP ==========

// Health check / status geral
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok',
        service: 'Atritelecom WebSocket Server',
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
    
    res.json({
        cliente_id,
        online: !!client,
        info: client ? client.info : null,
        last_ping: client ? client.last_ping : null,
        timestamp: Date.now()
    });
});

// Enviar comando pro agent
app.post('/command/:cliente_id', (req, res) => {
    const cliente_id = req.params.cliente_id;
    const client = clients.get(cliente_id);
    
    if (!client) {
        return res.status(404).json({ error: 'Cliente offline' });
    }
    
    const command = {
        ...req.body,
        request_id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
    
    client.ws.send(JSON.stringify(command));
    res.json({ success: true, request_id: command.request_id });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log(`HTTP: http://localhost:${PORT}`);
});
