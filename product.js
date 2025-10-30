
const mongoose = require('mongoose');

// Review Schema (nested inside Product)
const reviewSchema = new mongoose.Schema({
    user: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: String,
    date: { type: Date, default: Date.now }
});

// Variant Schema (nested inside Product)
const variantSchema = new mongoose.Schema({
    color: String,
    size: String,
    stock: { type: Number, default: 0 },
    price: { type: Number, required: true }
});

// Product Schema
const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    category: { type: String, required: true },
    brand: String,
    variants: [variantSchema],      // Array of nested variants
    reviews: [reviewSchema],        // Array of nested reviews
    createdAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);
module.exports = Product;
