import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import dotenv from 'dotenv';
import { Pinecone } from '@pinecone-database/pinecone';
import { pipeline } from '@xenova/transformers';

// Load environment variables
dotenv.config();

// Check for required environment variables
if (!process.env.PINECONE_API_KEY) {
  console.error('Missing PINECONE_API_KEY in environment variables.');
  process.exit(1);
}

// Initialize inquiries object to track user-supplier associations
const inquiries = {};

// Async function to start the server
async function startServer() {
  // Initialize Pinecone client
  const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY
  });

  // Access the index with the 'chemicals' namespace
  const index = pinecone.index('chemicals-new').namespace('chemicals');

  // Verify index data
  try {
    const stats = await index.describeIndexStats();
    console.log('Index stats:', stats);
    if (stats.totalRecordCount === 0) {
      console.warn('Index is empty. You may need to upload data first.');
    }
  } catch (error) {
    console.error('Failed to fetch index stats:', error.message);
    console.warn('Proceeding without index stats. Ensure the index has data.');
  }

  // Load embedding model
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  // Express app
  const app = express();
  app.use(bodyParser.urlencoded({ extended: false }));

  // Twilio client
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const client = twilio(accountSid, authToken);

  // Session store
  const sessions = {};

  // Function to send inquiry to supplier with an inquiry ID
  const sendInquiryToSupplier = async (supplierNumber, productName, category, quantity, inquiryId) => {
    const messageBody = `Please provide your quotation for inquiry #${inquiryId}:
Product: ${productName || 'Not specified'}
Category: ${category || 'Not specified'}
Quantity: ${quantity !== undefined && quantity !== null ? quantity : 'Not specified'}
Send your quotation via WhatsApp only, including the inquiry number.`;

    try {
      await client.messages.create({
        from: 'whatsapp:+14155238886', // Replace with your Twilio WhatsApp number
        to: `whatsapp:${supplierNumber}`,
        body: messageBody
      });
      console.log(`Inquiry #${inquiryId} sent to supplier: ${supplierNumber}`);
    } catch (error) {
      console.error(`Failed to send inquiry to supplier ${supplierNumber}:`, error);
    }
  };

  // Search function
  async function performSearch(data) {
    const { product_name, category, quantity, pincode, proximity } = data;

    // Generate query vector
    const queryText = product_name || 'chemicals';
    console.log(`Generating query vector for: ${queryText}`);
    const output = await embedder(queryText, { pooling: 'mean', normalize: true });
    const queryVector = Array.from(output.data);
    console.log(`Query vector dimensions: ${queryVector.length}`);

    // Build filters
    let filters = {};
    if (category) {
      filters['Product Category'] = { '$eq': category };
    }
    if (quantity !== undefined && quantity !== null) {
      filters['Minimum Order Quantity'] = { '$lte': quantity };
    }
    console.log(`Filters: ${JSON.stringify(filters)}`);

    // Perform Pinecone query
    let matches = [];
    try {
      const queryParams = {
        vector: queryVector,
        topK: 1000,
        includeMetadata: true
      };
      if (Object.keys(filters).length > 0) {
        queryParams.filter = filters;
      }
      const response = await index.query(queryParams);
      matches = response.matches;
      console.log(`Pinecone matches: ${matches.length}`);
    } catch (error) {
      console.error('Error querying Pinecone:', error.message);
      return matches;
    }

    // Filter by product name if provided
    if (product_name) {
      const productNameLower = product_name.toLowerCase();
      matches = matches.filter(m => m.metadata['Product Name'].toLowerCase().includes(productNameLower));
      console.log(`After product name filter: ${matches.length}`);
    }

    // Apply proximity filter if PIN code and proximity are provided
    if (pincode && proximity) {
      if (proximity === 'same') {
        const pincodePrefix = pincode.slice(0, 2);
        matches = matches.filter(m => m.metadata['PIN Code'].startsWith(pincodePrefix));
        matches = matches.slice(0, 5);
        console.log(`After same state filter: ${matches.length}`);
      } else if (proximity === 'pan') {
        matches = matches.sort((a, b) => {
          const pinA = parseInt(a.metadata['PIN Code'], 10);
          const pinB = parseInt(b.metadata['PIN Code'], 10);
          const userPin = parseInt(pincode, 10);
          return Math.abs(pinA - userPin) - Math.abs(pinB - userPin);
        });
        matches = matches.slice(0, 5);
        console.log(`After pan-India filter: ${matches.length}`);
      }
    } else {
      matches = matches.slice(0, 5);
      console.log(`Default top 5: ${matches.length}`);
    }

    return matches;
  }

  // Combine search and send inquiries
  async function performSearchAndFormat(data, fromNumber) {
    const matches = await performSearch(data);
    if (matches.length === 0) {
      return "No suppliers found matching your criteria.";
    }

    const inquiryId = Date.now().toString();
    inquiries[inquiryId] = {
      user: fromNumber,
      productName: data.product_name,
      suppliers: matches.map(match => ({
        number: match.metadata['Seller POC Contact Number'],
        name: match.metadata['Seller Name']
      }))
    };

    const supplierNumbers = matches.map(match => match.metadata['Seller POC Contact Number']).filter(number => number);
    if (supplierNumbers.length === 0) {
      return "No suppliers with contact numbers found.";
    }

    const sendPromises = supplierNumbers.map(number => sendInquiryToSupplier(number, data.product_name, data.category, data.quantity, inquiryId));
    await Promise.all(sendPromises);

    return `We have sent your inquiry #${inquiryId} to ${supplierNumbers.length} suppliers. You will receive their responses within 24 hours.`;
  }

  // Webhook route
  app.post('/webhook', async (req, res) => {
    const incomingMessage = req.body.Body.trim();
    const fromNumber = req.body.From;
    let responseMessage;

    // Check if the message is a supplier response
    const inquiryIdMatch = incomingMessage.match(/#(\d+)/);
    if (inquiryIdMatch) {
      const inquiryId = inquiryIdMatch[1];
      if (inquiries[inquiryId]) {
        const supplierNumber = fromNumber.replace('whatsapp:', '');
        const supplier = inquiries[inquiryId].suppliers.find(s => s.number === supplierNumber);
        if (supplier) {
          const userNumber = inquiries[inquiryId].user;
          const productName = inquiries[inquiryId].productName || 'the product';
          const messageToUser = `Quotation for ${productName} from ${supplier.name} (${supplier.number}): ${incomingMessage}`;
          await client.messages.create({
            from: 'whatsapp:+14155238886',
            to: userNumber,
            body: messageToUser
          });
          console.log(`Sent supplier response to user: ${messageToUser}`);
          responseMessage = 'Your quotation has been forwarded to the user.';
        } else {
          responseMessage = 'Supplier not found for this inquiry.';
        }
      } else {
        responseMessage = 'Inquiry not found.';
      }
    } else {
      // User message handling
      if (!sessions[fromNumber] || incomingMessage.toLowerCase() === 'hello') {
        sessions[fromNumber] = {
          state: 'START',
          data: {}
        };
      }

      const session = sessions[fromNumber];
      const lowerMessage = incomingMessage.toLowerCase();

      if (lowerMessage === 'no' || lowerMessage === 'stop') {
        responseMessage = 'Search terminated. Goodbye! Send "hello" to start a new search.';
        delete sessions[fromNumber];
      } else {
        switch (session.state) {
          case 'START':
            responseMessage = "Welcome to the Chemical Product Search! Connect with suppliers across India.\n\nYou can send 'no' or 'stop' at any time to exit.\n\nEnter part of the Product Name (e.g., 'Sodium', or send 'skip' to skip):";
            session.state = 'PRODUCT_NAME';
            break;
          case 'PRODUCT_NAME':
            if (lowerMessage !== 'skip') {
              session.data.product_name = incomingMessage;
            }
            responseMessage = "Enter the Product Category (e.g., 'Industrial Chemicals', or send 'skip' to skip):";
            session.state = 'CATEGORY';
            break;
          case 'CATEGORY':
            if (lowerMessage !== 'skip') {
              session.data.category = incomingMessage;
            }
            responseMessage = "How much do you need (in units, e.g., 500, or send 'skip' to skip):";
            session.state = 'QUANTITY';
            break;
          case 'QUANTITY':
            if (lowerMessage === 'skip') {
              session.data.quantity = null;
              responseMessage = "Enter your 6-digit PIN code (e.g., 390013, or send 'skip' to skip):";
              session.state = 'PINCODE';
            } else {
              const quantity = parseFloat(incomingMessage);
              if (!isNaN(quantity) && quantity >= 0) {
                session.data.quantity = quantity;
                responseMessage = "Enter your 6-digit PIN code (e.g., 390013, or send 'skip' to skip):";
                session.state = 'PINCODE';
              } else {
                responseMessage = "Please enter a valid non-negative number for quantity, or send 'skip' to skip.";
              }
            }
            break;
          case 'PINCODE':
            if (lowerMessage === 'skip') {
              session.data.pincode = null;
              responseMessage = await performSearchAndFormat(session.data, fromNumber);
              session.state = 'END';
            } else if (/^\d{6}$/.test(incomingMessage)) {
              session.data.pincode = incomingMessage;
              responseMessage = "Do you want suppliers from the same state (same) or anywhere in India (pan)? Send 'same' or 'pan':";
              session.state = 'PROXIMITY';
            } else {
              responseMessage = "Please enter a valid 6-digit PIN code, or send 'skip' to skip.";
            }
            break;
          case 'PROXIMITY':
            const preference = lowerMessage;
            if (preference === 'same' || preference === 'pan') {
              session.data.proximity = preference;
              responseMessage = await performSearchAndFormat(session.data, fromNumber);
              session.state = 'END';
            } else {
              responseMessage = "Please send 'same' for same state or 'pan' for pan-India.";
            }
            break;
          case 'END':
            if (lowerMessage === 'yes' || lowerMessage === 'y') {
              session.state = 'START';
              session.data = {};
              responseMessage = "Let's start a new search.\n\nEnter part of the Product Name (e.g., 'Sodium', or send 'skip' to skip):";
            } else {
              responseMessage = "Thank you for using the Chemical Product Search! Goodbye! Send 'hello' to start a new search.";
              delete sessions[fromNumber];
            }
            break;
          default:
            responseMessage = "Sorry, something went wrong. Please send 'hello' to start again.";
            delete sessions[fromNumber];
        }
      }

      // Prompt to search again
      if (session.state === 'END' && lowerMessage !== 'no' && lowerMessage !== 'stop') {
        responseMessage += "\n\nDo you want to search again? Send 'yes' to start a new search.";
      }
    }

    // Send response
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(responseMessage);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());

    // Log interaction
    console.log(`Received from ${fromNumber}: ${incomingMessage}`);
    console.log(`Response: ${responseMessage}`);
  });

  // Start server
  app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
  });
}

// Start the server
startServer().catch(console.error);