# Realtime Relay - Railway Deployment

Este servidor maneja las conexiones WebSocket entre Twilio y OpenAI Realtime API, con soporte para ElevenLabs TTS.

## Despliegue en Railway

### 1. Crear cuenta en Railway
Ve a [railway.app](https://railway.app) y crea una cuenta (puedes usar GitHub).

### 2. Crear nuevo proyecto
- Click en "New Project"
- Selecciona "Deploy from GitHub repo" o "Empty Project"

### 3. Si usas GitHub:
1. Crea un nuevo repositorio con los archivos de la carpeta `railway/realtime-relay/`
2. Conecta el repo a Railway
3. Railway detectará automáticamente el Dockerfile

### 4. Si usas "Empty Project":
1. Instala Railway CLI: `npm install -g @railway/cli`
2. Login: `railway login`
3. Inicializa: `railway init`
4. Despliega: `railway up`

### 5. Configurar Variables de Entorno
En Railway Dashboard → tu proyecto → Variables:

```
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...
SUPABASE_URL=https://agaufktnlxnnrhbjifne.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
PORT=8080
```

### 6. Obtener URL del Servidor
Una vez desplegado, Railway te dará una URL como:
```
https://realtime-relay-production-xxxx.up.railway.app
```

### 7. Actualizar Twilio Webhook
En tu función `twilio-webhook`, actualiza la URL del WebSocket:

```typescript
// Cambiar de:
const wsUrl = `wss://${supabaseUrl.replace('https://', '')}/functions/v1/realtime-relay`;

// A:
const wsUrl = `wss://realtime-relay-production-xxxx.up.railway.app`;
```

## Estructura de Archivos

```
railway/realtime-relay/
├── main.ts      # Servidor principal
├── Dockerfile   # Configuración Docker
└── README.md    # Este archivo
```

## Monitoreo

- Los logs están disponibles en Railway Dashboard → Deployments → Logs
- El endpoint `/health` devuelve el estado del servidor

## Costos

- Railway tiene un free tier con $5 de crédito mensual
- Para producción, el plan Hobby es ~$5/mes
- El uso se cobra por consumo (CPU, RAM, bandwidth)

## Escalabilidad

Railway escala automáticamente. Para alta demanda:
1. Ve a Settings → Scaling
2. Configura min/max replicas
3. Railway balancea las conexiones automáticamente
