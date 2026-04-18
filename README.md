# Chatbot SPA WhatsApp

Backend para gestionar clientes, reservas y cobros de un spa por WhatsApp usando `Node.js`, `Express`, `Prisma + PostgreSQL`, `WhatsApp Business Cloud API`, `OpenAI`, `Google Calendar` y `Mercado Pago`.

## Funcionalidades

- Webhook de WhatsApp Cloud API con validacion de firma.
- Menu interactivo con listas y botones para reservas y consultas.
- Flujo guiado de reservas con captura de datos del cliente.
- Consulta de disponibilidad y creacion de eventos en Google Calendar.
- Generacion de links de pago dinamicos con Mercado Pago segun el valor del servicio.
- Respuestas asistidas por OpenAI con tono configurable e informacion oficial del spa.
- Proteccion contra eventos duplicados de Meta.

## Stack

- `Node.js`
- `Express`
- `Prisma`
- `PostgreSQL`
- `OpenAI`
- `Google Calendar API`
- `WhatsApp Business Cloud API`
- `Mercado Pago`

## Inicio rapido

```bash
npm install
copy .env.example .env
npm run prisma:generate
npx prisma migrate dev --name init
npm run prisma:seed
npm run dev
```

## Deploy en produccion

En produccion no uses `prisma migrate dev`. Ese comando intenta crear migraciones nuevas y usa locks interactivos que suelen fallar en plataformas como Render.

Usa este flujo:

```bash
npm run prisma:generate
npm run prisma:migrate:deploy
npm start
```

Para Render:

- Build Command: `npm install && npm run prisma:generate && npm run prisma:migrate:deploy`
- Start Command: `npm start`

Si aparece `P1002` con `pg_advisory_lock`, normalmente significa que:

- se esta ejecutando `prisma migrate dev` en el deploy;
- hay dos deploys o instancias intentando migrar al mismo tiempo;
- o quedo una migracion anterior colgada y Neon/Render todavia mantiene el lock unos segundos.

## Variables de entorno

Configura tus credenciales reales en `.env` tomando como base `.env.example`.

Bloques principales:

- Meta / WhatsApp
- OpenAI
- Google Calendar
- Mercado Pago
- Datos del spa

## Endpoints principales

- `GET /health`
- `GET /webhooks/meta`
- `POST /webhooks/meta`
- `GET /api/services`
- `POST /api/bookings/quote`
- `POST /api/bookings`
- `POST /api/bookings/:id/cancel`
- `POST /api/payments/link`

## Flujo general

1. El usuario escribe por WhatsApp.
2. Meta envia el evento al webhook.
3. El backend detecta intencion y estado de conversacion.
4. Si corresponde, consulta servicios y disponibilidad.
5. Crea la reserva en base de datos y Google Calendar.
6. Genera un link de pago segun el precio del servicio.

## Tests

```bash
npm test
```

## Notas

- `.env` esta ignorado por Git y no debe subirse.
- Si faltan credenciales externas, algunas integraciones trabajan en modo degradado.
- OpenAI se usa para clasificar y redactar, pero las reglas de negocio siguen en el backend.
