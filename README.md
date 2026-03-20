# leads.widget.backend

Backend externo para Lead Widget con contratos compatibles de Vercel API.

## Endpoints

- `GET /health`
- `POST /api/chat`
- `POST /api/track`
- `POST /api/verify-payment`
- `POST /api/acquisition/search`
- `GET /api/acquisition/prospects`
- `PATCH /api/acquisition/prospects`
- `GET /api/crm/contacts`
- `GET /api/crm/contacts/:contactId`
- `POST /api/crm/contacts`
- `PATCH /api/crm/contacts/:contactId`
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
- `IACLOSER_API_URL` (opcional, default: `https://ai-call-closer-saas.vercel.app/api/leads/handoff`)
- `IACLOSER_API_KEY` (Bearer token para IACloser)
- `IACLOSER_DEFAULT_REDIRECT_URL` (opcional)

## Desarrollo local

```bash
npm install
npm run dev
```

Health check:

```bash
curl http://localhost:8080/health
```

## Deploy en Railway

`railway.json` fija el builder `DOCKERFILE` y usa `GET /health` como healthcheck para mantener el runtime alineado con produccion.

Pasos recomendados:

```bash
railway init -n leads-widget-backend
railway up
railway domain
```

Variables obligatorias a cargar en Railway:

- `FIREBASE_SERVICE_ACCOUNT`
- `OPENAI_API_KEY`
- `GOOGLE_MAPS_API_KEY`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_ENV`
- `CORS_ORIGINS`
- `PUBLIC_APP_URL`
- `WIDGET_EMBED_URL`
- `ALLOW_INSECURE_VERIFY_PAYMENT`
- `IACLOSER_API_URL`
- `IACLOSER_API_KEY`
- `IACLOSER_DEFAULT_REDIRECT_URL`

Si el frontend `leads.widget` consume este backend por Vercel, el upstream debe configurarse via `BACKEND_URL` en ese proyecto para evitar hardcodes de hosting.

## Deploy en Cloud Run

```bash
gcloud run deploy leads-widget-backend --source . --region us-central1 --allow-unauthenticated
```

Luego configura variables de entorno en Cloud Run.

## Nota de seguridad

`/api/verify-payment` acepta fallback inseguro por compatibilidad (`ALLOW_INSECURE_VERIFY_PAYMENT=true`).
Cuando actualices frontend para enviar Firebase ID token, cambia a `false`.
