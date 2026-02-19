# Contrato de integracion actual - leads.widget

Documento descriptivo (no prescriptivo) del comportamiento observado en codigo al momento de este cambio.

## Proposito

Describir el contrato real entre:

- Frontend/dashboard/widget embebido (`leads.widget`)
- Backend HTTP (`leads.widget.backend`)
- Datos compartidos en Firestore

El objetivo es congelar el comportamiento actual para gobernanza contract-first sin cambiar runtime.

## Modelos de datos compartidos

Colecciones Firestore detectadas en uso:

### `profiles` (doc id = `uid`)

Campos observados (pueden coexistir segun flujo):

- `email: string | null`
- `display_name: string`
- `business_name: string`
- `whatsapp_number: string`
- `subscription_status: "trial" | "active" | "pro" | "verified" | "suspended" | string`
- `plan_type: "pro" | "plus" | string`
- `trial_ends_at: string | null` (ISO date)
- `ai_enabled: boolean`
- `ai_provider: string`
- `ai_api_key: string`
- `ai_model: string`
- `ai_temperature: number`
- `ai_max_tokens: number`
- `business_description: string`
- `ai_system_prompt: string`
- `ai_security_prompt: string`
- `referred_by: string | null`
- `created_at: string` (ISO date)
- `updated_at: string` (ISO date)

### `user_roles` (doc id = `uid`)

- `role: "superadmin" | string`
- `updated_at: string`

### `widget_configs` (doc id auto, publico para lectura)

Campos observados:

- Identidad: `user_id`, `widget_id`
- Branding/UI: `business_name`, `primary_color`, `welcome_message`, `chat_placeholder`, `launcher_icon`, `hide_branding`, `branding_text`, `branding_link`, `language`, `template`
- Lead Chat/Closer: `experience_mode`, `lead_chat_slug`, `consent_text`, `consent_text_version`, `icloser_redirect_url`, `lead_chat_eyebrow`, `lead_chat_badge_text`, `lead_chat_headline`, `lead_chat_subheadline`, `lead_chat_offer_title`, `lead_chat_offer_description`, `lead_chat_cta_label`, `lead_chat_live_toasts`
- WhatsApp y flujo: `whatsapp_destination`, `niche_question`
- Triggers: `trigger_delay`, `trigger_exit_intent`, `exit_intent_title`, `exit_intent_description`, `exit_intent_cta`, `vibration_intensity`
- Mensajeria: `teaser_messages` (array o string), `quick_replies` (array o string)
- Testimonios: `testimonials_json` (string JSON), opcional `testimonials` (array)
- IA: `ai_enabled`, `ai_provider`, `ai_api_key`, `ai_model`, `ai_system_prompt`, `business_description`, `ai_temperature`, `ai_max_tokens`, `ai_security_prompt`
- Tracking declarativo: `facebook_pixel_id`, `tiktok_pixel_id`, `google_tag_id`
- Timestamps: `created_at`, `updated_at`

Comportamiento observado:

- `custom_tracking_code` y `custom_code` se eliminan/ignoran (frontend los borra y backend publico responde `customTrackingCode: ""`).

### `analytics`

Eventos generados por backend:

- Track view/otros:
  - `widget_id`, `event_type`, `ip`, `user_agent`, `referer`, `date`, `created_at`
- Chat:
  - `widget_id`, `event_type: "message_sent"`, `ip`, `created_at`

### `blocked_ips`

- `widget_id`
- `ip_address`
- `reason`
- `created_at`
- opcional `ai_raw_response`

### `leads`

Se escriben desde dos flujos (schema heterogeneo):

- Flujo backend IA (`collect_lead`):
  - `client_id`, `widget_id`, `name`, `interest`, `phone`, `created_at`
- Flujo widget embebido via Firestore REST:
  - `client_id`, `name`, `phone`, `interest`, `source`, `status`, `created_at` (timestamp)

### `payments`

Campos observados:

- `user_id`
- `amount` (string o number segun flujo)
- `currency`
- `payment_method`
- `description`
- `status`
- `paypal_order_id`
- `payer_email`
- `operation_ref`
- `verified_at`, `verified_by`, `verified_by_server`
- `created_at`

### `visits`

- `client_id`
- `source`
- `timestamp`

## Endpoints del backend

Base detectada:

- Backend externo: `leads.widget.backend/src/index.js`
- Capa publica en frontend: rutas relativas `/api/*` consumidas por frontend y widget.

### Backend externo (Cloud Run / Express)

#### `GET /health`

- Respuesta `200`: `{ ok: true, service: "leads-widget-backend", time: "<ISO>" }`

#### `POST /api/track`

- Body JSON:
  - Requerido: `widgetId`
  - Opcional: `eventType` (default `"view"`)
- Respuestas:
  - `200`: `{ success: true }`
  - `200`: `{ success: true, blocked: true }` (IP bloqueada)
  - `200`: `{ success: true, cached: true }` (de-dup en 5s para `view`)
  - `400`: `{ error: "widgetId is required" }`
  - `500`: `{ error: "Internal server error" }`

#### `POST /api/chat`

- Body JSON:
  - Requeridos: `message`, `widgetId`
  - Opcionales: `history` (array `{ role, content }`), `userTimezone`
- Respuestas observadas:
  - `200`: `{ response: "<texto>" }`
  - `200`: `{ response: "<texto>", blocked: true }` (cierres de seguridad)
  - `200`: mensajes de estado negocio (trial vencido, AI deshabilitada, falta API key, error tecnico)
  - `400`: `{ error: "Message and widgetId are required" }`
  - `403`: `{ response: "<texto>", blocked: true }` (filtros/blocked IP)
  - `404`: `{ error: "Widget not found" }`
  - `429`: `{ response: "<texto>", rateLimited: true }`

#### `POST /api/icloser/handoff`

- Body JSON:
  - Requeridos: `widgetId`, `name`, `phone`
  - Requerido: `consent.accepted === true`
  - Requerido: `consent.explicitResponse` con valor afirmativo explicito (`"SI"`/`"YES"`)
  - Opcionales: `collectedInfo`, `history` (array `{ role, content }`), `consent.textVersion`, `consent.text`
- Comportamiento:
  - Valida consentimiento expreso antes de handoff.
  - Reenvia payload JSON a API externa IACloser (usa `IACLOSER_API_URL` o fallback productivo por defecto).
  - Registra trazabilidad en Firestore (`lead_handoffs`) y agrega lead en `leads` con `source: "lead_chat_iacloser"`.
- Respuestas:
  - `200`: `{ success: true, handoffId: string, leadId: string | null, lead_id: string | null, redirectUrl: string | null, redirect_url: string | null, queuedCallInSeconds: number, etaSeconds: number, eta_seconds: number }`
  - `400`: `{ error: "widgetId is required" | "name is required" | "phone is required" | "Explicit consent is required" | "Explicit consent response 'SI' is required" | "IACLOSER_API_URL is not configured" }`
  - `404`: `{ error: "Widget not found" }`
  - `502`: `{ error: "IACloser handoff failed", details?: object }`
  - `500`: `{ error: "Failed to send handoff" }`

#### `POST /api/users/bootstrap`

- Headers:
  - `Authorization: Bearer <Firebase ID token>` (requerido)
- Body JSON:
  - `businessName` (opcional)
  - `referredBy` (opcional)
- Respuestas:
  - `200`: `{ success: true, role: "client" | "superadmin", created: boolean }`
  - `401`: `{ error: "Unauthorized" }`
  - `500`: `{ error: "Failed to bootstrap user profile" }`

#### `GET /api/affiliates/network`

- Headers:
  - `Authorization: Bearer <Firebase ID token>` (requerido)
- Query params:
  - `levels` (1..4, default 4)
  - `includeInactive` (`"1"` incluye no activos; default `"0"`)
- Respuesta `200`:
  - `{ upline: Profile | null, levels: Array<{ level: number, users: Profile[] }> }`
  - `Profile` mapeado con: `id`, `email`, `display_name`, `business_name`, `subscription_status`, `plan_type`, `referred_by`, `created_at`
- Errores:
  - `401`: `{ error: "Unauthorized" }`
  - `500`: `{ error: "Failed to load affiliate network" }`

#### `POST /api/admin/delete-user`

- Headers:
  - `Authorization: Bearer <Firebase ID token>` (requerido)
- Body JSON:
  - `userId` (requerido)
- Comportamiento:
  - Elimina acceso en Firebase Auth (`deleteUser`) y borra datos principales en Firestore (`profiles`, `user_roles`, `partner_users`, `widget_configs`, `payments`, `visits`, `leads`).
- Respuestas:
  - `200`: `{ success: true, auth_deleted: boolean }`
  - `400`: `{ error: "Missing userId" }`
  - `401`: `{ error: "Unauthorized" }`
  - `403`: `{ error: "Forbidden" }`
  - `403`: `{ error: "Protected superadmin account cannot be deleted" }`
  - `500`: `{ error: "Failed to delete user" }`

#### `POST /api/verify-payment`

- Body JSON:
  - Requerido: `orderID`
  - Opcionales: `user_id`, `plan_type`
- Auth:
  - Usa token Firebase si llega en `Authorization`.
  - Sin token, puede aceptar `user_id` solo si `ALLOW_INSECURE_VERIFY_PAYMENT=true`.
- Respuestas:
  - `200`: `{ success: true, idempotent: true }` (order ya procesada)
  - `200`: `{ success: true, message: "Payment verified and subscription activated" }`
  - `400`: `{ error: "Missing orderID" }`
  - `400`: `{ error: "Missing PAYPAL credentials" }`
  - `400`: `{ error: "Invalid order status: <status>" }`
  - `401`: `{ error: "Unauthorized. Missing valid Firebase token." }`
  - `500`: `{ error: "<paypal/backend error>" }`

#### `GET /api/widget-config/:identity`

- Path param:
  - `identity` (requerido)
- Busqueda:
  - primero `widget_configs.widget_id == identity`
  - fallback `widget_configs.user_id == identity`
  - fallback `widget_configs.lead_chat_slug == identity`
- Respuestas:
  - `200`: `{ config: PublicWidgetConfig }`
  - `400`: `{ error: "Missing widget identity" }`
  - `404`: `{ error: "Widget config not found" }`
  - `500`: `{ error: "Failed to load widget config" }`
- `PublicWidgetConfig` incluye (entre otros):
  - `clientId`, `widgetId`, `businessName`, `primaryColor`, `whatsappDestination`, `language`
  - `welcomeMessage`, `template`, `chatPlaceholder`
  - `triggerDelay`, `exitIntentEnabled`, `exitIntentTitle`, `exitIntentDescription`, `exitIntentCta`
  - `teaserMessages`, `quickReplies`, `testimonials`
  - `launcherIcon`, `hideBranding`, `brandingText`, `brandingLink`
  - `experienceMode`, `leadChatSlug`, `leadChatUrl`
  - `consentText`, `consentTextVersion`, `iacloserRedirectUrl`, `iacloserEnabled`
  - `leadChatHeadline`, `leadChatSubheadline`, `leadChatOfferTitle`, `leadChatOfferDescription`, `leadChatCtaLabel`, `leadChatLiveToasts`
  - `ai_enabled`, `ai_provider`, `ai_api_key`, `ai_model`, `ai_system_prompt`, `business_description`, `ai_temperature`, `ai_max_tokens`
  - `facebookPixelId`, `tiktokPixelId`, `googleTagId`, `customTrackingCode: ""`, `updatedAt`

#### `GET /api/w/:widgetId.js`

- Retorna JavaScript (`Content-Type: application/javascript`).
- Respuestas:
  - `200`: script bootstrap del widget (inyecta `window.LEADWIDGET_*` y carga `widget-embed.js`)
  - `200`: `console.warn(...)` si `subscription_status === "suspended"`
  - `400`: `// widgetId is required`
  - `404`: `// Widget not found`
  - `500`: `// Error generating widget script`

### CORS y preflight (backend externo)

- `Access-Control-Allow-Methods: GET,POST,OPTIONS`
- `Access-Control-Allow-Headers: Content-Type,Authorization`
- `OPTIONS` responde `200` y corta flujo.

### Capa `/api` en `leads.widget` (proxy/routing)

Codigo observado:

- `POST|OPTIONS /api/chat` (proxy a backend externo)
- `POST|OPTIONS /api/track` (proxy a backend externo)
- `POST|OPTIONS /api/verify-payment` (proxy a backend externo)
- `GET /api/w/:widgetId.js` (proxy a backend externo)
- `GET /api/debug` (verifica acceso Firebase Admin; retorna `status/env`, y en error incluye `stack`)
- `vercel.json` define rewrite global: `/api/(.*)` -> backend externo Cloud Run

Asuncion:

- En produccion, la precedencia exacta entre rewrite global y archivos `api/*.js` depende del runtime de despliegue. El frontend consume `/api/*` y espera contrato del backend externo.

## Formato de errores

Formatos observados:

- JSON estandar: `{ error: "<mensaje>" }`
- Proxy local caido: `{ error: "<upstream unavailable>", details: "<mensaje>" }` con `502`
- Chat bloqueado/rate-limit usa payload de negocio:
  - `{ response: "<mensaje>", blocked: true }`
  - `{ response: "<mensaje>", rateLimited: true }`
- Endpoints JS (`/api/w/:widgetId.js`) devuelven comentarios JS en error (`// ...`) en vez de JSON.
- `api/debug` local en `500` incluye `stack` (solo diagnostico).

## Reglas de compatibilidad hacia atras

Comportamientos actuales que clientes ya consumen:

- Rutas relativas `/api/*` en frontend/widget (sin versionado explicito).
- `POST /api/chat` devuelve mayormente `200` con campo `response` incluso para varios casos de error de negocio.
- `GET /api/widget-config/:identity` soporta lookup por `widget_id` y fallback por `user_id`.
- `GET /api/w/:widgetId.js` mantiene entrega de script autocontenido y globals `window.LEADWIDGET_CLIENT_ID`, `window.LEADWIDGET_WIDGET_ID`, `window.LEADWIDGET_CONFIG`.
- Si `experience_mode=lead_chat`, `GET /api/w/:widgetId.js` responde script no embebible (warning) y se prioriza `leadChatUrl` publico.
- Tracking declarativo se mantiene en `facebook_pixel_id`, `tiktok_pixel_id`, `google_tag_id`; `custom_tracking_code/custom_code` no se exponen.
- `POST /api/verify-payment` es idempotente por `orderID` (`paypal_order_id`).
- CORS acepta `GET,POST,OPTIONS` y header `Authorization`.
- En Plan PLUS, `branding_link` permite redireccion configurable del texto de marca; si falta o es invalido se usa `/crear-ahora?ref=<clientId>`.


## Extensiones Partner Program (2026-02-16)

Nuevos modelos observados:
- `partners`
- `partner_users`
- `partner_invites`
- `partner_checkout_links`
- `partner_leads`
- `partner_client_drafts`
- `partner_tickets`
- `commission_ledger`
- `partner_payouts`
- `audit_events`

Nuevos endpoints backend:
- `POST /api/admin/payments/:paymentId/verify`
- `GET /api/partners/me`
- `GET /api/partners/overview`
- `GET /api/partners/clients`
- `POST|GET /api/partners/checkout-links`
- `POST|GET /api/partners/leads`
- `POST|GET /api/partners/drafts`
- `GET|PUT /api/partners/branding`
- `POST|GET /api/partners/tickets`
- `GET /api/partners/commissions` (`?format=csv` opcional)
- `GET /api/partners/payouts`
- `PUT /api/partners/payout-method`
- `GET /api/partners/users`
- `POST /api/partners/users/invite`
- `GET /api/admin/partners`
- `PATCH /api/admin/partners/:partnerId`
- `GET /api/admin/partners/:partnerId/clients`
- `POST /api/admin/partners/:partnerId/reassign-client`
- `POST /api/admin/commissions/:ledgerId/approve`
- `POST /api/admin/payouts/create`
- `POST /api/admin/payouts/:payoutId/mark-paid`

Cambios de comportamiento relevantes:
- `POST /api/verify-payment` ahora considera `ALLOW_INSECURE_VERIFY_PAYMENT=false` como default recomendado.
- `POST /api/verify-payment` y verificacion manual admin generan `commission_ledger` cuando existe `partner_id`.
- Politica de comisiones implementada: primer pago 50%, pagos siguientes 30%; no se reinicia por cancelacion/reactivacion.
- White-label reforzado server-side: solo `plan_type=plus` permite ocultar o personalizar branding.
- `GET /api/partners/overview` y `GET /api/partners/commissions` pueden materializar filas `pending` en `commission_ledger` para clientes `plus` activos sin pago registrado del periodo (cobro manual externo).
- `PUT /api/partners/branding` acepta `branding_text` y `branding_link` (manteniendo compatibilidad con `agency_name`/`cta_url`).

### Changelog del Contrato
- Fecha: 2026-02-16
- Cambio: agregado modulo Partner Program, endpoints partner/admin y reglas de comision/branding server-side
- Tipo: non-breaking
- Impacto: se mantienen rutas legacy; se suman nuevas capacidades para agencias y superadmin
- Fecha: 2026-02-16
- Cambio: `POST /api/admin/delete-user` pasa de soft delete a borrado completo de acceso (Firebase Auth + datos principales)
- Tipo: non-breaking
- Impacto: permite re-registro inmediato con el mismo email luego de eliminacion por superadmin
- Fecha: 2026-02-16
- Cambio: agregado soporte `branding_link` en `widget_configs` y `brandingLink` en `PublicWidgetConfig` para personalizar URL del texto de marca (Plan PLUS)
- Tipo: non-breaking
- Impacto: mantiene fallback al enlace promocional actual cuando no hay URL valida
- Fecha: 2026-02-16
- Cambio: `next_renewal_at` se fija en verificaciones de pago y `GET /api/partners/clients` aplica fallback derivado para cuentas activas sin dato historico
- Tipo: non-breaking
- Impacto: mejora consistencia visual del campo "Prox. renovacion" en dashboard partner sin cambiar shape del endpoint
- Fecha: 2026-02-16
- Cambio: contabilizacion de comision por cliente PLUS activo en periodo actual aun sin `payments` internos (escenario de cobro manual externo), via filas `pending` auto-generadas
- Tipo: non-breaking
- Impacto: el dashboard partner muestra comision calculada sin depender exclusivamente de pagos procesados por la plataforma
- Fecha: 2026-02-16
- Cambio: branding partner simplificado a `branding_text` + `branding_link` en `PUT /api/partners/branding` (con aliases legacy)
- Tipo: non-breaking
- Impacto: estandariza la configuracion de texto/enlace usados como fallback en widgets PLUS de clientes atribuidos
- Fecha: 2026-02-19
- Cambio: agregado flujo Lead Chat + IACloser con `POST /api/icloser/handoff`, lookup por `lead_chat_slug` y campos publicos (`experience_mode`, `lead_chat_slug`, consentimiento, redirect IACloser)
- Tipo: non-breaking
- Impacto: mantiene rutas legacy de widget embebido; habilita modo pagina publica para captacion y handoff con consentimiento expreso
- Fecha: 2026-02-19
- Cambio: `POST /api/icloser/handoff` agrega fallback productivo de `IACLOSER_API_URL` y aliases de respuesta (`lead_id`, `redirect_url`, `eta_seconds`) manteniendo campos previos
- Tipo: non-breaking
- Impacto: simplifica configuracion de integracion IACloser y mejora compatibilidad con shape del proveedor externo sin romper clientes existentes
- Fecha: 2026-02-19
- Cambio: `POST /api/icloser/handoff` exige consentimiento afirmativo explicito (`consent.explicitResponse = "SI"/"YES"`) ademas de `consent.accepted=true`
- Tipo: non-breaking
- Impacto: refuerza cumplimiento legal del flujo Lead Chat antes del handoff a IACloser
