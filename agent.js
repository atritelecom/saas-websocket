const WebSocket = require('ws');
const http = require('http');
const os = require('os');

// Configurações (O instalador deve configurar o ID correto aqui)
const CLIENTE_ID = process.argv[2] || 'atritelecom'; 
const SERVER_URL = 'wss://saas-websocket.onrender.com';

function conectar() {
    const ws = new WebSocket(SERVER_URL);

    ws.on('open', () => {
        console.log(`✅ Conectado como: ${CLIENTE_ID}`);
        // Autenticação exigida pelo seu novo server.js
        ws.send(JSON.stringify({
            action: 'auth',
            cliente_id: CLIENTE_ID,
            info: {
                hostname: os.hostname(),
                platform: os.platform(),
                uptime: os.uptime()
            }
        }));
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            // Responder ao comando de Snapshot XMEye (via IP Local)
            if (msg.action === 'xmeye_snapshot') {
                capturarSnapshotLocal(ws, msg);
            }

            // Responder ao Ping do servidor para não cair
            if (msg.action === 'ping') {
                ws.send(JSON.stringify({ action: 'pong', cliente_id: CLIENTE_ID }));
            }
        } catch (e) {
            console.error("Erro ao processar mensagem", e);
        }
    });

    ws.on('close', () => {
        console.log('⚠️ Conexão perdida. Tentando reconectar...');
        setTimeout(conectar, 5000);
    });

    ws.on('error', (err) => console.error('Erro no WebSocket:', err.message));
}

function capturarSnapshotLocal(ws, msg) {
    // Tenta capturar a imagem do DVR na rede local do cliente
    // Se o seu PHP mandar o 'serial', você precisaria de um SDK XMEye.
    // Como estamos em Node, usamos o IP Local que é mais garantido.
    const url = `http://${msg.ip || '192.168.0.200'}:34567/cgi-bin/snapshot.cgi?chn=${msg.channel || 0}&u=${msg.user || 'admin'}&p=${msg.pass || ''}`;

    http.get(url, (res) => {
        let chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            ws.send(JSON.stringify({
                action: 'xmeye_snapshot_response', // O servidor espera esse nome
                request_id: msg.request_id,
                success: true,
                snapshot: buffer.toString('base64')
            }));
            console.log(`📸 Snapshot enviado para request: ${msg.request_id}`);
        });
    }).on('error', (e) => {
        ws.send(JSON.stringify({
            action: 'xmeye_snapshot_response',
            request_id: msg.request_id,
            success: false,
            error: e.message
        }));
    });
}

conectar();
