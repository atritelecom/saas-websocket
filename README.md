# SaaS WebSocket Server

Servidor WebSocket para gerenciar conexões de agents de clientes.

## Endpoints

### WebSocket
- `wss://seu-app.onrender.com`

### HTTP
- `GET /health` - Status do servidor
- `GET /status/:cliente_id` - Verifica se cliente está online
- `POST /command/:cliente_id` - Envia comando pro agent

## Deploy

Deploy automático no Render.com
