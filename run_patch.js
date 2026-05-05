const fs = require('fs');
let code = fs.readFileSync('website/app.js', 'utf-8');

const startIndex = code.indexOf('function renderCenterGraph');
const endIndex = code.indexOf('// Logic Functions');

if (startIndex === -1 || endIndex === -1) {
    console.error(" boundaries not found");
    process.exit(1);
}

console.log("Boundary found at", startIndex, endIndex);
