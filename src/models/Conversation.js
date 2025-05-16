const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    content: {
        type: String,
        required: true
    },
    sender: {
        type: String,
        required: true,
        enum: ['user', 'bot']
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
});

const conversationSchema = new mongoose.Schema({
    phoneNumber: {
        type: String,
        required: true
    },
    messages: [messageSchema],
    status: {
        type: String,
        enum: ['active', 'completed', 'archived'],
        default: 'active'
    },
    lastInteraction: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Conversation', conversationSchema); 