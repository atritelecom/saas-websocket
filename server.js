const WebSocket = require('ws');
const os = require('os');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuração
const CONFIG_FILE = path.join(process.env.APPDATA || process.env.HOME, 'AtritelecomAgent', 'config.json');
const SERVER_URL = 'wss://saas-websocket.onrender.com';

let ws = null;
let clienteId = null;
let cameras = [];
let dispositivos = [];
let snapshotIntervals = {};

// Carregar configuração
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            clienteId = config.cliente_id;
            cameras = config.cameras || [];
            dispositivos = config.dispositivos || [];
            return true;
        }
    } catch (e) {
        console.error('Erro ao carregar config:', e.message);
    }
    return false;
}

// Salvar configuração
function saveConfig() {
    try {
        const dir = path.dirname(CONFIG_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({
            cliente_id: clienteId,
            cameras: cameras,
            dispositivos: dispositivos
        }, null, 2));
    } catch (e) {
        console.error('Erro ao salvar config:', e.message);
    }
}

// Obter informações do sistema
function getSystemInfo() {
    const networkInterfaces = os.networkInterfaces();
    let ip = '127.0.0.1';
    let mac = '00:00:00:00:00:00';

    for (const name of Object.keys(networkInterfaces)) {
        for (const net of networkInterfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                ip = net.address;
                mac = net.mac;
                break;
            }
        }
    }

    return {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        ip_local: ip,
        mac: mac,
        uptime: os.uptime(),
        memoria_total: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 100) / 100,
        memoria_livre: Math.round(os.freemem() / 1024 / 1024 / 1024 * 100) / 100,
        cpus: os.cpus().length,
        cameras_count: cameras.length,
        dispositivos_count: dispositivos.length
    };
}

// Capturar snapshot da câmera
function captureSnapshot(camera) {
    return new Promise((resolve, reject) => {
        // URLs possíveis para Intelbras
        const urls = [
            `http://${camera.usuario}:${camera.senha}@${camera.ip}/cgi-bin/snapshot.cgi`,
            `http://${camera.usuario}:${camera.senha}@${camera.ip}/ISAPI/Streaming/channels/101/picture`,
            `http://${camera.usuario}:${camera.senha}@${camera.ip}/Streaming/channels/1/picture`,
            `http://${camera.ip}/cgi-bin/snapshot.cgi?loginuse=${camera.usuario}&loginpas=${camera.senha}`
        ];

        let urlIndex = camera.urlIndex || 0;
        
        function tryUrl(index) {
            if (index >= urls.length) {
                reject(new Error('Todas as URLs falharam'));
                return;
            }

            const url = urls[index];
            console.log(`[CAM ${camera.nome}] Tentando URL ${index + 1}/${urls.length}`);

            const req = http.get(url, { timeout: 10000 }, (res) => {
                if (res.statusCode === 200) {
                    const chunks = [];
                    res.on('data', chunk => chunks.push(chunk));
                    res.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        if (buffer.length > 1000) { // Imagem válida
                            camera.urlIndex = index; // Salva URL que funcionou
                            resolve({
                                camera_id: camera.id,
                                nome: camera.nome,
                                timestamp: Date.now(),
                                image: buffer.toString('base64'),
                                content_type: res.headers['content-type'] || 'image/jpeg'
                            });
                        } else {
                            tryUrl(index + 1);
                        }
                    });
                } else if (res.statusCode === 401) {
                    console.log(`[CAM ${camera.nome}] Autenticação falhou na URL ${index + 1}`);
                    tryUrl(index + 1);
                } else {
                    tryUrl(index + 1);
                }
            });

            req.on('error', () => tryUrl(index + 1));
            req.on('timeout', () => {
                req.destroy();
                tryUrl(index + 1);
            });
        }

        tryUrl(urlIndex);
    });
}

// Iniciar captura de snapshots
function startSnapshotCapture() {
    // Parar capturas anteriores
    Object.values(snapshotIntervals).forEach(interval => clearInterval(interval));
    snapshotIntervals = {};

    cameras.forEach(camera => {
        if (!camera.ativo) return;

        console.log(`[CAM] Iniciando captura: ${camera.nome} (${camera.ip})`);
        
        // Captura inicial
        captureAndSend(camera);

        // Captura periódica (a cada 3 segundos)
        snapshotIntervals[camera.id] = setInterval(() => {
            captureAndSend(camera);
        }, 3000);
    });
}

// Capturar e enviar snapshot
async function captureAndSend(camera) {
    try {
        const snapshot = await captureSnapshot(camera);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                action: 'camera_snapshot',
                cliente_id: clienteId,
                ...snapshot
            }));
            console.log(`[CAM ${camera.nome}] Snapshot enviado (${Math.round(snapshot.image.length / 1024)}KB)`);
        }
    } catch (e) {
        console.error(`[CAM ${camera.nome}] Erro:`, e.message);
    }
}

// Controlar dispositivo Sonoff/IoT
function controlDevice(dispositivo, comando) {
    return new Promise((resolve, reject) => {
        let url = '';
        
        // Monta URL baseado no tipo
        switch (dispositivo.tipo?.toLowerCase()) {
            case 'sonoff':
            case 'tasmota':
                // Tasmota/Sonoff
                const cmd = comando === 'on' ? 'Power%20On' : 'Power%20Off';
                url = `http://${dispositivo.ip}/cm?cmnd=${cmd}`;
                if (dispositivo.usuario && dispositivo.senha) {
                    url = `http://${dispositivo.usuario}:${dispositivo.senha}@${dispositivo.ip}/cm?cmnd=${cmd}`;
                }
                break;
            case 'shelly':
                // Shelly
                const state = comando === 'on' ? 'on' : 'off';
                url = `http://${dispositivo.ip}/relay/0?turn=${state}`;
                break;
            case 'tuya':
                // Tuya local precisa de protocolo específico
                reject(new Error('Tuya requer integração específica'));
                return;
            default:
                // Genérico - tenta como Tasmota
                const cmdGen = comando === 'on' ? 'Power%20On' : 'Power%20Off';
                url = `http://${dispositivo.ip}/cm?cmnd=${cmdGen}`;
        }

        console.log(`[IOT ${dispositivo.nome}] Comando: ${comando} -> ${url}`);

        http.get(url, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    dispositivo_id: dispositivo.id,
                    nome: dispositivo.nome,
                    comando: comando,
                    success: true,
                    response: data
                });
            });
        }).on('error', (e) => {
            reject(e);
        });
    });
}

// Conectar ao WebSocket
function connect() {
    console.log(`\n[WS] Conectando a ${SERVER_URL}...`);
    
    ws = new WebSocket(SERVER_URL);

    ws.on('open', () => {
        console.log('[WS] Conectado!');
        
        // Autenticar
        ws.send(JSON.stringify({
            action: 'auth',
            cliente_id: clienteId,
            info: getSystemInfo()
        }));
    });

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            console.log('[WS] Mensagem:', msg.action || msg.type || 'desconhecido');

            switch (msg.action) {
                case 'auth_success':
                    console.log('[WS] Autenticado com sucesso!');
                    startSnapshotCapture();
                    break;

                case 'ping':
                    ws.send(JSON.stringify({
                        action: 'pong',
                        cliente_id: clienteId,
                        timestamp: Date.now(),
                        info: getSystemInfo()
                    }));
                    break;

                case 'get_status':
                    ws.send(JSON.stringify({
                        action: 'status',
                        request_id: msg.request_id,
                        cliente_id: clienteId,
                        info: getSystemInfo(),
                        cameras: cameras.map(c => ({ id: c.id, nome: c.nome, ip: c.ip, ativo: c.ativo })),
                        dispositivos: dispositivos.map(d => ({ id: d.id, nome: d.nome, ip: d.ip, tipo: d.tipo }))
                    }));
                    break;

                case 'add_camera':
                    const newCam = {
                        id: msg.camera.id || Date.now().toString(),
                        nome: msg.camera.nome,
                        ip: msg.camera.ip,
                        porta: msg.camera.porta || 554,
                        usuario: msg.camera.usuario || 'admin',
                        senha: msg.camera.senha || 'admin',
                        fabricante: msg.camera.fabricante,
                        modelo: msg.camera.modelo,
                        rtsp_url: msg.camera.rtsp_url,
                        ativo: true
                    };
                    cameras.push(newCam);
                    saveConfig();
                    startSnapshotCapture();
                    ws.send(JSON.stringify({
                        action: 'camera_added',
                        request_id: msg.request_id,
                        camera: newCam,
                        success: true
                    }));
                    console.log(`[CAM] Câmera adicionada: ${newCam.nome}`);
                    break;

                case 'remove_camera':
                    cameras = cameras.filter(c => c.id !== msg.camera_id);
                    if (snapshotIntervals[msg.camera_id]) {
                        clearInterval(snapshotIntervals[msg.camera_id]);
                        delete snapshotIntervals[msg.camera_id];
                    }
                    saveConfig();
                    ws.send(JSON.stringify({
                        action: 'camera_removed',
                        request_id: msg.request_id,
                        camera_id: msg.camera_id,
                        success: true
                    }));
                    console.log(`[CAM] Câmera removida: ${msg.camera_id}`);
                    break;

                case 'add_dispositivo':
                    const newDisp = {
                        id: msg.dispositivo.id || Date.now().toString(),
                        nome: msg.dispositivo.nome,
                        ip: msg.dispositivo.ip,
                        tipo: msg.dispositivo.tipo || 'sonoff',
                        usuario: msg.dispositivo.usuario,
                        senha: msg.dispositivo.senha
                    };
                    dispositivos.push(newDisp);
                    saveConfig();
                    ws.send(JSON.stringify({
                        action: 'dispositivo_added',
                        request_id: msg.request_id,
                        dispositivo: newDisp,
                        success: true
                    }));
                    console.log(`[IOT] Dispositivo adicionado: ${newDisp.nome}`);
                    break;

                case 'remove_dispositivo':
                    dispositivos = dispositivos.filter(d => d.id !== msg.dispositivo_id);
                    saveConfig();
                    ws.send(JSON.stringify({
                        action: 'dispositivo_removed',
                        request_id: msg.request_id,
                        dispositivo_id: msg.dispositivo_id,
                        success: true
                    }));
                    console.log(`[IOT] Dispositivo removido: ${msg.dispositivo_id}`);
                    break;

                case 'control_dispositivo':
                    try {
                        const disp = dispositivos.find(d => d.id === msg.dispositivo_id);
                        if (!disp) throw new Error('Dispositivo não encontrado');
                        
                        const result = await controlDevice(disp, msg.comando);
                        ws.send(JSON.stringify({
                            action: 'dispositivo_controlled',
                            request_id: msg.request_id,
                            ...result
                        }));
                    } catch (e) {
                        ws.send(JSON.stringify({
                            action: 'dispositivo_controlled',
                            request_id: msg.request_id,
                            dispositivo_id: msg.dispositivo_id,
                            success: false,
                            error: e.message
                        }));
                    }
                    break;

                case 'request_snapshot':
                    const cam = cameras.find(c => c.id === msg.camera_id);
                    if (cam) {
                        captureAndSend(cam);
                    }
                    break;

                case 'sync_config':
                    // Sincroniza configuração do dashboard
                    if (msg.cameras) {
                        cameras = msg.cameras;
                    }
                    if (msg.dispositivos) {
                        dispositivos = msg.dispositivos;
                    }
                    saveConfig();
                    startSnapshotCapture();
                    console.log('[SYNC] Configuração sincronizada');
                    break;
            }
        } catch (e) {
            console.error('[WS] Erro ao processar mensagem:', e.message);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Desconectado. Reconectando em 5s...');
        setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
        console.error('[WS] Erro:', err.message);
    });
}

// Status periódico
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: 'status_update',
            cliente_id: clienteId,
            info: getSystemInfo()
        }));
    }
}, 30000);

// Inicialização
console.log('========================================');
console.log('   ATRITELECOM AGENT v2.0');
console.log('   Suporte a Câmeras e IoT');
console.log('========================================\n');

if (!loadConfig()) {
    // Primeira execução - pedir cliente_id
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('Digite o ID do cliente: ', (answer) => {
        clienteId = answer.trim();
        saveConfig();
        rl.close();
        connect();
    });
} else {
    console.log(`Cliente: ${clienteId}`);
    console.log(`Câmeras: ${cameras.length}`);
    console.log(`Dispositivos: ${dispositivos.length}\n`);
    connect();
}
