# Lead Widget (Backend Externo) - Project Context

## Objetivo de negocio
Backend externo para Lead Widget: script embebible, chat IA, tracking, pagos y desde 2026-02-16 modulo Partner Program (agencias) con RBAC y scoping server-side.

Actualizacion de objetivo (2026-02-19):
- Activar flujo Lead Chat + IACloser para cierre por llamada outbound automatizada.
- Handoff primario: envio de contexto de lead a API de IACloser + redireccion del usuario a landing/pagina IACloser.
- Lead Chat opera como pagina publica compartible (sin requerir instalacion embebida en web del cliente).

## Tech Stack
- Runtime: Node.js >= 20
- Framework: Express
- Auth/DB: Firebase Admin SDK (Auth + Firestore)
- IA: OpenAI SDK
- Deploy: Cloud Run

## Arquitectura (decisiones clave)
- Servicio stateless con Firestore como persistencia.
- Compatibilidad backward de rutas existentes (`/api/chat`, `/api/track`, `/api/w/:widgetId.js`, `/api/widget-config/:identity`).
- White-label reforzado server-side:
  - Plan `pro` (30): no puede ocultar marca.
  - Plan `plus` (60): permite `hide_branding`, `branding_text` y `branding_link` custom.
  - Si `branding_link` no existe o es invalido, el backend entrega fallback a `/crear-ahora?ref=<clientId>`.
- Seguridad de pago:
  - `/api/verify-payment` ahora asume `ALLOW_INSECURE_VERIFY_PAYMENT=false` por defecto.
  - Se recomienda Bearer token siempre.
- Seguridad operativa:
  - `POST /api/admin/delete-user` ejecuta borrado completo de cuenta (Firebase Auth + datos principales en Firestore).
- Para `widgetId=demo-landing`, el prompt por defecto contempla preguntas comerciales, programa Partners y la oferta Lead Chat + IACloser (consentimiento explicito + llamada outbound <60s), manteniendo compatibilidad del tag `[WHATSAPP_REDIRECT: ...]` para cierre del demo embebido.
- Nuevo flujo comercial objetivo (en implementacion, no rompe legacy):
  1. Usuario abre chat.
  2. Bot conversa y califica.
  3. Bot solicita numero.
  4. Bot solicita consentimiento expreso.
  5. Con consentimiento valido, backend prepara handoff.
  6. IACloser llama al lead en menos de 60 segundos (SLA del proveedor externo).

## Partner Program (nuevo)
### Roles
- `partner_admin`
- `partner_staff`
- `superadmin`

### Colecciones nuevas (Firestore)
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

### Endpoints nuevos
- Partner:
  - `GET /api/partners/me`
  - `GET /api/partners/overview`
  - `GET /api/partners/clients`
  - `POST|GET /api/partners/checkout-links`
  - `POST|GET /api/partners/leads`
  - `POST|GET /api/partners/drafts`
  - `GET|PUT /api/partners/branding`
  - `POST|GET /api/partners/tickets`
  - `GET /api/partners/commissions` (+ `?format=csv`)
  - `GET /api/partners/payouts`
  - `PUT /api/partners/payout-method`
  - `GET /api/partners/users`
  - `POST /api/partners/users/invite`
- Superadmin agencias:
  - `POST /api/admin/payments/:paymentId/verify`
  - `GET /api/admin/partners`
  - `PATCH /api/admin/partners/:partnerId`
  - `GET /api/admin/partners/:partnerId/clients`
  - `POST /api/admin/partners/:partnerId/reassign-client`
  - `POST /api/admin/commissions/:ledgerId/approve`
  - `POST /api/admin/payouts/create`
  - `POST /api/admin/payouts/:payoutId/mark-paid`

### Regla de renovacion (partner clients)
- Al verificar pago (`/api/verify-payment` y `/api/admin/payments/:paymentId/verify`) se guarda `next_renewal_at` (+30 dias) en el perfil del cliente.
- `GET /api/partners/clients` incluye fallback de `next_renewal_at` derivado (desde ultimo pago o `updated_at/created_at`) para evitar valores vacios en cuentas activas legacy.

### Resiliencia de roles partner
- `POST /api/users/bootstrap` incluye auto-recuperacion de membresia en `partner_users` para cuentas de agencia (`account_type` partner) cuando existe `partner_id` pero falta el documento de membresia.
- Este guardrail evita que una cuenta partner caiga al dashboard cliente por inconsistencias de datos.
- Los links generados por partner se emiten con `account=client` para mantener claro el flujo de alta de clientes referidos.

## Reglas de comision implementadas
- Primer pago exitoso de cliente referido: `50%` agencia.
- Pagos siguientes del mismo cliente: `30%` agencia.
- Cancelacion/reactivacion no reinicia primer pago: se determina por historial de pagos pagados previos del cliente.
- Para clientes `plus` activos atribuidos a partner, el backend genera filas `pending` en `commission_ledger` por periodo actual aun sin `payments` registrados (caso cobro externo/manual).

## Variables de entorno
- `FIREBASE_SERVICE_ACCOUNT`
- `OPENAI_API_KEY`
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`
- `CORS_ORIGINS`, `PUBLIC_APP_URL`, `WIDGET_EMBED_URL`
- `ALLOW_INSECURE_VERIFY_PAYMENT` (default seguro recomendado: `false`)
- `IACLOSER_API_URL`, `IACLOSER_API_KEY` (integracion outbound/handoff)
- `IACLOSER_DEFAULT_REDIRECT_URL` (fallback de redireccion post-handoff)

## Integracion IACloser (objetivo operativo)
- El backend debe enviar a IACloser, via API HTTP JSON, el contexto recopilado del lead durante el chat.
- Payload minimo esperado por negocio:
  - `name`: nombre del lead
  - `phone`: numero para llamada outbound
  - `collected_info`: resumen estructurado de calificacion y necesidades
- El payload debe incluir metadata de consentimiento para cumplimiento en USA:
  - `consent.accepted` (boolean)
  - `consent.accepted_at` (ISO datetime)
  - `consent.text_version` (version legal mostrada)
- Regla obligatoria: sin consentimiento expreso no se envia handoff a IACloser ni se activa llamada.
- El backend expone en `PublicWidgetConfig` ajustes visuales/comerciales de Lead Chat (eyebrow/badge superior, headline/subheadline, popup de oferta, CTA y mensajes live toast) para que el frontend los renderice desde dashboard.
