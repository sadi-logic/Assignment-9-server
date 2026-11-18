import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient } from 'mongodb';

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

app.get('/', (req, res) => {
  res.send('Salon-Book Backend');
});

app.get('/users',async(req,res)=>{
    const cursor = users.find({});
    const result = await cursor.toArray();
    res.send(result);
})

//services related api

app.post('/services',async(req,res)=>{
  // `createdAt` is stamped here, not accepted from the client: a JSON body
  // carries an ISO string, which Mongo would store as text instead of a Date.
  const service = { ...req.body, createdAt: new Date() };
  const result = await services.insertOne(service);
  res.status(201).send(result);
})

app.get("/services", async (req, res) => {
  const result = await services.find().toArray();

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
  const result = await studiosCollection.deleteOne({ _id: new ObjectId(id) });
  if (result.deletedCount === 0) {
    return res.status(404).send("Studio not found");
  }
  res.send("Service deleted successfully");
});



app.listen(port, () => {
  console.log(`The Salon Book is running on ${port}`);
});