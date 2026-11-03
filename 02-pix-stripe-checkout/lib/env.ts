// Read a required setting, failing with its name rather than a later
// "undefined" deep inside a provider call.
export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}; see .env.example`);
  return value;
}
