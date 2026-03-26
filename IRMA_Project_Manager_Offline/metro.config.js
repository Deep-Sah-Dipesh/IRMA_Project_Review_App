const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add .wasm to the source extensions
config.resolver.sourceExts.push('wasm');

// Ensure .wasm is NOT in sourceExts to prevent Metro from trying to transform it
config.resolver.sourceExts = config.resolver.sourceExts.filter(ext => ext !== 'wasm');

module.exports = config;