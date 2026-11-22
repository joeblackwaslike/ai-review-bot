import { save, sanitize } from "./store.js";

export function createUser(input: NewUser) {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const handle = sanitize(input.handle);
  const plan = input.plan ?? "free";
  const record = { name, email, handle, plan };
  return save(record);
}

export function updateUser(id: string, input: NewUser) {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const handle = sanitize(input.handle);
  const plan = input.plan ?? "free";
  const record = { name, email, handle, plan };
  return save(record, id);
}
