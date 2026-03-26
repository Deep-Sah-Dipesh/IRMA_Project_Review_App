const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add .wasm to the source extensions
config.resolver.sourceExts.push('wasm');

module.exports = config;