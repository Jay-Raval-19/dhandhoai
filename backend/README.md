# DhandhoAI Backend

A Node.js backend for the DhandhoAI B2B conversational agent, using Express, MongoDB, and Pinecone.

## Prerequisites

- Node.js (v14 or higher)
- MongoDB (local or Atlas)
- Pinecone account

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file in the backend root directory with the following variables:
   ```env
   PORT=5000
   MONGO_URI=your_mongodb_connection_string
   DB_NAME=your_db_name
   COLLECTION_NAME=your_collection_name
   PINECONE_API_KEY=your_pinecone_api_key
   PINECONE_ENVIRONMENT=your_pinecone_environment
   PINECONE_INDEX=your_pinecone_index
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. To transfer data from MongoDB to Pinecone:
   ```bash
   npm run transfer-to-pinecone
   ```

## Project Structure

- `src/models/` - Mongoose models
- `src/scripts/` - Utility scripts (e.g., MongoDB to Pinecone transfer)
- `src/index.js` - Main Express server entry point

## Notes
- Ensure your MongoDB and Pinecone credentials are correct in the `.env` file.
- The transfer script will use the MongoDB `_id` as the Pinecone vector ID.
