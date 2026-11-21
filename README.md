# SalonBook Server

The REST API for **SalonBook**, a salon appointment booking platform. It handles role-based access, services, appointments, user management, Stripe payments, and transaction records for the SalonBook client.

## Live Website

🔗 **Live Site:** https://salonbook-client-zeta.vercel.app/

## Repository Links

| Part | Repository |
| --- | --- |
| Client (Next.js) | https://github.com/sadi-logic/Assignment-9-client |
| Server (Express API) | https://github.com/sadi-logic/Assignment-9-server |

## Important Features

- **Token verification middleware:** every protected route reads the Bearer token, looks up the session, rejects expired sessions, and loads the user from the database
- **Server-side role checks:** separate admin and customer guards on every protected route, and blocked accounts are refused
- **Services API:** public listing with search and category filter; admin-only create, update, and delete
- **Appointments API:**
  - Date, time slot, and message validation, with a predefined list of time slots
  - Inactive services cannot be booked
  - Duplicate bookings for the same service, date, and slot are rejected
  - Customers can view and cancel only their own pending appointments
  - Admins can confirm pending appointments and cancel pending or confirmed ones
- **User management:** admins can list customers and block or unblock them
- **Stripe Checkout:** customers pay for confirmed appointments only
- **Verified Stripe webhook:** payment status changes to `paid` only after a signature-verified event, with amount and ID checks and duplicate-event protection
- **Transactions API:** admin view of all payments with customer, service, amount, currency, and Stripe session reference

## Technology Stack

- Node.js (ES modules)
- Express 5
- MongoDB (official driver)
- Stripe
- CORS and dotenv

## API Overview

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| GET | `/services` | Public | List services (supports `search` and `category`) |
| POST | `/services` | Admin | Create a service |
| PATCH | `/services/:id` | Admin | Update a service |
| DELETE | `/services/:id` | Admin | Delete a service |
| POST | `/appointments` | Customer | Submit an appointment request |
| GET | `/appointments` | Customer | List own appointments |
| PATCH | `/appointments/:id/cancel` | Customer | Cancel own pending appointment |
| GET | `/admin/appointments` | Admin | List all appointments |
| PATCH | `/admin/appointments/:id/confirm` | Admin | Confirm a pending appointment |
| PATCH | `/admin/appointments/:id/cancel` | Admin | Cancel a pending or confirmed appointment |
| GET | `/users` | Admin | List registered customers |
| PATCH | `/users/:id` | Admin | Block or unblock a customer |
| GET | `/admin/transactions` | Admin | List payment transactions |
| POST | `/payments/checkout` | Customer | Start Stripe Checkout for a confirmed appointment |
| POST | `/payments/webhook` | Stripe | Receive verified Stripe events |

## Database Collections

- `user` and `session` (managed by Better Auth from the client; the server only reads them)
- `services`
- `appointments`
- `transactions`

## Installation Instructions

**Prerequisites:** Node.js 20 or later, npm, a MongoDB Atlas database, and a Stripe account in test mode.

```bash
git clone https://github.com/sadi-logic/Assignment-9-server.git
cd Assignment-9-server
npm install
```

## Required Environment Variables

Create a `.env` file in the project root. Use your own values; never commit real secrets.

```env
PORT=
DB_USER=
DB_PASSWORD=
APP_URL=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_CURRENCY=
```

Notes:
- `PORT` defaults to `5000` and `STRIPE_CURRENCY` defaults to `bdt`.
- `APP_URL` is the client URL that Stripe redirects to after payment (for example `http://localhost:3000`).
- The server must use the same MongoDB database as the client (`salonbookdb`).
- `.env` is listed in `.gitignore` and must never be pushed.

## How to Run the Project Locally

1. Make sure your `.env` file is filled in.
2. Start the server:

   ```bash
   node index.js
   ```

3. The API runs at **http://localhost:5000**. Open it in a browser to see the "Salon-Book Backend" message.
4. Start the [client](https://github.com/sadi-logic/Assignment-9-client) and point its `SALONBOOK_API_URL` to this server.

## Testing Stripe Payments Locally

Forward Stripe webhook events to the server using the Stripe CLI:

```bash
stripe listen --forward-to localhost:5000/payments/webhook
```

Copy the signing secret it prints into `STRIPE_WEBHOOK_SECRET`, then restart the server. For the deployed server, add `<server-url>/payments/webhook` as a webhook endpoint in the Stripe dashboard for the events `checkout.session.completed` and `checkout.session.expired`.

## Author

**Sadullah Sadi** – [GitHub](https://github.com/sadi-logic)