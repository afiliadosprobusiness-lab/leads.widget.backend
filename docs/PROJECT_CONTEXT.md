# Lead Widget (Backend Externo) - Project Context

## Objetivo de negocio
Backend externo para Lead Widget: script embebible, chat IA, tracking, pagos y desde 2026-02-16 modulo Partner Program (agencias) con RBAC y scoping server-side.

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
- Para `widgetId=demo-landing`, el prompt por defecto contempla preguntas comerciales y del programa Partners (comisiones, rutas y modelo de cobro).

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

### Resiliencia de roles partner
- `POST /api/users/bootstrap` incluye auto-recuperacion de membresia en `partner_users` para cuentas de agencia (`account_type` partner) cuando existe `partner_id` pero falta el documento de membresia.
- Este guardrail evita que una cuenta partner caiga al dashboard cliente por inconsistencias de datos.
- Los links generados por partner se emiten con `account=client` para mantener claro el flujo de alta de clientes referidos.

## Reglas de comision implementadas
- Primer pago exitoso de cliente referido: `50%` agencia.
- Pagos siguientes del mismo cliente: `30%` agencia.
- Cancelacion/reactivacion no reinicia primer pago: se determina por historial de pagos pagados previos del cliente.

## Variables de entorno
- `FIREBASE_SERVICE_ACCOUNT`
- `OPENAI_API_KEY`
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`
- `CORS_ORIGINS`, `PUBLIC_APP_URL`, `WIDGET_EMBED_URL`
- `ALLOW_INSECURE_VERIFY_PAYMENT` (default seguro recomendado: `false`)
