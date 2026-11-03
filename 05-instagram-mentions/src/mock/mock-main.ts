import { createGraphMock } from "./graph-mock.js";

// Local test values, not secrets: they match the defaults in docker-compose.yml.
const port = Number(process.env.MOCK_PORT || 4010);
const publicUrl = process.env.MOCK_PUBLIC_URL || `http://localhost:${port}`;
const { app } = createGraphMock({
  accessToken: process.env.INSTAGRAM_ACCESS_TOKEN || "mock-token",
  appSecret: process.env.INSTAGRAM_APP_SECRET || "mock-app-secret",
  igUserId: process.env.MOCK_IG_USER_ID || "17841400000000001",
  webhookUrl: process.env.WEBHOOK_URL || "http://localhost:3000/webhook",
  publicUrl,
});

app.listen(port, () => {
  console.log(`Graph mock listening on :${port}`);
  console.log("This is a local stand-in for graph.facebook.com: nothing here reaches Meta.");
  console.log(`Emit a mention: POST ${publicUrl}/__mock/mentions {"kind":"comment","username":"ana","text":"oi @loja"}`);
});
