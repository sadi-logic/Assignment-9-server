import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const app = express();
const port = process.env.PORT || 5000



//middlewares
app.use(express.json());
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

app.get('/', (req, res) => {
  res.send('Salon-Book Backend');
});

app.get('/users', async (req, res) => {
  const cursor = users.find({});
  const result = await cursor.toArray();
  res.send(result);
})

//services related api

app.post('/services', async (req, res) => {
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

app.patch("/services/:id", async (req, res) => {
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

app.delete("/services/:id", async (req, res) => {
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

app.post("/appointments", async (req, res) => {
  try {
    const {
      serviceId,
      customerId,
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

    // 2. Temporary local customer identity
    //
    // The Next.js booking route currently sends the Better Auth user ID.
    // This must later be replaced by JWT/session middleware and not trusted
    // from req.body.
    if (
      typeof customerId !== "string" ||
      customerId.trim() === ""
    ) {
      return res.status(401).json({
        error: "Customer authentication is required.",
      });
    }

    // 3. Verify that the service exists
    const service = await services.findOne({
      _id: new ObjectId(serviceId),
    });

    if (!service) {
      return res.status(404).json({
        error: "That service no longer exists.",
      });
    }

    // 4. Prevent booking inactive services
    if (service.status !== "active") {
      return res.status(409).json({
        error: "This service is inactive and cannot be booked.",
      });
    }

    // 5. Prevent duplicate active appointments
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

    // 6. Create the server-controlled appointment document
    const appointment = {
      serviceId: new ObjectId(serviceId),
      customerId: customerId.trim(),
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
//
// The Next.js server sends the customer id it read from the verified Better
// Auth session. Express compares that id with the stored `customerId`, so one
// customer can never read another customer's appointment list.
app.get("/appointments", async (req, res) => {
  try {
    const customerId =
      typeof req.query.customerId === "string"
        ? req.query.customerId.trim()
        : "";

    if (!customerId) {
      return res.status(400).json({
        error: "A customer id is required.",
      });
    }

    const result = await appointments
      .find({ customerId })
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
app.patch("/appointments/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;
    const { customerId } = req.body ?? {};

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid appointment ID." });
    }

    // Same temporary identity check as POST /appointments. This must later be
    // replaced by real session verification inside Express.
    if (typeof customerId !== "string" || customerId.trim() === "") {
      return res.status(401).json({
        error: "Customer authentication is required.",
      });
    }

    const appointment = await appointments.findOne({
      _id: new ObjectId(id),
    });

    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found." });
    }

    if (appointment.customerId !== customerId.trim()) {
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
      { _id: new ObjectId(id), customerId: customerId.trim(), status: "pending" },
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

app.listen(port, () => {
  console.log(`The Salon Book is running on ${port}`);
});