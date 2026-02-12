# Lead Widget (Backend Externo) — Project Context

## Objetivo de negocio
Backend externo para Lead Widget: sirve el script embebible del widget, procesa chat IA (OpenAI), tracking de eventos, y verificación/activación de pagos. Diseñado para Cloud Run y compatible con contratos tipo Vercel API.

## Tech Stack
- Runtime: Node.js (>= 20) en Cloud Run
- Framework: Express
- Auth/DB: Firebase Admin SDK (Auth + Firestore)
- IA: OpenAI SDK (solo backend)
- Deploy: Google Cloud Run

## Arquitectura (decisiones clave)
- Servicio stateless:
  - Persistencia en Firestore.
  - Endpoint del script embebible (`/api/w/:widgetId.js`) debe ser rápido, cacheable y seguro.
- Seguridad:
  - `FIREBASE_SERVICE_ACCOUNT` y `OPENAI_API_KEY` solo en Cloud Run.
  - CORS restringido por `CORS_ORIGINS` (CSV).
- Compatibilidad:
  - Mantener paths compatibles con despliegues previos (Vercel functions).
  - Respuestas de `/api/chat` y `/api/track` estables para no romper el widget instalado.

## Endpoints (alto nivel)
- `GET /health`
- `POST /api/chat`
- `POST /api/track`
- `POST /api/verify-payment`
- `GET /api/w/:widgetId.js`

## Convenciones de código
- ESM (`type: module`).
- Validar inputs en el borde (si no hay zod, mantener checks manuales consistentes).
- Errores: HTTP status correctos y sin filtrar secretos.

## Variables de entorno (resumen)
- `FIREBASE_SERVICE_ACCOUNT`
- `OPENAI_API_KEY`
- PayPal: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`
- CORS/URLs: `CORS_ORIGINS`, `PUBLIC_APP_URL`, `WIDGET_EMBED_URL` (opcional)
- Seguridad: `ALLOW_INSECURE_VERIFY_PAYMENT` (debe ser `false` en producción idealmente)

