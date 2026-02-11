# leads.widget.backend

Backend externo para Lead Widget con contratos compatibles de Vercel API.

## Endpoints

- `GET /health`
- `POST /api/chat`
- `POST /api/track`
- `POST /api/verify-payment`
- `GET /api/w/:widgetId.js`

## Variables de entorno

- `FIREBASE_SERVICE_ACCOUNT` (JSON en una linea)
- `OPENAI_API_KEY`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_ENV` (`live` o `sandbox`)
- `CORS_ORIGINS` (CSV)
- `PUBLIC_APP_URL`
- `WIDGET_EMBED_URL` (opcional)
- `ALLOW_INSECURE_VERIFY_PAYMENT` (`true|false`)

## Desarrollo local

```bash
npm install
npm run dev
```

Health check:

```bash
curl http://localhost:8080/health
```

## Deploy en Cloud Run

```bash
gcloud run deploy leads-widget-backend --source . --region us-central1 --allow-unauthenticated
```

Luego configura variables de entorno en Cloud Run.

## Nota de seguridad

`/api/verify-payment` acepta fallback inseguro por compatibilidad (`ALLOW_INSECURE_VERIFY_PAYMENT=true`).
Cuando actualices frontend para enviar Firebase ID token, cambia a `false`.
