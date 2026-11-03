import { createGraphMock } from "./graph-mock.js";

// Every default is a local test value, so this runs bare next to the bot's
// keyless setup.
const env = (name: string, fallback: string) => process.env[name] || fallback;

const port = Number(env("PORT", "3100"));
const { app } = createGraphMock({
  token: env("MOCK_TOKEN", "mock-token"),
  phoneNumberId: env("MOCK_PHONE_NUMBER_ID", "100000000000001"),
  appSecret: env("MOCK_APP_SECRET", "local-app-secret"),
  botWebhookUrl: env("BOT_WEBHOOK_URL", "http://localhost:3000/webhook"),
  refuseTo: env("MOCK_REFUSE_TO", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});

app.listen(port, () => console.log(`mock WhatsApp (not the real one) listening on :${port}, chat at /chat`));
