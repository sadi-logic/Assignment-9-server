import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import Stripe from 'stripe';
import { MongoClient, ObjectId } from 'mongodb';

const app = express();
const port = process.env.PORT || 5000



//middlewares
//
// `verify` keeps the untouched request body on `req.rawBody`. Stripe signs the
// exact bytes it sent, so the webhook needs those bytes - the parsed JSON on
// `req.body` would not match the signature. Every other route is unaffected.
app.use(
  express.json({
    verify: (req, res, buffer) => {
      req.rawBody = buffer;
    },
  })
);
app.use(cors());

const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-lltgfzm-shard-00-00.radi1mm.mongodb.net:27017,ac-lltgfzm-shard-00-01.radi1mm.mongodb.net:27017,ac-lltgfzm-shard-00-02.radi1mm.mongodb.net:27017/?ssl=true&replicaSet=atlas-rxk7b7-shard-0&authSource=admin`);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("salonbookdb");

const users = database.collection("user");
const services = database.collection("services")
const appointments = database.collection("appointments");
const transactions = database.collection("transactions");

// ---------------------------------------------------------------------------
// Payment configuration
// ---------------------------------------------------------------------------

// Where Stripe sends the customer after paying or cancelling. Stripe needs a
// full address, so the Next.js app's address is reused when APP_URL is absent.
const appUrl = (
  process.env.APP_URL ||
  process.env.BETTER_AUTH_URL ||
  "http://localhost:3000"
).replace(/\/+$/, "");

// Lower-case ISO code, for example "bdt". BDT uses two decimals, so 2000 BDT
// becomes 200000 in Stripe's smallest unit.
const paymentCurrency = (process.env.STRIPE_CURRENCY || "bdt").toLowerCase();

// Stripe is optional in local development, but its secret key never leaves
// this server.
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

await transactions.createIndex(
  { stripeSessionId: 1 },
  {
    name: "unique_stripe_session",
    unique: true,
    partialFilterExpression: { stripeSessionId: { $type: "string" } },
  }
);
await transactions.createIndex(
  { appointmentId: 1 },
  {
   name: "one_pending_transaction_per_appointment",
    unique: true,
    partialFilterExpression: { paymentStatus: "pending" },
  }
);

// ---------------------------------------------------------------------------
// Admin authentication
// ---------------------------------------------------------------------------

// Better Auth (inside the Next.js app) owns the sessions. Express does not
// create or decode them, so it asks Better Auth who the cookie belongs to.
// The role always comes from that session record, never from the request body
// or query string, so a crafted request cannot claim to be an admin.
const authBaseUrl = (
  process.env.BETTER_AUTH_URL || "http://localhost:3000"
).replace(/\/+$/, "");

const readSession = async (cookie) => {
  if (!cookie) return null;

  try {
    const response = await fetch(`${authBaseUrl}/api/auth/get-session`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const payload = await response.json().catch(() => null);

    // Better Auth answers `null` when the cookie is missing or expired.
    return payload?.user ? payload : null;
  } catch {
    // If the auth service cannot be reached, access is denied rather than
    // granted.
    return null;
  }
}

/**
 * Gate for the admin appointment routes below.
 *
 * Rejects anyone without a real session, anyone whose role is not `admin`, and
 * any blocked account. The remaining routes never look at user input for the
 * role.
 */
 const verifyAdmin = async (req, res, next) => {
  const session = await readSession(req.headers.cookie);

  if (!session) {
    return res.status(401).json({
      error: "Sign in as an administrator to manage appointments.",
    });
  }

  if (session.user.role !== "admin") {
    return res.status(403).json({
      error: "Only administrators can manage appointments.",
    });
  }

  if (session.user.isBlocked) {
    return res.status(403).json({ error: "This account is blocked." });
  }

  next();
}

/**
 * Gate for the payment routes.
 *
 * Same idea as `verifyAdmin`: Better Auth says who owns the cookie, and the
 * customer id is taken from that verified session. A request body can never
 * choose who is paying.
 */
const verifyCustomer = async (req, res, next) => {
  const session = await readSession(req.headers.cookie);

  if (!session) {
    return res.status(401).json({ error: "Sign in to pay for an appointment." });
  }

  if (session.user.role !== "customer") {
    return res.status(403).json({
      error: "Only customers can pay for appointments.",
    });
  }

  if (session.user.isBlocked) {
    return res.status(403).json({ error: "This account is blocked." });
  }

  // Made available to the route below. It is not read from the request body.
  req.customer = session.user;
  next();
};

app.get('/', (req, res) => {
  res.send('Salon-Book Backend');
});

app.get('/users', verifyAdmin, async (req, res) => {
  try {
    const result = await users
      .find({ role: "customer" })
      .project({ name: 1, email: 1, image: 1, role: 1, isBlocked: 1 })
      .sort({ name: 1 })
      .toArray();

    return res.send(result);
  } catch (error) {
    console.error("Could not load customers:", error);
    return res.status(500).json({ error: "Could not load customers." });
  }
});

app.patch("/users/:id", verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { isBlocked } = req.body ?? {};

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid customer ID." });
    }

    if (typeof isBlocked !== "boolean") {
      return res.status(400).json({ error: "Choose a valid access status." });
    }

    const result = await users.updateOne(
      { _id: new ObjectId(id), role: "customer" },
      { $set: { isBlocked } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Customer not found." });
    }

    return res.json({ ok: true, isBlocked });
  } catch (error) {
    console.error("Could not update customer access:", error);
    return res.status(500).json({ error: "Could not update customer access." });
  }
})

//services related api

app.post('/services', verifyAdmin, async (req, res) => {
  // `createdAt` is stamped here, not accepted from the client: a JSON body
  // carries an ISO string, which Mongo would store as text instead of a Date.
  const service = { ...req.body, createdAt: new Date() };
  const result = await services.insertOne(service);
  res.status(201).send(result);
})

app.get("/services", async (req, res) => {
  const query = {};
  if (req.query) {
    if (req.query.category) {
      query.category = req.query.category;
    }
    if (req.query.search) {
      query.$or = [
        { serviceName: { $regex: req.query.search, $options: 'i' } },
        { description: { $regex: req.query.search, $options: 'i' } },
        { category: { $regex: req.query.search, $options: 'i' } }
      ];
    }
  }
  const cursor = services.find(query)
  const result = await cursor.toArray();

  res.send(result);
})

app.patch("/services/:id", verifyAdmin, async (req, res) => {
  const id = req.params.id;
  const updatedData = req.body;

  const result = await services.updateOne(
    { _id: new ObjectId(id) },
    { $set: updatedData }
  );

  if (result.matchedCount === 0) {
    return res.status(404).send("Services not found");
  }

  res.send(result);
});

app.delete("/services/:id", verifyAdmin, async (req, res) => {
  const id = req.params.id;
  const result = await services.deleteOne({ _id: new ObjectId(id) });
  if (result.deletedCount === 0) {
    return res.status(404).send("Service not found");
  }
  res.send("Service deleted successfully");
});



// Appointment api

const appointmentTimeSlots = [
  "10:00 AM",
  "11:00 AM",
  "12:00 PM",
  "01:00 PM",
  "02:00 PM",
  "03:00 PM",
  "04:00 PM",
  "05:00 PM",
  "06:00 PM",
  "07:00 PM",
];

app.post("/appointments", verifyCustomer, async (req, res) => {
  try {
    const {
      serviceId,
      appointmentDate,
      timeSlot,
      message,
    } = req.body;

    // 1. Appointment fields
    if (
      typeof serviceId !== "string" ||
      !ObjectId.isValid(serviceId)
    ) {
      return res.status(400).json({
        error: "Invalid service ID.",
      });
    }

    if (
      typeof appointmentDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)
    ) {
      return res.status(422).json({
        error: "Appointment date must use the YYYY-MM-DD format.",
      });
    }

    // Reject past dates.
    const today = new Date();
    const todayString =
      `${today.getFullYear()}-` +
      `${String(today.getMonth() + 1).padStart(2, "0")}-` +
      `${String(today.getDate()).padStart(2, "0")}`;

    if (appointmentDate < todayString) {
      return res.status(422).json({
        error: "Choose today or a later date.",
      });
    }

    if (
      typeof timeSlot !== "string" ||
      !appointmentTimeSlots.includes(timeSlot)
    ) {
      return res.status(422).json({
        error: "Choose a valid appointment time slot.",
      });
    }

    if (typeof message !== "undefined" && typeof message !== "string") {
      return res.status(422).json({
        error: "The additional message must be text.",
      });
    }

    const appointmentMessage =
      typeof message === "string" ? message.trim() : "";

    if (appointmentMessage.length > 500) {
      return res.status(422).json({
        error: "The appointment message cannot exceed 500 characters.",
      });
    }

    // 2. Verify that the service exists
    const service = await services.findOne({
      _id: new ObjectId(serviceId),
    });

    if (!service) {
      return res.status(404).json({
        error: "That service no longer exists.",
      });
    }

    // 3. Prevent booking inactive services
    if (service.status !== "active") {
      return res.status(409).json({
        error: "This service is inactive and cannot be booked.",
      });
    }

    // 4. Prevent duplicate active appointments
    const existingAppointment = await appointments.findOne({
      serviceId: new ObjectId(serviceId),
      appointmentDate,
      timeSlot,
      status: { $ne: "cancelled" },
    });

    if (existingAppointment) {
      return res.status(409).json({
        error: "That date and time slot are already booked.",
      });
    }

    // 5. Create the server-controlled appointment document
    const appointment = {
      serviceId: new ObjectId(serviceId),
      customerId: req.customer.id,
      appointmentDate,
      timeSlot,
      message: appointmentMessage,
      servicePrice: service.price,
      paymentStatus: "unpaid",
      status: "pending",
      createdAt: new Date(),
    };

    const result = await appointments.insertOne(appointment);

    if (!result.acknowledged) {
      return res.status(500).json({
        error: "The appointment could not be saved.",
      });
    }

    return res.status(201).json({
      ok: true,
      id: result.insertedId.toString(),
    });
  } catch (error) {
    console.error("Could not create appointment:", error);

    return res.status(500).json({
      error: "An unexpected error occurred while booking the appointment.",
    });
  }
});

// Returns the signed-in customer's appointments, newest first.
app.get("/appointments", verifyCustomer, async (req, res) => {
  try {
    const result = await appointments
      .find({ customerId: req.customer.id })
      .sort({ createdAt: -1 })
      .toArray();

    return res.send(result);
  } catch (error) {
    console.error("Could not load appointments:", error);

    return res.status(500).json({
      error: "An unexpected error occurred while loading appointments.",
    });
  }
});

// Cancels one appointment. Only the owner can cancel, and only while it is
// still pending.
app.patch("/appointments/:id/cancel", verifyCustomer, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid appointment ID." });
    }

    const appointment = await appointments.findOne({
      _id: new ObjectId(id),
    });

    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found." });
    }

    if (appointment.customerId !== req.customer.id) {
      return res.status(403).json({
        error: "You can only cancel your own appointments.",
      });
    }

    if (appointment.status !== "pending") {
      return res.status(409).json({
        error:
          appointment.status === "cancelled"
            ? "This appointment is already cancelled."
            : "Confirmed appointments cannot be cancelled.",
      });
    }


    const result = await appointments.updateOne(
      { _id: new ObjectId(id), customerId: req.customer.id, status: "pending" },
      { $set: { status: "cancelled" } }
    );

    if (result.modifiedCount === 0) {
      return res.status(409).json({
        error: "This appointment can no longer be cancelled.",
      });
    }

    return res.send({ ok: true });
  } catch (error) {
    console.error("Could not cancel appointment:", error);

    return res.status(500).json({
      error: "An unexpected error occurred while cancelling the appointment.",
    });
  }
});

// ---------------------------------------------------------------------------
// Admin appointment management
// ---------------------------------------------------------------------------

// Every appointment for the admin table, newest first, with the customer and
// service information the page needs attached to each row.
//
// The join happens here (not in the browser, and not through the unprotected
// `/users` endpoint) and only the safe fields are selected.
app.get("/admin/appointments", verifyAdmin, async (req, res) => {
  try {
    const list = await appointments
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const serviceIds = [
      ...new Set(list.map((item) => item.serviceId).filter(Boolean)),
    ];


    const customerIds = [
      ...new Set(
        list
          .map((item) => item.customerId)
          .filter((id) => typeof id === "string" && ObjectId.isValid(id))
      ),
    ];

    const serviceDocuments = serviceIds.length
      ? await services
          .find({ _id: { $in: serviceIds } })
          .project({
            serviceName: 1,
            category: 1,
            description: 1,
            image: 1,
            status: 1,
          })
          .toArray()
      : [];

    const customerDocuments = customerIds.length
      ? await users
          .find({ _id: { $in: customerIds.map((id) => new ObjectId(id)) } })
          .project({ name: 1, email: 1, image: 1 })
          .toArray()
      : [];

    const servicesById = new Map(
      serviceDocuments.map((service) => [service._id.toString(), service])
    );
    const customersById = new Map(
      customerDocuments.map((customer) => [customer._id.toString(), customer])
    );

    return res.send(
      list.map((appointment) => ({
        ...appointment,
        service: servicesById.get(String(appointment.serviceId)) ?? null,
        // A deleted account leaves the appointment intact; the page shows a
        // neutral fallback in that case.
        customer: customersById.get(String(appointment.customerId)) ?? null,
      }))
    );
  } catch (error) {
    console.error("Could not load admin appointments:", error);

    return res.status(500).json({
      error: "An unexpected error occurred while loading appointments.",
    });
  }
});

// Confirms one appointment. Allowed only while it is still pending; the status
// filter in the update makes the transition atomic.
app.patch(
  "/admin/appointments/:id/confirm",
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid appointment ID." });
      }

      const appointmentId = new ObjectId(id);
      const appointment = await appointments.findOne({ _id: appointmentId });

      if (!appointment) {
        return res.status(404).json({ error: "Appointment not found." });
      }

      if (appointment.status !== "pending") {
        return res.status(409).json({
          error:
            appointment.status === "cancelled"
              ? "Cancelled appointments cannot be confirmed."
              : "This appointment is already confirmed.",
        });
      }

      // Only `status` is written. Payment status and every other field are
      // left exactly as they were.
      const result = await appointments.updateOne(
        { _id: appointmentId, status: "pending" },
        { $set: { status: "confirmed" } }
      );

      if (result.modifiedCount === 0) {
        return res.status(409).json({
          error:
            "This appointment changed while you were updating it. Refresh and try again.",
        });
      }

      return res.send({ ok: true });
    } catch (error) {
      console.error("Could not confirm appointment:", error);

      return res.status(500).json({
        error: "An unexpected error occurred while confirming the appointment.",
      });
    }
  }
);

// Cancels one appointment. Admins may cancel a pending or a confirmed
// appointment, but never one that is already cancelled.
app.patch(
  "/admin/appointments/:id/cancel",
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid appointment ID." });
      }

      const appointmentId = new ObjectId(id);
      const appointment = await appointments.findOne({ _id: appointmentId });

      if (!appointment) {
        return res.status(404).json({ error: "Appointment not found." });
      }

      if (
        appointment.status !== "pending" &&
        appointment.status !== "confirmed"
      ) {
        return res.status(409).json({
          error: "This appointment is already cancelled.",
        });
      }

      // The same two-value filter is repeated in the update so a simultaneous
      // request cannot cancel something that just changed.
      const result = await appointments.updateOne(
        { _id: appointmentId, status: { $in: ["pending", "confirmed"] } },
        { $set: { status: "cancelled" } }
      );

      if (result.modifiedCount === 0) {
        return res.status(409).json({
          error:
            "This appointment changed while you were updating it. Refresh and try again.",
        });
      }

      return res.send({ ok: true });
    } catch (error) {
      console.error("Could not cancel appointment:", error);

      return res.status(500).json({
        error: "An unexpected error occurred while cancelling the appointment.",
      });
    }
  }
);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
app.get("/admin/transactions", verifyAdmin, async (req, res) => {
  try {
    const list = await transactions.find({}).sort({ createdAt: -1 }).toArray();
    const appointmentIds = [
      ...new Set(
        list
          .map((transaction) => String(transaction.appointmentId ?? ""))
          .filter((id) => ObjectId.isValid(id))
      ),
    ];
    const appointmentDocuments = appointmentIds.length
      ? await appointments
          .find({ _id: { $in: appointmentIds.map((id) => new ObjectId(id)) } })
          .toArray()
      : [];
    const serviceIds = [
      ...new Set(
        appointmentDocuments
          .map((appointment) => String(appointment.serviceId ?? ""))
          .filter((id) => ObjectId.isValid(id))
      ),
    ];
    const customerIds = [
      ...new Set(
        list
          .map((transaction) => transaction.customerId)
          .filter((id) => typeof id === "string" && ObjectId.isValid(id))
      ),
    ];
    const [serviceDocuments, customerDocuments] = await Promise.all([
      serviceIds.length
        ? services
            .find({ _id: { $in: serviceIds.map((id) => new ObjectId(id)) } })
            .project({ serviceName: 1 })
            .toArray()
        : [],
      customerIds.length
        ? users
            .find({ _id: { $in: customerIds.map((id) => new ObjectId(id)) } })
            .project({ name: 1, email: 1 })
            .toArray()
        : [],
    ]);

    const appointmentsById = new Map(
      appointmentDocuments.map((appointment) => [String(appointment._id), appointment])
    );
    const servicesById = new Map(
      serviceDocuments.map((service) => [String(service._id), service])
    );
    const customersById = new Map(
      customerDocuments.map((customer) => [String(customer._id), customer])
    );

    return res.json(
      list.map((transaction) => {
        const appointment = appointmentsById.get(String(transaction.appointmentId));
        const service = appointment
          ? servicesById.get(String(appointment.serviceId))
          : null;
        const customer = customersById.get(String(transaction.customerId));

        return {
          id: String(transaction._id),
          customerName: customer?.name ?? "Deleted customer",
          customerEmail: customer?.email ?? "No email on file",
          serviceName: service?.serviceName ?? "Service no longer listed",
          appointmentDate: appointment?.appointmentDate ?? "",
          amount: Number(transaction.amount ?? 0),
          currency: transaction.currency ?? paymentCurrency,
          stripeSessionId: transaction.stripeSessionId ?? "",
          paymentStatus: transaction.paymentStatus ?? "unknown",
          createdAt: transaction.createdAt ?? null,
        };
      })
    );
  } catch (error) {
    console.error("Could not load payment transactions:", error);
    return res.status(500).json({ error: "Could not load payment transactions." });
  }
});

app.post("/payments/checkout", verifyCustomer, async (req, res) => {
  let session;
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Online payments are not configured." });
    }

    const { appointmentId } = req.body ?? {};
    if (typeof appointmentId !== "string" || !ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ error: "Invalid appointment ID." });
    }

    const appointment = await appointments.findOne({ _id: new ObjectId(appointmentId) });
    if (!appointment) return res.status(404).json({ error: "Appointment not found." });
    if (appointment.customerId !== req.customer.id) {
      return res.status(403).json({ error: "You can only pay for your own appointments." });
    }
    if (appointment.status !== "confirmed" || appointment.paymentStatus !== "unpaid") {
      return res.status(409).json({ error: "Only confirmed, unpaid appointments can be paid." });
    }
    if (!Number.isFinite(appointment.servicePrice) || appointment.servicePrice <= 0) {
      return res.status(400).json({ error: "The appointment has an invalid price." });
    }

    const paidTransaction = await transactions.findOne({
      appointmentId: appointment._id,
      paymentStatus: "paid",
    });
    if (paidTransaction) {
      return res.status(409).json({ error: "This appointment has already been paid." });
    }

    const pendingTransaction = await transactions.findOne({
      appointmentId: appointment._id,
      paymentStatus: "pending",
    });
    if (pendingTransaction) {
      return res.status(409).json({ error: "A payment attempt is already in progress." });
    }

    session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: paymentCurrency,
          unit_amount: Math.round(appointment.servicePrice * 100),
          product_data: {
            name: "Salon appointment",
            description: appointment.appointmentDate + " at " + appointment.timeSlot,
          },
        },
      }],
      customer_email: req.customer.email || undefined,
      metadata: {
        appointmentId: appointment._id.toString(),
        customerId: req.customer.id,
      },
      success_url: appUrl + "/payment/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: appUrl + "/payment/cancel",
    });

    if (!session.url) throw new Error("Stripe did not return a checkout URL.");

    await transactions.insertOne({
      appointmentId: appointment._id,
      customerId: req.customer.id,
      stripeSessionId: session.id,
      amount: appointment.servicePrice,
      currency: paymentCurrency,
      paymentStatus: "pending",
      needsReview: false,
      createdAt: new Date(),
    });

    return res.status(201).json({ url: session.url });
  } catch (error) {
    if (error?.code === 11000) {
      if (session) {
        try {
          await stripe.checkout.sessions.expire(session.id);
        } catch (expireError) {
          console.error("Could not expire duplicate checkout session:", expireError);
          return res.status(500).json({
            error: "Could not safely finish the duplicate payment attempt.",
          });
        }
      }

      return res.status(409).json({ error: "A payment attempt is already in progress." });
    }

    console.error("Could not start payment:", error);
    return res.status(500).json({ error: "Could not start the payment." });
  }
});

app.post("/payments/webhook", async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "The payment webhook is not configured." });
  }

  const signature = req.headers["stripe-signature"];
  if (!signature || !req.rawBody) {
    return res.status(400).json({ error: "Missing Stripe signature." });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error("Invalid Stripe signature:", error.message);
    return res.status(400).json({ error: "Invalid Stripe signature." });
  }

  if (event.type === "checkout.session.expired") {
    await transactions.updateOne(
      { stripeSessionId: event.data.object.id, paymentStatus: "pending" },
      { $set: { paymentStatus: "expired" } }
    );
    return res.json({ received: true });
  }

  if (event.type !== "checkout.session.completed") {
    return res.json({ received: true, ignored: true });
  }

  const session = event.data.object;
  if (session.payment_status !== "paid") {
    return res.json({ received: true, ignored: true });
  }

  try {
    const transaction = await transactions.findOne({ stripeSessionId: session.id });
    if (!transaction) {
      return res.status(500).json({ error: "Payment transaction was not found." });
    }
    if (transaction.paymentStatus === "paid") {
      return res.json({ received: true, duplicate: true });
    }

    const appointment = await appointments.findOne({ _id: transaction.appointmentId });
    const idsMatch = appointment &&
      String(appointment._id) === session.metadata?.appointmentId &&
      appointment.customerId === session.metadata?.customerId &&
      String(transaction.appointmentId) === session.metadata?.appointmentId &&
      transaction.customerId === session.metadata?.customerId;
    const amountMatches = appointment &&
      appointment.servicePrice === transaction.amount &&
      session.amount_total === Math.round(appointment.servicePrice * 100) &&
      session.currency?.toLowerCase() === paymentCurrency;

    if (!appointment || !idsMatch || !amountMatches) {
      await transactions.updateOne(
        { _id: transaction._id, paymentStatus: "pending" },
        { $set: {
          paymentStatus: "paid",
          needsReview: true,
          reviewReason: "Payment details did not match the appointment.",
          paidAt: new Date(),
        } }
      );
      return res.json({ received: true, needsReview: true });
    }

    const needsReview = appointment.status !== "confirmed" ||
      appointment.paymentStatus !== "unpaid";
    await appointments.updateOne(
      { _id: appointment._id, paymentStatus: "unpaid" },
      { $set: { paymentStatus: "paid" } }
    );
    await transactions.updateOne(
      { _id: transaction._id, paymentStatus: "pending" },
      { $set: {
        paymentStatus: "paid",
        needsReview,
        reviewReason: needsReview
          ? "Appointment was cancelled or already paid when Stripe confirmed payment."
          : null,
        paidAt: new Date(),
      } }
    );

    return res.json({ received: true });
  } catch (error) {
    console.error("Could not record Stripe payment:", error);
    return res.status(500).json({ error: "Could not record the payment." });
  }
});

app.listen(port, () => {
  console.log(`The Salon Book is running on ${port}`);
});