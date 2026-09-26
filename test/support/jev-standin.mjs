import http from "node:http";

// A loopback stand-in for TypeSafe's Jev, so no test needs a key or the network. It answers each
// item question with `judge(search, text)`, bills a quarter token per body byte as Jev does, and
// keeps every body it received so a test can check what would have left the machine.
export async function startStandin({ judge = () => 0.1, pick = () => 0, failFirst = 0, status = 503 } = {}) {
  const bodies = [];
  let failures = failFirst;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      bodies.push({ raw, authorization: request.headers.authorization });
      if (failures > 0) {
        failures -= 1;
        response.writeHead(status);
        response.end("{}");
        return;
      }
      const body = JSON.parse(raw);
      const answers = {};
      for (const [id, question] of Object.entries(body.questions)) {
        if (question.type === "choice") {
          const options = Object.keys(question.criteria);
          answers[id] = { type: "choice", choice: options[Math.min(pick(body.state.search, options.map((option) => question.criteria[option])), options.length - 1)] };
        } else {
          answers[id] = { type: "noul", noul: judge(body.state.search, body.state.items[question.instructions.item]) };
        }
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: Math.ceil(Buffer.byteLength(raw) / 4) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/systemone`,
    bodies,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
