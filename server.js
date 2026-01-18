const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// CORS manual
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '10mb' }));

// Armazena clientes (agentes) conectados
const clients = new Map();

// Armazena dashboards conectados (para receber snapshots)
const dashboards = new Map();

// Armazena último snapshot de cada câmera
const lastSnapshots = new Map();

// Armazena requisições pendentes (para aguardar respostas do agente)
const pendingRequests = new Map();

// ==========================================
// WEBSOCKET CONNECTION
// ==========================================

wss.on('connection', (ws, req) => {
    console.log('🔌 Nova conexão WebSocket');
    
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            // Autenticação do agente
            if (data.action === 'auth') {
                const clienteId = data.cliente_id;
                
                clients.set(clienteId, {
                    ws: ws,
                    info: data.info || {},
                    connected_at: Date.now(),
                    last_ping: Date.now()
                });
                
                ws.cliente_id = clienteId;
                ws.isAgent = true;
                console.log(`✅ Agente ${clienteId} autenticado`);

                ws.send(JSON.stringify({
                    action: 'auth_success',
                    message: 'Autenticado com sucesso'
                }));

                notifyDashboards({
                    type: 'client_connected',
                    cliente_id: clienteId,
                    info: data.info
                });
            }

            // Dashboard se registrando
            if (data.action === 'register_dashboard') {
                ws.isDashboard = true;
                ws.watching = data.cliente_id || 'all';
                
                if (!dashboards.has(ws.watching)) {
                    dashboards.set(ws.watching, new Set());
                }
                dashboards.get(ws.watching).add(ws);
                
                console.log(`📊 Dashboard registrado para: ${ws.watching}`);
                
                if (data.cliente_id) {
                    const snapshots = [];
                    lastSnapshots.forEach((snap, key) => {
                        if (key.startsWith(data.cliente_id + '_')) {
                            snapshots.push(snap);
                        }
                    });
                    if (snapshots.length > 0) {
                        ws.send(JSON.stringify({
                            type: 'cached_snapshots',
                            snapshots: snapshots
                        }));
                    }
                }
            }

            // Snapshot de câmera recebido
            if (data.action === 'camera_snapshot') {
                const key = `${data.cliente_id}_${data.camera_id}`;
                lastSnapshots.set(key, data);
                
                sendToDashboards(data.cliente_id, {
                    type: 'camera_snapshot',
                    ...data
                });
            }

            // Resposta de snapshot XMEye
            if (data.action === 'xmeye_snapshot_response') {
                const pending = pendingRequests.get(data.request_id);
                if (pending) {
                    pending.resolve(data);
                    pendingRequests.delete(data.request_id);
                }
            }

            // Status update
            if (data.action === 'status_update') {
                const client = clients.get(data.cliente_id);
                if (client) {
                    client.info = data.info;
                    client.last_ping = Date.now();
                }
                
                sendToDashboards(data.cliente_id, {
                    type: 'status_update',
                    cliente_id: data.cliente_id,
                    info: data.info
                });
            }

            // Pong
            if (data.action === 'pong') {
                const client = clients.get(data.cliente_id);
                if (client) {
                    client.info = data.info;
                    client.last_ping = Date.now();
                }
            }

            // Respostas de comandos
            if (data.action === 'camera_added' || 
                data.action === 'camera_removed' ||
                data.action === 'dispositivo_added' ||
                data.action === 'dispositivo_removed' ||
                data.action === 'dispositivo_controlled') {
                
                sendToDashboards(data.cliente_id || ws.cliente_id, {
                    type: data.action,
                    ...data
                });
            }

        } catch (error) {
            console.error('❌ Erro ao processar mensagem:', error);
        }
    });

    ws.on('close', () => {
        if (ws.cliente_id && ws.isAgent) {
            clients.delete(ws.cliente_id);
            console.log(`🔴 Agente ${ws.cliente_id} desconectado`);
            
            notifyDashboards({
                type: 'client_disconnected',
                cliente_id: ws.cliente_id
            });
        }
        
        if (ws.isDashboard && ws.watching) {
            const set = dashboards.get(ws.watching);
            if (set) {
                set.delete(ws);
            }
        }
    });
});

// Função para enviar para dashboards específicos
function sendToDashboards(clienteId, data) {
    const specific = dashboards.get(clienteId);
    if (specific) {
        specific.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(data));
            }
        });
    }
    
    const all = dashboards.get('all');
    if (all) {
        all.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(data));
            }
        });
    }
}

// Notifica todos os dashboards
function notifyDashboards(data) {
    dashboards.forEach((set, key) => {
        set.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(data));
            }
        });
    });
}

// Ping periódico
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ==========================================
// API HTTP - ENDPOINTS EXISTENTES
// ==========================================

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        clientes_online: clients.size,
        dashboards_conectados: Array.from(dashboards.values()).reduce((acc, set) => acc + set.size, 0),
        timestamp: Date.now()
    });
});

app.get('/clients', (req, res) => {
    const list = [];
    clients.forEach((client, id) => {
        list.push({
            cliente_id: id,
            online: true,
            info: client.info,
            connected_at: client.connected_at,
            last_ping: client.last_ping
        });
    });
    res.json(list);
});

app.get('/status/:cliente_id', (req, res) => {
    const cliente_id = req.params.cliente_id;
    const client = clients.get(cliente_id);

    if (client) {
        res.json({
            cliente_id,
            online: true,
            info: client.info,
            connected_at: client.connected_at,
            last_ping: client.last_ping
        });
    } else {
        res.json({
            cliente_id,
            online: false
        });
    }
});

app.get('/snapshot/:cliente_id/:camera_id', (req, res) => {
    const key = `${req.params.cliente_id}_${req.params.camera_id}`;
    const snapshot = lastSnapshots.get(key);
    
    if (snapshot) {
        res.json(snapshot);
    } else {
        res.status(404).json({ error: 'Snapshot não disponível' });
    }
});

app.post('/command/:cliente_id', (req, res) => {
    const cliente_id = req.params.cliente_id;
    const client = clients.get(cliente_id);

    if (!client) {
        return res.status(404).json({ error: 'Cliente offline' });
    }

    const command = {
        ...req.body,
        request_id: Date.now().toString()
    };

    client.ws.send(JSON.stringify(command));
    res.json({ success: true, request_id: command.request_id });
});

app.post('/camera/:cliente_id', (req, res) => {
    const cliente_id = req.params.cliente_id;
    const client = clients.get(cliente_id);

    if (!client) {
        return res.status(404).json({ error: 'Cliente offline' });
    }

    const command = {
        action: 'add_camera',
        camera: req.body,
        request_id: Date.now().toString()
    };

    client.ws.send(JSON.stringify(command));
    res.json({ success: true, request_id: command.request_id });
});

app.delete('/camera/:cliente_id/:camera_id', (req, res) => {
    const cliente_id = req.params.cliente_id;
    const client = clients.get(cliente_id);

    if (!client) {
        return res.status(404).json({ error: 'Cliente offline' });
    }

    client.ws.send(JSON.stringify({
        action: 'remove_camera',
        camera_id: req.params.camera_id,
        request_id: Date.now().toString()
    }));
    
    res.json({ success: true });
});

app.post('/dispositivo/:cliente_id', (req, res) => {
    const cliente_id = req.params.cliente_id;
    const client = clients.get(cliente_id);

    if (!client) {
        return res.status(404).json({ error: 'Cliente offline' });
    }

    const command = {
        action: 'add_dispositivo',
        dispositivo: req.body,
        request_id: Date.now().toString()
    };

    client.ws.send(JSON.stringify(command));
    res.json({ success: true, request_id: command.request_id });
});

app.delete('/dispositivo/:cliente_id/:dispositivo_id', (req, res) => {
    const cliente_id = req.params.cliente_id;
    const client = clients.get(cliente_id);

    if (!client) {
        return res.status(404).json({ error: 'Cliente offline' });
    }

    client.ws.send(JSON.stringify({
        action: 'remove_dispositivo',
        dispositivo_id: req.params.dispositivo_id,
        request_id: Date.now().toString()
    }));
    
    res.json({ success: true });
});

app.post('/dispositivo/:cliente_id/:dispositivo_id/control', (req, res) => {
    const cliente_id = req.params.cliente_id;
    const client = clients.get(cliente_id);

    if (!client) {
        return res.status(404).json({ error: 'Cliente offline' });
    }

    client.ws.send(JSON.stringify({
        action: 'control_dispositivo',
        dispositivo_id: req.params.dispositivo_id,
        comando: req.body.comando,
        request_id: Date.now().toString()
    }));
    
    res.json({ success: true });
});

// ==========================================
// API XMEYE P2P - NOVOS ENDPOINTS
// ==========================================

// Snapshot via XMEye P2P (através do agente)
app.get('/api/xmeye/snapshot/:cliente_id', async (req, res) => {
    try {
        const { cliente_id } = req.params;
        const { serial, user = 'admin', pass = '', channel = '0' } = req.query;
        
        console.log(`📸 XMEye Snapshot: Cliente ${cliente_id} | Serial: ${serial} | Channel: ${channel}`);
        
        const client = clients.get(cliente_id);
        
        if (!client) {
            return res.status(503).json({ 
                error: 'Cliente offline',
                message: 'Agente não está conectado ao servidor'
            });
        }

        const request_id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        
        // Cria promise para aguardar resposta do agente
        const responsePromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingRequests.delete(request_id);
                reject(new Error('Timeout: Agente não respondeu em 15s'));
            }, 15000);
            
            pendingRequests.set(request_id, {
                resolve: (data) => {
                    clearTimeout(timeout);
                    resolve(data);
                },
                reject
            });
        });
        
        // Envia comando pro agente via WebSocket
        client.ws.send(JSON.stringify({
            action: 'xmeye_snapshot',
            serial: serial,
            user: user,
            pass: pass,
            channel: parseInt(channel),
            request_id: request_id
        }));
        
        // Aguarda resposta do agente
        const response = await responsePromise;
        
        if (response.success && response.snapshot) {
            const buffer = Buffer.from(response.snapshot, 'base64');
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.send(buffer);
        } else {
            res.status(500).json({ 
                error: response.error || 'Erro ao capturar snapshot',
                details: response.details
            });
        }
        
    } catch (error) {
        console.error('❌ XMEye API Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Snapshot direto via HTTP (só funciona na mesma rede local - sem CGNAT)
app.get('/api/xmeye/snapshot-direct', async (req, res) => {
    try {
        const { ip, user = 'admin', pass = '', channel = '0', port = '34567' } = req.query;
        
        if (!ip) {
            return res.status(400).json({ error: 'Parâmetro IP é obrigatório' });
        }
        
        console.log(`📸 XMEye Direct: ${ip}:${port} | User: ${user} | Channel: ${channel}`);
        
        // URLs comuns de snapshot em DVRs XMEye
        const urls = [
            `http://${ip}:${port}/cgi-bin/snapshot.cgi?chn=${channel}&u=${user}&p=${pass}`,
            `http://${ip}:${port}/snapshot.jpg?user=${user}&pwd=${pass}&chn=${channel}`,
            `http://${ip}:${port}/web/cgi-bin/hi3510/snap.cgi?&-getpic`,
            `http://${ip}/cgi-bin/snapshot.cgi?chn=${channel}`,
        ];
        
        for (const url of urls) {
            try {
                const response = await axios.get(url, {
                    responseType: 'arraybuffer',
                    timeout: 5000,
                    auth: user ? { username: user, password: pass } : undefined
                });
                
                // Verifica se é uma imagem válida (tamanho mínimo)
                if (response.data && response.data.length > 1000) {
                    res.set('Content-Type', 'image/jpeg');
                    res.set('Cache-Control', 'no-cache');
                    return res.send(Buffer.from(response.data));
                }
            } catch (err) {
                console.log(`⚠️  URL falhou: ${url.substring(0, 60)}...`);
                continue;
            }
        }
        
        res.status(404).json({ 
            error: 'Snapshot não disponível',
            message: 'Nenhuma URL funcionou. Use a API via agente para CGNAT: /api/xmeye/snapshot/:cliente_id'
        });
        
    } catch (error) {
        console.error('❌ XMEye Direct Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('🚀 SERVIDOR ATRITELECOM IA INICIADO COM SUCESSO');
    console.log('='.repeat(60));
    console.log(`📡 WebSocket: ws://localhost:${PORT}`);
    console.log(`🌐 HTTP API: http://localhost:${PORT}`);
    console.log(`📸 XMEye P2P: GET /api/xmeye/snapshot/:cliente_id?serial=XXX`);
    console.log(`📸 XMEye Direto: GET /api/xmeye/snapshot-direct?ip=192.168.0.200`);
    console.log(`🏥 Health Check: GET /health`);
    console.log('='.repeat(60));
});
