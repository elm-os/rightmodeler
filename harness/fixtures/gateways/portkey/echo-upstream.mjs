import { createServer } from "node:http";
createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body =
    chunks.length === 0
      ? {}
      : JSON.parse(Buffer.concat(chunks).toString("utf8"));
  response.writeHead(200, { "content-type": "application/json" });
  if (request.method === "GET") {
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "stub/requested", object: "model" }],
      }),
    );
    return;
  }
  const text = JSON.stringify(body.messages ?? []);
  response.end(
    JSON.stringify({
      id: "chatcmpl-echo",
      object: "chat.completion",
      created: 1790118087,
      model: body.model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: `echo ${text.length}` },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
    }),
  );
}).listen(Number(process.argv[2]), "0.0.0.0");
