const mongoose = require('mongoose');
const { Pinecone } = require('@pinecone-database/pinecone');
require('dotenv').config();

// Pinecone setup with hardcoded API key
const pc = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY
});

const indexName = 'dhandhoai-dataset';
const namespace = 'ns1';
const model = 'llama-text-embed-v2';
const BATCH_SIZE = 96; // Maximum batch size for multilingual-e5-large

// Enhanced retry logic with exponential backoff
const retryOperation = async (operation, maxAttempts = 3, baseDelayMs = 1000) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await operation();
            return result;
        } catch (error) {
            const isRetryable = !error.message.includes('404') && !error.message.includes('index not found');
            if (attempt === maxAttempts || !isRetryable) {
                throw error;
            }
            const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
            console.warn(`Attempt ${attempt} failed: ${error.message}. Retrying in ${delayMs}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
};

// Wait for index to be ready
const waitForIndexReady = async (indexName, maxAttempts = 30, delayMs = 10000) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const index = pc.index(indexName);
            const stats = await retryOperation(() => index.describeIndexStats());
            if (stats) {
                console.log(`Index ${indexName} is ready`);
                return true;
            }
        } catch (error) {
            console.warn(`Index ${indexName} not ready (attempt ${attempt}): ${error.message}`);
            if (attempt === maxAttempts) {
                throw new Error(`Index ${indexName} not ready after ${maxAttempts} attempts`);
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
};

// Ensure Pinecone index exists (serverless configuration)
const ensureIndex = async () => {
    try {
        const response = await retryOperation(() => pc.listIndexes());
        let indexes = Array.isArray(response) ? response : response?.indexes || response?.data || [];
        const indexExists = indexes.some(index => index?.name === indexName);

        if (!indexExists) {
            console.log(`Creating index "${indexName}"...`);
            await retryOperation(() =>
                pc.createIndex({
                    name: indexName,
                    dimension: 1024, // Adjust based on multilingual-e5-large
                    metric: 'cosine',
                    spec: {
                        serverless: {
                            cloud: 'aws',
                            region: 'us-east-1' // Adjust based on your region
                        }
                    }
                })
            );
            console.log(`Index "${indexName}" created. Waiting for it to be ready...`);
            await waitForIndexReady(indexName);
        } else {
            console.log(`Index "${indexName}" already exists. Verifying readiness...`);
            await waitForIndexReady(indexName);
        }
    } catch (error) {
        console.error('Error ensuring index:', error.message);
        throw new Error(`Failed to ensure index: ${error.message}`);
    }
};

// Generate embeddings with Pinecone's Inference API (with batch processing)
const generateEmbeddings = async (texts) => {
    try {
        if (!pc.inference) {
            throw new Error('Pinecone inference API is not available. Ensure you are using @pinecone-database/pinecone version >= 2.0.0.');
        }

        const embeddings = [];
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
            const batch = texts.slice(i, i + BATCH_SIZE);
            console.log(`Processing batch ${i / BATCH_SIZE + 1} with ${batch.length} texts...`);

            const response = await retryOperation(() =>
                pc.inference.embed(model, batch, {
                    inputType: 'passage',
                    truncate: 'END'
                })
            );

            console.log(`Raw embedding response for batch ${i / BATCH_SIZE + 1}:`, JSON.stringify(response, null, 2));

            let batchEmbeddings;
            if (Array.isArray(response)) {
                batchEmbeddings = response.map(embedding => ({ values: embedding.values }));
            } else if (response?.embeddings) {
                batchEmbeddings = response.embeddings.map(embedding => ({ values: embedding.values }));
            } else if (response?.data) {
                batchEmbeddings = response.data.map(embedding => ({ values: embedding.values }));
            } else {
                throw new Error('Unexpected embeddings response format');
            }

            embeddings.push(...batchEmbeddings);
        }

        return embeddings;
    } catch (error) {
        console.error('Error generating embeddings:', error);
        if (error.message.includes('ENOTFOUND') || error.message.includes('PineconeConnectionError')) {
            throw new Error('Cannot connect to Pinecone. Check your network or Pinecone status at https://status.pinecone.io/');
        }
        throw new Error(`Failed to generate embeddings: ${error.message}`);
    }
};

// Main function to transfer data from MongoDB to Pinecone
async function transferMongoToPinecone() {
    try {
        // Ensure Pinecone index exists
        await ensureIndex();

        // Connect to MongoDB
        await mongoose.connect(process.env.MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            dbName: process.env.DB_NAME
        });
        console.log('Connected to MongoDB');

        // Get all documents from the collection
        const collection = mongoose.connection.db.collection(process.env.COLLECTION_NAME);
        const documents = await collection.find({}).toArray();
        console.log(`Found ${documents.length} documents in MongoDB`);

        // Prepare texts for embedding
        const texts = documents.map(doc => {
            const docWithStringId = { ...doc, _id: doc._id.toString() };
            return Object.entries(docWithStringId)
                .map(([key, value]) => `${key}: ${value}`)
                .join(', ');
        });

        // Generate embeddings
        console.log('Generating embeddings...');
        const embeddings = await generateEmbeddings(texts);
        console.log('Embeddings generated successfully');

        // Prepare vectors for Pinecone
        const vectors = documents.map((doc, i) => ({
            id: doc._id.toString(), // Use _id as Pinecone vector ID
            values: embeddings[i].values,
            metadata: {
                ...doc, // Include all document fields
                mongo_id: doc._id.toString() // Explicitly include MongoDB _id as mongo_id
            }
        }));

        // Log a sample vector to verify metadata
        console.log('Sample vector metadata:', JSON.stringify(vectors[0].metadata, null, 2));

        // Upsert vectors to Pinecone
        const index = pc.index(indexName);
        await retryOperation(() => index.namespace(namespace).upsert(vectors));
        console.log(`Successfully upserted ${vectors.length} vectors to Pinecone`);

    } catch (error) {
        console.error('Error transferring data:', error);
        throw error;
    } finally {
        await mongoose.connection.close();
        console.log('MongoDB connection closed');
    }
}

// Run the transfer
(async () => {
    try {
        await transferMongoToPinecone();
        console.log('Data transfer completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('Data transfer failed:', error);
        process.exit(1);
    }
})();