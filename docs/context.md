# Contexto Arquitectonico - leads.widget.backend

Snapshot derivado del codigo real del repo al 2026-03-18.

## Runtime y stack

- Node.js >= 20
- Express monolitico en `src/index.js`
- Firebase Admin SDK para Auth y Firestore
- OpenAI SDK para flujos IA
- Integraciones HTTP salientes con PayPal, IACloser y Google Places API

## Estructura real observada

- `src/index.js`: bootstrap Express, middlewares, helpers y todas las rutas HTTP
- `src/firebase.js`: inicializacion Firebase Admin y acceso a Firestore
- No existe una capa separada de controllers/services/repositories; la logica se organiza como helpers locales reutilizados dentro del archivo principal

## Auth y tenancy

- Los endpoints autenticados usan Bearer Firebase ID token.
- El patron base valida el token con `firebaseAdmin.auth().verifyIdToken(...)`.
- Para operaciones de cliente, el tenant se scopea por `decoded.uid`.
- Las rutas partner/admin agregan chequeos adicionales de rol sobre Firestore (`user_roles`, `partner_users`).

## Persistencia Firestore relevante

- `profiles`
- `widget_configs`
- `leads`
- `payments`
- `crm_contacts`
- `activity_events`
- `acquisition_prospects`
- colecciones partner (`partners`, `partner_users`, `commission_ledger`, etc.)

## Modulos funcionales observados

### Widget/chat publico

- `POST /api/track`
- `POST /api/chat`
- `POST /api/icloser/handoff`
- `GET /api/widget-config/:identity`
- `GET /api/w/:widgetId.js`

### Cuenta/operacion interna

- `POST /api/users/bootstrap`
- `GET /api/affiliates/network`
- `POST /api/verify-payment`
- endpoints partner y admin bajo `/api/partners/*` y `/api/admin/*`

### Acquisition (2026-03-18)

- `POST /api/acquisition/search`
- `GET /api/acquisition/prospects`
- `PATCH /api/acquisition/prospects`

Reglas implementadas:

- Fuente inicial obligatoria: Google Places API (`places:searchText`)
- Persistencia por tenant en `acquisition_prospects`
- Dedupe por `client_id + external_id` usando doc id deterministico
- `commercial_score` calculado solo server-side
- Al aprobar, el prospect crea o mergea un contacto en `crm_contacts` con `source = acquisition_google_places`
- La respuesta publica del modulo Acquisition se mapea a camelCase para mantener compatibilidad con la UI actual

## Integraciones externas observadas

- OpenAI: respuestas del chat
- PayPal: verificacion de pagos
- IACloser: handoff outbound
- Google Places API: adquisicion de prospects

## Variables de entorno activas/requeridas

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

## CORS observado

- Headers permitidos: `Content-Type,Authorization`
- Metodos permitidos: `GET,POST,PATCH,PUT,OPTIONS`
