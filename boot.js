const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, 'server.js');
const fixedPath = path.join('/tmp', 'homestro-server-fixed.js');
let source = fs.readFileSync(sourcePath, 'utf8');

// Repair the accidental literal newline inside the OpenAI prompt string without
// changing the application source permanently. This keeps the existing API intact.
source = source.replace(/text:'Verarbeite dieses Produkt:\r?\n'\+/, "text:'Verarbeite dieses Produkt:\\\\n'+");

fs.writeFileSync(fixedPath, source, 'utf8');
require(fixedPath);
