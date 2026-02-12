# Lead Widget (Backend Externo) - Project Context

## Objetivo de negocio
Backend externo para Lead Widget: sirve el script embebible del widget, procesa chat IA (OpenAI), tracking de eventos y verificacion/activacion de pagos. Disenado para Cloud Run y compatible con contratos tipo Vercel API.

## Tech Stack
- Runtime: Node.js (>= 20) en Cloud Run
- Framework: Express
- Auth/DB: Firebase Admin SDK (Auth + Firestore)
- IA: OpenAI SDK (solo backend)
- Deploy: Google Cloud Run

## Arquitectura (decisiones clave)
- Servicio stateless:
  - Persistencia en Firestore.
  - Endpoint del script embebible (`/api/w/:widgetId.js`) debe ser rapido, cacheable y seguro.
- Tracking embebido declarativo:
  - Solo se aceptan IDs oficiales: `facebook_pixel_id`, `tiktok_pixel_id`, `google_tag_id`.
  - El backend genera snippets oficiales de Meta/TikTok/Google desde esos IDs.
  - `custom_tracking_code` y `custom_code` se ignoran de forma segura (no se ejecutan ni se exponen desde datos de usuario).
  - Validacion estricta por allowlist regex + longitud maxima; valores vacios se normalizan a `null`.
- Seguridad:
  - `FIREBASE_SERVICE_ACCOUNT` y `OPENAI_API_KEY` solo en Cloud Run.
  - CORS restringido por `CORS_ORIGINS` (CSV).
- Compatibilidad:
  - Mantener paths compatibles con despliegues previos (Vercel functions).
  - Respuestas de `/api/chat` y `/api/track` estables para no romper el widget instalado.
  - `/api/w/:widgetId.js` mantiene contrato y hace fallback silencioso si faltan IDs.

## Endpoints (alto nivel)
- `GET /health`
- `POST /api/chat`
- `POST /api/track`
- `POST /api/verify-payment`
- `GET /api/w/:widgetId.js`
- `GET /api/widget-config/:identity`

## Convenciones de codigo
- ESM (`type: module`).
- Validar inputs en el borde (si no hay zod, mantener checks manuales consistentes).
- Errores: HTTP status correctos y sin filtrar secretos.

## Variables de entorno (resumen)
- `FIREBASE_SERVICE_ACCOUNT`
- `OPENAI_API_KEY`
- PayPal: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`
- CORS/URLs: `CORS_ORIGINS`, `PUBLIC_APP_URL`, `WIDGET_EMBED_URL` (opcional)
- Seguridad: `ALLOW_INSECURE_VERIFY_PAYMENT` (debe ser `false` en produccion idealmente)
