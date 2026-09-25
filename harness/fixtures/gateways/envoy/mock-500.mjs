// The priority-0 backend of the fallback capture: answers every request with HTTP 500.
// Usage: node mock-500.mjs <port>
import { createServer } from "node:http";

createServer((request, response) => {
  response.writeHead(500, { "content-type": "application/json" });
  response.end('{"error":{"message":"mock failure"}}');
}).listen(Number(process.argv[2]), "0.0.0.0");
