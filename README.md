# B2B Chatbot Backend

A Node.js backend for a B2B conversational agent using Express, MongoDB, and Twilio.

## Prerequisites

- Node.js (v14 or higher)
- MongoDB (local or Atlas)
- Twilio Account with WhatsApp Sandbox

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with the following variables:
```
PORT=5000
MONGODB_URI=mongodb://localhost:27017/b2b-chatbot
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=your_twilio_phone_number
```

3. Start the development server:
```bash
npm run dev
```

## API Endpoints

### Twilio Webhook
- **POST** `/api/twilio/webhook`
  - Handles incoming WhatsApp messages
  - Requires Twilio webhook configuration

### Conversation History
- **GET** `/api/twilio/conversation/:phoneNumber`
  - Retrieves conversation history for a specific phone number
  - Example: `/api/twilio/conversation/+1234567890`

## Models

### Product
- name (String)
- description (String)
- price (Number)
- category (String)
- stock (Number)
- seller (ObjectId)
- createdAt (Date)

### Seller
- name (String)
- email (String)
- phone (String)
- company (String)
- address (Object)
- createdAt (Date)

### Conversation
- phoneNumber (String)
- messages (Array)
  - content (String)
  - sender (String)
  - timestamp (Date)
- status (String)
- lastInteraction (Date)
- createdAt (Date) 