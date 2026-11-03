import type { Server } from "node:http";

export function createMockServer(options: {
  appUrl: string;
  mpWebhookSecret: string;
  stripeWebhookSecret: string;
  publicUrl: string;
  log?: (line: string) => void;
}): Server;
