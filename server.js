const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Armazena clientes conectados
const clients = new Map();

// WebSocket connection
wss.on('connection', (ws) => {
    console.log('Novo cliente conectado');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // Autenticação do cliente
            if (data.action === 'auth') {
                clients.set(data.cliente_id, ws);
                ws.cliente_id = data.cliente_id;
                console.log(`Cliente ${data.cliente_id} autenticado`);
                
                ws.send(JSON.stringify({
                    action: 'auth_success',
                    message: 'Autenticado com sucesso'
                }));
            }
            
            // Recebe resposta do agent
            if (data.request_id) {
                console.log(`Resposta recebida para request ${data.request_id}`);
                // Aqui você pode repassar pro dashboard via HTTP/polling
            }
            
        } catch (error) {
            console.error('Erro ao processar mensagem:', error);
        }
    });
    
    ws.on('close', () => {
        if (ws.cliente_id) {
            clients.delete(ws.cliente_id);
            console.log(`Cliente ${ws.cliente_id} desconectado`);
        }
    });
});

// Endpoint HTTP pra dashboard verificar se cliente está online
app.get('/status/:cliente_id', (req, res) => {
    const cliente_id = req.params.cliente_id;
    const online = clients.has(cliente_id);
    
    res.json({
        cliente_id,
        online,
        timestamp: Date.now()
    });
});

// Endpoint pra dashboard enviar comando pro agent
app.post('/command/:cliente_id', express.json(), (req, res) => {
    const cliente_id = req.params.cliente_id;
    const ws = clients.get(cliente_id);
    
    if (!ws) {
        return res.status(404).json({ error: 'Cliente offline' });
    }
    
    ws.send(JSON.stringify(req.body));
    res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        clientes_online: clients.size,
        timestamp: Date.now()
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log(`HTTP: http://localhost:${PORT}`);
});
