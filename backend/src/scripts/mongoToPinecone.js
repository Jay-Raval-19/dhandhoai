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
const BATCH_SIZE = 96; // Maximum batch size for llama-text-embed-v2 (verify with Pinecone)

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
                    dimension: 1024, // Verify dimension for llama-text-embed-v2
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

// Clear namespace to ensure fresh data
const clearNamespace = async (indexName, namespace) => {
    try {
        const index = pc.index(indexName);
        const stats = await retryOperation(() => index.describeIndexStats());
        console.log(`Namespace ${namespace} stats:`, JSON.stringify(stats, null, 2));

        if (stats.namespaces && stats.namespaces[namespace] && stats.namespaces[namespace].vectorCount > 0) {
            console.log(`Clearing namespace ${namespace} with ${stats.namespaces[namespace].vectorCount} vectors...`);
            // Pinecone doesn't support fetching all IDs directly; use deleteAll for serverless
            await retryOperation(() => index.namespace(namespace).deleteAll());
            console.log(`Cleared namespace ${namespace}`);
        } else {
            console.log(`Namespace ${namespace} is empty or does not exist. No vectors to clear.`);
        }
    } catch (error) {
        console.warn(`Warning: Failed to clear namespace ${namespace}: ${error.message}. Proceeding with upsert.`);
        // Continue execution to ensure upsert happens
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

        // Clear namespace to avoid stale data
        await clearNamespace(indexName, namespace);

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

        // Log a sample MongoDB document to inspect fields
        console.log('Sample MongoDB document:', JSON.stringify(documents[0], null, 2));

        // Log raw document keys
        console.log('Sample document keys:', Object.keys(documents[0]));

        // Check if document has a text field
        console.log('Raw text field in sample document:', documents[0].text || 'Not present');

        // Prepare texts for embedding and metadata by stringifying the entire document
        const texts = documents.map(doc => {
            // Create a copy without _id to avoid redundancy
            const docCopy = { ...doc };
            delete docCopy._id;
            // Convert to string, removing quotes around keys for readability
            const textString = Object.entries(docCopy)
                .map(([key, value]) => `${key}: ${value}`)
                .join(' ');
            return textString.trim();
        });

        // Log a sample text to verify stringification
        console.log('Sample stringified text:', texts[0]);

        // Generate embeddings
        console.log('Generating embeddings...');
        const embeddings = await generateEmbeddings(texts);
        console.log('Embeddings generated successfully');

        // Prepare vectors for Pinecone
        const vectors = documents.map((doc, i) => {
            // Create metadata with all document fields
            const metadata = { ...doc };

            // Remove redundant ID fields, existing text field, and any ID-like fields
            ['_id', 'ID', 'Id', 'id', 'iD', 'text'].forEach(field => {
                delete metadata[field];
            });

            // Explicitly set mongo_id and text
            metadata.mongo_id = doc._id.toString();
            metadata.text = texts[i];

            // Log metadata keys and sample metadata
            console.log('Metadata keys:', Object.keys(metadata));
            console.log('Sample metadata before upsert:', JSON.stringify(metadata, null, 2));

            return {
                id: doc._id.toString(), // Use _id as Pinecone vector ID
                values: embeddings[i].values,
                metadata
            };
        });

        // Log index stats before upsert
        const index = pc.index(indexName);
        const statsBefore = await retryOperation(() => index.describeIndexStats());
        console.log('Index stats before upsert:', JSON.stringify(statsBefore, null, 2));

        // Upsert vectors to Pinecone
        console.log(`Upserting ${vectors.length} vectors to namespace ${namespace}...`);
        await retryOperation(() => index.namespace(namespace).upsert(vectors));
        console.log(`Successfully upserted ${vectors.length} vectors to Pinecone`);

        // Log index stats after upsert
        const statsAfter = await retryOperation(() => index.describeIndexStats());
        console.log('Index stats after upsert:', JSON.stringify(statsAfter, null, 2));

        // Fetch a sample vector to verify
        const sampleVector = await index.namespace(namespace).fetch([vectors[0].id]);
        console.log('Sample fetched vector:', JSON.stringify(sampleVector, null, 2));

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
