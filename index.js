import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const port = 3000;

// Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// Gemini API setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Middleware to parse incoming request bodies
app.use(bodyParser.urlencoded({ extended: false }));

// Route to handle incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  try {
    const incomingMessage = req.body.Body;
    const fromNumber = req.body.From;

    // Get response from Gemini
    const result = await model.generateContent(incomingMessage);
    const geminiResponse = result.response.text();

    // Create TwiML response
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(geminiResponse);

    // Send TwiML response
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());

    // Log interaction
    console.log(`Received from ${fromNumber}: ${incomingMessage}`);
    console.log(`Gemini response: ${geminiResponse}`);
  } catch (error) {
    console.error('Error processing webhook:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Sorry, something went wrong. Try again!');
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});